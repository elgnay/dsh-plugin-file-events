'use strict'

/**
 * dsh-plugin-file-events — Client half
 *
 * Registers a `settings.section` management page and a `sidebar.footer.action`
 * button opening the same surface as a full-page overlay. Both render over one
 * component-local store; data arrives from the Host half through plain `fetch`
 * on `/file-events/api` (the bundle runs in the real page, not a sandbox).
 * Workspace and agent-preset options are fetched from the Host's
 * `/file-events/api/workspaces` and `/file-events/api/presets` routes.
 *
 * Components are zero-argument closures — they never read renderer-bound props
 * hooks — so the bundle works in any harness client runtime that serves the
 * `slots` service. UI text is localized through the harness `locale` service
 * (namespace `settings.fileEvents`) when present, falling back to raw keys
 * otherwise.
 *
 * Each rule may carry an optional ordered model chain (`models`) plus an
 * optional provider allowlist (`allowedProviders`) and an optional agent
 * preset (`agentPreset`) mounted on each run's fresh session — the same policy
 * fields the scheduled-items fork exposes. On top of that, a rule carries the
 * watch configuration: `workspaceId` (required), `watchPaths` (relative
 * directories/files), optional `globs`/`ignoreGlobs`, and a `debounceMs`
 * window. The panel below edits those fields and surfaces trigger/run metadata
 * (`lastTriggerAt`, `lastTriggerFiles`, `lastRunAt`, `lastRunModel`,
 * `lastRunPreset`, `lastRunAttempts`, `lastRunError`).
 *
 * This file is the dynamic-plugin source of truth; `client/bundle.js` is the
 * static-install artifact regenerated from it via `npm run build:client`.
 */

const LOCALE_NS = 'settings.fileEvents'

const ZH = {
  nav: '文件事件',
  title: '文件事件',
  intro: '监听工作区目录，文件变化（防抖后）交给全新的 agent 会话处理——也可以立即执行。',
  loading: '正在加载文件事件规则…',
  error: '无法连接文件事件服务。',
  empty: '还没有文件事件规则，先创建一个吧。',
  retry: '重试',
  newItem: '新建事件规则',
  editItem: '编辑事件规则',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  delete: '删除',
  running: '执行中…',
  runNow: '立即执行',
  lastRun: '上次执行',
  neverRun: '从未执行',
  failed: '失败',
  lastTrigger: '上次触发',
  triggeredFiles: '变更文件',
  titleLabel: '标题',
  titlePlaceholder: '例如：导入流水线',
  promptLabel: '提示词',
  promptPlaceholder: '文件变化后，让 agent 做什么？',
  promptFilesHint: '在提示词中使用 {files} 占位符内联变更文件清单；未使用时自动在末尾追加一段清单。',
  enabledLabel: '启用',
  enabledHint: '停用的规则保留数据，但不会响应文件变化。',
  invalidForm: '标题、提示词、工作区和监听路径都是必填项。',
  deleteConfirm: '确定删除这条文件事件规则？',
  close: '关闭',
  workspace: '工作区',
  workspaceLabel: '工作区',
  workspaceSelectPlaceholder: '请选择工作区…',
  workspaceHint: '只监听该工作区目录内的路径；触发的会话绑定到此工作区并显示在其分组中。',
  watchPathsLabel: '监听路径',
  watchPathsPlaceholder: '相对工作区的路径，每行一个，例如：\ninbox/raw\ncontent/posts\nimport-list.csv',
  watchPathsHint: '必须是相对工作区的目录或文件，不能以 / 开头或包含 ..（否则会逃出工作区）。',
  globsLabel: '触发通配符（可选）',
  globsHint: '留空表示任何文件都触发；填写后只有匹配才触发，例如 **/*.md。',
  ignoreGlobsLabel: '忽略通配符（可选）',
  ignoreGlobsHint: '命中的文件不触发。隐藏路径（.git、.obsidian 等）与临时文件（*.tmp 等）默认已被忽略。',
  debounceLabel: '防抖（秒）',
  debounceShort: '防抖',
  debounceHint: '把窗口内的多次变化合并成一次执行；范围 1–600 秒，默认 15。',
  off: '停用',
  watch: '监听',
  // Model chain / provider policy (shared wording with scheduled items).
  modelsToggleLabel: '自定义模型链',
  modelsToggleHint: '关闭时按全局默认模型执行；开启后按顺序逐个尝试，某个模型启动失败会自动回退到下一个。',
  modelsEditorTitle: '模型链（按顺序尝试）',
  providerLabel: 'Provider',
  providerPlaceholder: 'local',
  modelLabel: 'Model',
  modelPlaceholder: '例如 deepseek-v4-flash',
  moveUp: '上移',
  moveDown: '下移',
  removeModel: '移除',
  addModel: '添加一个模型',
  allowedProvidersLabel: '仅允许这些 Provider',
  allowedProvidersPlaceholder: '例如 local（多个用逗号分隔）',
  allowedProvidersHint: '留空表示不限制。每次执行前会先过滤掉不在名单中的候选模型，确保触发任务永远不会误用名单之外的 provider。',
  modelsInvalid: '自定义模型链开启后，每一行都要填 provider 和 model。',
  providerNotAllowed: '模型所在 provider 不在“仅允许”名单中',
  modelChainEmpty: '模型链已开启，但还没有任何模型。',
  badgeLocalOnly: '仅本地模型',
  chainSummaryHint: '执行时按此顺序尝试',
  usedModel: '使用模型',
  attemptsCount: '次尝试',
  // Per-rule agent preset.
  agentPresetLabel: 'Agent 预设',
  agentPresetNone: '（默认预设）',
  agentPresetHint: '该规则触发时启动的新会话挂载的 agent 预设；留空使用全局默认预设。',
  agentPresetUnavailable: '不存在/无法挂载',
  agentPresetMissing: '所选 agent 预设已不可用，本次运行会失败——请重新选择或清空为默认。',
  presetConfigured: '预设',
  presetUsed: '使用预设',
}

