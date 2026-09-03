'use strict'

/**
 * dsh-plugin-file-events — Host half
 *
 * Event-driven counterpart to the cron plugin: instead of firing on a
 * schedule, each watch rule watches one or more directories under a bound
 * workspace and, when matching files change there (debounced), starts a
 * *fresh* agent session to handle the change. Runs never depend on a live
 * chat session — the watcher and the sessions it spawns live in the host
 * process.
 *
 * The run model is shared with the scheduled-items fork:
 *
 * - fresh agent session, independent per trigger;
 * - session bound to a workspace (`meta.cwd` = workspace path, then
 *   `workspace.attachSession`) so the agent runs in the right directory and
 *   shows up under that workspace's group;
 * - an optional agent preset (`agentPreset`) mounted in the session's setup;
 * - an optional ordered model chain (`models`) with automatic fallback when a
 *   candidate fails to start, restricted by an optional provider allowlist
 *   (`allowedProviders`);
 * - last-trigger / last-run metadata on each rule.
 *
 * Each rule is debounced: file events accumulate into a pending set and reset
 * a timer; when it fires, ONE agent run handles the whole burst, with the
 * changed-file list injected into the prompt (a `{files}` placeholder in the
 * rule prompt, or an appended "Changed files:" block). Overlapping runs for
 * the same rule are avoided: while one run is in flight, further events arm a
 * follow-up window instead of starting a second session concurrently.
 *
 * Zero `@deepseek-ai/dsh-*` imports: every harness capability is reached
 * through `ctx.*` runtime services (`storageDomain`, `workspaceRegistry`,
 * `agents`, `agentDefaultModel`, `agentPresets`, `sessionTitle`,
 * `webServer`). Runtime dependencies are plain npm packages (chokidar for
 * recursive watching, minimatch for glob matching, zod for schemas).
 */

const { randomUUID } = require('node:crypto')
const path = require('node:path')
const chokidar = require('chokidar')
const { minimatch } = require('minimatch')
const { z } = require('zod')

/** One entry of an ordered model chain. */
const modelCandidateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
})

/** One recorded attempt inside a single run. */
const runAttemptSchema = z.object({
  provider: z.string(),
  model: z.string(),
  attemptedAt: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
})

/** Durable shape of one watch rule. */
const ruleSchema = z.object({
  id: z.string(),
  title: z.string(),
  enabled: z.boolean(),
  workspaceId: z.string(),
  watchPaths: z.array(z.string().min(1)).min(1),
  globs: z.array(z.string()).optional(),
  ignoreGlobs: z.array(z.string()).optional(),
  debounceMs: z.number().int().optional(),
  prompt: z.string(),
  // NEW (all optional — absent on legacy rules).
  agentPreset: z.string().optional(),
  models: z.array(modelCandidateSchema).optional(),
  allowedProviders: z.array(z.string().min(1)).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastTriggerAt: z.string().optional(),
  lastTriggerFiles: z.array(z.string()).optional(),
  lastRunAt: z.string().optional(),
  lastRunModel: z.string().optional(),
  lastRunPreset: z.string().optional(),
  lastRunAttempts: z.array(runAttemptSchema).optional(),
  lastRunError: z.string().optional(),
})

/** The file-events domain: one `rules` table keyed by rule id. */
const domainSpec = {
  name: 'file_events',
  version: 1,
  tables: { rules: { valueSchema: ruleSchema } },
}

/**
 * How long one candidate attempt waits for its first model request to either
 * start producing output or fail. Real provider failures (model not found,
 * connection error, auth/quota) surface as a terminal `turn/end` error from
 * the harness well before this ceiling; the ceiling only bounds a wait that
 * never receives any signal (see {@link startCandidate}'s watchdog).
 */
const STARTUP_TIMEOUT_MS = 2 * 60 * 1000

/** Maximum request body the API accepts (create/update payloads). */
const MAX_BODY_BYTES = 64 * 1024

/** Default per-rule debounce window between the first event and a run. */
const DEFAULT_DEBOUNCE_MS = 15000

/** Debounce lower/upper bounds, enforced by {@link normalizeDebounceMs}. */
const MIN_DEBOUNCE_MS = 1000
const MAX_DEBOUNCE_MS = 10 * 60 * 1000

/**
 * At most this many changed files are listed in the injected prompt context;
 * anything beyond the cap is summarized as a count.
 */
const PROMPT_FILES_CAP = 200

/** File-name patterns treated as editor/temp noise, matched per component. */
const DEFAULT_IGNORE_GLOBS = ['*.tmp', '*~', '*.swp', '*.icloud', '.DS_Store']

/**
 * Validate and normalize the optional model fields from a create/update
 * payload. Throws on malformed input. Semantics:
 *
 * - `models: undefined` → no chain. An empty array is treated as "clear the
 *   chain" and normalizes to `undefined`.
 * - Each entry must be `{ provider, model }` with non-empty strings; entries
 *   are trimmed.
 * - `allowedProviders: undefined` → unrestricted. An empty array is treated
 *   as unrestricted. Provider names are trimmed and de-duplicated.
 * - When both a chain and a non-empty allowlist are supplied, every model's
 *   provider must be inside the allowlist.
 *
 * @returns `{ models?, allowedProviders? }` with undefined values when absent.
 */
