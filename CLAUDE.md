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

**迁移**：`occ migrate` 把用户既有配置从 `~/.claude` 拷进来。`~/.claude` 全程**只读**；会话历史**永不复制**；凭据**只在用户显式选择时**复制（`--with-credentials` / 首启向导选项 1），且是单向 no-clobber（occ 已有登录就保留 occ 的），官方 keychain 条目永不改写。默认模式剥离一切密钥但保留端点类 env（`*_BASE_URL`、`*_MODEL`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`），plugins/skills/MCP 定义两种模式都迁。见 `src/config/migrateFromClaude.ts` 顶部的四条规则 + `migrateCredentials.ts`。

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

`packages/builtin-tools/` 是叶子，不该反向 import host 的 `src/`。工具需要 host 能力时走 facade：**`packages/tool-runtime/` 声明接口 + host 实现模块在自己文件末尾自注册 + 消费方从 tool-runtime 取**。现有 6 个：`slowOperations`、`analytics`、`featureGate`、`messageResponse`、`bootstrapState`、`apiRetry`。

- 注册由 `src/tools.ts` 顶部 side-effect import 保证先于 builtin tool 加载。**例外是 `bootstrapState`** —— 它故意**不**从 `tools.ts` 触发（type-only 回边会让类型图环数暴涨几百），改为搭 session bootstrap 顺风车。
- **未注册时的 fallback 各不相同，是刻意的**：`slowOperations` 退回原生 JSON、`analytics` no-op、`featureGate` 返回 defaultValue、`messageResponse` 透传 children、`apiRetry` 原样跑一次（不重试）、**`bootstrapState` fail-fast 抛错**（掩盖注册顺序 bug 比崩溃更糟）。
- 新增 facade 照抄 `slowOperations.ts`；注册与翻转分两个提交。**`apiRetry` 的注册是个例外**：host 实现 `src/services/api/openai/retry.ts` 是纯库（`sideQuery` 等多处直接 import 它），在文件末尾自注册会让每个 importer 都产生副作用，所以注册单独放在 `src/services/api/retryFacade.ts` 这层薄壳里，由 `tools.ts` 顶部 side-effect import。名字带 OpenAI 是历史包袱，`retryOpenAIRequest` 本身按 `retryClassification.ts` 分类，Anthropic/DeepSeek/Gemini 都在用。
- `packages/tool-runtime/` 包内**零** `src/` 与 `builtin-tools` import（含 type-only），由 `src/__tests__/toolRuntimeTypeContract.test.ts` 的类型断言守着。

### 长会话驻留（会静默变成 OOM 的一类）

- **子 agent 的每条消息都会变成父会话 `messages` 里的一条 `agent_progress`**，且 bash/mcp 那套就地替换**不适用**（替换会让运行中的 AgentTool 卡在「Initializing…」）。它们不落盘（`isLoggableMessage` 返回 false），所以主 transcript 再小也不代表内存小 —— 实测 9MB transcript / 4GB 堆，216 个子 agent、其中一个自己就 1,270 条消息。裁剪在 `utils/messages/pruneAgentProgress.ts`：**只在 agent 的 `tool_result` 到达时裁，运行中一律不动**，且**永不动 index 0**（`useLogMessages` 靠 `messages[0].uuid` 区分同头缩短与 compaction）。
- **终态任务的驱逐只在主线程 attachment 阶段跑**（`orchestrator.ts` 的 `isMainThread`），子 agent 轮次从不清扫。所以新增的任务类型要么自己排 `scheduleTerminalTaskEviction`，要么就会在长轮次里一直堆着。
- 判断是不是真漏看 GC 日志：`Ineffective mark-compacts` + 回收量接近 0 = 真实驻留，调 `--max-old-space-size` 只是推后。真源文档 `docs/zh/features/memory-footprint.md`。

### UI / 包

- **Ink 框架在 `packages/@ant/ink/`**，不是 `src/ink/`（该目录不存在）。
- 老控制台兼容：`packages/@ant/ink/src/core/legacyConsole.ts` 检测 Windows build < 17763 自动启用，每 ~1s 全量重绘自愈 conhost 花屏；`CLAUDE_CODE_LEGACY_CONSOLE=1/0` 强制开关。其他环境不走此路径。
- 组件是 React Compiler 反编译产物（`const $ = _c(N)` 记忆化样板），正常现象。
- `packages/mcp-client/` 是**平行实现，连接/发现/执行那半边未接线**——生产只用它 4 个工具函数。不要为了一致性统一。
- `packages/cloud-artifacts/` 是独立 Cloudflare Worker，workspace 成员但**不被主 CLI import**。详见其 README。

### 已删/已委托的子系统（不要去找、不要恢复）

- **Remote Control**：传输层已删（`src/bridge/`、RCS、acp-link，约 45k 行，2026-07）。`occ remote-control` = exec `happy acp -- occ --acp`（Happy 项目负责客户端半边）。occ 侧命令行由 `buildCliLaunch()` 推导，**不要**手写 `process.execPath + argv[1]`。编辑器集成走 `occ --acp` 直连。
- **DIRECT_CONNECT**（`src/server/`、`claude server/open`、`cc://`）与 `packages/weixin/` 已删（2026-07）。
- **不内置 Chrome MCP**：用户可通过普通 MCP 配置接入任意浏览器工具，`chrome-devtools` 等名称不保留。
- Daemon 的 `DAEMON_WORKER_KINDS` 目前是**空的**（唯一 worker 随 bridge 删除），supervisor 机制保留为扩展点。后台会话（`daemon bg`/`attach` 等）不受影响。
- 已移除的 feature flag（代码全删，别再引用）：`CONTEXT_COLLAPSE`、`UDS_INBOX`、`LAN_PIPES`、`REVIEW_ARTIFACT`、`TEAMMEM`、`HISTORY_SNIP`、`OVERFLOW_TEST_TOOL` 及对应命令/工具。
- **`FORK_SUBAGENT` 并未被移除**（文档曾写错）——只是不进默认编译列表，`FEATURE_FORK_SUBAGENT=1 bun run dev` 可启用；`/fork` 现在是 `/branch` 的 alias。
- Analytics / GrowthBook / Sentry 是空实现。