const EN = {
  nav: 'File events',
  title: 'File events',
  intro: 'Watch workspace folders and hand file changes (after a debounce) to a fresh agent session — or run it right now.',
  loading: 'Loading file-event rules…',
  error: 'Could not reach the file-events service.',
  empty: 'No file-event rules yet. Create your first one below.',
  retry: 'Retry',
  newItem: 'New event rule',
  editItem: 'Edit event rule',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  delete: 'Delete',
  running: 'Running…',
  runNow: 'Run now',
  lastRun: 'Last run',
  neverRun: 'Never',
  failed: 'failed',
  lastTrigger: 'Last trigger',
  triggeredFiles: 'changed files',
  titleLabel: 'Title',
  titlePlaceholder: 'e.g. Import pipeline',
  promptLabel: 'Prompt',
  promptPlaceholder: 'What should the agent do when files change?',
  promptFilesHint: 'Use a {files} placeholder in the prompt to inline the changed-file list; otherwise one is appended automatically.',
  enabledLabel: 'Enabled',
  enabledHint: 'Disabled rules keep their data but never react to file changes.',
  invalidForm: 'Title, prompt, workspace, and watch paths are required.',
  deleteConfirm: 'Delete this file-event rule?',
  close: 'Close',
  workspace: 'Workspace',
  workspaceLabel: 'Workspace',
  workspaceSelectPlaceholder: 'Select a workspace…',
  workspaceHint: 'Only paths inside this workspace are watched; triggered sessions bind to it and appear under it in the sidebar.',
  watchPathsLabel: 'Watch paths',
  watchPathsPlaceholder: 'Workspace-relative paths, one per line, e.g.:\ninbox/raw\ncontent/posts\nimport-list.csv',
  watchPathsHint: 'Must be directories or files relative to the workspace; no leading "/" and no ".." (they would escape the workspace).',
  globsLabel: 'Trigger globs (optional)',
  globsHint: 'Leave empty to trigger on any file. When set, only matching paths trigger, e.g. **/*.md.',
  ignoreGlobsLabel: 'Ignore globs (optional)',
  ignoreGlobsHint: 'Matching files never trigger. Hidden paths (.git, .obsidian, …) and temp files (*.tmp, …) are ignored by default.',
  debounceLabel: 'Debounce (seconds)',
  debounceShort: 'debounce',
  debounceHint: 'Coalesces changes within the window into one run; range 1–600 seconds, default 15.',
  off: 'off',
  watch: 'watch',
  // Model chain / provider policy (shared wording with scheduled items).
  modelsToggleLabel: 'Custom model chain',
  modelsToggleHint: 'When off, runs use the global default model. When on, attempts each model in order and falls back to the next if one fails to start.',
  modelsEditorTitle: 'Model chain (tried in order)',
  providerLabel: 'Provider',
  providerPlaceholder: 'local',
  modelLabel: 'Model',
  modelPlaceholder: 'e.g. deepseek-v4-flash',
  moveUp: 'Move up',
  moveDown: 'Move down',
  removeModel: 'Remove',
  addModel: 'Add a model',
  allowedProvidersLabel: 'Only allow these providers',
  allowedProvidersPlaceholder: 'e.g. local (comma separated)',
  allowedProvidersHint: 'Leave empty for no restriction. Candidates outside this list are filtered before every run, so a triggered job can never accidentally use a provider outside the allowlist.',
  modelsInvalid: 'With a custom model chain enabled, every row needs a provider and a model.',
  providerNotAllowed: 'Model provider is outside the allowlist',
  modelChainEmpty: 'The model chain is on but has no models yet.',
  badgeLocalOnly: 'local-only',
  chainSummaryHint: 'Tried in this order at run time',
  usedModel: 'model used',
  attemptsCount: 'attempt(s)',
  // Per-rule agent preset.
  agentPresetLabel: 'Agent preset',
  agentPresetNone: '(default preset)',
  agentPresetHint: 'Agent preset mounted on the fresh session for each triggered run; empty uses the global default preset.',
  agentPresetUnavailable: 'missing / unmountable',
  agentPresetMissing: 'The selected agent preset is unavailable, so runs would fail — pick another or clear back to default.',
  presetConfigured: 'preset',
  presetUsed: 'preset used',
}

