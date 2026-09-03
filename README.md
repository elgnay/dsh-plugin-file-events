# dsh-plugin-file-events

DeepSeek Harness 插件：**文件变化事件触发**。每条监听规则（watch rule）绑定一个工作区与一个或多个工作区内的监听路径；当这些路径下有文件变化（新增 / 修改 / 删除，经过一段防抖窗口）时，在一个**全新的 agent 会话**中提交提示词处理整批变更——不需要任何存活的聊天会话。带全屏管理界面（列表 + 增删改查 + 立即执行 + 启停开关）。

与 cron 定时事项（`dsh-plugin-scheduled-items`）共享同一套执行能力：

- 规则可固定 provider/model，或配置一个**按顺序尝试的模型链**；某个模型在会话启动阶段失败会自动回退到下一个候选模型。
- 可通过 `allowedProviders` 限定候选 provider，确保触发任务永远不会误用白名单之外的 provider（例如仅本地 `local`）。
- 规则可指定会话挂载的 **agent 预设**（`agentPreset`），让不同规则以不同工具集运行。

## 安装

### 作为组合插件（推荐，npm 或本地路径）

发布到 npm 后：

```bash
dsh plugin --profile web add dsh-plugin-file-events
```

`dsh plugin` 会把包调和进 profile 的 bundle 列表（`dsh.profile.bundles`）。包内 `cordis.patch.yml`（经 `package.json` 的 `dsh.bundle.patch` 声明）随后把插件行插入宿主组合；`dsh.client` 声明则让 web 外壳加载 `client/bundle.js` 作为管理界面。

或不安装包、以相对路径在 profile 的宿主组合（`cordis.patch.yml`）中指向本仓库：

```yaml
- insert:
    - id: file-events
      name: 'dsh-plugin-file-events'
```

本插件属于 **Host 平面**：它读取 Host 的 `storageDomain`、`workspaceRegistry`、`agents`、`agentDefaultModel`、`webServer` 服务，在宿主进程内用 chokidar 监听目录并生成全新会话，因此应放在**宿主组合**中，而不是某个 agent preset 内。

### 作为动态插件（开发 / 会话级）

`code.host` 的函数体即 `src/index.js` 去掉 `module.exports` 包装；`code.client` 的函数体即 `client/index.js` 去掉包装。

## 功能

- **监听规则 CRUD**：标题、提示词、启用开关、绑定工作区、一个或多个监听路径、触发/忽略通配符、防抖时长。
- **事件驱动执行**：文件新增 / 修改 / 删除进入防抖窗口，窗口结束触发一次**全新 agent 会话**，把变更文件清单注入提示词处理整批变更。
- **防抖合并**：窗口内多次变化合并成一次执行，避免为每个中间文件都开一个会话；同一规则的一次执行在跑时，新的变化会排队成“下一窗口”，同一规则不会有两个并发会话。
- **默认忽略**：隐藏路径（`.git`、`.obsidian`、`.DS_Store` 等点开头路径）与编辑器临时文件（`*.tmp`、`*~`、`*.swp`、`*.icloud`）默认不触发。
- **工作区归属**：规则只能监听所绑定工作区内的路径；触发会话 cwd = 工作区路径，且 `workspace.attachSession()` 挂到该工作区分组。监听路径必须是相对路径（不允许 `/` 开头或 `..`），否则无法逃出工作区。
- **持久化**：走 storage-domain（domain `file_events`，表 `rules`）；web 组合可将其路由到 SQLite 后端。
- **模型链 / Provider 白名单 / Agent 预设**：同 cron 插件，见下文。
- **触发与运行元数据**：每次触发记录 `lastTriggerAt` 与 `lastTriggerFiles`；每次运行记录 `lastRunAt`、`lastRunModel`、`lastRunPreset`、`lastRunAttempts`、`lastRunError`。

## 规则字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 规则标题，也是触发会话的标题 |
| `prompt` | 是 | 触发时提交给 agent 的提示词；可含 `{files}` 占位符（见下） |
| `workspaceId` | 是 | 所绑定工作区；监听与执行都限于该工作区 |
| `watchPaths` | 是 | 工作区内的目录或文件，相对路径，每项不能以 `/` 开头、不能含 `..` |
| `enabled` | 否 | 默认 `true`；停用保留数据但不监听 |
| `globs` | 否 | 触发通配符；缺省 = 任意文件都触发。填了则只触发匹配路径（相对监听根） |
| `ignoreGlobs` | 否 | 命中的路径不触发 |
| `debounceMs` | 否 | 防抖窗口毫秒数，默认 `15000`，范围 `[1000, 600000]` |
| `models` | 否 | 有序模型链 `[{ provider, model }]`；缺省按全局默认模型执行 |
| `allowedProviders` | 否 | provider 白名单；执行前过滤候选 |
| `agentPreset` | 否 | 触发会话挂载的 agent 预设 id；留空用全局默认预设 |

示例：

