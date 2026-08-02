# 四项任务架构方案（2026-08-02）

> 依据四路并行调研产出：本仓库四域审计、claude-code-yasasbanuka / claude-code-official 对比、
> 《The new rules of context engineering for Claude 5 generation models》精读、
> cc-switch / Codex OAuth / OpenAI Responses API 协议调研。
> 本文是架构与实施顺序的唯一汇总；实施时按里程碑逐条落地，每个里程碑 `bun run precheck` 必须零错误。

## 0. 调研关键结论（影响架构方向的事实）

1. **Responses 适配器已存在**：`src/services/api/openai/responsesAdapter.ts`（511 行）已实现
   Responses SSE → Anthropic 事件映射，但端点写死 `chatgpt.com/backend-api/codex/responses`，
   唯一触发条件 `OPENAI_AUTH_MODE === 'chatgpt'`。任务二＝把它通用化，不是从零写。
2. **Codex OAuth（ChatGPT 登录）已存在**：`src/services/api/openai/chatgptAuth.ts`（device-code 流，
   token 落 `~/.occ/openai-chatgpt-auth.json`，可回退读 `$CODEX_HOME/auth.json`）。
   任务三的 OAuth 半边是补强（刷新策略对齐、登录后选模型），不是新建。
3. **启动 provider 选择 UI 已存在**：`ConsoleOAuthFlow.tsx` 8 项菜单 + Onboarding oauth 步。
   任务三的核心增量是 cc-switch 式「多配置档案 + 单一激活」与可见性/安全性补漏。
4. **MCP 2026-07-28 协商已就绪未启用**：门控点全仓仅 `clientFactory.ts:50` 一处，
   `scripts/defines.ts` 里 `'MCP_2026'` 处于注释状态，17 个测试就绪。
   真正的功能空白是 `sampling/createMessage`（含 augmented tool calls）；`tasks/*` 被 SDK
   明确标注无 runtime（记录为受阻，不做）。
5. **yasasbanuka（≈官方 2.1.90-94）旧于本项目（≥2.1.111）**，整体质量更差
   （803KB 单体 main.tsx、utils 329 文件平铺、零测试）。它对本项目的真实增量只有：
   `services/teamMemorySync/`（含 secretScanner）、若干「为什么存在」的依赖图注释、
   纯 TS yoga/color-diff 回退实现。
   **否决**对比报告中「移植 src/bridge/ 与 src/server/」的建议 —— 与本仓库 2026-07
   刻意删除 bridge（约 45k 行、远程控制委托 Happy）及 DIRECT_CONNECT 移除的决策直接冲突。
6. **claude-code-official（CHANGELOG 至 2.1.220）** 对照出一批缺失功能（见任务一 1C 红表）；
   `plugins/plugin-dev`、`examples/settings/*.json`、`examples/hooks` 是 plugin/hook/设置
   契约的权威验收材料。

---

## 任务一：参考项目 + Claude 5 上下文工程规则，提升项目质量

### 1A. 上下文工程改造（对照博客六规则）

博客核心：Anthropic 给 5 代模型删掉 Claude Code system prompt 的 80%+，评测无损
（"unhobbling"）。本项目现有机制与 Rule 3（渐进披露：SearchExtraTools 延迟加载、
attachment 编排、skill 搜索）和缓存工程（静态/动态边界、`DANGEROUS_uncached` 强制理由）
已高度一致，**不动**。改造集中在：

| # | 规则 | 落点 | 动作 |
|---|---|---|---|
| 1 | judgement over rules | `src/constants/prompts.ts`（862 行） | 审计静态前缀各 section：删除硬禁令/冲突成对指令/防御性规则，保留「匹配周围环境」式原则。**每删一段必须过 golden 测试 + 人工 A/B**，不盲删。注意 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 不可动 |
| 2 | interfaces over examples | `packages/builtin-tools/src/tools/*/prompt.ts` | 逐工具审计 description 中的 "Example:" 段；能由参数 schema 自解释的删除示例，token 预算转投参数 description/enum |
| 4 | 指令唯一归属 | prompts.ts × tool prompts × CLAUDE.md | 全局去重扫描：同一指令出现两处的，删 system prompt 侧。产出一份归属表（工具用法→tool description；项目约定→CLAUDE.md；产品行为→system prompt） |
| 5 | auto-memory | `src/memdir/` | 已有 memdir 双轨（静态 CLAUDE.md + 动态 memdir），核对 EXTRACT_MEMORIES 路径的写入判定与去重/淘汰即可，预计小改 |
| 6 | rich references | plan mode / 子代理 prompt | 计划产物强调「关键文件路径+现有代码引用」；子代理传参照文件路径而非转述。改 `EnterPlanMode`/Agent prompt 措辞，小改 |
| — | 工具化 | `/doctor` | 远期：加「prompt 冗余扫描」诊断项（对齐官方 2.1.205 的 /doctor 全面体检方向），本轮不做 |

