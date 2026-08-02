# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other AI coding agents when working with code in this repository.

## Project Overview

This is a **reverse-engineered / decompiled** version of Anthropic's official Claude Code CLI tool. The goal is to restore core functionality while trimming secondary capabilities. Many modules are stubbed or feature-flagged off. TypeScript strict mode is enforced — **`bun run precheck` 必须零错误通过**（包含 typecheck + lint fix + test）。

本项目已改名为 **open-claude-code**（CLI 名 `occ`），并与官方 Claude Code 完成了用户态隔离。**动任何路径相关代码前，先读下面这节。**

## 路径与隔离不变式（最容易被破坏的一组约定）

occ 与官方 Claude Code 必须能装在同一台机器上互不干扰。这不是洁癖 —— 隔离之前，两者共用同一条 macOS keychain 记录，任一边登录都会**覆盖对方的 OAuth token**。

**唯一真源是 `src/config/paths.ts`。所有路径都必须从那里派生。**

| 要什么 | 用什么 | 绝对不要写 |
| --- | --- | --- |
| 用户配置根 | `occConfigDir()` / `occConfigPath(...)` | `join(homedir(), '.claude')`、`join(homedir(), '.occ')` |
| 全局状态文件 | `occGlobalConfigFile()` | `~/.claude.json`、`~/.occ.json` 字面量 |
| 项目内资产目录 | `PROJECT_DIR_NAME` | `'.claude'`、`'.occ'` 字面量 |
| CLI 名 / 进程名 / socket 前缀 | `BIN_NAME` | `'claude'` |
| 缓存树 / XDG 子目录 | `CACHE_NAMESPACE` / `XDG_SUBDIR` | `'claude-cli'`、`'claude'` |

为什么这么严：改造前有 **12 处**绕过配置目录 helper 直接拼 `homedir() + '.claude'`。它们全都无视 `CLAUDE_CONFIG_DIR`，所以那个本就存在的隔离开关一直是漏的。其中两处是真实事故：`nativeInstaller/installer.ts` 会 `rm -rf ~/.claude/local`（隔离后等于**删掉官方 CLI 的本地安装**），`doctorDiagnostic.ts` 上报的路径和它实际检查的路径根本不是同一个。

**环境变量**：`OCC_CONFIG_DIR` > `CLAUDE_CONFIG_DIR`（弃用回退，约 50 个测试文件在用，暂不删）> `~/.occ`。

**故意保持不变的东西**（改了会坏，不要"顺手统一"）：

- **`CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` 文件名** —— 是跨工具生态约定，改名会让所有既有仓库丢失上下文。
- **`CLAUDECODE=1`** 子进程环境变量 —— 大量用户 hook 脚本和第三方 CLI 靠它判断"跑在 Claude Code 里"。occ 另外加了 `OCC=1`，两个都发。
- **`~/.claude/ide` 锁文件目录** —— `getIdeLockfilesPaths()` **同时**搜两个根。这些锁文件是 IDE 插件写的、我们只读，而市面上的插件是 Anthropic 的 `anthropic.claude-code`，它写 `~/.claude/ide`。只搜 occ 自己的根 = 静默断掉 IDE 集成。
- **系统提示词、User-Agent `claude-code/<ver>`、OTel `service.name`** —— 见 `src/constants/brand.ts` 顶部注释的"明确不改"清单。

**迁移**：`occ migrate` 把用户既有配置从 `~/.claude` 拷进来。`~/.claude` **只读**，凭据和会话历史**永不复制**（凭据与官方共用，复制等于把要拆掉的耦合又搬回来）。见 `src/config/migrateFromClaude.ts` 顶部的四条规则。

## Git Commit Message Convention

使用 **Conventional Commits** 规范：

```
<type>: <描述>
```

常见 type：`feat`、`fix`、`docs`、`chore`、`refactor`

示例：
- `feat: 添加模型 1M 上下文切换`
- `fix: 修复初次登陆的校验问题`
- `chore: remove prefetchOfficialMcpUrls call on startup`

## Commands

```bash
# Install dependencies
bun install

# Dev mode (runs cli.tsx with MACRO defines injected via -d flags)
bun run dev

# Dev mode with debugger (set BUN_INSPECT=9229 to pick port)
bun run dev:inspect

# Pipe mode
echo "say hello" | bun run src/entrypoints/cli.tsx -p

# Build (code splitting, outputs dist/cli.js + chunk files)
bun run build

# Build with Vite (alternative build pipeline)
bun run build:vite

# Test
bun test                                    # run all tests
bun test src/utils/__tests__/hash.test.ts   # run single file
bun test --coverage                         # with coverage report

# Lint & Format (Biome) — 日常开发用 precheck 代替单独调用
bun run lint              # lint check (全项目)
bun run lint:fix          # auto-fix lint issues
bun run format            # format all (全项目)
bun run check             # lint + format check (全项目)
bun run check:fix         # lint + format auto-fix

# Check unused exports
bun run check:unused

# Full check (typecheck + lint fix + test) — 任务完成后必须运行
bun run precheck

# Docs dev server (Mintlify)
bun run docs:dev
```