### Feature Flags

- 统一 `import { feature } from 'bun:bundle'` + `feature('FLAG_NAME')`；**只能直接用在 `if` 或三元条件位置**（Bun 编译器限制），不能赋值变量、不能进箭头函数体、不能作 `&&` 链一部分。不要在 `cli.tsx` 重定义 `feature`。
- 环境变量 `FEATURE_<NAME>` 覆盖单个 flag：`1`/`true` 开，`0`/`false`/空关（**关也对默认列表里的 flag 生效**，这是把某个 feature 从构建里摘掉的唯一办法）。解析集中在 `scripts/defines.ts` 的 `resolveBuildFeatures()`，`dev.ts` 与 Vite 插件共用——早先两边各自只判断变量**是否存在**，`FEATURE_X=0` 反而会把功能编进发布产物。默认列表见同文件的 `DEFAULT_BUILD_FEATURES`（dev/build 同源，33 个）。
- `MCP_2026`（2026-08-02 起默认编译进）**只管客户端要不要用 `server/discover` 探测** —— serve 双时代、outputSchema 降级、OAuth 加固不受它门控；协商到的「时代」是连接属性（问 `getProtocolEra()`，不要再判标志）。见 `docs/zh/features/mcp-2026.md`。
- `SKILL_LEARNING` 未编译进默认列表；运行时另由 `SKILL_LEARNING_ENABLED` 控制。

### Multi-API 兼容层

流适配器模式：第三方 API 格式转 Anthropic 内部格式，下游零改动。`CLAUDE_CODE_USE_OPENAI/GEMINI/GROK=1` 启用对应层（`src/services/api/{openai,gemini,grok}/`），`/login` 可配。Provider 优先级：`modelType` 参数 > 环境变量 > 默认 `firstParty`；新增 provider 在 `src/utils/model/providers.ts` 注册。