function normalizeModelFields(input) {
  const result = { models: undefined, allowedProviders: undefined }
  if (input === null || typeof input !== 'object') return result
  let { models, allowedProviders } = input

  if (models !== undefined) {
    if (!Array.isArray(models)) {
      throw new Error('models must be an array of { provider, model }')
    }
    const cleaned = []
    for (const entry of models) {
      if (entry === null || typeof entry !== 'object'
        || typeof entry.provider !== 'string' || typeof entry.model !== 'string') {
        throw new Error('models must be an array of { provider, model }')
      }
      const provider = entry.provider.trim()
      const model = entry.model.trim()
      if (provider === '' || model === '') {
        throw new Error('models: provider and model must be non-empty strings')
      }
      cleaned.push({ provider, model })
    }
    models = cleaned.length > 0 ? cleaned : undefined
  }

  if (allowedProviders !== undefined) {
    if (!Array.isArray(allowedProviders)) {
      throw new Error('allowedProviders must be an array of non-empty provider names')
    }
    const providers = new Set()
    for (const value of allowedProviders) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('allowedProviders must be an array of non-empty provider names')
      }
      providers.add(value.trim())
    }
    allowedProviders = providers.size > 0 ? [...providers] : undefined
  }

  if (models !== undefined || allowedProviders !== undefined) {
    assertAllowedProviders({ models, allowedProviders })
  }

  return { models, allowedProviders }
}

/**
 * Ensure a record's model chain never leaves its provider allowlist. Guards
 * the merged result of a PATCH even when `models` and `allowedProviders`
 * arrive in separate updates.
 */
function assertAllowedProviders(item) {
  const allowed = item && Array.isArray(item.allowedProviders) ? item.allowedProviders : []
  const models = item && Array.isArray(item.models) ? item.models : []
  if (allowed.length === 0 || models.length === 0) return
  for (const candidate of models) {
    if (!allowed.includes(candidate.provider)) {
      throw new Error(
        `model '${candidate.provider}/${candidate.model}' uses provider '${candidate.provider}' `
        + `which is not in allowedProviders [${allowed.join(', ')}]`
      )
    }
  }
}

/** A dsh preset id: lowercase alphanumeric start, then `[a-z0-9-]`. */
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Validate and normalize the optional `agentPreset` field from a create/update
 * payload. `undefined` / `null` / `""` → no override (use the default preset);
 * a non-empty value must follow `[a-z0-9][a-z0-9-]*` and is returned trimmed.
 */
function normalizeAgentPreset(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error('agentPreset must be a string')
  }
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (!PRESET_ID_RE.test(trimmed)) {
    throw new Error(`invalid agent preset id '${trimmed}' (expected [a-z0-9][a-z0-9-]*)`)
  }
  return trimmed
}

/**
 * Resolve the preset a run should mount, *before* any model candidate is
 * tried, so a bad preset fails the run and never triggers model fallback.
 *
 * - A named override that is unknown, or belongs to a deployment whose
 *   `agentPresets` service is missing, throws `agent preset '<id>' not
 *   found`. A named preset discovery reports as broken throws
 *   `<id> failed to mount: <reason>`.
 * - With no override and no service there is nothing to mount → `undefined`.
 * - With no override and a service present → the default preset's id. A
 *   broken default still returns its id so the mount surfaces the reason.
 */
async function resolvePresetForItem(agentPresets, agentPreset) {
  const requested = typeof agentPreset === 'string' && agentPreset.trim() !== '' ? agentPreset : undefined
  const hasService = !!agentPresets
    && typeof agentPresets.resolve === 'function'
    && typeof agentPresets.mount === 'function'
  if (requested !== undefined) {
    if (!hasService) throw new Error(`agent preset '${requested}' not found`)
    let resolved
    try {
      resolved = await agentPresets.resolve(requested)
    } catch {
      throw new Error(`agent preset '${requested}' not found`)
    }
    if (!resolved || resolved.id !== requested) throw new Error(`agent preset '${requested}' not found`)
    if (resolved.broken !== undefined) {
      throw new Error(`agent preset '${requested}' failed to mount: ${resolved.broken}`)
    }
    return resolved.id
  }
  if (!hasService) return undefined
  const resolved = await agentPresets.resolve(undefined).catch(() => undefined)
  return resolved && resolved.id ? resolved.id : undefined
}

/**
 * Stamp a run result with the preset that was actually mounted, recorded only
 * on a successful run; a failed run drops any stale preset.
 */
function finalizeRunPreset(out, presetId) {
  const { lastRunPreset, ...rest } = out
  if (presetId !== undefined && out.lastRunError === undefined) {
    return { ...rest, lastRunPreset: presetId }
  }
  return rest
}

