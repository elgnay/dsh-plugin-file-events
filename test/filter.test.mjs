/**
 * Offline tests for the watch-decision and prompt-injection logic: default
 * ignores (hidden segments / temp noise), glob matching, change
 * classification, and `{files}` interpolation. All pure — no watcher or
 * harness involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { __test } = require('../src/index.js')

const {
  isHiddenSegment,
  ignoredByDefault,
  matchAnyGlob,
  shouldTrigger,
  eventPayloadFor,
  buildPrompt,
  normalizeGlobList,
  PROMPT_FILES_CAP,
} = __test

function baseRule(overrides = {}) {
  return {
    id: 'rule-1',
    title: 'T',
    prompt: 'Handle the changed files.',
    enabled: true,
    workspaceId: 'ws-1',
    watchPaths: ['inbox/raw'],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

// ── hidden segments ───────────────────────────────────────────────────────

test('isHiddenSegment flags dotfiles and dot directories anywhere in the path', () => {
  assert.equal(isHiddenSegment('.git/config'), true)
  assert.equal(isHiddenSegment('.obsidian/workspace.json'), true)
  assert.equal(isHiddenSegment('inbox/.staging/x.md'), true)
  assert.equal(isHiddenSegment('inbox/raw/a.md'), false)
  assert.equal(isHiddenSegment('deep.subdir/file.txt'), false)
})

test('ignoredByDefault flags temp/noise components (.tmp, ~, .DS_Store)', () => {
  assert.equal(ignoredByDefault('a/scratch.tmp'), true)
  assert.equal(ignoredByDefault('a/backup~'), true)
  assert.equal(ignoredByDefault('a/.DS_Store'), true)
  assert.equal(ignoredByDefault('a/vim.swp'), true)
  assert.equal(ignoredByDefault('a/report.md'), false)
})

// ── glob matching ─────────────────────────────────────────────────────────

test('matchAnyGlob matches a path against any of several globs', () => {
  const globs = ['**/*.md', '*.csv']
  assert.equal(matchAnyGlob('inbox/raw/a.md', globs), true)
  assert.equal(matchAnyGlob('a.csv', globs), true)
  assert.equal(matchAnyGlob('inbox/raw/a.txt', globs), false)
})

test('matchAnyGlob returns false for empty or missing glob lists', () => {
  assert.equal(matchAnyGlob('a.md', []), false)
  assert.equal(matchAnyGlob('a.md', undefined), false)
})

test('shouldTrigger honors rule globs as an allowlist', () => {
  const rule = baseRule({ globs: ['**/*.md'] })
  assert.equal(shouldTrigger(rule, 'inbox/raw/a.md'), true)
  assert.equal(shouldTrigger(rule, 'inbox/raw/a.txt'), false)
  // Hidden and temp files never trigger even when they match the globs.
  assert.equal(shouldTrigger(rule, '.hidden.md'), false)
})

test('shouldTrigger triggers on anything when no globs are set', () => {
  const rule = baseRule()
  assert.equal(shouldTrigger(rule, 'inbox/raw/a.txt'), true)
  assert.equal(shouldTrigger(rule, 'inbox/raw/sub/a.md'), true)
})

test('shouldTrigger suppresses hidden and default-ignored paths', () => {
  const rule = baseRule()
  assert.equal(shouldTrigger(rule, '.git/index'), false)
  assert.equal(shouldTrigger(rule, '.obsidian/workspace.json'), false)
  assert.equal(shouldTrigger(rule, 'x.tmp'), false)
})

test('shouldTrigger suppresses paths matched by ignoreGlobs', () => {
  const rule = baseRule({ ignoreGlobs: ['**/draft/**'] })
  assert.equal(shouldTrigger(rule, 'inbox/raw/draft/a.md'), false)
  assert.equal(shouldTrigger(rule, 'inbox/raw/final/a.md'), true)
})

test('shouldTrigger keeps an explicitly watched dot root working (filter is beneath the root)', () => {
  // The watch root is `.config`, so the root-relative path never includes the
  // `.config` segment itself — only its children are tested for hiddenness.
  const rule = baseRule()
  assert.equal(shouldTrigger(rule, 'settings.json'), true)
})

