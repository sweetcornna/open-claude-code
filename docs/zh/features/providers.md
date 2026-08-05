# 多模型 / 多协议配置（GPT · GLM · Kimi · DeepSeek · Gemini · Grok）

occ 不只连 Claude：任何 OpenAI 兼容端点、Gemini 原生 API、Grok、以及自建的 Anthropic 兼容服务都能当主力模型用。实现方式是流适配器——第三方 API 的请求/响应在边界处转成内部 Anthropic 格式，工具调用、流式输出、上下文管理等所有下游逻辑零改动。

**大多数人不需要读完本文**：首次运行 `occ` 的向导（或之后的 `/login`）会引导你选供应商、填 key 和模型，国产模型还有现成 preset。本文是给需要手动调环境变量、写脚本或排查问题的人准备的配置真源。

## 一、选择 provider

优先级：`settings.modelType`（`/login` 或向导写入）> `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,OPENAI,GEMINI,GROK}` 环境变量 > 默认 Anthropic 一方 API。判定入口 `src/utils/model/providers.ts`。

## 二、各 provider 环境变量矩阵

| Provider | 启用 | Key | Base URL | 模型 | 输出上限 |
|---|---|---|---|---|---|
| OpenAI 兼容（GPT/GLM/Kimi/DeepSeek/Ollama/vLLM/One API…） | `modelType:'openai'` 或 `CLAUDE_CODE_USE_OPENAI=1` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `OPENAI_MODEL`（最高优先级，透传）或 `OPENAI_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` 三档 | `OPENAI_MAX_TOKENS` |
| ChatGPT 订阅 | 同上 + `OPENAI_AUTH_MODE=chatgpt` | 设备码 OAuth | Codex 专有后端 | tier 常量（sol/terra/luna） | 不发（Codex 不收） |
| Gemini 原生 | `modelType:'gemini'` 或 `CLAUDE_CODE_USE_GEMINI=1` | `GEMINI_API_KEY` | `GEMINI_BASE_URL`（默认官方） | `GEMINI_MODEL` 或三档（**必须配一种**，无内置默认） | `GEMINI_MAX_TOKENS`（或通用 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，opt-in） |
| Grok | `modelType:'grok'` 或 `CLAUDE_CODE_USE_GROK=1` | `GROK_API_KEY`/`XAI_API_KEY` | `GROK_BASE_URL`（默认 api.x.ai/v1） | `GROK_MODEL` 或映射表 | `GROK_MAX_TOKENS`（同上，opt-in） |
| Anthropic 兼容端点 | `modelType:'anthropic'` + baseURL | `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL` | `ANTHROPIC_MODEL` 或三档 | （Anthropic 路径原生管理） |

国产模型（DeepSeek / 智谱 GLM / 千问 / MiMo）走 OpenAI 兼容矩阵；`/login → China LLM Providers` 有内置 preset（baseURL、模型表、Coding Plan 专用端点），选择后自动写入以上键**并按 preset 的上下文窗口自动写 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`**。

## 三、协议（wire API）

OpenAI 家族有两条线：`OPENAI_WIRE_API=chat`（默认，Chat Completions，打 `<base>/chat/completions`）或 `responses`（Responses API，打 `<base>/responses`）。`OPENAI_AUTH_MODE=chatgpt` 强制 responses；Codex 家族模型（id 含 `codex`、GPT-5 世代）在未显式指定时也默认 responses。

**协议在登录菜单里选，不是表单里的一个字段**：`/login` 有两个并列入口 —— **OpenAI Chat Completions** 与 **OpenAI Responses API**，选哪个就把 `OPENAI_WIRE_API` 写成哪个，后续表单只填 Base URL / API Key / 模型。这样命名是因为"OpenAI 兼容"只描述了 chat 那条线，把 responses 塞进同一个表单会让人以为它也是"兼容"模式。

选定的协议对**整条链路**生效：主循环、side query（分类器、标题生成、模型校验等）、WebSearch 的 codex 源共用同一套解析（`resolveOpenAIWireProtocol`）。曾经只有主循环认这个键，side query 一律走 Chat Completions，只支持 `/responses` 的上游会直接拒掉那部分请求。

## 四、模型名解析

- 任意模型名（`glm-4.6`、`kimi-k2`、`deepseek-v4-pro`、`gpt-5.2`、`gemini-3-pro`）**都可透传**：设 `OPENAI_MODEL` 等单一模型键最直接；或设 `ANTHROPIC_MODEL`/`settings.model`（不含 haiku/sonnet/opus 子串的名字原样透传）。
- 含家族子串的名字按 `{PROVIDER}_DEFAULT_{FAMILY}_MODEL` → 内置家族表映射（映射逻辑在 `packages/@ant/model-provider/.../modelMapping.ts`）。

## 五、最大上下文（关键）

**`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** 是模型上下文窗口的用户覆盖，优先于一切自动探测。非 Anthropic 模型探测不到真实窗口时按 200k 兜底——128k 的模型会在 auto-compact 触发前就被端点以 prompt-too-long 拒掉，1M 的模型会浪费 80% 窗口并过早 compact。设置它之后**全链路生效**：