const LOCALE_DICT = { zh: ZH, en: EN }

const API = '/file-events/api'

const styles = {
  _head: null,
  insert(css) {
    if (typeof document === 'undefined') return
    if (!this._head) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', 'dsh-plugin-file-events')
      document.head.appendChild(style)
      this._head = style
    }
    this._head.textContent = css
  },
}

styles.insert(`
/*
 * Theme-aware styles for dsh-plugin-file-events.
 *
 * Every color comes from the harness theme tokens (Theme.listTokens). Tokens
 * that do not exist there are derived from real tokens through CSS
 * color-mix(), so the surface follows light/dark switching automatically
 * without any local fallback palette.
 *
 * Buttons by role:
 *   .fe-btn            — secondary / outline / ghost
 *   .fe-btn-primary    — "新建事件规则" / "保存" / form submit; solid
 *                        label-primary fill with bg-base text, guaranteed
 *                        readable in any theme
 *   .fe-btn-danger     — "删除"; error-state tint
 *   .fe-pageClose      — header close "✕"; ghost with hover overlay
 *   .fe-form input, select, textarea — layer-1 surface, label-primary text
 */
.fe-root{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}
.fe-title{font-size:20px;font-weight:600;margin:0}
.fe-intro{font-size:13px;color:var(--dsw-alias-label-secondary);margin:0}
.fe-muted{font-size:13px;color:var(--dsw-alias-label-secondary);margin:0}
.fe-error{font-size:13px;color:var(--dsw-alias-state-error-primary);display:flex;align-items:center;gap:8px;margin:0}
.fe-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.fe-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);transition:border-color .16s,background .16s}
.fe-row:hover{border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.fe-rowMain{display:flex;flex-direction:column;gap:3px;min-width:0}
.fe-rowTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.fe-rowPath{font-size:12px;color:var(--dsw-alias-label-secondary);font-feature-settings:"tnum" 1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fe-rowMeta{font-size:12px;color:var(--dsw-alias-label-secondary)}
.fe-rowActions{display:flex;gap:8px;flex-shrink:0}
.fe-rowSub{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.fe-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:1;padding:3px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.fe-badgeDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.fe-chain{font-size:12px;font-feature-settings:"tnum" 1;min-width:0}
.fe-btn{font-size:13px;padding:5px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .16s,border-color .16s,color .16s}
.fe-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,var(--dsw-alias-border-l2))}
.fe-btn:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.fe-btn:disabled{opacity:.5;cursor:default}
.fe-btn-primary{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.fe-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-base) 14%,var(--dsw-alias-label-primary));border-color:transparent}
.fe-btn-primary:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-base) 24%,var(--dsw-alias-label-primary))}
.fe-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,var(--dsw-alias-border-l2))}
.fe-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.fe-btn-danger:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent)}
.fe-form{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.fe-formTitle{font-size:15px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary)}
.fe-field{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.fe-field input,.fe-field textarea,.fe-field select{padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;transition:border-color .16s,background .16s}
.fe-field input:focus,.fe-field textarea:focus,.fe-field select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.fe-field textarea{resize:vertical;min-height:64px}
.fe-field textarea.fe-watchBox{min-height:88px}
.fe-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}
.fe-warn{font-size:12px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}
.fe-checkbox{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.fe-formActions{display:flex;gap:8px}
.fe-page{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1)}
.fe-pageHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);flex-shrink:0}
.fe-pageTitle{font-size:17px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary)}
.fe-pageClose{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .16s,color .16s}
.fe-pageClose:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}
.fe-pageBody{flex:1;overflow:auto;padding:24px 20px;display:flex;justify-content:center}
.fe-sidebarTrigger{display:flex;align-items:center;gap:6px;width:100%;padding:8px 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;text-align:left;cursor:pointer;transition:background .16s,border-color .16s,color .16s}
.fe-sidebarTrigger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.fe-sidebarTrigger:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.fe-sidebarTrigger:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.fe-sidebarTriggerIcon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1}
.fe-modelBox{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.fe-modelRow{display:flex;align-items:center;gap:6px}
.fe-modelRow .fe-modelProvider{flex:0 0 30%}
.fe-modelRow .fe-modelName{flex:1 1 auto}
.fe-modelMove{flex:0 0 auto}
.fe-mini{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;cursor:pointer;transition:background .16s,border-color .16s,color .16s}
.fe-mini:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.fe-mini:disabled{opacity:.4;cursor:default}
.fe-miniDanger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}
.fe-modelAdd{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:4px 9px;border-radius:7px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .16s,border-color .16s,color .16s}
.fe-modelAdd:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
`)