/**
 * Build the ordered candidate list for one run.
 * @throws when the resulting candidate list is empty, or no default selection
 *   is available and the rule has no chain.
 */
function buildCandidates(rule, defaultSelection) {
  const hasChain = Array.isArray(rule && rule.models) && rule.models.length > 0
  let candidates
  if (hasChain) {
    candidates = rule.models.map((candidate) => ({ provider: candidate.provider, model: candidate.model }))
  } else {
    const selection = defaultSelection
    if (!selection || typeof selection.provider !== 'string' || selection.provider === ''
      || typeof selection.model !== 'string' || selection.model === '') {
      throw new Error('the default model selection is unavailable; set models to pin a model chain')
    }
    candidates = [{ provider: selection.provider, model: selection.model }]
  }
  if (Array.isArray(rule && rule.allowedProviders) && rule.allowedProviders.length > 0) {
    candidates = candidates.filter((candidate) => rule.allowedProviders.includes(candidate.provider))
  }
  if (candidates.length === 0) {
    throw new Error('no allowed model candidates')
  }
  return candidates
}

/**
 * Try each candidate in order until one attempt starts. Fallback happens
 * exactly when `spawn` rejects; a resolved `spawn` commits the run on that
 * model and stops. Deliberately harness-free — `spawn` is injected.
 *
 * @returns the updated rule with last-run metadata.
 */
async function runWithCandidates({ record, candidates, spawn, now = () => new Date().toISOString() }) {
  const startedAt = now()
  const attempts = []
  for (const candidate of candidates) {
    const attempt = { provider: candidate.provider, model: candidate.model, attemptedAt: now() }
    try {
      await spawn(candidate)
      attempt.ok = true
      attempts.push(attempt)
      return {
        ...record,
        lastRunAt: startedAt,
        lastRunModel: `${candidate.provider}/${candidate.model}`,
        lastRunAttempts: attempts,
        lastRunError: undefined,
      }
    } catch (error) {
      attempt.ok = false
      attempt.error = String((error && error.message) || error)
      attempts.push(attempt)
    }
  }
  const last = attempts[attempts.length - 1]
  return {
    ...record,
    lastRunAt: startedAt,
    lastRunModel: undefined,
    lastRunAttempts: attempts,
    lastRunError: last === undefined
      ? 'run failed: no model candidate started'
      : `run failed after ${attempts.length} model attempt(s): ${last.error}`,
  }
}

/**
 * A record that failed before any model attempt (bad config / missing preset /
 * no candidates). Run and preset metadata are cleared so the record always
 * describes the latest run.
 */
function failedBeforeAttempts(record, at, error) {
  const { lastRunPreset, ...base } = record
  return {
    ...base,
    lastRunAt: at,
    lastRunModel: undefined,
    lastRunAttempts: [],
    lastRunError: String((error && error.message) || error),
  }
}

/**
 * Normalize the watch paths of a rule. Accepts an array or a single
 * newline/comma-separated string. Each entry is trimmed (and its trailing
 * slashes dropped) and must be **relative** to the workspace — a leading `/`
 * or any `..` segment would let the watcher escape the workspace, so those
 * are rejected.
 *
 * @returns a de-duplicated non-empty array of relative paths.
 */
function normalizeWatchPaths(value) {
  const rawList = typeof value === 'string' ? value.split(/[\n,，]+/) : value
  if (!Array.isArray(rawList)) {
    throw new Error('watchPaths must be an array of relative paths')
  }
  const out = []
  const seen = new Set()
  for (const raw of rawList) {
    if (raw !== null && typeof raw === 'object') {
      throw new Error('watchPaths must be an array of relative paths')
    }
    if (typeof raw !== 'string') continue
    const p = raw.trim().replace(/\/+$/, '')
    if (p === '') continue
    const segments = p.split('/')
    if (segments[0] === '' || segments.includes('..')) {
      throw new Error(`watch path '${p}' must be relative to the workspace and must not contain '..'`)
    }
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  if (out.length === 0) {
    throw new Error('watchPaths must contain at least one relative path')
  }
  return out
}

/**
 * Validate and clamp a debounce window (ms). `undefined` yields the default
 * 15 s; out-of-range or fractional values are clamped/rounded to
 * [1000, 600000].
 */
function normalizeDebounceMs(value) {
  if (value === undefined) return DEFAULT_DEBOUNCE_MS
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('debounceMs must be a number of milliseconds')
  }
  return Math.round(Math.min(MAX_DEBOUNCE_MS, Math.max(MIN_DEBOUNCE_MS, value)))
}

/**
 * Normalize a glob list (used for both `globs` and `ignoreGlobs`). Accepts an
 * array or a single string split on whitespace/commas. Returns `undefined`
 * when empty so an explicit `[]` clears the list.
 */
function normalizeGlobList(value) {
  if (value === undefined) return undefined
  const rawList = typeof value === 'string' ? value.split(/[\s,，]+/) : value
  if (!Array.isArray(rawList)) {
    throw new Error('globs must be an array of glob patterns')
  }
  const out = []
  const seen = new Set()
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue
    const glob = raw.trim()
    if (glob === '' || seen.has(glob)) continue
    seen.add(glob)
    out.push(glob)
  }
  return out.length > 0 ? out : undefined
}