- **OpenAI 双线协议**：`OPENAI_WIRE_API=responses` 切到 Responses API（`<OPENAI_BASE_URL>/responses`，`responsesAdapter.ts`）；默认 `chat`。ChatGPT 订阅认证（`OPENAI_AUTH_MODE=chatgpt`）强制 responses 且走 Codex 专有后端（带指纹头、不发 `max_output_tokens`）。选择逻辑在 `wireProtocol.ts`。
- 模型映射按家族（haiku/sonnet/opus 子串）映射，见 `packages/@ant/model-provider/.../modelMapping.ts`，与 `src/utils/model/chatgptModels.ts` 的 tier 常量需人工同步。
- Provider 档案系统：`/provider-settings`（别名 `providers`/`provider`/`api`，2026-08-11 由 `/provider` 合并而来，旧写法全部保留；`src/commands/provider-settings/` + `src/services/providerProfiles/`）。面板里 `A` 新增（跑登录向导并存档，**会切换会话**，理由见 `addFlow.ts` 顶部）、`E` 重命名（键迁移）、`Space` 聚合、`R` 刷新、`D D` 删除。激活是全形状写入（`PROFILE_ENV_KEYS` 是各家族可管理键的真源，新增 provider 相关 env 键要同步加进去）。裸家族名（`/provider-settings openai`）走的是**家族**轴而不是档案轴，两者靠位置区分。
- **上下文窗口覆盖**：`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 对所有用户生效（曾是 ant-only，2026-08 解禁），在 `getContextWindowForModel()` 最顶端短路，贯通 autocompact 阈值/预测式 compact/硬阻断/statusline/`/context`。第三方模型探测不到窗口时兜底 200k。**它仍是最高优先级的纠正手段**，但 2.31.0 起下面多了一层：`settings.modelSettings.<tier>.contextTokens`（见 `docs/zh/features/model-settings.md`）。优先级链是 env > 分层配置 > 内置默认；不要再加第三个覆盖入口。`CLAUDE_CODE_1M_CONTEXT_MODELS`（逗号分隔子串）按模型选择性追加 `[1m]` 后缀（`apply1mContextOptIn`，挂在 `getMainLoopModel` 出口）。配置真源文档：`docs/zh/features/providers.md`。
- **GPT 调优门控**：`src/utils/model/gptTuning.ts` 的 `isGptTuningActive()`（provider=openai 且**解析后**模型为 GPT 家族——先过 `resolveOpenAIModel` 映射，别名 `/model opus` 也命中）是全部 GPT 专属行为的**唯一门控**：行为 overlay（`openai/gptBehaviorPrompt.ts`，在 `queryModelOpenAI` 末尾追加）、EnterPlanMode/Agent 工具克制文案、plan mode 指令变体、参数默认（GPT 家族 effort 出厂默认 xhigh，Chat Completions 将 xhigh/max 夹到 high；responses 线 verbosity 默认 low，`OPENAI_VERBOSITY` env 可对任意端点显式放行/关闭）。新增 GPT 差异化行为必须挂这个门控；**Anthropic 路径与非 GPT 模型必须字节级不变**（护栏：dump-prompt 对比 + promptCharacterization 快照 + `tests/mocks/gptTuning.ts` 共享 mock——测试里渲染这些 prompt 前先把门控钉成 false，否则在 openai 配置的机器上会波及快照）。responses 线网络层在 `openai/retry.ts`（退避重试）+ `responsesAdapter.ts`（空闲看门狗、代理接入），`OPENAI_REQUEST_MAX_RETRIES`/`CLAUDE_STREAM_IDLE_TIMEOUT_MS` 可调。
- **OpenCode（Console 推理面 / Zen 网关 / Go 订阅）**：一个账号后面是**三个推理端点**。其中两个是产品，同主机不同路径——Zen（`opencode.ai/zen/v1`，按量扣 credit，61 个模型含 Claude）与 Go（`opencode.ai/zen/go/v1`，包月订阅，25 个开源系编码模型、**无 Claude**，响应带 `"cost":"0"`）。**两者同主机，只差一个路径段**，所以「这是哪个 OpenCode 端点」必须比 path（`opencodeProductForBaseUrl()`），只比 host 的 `usesOfficialEndpoint()` 对两个都答是——那正是 Go 用户被塞 Zen 61 个模型的那个 bug，选中一个就扣 Zen 余额并回 `CreditsError: Insufficient balance`（这条错既不提产品也不提 URL）。内置目录表两张（`components/opencodeLogin/opencodeCatalog.ts` 的 `OPENCODE_PRODUCTS`），两个产品都不认的 base URL 两张都不给。免费档只有 Zen 有。**协议线判定对两个产品是同一套、不要改**：`src/utils/model/opencodeWire.ts` 按 `OPENCODE_MODEL` 的家族选线并把配置镜像到 `ANTHROPIC_*` / `OPENAI_*`（claude→`/messages`、gpt·o 系→`/responses`、其余→`/chat/completions`）。**线路由只读 env，绝不解析模型** —— `getAPIProvider()` 在模型解析链上游，问 `model.ts` 会闭合环。**`/messages` 不做格式转换只做转发**（实测：非 Anthropic 上游的模型打它，返回上游透传的 `Input required: specify "prompt" or "messages"`），所以 `OPENCODE_WIRE_API=messages` 配非 Claude 模型必然失败。凭据两种（Console 设备码 OAuth / `OPENCODE_API_KEY`），作为 bearer 的**形状**等价（opencode 自己也是解析成同一个 bearer），优先级 key > OAuth——但**形状等价 ≠ 端点等价，这两种是两种会话、两套配置，不许合并**。**Console OAuth token 打 Zen 是 401**（实测同账号同 token：`config.provider.opencode.api` 上 200、`opencode.ai/zen/v1` 上 `AuthError: Invalid API key.`），所以 Console 会话的 base URL、必带请求头（`x-org-id`，按账号，不能是常量）和模型表**全部从 `GET {console}/api/config` 的 `provider.opencode` 读**，照搬 sst/opencode 的插件。那个平面**只有 OpenAI 兼容一条线**（`/messages` 实测 404），因此 `OPENCODE_INFERENCE_PLANE=console` 会让 `getOpencodeLane()` 恒返回 `chat`——连 `OPENCODE_WIRE_API` 也不认，钉了只能钉出 404。端点与请求头存在 0600 文件的 `inference` 块里（和账号放一起，不是和 token 放一起：刷新只回 token），活值由 `setOpencodeRuntimeCredential(token, {baseUrl})` 进内存并**压过 `OPENCODE_BASE_URL`**。标记由设备码登录写、由 `specs.ts` 的 `extraEnv` 清（只在拥有凭据面的保存上跑 = 配 API key 时）。`/api/config` 把模型全报成 `status:"active"`，但真发请求会 403 `managed_inference_model_disabled`——**按组织的可用性请求前不可知**，所以不筛目录、改为出错时说人话（`inferenceErrors.ts`），且它**不是认证失败**（`MODEL_DISABLED` 信号在 `retryClassification.ts` 里排在 status 之前，落 `invalid_request`；探针也直接判通过）。**access token 绝不落盘到 settings.json 或 profile** —— 一小时过期 + 明文密钥，只存 0600 文件。Zen/Go 会话一个只说一条线，跨家族钉档位会有一档走错。免费档 `Bearer public` 无账号可用（Zen 限定）。真源文档 `docs/zh/features/opencode.md`。
- **「这个会话属于哪个 provider」不能问 `getAPIProvider()`** —— 它答的是**协议**，而 OpenCode 的协议由模型家族决定，于是同一个 Zen 账号会答出 `firstParty` 或 `openai`。接入 OpenCode 时**三个入口各踩了一次同一个坑**：`currentProfileModelType()`（`/provider save`）、`currentProviderSetupKind()`（`/model-settings`）、以及 `getAPIProvider()` 自身。前两个的后果一样且严重：解析到 `anthropic` 家族 → 快照/预填该家族的凭据键 → 而那里装的是镜像写进去的**活 access token** → 明文写进 `provider-profiles.json` / `settings.env`。准则：凡是要回答「归属哪个 provider」的地方，先问 `isOpencodeSessionActive()` 这类**身份**谓词，再 fall through 到协议判定。
- **`ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 不是一回事**：SDK 把前者变成 `x-api-key`、后者变成 `Authorization: Bearer`。Zen 的 `/messages` **只认 `x-api-key`**（实测：Bearer 单发回 `AuthError: Missing API key`，x-api-key 单发通过，两个都发也通过），所以 opencode 镜像写的是 `ANTHROPIC_API_KEY`。**这类错单元测试抓不到** —— 它们断言「哪个 env 键被写了」，而不是「那个键会变成什么头」；写反了的表现是每个会话都 401。凡是新增 provider 镜像，必须对真实端点验一次头。镜像出的 `ANTHROPIC_API_KEY` 还必须进 `isOccConfiguredAnthropicApiKey()`（`isOpencodeMirroredApiKey()`），否则交互式会弹审批、默认 No、拒掉用户刚登录的凭据，而 `-p` 一切正常 —— 与 DeepSeek 镜像同一个坑。
- **这里有三个不同的问题，别混用**：`getAPIProvider()` 答**协议**；`isThirdPartyModelCatalog()` 答**谁的目录 / 谁的价目表**；`servesAnthropicModels()` 答 **`claude-opus-5` 这个 id 是不是真指 Anthropic 的 Opus 5**。Bedrock/Vertex/Foundry 对第二个答「是第三方」（独立计费、beta 支持不同），对第三个答「是 Anthropic 的模型」—— 所以那边叫「Opus 5」是对的。openai/gemini/grok 和 DeepSeek Anthropic 线对第三个答否：`ALL_MODEL_CONFIGS` 给这几家映射的是**同一批 `claude-*` 字符串**，于是没配的档位会解析出字面量 `claude-fable-5`，DeepSeek 静默换成自家 checkpoint、其他家 404。把它显示成「Fable 5」等于对用户**和 system prompt**（"You are powered by the model named …"）撒谎。凡是「要不要用 Anthropic 营销名 / 要不要把 Anthropic model id 当可选项」问 `servesAnthropicModels()`。**非官方 `ANTHROPIC_BASE_URL` ≠ 第三方**（2.35.0 起，`isThirdPartyAnthropicEndpoint()`）：只有 positively 识别为第三方厂商（DeepSeek 端点，或会话锚定的模型不是 claude 系 id）才按第三方目录处理；纯代理/网关 + claude 系模型按 Anthropic 对待（beta 头、`[1m]`、营销名、Fast mode 全保留）——改这条判定前想想 LiteLLM/企业网关用户。
- **`getAPIProvider() !== 'firstParty'` 不等于「第三方模型」**。前者答的是**协议**，后者问 `isThirdPartyModelCatalog()`（`providers.ts`）。DeepSeek 走 Anthropic 线后两者分叉，而仓库里约 40 处把它们写成同一个表达式 —— 结果是 DeepSeek 会话的 `/model` 列出 Opus 5 并标 Anthropic 单价。准则：**改造前 DeepSeek 是 `provider === 'openai'`，这条线不得打开任何当时关着的 Anthropic 专属行为**（有意例外只有协议本身、原生 thinking、prompt 缓存、服务端搜索适配器）。定价文案 / `/model` 列表 / Anthropic 专属 beta 头（含 global cache scope、interleaved thinking、context management、adaptive thinking）/ legacy 模型迁移 / Fast mode / bootstrap 拉取，全部问 catalog 那个。
- **`-p` 与交互式（REPL）走的是两条 auth 分支，只测 `-p` 等于没测**。`preferThirdPartyAuthentication() = getIsNonInteractiveSession() && …`：print 模式直接采信 `ANTHROPIC_API_KEY`；交互式则要求它在 `customApiKeyResponses.approved` 里，否则弹「Detected a custom API key」并**默认选 No**，答默认就等于拒掉自己刚配好的 key，随后一路 401 显示 `Not logged in · Please run /login`。凡是 occ 自己写进去的 `ANTHROPIC_API_KEY`（Anthropic-compatible 向导写进 settings.env 的、DeepSeek 线内存镜像的）都不是「在环境里发现的」，必须绕过审批 —— 判定是 `isOccConfiguredAnthropicApiKey()`（`auth.ts`），三个用到的地方：`getAnthropicApiKeyWithSource`、`interactiveHelpers` 的启动弹窗、`Onboarding` 的 API-key 步骤。**验证这类问题必须真跑交互式**（pty + 读 `<configdir>/projects/**/*.jsonl` 里是否真有 assistant 轮），`-p` 结构上就看不见。
- **DeepSeek 默认走 Anthropic message 线**（2.31.0 起）：检测到 `OPENAI_BASE_URL` 指向 `api.deepseek.com` 时，`src/utils/model/deepseekWire.ts` 把配置镜像到 `ANTHROPIC_*` 键并让 `getAPIProvider()` 返回 `firstParty`，请求走 `/anthropic`。**镜像必须跟着配置走，不能只在启动时跑一次** —— `getAPIProvider()` 在 DeepSeek 键落进 `process.env` 的那一刻就翻成 `firstParty`，而首次 `/login` 恰恰是在启动之后才写这些键。漏掉重跑 = 会话「声称」走这条线却没应用：请求打到 api.anthropic.com、无凭据 401（界面显示 `Not logged in · Please run /login`）、档位别名解析成字面量 `claude-sonnet-5`。**真正的兜底在 `getAnthropicClient()` 里**（每次请求现建客户端，镜像是纯 env 幂等函数）—— 逐个补调用点是打地鼠，2.32.2 就漏了 `structuredIO` 的 `update_environment_variables`；放在建客户端处则「请求不可能由未应用的镜像构造出来」，与谁写的 env 无关。其余挂钩点（`managedEnv.ts` 的两个 apply 函数、`ProviderSetupWizard.doSave`、`ConsoleOAuthFlow`、`structuredIO`）保证的是**显示与模型解析**也同步，不是请求正确性。镜像用 `Map<key, 写入值>` 记账：只回收「当前值仍等于自己上次写入值」的键，否则那是别人（settings.env 重新应用、用户 export）的值，动不得。**settings.json 一字不改**（纯内存镜像），存量配置无感知。理由：那是 DeepSeek 三条协议里唯一同时提供原生 thinking 块、零格式转换和**服务端 web 搜索**的一条 —— chat 线根本没有内置搜索，而 `hasCodexSearchCredentials()` 要求 `api.openai.com`，所以 DeepSeek 用户此前一直落在 `FreeSearchAdapter`（无密钥抓取）。2.32.5 起这条 lane 是**独立的 `deepseek` 搜索源**（不再借 `anthropic` 的名字：那会在 `/search-setting` 里显示一行「已连接的 Anthropic」而字节全发往 DeepSeek，并把同一端点当两家各发一路），且**不看主循环协议** —— chat/responses 线的会话也能用上；只有 `CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` 整个关掉。有 key ≠ 那个部署实现了 `web_search_20250305`，所以 `probeDeepSeekSearchSupport()` 用一个 `max_tokens: 16` 的最小请求自动探测，答不认就走既有的会话级 availability 轴退役。见 `docs/zh/features/web-search-tool.md` §4.1。优先级 message（默认）> responses（显式 `OPENAI_WIRE_API`）> chat（显式）；`CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` 关闭。**七项调优在 message 线上的逐项结论**（2026-08-07 对真实端点实测）：
  - **temperature 0** 与 **thinking 显式关闭** 已移植到 `claude.ts`，门控用 `isDeepSeekTuningActiveForModel(model, ANTHROPIC_BASE_URL)` —— 必须带 baseURL，因为该端点也接受 `claude-*` 名并在服务端映射到 v4-pro/v4-flash。thinking 那条是真缺陷：**DeepSeek 把「没有 `thinking` 字段」当作启用**，而 occ 关闭时恰恰是不发该字段，于是 `CLAUDE_CODE_DISABLE_THINKING` 形同虚设（实测：不发 → `['thinking','text']`，发 `{type:'disabled'}` → `['text']`）。
  - **128 工具上限不要移植** —— 实测 150 个工具照样接受，那是 chat 线的限制。照搬会白白对模型隐藏工具。
  - `chat_template_kwargs` / `enable_thinking` / `reasoning_content` 补洞在这条线上不存在对应概念，无需移植。
  - **`reasoning_effort` 三档折叠必须移植**（2.32.5 更正了此前「让位给 `output_config.effort`」的结论）。实测该端点对五个值全部 200、不报错、也测不出差异 —— 那是坏消息：它没定义的档位静默回落到自家默认，而状态栏还显示用户选的那档。`configureEffortParams` 现在按 `isDeepSeekTuningActiveForModel(model, ANTHROPIC_BASE_URL)` 走同一张折叠表。同一处还修了 `modelSupportsEffort()`：白名单只写了 `deepseek-v4-pro`/`-flash`，漏掉 DeepSeek 官方文档教人配的 `deepseek-chat`/`deepseek-reasoner`，那些会话报「不支持 effort」而 chat 线照发 `max`。
  - 上下文 1M 本来就按模型名判定，跨 provider 生效，无需改动。
