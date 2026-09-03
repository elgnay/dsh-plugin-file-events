/**
 * Offline test suite for the Host half's rule model: schema acceptance,
 * domain spec, watch-path / debounce / glob normalization, and rule
 * building. Requires no harness services.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../src/index.js')

const {
  ruleSchema,
  domainSpec,
  buildRule,
  normalizeWatchPaths,
  normalizeDebounceMs,
  normalizeGlobList,
  DEFAULT_DEBOUNCE_MS,
  MIN_DEBOUNCE_MS,
} = __test

function baseRule(overrides = {}) {
  return {
    id: 'rule-1',
    title: 'Import pipeline',
    prompt: 'Handle the changed files.',
    enabled: true,
    workspaceId: 'ws-1',
    watchPaths: ['inbox/raw'],
    debounceMs: 15000,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

// ── schema ────────────────────────────────────────────────────────────────

test('rule schema accepts a complete rule', () => {
  const parsed = ruleSchema.safeParse(baseRule())
  assert.equal(parsed.success, true)
})

test('rule schema accepts optional globs, ignoreGlobs, and trigger metadata', () => {
  const parsed = ruleSchema.safeParse(baseRule({
    globs: ['**/*.md'],
    ignoreGlobs: ['**/draft/*.md'],
    lastTriggerAt: '2026-09-03T08:00:00.000Z',
    lastTriggerFiles: ['inbox/raw/a.md', 'inbox/raw/b.md'],
  }))
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed.data.lastTriggerFiles, ['inbox/raw/a.md', 'inbox/raw/b.md'])
})

test('rule schema accepts legacy records without the optional fields', () => {
  const parsed = ruleSchema.safeParse(baseRule({
    globs: undefined,
    ignoreGlobs: undefined,
    debounceMs: undefined,
  }))
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.debounceMs, undefined)
})