async function readJson(response) {
  const payload = await response.json()
  if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
  return payload
}

/** Split user-provided allowlist text into trimmed, de-duplicated providers. */
function parseProviders(text) {
  return [...new Set(String(text || '').split(/[\s,，]+/).map((part) => part.trim()).filter(Boolean))]
}

/** Split user-provided watch paths (one per line) into a trimmed array. */
function parseWatchPaths(text) {
  return String(text || '').split(/[\n,，]+/).map((part) => part.trim()).filter(Boolean)
}

/** "local/deepseek-v4-flash → local/qwen38-27b" from a rule's chain. */
function modelChainLabel(item) {
  if (!Array.isArray(item.models) || item.models.length === 0) return ''
  return item.models.map((candidate) => `${candidate.provider}/${candidate.model}`).join(' → ')
}

/** True when the rule is pinned to exactly the `local` provider. */
function isLocalOnly(item) {
  return Array.isArray(item.allowedProviders)
    && item.allowedProviders.length === 1
    && item.allowedProviders[0] === 'local'
}

function formatTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

function lastRunText(t, item) {
  if (!item.lastRunAt) return t('neverRun')
  const time = formatTime(item.lastRunAt)
  return item.lastRunError === undefined ? time : `${time} (${t('failed')}: ${item.lastRunError})`
}