- **分层模型设置**（2.31.0 起）：`settings.modelSettings.<tier>.{effort,contextTokens}` 按 haiku/sonnet/opus/fable 分别配置，入口是 `/model` 选择器（`←/→` effort、`Space` 循环最大上下文，都作用于高亮行所属档位）和 `/model-settings` 命令。2.35.0 起另有独立的 `modelSettings.default` 槽（provider 默认模型专用，与四档互不污染，即使解析成同一 concrete id）；**槽位判定基于选择来源而不是解析后 id 对比**（默认链 → `default`，字面别名 → 别名槽，显式 id → 反查；恰等于 provider primary 的显式 id 归 `default`），实现禁止调用订阅/auth 链（`getContextWindowForModel` 是热路径且测试/CI 下 auth 会抛）。出厂默认按 provider 家族分（DeepSeek max·1M / GPT 含 o 系 xhigh·272k / Claude opus·fable xhigh·1M / Claude sonnet·haiku xhigh·200k / Gemini·Grok high·200k / 其他 xhigh·200k）。**occ 的五档只有 Anthropic 一家原生认，其余每家都要映射**，表在 `docs/zh/features/model-settings.md` 的「effort 怎么落到各家协议上」：DeepSeek 两条线都折成三档、OpenAI chat 把 xhigh·max 夹到 high、Gemini 缩放 `thinkingBudget`（`high` 是恒等档，所以 Gemini·Grok 的出厂默认才是 `high`）、Grok 折成两档且只对 `grok-3-mini` 系发。`modelSupportsEffort()` 是**显示与发送的同一个判据** —— 分叉过一次（`deepseek-chat` 判为不支持而 chat 线照发 `max`），界面装作没这旋钮、请求却一直被它操纵。**`modelTier.ts` 与 `tierDefaults.ts` 必须保持零依赖** —— 两个热解析器都调它们且都从 `providers.ts` 可达（`getModelTiers` 的档位反查因此只读 `process.env`）。两处易错点：档位以**别名**为键而请求里流的是**解析后的 id**，第三方 id 不含 `opus`/`sonnet` 字样，所以必须靠 `*_DEFAULT_<TIER>_MODEL` 反查（否则所有覆盖静默失效）；`[1m]` 闸门只对 Anthropic 模型成立，`supportsContextWindow()` 不得对第三方 id clamp。真源文档 `docs/zh/features/model-settings.md`。
- **DeepSeek 调优门控**：`src/utils/model/deepseekTuning.ts` 是全部 DeepSeek 专属行为的**唯一门控**（模型 id 含 `deepseek` **或** baseURL 指向 `api.deepseek.com`）。现有七项：未指定时 temperature 补 `0`（官方参数指南把代码/数学定为 0.0，而 DeepSeek 的隐式默认是 1.0；`DEEPSEEK_TEMPERATURE` 单项退出，thinking 模式下不发）、工具表截断到 128（官方硬上限，超出直接拒收）、thinking 模式下带 `tool_calls` 的 assistant 轮补 `reasoning_content: ''`（缺字段 DeepSeek 回 400；只保留已有 thinking 块不够，compact 改写过的历史会漏）、`thinking` 开关两个方向都显式发（DeepSeek 默认 `enabled`，只发开不发关等于 `OPENAI_ENABLE_THINKING=0` 无效）、`reasoning_effort` 按 low/high/max 三档折叠 occ 的五档且**未设置时默认 `max`**（梯子只有三级，从默认到顶只差一步；`/effort` 与 `CLAUDE_CODE_EFFORT_LEVEL` 仍优先，thinking 关闭时不发）、上下文窗口按 **1M** 算（V4 是 1M 族，200k 兜底会让 auto-compact 早触发 5 倍）。**依赖为零的那半边谓词在 `deepseekFamily.ts`**（`isDeepSeekFamilyModel` / `isDeepSeekBaseURL` / 窗口常量），`deepseekTuning.ts` 再导出 —— `session/context.ts` 直接引 tuning 会闭合一条 runtime 环。窗口那一项**只按模型名判定、不看 baseURL**：`getContextWindowForModel` 对所有 provider 都跑，残留的 `OPENAI_BASE_URL` 不该把 1M 发给 Anthropic 会话。新增 DeepSeek 差异化行为必须挂这个门控；**其他 OpenAI 兼容端点（GLM/Kimi/Qwen/MiMo/本地 vLLM）必须字节级不变**。
- **首启向导**：`Onboarding.tsx` 步骤为 theme → migrate（`MigrationStep`，检测 `~/.claude` 且未迁移过才出现）→ oauth（`ConsoleOAuthFlow`，登录方式菜单 + OAuth/ChatGPT/Antigravity/china preset 各流程）→ security → terminal-setup。china preset 选定模型会按 `parseContextWindowTokens` 自动写上下文键。
- **API-key 类 provider 的表单不在 ConsoleOAuthFlow 里**：OpenAI 两条线、Anthropic 兼容、Gemini、Grok 共用 `src/components/providerSetup/` 的两步向导（Step 1 端点 → `GET /models` → Step 2 选模型，拉不到就退回手填）。**各家差异只能加在 `specs.ts` 的表里**（env 键、默认 baseURL、校验、保存副作用、`hasEndpointStep`、`defaultModelField`、`presetModels`），组件里不要写 provider 分支。2.35.0 起 `OPENAI_MODEL` 不再压过档位别名（`resolveOpenAIModel` 把 `OPENAI_DEFAULT_<TIER>_MODEL` 排在它之上，显式 id 原样透传），所以 china preset 改为 `defaultModelField: 'required'` 并写 `OPENAI_MODEL` 作为 default 槽主模型。ChatGPT 订阅 / Antigravity 会话进向导走 `subscriptionAuth` 锁定模式（`credentialEditing: 'locked'`，只编辑模型/档位，凭据与 auth-mode 键一概不写）。`presetModels` 只给 occ 本来就维护表的两家（Anthropic 兼容 = Claude 全系、OpenAI = GPT 列表），且只对官方端点生效（`usesOfficialEndpoint`）；Gemini/Grok 故意留空，别去现编第三方 model id 表。不带参数的 `/model-settings`（`src/commands/model-settings/tierWizard.tsx`；`/models-setting` 是它的别名，两条命令 2.38 合并）从 env 重开模型步骤，判定逻辑在 `providerSetup/fromEnvironment.ts`；**没有可配置 provider 时退回该命令的文字面板**，不要退回「无可配置项」对话框。凭据此时还没落盘，所以探测走 `modelCatalog/fetchExplicit.ts`（读 env 的 `fetch.ts` 在这里用不了）；纯解析函数在 `modelCatalog/parse.ts`，两边共用。Max ctx 字段接受 `128000`/`128k`/`1m`（`providerSetup/maxContext.ts` 的 `parseMaxContextInput`，ConsoleOAuthFlow 仍再导出）。