```jsonc
{
  "title": "Ingest pipeline",
  "prompt": "处理这批新写入的文件，按项目约定整理后更新索引。文件列表：{files}",
  "enabled": true,
  "workspaceId": "web",
  "watchPaths": ["inbox/raw", "content/posts"],
  "globs": ["**/*.md", "**/*.csv"],
  "ignoreGlobs": ["**/draft/**"],
  "debounceMs": 15000,

  "agentPreset": "web",
  "models": [
    { "provider": "local", "model": "deepseek-v4-flash" },
    { "provider": "local", "model": "qwen38-27b" }
  ],
  "allowedProviders": ["local"]
}
```

### 通配符与忽略

- 判定以**监听根为基准的相对路径**进行：规则监听 `content/posts` 时，事件路径归一为 `a.md`、`draft/b.md` 等。
- `globs` 是允许名单：留空 = 全部触发；填了只有匹配者触发。`ignoreGlobs` 优先于 `globs` 与默认规则。
- **隐藏与临时文件默认忽略**：相对监听根的任一路径段以 `.` 开头（`.git`、`.obsidian`、`.gitkeep`…），或任一路径段命中 `*.tmp` / `*~` / `*.swp` / `*.icloud` / `.DS_Store`，一律不触发。过滤发生在监听根**之下**——因此用户显式把某个点目录设为监听根仍然有效。

### `{files}` 注入

触发时把本次窗口内收集到的变更文件清单（相对工作区的路径）注入提示词：

- 提示词里出现 `{files}` 时，**每个**占位符都被替换成清单本身（每行一条、前导 ` - `），不额外加标题——占位符由作者放在自己的句子里。
- 没有占位符且清单非空时，自动在提示词末尾追加一段：

  ```
  Changed files:
   - inbox/raw/a.md
   - content/posts/b.md
  ```

- 清单截断为 200 条，超出部分以 `... and N more` 计数补足；清单为空且使用占位符时替换为 `(no file changes recorded)`。

## 模型链与 Provider 白名单

执行前构建候选：`models` 非空用 `models`，否则用全局默认 `agentDefaultModel.currentSelection()`。`allowedProviders` 非空时先过滤候选，过滤后为空则本次运行失败（`no allowed model candidates`）。每个候选都在**全新 agent 会话**中尝试：创建会话 → 绑定工作区 → 提交提示词 → 等待**首个模型请求开始**；只有会话启动阶段失败（模型不存在、provider 不可用、超时、鉴权/配额、创建失败）才回退到下一个。一旦首个 assistant 内容出现即按该模型记成功——不用“任务是否语义成功”来决定回退。每次运行写入 `lastRunModel` / `lastRunAttempts`（含 `ok`/`error`）/ `lastRunError`。

`models` / `allowedProviders` 传 `[]` 视为清除（等同于未配置）。写时校验：同时提供 `models` 与**非空** `allowedProviders` 时，每个模型的 provider 必须在白名单内，否则创建/更新报错。旧数据没有这些字段，行为不变。

## Agent 预设

`agentPreset` 遵循 dsh 预设 id 约定 `[a-z0-9][a-z0-9-]*`；`null` / `""` 视为清除。执行时在尝试任何模型候选**之前**先解析预设：指定预设不存在或部署没有 agentPresets 服务 → 本次运行直接失败（`agent preset '<id>' not found`）；指定预设损坏 → 直接失败（`... failed to mount: <原因>`）；省略/清空 → 挂载部署的**默认**预设（没有该服务则按无预设会话运行）。预设解析失败发生在模型候选之前，因此**不会**触发模型链回退。每次成功运行把实际挂载的预设 id 写入 `lastRunPreset`；失败运行清空旧值。

## HTTP API

Host 半端在 `/file-events/api` 注册一个 prefix route：

| 方法 | 路径 | body | 返回 |
|---|---|---|---|
| GET | `/file-events/api` | — | `{ rules }` |
| POST | `/file-events/api` | 规则（`title`/`prompt`/`workspaceId`/`watchPaths` 必填，其余可选） | `{ rule }` |
| PATCH | `/file-events/api` | `{ id, ...patch }` | `{ rule }` |
| DELETE | `/file-events/api` | `{ id }` | `{ removed: true }` |
| POST | `/file-events/api/run` | `{ id }` | `{ rule }`（立即执行，跳过防抖，不含文件清单） |
| GET | `/file-events/api/workspaces` | — | `{ workspaces: [{ id, title }] }` |
| GET | `/file-events/api/presets` | — | `{ presets: [{ id, name?, description?, isDefault, broken? }] }` |

`PATCH` 省略某字段则保持原值；显式传空值清除对应字段：`watchPaths` 不能为空数组，`globs` / `ignoreGlobs` / `models` / `allowedProviders` 传 `[]`、`agentPreset` 传 `null` / `""` 均清除。`POST /run` 只执行一次（相当于手动触发、无文件事件）。

## 开发

```bash
npm install
npm run check    # 语法检查两个半端
npm test         # 离线测试套件
npm run build:client   # 从 client/index.js 构建 client/bundle.js
```

## 依赖

运行时只依赖普通 npm 包：`chokidar`（递归监听目录）、`minimatch`（通配符匹配）、`zod`（记录 schema）。不依赖任何 `@deepseek-ai/dsh-*` 包——Host 半端通过 `ctx.*` 运行时服务访问 harness 能力。

## License

MIT
