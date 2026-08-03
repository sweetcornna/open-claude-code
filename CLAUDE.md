# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other AI coding agents when working with code in this repository.

## Project Overview

This is a **reverse-engineered / decompiled** version of Anthropic's official Claude Code CLI tool. The goal is to restore core functionality while trimming secondary capabilities. Many modules are stubbed or feature-flagged off. TypeScript strict mode is enforced — **`bun run precheck` 必须零错误通过**（typecheck + lint fix + test，任务完成后必须运行）。提交用 Conventional Commits（`feat:`/`fix:`/`docs:`/`chore:`/`refactor:` + 中文描述）。

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
- **`~/.claude/ide` 锁文件目录** —— `getIdeLockfilesPaths()` **同时**搜两个根。这些锁文件是 IDE 插件写的、我们只读，只搜 occ 自己的根 = 静默断掉 IDE 集成。
- **系统提示词、User-Agent `claude-code/<ver>`、OTel `service.name`** —— 见 `src/constants/brand.ts` 顶部注释的"明确不改"清单。

**迁移**：`occ migrate` 把用户既有配置从 `~/.claude` 拷进来。`~/.claude` **只读**，凭据和会话历史**永不复制**。见 `src/config/migrateFromClaude.ts` 顶部的四条规则。

## Commands

日常只需要：`bun install`、`bun run dev`（dev 模式，MACRO defines 经 `-d` 注入）、`bun test <path>`（单文件）、**`bun run precheck`**（完成任务后必跑）。非自明命令：`bun run dev:inspect`（调试器，`BUN_INSPECT=9229` 选端口）、`bun run check:cycles`（循环依赖棘轮）、`bun run check:unused`、`bun run docs:dev`。完整清单见 `package.json` scripts。

## Architecture Gotchas（只记不可自行发现的约定；目录结构请直接读代码）

### Build / Runtime

- **Runtime 是 Bun 不是 Node**；构建产物经 `import.meta.require` 后处理后 node 也能跑。
- **为什么 Vite 必须代码分割**：Bun/JSC 会全量解析单个大 JS 文件的 bytecode 和 JIT，单文件 17MB 产物导致 RSS 暴涨至 ~1GB（Node/V8 懒解析仅需 ~220MB）。代码分割为 600+ 小 chunk 后 `--version` RSS 从 966MB 降至 35MB。**不要把构建"优化"回单文件。**
- **Vendor 路径解析**：chunk 在 `dist/` 或 `dist/chunks/`，vendor 二进制在 `dist/vendor/`；统一用 `src/utils/distRoot.ts` 的 `distRoot`，不要内联 `import.meta.url` 推算。
- Defines 集中在 `scripts/defines.ts`（版本号从 package.json 读）；dev 与 build 的默认 feature 列表**同源**（`DEFAULT_BUILD_FEATURES`，33 个），不是「全部启用」。

### Entry / Core Loop

- **print 模式（`-p`）靠 `rootAction` 里的提前 return 跳过子命令注册**，`src/cli/program/commands/` barrel 只能经那之后的**动态** import 触达。改成顶层静态 import 会静默让 print 路径付出注册成本，而 golden 测试测不出来（它们测输出正确性，不测启动耗时）。
- **REPL.tsx 的 hook 调用顺序由 `src/screens/__tests__/replHookOrder.test.ts` 钉住**（253 次调用的顺序快照）。组件本体 5400 行是有意停手 —— 剩余 hook 簇捕获面都在 50 字段以上，提取只会把代码藏到巨型上下文对象后面。文件头有 hook 簇映射注释。
- 工具白名单 `CORE_TOOLS` 在 `src/constants/tools.ts`（29 个），非白名单工具 + 全部 MCP 工具走延迟加载（SearchExtraTools TF-IDF 检索）。`src/services/searchExtraTools/` 复用 `localSearch.ts` 的 TF-IDF 函数——改那些函数需同步跑工具索引测试。

### Host facade 模式（依赖反转）