- auto-compact 阈值（窗口 − 20k 输出预留 − 13k 缓冲）与预测式 compact —— 即"靠近阈值触发 compact"
- 硬阻断线、statusline 的 `ctx:%`、`/context` 显示

配置面：首启向导 / `/login` 各表单的 **Max ctx** 字段（接受 `128000` / `128k` / `1m`）、china preset 自动写入、`/provider` 档案随家族切换、或直接设环境变量。

**按模型开启 1M 后缀**：`CLAUDE_CODE_1M_CONTEXT_MODELS`（逗号分隔模型名/子串，大小写不敏感）。主循环模型解析后命中即自动追加 `[1m]` 后缀，等价于手选 `sonnet[1m]`——走完整的后缀链路（1M 窗口 **+ 1M beta 头**），适用于支持 1M 上下文的 Anthropic 系模型；已带后缀的模型不重复追加。第三方模型只需要窗口数值时，用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 即可，无需该开关。

## 五点五、Prompt 缓存（各家的命中率从哪来）

各 provider 的缓存都是**前缀命中**：请求的前缀与上一轮完全一致才算命中。所以任何让前缀发生位移或改写的东西（工具表变动、system prompt 动态段变化、把上一轮的响应换个形状发回去）都会把整轮打成 miss。

| Provider | 机制 | occ 的处理 |
| --- | --- | --- |
| Anthropic | 显式 `cache_control` 断点 | system 块 + 单个消息断点；TTL 见 [system-prompt.mdx](../context/system-prompt.mdx) 的 `should1hCacheTTL` 一节（含 `CLAUDE_CODE_PROMPT_CACHING_1H`） |
| OpenAI Chat Completions | 自动前缀缓存 + `prompt_cache_key` 粘性路由 | 会话级稳定 key `occ:<sessionId>`，默认只发官方端点 |
| OpenAI Responses / Codex | 同上 + reasoning 回放 | key 恒发；reasoning 见下 |
| Gemini | 隐式缓存 | `promptTokenCount` 含缓存前缀，统计时须扣除（`normalizeGeminiUsage`） |
| Grok (xAI) | 自动前缀缓存 | 无需额外参数 |

### 实测：什么真的影响命中率

对一个 OpenAI 兼容网关跑的对照实验（`gpt-5.3-codex-spark`，5 轮，~4K token 稳定前缀，每次只改一个变量）：

| 场景 | 累计命中率 | 逐轮 |
| --- | --- | --- |
| 发 `prompt_cache_key` | **75.8%** | 0 / 93 / 94 / 96 / 91 |
| 不发 `prompt_cache_key` | **18.3%** | 95 / 0 / 0 / 0 / 0 |
| 每轮改动一个 tool description | **0.0%** | 0 / 0 / 0 / 0 / 0 |
| 每轮改动 system prompt 尾部 | 88.5% | 92 / 90 / 89 / 87 / 85 |

两条结论：

1. **粘性路由键是最大的杠杆。** 没有 `prompt_cache_key`，只有第一次追问命中，之后每轮都落到不同的缓存节点。这就是"缓存率特别低"的典型形态。
2. **工具表变动是唯一的一票否决。** 改一个 tool description 就是全表 miss —— 工具数组排在最前面。occ 因此刻意不把延迟加载的工具放进请求（见 `queryModelOpenAI` 里的 filter 注释），MCP 中途连接也走 delta attachment 而不是重算 system prompt。system prompt 尾部漂移反而没那么致命。

**`OPENAI_PROMPT_CACHE_KEY`**：默认规则按协议分开——

- `/responses`：**总是发**。能提供这个端点就意味着实现了 Responses schema，`prompt_cache_key` 是其中的标准字段。
- Chat Completions：只发给官方 `api.openai.com`。会 400 拒收未知顶层字段的严格端点（GLM / Kimi / DeepSeek / Cerebras 直连）都在 chat 这条线上，而它们并不提供 `/responses`。

把 OpenAI 挂在 chat 网关后面（LiteLLM / one-api / new-api / OpenRouter）时用 `OPENAI_PROMPT_CACHE_KEY=1` 强制开启；`=0` 强制关闭，用于会把未知键透传给上游、而上游拒收的网关。

**Responses / Codex 的 reasoning 回放**：推理模型走 `/responses` 且 `store: false` 时服务端不留状态，第 N 轮的 reasoning item 不回放就彻底丢失。occ 的做法是请求带 `include: ["reasoning.encrypted_content"]`，从 `response.output_item.done` 抓取后按 `_openaiReasoningItems` 挂在该轮 assistant 消息上（消息级而非内容块级——中途切模型时消息级附加字段会被丢弃，块级会跟着发给别的 provider），下一轮在该 assistant 轮最前面按原顺序回放；assistant 文本按 `{type:'message', content:[{type:'output_text'}]}` 回放而不是裸 `{role, content}`（后者归一成 `input_text`，等于告诉模型它自己上一轮的回答是用户输入）。