## Testing

- 框架 `bun:test`；单测就近 `src/**/__tests__/`；集成测试 `tests/integration/`（9 个文件）。其中 **cli-golden**（子进程跑真 CLI，钉命令/flag 表面）和 **headless-ndjson**（钉 NDJSON 线格式）是 monolith 拆分的安全网——注意 headless-ndjson 钉的是 `StructuredIO`/schema 边界，**不执行** `runHeadlessStreaming`，是契约护栏而非代码路径护栏。
- system prompt 内容护栏在 `src/constants/promptEngineeringAudit.runner.ts`（行为锚点 + 已删内容反向断言 + 结构断言）；工具描述快照只钉 Bash/Agent/FileRead/FileEdit 四个（`promptCharacterization`，改后 `bun test <runner路径> -u` 并人工审读 snap diff）。

### Mock 使用规范

**只 mock 有副作用的依赖链，不 mock 纯函数/纯数据模块。** 必须 mock：`log.ts`、`debug.ts`（用共享 mock `tests/mocks/log.ts` / `tests/mocks/debug.ts`，不要内联）、`bun:bundle`、`settings/settings.js`、`config.ts`、`auth.ts`、第三方网络库。路径统一 `.ts` 扩展名 + `src/*` 别名，禁止双重 mock 同一模块。