// ── change classification ─────────────────────────────────────────────────

test('eventPayloadFor yields workspace-relative and root-relative paths', () => {
  const rule = baseRule()
  const workspaceAbs = path.resolve('/ws')
  const rootAbs = path.resolve('/ws/inbox/raw')
  const payload = eventPayloadFor(rule, workspaceAbs, rootAbs, path.resolve('/ws/inbox/raw/a.md'))
  assert.deepEqual(payload, { wsRel: 'inbox/raw/a.md', rootRel: 'a.md' })
})

test('eventPayloadFor returns null for changes outside the watch root', () => {
  const rule = baseRule()
  assert.equal(eventPayloadFor(rule, '/ws', '/ws/inbox/raw', '/ws/elsewhere/b.md'), null)
})

test('eventPayloadFor treats a single-file watch root as its own basename', () => {
  const rule = baseRule({ watchPaths: ['import-list.csv'], globs: ['*.csv'] })
  const payload = eventPayloadFor(rule, '/ws', '/ws/import-list.csv', '/ws/import-list.csv')
  assert.deepEqual(payload, { wsRel: 'import-list.csv', rootRel: 'import-list.csv' })
  // A file-root change that does not match the rule globs is suppressed.
  const filtered = eventPayloadFor(baseRule({ watchPaths: ['a.csv'], globs: ['*.md'] }), '/ws', '/ws/a.csv', '/ws/a.csv')
  assert.equal(filtered, null)
})

test('eventPayloadFor filters through hidden/default-ignore rules', () => {
  const rule = baseRule()
  assert.equal(eventPayloadFor(rule, '/ws', '/ws/inbox/raw', '/ws/inbox/raw/.hidden'), null)
  assert.equal(eventPayloadFor(rule, '/ws', '/ws/inbox/raw', '/ws/inbox/raw/x.tmp'), null)
})

// ── prompt injection ──────────────────────────────────────────────────────

test('buildPrompt replaces every {files} placeholder with the list', () => {
  const prompt = 'Here are the files:\n{files}\nProcess them.\nAgain: {files}'
  const out = buildPrompt(prompt, ['a.md', 'b/c.md'])
  assert.match(out, /Here are the files:\n - a\.md\n - b\/c\.md\nProcess them\.\nAgain:  - a\.md\n - b\/c\.md/)
})

test('buildPrompt appends a Changed files block when there is no placeholder', () => {
  const out = buildPrompt('Do the thing.', ['a.md', 'b/c.md'])
  assert.match(out, /^Do the thing\.\n\nChanged files:\n - a\.md\n - b\/c\.md$/)
})

test('buildPrompt leaves a placeholder-less prompt unchanged for an empty list', () => {
  assert.equal(buildPrompt('Do the thing.', []), 'Do the thing.')
  assert.equal(buildPrompt('Do the thing.', undefined), 'Do the thing.')
})

test('buildPrompt substitutes a (no file changes) marker for an empty list', () => {
  const out = buildPrompt('See {files}', [])
  assert.match(out, /\(no file changes recorded\)/)
})

test('buildPrompt caps the injected list and reports the overflow count', () => {
  const many = Array.from({ length: PROMPT_FILES_CAP + 5 }, (_, i) => `f${i}.md`)
  const out = buildPrompt('List:\n{files}', many)
  assert.match(out, /List:\n - f0\.md/)
  assert.match(out, /\.\.\. and 5 more/)
  const placeholderCopies = (out.match(/ - f/g) || []).length
  assert.equal(placeholderCopies, PROMPT_FILES_CAP)
})

test('normalizeGlobList orders globs as given and tolerates mixed separators', () => {
  assert.deepEqual(normalizeGlobList('**/*.md **/*.txt'), ['**/*.md', '**/*.txt'])
  assert.deepEqual(normalizeGlobList(['*.md', '*.md', '*.txt']), ['*.md', '*.txt'])
})
