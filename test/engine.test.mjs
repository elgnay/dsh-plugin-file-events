/**
 * Offline tests for the execution machinery shared with the scheduled-items
 * fork: optional model chain / provider allowlist / agent preset fields on a
 * rule, candidate selection, fallback orchestration, and preset resolution.
 * All logic under test is pure — `agentPresets` is stubbed and no harness is
 * required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../src/index.js')

const {
  ruleSchema,
  buildRule,
  normalizeModelFields,
  assertAllowedProviders,
  normalizeAgentPreset,
  buildCandidates,
  runWithCandidates,
  resolvePresetForItem,
  finalizeRunPreset,
  failedBeforeAttempts,
} = __test

const AT = '2026-09-03T08:00:00.000Z'
const now = () => AT

function baseRule(overrides = {}) {
  return {
    id: 'rule-1',
    title: 'T',
    prompt: 'P',
    enabled: true,
    workspaceId: 'ws-1',
    watchPaths: ['inbox/raw'],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A minimal harness `agentPresets` service stub around a resolver. */
function stubService(resolve) {
  return { resolve, mount: async () => ({ id: 'stub' }) }
}

// ── schema ────────────────────────────────────────────────────────────────

test('rule schema accepts a rule with a model chain, allowlist, and preset', () => {
  const parsed = ruleSchema.safeParse(baseRule({
    models: [
      { provider: 'local', model: 'deepseek-v4-flash' },
      { provider: 'local', model: 'qwen38-27b' },
    ],
    allowedProviders: ['local'],
    agentPreset: 'web',
    lastRunPreset: 'web',
  }))
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.models.length, 2)
  assert.deepEqual(parsed.data.allowedProviders, ['local'])
  assert.equal(parsed.data.agentPreset, 'web')
})

test('rule schema still parses legacy rules without the new fields', () => {
  const parsed = ruleSchema.safeParse(baseRule())
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.agentPreset, undefined)
  assert.equal(parsed.data.models, undefined)
})

test('rule schema accepts run metadata (lastRunModel, lastRunAttempts, lastRunPreset)', () => {
  const parsed = ruleSchema.safeParse(baseRule({
    lastRunAt: AT,
    lastRunModel: 'local/deepseek-v4-flash',
    lastRunPreset: 'web',
    lastRunAttempts: [
      { provider: 'local', model: 'deepseek-v4-flash', attemptedAt: AT, ok: false, error: 'UNKNOWN_MODEL (UNKNOWN_MODEL)' },
      { provider: 'local', model: 'qwen38-27b', attemptedAt: AT, ok: true },
    ],
  }))
  assert.equal(parsed.success, true)
})

// ── model-field normalization / validation ────────────────────────────────

test('normalizeModelFields accepts a chain and allowlist and trims providers', () => {
  const out = normalizeModelFields({
    models: [{ provider: ' local ', model: ' deepseek-v4-flash ' }],
    allowedProviders: ['local', 'local'],
  })
  assert.deepEqual(out.models, [{ provider: 'local', model: 'deepseek-v4-flash' }])
  assert.deepEqual(out.allowedProviders, ['local'])
})

test('normalizeModelFields treats empty arrays as absent', () => {
  assert.equal(normalizeModelFields({ models: [], allowedProviders: ['local'] }).models, undefined)
  const out = normalizeModelFields({ models: [{ provider: 'local', model: 'm' }], allowedProviders: [] })
  assert.equal(out.allowedProviders, undefined)
  assert.deepEqual(out.models, [{ provider: 'local', model: 'm' }])
})

test('normalizeModelFields rejects malformed chains and allowlists', () => {
  assert.throws(() => normalizeModelFields({ models: { provider: 'local', model: 'm' } }), /models must be an array/)
  assert.throws(() => normalizeModelFields({ models: [{ provider: 'local' }] }), /models must be an array/)
  assert.throws(() => normalizeModelFields({ models: [{ provider: '', model: 'm' }] }), /non-empty/)
  assert.throws(() => normalizeModelFields({ allowedProviders: 'local' }), /allowedProviders must be an array/)
  assert.throws(() => normalizeModelFields({ allowedProviders: [''] }), /allowedProviders must be an array/)
})