/** Convert a platform path to POSIX separators (for globs/metadata). */
function toPosix(p) {
  return p.split(path.sep).join('/')
}

/** True when any component of the relative path starts with a dot. */
function isHiddenSegment(rel) {
  return rel.split('/').some((segment) => segment.startsWith('.'))
}

/** True when any component matches the default temp/noise ignore globs. */
function ignoredByDefault(rel) {
  const segments = rel.split('/')
  return segments.some((segment) => DEFAULT_IGNORE_GLOBS.some((glob) => minimatch(segment, glob)))
}

/** True when the relative path matches at least one of the supplied globs. */
function matchAnyGlob(rel, globs) {
  return Array.isArray(globs) && globs.length > 0 && globs.some((glob) => minimatch(rel, glob))
}

/**
 * Decide whether a change (given as a path relative to its watch root) should
 * trigger a run for a rule:
 *
 * 1. Hidden segments and default noise (`.git`, `.obsidian`, `*.tmp`, …) never
 *    trigger, unless the path's own watch root chose to surface them — hidden
 *    filtering applies *beneath* the root the user selected, so a dot-dir the
 *    user explicitly watches still works.
 * 2. A rule `ignoreGlobs` entry matching the path suppresses it.
 * 3. When `globs` are configured the path must match at least one.
 */
function shouldTrigger(rule, rootRel) {
  if (isHiddenSegment(rootRel) || ignoredByDefault(rootRel)) return false
  if (matchAnyGlob(rootRel, rule.ignoreGlobs)) return false
  if (matchAnyGlob(rootRel, rule.globs)) return true
  return !(Array.isArray(rule.globs) && rule.globs.length > 0)
}

/**
 * Classify one absolute changed file against a rule/watch root.
 *
 * @param rule the stored rule.
 * @param workspaceAbs canonical absolute path of the rule's workspace.
 * @param rootAbs canonical absolute path of the watch root.
 * @param eventPath absolute path the watcher reported.
 * @returns `{ wsRel, rootRel }` (both POSIX-relative) when the change should
 *   trigger a run, or `null` when it should be ignored.
 */
function eventPayloadFor(rule, workspaceAbs, rootAbs, eventPath) {
  let rootRel = toPosix(path.relative(rootAbs, eventPath))
  if (rootRel === '') {
    // The changed path IS the watch root itself — a single-file watch root, or
    // a watch path that turned out to be a file rather than a directory. Treat
    // the root's own name as the root-relative path so glob matching still
    // has something to test against.
    rootRel = toPosix(path.basename(rootAbs))
  } else if (rootRel.startsWith('..') || path.isAbsolute(rootRel)) {
    return null
  }
  if (!shouldTrigger(rule, rootRel)) return null
  const wsRel = toPosix(path.relative(workspaceAbs, eventPath))
  if (wsRel === '' || wsRel.startsWith('..') || path.isAbsolute(wsRel)) return null
  return { wsRel, rootRel }
}

/**
 * Inject the debounced change list into a rule prompt. Every `{files}`
 * placeholder is replaced with the bare indented list (the author positioned
 * it inside their own prose, so no heading is added); when the prompt has no
 * placeholder and the list is non-empty, a "Changed files:" block is appended
 * instead. The list is capped at {@link PROMPT_FILES_CAP}, with overflow
 * summarized as a count.
 */
function buildPrompt(rulePrompt, wsRels) {
  const files = Array.isArray(wsRels) ? wsRels : []
  const prompt = typeof rulePrompt === 'string' ? rulePrompt : ''
  const listed = files.slice(0, PROMPT_FILES_CAP).map((f) => ` - ${f}`).join('\n')
  const overflow = files.length > PROMPT_FILES_CAP ? `\n... and ${files.length - PROMPT_FILES_CAP} more` : ''
  if (prompt.includes('{files}')) {
    const inline = files.length === 0 ? '(no file changes recorded)' : `${listed}${overflow}`
    return prompt.split('{files}').join(inline)
  }
  if (files.length === 0) return prompt
  return `${prompt}\n\nChanged files:\n${listed}${overflow}`
}