#### 跨文件 mock 污染（process-global `mock.module`）

**Bun 的 `mock.module` 是进程全局的（last-write-wins），不是 per-file 隔离的。** 实测事实：执行顺序**不是**字母序；`beforeAll` 内调用不 hoist 但仍污染后续加载；`require`/`import` 共享注册表；一旦替换，同进程所有后续导入都拿到 mock，无论 specifier 写法。

**核心规则：不要 mock 被测模块的上层业务模块** —— mock 底层（如 axios，用 `tests/mocks/axios.js` 的 `setupAxiosMock`），否则会污染同目录需要测真实模块的回归测试（如 `api.test.ts`）。排查方法：单跑可疑文件→与同目录合跑定位→`console.error` 追执行顺序→核对 specifier 是否解析到同一模块。

**多文件共用模块必须用完整表面 mock**：`envUtils.js` 用 `tests/mocks/envUtils.ts` 的 `setupEnvUtilsMock(overrides)`，`growthbook.js` 用 `tests/mocks/growthbook.ts`，`settings/settings.js` 用 `tests/mocks/settings.ts`，其他模块用 `tests/mocks/sharedModuleMock.ts` 的 `makeSharedModuleMock` 就地包装。**禁止再手写部分表面的 `mock.module`**（只导出自己用到的几个函数）：进程全局 last-write-wins 下，后跑的文件会拿到缺导出（"Export not found"/undefined）或手抄后漂移的旧语义——这曾让 Linux CI 因文件顺序与 macOS 不同而红了一整批（envUtils 的手抄回退还停留在隔离前的 `~/.claude` 语义）。