module.exports = {
  name: 'file-events-client',
  // Only `slots` is a resolvable service in the static bundle environment;
  // `locale` is resolved dynamically below so the plugin never waits on a
  // service name the web module loader does not serve.
  inject: ['slots'],

  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const locale = ctx.get('locale')
    const t = locale ? locale.bind(LOCALE_NS) : (key) => key
    if (locale) {
      ctx.effect(() => locale.register(LOCALE_NS, LOCALE_DICT))
    }

    const emptyForm = () => ({
      editingId: null,
      title: '',
      prompt: '',
      enabled: true,
      workspaceId: undefined,
      watchPaths: '',
      globsText: '',
      ignoreGlobsText: '',
      debounceSeconds: '15',
      modelsEnabled: false,
      models: [{ provider: 'local', model: '' }],
      allowedText: '',
      agentPreset: '',
    })

    /**
     * The management surface. Component-local state, zero renderer-bound
     * props hooks: everything (list, form, workspace options, actions) is
     * reached through the apply closure, so the bundle renders in any client
     * runtime that serves `slots`.
     */
    function FileEventsPanel() {
      const [rules, setRules] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [runningId, setRunningId] = React.useState(null)
      const [workspaces, setWorkspaces] = React.useState([])
      const [presets, setPresets] = React.useState([])
      const [presetsLoaded, setPresetsLoaded] = React.useState(false)

      const load = async () => {
        setLoading(true)
        setError(null)
        try {
          const payload = await readJson(await fetch(API))
          setRules(payload.rules || [])
        } catch (err) {
          setError(String((err && err.message) || err))
        }
        setLoading(false)
      }

      React.useEffect(() => {
        void load()
        // Workspace and agent-preset options are optional; a failed fetch
        // never blocks the page (an empty roster just hides the preset picker).
        fetch(`${API}/workspaces`)
          .then((response) => readJson(response))
          .then((payload) => { setWorkspaces(payload.workspaces || []) })
          .catch(() => {})
        fetch(`${API}/presets`)
          .then((response) => readJson(response))
          .then((payload) => { setPresets(payload.presets || []) })
          .catch(() => {})
          .finally(() => { setPresetsLoaded(true) })
      }, [])

      const openNew = () => setForm(emptyForm())
      const openEdit = (item) => setForm({
        editingId: item.id,
        title: item.title,
        prompt: item.prompt,
        enabled: item.enabled,
        ...(item.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }),
        watchPaths: Array.isArray(item.watchPaths) ? item.watchPaths.join('\n') : '',
        globsText: Array.isArray(item.globs) ? item.globs.join(', ') : '',
        ignoreGlobsText: Array.isArray(item.ignoreGlobs) ? item.ignoreGlobs.join(', ') : '',
        debounceSeconds: String(item.debounceMs === undefined ? 15 : Math.round(item.debounceMs / 1000)),
        modelsEnabled: Array.isArray(item.models) && item.models.length > 0,
        models: Array.isArray(item.models) && item.models.length > 0
          ? item.models.map((candidate) => ({ provider: candidate.provider, model: candidate.model }))
          : [{ provider: 'local', model: '' }],
        allowedText: Array.isArray(item.allowedProviders) ? item.allowedProviders.join(', ') : '',
        agentPreset: typeof item.agentPreset === 'string' ? item.agentPreset : '',
      })

      // The payload always carries the policy fields. An empty `models: []` /
      // `allowedProviders: []` / `agentPreset: ""` / `globs: []` /
      // `ignoreGlobs: []` tells the Host half to clear that field, so a PATCH
      // can remove a previously configured chain, allowlist, preset, or globs.
      const buildPayload = () => {
        const completeRows = form.models
          .filter((row) => row.provider.trim() !== '' && row.model.trim() !== '')
          .map((row) => ({ provider: row.provider.trim(), model: row.model.trim() }))
        const allowed = parseProviders(form.allowedText)
        const debounceMs = Math.round(Number(form.debounceSeconds) * 1000)
        return {
          title: form.title,
          prompt: form.prompt,
          enabled: form.enabled,
          workspaceId: form.workspaceId,
          watchPaths: parseWatchPaths(form.watchPaths),
          globs: parseProviders(form.globsText),
          ignoreGlobs: parseProviders(form.ignoreGlobsText),
          ...(Number.isFinite(debounceMs) && debounceMs > 0 ? { debounceMs } : {}),
          models: form.modelsEnabled ? completeRows : [],
          allowedProviders: allowed,
          agentPreset: form.agentPreset || '',
        }
      }

      const saveForm = async () => {
        if (!form || saving) return
        const watchPaths = parseWatchPaths(form.watchPaths)
        if (!form.title.trim() || !form.prompt.trim() || !form.workspaceId || watchPaths.length === 0) {
          window.alert(t('invalidForm'))
          return
        }
        const completeRows = form.models
          .filter((row) => row.provider.trim() !== '' && row.model.trim() !== '')
        if (form.modelsEnabled) {
          if (completeRows.length === 0) {
            window.alert(t('modelChainEmpty'))
            return
          }
          const allowed = parseProviders(form.allowedText)
          if (allowed.length > 0) {
            const offender = completeRows.find((row) => !allowed.includes(row.provider.trim()))
            if (offender) {
              window.alert(`${t('providerNotAllowed')}: ${offender.provider.trim()}`)
              return
            }
          }
        }
        setSaving(true)
        setError(null)
        try {
          const payload = buildPayload()
          const response = form.editingId === null
            ? await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
            : await fetch(API, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: form.editingId, ...payload }) })
          await readJson(response)
          setForm(null)
          await load()
        } catch (err) {
          setError(String((err && err.message) || err))
        }
        setSaving(false)
      }

      const remove = async (id) => {
        try {
          const response = await fetch(API, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
          await readJson(response)
          await load()
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }

      const runNow = async (id) => {
        setRunningId(id)
        try {
          const response = await fetch(`${API}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
          await readJson(response)
          await load()
        } catch (err) {
          setError(String((err && err.message) || err))
        }
        setRunningId(null)
      }

      // Immutable helpers over form.models.
      const updateModelRow = (index, patch) =>
        setForm((current) => ({ ...current, models: current.models.map((row, i) => i === index ? { ...row, ...patch } : row) }))
      const addModelRow = () =>
        setForm((current) => ({ ...current, models: [...current.models, { provider: 'local', model: '' }] }))
      const removeModelRow = (index) =>
        setForm((current) => {
          const rows = current.models.filter((_, i) => i !== index)
          return { ...current, models: rows.length === 0 ? [{ provider: 'local', model: '' }] : rows }
        })
      const moveModelRow = (index, delta) =>
        setForm((current) => {
          const target = index + delta
          if (target < 0 || target >= current.models.length) return current
          const rows = current.models.slice()
          const [row] = rows.splice(index, 1)
          rows.splice(target, 0, row)
          return { ...current, models: rows }
        })

      const workspaceOptions = workspaces.map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
      }))
      const workspaceTitle = (id) => {
        const option = workspaceOptions.find((o) => o.id === id)
        return option ? option.title : id
      }
      const runSummary = (item) => {
        const parts = []
        if (item.lastRunModel) parts.push(`${t('usedModel')}: ${item.lastRunModel}`)
        if (item.lastRunPreset) parts.push(`${t('presetUsed')}: ${item.lastRunPreset}`)
        if (Array.isArray(item.lastRunAttempts) && item.lastRunAttempts.length > 1) {
          parts.push(`${item.lastRunAttempts.length} ${t('attemptsCount')}`)
        }
        return parts.join(' · ')
      }
      const rowMeta = (item) => {
        const parts = []
        parts.push(`${t('workspace')}: ${workspaceTitle(item.workspaceId)}`)
        const debounceSec = item.debounceMs === undefined ? 15 : Math.round(item.debounceMs / 1000)
        parts.push(`${t('debounceShort')}: ${debounceSec}s`)
        if (!item.enabled) parts.push(`${t('off')}`)
        if (item.lastTriggerAt) {
          parts.push(`${t('lastTrigger')}: ${formatTime(item.lastTriggerAt)}`
            + (Array.isArray(item.lastTriggerFiles) && item.lastTriggerFiles.length > 0
              ? ` (${item.lastTriggerFiles.length} ${t('triggeredFiles')})` : ''))
        }
        parts.push(`${t('lastRun')}: ${lastRunText(t, item)}`)
        const summary = runSummary(item)
        if (summary) parts.push(summary)
        return parts.join(' · ')
      }
      const disabled = loading || saving

      const renderModelEditor = (modelRows, modelsEnabled, onToggle) =>
        React.createElement(React.Fragment, null,
          React.createElement('label', { className: 'fe-checkbox', key: 'toggle' },
            React.createElement('input', {
              type: 'checkbox',
              checked: modelsEnabled,
              disabled,
              onChange: (event) => {
                onToggle(event.target.checked)
                if (event.target.checked && modelRows.filter((row) => row.provider.trim() || row.model.trim()).length === 0) {
                  setForm((current) => ({ ...current, models: [{ provider: 'local', model: '' }] }))
                }
              },
            }),
            React.createElement('span', null, t('modelsToggleLabel')),
            React.createElement('small', { className: 'fe-hint' }, t('modelsToggleHint'))
          ),
          modelsEnabled && React.createElement('div', { className: 'fe-modelBox', key: 'editor' },
            React.createElement('span', { className: 'fe-hint' }, t('modelsEditorTitle')),
            modelRows.map((row, index) =>
              React.createElement('div', { className: 'fe-modelRow', key: index },
                React.createElement('input', {
                  className: 'fe-modelProvider',
                  value: row.provider,
                  disabled,
                  placeholder: t('providerPlaceholder'),
                  'aria-label': t('providerLabel'),
                  onChange: (event) => updateModelRow(index, { provider: event.target.value }),
                }),
                React.createElement('input', {
                  className: 'fe-modelName',
                  value: row.model,
                  disabled,
                  placeholder: t('modelPlaceholder'),
                  'aria-label': t('modelLabel'),
                  onChange: (event) => updateModelRow(index, { model: event.target.value }),
                }),
                React.createElement('button', {
                  type: 'button',
                  className: 'fe-mini fe-modelMove',
                  disabled: disabled || index === 0,
                  title: t('moveUp'),
                  'aria-label': t('moveUp'),
                  onClick: () => moveModelRow(index, -1),
                }, '↑'),
                React.createElement('button', {
                  type: 'button',
                  className: 'fe-mini fe-modelMove',
                  disabled: disabled || index === modelRows.length - 1,
                  title: t('moveDown'),
                  'aria-label': t('moveDown'),
                  onClick: () => moveModelRow(index, 1),
                }, '↓'),
                React.createElement('button', {
                  type: 'button',
                  className: 'fe-mini fe-miniDanger',
                  disabled,
                  title: t('removeModel'),
                  'aria-label': t('removeModel'),
                  onClick: () => removeModelRow(index),
                }, '✕')
              )
            ),
            React.createElement('button', { type: 'button', className: 'fe-modelAdd', disabled, onClick: addModelRow }, `+ ${t('addModel')}`)
          ),
          React.createElement('label', { className: 'fe-field', key: 'allowed' },
            React.createElement('span', null, t('allowedProvidersLabel')),
            React.createElement('input', {
              value: form.allowedText,
              disabled,
              placeholder: t('allowedProvidersPlaceholder'),
              onChange: (event) => setForm((current) => ({ ...current, allowedText: event.target.value })),
            }),
            React.createElement('small', { className: 'fe-hint' }, t('allowedProvidersHint'))
          )
        )

      // Presets the user may pick: the roster minus anything that cannot
      // mount. A stored override that is missing or broken stays shown (so the
      // field can display it and the user can clear it) with a warning.
      const usablePresets = presets.filter((preset) => preset.broken === undefined)
      const showPresetPicker = presetsLoaded
        && (usablePresets.length > 0 || (form !== null && form.agentPreset !== ''))
      const selectedPresetMissing = form !== null
        && form.agentPreset !== ''
        && presetsLoaded
        && !usablePresets.some((preset) => preset.id === form.agentPreset)
      const presetOptionLabel = (preset) =>
        preset.name && preset.name !== preset.id ? `${preset.id} — ${preset.name}` : preset.id

      return React.createElement('div', { className: 'fe-root' },
        error && React.createElement('p', { className: 'fe-error', role: 'alert' },
          error,
          React.createElement('button', { type: 'button', className: 'fe-btn', onClick: () => void load() }, t('retry'))
        ),
        loading && React.createElement('p', { className: 'fe-muted' }, t('loading')),
        !loading && rules.length === 0 && !error && React.createElement('p', { className: 'fe-muted' }, t('empty')),
        React.createElement('ul', { className: 'fe-list' },
          rules.map((item) =>
            React.createElement('li', { key: item.id, className: 'fe-row' },
              React.createElement('div', { className: 'fe-rowMain' },
                React.createElement('span', { className: 'fe-rowTitle' }, item.title),
                React.createElement('span', { className: 'fe-rowPath', title: (item.watchPaths || []).join('\n') },
                  `${t('watch')}: ${(item.watchPaths || []).join(', ')}`
                ),
                (modelChainLabel(item) || isLocalOnly(item) || (Array.isArray(item.globs) && item.globs.length > 0)) && React.createElement('span', { className: 'fe-rowSub' },
                  isLocalOnly(item) && React.createElement('span', { className: 'fe-badge' },
                    React.createElement('span', { className: 'fe-badgeDot', 'aria-hidden': 'true' }),
                    t('badgeLocalOnly')
                  ),
                  Array.isArray(item.globs) && item.globs.length > 0
                    && React.createElement('span', { className: 'fe-chain', title: t('globsHint') }, item.globs.join(', ')),
                  modelChainLabel(item) && React.createElement('span', { className: 'fe-chain', title: t('chainSummaryHint') }, modelChainLabel(item))
                ),
                React.createElement('span', { className: 'fe-rowMeta' }, rowMeta(item))
              ),
              React.createElement('div', { className: 'fe-rowActions' },
                React.createElement('button', {
                  type: 'button',
                  className: 'fe-btn',
                  disabled: runningId === item.id,
                  onClick: () => void runNow(item.id),
                }, runningId === item.id ? t('running') : t('runNow')),
                React.createElement('button', {
                  type: 'button',
                  className: 'fe-btn',
                  onClick: () => openEdit(item),
                }, t('editItem')),
                React.createElement('button', {
                  type: 'button',
                  className: 'fe-btn fe-btn-danger',
                  onClick: () => { if (window.confirm(t('deleteConfirm'))) void remove(item.id) },
                }, t('delete'))
              )
            )
          )
        ),
        form === null
          ? React.createElement('button', { type: 'button', className: 'fe-btn fe-btn-primary', onClick: openNew }, t('newItem'))
          : React.createElement('form', {
            className: 'fe-form',
            onSubmit: (event) => {
              event.preventDefault()
              void saveForm()
            },
          },
            React.createElement('h3', { className: 'fe-formTitle' }, form.editingId === null ? t('newItem') : t('editItem')),
            React.createElement('label', { className: 'fe-field' },
              React.createElement('span', null, t('titleLabel')),
              React.createElement('input', {
                value: form.title,
                disabled,
                placeholder: t('titlePlaceholder'),
                onChange: (event) => setForm((current) => ({ ...current, title: event.target.value })),
              })
            ),
            React.createElement('label', { className: 'fe-field' },
              React.createElement('span', null, t('promptLabel')),
              React.createElement('textarea', {
                value: form.prompt,
                disabled,
                rows: 4,
                placeholder: t('promptPlaceholder'),
                onChange: (event) => setForm((current) => ({ ...current, prompt: event.target.value })),
              }),
              React.createElement('small', { className: 'fe-hint' }, t('promptFilesHint'))
            ),
            React.createElement('label', { className: 'fe-field' },
              React.createElement('span', null, t('workspaceLabel')),
              React.createElement('select', {
                value: form.workspaceId || '',
                disabled,
                onChange: (event) => setForm((current) => ({ ...current, workspaceId: event.target.value === '' ? undefined : event.target.value })),
              },
                React.createElement('option', { value: '' }, t('workspaceSelectPlaceholder')),
                workspaceOptions.map((option) =>
                  React.createElement('option', { key: option.id, value: option.id }, option.title))
              ),
              React.createElement('small', { className: 'fe-hint' }, t('workspaceHint'))
            ),
            React.createElement('label', { className: 'fe-field' },
              React.createElement('span', null, t('watchPathsLabel')),
              React.createElement('textarea', {
                className: 'fe-watchBox',
                value: form.watchPaths,
                disabled,
                placeholder: t('watchPathsPlaceholder'),
                onChange: (event) => setForm((current) => ({ ...current, watchPaths: event.target.value })),
              }),
              React.createElement('small', { className: 'fe-hint' }, t('watchPathsHint'))
            ),
            React.createElement('div', { className: 'fe-field', style: { flexDirection: 'row', gap: '10px' } },
              React.createElement('label', { className: 'fe-field', style: { flex: '1 1 50%' } },
                React.createElement('span', null, t('globsLabel')),
                React.createElement('input', {
                  value: form.globsText,
                  disabled,
                  onChange: (event) => setForm((current) => ({ ...current, globsText: event.target.value })),
                }),
                React.createElement('small', { className: 'fe-hint' }, t('globsHint'))
              ),
              React.createElement('label', { className: 'fe-field', style: { flex: '1 1 50%' } },
                React.createElement('span', null, t('ignoreGlobsLabel')),
                React.createElement('input', {
                  value: form.ignoreGlobsText,
                  disabled,
                  onChange: (event) => setForm((current) => ({ ...current, ignoreGlobsText: event.target.value })),
                }),
                React.createElement('small', { className: 'fe-hint' }, t('ignoreGlobsHint'))
              )
            ),
            React.createElement('label', { className: 'fe-field', style: { maxWidth: 180 } },
              React.createElement('span', null, t('debounceLabel')),
              React.createElement('input', {
                type: 'number',
                min: 1,
                max: 600,
                value: form.debounceSeconds,
                disabled,
                onChange: (event) => setForm((current) => ({ ...current, debounceSeconds: event.target.value })),
              }),
              React.createElement('small', { className: 'fe-hint' }, t('debounceHint'))
            ),
            showPresetPicker && React.createElement('label', { className: 'fe-field' },
              React.createElement('span', null, t('agentPresetLabel')),
              React.createElement('select', {
                value: form.agentPreset || '',
                disabled,
                onChange: (event) => setForm((current) => ({ ...current, agentPreset: event.target.value })),
              },
                React.createElement('option', { value: '' }, t('agentPresetNone')),
                usablePresets.map((preset) =>
                  React.createElement('option', { key: preset.id, value: preset.id }, presetOptionLabel(preset))),
                (form.agentPreset !== '' && selectedPresetMissing)
                  && React.createElement('option', { value: form.agentPreset },
                    `${form.agentPreset}（${t('agentPresetUnavailable')}）`)
              ),
              React.createElement('small', { className: 'fe-hint' }, t('agentPresetHint')),
              selectedPresetMissing
                && React.createElement('small', { className: 'fe-warn', role: 'alert' }, t('agentPresetMissing'))
            ),
            renderModelEditor(form.models, form.modelsEnabled, (checked) => setForm((current) => ({ ...current, modelsEnabled: checked }))),
            React.createElement('label', { className: 'fe-checkbox' },
              React.createElement('input', {
                type: 'checkbox',
                checked: form.enabled,
                disabled,
                onChange: (event) => setForm((current) => ({ ...current, enabled: event.target.checked })),
              }),
              React.createElement('span', null, t('enabledLabel')),
              React.createElement('small', { className: 'fe-hint' }, t('enabledHint'))
            ),
            React.createElement('div', { className: 'fe-formActions' },
              React.createElement('button', { type: 'submit', className: 'fe-btn fe-btn-primary', disabled }, saving ? t('saving') : t('save')),
              React.createElement('button', { type: 'button', className: 'fe-btn', disabled, onClick: () => setForm(null) }, t('cancel'))
            )
          )
      )
    }

    /** Full-page management overlay. */
    function FileEventsPage() {
      const [open, setOpen] = React.useState(false)
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          className: 'fe-sidebarTrigger',
          'aria-label': t('nav'),
          onClick: () => setOpen(true),
        },
          React.createElement('span', { className: 'fe-sidebarTriggerIcon', 'aria-hidden': 'true' }, '⚡'),
          React.createElement('span', null, t('nav'))
        ),
        open && React.createElement('div', { className: 'fe-page', role: 'dialog', 'aria-modal': 'true' },
          React.createElement('div', { className: 'fe-pageHeader' },
            React.createElement('h2', { className: 'fe-pageTitle' }, t('title')),
            React.createElement('button', { type: 'button', className: 'fe-pageClose', 'aria-label': t('close'), onClick: () => setOpen(false) }, '✕')
          ),
          React.createElement('div', { className: 'fe-pageBody' },
            React.createElement(FileEventsPanel, null)
          )
        )
      )
    }

    // Settings page.
    slots.inject('settings.section', () => slots.register(
      {
        name: 'settings.section',
        id: 'file-events',
        order: 30,
        label: () => t('nav'),
        locale: LOCALE_NS,
      },
      () => React.createElement(FileEventsPanel, null)
    ))

    // Sidebar footer action: full-page management overlay.
    slots.inject('sidebar.footer.action', () => slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'file-events',
        order: 30,
        locale: LOCALE_NS,
      },
      () => React.createElement(FileEventsPage, null)
    ))
  },
}