test('normalizeModelFields rejects a model provider outside the allowlist', () => {
  assert.throws(
    () => normalizeModelFields({ models: [{ provider: 'deepseek', model: 'm' }], allowedProviders: ['local'] }),
    /not in allowedProviders/
  )
})

test('assertAllowedProviders guards a merged rule whose chain leaves the allowlist', () => {
  assert.throws(
    () => assertAllowedProviders(baseRule({
      models: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      allowedProviders: ['local'],
    })),
    /not in allowedProviders/
  )
  assert.doesNotThrow(() => assertAllowedProviders(baseRule()))
})

test('buildRule carries normalized chain fields and omits empty ones', () => {
  const withChain = buildRule({
    title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'],
    models: [{ provider: 'local', model: 'deepseek-v4-flash' }],
    allowedProviders: ['local'],
  })
  assert.deepEqual(withChain.models, [{ provider: 'local', model: 'deepseek-v4-flash' }])
  assert.deepEqual(withChain.allowedProviders, ['local'])

  const cleared = buildRule({ title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'], models: [] })
  assert.equal(cleared.models, undefined)
  assert.equal(cleared.allowedProviders, undefined)
})

test('buildRule rejects a chain whose provider is outside the allowlist', () => {
  assert.throws(
    () => buildRule({
      title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'],
      models: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      allowedProviders: ['local'],
    }),
    /not in allowedProviders/
  )
})

// ── agent-preset normalization ────────────────────────────────────────────

test('normalizeAgentPreset trims a valid preset id', () => {
  assert.equal(normalizeAgentPreset('  web  '), 'web')
  assert.equal(normalizeAgentPreset('daily-digest-2'), 'daily-digest-2')
})

test('normalizeAgentPreset treats undefined, null, and empty string as clear', () => {
  assert.equal(normalizeAgentPreset(undefined), undefined)
  assert.equal(normalizeAgentPreset(null), undefined)
  assert.equal(normalizeAgentPreset(''), undefined)
  assert.equal(normalizeAgentPreset('   '), undefined)
})

test('normalizeAgentPreset rejects non-strings and ids outside [a-z0-9][a-z0-9-]*', () => {
  assert.throws(() => normalizeAgentPreset(42), /agentPreset must be a string/)
  assert.throws(() => normalizeAgentPreset(['web']), /agentPreset must be a string/)
  assert.throws(() => normalizeAgentPreset('UPPER'), /invalid agent preset id/)
  assert.throws(() => normalizeAgentPreset('has space'), /invalid agent preset id/)
  assert.throws(() => normalizeAgentPreset('snake_case'), /invalid agent preset id/)
  assert.throws(() => normalizeAgentPreset('-leading'), /invalid agent preset id/)
  assert.throws(() => normalizeAgentPreset('web/task'), /invalid agent preset id/)
})

test('buildRule carries a valid preset and omits a cleared one', () => {
  assert.equal(buildRule({ title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'], agentPreset: 'web' }).agentPreset, 'web')
  const cleared = buildRule({ title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'], agentPreset: '' })
  assert.equal('agentPreset' in cleared, false)
  const absent = buildRule({ title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'] })
  assert.equal('agentPreset' in absent, false)
})

test('buildRule rejects an invalid agentPreset format', () => {
  assert.throws(
    () => buildRule({ title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'], agentPreset: 'slash/preset' }),
    /invalid agent preset id/
  )
})

// ── candidate selection ───────────────────────────────────────────────────

test('buildCandidates falls back to the default selection when no chain is set', () => {
  const out = buildCandidates(baseRule(), { provider: 'local', model: 'deepseek-v4-flash' })
  assert.deepEqual(out, [{ provider: 'local', model: 'deepseek-v4-flash' }])
})

test('buildCandidates uses the rule chain when present', () => {
  const out = buildCandidates(baseRule({
    models: [
      { provider: 'local', model: 'deepseek-v4-flash' },
      { provider: 'local', model: 'qwen38-27b' },
    ],
  }), { provider: 'local', model: 'default' })
  assert.equal(out.length, 2)
  assert.equal(out[0].model, 'deepseek-v4-flash')
})

test('buildCandidates filters the chain by the allowlist', () => {
  const out = buildCandidates(baseRule({
    models: [
      { provider: 'local', model: 'm1' },
      { provider: 'openrouter', model: 'm2' },
    ],
    allowedProviders: ['local'],
  }), { provider: 'local', model: 'default' })
  assert.deepEqual(out, [{ provider: 'local', model: 'm1' }])
})

test('buildCandidates keeps the default selection when the allowlist includes its provider', () => {
  const out = buildCandidates(baseRule({ allowedProviders: ['local'] }), { provider: 'local', model: 'm' })
  assert.deepEqual(out, [{ provider: 'local', model: 'm' }])
})

test('buildCandidates throws when no allowed model remains or the default is unusable', () => {
  assert.throws(
    () => buildCandidates(baseRule({ allowedProviders: ['local'] }), { provider: 'openrouter', model: 'm' }),
    /no allowed model candidates/
  )
  assert.throws(() => buildCandidates(baseRule(), undefined), /default model selection is unavailable/)
})

// ── fallback orchestration ────────────────────────────────────────────────

test('runWithCandidates falls back from a failed first model to a successful second', async () => {
  const spawned = []
  const out = await runWithCandidates({
    record: baseRule(),
    candidates: [
      { provider: 'local', model: 'dead' },
      { provider: 'local', model: 'alive' },
    ],
    now,
    spawn: async (candidate) => {
      spawned.push(candidate.model)
      if (candidate.model === 'dead') throw new Error('UNKNOWN_MODEL (UNKNOWN_MODEL)')
    },
  })
  assert.deepEqual(spawned, ['dead', 'alive'])
  assert.equal(out.lastRunModel, 'local/alive')
  assert.equal(out.lastRunAt, AT)
  assert.equal(out.lastRunError, undefined)
  assert.equal(out.lastRunAttempts.length, 2)
  assert.equal(out.lastRunAttempts[0].ok, false)
  assert.match(out.lastRunAttempts[0].error, /UNKNOWN_MODEL/)
  assert.equal(out.lastRunAttempts[1].ok, true)
})

test('runWithCandidates stops after the first successful attempt', async () => {
  const out = await runWithCandidates({
    record: baseRule(),
    candidates: [{ provider: 'local', model: 'alive' }],
    now,
    spawn: async () => {},
  })
  assert.equal(out.lastRunModel, 'local/alive')
  assert.equal(out.lastRunAttempts.length, 1)
  assert.equal(out.lastRunAttempts[0].ok, true)
})

test('runWithCandidates records a failure when every candidate fails', async () => {
  const out = await runWithCandidates({
    record: baseRule(),
    candidates: [
      { provider: 'local', model: 'a' },
      { provider: 'local', model: 'b' },
    ],
    now,
    spawn: async () => { throw new Error('quota exceeded') },
  })
  assert.equal(out.lastRunModel, undefined)
  assert.match(out.lastRunError, /run failed after 2 model attempt/)
  assert.match(out.lastRunError, /quota exceeded/)
  assert.equal(out.lastRunAttempts.length, 2)
  assert.ok(out.lastRunAttempts.every((attempt) => attempt.ok === false))
})

test('runWithCandidates records a clean failure with no candidates', async () => {
  const out = await runWithCandidates({ record: baseRule(), candidates: [], now, spawn: async () => {} })
  assert.equal(out.lastRunModel, undefined)
  assert.equal(out.lastRunError, 'run failed: no model candidate started')
  assert.equal(out.lastRunAttempts.length, 0)
})

test('failedBeforeAttempts clears stale run metadata on a pre-attempt failure', () => {
  const out = failedBeforeAttempts(
    baseRule({ lastRunPreset: 'stale', lastRunModel: 'local/m', agentPreset: 'ghost' }),
    AT,
    new Error("agent preset 'ghost' not found"),
  )
  assert.equal('lastRunPreset' in out, false)
  assert.equal(out.lastRunModel, undefined)
  assert.equal(out.lastRunAttempts.length, 0)
  assert.match(out.lastRunError, /agent preset 'ghost' not found/)
})

// ── run-time preset resolution ────────────────────────────────────────────

test('resolvePresetForItem returns a named preset when the service knows it', async () => {
  const service = stubService(async (id) => ({ id, name: 'Digest' }))
  assert.equal(await resolvePresetForItem(service, 'digest'), 'digest')
})

test('resolvePresetForItem throws "not found" for an unknown named preset', async () => {
  const service = stubService(async (id) => {
    if (id !== 'digest') throw new Error(`agent-presets: preset "${id}" not found (available: digest)`)
    return { id }
  })
  await assert.rejects(resolvePresetForItem(service, 'ghost'), /agent preset 'ghost' not found/)
})

test('resolvePresetForItem throws "not found" when a named preset is set but the service is missing', async () => {
  await assert.rejects(resolvePresetForItem(undefined, 'digest'), /agent preset 'digest' not found/)
  await assert.rejects(resolvePresetForItem({ list: async () => [] }, 'digest'), /agent preset 'digest' not found/)
})

test('resolvePresetForItem fails a broken named preset before any model is tried', async () => {
  const service = stubService(async () => ({ id: 'digest', broken: 'plugin rowlist is empty' }))
  await assert.rejects(resolvePresetForItem(service, 'digest'), /agent preset 'digest' failed to mount/)
})

test('resolvePresetForItem tolerates a resolving service that rejects for the default', async () => {
  const service = stubService(async (id) => {
    if (id !== undefined) throw new Error('nope')
    throw new Error('agent-presets: preset "default" not found (available: none)')
  })
  assert.equal(await resolvePresetForItem(service, undefined), undefined)
})

test('resolvePresetForItem returns the default preset when no override is set', async () => {
  const service = stubService(async (id) => ({ id: id === undefined ? 'web' : id }))
  assert.equal(await resolvePresetForItem(service, undefined), 'web')
})

test('resolvePresetForItem with no override and no service returns undefined', async () => {
  assert.equal(await resolvePresetForItem(undefined, undefined), undefined)
  assert.equal(await resolvePresetForItem({}, undefined), undefined)
})

test('resolvePresetForItem keeps a broken default resolvable so session setup surfaces it', async () => {
  const service = stubService(async () => ({ id: 'web', broken: 'unparsable' }))
  assert.equal(await resolvePresetForItem(service, undefined), 'web')
})

// ── last-run preset stamping ──────────────────────────────────────────────

test('finalizeRunPreset records the mounted preset on a successful run', () => {
  const out = finalizeRunPreset(
    baseRule({ lastRunPreset: 'stale', lastRunModel: 'local/m', lastRunError: undefined }),
    'web',
  )
  assert.equal(out.lastRunPreset, 'web')
  assert.equal(out.lastRunModel, 'local/m')
})

test('finalizeRunPreset never records a preset on a failed run and drops the stale value', () => {
  const out = finalizeRunPreset(
    baseRule({ lastRunPreset: 'stale', lastRunError: 'run failed after 2 model attempt(s)' }),
    'web',
  )
  assert.equal('lastRunPreset' in out, false)
  assert.equal(out.lastRunError, 'run failed after 2 model attempt(s)')
})

test('finalizeRunPreset omits the field on a preset-less run', () => {
  const out = finalizeRunPreset(baseRule({ lastRunPreset: 'stale' }), undefined)
  assert.equal('lastRunPreset' in out, false)
})