**这是保真修复，不是缓存修复**：同样的对照实验（6 轮，开/关回放）两边命中率都是 80.9%——OpenAI 的前缀缓存是拿客户端**自己上一次的请求**去匹配的，一个始终不回放的客户端也能和自己接上。回放买到的是模型在工具调用轮之间不用重新推导意图。

这条链路只在 `OPENAI_WIRE_API=responses` 时启用，Chat Completions 的消息体不会出现这个字段（严格端点会拒未知键）。

## 五点六、GPT 调优（仅 openai provider + GPT 家族模型生效）

接 GPT 模型时（`modelType:'openai'` 且解析后的模型 id 以 `gpt-` 开头或含 `codex`；Claude 别名如 `/model opus` 会先经模型映射再判定），occ 参照 OpenAI Codex CLI 做三层收敛。**Anthropic 路径与 openai 层跑非 GPT 模型（DeepSeek/GLM 等）完全不受影响。**

**行为提示词**：system prompt 末尾追加一段 GPT 执行纪律 overlay（少计划、不自审、不派审查子代理、压缩最终回复）；`EnterPlanMode`/`Agent` 工具描述与 plan mode 指令切换到克制版文案——针对 GPT 把"鼓励计划/鼓励子代理"条款当硬性命令执行的问题。

**请求参数默认值**（用户显式设置永远优先）：

- reasoning effort：未设置时 `gpt-5.6-sol` 默认 `low`（对齐 codex："Sol is highly capable at lower reasoning efforts"），其余 GPT 模型默认 `medium`。用 `CLAUDE_CODE_EFFORT_LEVEL` 或 `/model` 的 effort 档覆盖。
- `text.verbosity`：responses 线对 GPT 模型默认发 `low`（ChatGPT OAuth 路由与官方 baseURL；第三方网关默认不发）。`OPENAI_VERBOSITY=low|medium|high` 强制指定并对任意端点放行，`=off` 强制不发。
- 内部分类器（side query）对 GPT 模型显式用 `low` effort，不再落到服务端默认 medium。

**网络层**（responses 线此前是裸 fetch，无超时无重试）：

- 建流重试：指数退避（200ms 起步、2 倍增长、±10% 抖动、尊重 `Retry-After`），对网络错误/5xx/408/带 `Retry-After` 的 429 重试，默认 4 次，`OPENAI_REQUEST_MAX_RETRIES` 覆盖。
- 空闲看门狗：复用 `CLAUDE_STREAM_IDLE_TIMEOUT_MS`（默认 90s），首事件前 stall 自动重试整个请求。
- responses 线接入代理配置（`HTTPS_PROXY` 等此前在 Bun 下对这条线不生效）；chat 线 SDK 客户端默认重试 0 → 2。

## 六、Provider 档案

`/provider save <name>` 把当前整组 env 快照成档案，`/provider use <name>` 全形状切换（先清全部家族键再写目标，含 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`）。多模型来回切换的推荐方式。

## 七、登出会清掉什么

`/logout`（与 `occ logout`）重置**整个账户面**，不区分 OAuth 还是 API key：Claude OAuth token、ChatGPT / Antigravity 的 OAuth 凭据文件、secure storage，以及 settings.env 与 `~/.occ.json` 里全部 provider 键（`ALL_PROFILE_ENV_KEYS` + `CLAUDE_CODE_OAUTH_TOKEN`），`modelType` 一并回到未设置；当前进程的 `process.env` 同步删除。

早期版本把第三方 key 当"配置而非登录态"保留，结果是非 Claude 用户登出后下一轮请求照旧打同一个端点、用同一把 key —— 等于没登出。

**保留的**：`/provider save` 存下的档案本身（只清 active 指针），所以 `/provider use <name>` 可以一键恢复；MCP、hooks、主题等与账户无关的设置不受影响。登录（`installOAuthTokens`）内部也会清一次旧状态，但**不**动 provider 配置 —— 登录不该顺手删掉用户的端点设置。

## 八、已知限制

- **thinking 字段**：仅 `deepseek`/`mimo` 模型名自动启用；GLM 等需手动 `OPENAI_ENABLE_THINKING=1`。启用时同时发三种格式字段，**严格校验未知字段的端点（Cerebras/Qwen 直连）可能 400**——此时 `OPENAI_ENABLE_THINKING=0` 关闭。
- `stream_options: {include_usage: true}` 恒发；个别严格端点会拒。
- Chat Completions 的 prompt cache 键默认只发给官方 api.openai.com（第三方隔离），网关场景用 `OPENAI_PROMPT_CACHE_KEY=1` 放行；`/responses` 恒发。见 §五点五。
- Gemini 只走隐式缓存，occ 不创建显式 `cachedContent`；Gemini 也不单独上报缓存写入量，所以 Gemini 的 `cache_creation_input_tokens` 恒为 0。