`packages/builtin-tools/` 是叶子，不该反向 import host 的 `src/`。工具需要 host 能力时走 facade：**`packages/tool-runtime/` 声明接口 + host 实现模块在自己文件末尾自注册 + 消费方从 tool-runtime 取**。现有 5 个：`slowOperations`、`analytics`、`featureGate`、`messageResponse`、`bootstrapState`。

- 注册由 `src/tools.ts` 顶部 side-effect import 保证先于 builtin tool 加载。**例外是 `bootstrapState`** —— 它故意**不**从 `tools.ts` 触发（type-only 回边会让类型图环数暴涨几百），改为搭 session bootstrap 顺风车。
- **未注册时的 fallback 各不相同，是刻意的**：`slowOperations` 退回原生 JSON、`analytics` no-op、`featureGate` 返回 defaultValue、`messageResponse` 透传 children、**`bootstrapState` fail-fast 抛错**（掩盖注册顺序 bug 比崩溃更糟）。
- 新增 facade 照抄 `slowOperations.ts`；注册与翻转分两个提交。
- `packages/tool-runtime/` 包内**零** `src/` 与 `builtin-tools` import（含 type-only），由 `src/__tests__/toolRuntimeTypeContract.test.ts` 的类型断言守着。

### UI / 包

- **Ink 框架在 `packages/@ant/ink/`**，不是 `src/ink/`（该目录不存在）。
- 老控制台兼容：`packages/@ant/ink/src/core/legacyConsole.ts` 检测 Windows build < 17763 自动启用，每 ~1s 全量重绘自愈 conhost 花屏；`CLAUDE_CODE_LEGACY_CONSOLE=1/0` 强制开关。其他环境不走此路径。
- 组件是 React Compiler 反编译产物（`const $ = _c(N)` 记忆化样板），正常现象。
- `packages/mcp-client/` 是**平行实现，连接/发现/执行那半边未接线**——生产只用它 4 个工具函数。不要为了一致性统一。
- `packages/cloud-artifacts/` 是独立 Cloudflare Worker，workspace 成员但**不被主 CLI import**。详见其 README。

### 已删/已委托的子系统（不要去找、不要恢复）

- **Remote Control**：传输层已删（`src/bridge/`、RCS、acp-link，约 45k 行，2026-07）。`occ remote-control` = exec `happy acp -- occ --acp`（Happy 项目负责客户端半边）。occ 侧命令行由 `buildCliLaunch()` 推导，**不要**手写 `process.execPath + argv[1]`。编辑器集成走 `occ --acp` 直连。
- **DIRECT_CONNECT**（`src/server/`、`claude server/open`、`cc://`）与 `packages/weixin/` 已删（2026-07）。
- Chrome 控制改用 Google `chrome-devtools-mcp`（`--chrome` 开启）；扩展 + native host 方案已删。
- Daemon 的 `DAEMON_WORKER_KINDS` 目前是**空的**（唯一 worker 随 bridge 删除），supervisor 机制保留为扩展点。后台会话（`daemon bg`/`attach` 等）不受影响。
- 已移除的 feature flag（代码全删，别再引用）：`CONTEXT_COLLAPSE`、`UDS_INBOX`、`LAN_PIPES`、`REVIEW_ARTIFACT`、`TEAMMEM`、`HISTORY_SNIP`、`OVERFLOW_TEST_TOOL` 及对应命令/工具。
- **`FORK_SUBAGENT` 并未被移除**（文档曾写错）——只是不进默认编译列表，`FEATURE_FORK_SUBAGENT=1 bun run dev` 可启用；`/fork` 现在是 `/branch` 的 alias。
- Analytics / GrowthBook / Sentry 是空实现。

### Feature Flags

- 统一 `import { feature } from 'bun:bundle'` + `feature('FLAG_NAME')`；**只能直接用在 `if` 或三元条件位置**（Bun 编译器限制），不能赋值变量、不能进箭头函数体、不能作 `&&` 链一部分。不要在 `cli.tsx` 重定义 `feature`。
- 环境变量 `FEATURE_<NAME>=1` 临时启用；默认列表见 `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES`（dev/build 同源，33 个）。
- `MCP_2026`（2026-08-02 起默认编译进）**只管客户端要不要用 `server/discover` 探测** —— serve 双时代、outputSchema 降级、OAuth 加固不受它门控；协商到的「时代」是连接属性（问 `getProtocolEra()`，不要再判标志）。见 `docs/features/mcp-2026.md`。
- `SKILL_LEARNING` 未编译进默认列表；运行时另由 `SKILL_LEARNING_ENABLED` 控制。

