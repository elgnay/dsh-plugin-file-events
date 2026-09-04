/**
 * Offline tests for the pinned-session extension: schema acceptance of the
 * optional `sessionMode` / `sessionKey` fields, write-time normalization and
 * validation, the one-job-per-key collision rule, the coalescing union used to
 * fold bursts onto a busy pinned session, and the durable mapping record
 * shape. The logic under test is pure and dependency-injected, so no harness
 * services are required.
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
  pinnedSessionSchema,
  normalizeSessionMode,
  normalizeSessionModeValue,
  normalizeSessionKey,
  isPinnedRecord,
  sessionKeyTaken,
  unionFiles,
} = __test

function baseRule(overrides = {}) {
  return {
    id: 'rule-1',
    title: 'Raw ingest',
    prompt: 'Process the new raw notes.',
    enabled: true,
    workspaceId: 'notes',
    watchPaths: ['obsidian/raw'],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function baseInput(overrides = {}) {
  return {
    title: 'Raw ingest',
    prompt: 'Process the new raw notes.',
    workspaceId: 'notes',
    watchPaths: ['obsidian/raw'],
    ...overrides,
  }
}

// ── schema acceptance ─────────────────────────────────────────────────────

test('rule schema accepts a rule in pinned mode', () => {
  const record = baseRule({ sessionMode: 'pinned', sessionKey: 'raw-ingest' })
  assert.equal(ruleSchema.safeParse(record).success, true)
})

test('rule schema accepts an explicit fresh-mode rule', () => {
  const record = baseRule({ sessionMode: 'fresh' })
  assert.equal(ruleSchema.safeParse(record).success, true)
})

test('rule schema still accepts a legacy rule without pinned fields', () => {
  assert.equal(ruleSchema.safeParse(baseRule()).success, true)
})

test('rule schema rejects an unknown sessionMode', () => {
  const record = baseRule({ sessionMode: 'sticky' })
  assert.equal(ruleSchema.safeParse(record).success, false)
})

// ── domain spec declares the mapping table ────────────────────────────────

test('domain spec declares a pinnedSessions table under the unit', () => {
  assert.equal(domainSpec.name, 'file_events')
  assert.ok(domainSpec.tables.pinnedSessions)
  assert.equal(domainSpec.tables.pinnedSessions.valueSchema, pinnedSessionSchema)
})

// ── normalizeSessionMode ──────────────────────────────────────────────────

test('sessionMode defaults to fresh when absent or empty', () => {
  assert.deepEqual(normalizeSessionMode({}), { sessionMode: 'fresh', sessionKey: undefined })
  assert.deepEqual(normalizeSessionMode({ sessionMode: '' }), { sessionMode: 'fresh', sessionKey: undefined })
  assert.deepEqual(normalizeSessionMode({ sessionMode: undefined, sessionKey: 'x' }),
    { sessionMode: 'fresh', sessionKey: undefined })
})

test('sessionMode fresh discards a supplied key', () => {
  assert.deepEqual(normalizeSessionMode({ sessionMode: 'fresh', sessionKey: 'whatever' }),
    { sessionMode: 'fresh', sessionKey: undefined })
})

test('sessionMode pinned requires a sessionKey', () => {
  assert.throws(() => normalizeSessionMode({ sessionMode: 'pinned' }), /sessionKey is required/)
  assert.throws(() => normalizeSessionMode({ sessionMode: 'pinned', sessionKey: '' }), /sessionKey is required/)
  assert.throws(() => normalizeSessionMode({ sessionMode: 'pinned', sessionKey: '   ' }), /sessionKey is required/)
})

test('sessionMode pinned accepts a valid sessionKey', () => {
  assert.deepEqual(normalizeSessionMode({ sessionMode: 'pinned', sessionKey: 'raw-ingest' }),
    { sessionMode: 'pinned', sessionKey: 'raw-ingest' })
})

test('an unknown sessionMode throws', () => {
  assert.throws(() => normalizeSessionMode({ sessionMode: 'sticky' }), /sessionMode must be "fresh" or "pinned"/)
})

// ── normalizeSessionKey ───────────────────────────────────────────────────

test('sessionKey is trimmed and validated', () => {
  assert.equal(normalizeSessionKey('  raw-ingest '), 'raw-ingest')
  assert.equal(normalizeSessionKey(undefined), undefined)
  assert.equal(normalizeSessionKey(null), undefined)
  assert.equal(normalizeSessionKey(''), undefined)
})

test('an invalid sessionKey is rejected', () => {
  for (const bad of ['Raw', 'raw ingest', '-raw', 'raw_ingest', 'raw!']) {
    assert.throws(() => normalizeSessionKey(bad), /invalid session key/, `key ${JSON.stringify(bad)}`)
  }
  assert.throws(() => normalizeSessionKey(42), /sessionKey must be a string/)
})

test('normalizeSessionModeValue accepts only fresh or pinned', () => {
  assert.equal(normalizeSessionModeValue(undefined), 'fresh')
  assert.equal(normalizeSessionModeValue('fresh'), 'fresh')
  assert.equal(normalizeSessionModeValue('pinned'), 'pinned')
  assert.throws(() => normalizeSessionModeValue('sticky'), /sessionMode must be/)
})

// ── buildRule persistence ─────────────────────────────────────────────────

test('buildRule persists pinned fields only when pinned', () => {
  const rule = buildRule(baseInput({ sessionMode: 'pinned', sessionKey: 'raw-ingest' }))
  assert.equal(rule.sessionMode, 'pinned')
  assert.equal(rule.sessionKey, 'raw-ingest')
})

test('buildRule omits pinned fields for the default fresh mode', () => {
  const rule = buildRule(baseInput())
  assert.equal('sessionMode' in rule, false)
  assert.equal('sessionKey' in rule, false)
})

test('buildRule rejects pinned mode without a key', () => {
  assert.throws(() => buildRule(baseInput({ sessionMode: 'pinned' })), /sessionKey is required/)
})

test('buildRule rejects an invalid sessionKey even when pinned', () => {
  assert.throws(() => buildRule(baseInput({ sessionMode: 'pinned', sessionKey: 'Bad Key' })), /invalid session key/)
})

test('buildRule accepts a sessionKey even when the mode is absent (fresh discards it)', () => {
  const rule = buildRule(baseInput({ sessionKey: 'orphan-key' }))
  assert.equal('sessionKey' in rule, false)
})

// ── isPinnedRecord ────────────────────────────────────────────────────────

test('isPinnedRecord requires pinned mode and a non-empty key', () => {
  assert.equal(isPinnedRecord({ sessionMode: 'pinned', sessionKey: 'k' }), true)
  assert.equal(isPinnedRecord({ sessionMode: 'pinned', sessionKey: '' }), false)
  assert.equal(isPinnedRecord({ sessionMode: 'pinned' }), false)
  assert.equal(isPinnedRecord({ sessionMode: 'fresh', sessionKey: 'k' }), false)
  assert.equal(isPinnedRecord({}), false)
  assert.equal(isPinnedRecord(null), false)
})

// ── sessionKeyTaken (one job per key) ─────────────────────────────────────

function rec(id, key) {
  return { id, sessionMode: 'pinned', sessionKey: key }
}

test('sessionKeyTaken detects a key pinned by another record', () => {
  const records = [rec('a', 'shared'), rec('b', 'other')]
  assert.equal(sessionKeyTaken(records, 'shared', 'c'), true)
  assert.equal(sessionKeyTaken(records, 'other', 'c'), true)
  assert.equal(sessionKeyTaken(records, 'free', 'c'), false)
})

test('sessionKeyTaken ignores the record that already owns the key', () => {
  assert.equal(sessionKeyTaken([rec('a', 'mine')], 'mine', 'a'), false)
})

test('sessionKeyTaken ignores fresh records and empty keys', () => {
  const records = [{ id: 'a', sessionMode: 'fresh', sessionKey: 'zombie' }, rec('b', 'used')]
  assert.equal(sessionKeyTaken(records, 'zombie', 'c'), false)
  assert.equal(sessionKeyTaken(records, 'used', 'b'), false)
  assert.equal(sessionKeyTaken(records, '', 'c'), false)
  assert.equal(sessionKeyTaken(records, undefined, 'c'), false)
})

// ── unionFiles (burst coalescing) ─────────────────────────────────────────

test('unionFiles folds a new burst onto the pending list in order', () => {
  assert.deepEqual(unionFiles(null, ['a.md', 'b.md']), ['a.md', 'b.md'])
  assert.deepEqual(unionFiles(['a.md'], ['b.md', 'c.md']), ['a.md', 'b.md', 'c.md'])
})

test('unionFiles de-duplicates files already pending', () => {
  assert.deepEqual(unionFiles(['a.md', 'b.md'], ['b.md', 'c.md']), ['a.md', 'b.md', 'c.md'])
  assert.deepEqual(unionFiles(['a.md'], ['a.md']), ['a.md'])
})

test('unionFiles tolerates a non-array accumulator and an empty incoming burst', () => {
  assert.deepEqual(unionFiles(undefined, ['a.md']), ['a.md'])
  assert.deepEqual(unionFiles(['a.md'], []), ['a.md'])
  assert.deepEqual(unionFiles(['a.md'], null), ['a.md'])
})

test('unionFiles returns a copy, never mutating the accumulator', () => {
  const base = ['a.md']
  const out = unionFiles(base, ['b.md'])
  assert.deepEqual(base, ['a.md'])
  assert.deepEqual(out, ['a.md', 'b.md'])
})

// ── pinnedSessionSchema mapping record ────────────────────────────────────

test('pinnedSessionSchema accepts a full mapping record', () => {
  const mapping = {
    sessionKey: 'raw-ingest',
    sessionId: 'session-abc',
    provider: 'local',
    model: 'deepseek-v4-flash',
    agentPreset: 'notes',
    workspaceId: 'notes',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  assert.equal(pinnedSessionSchema.safeParse(mapping).success, true)
})

test('pinnedSessionSchema accepts a minimal mapping record', () => {
  const mapping = {
    sessionKey: 'raw-ingest',
    sessionId: 'session-abc',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  assert.equal(pinnedSessionSchema.safeParse(mapping).success, true)
})

test('pinnedSessionSchema requires the key, session id, and stamps', () => {
  assert.equal(pinnedSessionSchema.safeParse({ sessionId: 's', createdAt: 'a', updatedAt: 'a' }).success, false)
  assert.equal(pinnedSessionSchema.safeParse({ sessionKey: 'k', createdAt: 'a', updatedAt: 'a' }).success, false)
  assert.equal(pinnedSessionSchema.safeParse({ sessionKey: 'k', sessionId: 's', createdAt: 'a' }).success, false)
  assert.equal(pinnedSessionSchema.safeParse({ sessionKey: 'k', sessionId: 's', createdAt: 'a', updatedAt: 'a' }).success, true)
})