风险控制：system prompt 是行为面，任何删减分小步提交，`tests/integration/cli-golden`
与 `headless-ndjson` 是安全网；必要时新增快照测试钉住 section 组装顺序。

### 1B. 从 yasasbanuka 移植（小额）

- `services/teamMemorySync/`（watcher + secretScanner + teamMemSecretGuard）→ 评估后
  以 feature flag 引入；`secretScanner.ts` 单独可先抄进 memdir 写路径做泄漏防护。
- 恢复 monorepo 抽取时丢失的「为什么存在」注释（如 `src/services/api/emptyUsage.ts`
  的防依赖爆炸理由）—— 在 shim 层补回原注释。
- 不学：单体 main.tsx、平铺 utils、零测试。

### 1C. 从官方 CHANGELOG 补齐（按成本排序，红表节选）

低成本单点（env/设置项类，每个≈1 文件）：
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`(默认3)、`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`(20)、
`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`(200)、`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`(200)、
`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`(MCP 调用超 2min 自动转后台)、MCP 每服务器
`request_timeout_ms`、`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`、`FORCE_HYPERLINK=0`、
`sandbox.filesystem.disabled`、`workflowSizeGuideline`。
中成本：`DirectoryAdded` hook、`occ mcp login/logout --no-browser`、
屏幕阅读器模式 `--ax-screen-reader`、emoji shortcode 补全、headless init 事件
`mcp_server_errors`。
行为修正对照（bug 预防）：权限规则 `dir/**` 单段语义收紧(2.1.214)、权限匹配器预编译
缓存(2.1.208)、消息规范化二次方增长(2.1.216 修复)、MCP stdio stderr 64MB 上限等
2.1.208 内存修复清单。
契约资产：`plugins/plugin-dev` 的 7 个 SKILL.md 作为 plugin/skill/hook frontmatter
验收标准；`examples/settings/*.json` 直接改造成配置解析测试夹具。

---

## 任务二：OpenAI 兼容端点 + Responses 协议通用化

### 现状缺口（审计结论）

- 端点写死 ChatGPT 私有后端，无 `/v1/responses` 通用路径；触发条件绑死 chatgpt 认证。
- 请求体缺 `max_output_tokens`（算好的值被丢弃）、`include: ["reasoning.encrypted_content"]`、
  `strict` 硬编码 false、无 `previous_response_id`。
- 事件覆盖缺 `response.reasoning_summary_text.delta`、`response.content_part.added/done`、
  `response.refusal.delta`、reasoning/message 类型的 `output_item.added`。
- 消息经「Anthropic → Chat Completions → Responses input」二次有损转换（thinking/签名丢失）。
- `DEFAULT_MODEL_MAP` 停留在 gpt-4o/o3；与 `chatgptModels.ts`（gpt-5.6 家族）两套解析不通。

### 设计

1. **协议选择抽象**（`src/services/api/openai/` 内新增 `wireProtocol.ts`）：
   `resolveOpenAIWireProtocol(): 'chat' | 'responses'`，判定优先级
   `OPENAI_WIRE_API`（`chat`/`responses` 显式指定）＞ ChatGPT auth（强制 responses）＞
   默认 `chat`。settings 侧配套 provider 档案的 `wireApi` 字段（任务三）。
2. **端点派生**：`responsesAdapter.ts` 的 URL 构造改为三态 ——
   ChatGPT auth → `https://chatgpt.com/backend-api/codex/responses`（保留现状与指纹头）；
   否则 → `${OPENAI_BASE_URL 去尾斜杠}/responses`（`OPENAI_BASE_URL` 已含 `/v1` 的约定
   与 Chat 路径一致）。请求头按模式分组：ChatGPT 模式带 `ChatGPT-Account-ID`/`originator`；
   API key 模式只带 `Authorization: Bearer`。
3. **请求体补全**：`max_output_tokens`（复用 `resolveOpenAIMaxTokens()`）；
   `include: ["reasoning.encrypted_content"]`（有 reasoning 时）；`store` 保持 false；
   `strict` 跟随工具 schema 是否可严格化；`reasoning.effort` 沿用现有
   `CLAUDE_CODE_EFFORT_LEVEL` 映射。
4. **直转路径**：新增 `convertAnthropicToResponsesInput()`，从 Anthropic 消息直接构造
   `input[]` item（system→instructions、user/assistant→message item、tool_use→function_call、
   tool_result→function_call_output、thinking(带 encrypted_content 存根)→reasoning item），
   替换现有二次转换。**回放纪律**：item type/id/call_id 一字不差（Codex 官方迁移文档：
   "Incomplete replay can silently reduce quality or break tool continuation"）。
   encrypted_content 存进内部 thinking block 的 signature 位（同 Anthropic 语义），下轮原样回放。
5. **事件覆盖补全**（映射表）：
   `reasoning_summary_text.delta` → `thinking_delta`；`content_part.added/done` → 用作块边界
   校验；`refusal.delta` → text 块（前缀标记）；`output_item.added(reasoning/message)` →
   对应 `content_block_start`；`output_item.done(reasoning)` 收 `encrypted_content`。
   维护 `item_id → {blockIndex, call_id}` 映射（arguments delta 不带 call_id）。
   `response.completed` 的完整 output 做终态校验兜底。
6. **模型映射统一**：更新 `DEFAULT_MODEL_MAP` 到当前模型代；`resolveOpenAIModel()` 与
   `resolveChatGPTCodexModelForTier()` 合并入口，按 wireProtocol+auth 分派。
   thinking 自动检测名单扩充（qwen/glm/kimi 等）。
7. **测试**：`responsesAdapter.test.ts` 扩展 —— 通用端点 URL/头矩阵、事件全集夹具
   （含 reasoning summary、多 item 交错）、回放往返（function_call→function_call_output）、
   max_output_tokens 断言反转。golden/headless 不受影响（内部事件格式不变）。

改动集中：`responsesAdapter.ts`、`openai/index.ts:354/373-388`、`wireProtocol.ts`(新)、
`modelMapping.ts`、`chatgptModels.ts`、测试。下游零改动（流适配器模式不变）。

---

## 任务三：启动 API/端点设定 + Claude/Codex 双 OAuth（参考 cc-switch）

### 借鉴 cc-switch 的三个设计

1. **档案模型**：provider 档案不给 baseUrl/apiKey 一等字段，而是存「落地配置的形状」
   （settingsConfig）+ 三个正交维度：`apiFormat`（anthropic/openai_chat/openai_responses/
   gemini）、`apiKeyField`、`providerType`（可选 oauth 类型）。
2. **单一激活 + 原子切换**：每次只有一个激活档案；切换 = 原子写（tmp+rename，已有
   settings 写入路径复用）；编辑激活档案前从 live 配置回填，避免外部修改丢失。
3. **最小侵入**：卸载/禁用档案系统后，settings.json 仍是自洽可用的普通配置。

### 设计

1. **档案存储**（新增 `src/services/providerProfiles/`）：
   `~/.occ/provider-profiles.json`：`{ profiles: {id → {name, apiFormat, wireApi?,
   settingsEnv, modelType, notes?, createdAt}}, active: id }`。
   **凭据不入档案文件**：API key 存 secureStorage（keychain/.credentials.json 0600），
   档案里只留 `credentialRef`。这是对审计缺口「第三方 key 全明文进 settings.env」的修复，
   也优于 cc-switch 的明文姿势。
   切换动作 = 把档案的 settingsEnv 写入 settings.json `env` + `modelType`，从
   secureStorage 取 key 注入对应字段；Claude OAuth 档案 = 清空 env 覆盖（对齐 cc-switch
   官方 preset `{"env":{}}` 语义）。
2. **启动/登录 UI**：
   - `getAuthStatus()` 增加第三方面：当前 provider/baseURL/模型/wireApi 在 `/login`
     首屏可见（修复「用户看不到自己连的是谁」）。
   - `ConsoleOAuthFlow` 菜单增加：Grok 条目（缺席修复）、「已保存档案」二级菜单
     （列出 profiles，选择即切换）、「保存当前为档案」。
   - ChatGPT 登录成功后加模型选择步（列 `CHATGPT_CODEX_MODELS_BY_TIER`）。
   - Onboarding oauth 步复用同一组件，天然获得以上能力。
3. **Codex OAuth 补强**（`chatgptAuth.ts`）：
   - 现有 device-code 流保留（无浏览器/SSH 场景）；新增 authorization-code + PKCE 浏览器流
     （`auth.openai.com/oauth/authorize`，client_id `app_EMoamEEZ73f0CkXaXp7hrann`，
     回调 `localhost:1455/auth/callback`，备用 1457；复用 `src/services/oauth/` 的
     PKCE/listener 基建）。
   - 刷新策略对齐 codex-rs：access_token JWT `exp` 距今 ≤5min 或 `last_refresh` 超 8 天
     即刷；`POST /oauth/token` JSON body `{client_id, grant_type:"refresh_token",
     refresh_token}`，三字段选择性写回。
   - `ChatGPT-Account-ID` 从 id_token 的 `https://api.openai.com/auth` 命名空间
     `chatgpt_account_id` claim 解出（现实现核对）。
4. **登出补全**：`logout.tsx` 清理矩阵 —— 按当前 modelType/档案清对应凭据
   （OPENAI_API_KEY、chatgpt auth 文件、GEMINI/GROK key），不再只清 `OPENAI_AUTH_MODE`。
5. **CLI 直达**：`occ --provider <profileId>`（会话级覆盖不落盘）与
   `occ provider use/save/list <id>` 子命令（落盘切换）。

依赖：`wireApi` 字段消费依赖任务二的 `resolveOpenAIWireProtocol`。

---

## 任务四：MCP 协议更新至 2026-07-28

### M4.1 启用协商（本次落地）

- `scripts/defines.ts`：`'MCP_2026'` 取消注释 → dev/build 默认 34 个 feature。
  文档自述"Flipping the comment below is the whole rollout"，门控点仅
  `clientFactory.ts:50` 一处，回滚 = 重新注释。
- 代价（已评估，接受）：每 connect 一次 `server/discover` 探测往返；stdio transport
  多一个短命探测子进程。era 是连接属性，`getProtocolEra()` 消费面不变。
- 同步文档：`docs/features/mcp-2026.md` §2/§3 状态表改为默认开；§6.3 过时项修正
  （rounds-exceeded 降级已由 `00c2db80` 实现：`inputRequiredDegradation.ts` 接线于
  `client.ts:3320`）。CLAUDE.md feature 列表同步。
- 验证：`bun test src/services/mcp`（negotiationMatrix 等 17 件）+ precheck。

### M4.2 sampling/createMessage（最大功能空白，2026 的 augmented tool calls 载体）

- `src/services/mcp/samplingHandler.ts`(新)：client capabilities 增声
  `sampling: {}`；`setRequestHandler('sampling/createMessage')` →
  权限门（每 server 首次询问，复用 MCP 工具权限 UI 语义）→ 走 `query()` 精简管道
  （无工具或按 `CreateMessageResultWithTools` 允许工具）→ 回 `CreateMessageResult`。
  上限与超时必须有（防 server 滥用配额）。
- augmented tool calls：结果带 tool calls 时按 2026 语义回传，MRTR 轮次计数复用
  `mrtrRounds.ts`。

### M4.3 收尾清单

- serve 端 capabilities 补 `prompts/resources`（`src/entrypoints/mcp.ts:93` 现仅 tools；
  `:100` 有 TODO）；icons 元数据消费（工具列表 UI 展示）择机。
- `subscriptions/listen`、分布式追踪 meta（`TRACEPARENT_META_KEY` 透传）列为观察项。
- v1 SDK 退役按文档 §9.3 四步走（OAuth 搬 v2 → WebSocket 解析器 → v1 降 devDeps →
  双时代测试），独立小 PR 串行推进。
- `tasks/*`：SDK 无 typed runtime（"no SDK runtime" 免责声明），**记录为受阻不做**，
  不绕类型层硬上。
- `packages/mcp-client` 平行实现：按既有决策不统一；若接线需先移植降级网。

---

## 实施顺序

| 里程碑 | 内容 | 状态 |
|---|---|---|
| A | M4.1 MCP_2026 默认启用 + 文档同步 | **✅ 2026-08-02 完成**（precheck 绿） |
| B | 任务二核心（Responses 通用化） | **✅ 2026-08-02 核心完成**（见下） |
| C | 任务三档案模型 + UI + Codex OAuth 补强 | **✅ 核心完成**（见下） |
| D | M4.2 sampling + M4.3 收尾 | **✅ sampling 完成**（opt-in） |
| E | 任务一 1A prompt 审计（小步多提交）+ 1C 低成本红表 | 部分（web search 会话上限已做） |
| F | 1B teamMemorySync 评估移植 | 最后 |

**里程碑 C 已落地**：`src/services/providerProfiles/`（档案数据层 profiles.ts + 激活编排
activate.ts：全形状写入、原子写 0600、`/provider save|use|list|delete` 子命令）；
`/login` 首屏新增只读 Active provider 面（provider/baseURL/wireApi/ChatGPT 认证/激活档案，
fail-soft）；Codex OAuth 刷新对齐 codex-rs（8 天陈旧强制刷 + 响应三字段可选 + 陈旧刷新失败
不阻塞请求）；logout 补 OpenAI/Grok 客户端缓存清理。
**里程碑 C 剩余**：ConsoleOAuthFlow 的 Grok 菜单项、ChatGPT 登录后模型选择步、
authorization-code+PKCE 浏览器流（现只有 device-code）、档案二级菜单 UI、
凭据入 secureStorage（档案文件目前 0600 明文，与 settings.env 同姿势）。

**里程碑 D 已落地**：`src/services/mcp/samplingHandler.ts` —— `OCC_MCP_SAMPLING=1` opt-in
时 advertise `sampling` capability 并处理 `sampling/createMessage`（sideQuery 走小模型、
maxTokens clamp 4096、每会话 100 次上限、文本 only）。见 mcp-2026.md §6.5。
**里程碑 D 剩余**：augmented tool calls（CreateMessageResultWithTools）、逐请求审批 UI、
serve 端 prompts/resources capability、v1 SDK 退役四步。

**里程碑 E 已落地**：`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`（默认 200，
WebSearchTool/sessionLimit.ts）。
**里程碑 E 剩余**：subagent 深度/并发上限（AgentTool 无现成深度概念，需新机制，
比红表预估重）、MCP_AUTO_BACKGROUND_MS、request_timeout_ms、prompt 冗余审计（1A 全部）。

**里程碑 B 已落地**：`wireProtocol.ts`（`OPENAI_WIRE_API=responses|chat` 显式选择，
ChatGPT auth 强制 responses）、`createOpenAIResponsesStream()`（`<OPENAI_BASE_URL>/responses`
通用端点，标准头，无 ChatGPT 指纹头）、`buildResponsesRequest` 增 `max_output_tokens`
（仅通用路线，ChatGPT 后端拒收）与可选 `prompt_cache_key`（仅官方端点）、事件覆盖补
`reasoning_summary_text.delta`（→thinking）与 `refusal.delta`（→可见文本）、
`DEFAULT_MODEL_MAP` 改为按家族映射到 gpt-5.6-sol/terra/luna（与 chatgptModels.ts 同步维护）。
**里程碑 B 剩余**（后续轮）：直转路径 `convertAnthropicToResponsesInput()` 消除二次有损转换、
`include: reasoning.encrypted_content` + 加密推理回放、`strict` 模式、模型解析双入口合并、
`previous_response_id`。

每里程碑独立可交付、precheck 零错误、Conventional Commits 分主题提交。