/** Build one fresh rule record from validated input. */
function buildRule(input) {
  if (!input || typeof input.title !== 'string' || input.title.trim() === '') {
    throw new Error('input must provide a non-empty title')
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    throw new Error('input must provide a non-empty prompt')
  }
  if (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '') {
    throw new Error('input must provide a workspaceId')
  }
  const { models, allowedProviders } = normalizeModelFields(input)
  const agentPreset = normalizeAgentPreset(input.agentPreset)
  const watchPaths = normalizeWatchPaths(input.watchPaths)
  const globs = normalizeGlobList(input.globs)
  const ignoreGlobs = normalizeGlobList(input.ignoreGlobs)
  const debounceMs = normalizeDebounceMs(input.debounceMs)
  const now = new Date().toISOString()
  const id = `rule-${randomUUID()}`
  return {
    id,
    title: input.title.trim(),
    prompt: input.prompt,
    enabled: input.enabled !== undefined ? !!input.enabled : true,
    workspaceId: input.workspaceId.trim(),
    watchPaths,
    ...(globs === undefined ? {} : { globs }),
    ...(ignoreGlobs === undefined ? {} : { ignoreGlobs }),
    debounceMs,
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(models === undefined ? {} : { models }),
    ...(allowedProviders === undefined ? {} : { allowedProviders }),
    createdAt: now,
    updatedAt: now,
  }
}

