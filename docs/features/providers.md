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

## 六、Provider 档案

`/provider save <name>` 把当前整组 env 快照成档案，`/provider use <name>` 全形状切换（先清全部家族键再写目标，含 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`）。多模型来回切换的推荐方式。

## 七、登出会清掉什么

`/logout`（与 `occ logout`）重置**整个账户面**，不区分 OAuth 还是 API key：Claude OAuth token、ChatGPT / Antigravity 的 OAuth 凭据文件、secure storage，以及 settings.env 与 `~/.occ.json` 里全部 provider 键（`ALL_PROFILE_ENV_KEYS` + `CLAUDE_CODE_OAUTH_TOKEN`），`modelType` 一并回到未设置；当前进程的 `process.env` 同步删除。

早期版本把第三方 key 当"配置而非登录态"保留，结果是非 Claude 用户登出后下一轮请求照旧打同一个端点、用同一把 key —— 等于没登出。

**保留的**：`/provider save` 存下的档案本身（只清 active 指针），所以 `/provider use <name>` 可以一键恢复；MCP、hooks、主题等与账户无关的设置不受影响。登录（`installOAuthTokens`）内部也会清一次旧状态，但**不**动 provider 配置 —— 登录不该顺手删掉用户的端点设置。

## 八、已知限制

- **thinking 字段**：仅 `deepseek`/`mimo` 模型名自动启用；GLM 等需手动 `OPENAI_ENABLE_THINKING=1`。启用时同时发三种格式字段，**严格校验未知字段的端点（Cerebras/Qwen 直连）可能 400**——此时 `OPENAI_ENABLE_THINKING=0` 关闭。
- `stream_options: {include_usage: true}` 恒发；个别严格端点会拒。
- prompt cache 键只发给官方 api.openai.com（第三方隔离）。