### Multi-API 兼容层

流适配器模式：第三方 API 格式转 Anthropic 内部格式，下游零改动。`CLAUDE_CODE_USE_OPENAI/GEMINI/GROK=1` 启用对应层（`src/services/api/{openai,gemini,grok}/`），`/login` 可配。Provider 优先级：`modelType` 参数 > 环境变量 > 默认 `firstParty`；新增 provider 在 `src/utils/model/providers.ts` 注册。

- **OpenAI 双线协议**：`OPENAI_WIRE_API=responses` 切到 Responses API（`<OPENAI_BASE_URL>/responses`，`responsesAdapter.ts`）；默认 `chat`。ChatGPT 订阅认证（`OPENAI_AUTH_MODE=chatgpt`）强制 responses 且走 Codex 专有后端（带指纹头、不发 `max_output_tokens`）。选择逻辑在 `wireProtocol.ts`。
- 模型映射按家族（haiku/sonnet/opus 子串）映射，见 `packages/@ant/model-provider/.../modelMapping.ts`，与 `src/utils/model/chatgptModels.ts` 的 tier 常量需人工同步。
- Provider 档案系统：`/provider save|use|list|delete`（`src/services/providerProfiles/`），激活是全形状写入（`PROFILE_ENV_KEYS` 是各家族可管理键的真源，新增 provider 相关 env 键要同步加进去）。
- **上下文窗口覆盖**：`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 对所有用户生效（曾是 ant-only，2026-08 解禁），在 `getContextWindowForModel()` 最顶端短路，贯通 autocompact 阈值/预测式 compact/硬阻断/statusline/`/context`。第三方模型探测不到窗口时兜底 200k，**这个键是唯一的纠正手段**——不要再加第二个覆盖入口。`CLAUDE_CODE_1M_CONTEXT_MODELS`（逗号分隔子串）按模型选择性追加 `[1m]` 后缀（`apply1mContextOptIn`，挂在 `getMainLoopModel` 出口）。配置真源文档：`docs/features/providers.md`。
- **首启向导**：`Onboarding.tsx` 步骤为 theme → migrate（`MigrationStep`，检测 `~/.claude` 且未迁移过才出现）→ oauth（`ConsoleOAuthFlow`，含全部 provider 表单）→ security → terminal-setup。ConsoleOAuthFlow 各表单的 Max ctx 字段接受 `128000`/`128k`/`1m`（`parseMaxContextInput`）；china preset 选定模型会按 `parseContextWindowTokens` 自动写上下文键。

## Testing

- 框架 `bun:test`；单测就近 `src/**/__tests__/`；集成测试 `tests/integration/`（9 个文件）。其中 **cli-golden**（子进程跑真 CLI，钉命令/flag 表面）和 **headless-ndjson**（钉 NDJSON 线格式）是 monolith 拆分的安全网——注意 headless-ndjson 钉的是 `StructuredIO`/schema 边界，**不执行** `runHeadlessStreaming`，是契约护栏而非代码路径护栏。
- system prompt 内容护栏在 `src/constants/promptEngineeringAudit.runner.ts`（行为锚点 + 已删内容反向断言 + 结构断言）；工具描述快照只钉 Bash/Agent/FileRead/FileEdit 四个（`promptCharacterization`，改后 `bun test <runner路径> -u` 并人工审读 snap diff）。

### Mock 使用规范

**只 mock 有副作用的依赖链，不 mock 纯函数/纯数据模块。** 必须 mock：`log.ts`、`debug.ts`（用共享 mock `tests/mocks/log.ts` / `tests/mocks/debug.ts`，不要内联）、`bun:bundle`、`settings/settings.js`、`config.ts`、`auth.ts`、第三方网络库。路径统一 `.ts` 扩展名 + `src/*` 别名，禁止双重 mock 同一模块。

#### 跨文件 mock 污染（process-global `mock.module`）

**Bun 的 `mock.module` 是进程全局的（last-write-wins），不是 per-file 隔离的。** 实测事实：执行顺序**不是**字母序；`beforeAll` 内调用不 hoist 但仍污染后续加载；`require`/`import` 共享注册表；一旦替换，同进程所有后续导入都拿到 mock，无论 specifier 写法。

**核心规则：不要 mock 被测模块的上层业务模块** —— mock 底层（如 axios，用 `tests/mocks/axios.js` 的 `setupAxiosMock`），否则会污染同目录需要测真实模块的回归测试（如 `api.test.ts`）。排查方法：单跑可疑文件→与同目录合跑定位→`console.error` 追执行顺序→核对 specifier 是否解析到同一模块。

**多文件共用模块必须用完整表面 mock**：`envUtils.js` 用 `tests/mocks/envUtils.ts` 的 `setupEnvUtilsMock(overrides)`，`growthbook.js` 用 `tests/mocks/growthbook.ts`，其他模块用 `tests/mocks/sharedModuleMock.ts` 的 `makeSharedModuleMock` 就地包装。**禁止再手写部分表面的 `mock.module`**（只导出自己用到的几个函数）：进程全局 last-write-wins 下，后跑的文件会拿到缺导出（"Export not found"/undefined）或手抄后漂移的旧语义——这曾让 Linux CI 因文件顺序与 macOS 不同而红了一整批（envUtils 的手抄回退还停留在隔离前的 `~/.claude` 语义）。共享 mock 的默认行为是逐导出委托真实实现，套件只覆写真正需要变的函数，`afterAll` 里 `reset()`。

## Working with This Codebase

- **precheck 必须零错误**；pre-commit hook（husky + lint-staged）会对暂存文件跑 biome。
- **循环依赖棘轮 `bun run check:cycles` 双向严格**（超预算与**低于**预算都 fail）。处理方式见 `CONTRIBUTING.md` §9。工作流规范（提交/PR/文档放哪/`.claude/` 与 `.occ/` 双目录政策）也在 CONTRIBUTING。
- **Biome**：42 条规则因 decompiled 代码关闭；`.tsx` 120 列 + 强制分号，其他 80 列。tsc 要求声明属性但 biome 报 `noUnusedPrivateClassMembers` 时，用 `// biome-ignore lint/correctness/noUnusedPrivateClassMembers: <原因>`。
- **`@ts-expect-error`**：directive 变 unused（TS2578）直接删；MACRO 替换产生的永假比较（如 `'production' === 'development'`）仍需保留。
- 生产代码禁止 `as any`（测试 mock 可用）；优先 `as unknown as T` 双重断言或补 interface。
- `src/*` path alias 有效（tsconfig 映射）。
- 设计 Web UI 时参考 `.impeccable.md`（Impeccable 设计上下文：品牌色 Claude Orange `#D77757`、Anthropic 式干净排版）。

## 发布（npm / GitHub Release）

- **npm 包名是 `@sweetcornna/open-claude-code`**（无 scope 的 `open-claude-code` 被第三方 0.0.0 占位包抢注，publish 会 403）。包名同时钉在 `package.json`、`src/constants/brand.ts` 的 `NPM_PACKAGE_NAME`（`updateIsolation.test.ts` 断言）、`scripts/install.sh`、README、`docs/auto-updater.md`——改名五处必须同步。bin 名（`occ`/`occ-bun`/`open-claude-code`）与包名无关，不要动。
- 发布流程：打 `v*` tag 推送 → `publish-npm.yml` 自动跑 typecheck → `tests/integration` → build:vite + check:bundle + 双入口 `--version` 冒烟 → `npm publish --provenance` → GitHub Release。**publish 故意只跑集成测试**：全量单测在 Linux runner 上有既有的顺序性 env 污染失败（~10 个文件，macOS 本地不复现，main 的 ci.yml 同样红），修复前不要把 `bun test` 全量塞回 publish 门禁。
- 版本号延续 2.8.x 叙事（首个对外发布是 v2.9.0），**不要回退到 1.x**——`occ update` 的 semver 比较会把老用户永远锁在"已是最新"。