**表面完整还不够，覆盖必须限定在本 suite 生命周期内**：`setup()` 在模块顶层装完整表面，`beforeAll` 里 `set()`，**`afterAll` 里 `reset()`**。少了 `reset()` 就等于把这条覆盖装给了本进程后续所有文件。两次真实事故都是这么来的：`src/utils/sandbox/__tests__/` spread 了真实模块（表面完整）却把 `getSettingsFilePathForSource` 永久钉成 `undefined`，`changeDetector.test.ts` 于是监听了错误目录；`MagicDocs/__tests__/prompts.test.ts` 套件结束后留下一个**手写**的 fs 适配器，缺 `mkdirSync` 等 `*Sync` 方法，`updateSettingsForSource` 抛错被吞，`pluginOperations.builtinSecurity.test.ts` 拿到 `success:false`。**能用模块自带的 setter（`setFsImplementation`/`setOriginalFsImplementation` 这类）就别用 `mock.module`。**

**Bun 的测试文件顺序由文件系统决定** —— 不是字母序，也**不是命令行参数顺序**（实测：显式传 `d c b a` 与传 `b d a c`，加载顺序完全一致）。所以这类问题在 macOS 上既无法复现也无法用参数强制，只能靠静态检查或真在 Linux 上跑。CI 从 v2.11.0 到 v2.30.0 连续 55 次全红就是这么攒出来的。

**mock 再导出 barrel 会穿透到底层包模块 —— 而且只在 Linux 上。** `src/Tool.ts` 是 `@open-claude-code/tool-runtime/Tool.js` 的纯再导出层；`mock.module('src/Tool.js', …)` 在 Linux 上**同时**替换了那个 package 模块，macOS 上不会。`agentToolUtils.test.ts` 因此把 `findToolByName` 变成 `() => {}` 喂给了整个 `packages/builtin-tools` 分片。**这类跨平台差异不要靠本地实验证伪**（macOS 上做同样的 preload 会得到"没影响"的相反结论），要么直接删 mock，要么在 CI 上打诊断拿真实数据。

**同一模块被两种扩展名 mock = 同一个 registry key 上的静默争夺。** 实测：用 `mock.module('x.js', …)` 注册，再 `import './x.ts'`，拿到的是那个 mock —— 两种拼写落在**同一条**记录上。所以两个文件各写各的部分表面、一个用 `.js` 一个用 `.ts`，读代码时像在动不同模块，实际是 last-write-wins 打架。这是这类 bug 里最难在 review 中看出来的形态，逐文件检查永远看不见。仓库统一用 **`.ts`**（真实文件都是 `.ts`），`check:mock-hygiene` 对此**零容忍、不设棘轮**。