test('rule schema rejects a record missing required fields', () => {
  const broken = {
    id: 'rule-3',
    title: 'no watch paths',
    prompt: 'P',
    enabled: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  assert.equal(ruleSchema.safeParse(broken).success, false)
})

test('rule schema rejects an empty watchPaths array', () => {
  assert.equal(ruleSchema.safeParse(baseRule({ watchPaths: [] })).success, false)
})

test('rule schema rejects a model candidate missing its model', () => {
  assert.equal(ruleSchema.safeParse(baseRule({ models: [{ provider: 'local' }] })).success, false)
})

test('rule schema accepts run metadata (lastRunModel, lastRunAttempts)', () => {
  const parsed = ruleSchema.safeParse(baseRule({
    lastRunAt: '2026-09-03T07:59:00.000Z',
    lastRunModel: 'local/deepseek-v4-flash',
    lastRunAttempts: [
      { provider: 'local', model: 'deepseek-v4-flash', attemptedAt: '2026-09-03T07:59:00.000Z', ok: false, error: 'UNKNOWN_MODEL' },
      { provider: 'local', model: 'qwen38-27b', attemptedAt: '2026-09-03T07:59:05.000Z', ok: true },
    ],
  }))
  assert.equal(parsed.success, true)
})

test('domain spec declares the rules table under the file_events unit', () => {
  assert.equal(domainSpec.name, 'file_events')
  assert.equal(domainSpec.version, 1)
  assert.equal(typeof domainSpec.tables.rules.valueSchema, 'object')
  assert.equal(domainSpec.tables.rules.valueSchema, ruleSchema)
})

// ── buildRule ─────────────────────────────────────────────────────────────

test('buildRule stamps id/timestamps and defaults enabled to true', () => {
  const rule = buildRule({
    title: 'T', prompt: 'P', workspaceId: 'ws-1', watchPaths: 'inbox/raw\ncontent/posts',
  })
  assert.match(rule.id, /^rule-/)
  assert.equal(rule.title, 'T')
  assert.equal(rule.prompt, 'P')
  assert.equal(rule.enabled, true)
  assert.equal(rule.workspaceId, 'ws-1')
  assert.deepEqual(rule.watchPaths, ['inbox/raw', 'content/posts'])
  assert.equal(rule.debounceMs, DEFAULT_DEBOUNCE_MS)
  assert.equal(rule.createdAt, rule.updatedAt)
})

test('buildRule requires title, prompt, workspaceId, and watchPaths', () => {
  assert.throws(() => buildRule({ prompt: 'P', workspaceId: 'w', watchPaths: ['a'] }), /non-empty title/)
  assert.throws(() => buildRule({ title: 'T', workspaceId: 'w', watchPaths: ['a'] }), /non-empty prompt/)
  assert.throws(() => buildRule({ title: 'T', prompt: 'P', watchPaths: ['a'] }), /workspaceId/)
  assert.throws(() => buildRule({ title: 'T', prompt: 'P', workspaceId: 'w' }), /watchPaths/)
})

test('buildRule honors an explicit enabled:false and a custom debounce', () => {
  const rule = buildRule({
    title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'], enabled: false, debounceMs: 5000,
  })
  assert.equal(rule.enabled, false)
  assert.equal(rule.debounceMs, 5000)
})

test('buildRule omits optional fields when absent and keeps them when provided', () => {
  const bare = buildRule({ title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'] })
  assert.equal('globs' in bare, false)
  assert.equal('ignoreGlobs' in bare, false)
  assert.equal('models' in bare, false)
  assert.equal('allowedProviders' in bare, false)
  assert.equal('agentPreset' in bare, false)

  const full = buildRule({
    title: 'T', prompt: 'P', workspaceId: 'w', watchPaths: ['a'],
    globs: ['**/*.md'], agentPreset: 'web', models: [{ provider: 'local', model: 'm' }],
  })
  assert.deepEqual(full.globs, ['**/*.md'])
  assert.equal(full.agentPreset, 'web')
  assert.deepEqual(full.models, [{ provider: 'local', model: 'm' }])
})

// ── watch path normalization ──────────────────────────────────────────────

test('normalizeWatchPaths trims, drops trailing slashes, and de-duplicates', () => {
  const out = normalizeWatchPaths([' inbox/raw ', 'content//', 'inbox/raw'])
  assert.deepEqual(out, ['inbox/raw', 'content'])
})

test('normalizeWatchPaths splits a newline/comma string into paths', () => {
  assert.deepEqual(normalizeWatchPaths('inbox\ncontent/posts,a/b'), ['inbox', 'content/posts', 'a/b'])
})

test('normalizeWatchPaths rejects an empty list', () => {
  assert.throws(() => normalizeWatchPaths([]), /at least one relative path/)
  assert.throws(() => normalizeWatchPaths(['', '  ']), /at least one relative path/)
})

test('normalizeWatchPaths rejects absolute paths and .. segments (workspace escape)', () => {
  assert.throws(() => normalizeWatchPaths(['/etc']), /must be relative/)
  assert.throws(() => normalizeWatchPaths(['../outside']), /must not contain '\.\.'/)
  assert.throws(() => normalizeWatchPaths(['a/../../b']), /must not contain '\.\.'/)
})

test('normalizeWatchPaths rejects a non-array, non-string input', () => {
  assert.throws(() => normalizeWatchPaths(42), /array/)
  assert.throws(() => normalizeWatchPaths({ 0: 'a' }), /array/)
})

// ── debounce normalization ────────────────────────────────────────────────

test('normalizeDebounceMs defaults to 15000 and clamps to [1000, 600000]', () => {
  assert.equal(normalizeDebounceMs(undefined), DEFAULT_DEBOUNCE_MS)
  assert.equal(normalizeDebounceMs(500), MIN_DEBOUNCE_MS)
  assert.equal(normalizeDebounceMs(0), MIN_DEBOUNCE_MS)
  assert.equal(normalizeDebounceMs(600000), 600000)
  assert.equal(normalizeDebounceMs(99999999), 600000)
})

test('normalizeDebounceMs rounds fractional values and rejects non-numbers', () => {
  assert.equal(normalizeDebounceMs(1250.6), 1251)
  assert.throws(() => normalizeDebounceMs('15000'), /number of milliseconds/)
  assert.throws(() => normalizeDebounceMs(null), /number of milliseconds/)
})

// ── glob normalization ────────────────────────────────────────────────────

test('normalizeGlobList trims, splits strings, and de-duplicates', () => {
  assert.deepEqual(normalizeGlobList(['**/*.md', ' **/*.txt ', '**/*.md']), ['**/*.md', '**/*.txt'])
  assert.deepEqual(normalizeGlobList('**/*.md **/*.txt, **/*.rst'), ['**/*.md', '**/*.txt', '**/*.rst'])
})

test('normalizeGlobList returns undefined for an empty list', () => {
  assert.equal(normalizeGlobList([]), undefined)
  assert.equal(normalizeGlobList(''), undefined)
  assert.equal(normalizeGlobList(undefined), undefined)
})

test('normalizeGlobList rejects a non-array, non-string input', () => {
  assert.throws(() => normalizeGlobList(7), /array of glob patterns/)
})