测试规范见下方 [Testing](#testing) 章节。`docs/testing/SLASH-COMMANDS-TEST-CHECKLIST.md` 是 slash 命令的人工验收清单。

## Architecture

### Runtime & Build

- **Runtime**: Bun (not Node.js). All imports, builds, and execution use Bun APIs.
- **Build**: `build.ts` 执行 `Bun.build()` with `splitting: true`，入口 `src/entrypoints/cli.tsx`，输出 `dist/cli.js` + chunk files。Build 默认启用 34 个 feature（见下方 Feature Flag 段）。构建后自动替换 `import.meta.require` 为 Node.js 兼容版本（产物 bun/node 都可运行）。构建时会将 `vendor/audio-capture/` 和 `src/utils/vendor/ripgrep/` 复制到 `dist/vendor/` 下。
- **Build (Vite)**: `vite.config.ts` + `scripts/post-build.ts`，代码分割模式，chunk 输出到 `dist/chunks/`。post-build 遍历 `dist/` 和 `dist/chunks/` 下所有 `.js` 文件做 `globalThis.Bun` 解构 patch，复制 vendor 文件到 `dist/vendor/`。
- **Vendor 路径解析**: 构建后 chunk 文件位于 `dist/` 或 `dist/chunks/` 下，vendor 二进制在 `dist/vendor/`。`src/utils/distRoot.ts` 提供共享的 `distRoot` 函数，通过 `import.meta.url` 路径中 `lastIndexOf('dist')` 或 `lastIndexOf('src')` 定位根目录。`ripgrep.ts`、`computerUse/setup.ts`、`updateOcc.ts` 均使用 `distRoot` 而非内联 `import.meta.url` 路径推算。`packages/audio-capture-napi/src/index.ts` 有独立的 `lastIndexOf('dist')` 逻辑，功能等价。
- **为什么 Vite 必须代码分割**: Bun/JSC 会全量解析单个大 JS 文件的 bytecode 和 JIT，单文件 17MB 产物导致 RSS 暴涨至 ~1GB（Node/V8 懒解析仅需 ~220MB）。代码分割为 600+ 小 chunk 后 Bun 按需加载，`--version` RSS 从 966MB 降至 35MB，完整加载从 1GB+ 降至 ~500MB。
- **Dev mode**: `scripts/dev.ts` 通过 Bun `-d` flag 注入 `MACRO.*` defines，运行 `src/entrypoints/cli.tsx`。feature 列表与 build 相同（同样来自 `DEFAULT_BUILD_FEATURES`），不是「全部启用」。
- **Module system**: ESM (`"type": "module"`), TSX with `react-jsx` transform.
- **Monorepo**: Bun workspaces — 15 个 workspace packages in `packages/`（含 `packages/@ant/` 下 5 个）resolved via `workspace:*`。
- **Lint/Format**: Biome (`biome.json`)。覆盖 `src/`、`scripts/`、`packages/` 全项目（含 `packages/@ant/`）。`bun run lint` / `bun run lint:fix` / `bun run format` / `bun run check` / `bun run check:fix`。42 条规则因 decompiled 代码被关闭，仅保留 `recommended` 基线。
- **Pre-commit**: husky + lint-staged。提交时自动对暂存文件执行 `biome check --fix`（TS/JS）和 `biome format --write`（JSON）。
- **CI Lint**: `ci.yml` 在依赖安装后、类型检查前执行 `bunx biome ci .`，lint 或格式化不达标则 CI 失败。
- **Defines**: 集中管理在 `scripts/defines.ts`。版本号从 `package.json` 读取（不再硬编码）。
- **CI**: GitHub Actions — 两条 workflow：
  - `ci.yml` — push / PR 触发。`ci` job（ubuntu）跑 `bunx biome ci .` → `typecheck` → `check:cycles`（循环依赖棘轮）→ 带覆盖率的 `bun test` → `build:vite`；`windows` job（windows-latest）单独跑 typecheck + Windows 敏感测试套件（路径校验/沙箱逃逸回归、隔离、ripgrep 解析、mailbox、legacy console）。windows 是独立 job 而非 matrix 分支，因为它有意跑一套不同的、更窄的步骤。
  - `publish-npm.yml` — npm 发布通道，`v*` tag 触发，`npm publish --provenance`，并生成 changelog + GitHub Release。

### Entry & Bootstrap

1. **`src/entrypoints/cli.tsx`** — True entrypoint。`main()` 函数按优先级处理多条快速路径：
   - `--version` / `-v` — 零模块加载
   - `--dump-system-prompt` — feature-gated (DUMP_SYSTEM_PROMPT)
   - `--computer-use-mcp` — 独立 MCP server 模式
   - `--daemon-worker=<kind>` — feature-gated (DAEMON)
   - `remote-control` / `rc` / `remote` / `sync` / `bridge` — feature-gated (ACP)，exec `happy acp -- occ --acp`
   - `daemon` [subcommand] — feature-gated (DAEMON)
   - `ps` / `logs` / `attach` / `kill` / `--bg` — feature-gated (BG_SESSIONS)
   - `new` / `list` / `reply` — Template job commands
   - `environment-runner` / `self-hosted-runner` — BYOC runner
   - `--tmux` + `--worktree` 组合
   - 默认路径：加载 `main.tsx` 启动完整 CLI
2. **`src/main.tsx`**（302 行）— 只剩启动副作用、`main()` 与一个 re-export。Commander.js 的程序定义住在 **`src/cli/program/`**：`rootOptions.tsx`（根选项链）、`preAction.tsx`、`rootAction.tsx`（主 action 处理器，负责权限、MCP、会话恢复、REPL/Headless 分发）、`run.tsx`，加上 `commands/` 下 14 个文件按领域注册 52 个 subcommand（`mcp`、`ssh`、`auth`、`plugin`、`agents`、`auto-mode`、`autonomy`、`doctor`、`update` 等）。
   **改这块前注意**：print 模式（`-p`/`--print`）靠 `rootAction` 里的提前 return 跳过子命令注册，`commands/` barrel 只能经那之后的**动态** import 触达。把它改成顶层静态 import 会静默让 print 路径付出注册成本，而 golden 测试测不出来（它们测输出正确性，不测启动耗时）。
3. **`src/entrypoints/init.ts`** — One-time initialization (telemetry, config, trust dialog)。

### Core Loop

- **`src/query.ts`** — The main API query function. Sends messages to Claude API, handles streaming responses, processes tool calls, and manages the conversation turn loop.
- **`src/QueryEngine.ts`** — Higher-level orchestrator wrapping `query()`. Manages conversation state, compaction, file history snapshots, attribution, and turn-level bookkeeping. Used by the REPL screen.
- **`src/screens/REPL.tsx`** — The interactive REPL screen (React/Ink component). Handles user input, message display, tool permission prompts, and keyboard shortcuts. 纯 helper、内联组件与部分 hook 簇已提取到 `src/screens/repl/`；组件本体仍有 5400 行，剩余 hook 簇的捕获面都在 50 个字段以上，提取只会把同样的代码藏到巨型上下文对象后面，故有意停手。**REPL.tsx 的 hook 调用顺序由 `src/screens/__tests__/replHookOrder.test.ts` 钉住**（253 次调用的顺序快照），改动这个文件后它必须仍绿。文件头附近有一份 hook 簇映射注释，是后续提取的地图。

### API Layer

- **`src/services/api/claude.ts`** — Core API client. Builds request params (system prompt, messages, tools, betas), calls the Anthropic SDK streaming endpoint, and processes `BetaRawMessageStreamEvent` events.
- **7 providers**: `firstParty` (Anthropic direct), `bedrock` (AWS), `vertex` (Google Cloud), `foundry`, `openai`, `gemini`, `grok` (xAI)。
- Provider selection in `src/utils/model/providers.ts`。优先级：modelType 参数 > 环境变量 > 默认 firstParty。

### Tool System

- **`src/Tool.ts`** — Tool interface definition (`Tool` type) and utilities (`findToolByName`, `toolMatchesName`).
- **`src/tools.ts`** — Tool registry. Assembles the tool list; tools are imported from `@open-claude-code/builtin-tools` package. Some tools are conditionally loaded via `feature()` flags or `process.env.USER_TYPE`.
- **`src/constants/tools.ts`** — `CORE_TOOLS` 白名单常量（29 个核心工具名），用于 `isDeferredTool` 白名单制判定。
- **`packages/builtin-tools/src/tools/`** — 58 个工具目录（含 shared/testing 等工具目录），通过 `@open-claude-code/builtin-tools` 包导出。主要分类：
  - **文件操作**: FileEditTool, FileReadTool, FileWriteTool, GlobTool, GrepTool
  - **Shell/执行**: BashTool, PowerShellTool, REPLTool
  - **Agent 系统**: AgentTool, TaskCreateTool, TaskUpdateTool, TaskListTool, TaskGetTool
  - **规划**: EnterPlanModeTool, ExitPlanModeV2Tool, VerifyPlanExecutionTool
  - **Web/MCP**: WebFetchTool, WebSearchTool, MCPTool, McpAuthTool
  - **调度**: CronCreateTool, CronDeleteTool, CronListTool
  - **工具发现**: SearchExtraToolsTool, ExecuteExtraTool, SyntheticOutput（CORE_TOOLS，用于延迟工具按需加载）
  - **其他**: LSPTool, ConfigTool, SkillTool, EnterWorktreeTool, ExitWorktreeTool 等
- **`src/tools/shared/`** / **`packages/builtin-tools/src/tools/shared/`** — Tool 共享工具函数。
- **`src/services/searchExtraTools/`** — TF-IDF 工具索引模块（`toolIndex.ts`），为延迟工具提供语义搜索能力。复用 `localSearch.ts` 的 TF-IDF 算法函数（`computeWeightedTf`、`computeIdf`、`cosineSimilarity` 已导出）。修改这些函数时需同步检查工具索引测试。`prefetch.ts` 的 `extractQueryFromMessages` 复用了 `skillSearch/prefetch.ts` 的同名导出函数，修改 skill prefetch 的该函数时需同步检查工具预取行为。工具预取使用独立的 `discoveredToolsThisSession` Set，与 skill prefetch 的去重集合互不影响。

### Host facade 模式（依赖反转）

`packages/builtin-tools/` 是叶子，不该反向 import host 的 `src/`。做不到的地方（工具需要 host 能力，如埋点、会话状态、UI 组件）统一走 **facade**：**`packages/tool-runtime/` 声明接口 + host 实现模块在自己文件末尾自注册 + 消费方从 tool-runtime 取**。

现有 5 个：`slowOperations`（JSON 埋点）、`analytics`（logEvent）、`featureGate`（GrowthBook）、`messageResponse`（Ink 组件）、`bootstrapState`（22 个会话状态存取器）。

- **注册触发点**：host 实现模块在模块求值末尾调 `registerXxxHost({...} satisfies XxxHost)`，由 `src/tools.ts` 顶部的 side-effect import 保证它先于 builtin tool 模块加载。**例外是 `bootstrapState`** —— 它故意**不**从 `src/tools.ts` 触发（`tools.ts` 到 `bootstrap/state` 有一条 type-only 回边，加这条 import 会让类型图环数暴涨几百），改为搭 session bootstrap 的顺风车（`entrypoints/init.ts` / `main.tsx` / `query.ts` 都会先加载它）。`src/bootstrap/state.ts` 的注册语句上方有注释说明。
- **未注册时的 fallback 各不相同，是刻意的**：`slowOperations` 退回原生 JSON、`analytics` no-op、`featureGate` 返回 defaultValue、`messageResponse` 透传 children、**`bootstrapState` fail-fast 抛错**（状态存取器没有"原生等价物"，返回默认值会掩盖注册顺序 bug）。
- 新增 facade 照抄 `slowOperations.ts` 的形状；注册与翻转分成两个提交，与既有提交（`7bf70cee` / `9166757c`）的切法一致。

### UI Layer (Ink)

- **`src/interactiveHelpers.tsx`** — Ink render wrapper with ThemeProvider injection.
- **`packages/@ant/ink/`** — Custom Ink framework（forked/internal），包含 components、core、hooks、keybindings、theme、utils。注意：不是 `src/ink/`。
- **老控制台兼容模式** — `packages/@ant/ink/src/core/legacyConsole.ts`：检测 Windows build < 17763（无 ConPTY 的老系统，如 1709/LTSC 内网机器）时自动启用；`log-update.ts` 的渲染循环每约 1 秒（`LEGACY_CONSOLE_RESET_MS`）用一次全量重绘替换增量 diff，自愈老 conhost 的光标漂移花屏。`CLAUDE_CODE_LEGACY_CONSOLE=1`/`=0` 可强制开/关。其他环境完全不走此路径。
- **`src/components/`** — 151 个组件目录/文件，渲染于终端 Ink 环境中。关键组件：
  - `App.tsx` — Root provider (AppState, Stats, FpsMetrics)
  - `Messages.tsx` / `MessageRow.tsx` — Conversation message rendering
  - `PromptInput/` — User input handling
  - `permissions/` — Tool permission approval UI
  - `design-system/` — 复用 UI 组件（Dialog, FuzzyPicker, ProgressBar, ThemeProvider 等）
- Components use React Compiler runtime (`react/compiler-runtime`) — decompiled output has `_c()` memoization calls throughout.

### State Management

- **`src/state/AppState.tsx`** — Central app state type and context provider. Contains messages, tools, permissions, MCP connections, etc.
- **`src/state/AppStateStore.ts`** — Default state and store factory.
- **`src/state/store.ts`** — Zustand-style store for AppState (`createStore`).
- **`src/state/selectors.ts`** — State selectors.
- **`src/bootstrap/state.ts`** — Module-level singletons for session-global state (session ID, CWD, project root, token counts, model overrides, client type, permission mode).

### Workspace Packages

| Package | 说明 |
|---------|------|
| `packages/@ant/ink/` | Forked Ink 框架（components、hooks、keybindings、theme） |
| `packages/@ant/computer-use-mcp/` | Computer Use MCP server（截图/键鼠/剪贴板/应用管理） |
| `packages/@ant/computer-use-input/` | 键鼠模拟（dispatcher + darwin/win32/linux backend） |
| `packages/@ant/computer-use-swift/` | 截图 + 应用管理（dispatcher + per-platform backend） |
| `packages/@ant/model-provider/` | Model provider 抽象层 |
| `packages/tool-runtime/` | **叶子包，依赖反转的地基**。Tool 契约 + 5 个 host facade（见下方「Host facade 模式」）。包内**零** `src/` 与 `builtin-tools` import（含 type-only），由 `src/__tests__/toolRuntimeTypeContract.test.ts` 的类型断言守着 —— 那些断言会在 host 类型漂移时直接让 typecheck 爆 |
| `packages/builtin-tools/` | 内置工具集（58 个 tool 实现，通过 `@open-claude-code/builtin-tools` 导出） |
| `packages/agent-tools/` | Agent 工具集 |
| `packages/mcp-client/` | MCP 客户端库。**平行实现，连接/发现/执行那半边当前未接线** —— `src/services/mcp/client.ts` 只用了它的 4 个工具函数（`getMcpHttpStatus`、`isMcpSessionExpiredError`、`MAX_MCP_DESCRIPTION_LENGTH`、`recursivelySanitizeUnicode`），`discoverTools` / `callMcpTool` 没有任何生产调用方 |
| `packages/cloud-artifacts/` | 独立 Cloudflare Worker + R2 服务：POST `/upload` HTML 上传返回 hash URL，GET `/<7d\|30d>/<id>.html` 由 Worker 代理读取；R2 lifecycle rule 自动 7/30 天过期 |
| `packages/audio-capture-napi/` | 原生音频捕获（已恢复） |
| `packages/color-diff-napi/` | 颜色差异计算（完整实现，11 tests） |
| `packages/image-processor-napi/` | 图像处理（已恢复） |
| `packages/modifiers-napi/` | 键盘修饰键检测（macOS FFI 实现） |
| `packages/url-handler-napi/` | URL scheme 处理（环境变量 + CLI 参数读取） |
| `packages/workflow-engine/` | Workflow 工具实现（`@open-claude-code/workflow-engine`，被 19 个文件引用） |

`packages/` 下没有非 workspace 的辅助目录 —— 每个子目录都有 `package.json`。Langfuse 集成在 `src/services/langfuse/`（被 11 个生产文件引用），不是独立包。

### Remote Control

occ **不再自带远程控制的传输层**。它自带 ACP agent（`occ --acp`），客户端那一半交给 [Happy](https://github.com/slopus/happy)（MIT）—— 手机 App、Web、端到端加密、可自托管中继。

- **`src/cli/remoteControlLauncher.ts`**（~100 行）—— 唯一的实现。在 PATH 上找 `happy`，exec `happy acp -- <occ> --acp`。occ 那一半的命令行由 `buildCliLaunch()` 推导（与 daemon / bg session / tmux 重启同一套引导约定），**不要**手写 `process.execPath + argv[1]`。
- CLI 快速路径: `occ remote-control` / `rc` / `remote` / `sync` / `bridge`，gate 在 `ACP`（默认编译进）而非已删除的 `BRIDGE_MODE`。组织策略 `allow_remote_control` 在拉起 Happy **之前**检查。
- 自托管：`HAPPY_SERVER_URL` 指向自建 Happy 服务端即可，occ 侧零配置。
- `packages/remote-control-server/`（自托管 RCS）、`packages/acp-link/`（WS↔ACP 代理）、`src/bridge/`、`BRIDGE_MODE` 已于 2026-07 全部删除（约 45k 行）。已发布的 GHCR 镜像 `ghcr.io/<owner>/remote-control-server` 仍可拉取但已冻结归档。
- 详见 `docs/features/remote-control-self-hosting.md`。

### HTML Artifact Hosting

- **`packages/cloud-artifacts/`** — 独立 Cloudflare Worker + R2 服务，workspace 成员但**不被主 CLI import**。Worker 处理 `POST /upload`（Bearer token 鉴权 + text/html 校验 + 10MB 上限 + ttl∈{7,30}）和 `GET /<7d|30d>/<id>.html`（从 R2 读 + Cache-Control: max-age=86400）。R2 用 prefix + lifecycle rule 实现 TTL（`7d/` 删 7 天、`30d/` 删 30 天），Worker 不参与过期处理。ID 默认 `nanoid(21)`（126 bit 熵），可指定 `?hash=` 自定义 ID（覆盖语义：先删 7d/30d prefix 旧 key 再写新 key）。Worker 用 `wrangler types` 生成的全局 `Env` 类型（`worker-configuration.d.ts`，已 gitignore），不依赖 `@cloudflare/workers-types`。部署用 `npm create cloudflare@latest` 初始化 + `bun run setup`（创建 bucket + lifecycle + secret）+ `bun run deploy`。生产出口经 Deno Deploy 边缘代理（`https://cloud-artifacts.claude-code-best.win`），副作用是 HTTP status code 被抹平为 200（body 的 `{error}` 字段仍保留）。详见 `packages/cloud-artifacts/README.md`。

### ACP Protocol (Agent Client Protocol)

- **`src/services/acp/`** — ACP agent 实现，包含 `agent.ts`（AcpAgent 类）、`bridge.ts`（Claude Code ↔ ACP 桥接）、`permissions.ts`（权限处理）、`entry.ts`（入口）。
- 编辑器（Zed、JetBrains）可以直接把 occ 当 agent 起：`occ --acp`，不需要 Happy。远程控制走 Happy，编辑器集成走直连，两者共用同一个 agent。
- ACP 权限管道改进：`createAcpCanUseTool` 统一权限流水线，`applySessionMode` 模式同步，`bypassPermissions` 可用性检测（非 root/sandbox 环境）。
- ACP Plan 可视化已支持 `session/update plan` 类型的消息展示（PlanView 组件，含进度条/状态图标/优先级标签）。

### Daemon Mode

- **`src/daemon/`** — Daemon 模式（长驻 supervisor）。feature-gated by `DAEMON`。包含 `main.ts`（entry）和 `workerRegistry.ts`（worker 管理）。
- `DAEMON_WORKER_KINDS` 目前是**空的** —— 唯一的 worker `remoteControl` 是 bridge 的 headless 驱动，随 bridge 一起删了。supervisor 的 spawn / backoff / park / state file 机制保留为下一个长驻 worker 的扩展点；`daemon start` 会明说"这个 build 没有注册 worker"。后台会话（`daemon bg` / `attach` / `logs` / `kill`，BG_SESSIONS）不受影响。

### Context & System Prompt

- **`src/context.ts`** — Builds system/user context for the API call (git status, date, CLAUDE.md contents, memory files).
- **`src/utils/claudemd.ts`** — Discovers and loads CLAUDE.md files from project hierarchy.

### Feature Flag System

Feature flags control which functionality is enabled at runtime. 代码中统一通过 `import { feature } from 'bun:bundle'` 导入，调用 `feature('FLAG_NAME')` 返回 `boolean`。

**启用方式**: 环境变量 `FEATURE_<FLAG_NAME>=1`。例如 `FEATURE_BUDDY=1 bun run dev`。

**Build 默认 features**（34 个，见 `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES`；`build.ts` 从那里 import）:
- 基础: `BUDDY`, `TRANSCRIPT_CLASSIFIER`, `AGENT_TRIGGERS_REMOTE`, `CHICAGO_MCP`, `VOICE_MODE`
- 统计/缓存: `SHOT_STATS`, `PROMPT_CACHE_BREAK_DETECTION`, `TOKEN_BUDGET`
- P0 本地: `AGENT_TRIGGERS`, `ULTRATHINK`, `BUILTIN_EXPLORE_PLAN_AGENTS`, `LODESTONE`
- P1 API 依赖: `EXTRACT_MEMORIES`, `VERIFICATION_AGENT`, `KAIROS_BRIEF`, `AWAY_SUMMARY`, `ULTRAPLAN`
- P2: `DAEMON`, `ACP`
- 工作流: `WORKFLOW_SCRIPTS`, `MONITOR_TOOL`, `KAIROS`
- 多 worker: `COORDINATOR_MODE`, `BG_SESSIONS`, `TEMPLATES`
- 连接器: `CONNECTOR_TEXT`, `COMMIT_ATTRIBUTION`
- 实验性: `EXPERIMENTAL_SKILL_SEARCH`, `EXPERIMENTAL_SEARCH_EXTRA_TOOLS`
- 模式: `POOR`, `SSH_REMOTE`
- 其他: `AUTOFIX_PR`（`/autofix-pr` 命令）, `GOAL`（持久化 thread goal）
- MCP: `MCP_2026`（MCP 协议 2026-07-28 版本协商，2026-08-02 起默认编译进；开启后 `connect()` 先用 `server/discover` 探测，回滚 = 重新注释该行）。**注意这个标志只管客户端要不要探测** —— serve 模式的双时代、outputSchema 降级、OAuth 加固都**不**受它门控，默认构建即生效；协商到的「时代」是连接的属性而非构建的属性（问 `getProtocolEra()`，不要再判一次标志）。见 `docs/features/mcp-2026.md`
- **未**编译进默认列表: `SKILL_LEARNING`（`scripts/defines.ts` 里已注释掉，需显式 `FEATURE_SKILL_LEARNING=1` 才编译进；运行时另由 `SKILL_LEARNING_ENABLED` 控制）

> `packages/weixin/`（微信 Channel）与整个 `DIRECT_CONNECT` 直连模式（`src/server/`、`useDirectConnect`、`claude server` / `claude open` / `cc://`）已于 2026-07 移除 —— 服务端全是 stub，客户端因 `parseConnectUrl` 返回空串而不可能连通。`occ ssh` 不受影响（它只依赖 `src/remote/`）。`src/plugins/bundled/` 现在没有任何内置 plugin，但注册表仍在用，保留为扩展点。
>
> 以下 flag 及其全部代码已于 2026-07 移除，不要再引用：`CONTEXT_COLLAPSE`、`UDS_INBOX`、`LAN_PIPES`、`REVIEW_ARTIFACT`、`TEAMMEM`、`HISTORY_SNIP`、`OVERFLOW_TEST_TOOL`。对应的 `/peers`、`/attach`、`/detach`、`/send`、`/pipes`、`/pipe-status`、`/history`、`/claim-main`、`/force-snip` 命令与 SnipTool / CtxInspectTool / ListPeersTool / ReviewArtifactTool / OverflowTestTool 一并删除。
>
> **`FORK_SUBAGENT` 并未被移除**（这份文档此前写错了）—— 它在 `scripts/defines.ts` 中一直是注释掉的状态（不进默认编译列表），但 `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts` 仍然存在，`isForkSubagentEnabled()` 有 8 个运行时门控点，`FEATURE_FORK_SUBAGENT=1 bun run dev` 可正常启用。只有 `/fork` slash 命令的独立实现被删除，该名字现在是 `/branch` 的 alias（`src/commands/branch/index.ts:6`）。

**Dev mode 默认**: 与 build 相同的 34 个（`scripts/dev.ts:40` 同样读 `DEFAULT_BUILD_FEATURES`）。不在表里的 flag 必须显式 `FEATURE_<NAME>=1`。

**类型声明**: `src/types/internal-modules.d.ts` 中声明了 `bun:bundle` 模块的 `feature` 函数签名。

**新增功能的正确做法**: 保留 `import { feature } from 'bun:bundle'` + `feature('FLAG_NAME')` 的标准模式，在运行时通过环境变量或配置控制，不要绕过 feature flag 直接 import。

### Multi-API 兼容层

所有兼容层均采用流适配器模式：将第三方 API 格式转为 Anthropic 内部格式，下游代码完全不改。通过 `/login` 命令配置。

#### OpenAI 兼容层

通过 `CLAUDE_CODE_USE_OPENAI=1` 启用，支持 Ollama/DeepSeek/vLLM 等任意 OpenAI Chat Completions 协议端点。含 DeepSeek thinking mode 支持。

- **`src/services/api/openai/`** — client、消息/工具转换、流适配、模型映射
- 关键环境变量：`CLAUDE_CODE_USE_OPENAI`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`
- **双线协议**：`OPENAI_WIRE_API=responses` 切到 Responses API（`<OPENAI_BASE_URL>/responses`，事件流经 `responsesAdapter.ts` 转 Anthropic 内部格式）；默认 `chat`（Chat Completions）。ChatGPT 订阅认证（`OPENAI_AUTH_MODE=chatgpt`）强制 responses 且走 Codex 专有后端（带指纹头、不发 `max_output_tokens`）；通用 `/responses` 路线发标准头 + `max_output_tokens`。选择逻辑在 `wireProtocol.ts`

#### Gemini 兼容层

通过 `CLAUDE_CODE_USE_GEMINI=1` 启用。独立环境变量体系。

- **`src/services/api/gemini/`** — client、模型映射、类型定义
- 关键环境变量：`GEMINI_API_KEY`（必填）、`GEMINI_MODEL`（直接指定）、`GEMINI_DEFAULT_SONNET_MODEL`/`GEMINI_DEFAULT_OPUS_MODEL`（按能力映射）
- 模型映射优先级：`GEMINI_MODEL` > `GEMINI_DEFAULT_*_MODEL` > `ANTHROPIC_DEFAULT_*_MODEL`(已废弃) > 原样返回

#### Grok 兼容层

通过 `CLAUDE_CODE_USE_GROK=1` 启用。自定义模型映射支持 xAI Grok API。

- **`src/services/api/grok/`** — client、模型映射

详见各兼容层的 docs 文档。

### 穷鬼模式（Budget Mode）

- 通过 `/poor` 命令切换，持久化到 `settings.json`。
- 启用后跳过 `extract_memories`、`prompt_suggestion` 和 `verification_agent`，显著减少 token 消耗。
- 实现在 `src/commands/poor/poorMode.ts`。

### Stubbed/Deleted Modules

| Module | Status |
|--------|--------|
| Computer Use (`@ant/*`) | Restored — macOS + Windows + Linux（后端完整度不一） |
| Chrome 浏览器控制 | Replaced — 扩展 + native host 方案已删除，改用 Google `chrome-devtools-mcp`（stdio 子进程，`--chrome` 开启）。见 `docs/features/chrome-devtools-mcp.md` |
| `*-napi` packages | 全部已恢复/实现：`audio-capture-napi`、`image-processor-napi` 已恢复；`color-diff-napi` 完整；`modifiers-napi`（macOS FFI）；`url-handler-napi`（环境变量+CLI） |
| Voice Mode | Restored — Push-to-Talk 语音输入（需 Anthropic OAuth） |
| OpenAI/Gemini/Grok 兼容层 | Restored |
| Remote Control | Delegated — `occ remote-control` 交给 Happy（`happy acp -- occ --acp`）；自建 RCS / acp-link / `src/bridge/` 已删除 |
| `packages/shell/`, `packages/swarm/`, `packages/mcp-server/`, `packages/cc-knowledge/` | Removed — 功能合并或废弃 |
| Analytics / GrowthBook / Sentry | Empty implementations |
| Magic Docs / LSP Server | Restored — Magic Docs 自动更新 + LSP 服务器管理器 |
| Plugins / Marketplace | Restored — 插件安装/卸载/启用/禁用 + Marketplace 浏览 |
| MCP OAuth | Hardened — RFC 9207 `iss` 校验、凭据按 issuer 分槽、DCR `application_type: 'native'`。**不受 `MCP_2026` 门控**，默认构建即生效。见 `docs/features/mcp-2026.md` |

### Key Type Files

- **`src/types/global.d.ts`** — Declares `MACRO`, `BUILD_TARGET`, `BUILD_ENV` and internal Anthropic-only identifiers.
- **`src/types/internal-modules.d.ts`** — Type declarations for `bun:bundle`, `bun:ffi`, `@anthropic-ai/mcpb`.
- **`src/types/message.ts`** — Message type hierarchy (UserMessage, AssistantMessage, SystemMessage, etc.).
- **`src/types/permissions.ts`** — Permission mode and result types.

## Testing

- **框架**: `bun:test`（内置断言 + mock）
- **单元测试**: 就近放置于 `src/**/__tests__/`，文件名 `<module>.test.ts`
- **集成测试**: `tests/integration/` — 9 个文件（cli-arguments, cli-golden, context-build, headless-ndjson, message-pipeline, tool-chain, autonomy-lifecycle-user-flow, dependency-overrides, goal-lifecycle）。其中 **cli-golden**（子进程跑真 CLI，钉住命令/flag 表面）和 **headless-ndjson**（钉住 NDJSON 事件序列）是 monolith 拆分的安全网 —— 动 `src/cli/program/` 或 `src/cli/print/` 时它们是主要防线。注意 headless-ndjson 钉的是 `StructuredIO`/schema 边界的线格式，**不执行** `runHeadlessStreaming`，所以它是契约护栏而非代码路径护栏。
- **共享 mock/fixture**: `tests/mocks/`（api-responses, file-system, fixtures/）
- **命名**: `describe("functionName")` + `test("behavior description")`，英文
- **包测试**: `packages/` 下各包也有独立测试（如 `color-diff-napi` 11 tests）

### Mock 使用规范

**只 mock 有副作用的依赖链，不 mock 纯函数/纯数据模块。**

被迫 mock 的根源：`log.ts` / `debug.ts` → `bootstrap/state.ts`（模块级 `realpathSync` / `randomUUID` 副作用）。必须 mock 的模块：`log.ts`、`debug.ts`、`bun:bundle`、`settings/settings.js`、`config.ts`、`auth.ts`、第三方网络库。

**`log.ts` 和 `debug.ts` 使用共享 mock**（`tests/mocks/log.ts` / `tests/mocks/debug.ts`），不要在测试文件中内联 mock 定义。使用方式：

```ts
import { logMock } from "../../../tests/mocks/log";
mock.module("src/utils/telemetry/log.ts", logMock);

import { debugMock } from "../../../../tests/mocks/debug";
mock.module("src/utils/telemetry/debug.ts", debugMock);
```

源文件导出变更时只需更新 `tests/mocks/` 下的对应文件，不需要逐个修改测试。

不要 mock：纯函数模块（`errors.ts`、`stringUtils.js`）、mock 值与真实实现相同的模块、mock 路径与实际 import 不匹配的模块。

路径规则：统一用 `.ts` 扩展名 + `src/*` 别名路径，禁止双重 mock 同一模块。

#### 跨文件 mock 污染（process-global `mock.module`）

**Bun 的 `mock.module` 是进程全局的（last-write-wins），不是 per-file 隔离的。** 一个测试文件的 `mock.module` 会污染同一进程中所有其他测试文件的 `require`/`import`。

**关键事实（Bun 1.x 实测验证）：**
- 测试文件执行顺序**不是严格字母序**，不要假设文件 A 一定在文件 B 之前执行。
- `mock.module` 在 `beforeAll` 内部调用时**不会被提升**（hoist），但仍会污染后续加载的文件。
- `require()` 和 `import()` 共享同一模块注册表，`mock.module` 对两者都生效。
- 一个模块一旦被某个文件的 `mock.module` 替换，同一进程中所有后续 `require`/`import` 都会返回 mock 值，即使调用方使用不同的 specifier 路径。

**核心规则：不要 mock 被测模块的上层业务模块。**

错误做法（会污染同目录的 `api.test.ts`）：
```ts
// launchSchedule.test.ts — 直接 mock 源 API 模块 ❌
mock.module('src/commands/schedule/triggersApi.js', () => ({
  listTriggers: listTriggersMock,
  // ...
}))
```

正确做法（mock 底层 HTTP 层，不污染业务模块）：参考 `launchSkillStore.test.ts`、`launchVault.test.ts` 的模式。
```ts
// launchSchedule.test.ts — mock axios 而非 triggersApi ✅
import { setupAxiosMock } from '../../../../tests/mocks/axios.js'

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.get = axiosGetMock
axiosHandle.stubs.post = axiosPostMock

beforeAll(() => { axiosHandle.useStubs = true })
afterAll(() => { axiosHandle.useStubs = false })
```

**判断标准：** 如果目录下同时有 `launch*.test.ts`（集成测试）和 `api.test.ts`（回归测试），`launch*.test.ts` 必须 mock axios 而非源 API 模块。`api.test.ts` 需要测试真实 API 模块的 HTTP 方法/URL/错误处理逻辑，被 mock 后就无法测试。

**排查 mock 污染的方法：**
1. 单独运行可疑文件确认其通过：`bun test path/to/suspect.test.ts`
2. 与同目录其他文件一起运行定位污染源：`bun test path/to/__tests__/`
3. 在两个文件中各加 `console.error('[file] milestone')` 追踪实际执行顺序
4. 检查 `mock.module` 的 specifier 是否与同目录其他测试的 `require`/`import` 路径解析到同一模块

### 类型检查

项目使用 TypeScript strict 模式，**tsc 必须零错误**。每次修改后运行：

```bash
bun run precheck
```

**类型规范**：
- 生产代码禁止 `as any`；测试文件中 mock 数据可用 `as any`
- 类型不匹配优先用 `as unknown as SpecificType` 双重断言，或补充 interface
- 未知结构对象用 `Record<string, unknown>` 替代 `any`
- 联合类型用类型守卫（type guard）收窄，不要强转
- `msg.request` 属性访问：`const req = msg.request as Record<string, unknown>`
- Ink `color` prop：用 `as keyof Theme` 而非 `as any`

## Working with This Codebase

- **precheck must pass** — `bun run precheck`（typecheck + lint fix + test）必须零错误，任何修改都不能引入新的类型/lint/测试错误。
- **循环依赖棘轮** — `bun run check:cycles` 双向严格（超预算与低于预算都 fail）。怎么处理（何时破环、何时 `--update`、以及「拆 barrel 会让 total 上升但真实耦合下降」这个反复出现的现象怎么判断）见 [`CONTRIBUTING.md`](CONTRIBUTING.md) §9。
- **工作流规范** — 提交格式、PR 要求、文档该放哪、`.claude/` 与 `.occ/` 双目录政策，见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。本文件只管「代码是什么样」。
- **Feature flags** — 默认全部关闭（`feature()` 返回 `false`）。Dev/build 各有自己的默认启用列表。不要在 `cli.tsx` 中重定义 `feature` 函数。
- **React Compiler output** — Components have decompiled memoization boilerplate (`const $ = _c(N)`). This is normal.
- **`bun:bundle` import** — `import { feature } from 'bun:bundle'` 是 Bun 内置模块，由运行时/构建器解析。不要用自定义函数替代它。**`feature()` 只能直接用在 `if` 语句或三元表达式的条件位置**（Bun 编译器限制），不能赋值给变量、不能放在箭头函数体里、不能作为 `&&` 链的一部分。正确：`if (feature('X')) {}` 或 `feature('X') ? a : b`。
- **`src/` path alias** — tsconfig maps `src/*` to `./src/*`. Imports like `import { ... } from 'src/utils/...'` are valid.
- **MACRO defines** — 集中管理在 `scripts/defines.ts`。Dev mode 通过 `bun -d` 注入，build 通过 `Bun.build({ define })` 注入。修改版本号等常量只改这个文件。
- **构建产物兼容 Node.js** — `build.ts` 会自动后处理 `import.meta.require`，产物可直接用 `node dist/cli.js` 运行。
- **Biome 配置** — 42 条 lint 规则因 decompiled 代码被关闭，仅保留 `recommended` 基线。格式化覆盖全项目（`src/`、`scripts/`、`packages/`，含 `packages/@ant/`）。`.tsx` 文件用 120 行宽 + 强制分号；其他文件 80 行宽 + 按需分号。JSON 格式化已启用。`.editorconfig` 与 Biome 配置对齐（2-space 缩进）。修改任何代码后应运行 `bun run precheck` 确认无类型/lint/格式/测试问题，pre-commit hook 会自动拦截不合格提交。
- **tsc 与 Biome 冲突处理** — 当 tsc 要求声明属性（赋值使用）但 biome 报 `noUnusedPrivateClassMembers`（只写不读）时，用 `// biome-ignore lint/correctness/noUnusedPrivateClassMembers: <原因>` 抑制 lint 警告，保留类型声明。`biome ci` 必须零 warnings。
- **`@ts-expect-error` 维护** — 只在下方代码确实有类型错误时保留 `@ts-expect-error`。如果类型系统已更新导致 directive 变为 unused（TS2578），直接移除注释。MACRO 替换产生的永假比较（如 `'production' === 'development'`）仍需保留 `@ts-expect-error`。
- **Ink 框架在 `packages/@ant/ink/`** — 不是 `src/ink/`（该目录不存在）。Ink 相关的组件、hooks、keybindings 都在 packages 中。
- **Provider 优先级** — `modelType` 参数 > 环境变量 > 默认 `firstParty`。新增 provider 需在 `src/utils/model/providers.ts` 注册。

## Design Context

Impeccable 设计上下文保存在 `.impeccable.md` 中。设计 Web UI（RCS 控制面板、文档站、着陆页）时必须参考该文件。

### 核心设计原则

1. **Considered over clever** — 每个设计选择都应感觉有意为之，而非追逐潮流
2. **Warmth through subtlety** — 通过橙色色调的中性色、留白布局、有温度的文案来传达温暖
3. **Density with clarity** — 技术用户需要信息密度，但不能混乱
4. **Community voice** — 设计应感觉是由使用者创造的，而非遥远的设计团队
5. **Anthropic's shadow** — 遵循 Anthropic 的设计直觉：干净的布局、充足的间距、温暖的色温

### 品牌色

- 主色：Claude Orange `#D77757`（terra cotta）
- 辅色：Claude Blue `#5769F7`
- 暗色模式使用温暖的深色表面（非冷蓝黑色）

### 目标用户

技术团队/企业，在专业工作流中使用 AI 辅助编程。友好的开源社区氛围，非企业 SaaS 风格。

### 视觉参考

Anthropic 公司的设计风格 — 干净、考究、温暖的底色。大量留白，以排版为核心。避免 AI 产品常见的设计套路（渐变文字、玻璃态、霓虹色）。