**`bun run check:mock-hygiene` 守着这条规则**（也在 precheck 和 CI 里），查两类：仓库内模块的内联 `mock.module('src/…', () => ({ … }))`（必须走 `tests/mocks/` helper；`bun:bundle`/`axios`/`node:*` 豁免），以及顶层 `setup({…})` 却全文件没有 `.reset()`。存量已清零（241 → 0），预算文件现在是空的，四条规则实际都是硬零；双向棘轮机制保留，防止回潮。**加 mock 前先想想能不能不加** —— 那 241 处里约三分之一根本不该存在（纯常量模块、纯谓词、把整个模块抹平的 `() => ({})` 空表面，还有两处 specifier 指向的路径根本不存在）。先试 `bun test <该目录>` 不带 mock 跑一遍，再决定。

## Working with This Codebase

- 改 system prompt、工具定义、CLAUDE.md 或 skill 前，先读 `dev-standards` skill —— 那里是这些取舍的依据（源自 Anthropic 对 Claude 5 代模型的官方指导），本文件不重复。
- **precheck 必须零错误**；pre-commit hook（husky + lint-staged）会对暂存文件跑 biome。
- **循环依赖棘轮 `bun run check:cycles` 双向严格**（超预算与**低于**预算都 fail）。处理方式见 `CONTRIBUTING.md` §9。工作流规范（提交/PR/文档放哪/`.claude/` 与 `.occ/` 双目录政策）也在 CONTRIBUTING。
- **Biome**：42 条规则因 decompiled 代码关闭；`.tsx` 120 列 + 强制分号，其他 80 列。tsc 要求声明属性但 biome 报 `noUnusedPrivateClassMembers` 时，用 `// biome-ignore lint/correctness/noUnusedPrivateClassMembers: <原因>`。
- **`@ts-expect-error`**：directive 变 unused（TS2578）直接删；MACRO 替换产生的永假比较（如 `'production' === 'development'`）仍需保留。
- 生产代码禁止 `as any`（测试 mock 可用）；优先 `as unknown as T` 双重断言或补 interface。
- `src/*` path alias 有效（tsconfig 映射）。
- 设计 Web UI 时参考 `.impeccable.md`（Impeccable 设计上下文：品牌色 Claude Orange `#D77757`、Anthropic 式干净排版）。

## 发布（npm / GitHub Release）

- **npm 包名是 `@sweetcornna/open-claude-code`**（无 scope 的 `open-claude-code` 被第三方 0.0.0 占位包抢注，publish 会 403）。包名同时钉在 `package.json`、`src/constants/brand.ts` 的 `NPM_PACKAGE_NAME`（`updateIsolation.test.ts` 断言）、`scripts/install.sh`、README、`docs/zh/auto-updater.md`——改名五处必须同步。bin 名（`occ`/`occ-bun`/`open-claude-code`）与包名无关，不要动。
- 发布流程：`bun run release <version>`（`scripts/release.ts`，纯逻辑在 `scripts/releaseCore.ts` 并有单测）改齐 `package.json` + `CHANGELOG.md`、跑门禁、提交并打 tag，**故意停在 push 之前**；`git push origin main --follow-tags` 才触发 `publish-npm.yml`：typecheck → prompt-purity + mock-hygiene 棘轮 → 全量单测（分片）→ build:vite + check:bundle + 双入口 `--version` 冒烟 → `npm publish --provenance` → GitHub Release。步骤与版本源清单见 `CONTRIBUTING.md` §11。
- **publish 门禁现在跑全量单测**（2026-08-07 起，此前只跑集成测试）。挡了很久的那个理由——Linux runner 上的顺序性 mock/env 污染——已经不存在了：分片 + 两处泄漏修复 + mock 卫生棘轮清零，ci.yml 连续 11 次全绿。
- **跑的是分片循环 `scripts/test-shards.sh`，不是 `bun test`。** 这不是风格选择：按目录分片硬隔离了跨目录的 mock 状态，那才是终结 55 次连红的原因；不分片的整体运行是**另一种执行模式**，从没在 Linux runner 上验证过。往会卡住发布的门禁里塞一个未验证的模式是净亏损。同一个脚本被 `ci.yml`、`publish-npm.yml` 和 `bun run release` 三处共用，避免漂移。`tests/integration` 是其中一个分片，所以 cli-golden / headless-ndjson 那两道发布面契约照旧覆盖。
- 版本号延续 2.8.x 叙事（首个对外发布是 v2.9.0），**不要回退到 1.x**，也不要发不递增的版本——`occ update` 的 semver 比较会把老用户永远锁在"已是最新"（release 脚本对此有硬校验）。
- **`CHANGELOG.md` 是用户可见面**：GitHub Release 正文与应用内「更新说明」都读它（后者由 `src/utils/update/releaseNotes.ts` 从本仓库 main 分支拉原始文件，**不是**上游 anthropics/claude-code）。格式受 `parseChangelog` 约束：`## <semver>` 标题 + 顶层 `- ` 条目，写坏了不报错、只是条目静默消失。release 脚本插入的是 commit subject 草稿，必须人工润色。