module.exports = {
  name: 'file-events',
  inject: ['storageDomain', 'agents', 'agentDefaultModel', 'workspaceRegistry', 'sessionTitle', 'webServer'],

  // Exposed for the offline test suite only (test/*.test.mjs); Cordis
  // ignores unknown export properties.
  __test: {
    ruleSchema,
    domainSpec,
    buildRule,
    modelCandidateSchema,
    runAttemptSchema,
    normalizeModelFields,
    assertAllowedProviders,
    normalizeAgentPreset,
    resolvePresetForItem,
    finalizeRunPreset,
    buildCandidates,
    runWithCandidates,
    failedBeforeAttempts,
    normalizeWatchPaths,
    normalizeDebounceMs,
    normalizeGlobList,
    DEFAULT_DEBOUNCE_MS,
    MIN_DEBOUNCE_MS,
    MAX_DEBOUNCE_MS,
    DEFAULT_IGNORE_GLOBS,
    PROMPT_FILES_CAP,
    isHiddenSegment,
    ignoredByDefault,
    matchAnyGlob,
    shouldTrigger,
    toPosix,
    eventPayloadFor,
    buildPrompt,
  },

  /**
   * Mount the store, the watcher layer, and the HTTP API.
   * @param ctx - harness context carrying the injected services.
   * @param rawConfig - plugin config (`{ cwd?: string }`); validated by Cordis
   *   when present, otherwise defaulted here.
   */
  apply(ctx, rawConfig) {
    const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
    const defaultCwd = config.cwd || process.cwd()

    let table
    const watches = new Map() // ruleId → watcher state

    const requireTable = () => {
      if (!table) throw new Error('file-event rules are not started yet')
      return table
    }

    const sendJson = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }

    const readJsonBody = async (req) => {
      const chunks = []
      let received = 0
      for await (const chunk of req) {
        received += chunk.length
        if (received > MAX_BODY_BYTES) throw new Error('request body too large')
        chunks.push(chunk)
      }
      if (chunks.length === 0) return {}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }

    // ── run machinery (shared with the scheduled-items fork) ───────────────

    /**
     * Spawn one candidate in a fresh agent session, submit the run prompt,
     * and wait for the first model request to start. Resolves once the
     * session created and the first request began producing output; rejects
     * (disposing the session) when the request fails to start — model not
     * found, provider unavailable, connection failure, timeout, or an auth /
     * quota error — so the caller can fall back to the next candidate.
     *
     * The startup signal is observed on the durable `session/event` feed. A
     * bounded watchdog stops the wait if no signal ever arrives and keeps the
     * session alive rather than risk disposing a session we merely failed to
     * observe. Once output has started, later errors never trigger fallback.
     *
     * @param candidate the `{ provider, model }` to try.
     * @param runSpec `{ title, prompt, workspace, presetId }`.
     * @returns the live handle of the started session.
     */
    async function startCandidate(candidate, runSpec) {
      const sessionId = `session-${randomUUID()}`
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: runSpec.workspace ? runSpec.workspace.path : defaultCwd },
        agentOptions: { provider: candidate.provider, model: candidate.model },
        // Without a preset mount the fresh session runs with NO tools. Mount
        // the preset resolved for this rule in setup; a mount error rolls the
        // session creation back and rejects the attempt.
        setup: async (agentCtx) => {
          const presets = ctx.get('agentPresets')
          if (runSpec.presetId !== undefined && presets && typeof presets.mount === 'function') {
            await presets.mount(agentCtx, runSpec.presetId)
          }
        },
      })
      try {
        if (runSpec.workspace !== undefined) {
          await runSpec.workspace.attachSession(sessionId)
        }
        const session = handle.agent.session
        // Set the session title to the rule's title. Append directly to the
        // session log with a 'user' source, which pins the title and prevents
        // automatic title generation from overwriting it.
        try {
          session.append('session/title', {
            title: runSpec.title,
            messageSeqs: [],
            source: { kind: 'user' },
          })
        } catch {
          // A failed append is non-fatal; the session still runs with a
          // fallback title derived from the first prompt.
        }
        const agent = handle.agent
        let settled = false
        let stopListening
        const message = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: runSpec.prompt }],
          source: { kind: 'plugin', plugin: 'file-events' },
        }
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer)
            if (stopListening) stopListening()
          }
          const timer = setTimeout(() => {
            // Watchdog fired with no signal at all. Treat the session as
            // started and keep it alive: real startup failures arrive as
            // turn/end errors long before this ceiling, so reaching it usually
            // means this listener is not receiving events — disposing a
            // session we merely failed to observe would be destructive.
            if (settled) return
            settled = true
            cleanup()
            resolve()
          }, STARTUP_TIMEOUT_MS)
          stopListening = ctx.on('session/event', (eventSession, event) => {
            if (settled || eventSession !== session) return
            if (event.type === 'assistant/chunk' || event.type === 'assistant/message') {
              settled = true
              cleanup()
              resolve()
              return
            }
            if (event.type === 'turn/end') {
              const reason = event.reason
              if (reason && reason.kind === 'error') {
                const failure = reason.error || {}
                const detail = failure.message || failure.code || 'model request failed to start'
                settled = true
                cleanup()
                reject(new Error(`${detail}${failure.code ? ` (${failure.code})` : ''}`))
                return
              }
              // A terminal, non-error turn with no content still counts as the
              // request having started — fallback is reserved for startup
              // failures, not for empty/completed turns.
              settled = true
              cleanup()
              resolve()
            }
          })
          agent.followup(message)
        })
        return handle
      } catch (error) {
        // The candidate never started: tear down the fresh session so the
        // next candidate starts from a clean slate.
        await handle.dispose().catch(() => {})
        throw error
      }
    }

    /**
     * Execute one rule: resolve the preset up front (a missing/broken preset
     * fails cleanly without model fallback), then try each candidate in a
     * fresh session until one starts.
     *
     * @param rule the stored rule snapshot.
     * @param files workspace-relative changed files to inject into the prompt.
     * @returns the updated rule with last-run metadata.
     */
    async function execute(rule, files) {
      const startedAt = new Date().toISOString()
      const prompt = buildPrompt(rule.prompt, files)
      const fail = (error) => failedBeforeAttempts(rule, startedAt, error)
      let selection
      try {
        selection = ctx.agentDefaultModel.currentSelection()
      } catch (error) {
        return fail(error)
      }
      let candidates
      try {
        candidates = buildCandidates(rule, selection)
      } catch (error) {
        return fail(error)
      }
      const workspace = ctx.workspaceRegistry.get(rule.workspaceId)
      if (workspace === undefined) {
        return fail(new Error(`workspace '${rule.workspaceId}' not found`))
      }
      let presetId
      try {
        presetId = await resolvePresetForItem(ctx.get('agentPresets'), rule.agentPreset)
      } catch (error) {
        return fail(error)
      }
      const out = await runWithCandidates({
        record: rule,
        candidates,
        spawn: (candidate) => startCandidate(candidate, {
          title: rule.title,
          prompt,
          workspace,
          presetId,
        }),
      })
      return finalizeRunPreset(out, presetId)
    }

    // ── watcher layer ──────────────────────────────────────────────────────

    function stopRuleWatch(ruleId) {
      const state = watches.get(ruleId)
      if (!state) return
      watches.delete(ruleId)
      if (state.timer !== null) clearTimeout(state.timer)
      for (const watcher of state.watchers) {
        try { watcher.close() } catch { /* already closed */ }
      }
    }

    /** True when a resolved watch root should be ignored from traversal. */
    function ignoredForWatch(absolutePath) {
      const posix = absolutePath.split(path.sep).join('/')
      const segments = posix.split('/')
      return segments.some((segment) => segment.startsWith('.')
        || DEFAULT_IGNORE_GLOBS.some((glob) => minimatch(segment, glob)))
    }

    /**
     * Start (or restart) a rule's watchers. Each watch path under the
     * workspace becomes one chokidar instance; matching file add/change/unlink
     * events are queued and debounced per rule. A rule whose workspace is
     * missing is skipped silently (it cannot resolve a path).
     */
    function startRuleWatch(ruleId, rule) {
      stopRuleWatch(ruleId)
      if (!rule.enabled) return
      const workspace = ctx.workspaceRegistry.get(rule.workspaceId)
      if (workspace === undefined) return
      const state = { workspace, watchers: [], pending: new Map(), timer: null, runInFlight: false, needsAnother: false }
      watches.set(ruleId, state)
      for (const watchPath of rule.watchPaths) {
        const rootAbs = path.join(workspace.path, watchPath)
        let watcher
        try {
          watcher = chokidar.watch(rootAbs, {
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
            // Skip hidden/temp entries up front so chokidar never descends
            // into .git/.obsidian or reports editor scratch files.
            ignored: (p) => ignoredForWatch(String(p)),
          })
        } catch (error) {
          continue
        }
        const queue = (eventPath) => {
          const payload = eventPayloadFor(rule, workspace.path, rootAbs, String(eventPath))
          if (!payload) return
          const current = requireTable().get(ruleId)
          if (!current || !current.enabled) return
          const stateNow = watches.get(ruleId)
          if (!stateNow) return
          stateNow.pending.set(payload.wsRel, payload)
          if (stateNow.timer !== null) clearTimeout(stateNow.timer)
          stateNow.timer = setTimeout(() => {
            stateNow.timer = null
            void fireRule(ruleId)
          }, current.debounceMs)
        }
        watcher.on('add', queue).on('change', queue).on('unlink', queue)
        watcher.on('error', () => {})
        state.watchers.push(watcher)
      }
    }

    /**
     * Debounce window elapsed for a rule: snapshot the pending file set and
     * start ONE agent run for the whole burst. If a run is already in flight,
     * leave the pending set alone and mark that a follow-up window is needed,
     * so two sessions for the same rule never overlap.
     */
    async function fireRule(ruleId) {
      const state = watches.get(ruleId)
      const rule = state && requireTable().get(ruleId)
      if (!state || !rule) return
      if (!rule.enabled) {
        state.pending.clear()
        return
      }
      if (state.runInFlight) {
        state.needsAnother = true
        return
      }
      const files = [...state.pending.keys()]
      state.pending.clear()
      if (files.length === 0) return
      state.runInFlight = true
      const triggerAt = new Date().toISOString()
      try {
        const before = requireTable().get(ruleId)
        if (before !== undefined) {
          await requireTable().put(ruleId, { ...before, lastTriggerAt: triggerAt, lastTriggerFiles: files })
        }
        const out = await execute(rule, files)
        const current = requireTable().get(ruleId)
        if (current !== undefined) {
          await requireTable().put(ruleId, mergeRunMeta(current, out))
        }
      } finally {
        state.runInFlight = false
        if (state.needsAnother) {
          state.needsAnother = false
          const latest = requireTable().get(ruleId)
          if (latest && latest.enabled) {
            // Give stragglers that landed mid-run a short fresh window.
            const ms = Math.min(latest.debounceMs || DEFAULT_DEBOUNCE_MS, 2000)
            if (state.timer !== null) clearTimeout(state.timer)
            state.timer = setTimeout(() => {
              state.timer = null
              void fireRule(ruleId)
            }, ms)
          }
        }
      }
    }

    /** Rebuild the watcher table from the stored rules. */
    function rescheduleAll() {
      for (const ruleId of [...watches.keys()]) stopRuleWatch(ruleId)
      for (const [ruleId, rule] of requireTable().entries()) startRuleWatch(ruleId, rule)
    }

    /** Merge only run metadata from `out` onto a live stored rule. */
    function mergeRunMeta(current, out) {
      const next = { ...current }
      for (const key of ['lastRunAt', 'lastRunModel', 'lastRunPreset', 'lastRunAttempts', 'lastRunError']) {
        if (out[key] === undefined) delete next[key]
        else next[key] = out[key]
      }
      return next
    }

    // ── CRUD helpers ───────────────────────────────────────────────────────

    /** List every rule in insertion order. */
    function list() {
      return [...requireTable().entries()].map(([, rule]) => rule)
    }

    /** Create one rule, schedule its watcher, and persist it. */
    async function create(input) {
      const rule = buildRule(input)
      if (ctx.workspaceRegistry.get(rule.workspaceId) === undefined) {
        throw new Error(`workspace '${rule.workspaceId}' not found`)
      }
      await requireTable().put(rule.id, rule)
      startRuleWatch(rule.id, rule)
      return rule
    }

    /** Update one rule and restart its watcher. */
    async function update(id, patch) {
      const current = requireTable().get(id)
      if (current === undefined) throw new Error(`file-event rule '${id}' not found`)
      const next = {
        ...current,
        ...patch,
        id: current.id,
        updatedAt: new Date().toISOString(),
      }
      // Explicit PATCH semantics: an omitted field keeps its value; an
      // explicit empty value clears the optional list/preset fields, while
      // watchPaths always stays non-empty.
      if (patch && 'title' in patch) {
        if (typeof patch.title !== 'string' || patch.title.trim() === '') {
          throw new Error('title must be a non-empty string')
        }
        next.title = patch.title.trim()
      }
      if (patch && 'prompt' in patch) {
        if (typeof patch.prompt !== 'string' || patch.prompt.trim() === '') {
          throw new Error('prompt must be a non-empty string')
        }
        next.prompt = patch.prompt
      }
      if (patch && 'enabled' in patch) {
        if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be a boolean')
        next.enabled = patch.enabled
      }
      if (patch && 'workspaceId' in patch) {
        if (typeof patch.workspaceId !== 'string' || patch.workspaceId.trim() === '') {
          throw new Error('workspaceId must be a non-empty string')
        }
        const workspaceId = patch.workspaceId.trim()
        if (workspaceId !== current.workspaceId && ctx.workspaceRegistry.get(workspaceId) === undefined) {
          throw new Error(`workspace '${workspaceId}' not found`)
        }
        next.workspaceId = workspaceId
      }
      if (patch && 'watchPaths' in patch) next.watchPaths = normalizeWatchPaths(patch.watchPaths)
      if (patch && 'debounceMs' in patch) next.debounceMs = normalizeDebounceMs(patch.debounceMs)
      if (patch && 'globs' in patch) {
        const globs = normalizeGlobList(patch.globs)
        if (globs === undefined) delete next.globs
        else next.globs = globs
      }
      if (patch && 'ignoreGlobs' in patch) {
        const ignoreGlobs = normalizeGlobList(patch.ignoreGlobs)
        if (ignoreGlobs === undefined) delete next.ignoreGlobs
        else next.ignoreGlobs = ignoreGlobs
      }
      if (patch && 'agentPreset' in patch) {
        const agentPreset = normalizeAgentPreset(patch.agentPreset)
        if (agentPreset === undefined) delete next.agentPreset
        else next.agentPreset = agentPreset
      }
      const { models, allowedProviders } = normalizeModelFields(patch)
      if (patch && 'models' in patch) {
        if (models === undefined) delete next.models
        else next.models = models
      }
      if (patch && 'allowedProviders' in patch) {
        if (allowedProviders === undefined) delete next.allowedProviders
        else next.allowedProviders = allowedProviders
      }
      assertAllowedProviders(next)
      await requireTable().put(id, next)
      startRuleWatch(id, next)
      return next
    }

    /** Remove one rule and stop its watchers. */
    async function remove(id) {
      const current = requireTable().get(id)
      if (current === undefined) throw new Error(`file-event rule '${id}' not found`)
      stopRuleWatch(id)
      await requireTable().delete(id)
    }

    /** Run one rule immediately (bypasses debounce), recording the run. */
    async function runNow(id) {
      const current = requireTable().get(id)
      if (current === undefined) throw new Error(`file-event rule '${id}' not found`)
      const out = await execute(current, [])
      const stored = requireTable().get(id)
      const merged = stored !== undefined ? mergeRunMeta(stored, out) : out
      await requireTable().put(id, merged)
      return merged
    }

    // ── lifecycle: open the domain and start every enabled watcher ─────────
    ;(async () => {
      const domain = await ctx.storageDomain.open(domainSpec)
      ctx.effect(() => () => {
        for (const ruleId of [...watches.keys()]) stopRuleWatch(ruleId)
        watches.clear()
        domain.close().catch(() => {})
      }, 'file-events: domain close')
      table = domain.table('rules')
      rescheduleAll()
    })()

    // ── HTTP API under the registered prefix ─────────────────────────────────
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/file-events/api',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')
          if (req.method === 'GET' && apiPath.endsWith('/file-events/api/workspaces')) {
            const registry = ctx.get('workspaceRegistry')
            const workspaces = registry && typeof registry.list === 'function'
              ? registry.list().map((workspace) => ({ id: workspace.id, title: workspace.title }))
              : []
            sendJson(res, 200, { workspaces })
            return
          }
          if (req.method === 'GET' && apiPath.endsWith('/file-events/api/presets')) {
            const service = ctx.get('agentPresets')
            let presets = []
            if (service && typeof service.list === 'function') {
              try {
                let defaultId
                try { defaultId = service.defaultId } catch { defaultId = undefined }
                presets = (await service.list()).map((preset) => ({
                  id: preset.id,
                  ...(preset.name === undefined ? {} : { name: preset.name }),
                  ...(preset.description === undefined ? {} : { description: preset.description }),
                  isDefault: preset.id === defaultId,
                  ...(preset.broken === undefined ? {} : { broken: preset.broken }),
                }))
              } catch {
                presets = []
              }
            }
            sendJson(res, 200, { presets })
            return
          }
          if (req.method === 'GET' && apiPath.endsWith('/file-events/api')) {
            sendJson(res, 200, { rules: list() })
            return
          }
          if (req.method === 'POST' && apiPath.endsWith('/file-events/api')) {
            const rule = await create(await readJsonBody(req))
            sendJson(res, 201, { rule })
            return
          }
          if (req.method === 'PATCH' && apiPath.endsWith('/file-events/api')) {
            const body = await readJsonBody(req)
            if (typeof body.id !== 'string') {
              sendJson(res, 400, { error: 'body must provide id' })
              return
            }
            const { id, ...patch } = body
            const rule = await update(id, patch)
            sendJson(res, 200, { rule })
            return
          }
          if (req.method === 'DELETE' && apiPath.endsWith('/file-events/api')) {
            const body = await readJsonBody(req)
            if (typeof body.id !== 'string') {
              sendJson(res, 400, { error: 'body must provide id' })
              return
            }
            await remove(body.id)
            sendJson(res, 200, { removed: true })
            return
          }
          if (req.method === 'POST' && apiPath.endsWith('/file-events/api/run')) {
            const body = await readJsonBody(req)
            if (typeof body.id !== 'string') {
              sendJson(res, 400, { error: 'body must provide id' })
              return
            }
            const rule = await runNow(body.id)
            sendJson(res, 200, { rule })
            return
          }
          sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          sendJson(res, 400, { error: String((error && error.message) || error) })
        }
      },
    }), 'file-events: api route')
  },
}
