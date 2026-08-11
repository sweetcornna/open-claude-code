# 多模型 / 多协议配置（GPT · GLM · Kimi · DeepSeek · Gemini · Grok）

occ 不只连 Claude：任何 OpenAI 兼容端点、Gemini 原生 API、Grok、以及自建的 Anthropic 兼容服务都能当主力模型用。实现方式是流适配器——第三方 API 的请求/响应在边界处转成内部 Anthropic 格式，工具调用、流式输出、上下文管理等所有下游逻辑零改动。

**大多数人不需要读完本文**：首次运行 `occ` 的向导（或之后的 `/login`）会引导你选供应商、填 key 和模型，国产模型还有现成 preset。本文是给需要手动调环境变量、写脚本或排查问题的人准备的配置真源。

## 〇、登录表单：四家共用的两步流

OpenAI（两条线）、Anthropic 兼容端点、Gemini、Grok 走的是**同一个向导**（`src/components/providerSetup/`，各家差异全部收在 `specs.ts` 的表里）：

1. **Step 1 —— 连接信息**。只填 Base URL 和 API Key。这一步不写任何设置，填完按 Enter 只做一件事：拿刚输入的凭据去问端点 `GET /models`。
2. **Step 2 —— 选模型**。端点答上来了，默认模型和四个档位就都是选择器，从它**实际提供**的模型里挑。答不上来（URL 写错、没有 key、网关不实现 `/models`）时分两种：**occ 自己有该 provider 的模型表**就用那张表继续给选择器，并在顶部说明这是 occ 的猜测、失败原因是什么；**没有表**才退回手填，并显示 `fetch failed (connect ECONNREFUSED 127.0.0.1:9)` 这样的原因 —— 端点能用但没有模型列表，从来不该挡住配置。

内置表**只覆盖 occ 本来就在维护的两家、且只对官方端点生效**：`api.anthropic.com` 用 Claude 全系 id（`ALL_MODEL_CONFIGS`），`api.openai.com` 用 GPT 列表（`CHATGPT_CODEX_MODEL_OPTIONS`）。自建网关、代理、国产端点一律拿不到这两张表 —— 兼容一种协议不等于拥有那份目录，把 GPT 列表塞给一个 vLLM 部署只会让人选中一个它没有的模型。Gemini 和 Grok 连官方端点都**故意没有表** —— 给它们现编一张第三方 model id 表意味着长期手工维护一份会过时的清单，而那正是 `GET /models` 探测要解决的问题。

**端点答上来时就只用端点返回的表**（早期版本会把内置表合并进去，已删除）：服务器自己说它有什么，比 occ 猜它有什么更权威；合并的实际效果是把已下线的模型继续摆在选择器里。

**`/models-setting` 随时重开这套设置**。改一个档位不必重走 `/login` 把端点和 key 再敲一遍：端点、key、四个档位当前值都从 env 读回来，只改模型再写回去。候选表来自后台 catalog 刷新缓存的 `GET /models` 结果（缓存为空时才退回官方端点的内置表），所以是瞬时且离线的。与新登录不同，**候选表里没有的已配置值不会被丢弃** —— 用户是故意配的，缓存可能只是旧了。这个命令**始终注册**（早期版本会在纯一方会话里隐藏它）：一方会话同样可以用 `ANTHROPIC_DEFAULT_<TIER>_MODEL` 把某一档钉到指定的 Claude checkpoint，而藏起来的命令是查不到的。

几条容易踩的规则：

- **Base URL 留空不等于写默认值**。留空时探测请求会发往该 provider 的默认端点，但保存时**不写** `*_BASE_URL` —— 写进去等于把会话钉死在今天这个地址，以后 provider 改默认就跟不上了。只有 OpenAI 强制要求填（它没有可回落的官方默认语义）。
- **API Key 留空只有 OpenAI 会拦**。其余三家会跳过探测直接进手填，理由是无鉴权的本地网关（比如套了 Anthropic 兼容壳的 vLLM）在这套向导之前就能配，不该被新流程拒之门外。
- **端点换了以后，记不住的旧模型会被丢掉**。Step 2 会用现有环境变量预填选中项，但在选择器模式下，端点已经不提供的模型名会被清空——留着它只会让你保存一个这台服务器答不了的配置。
- 校验按家不同：OpenAI 必须选默认模型（OpenAI 兼容端点没有家族默认可回落）；Gemini 要么填默认模型、要么把 haiku/sonnet/opus 三档填全（它的映射表打不中就抛错）；Anthropic 兼容与 Grok 都可以全空，靠内置家族默认。

## 一、选择 provider

优先级：`settings.modelType`（`/login` 或向导写入）> `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,OPENAI,GEMINI,GROK}` 环境变量 > 默认 Anthropic 一方 API。判定入口 `src/utils/model/providers.ts`。

## 二、各 provider 环境变量矩阵

| Provider | 启用 | Key | Base URL | 模型 | 输出上限 |
|---|---|---|---|---|---|
| OpenAI 兼容（GPT/GLM/Kimi/DeepSeek/Ollama/vLLM/One API…） | `modelType:'openai'` 或 `CLAUDE_CODE_USE_OPENAI=1` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `OPENAI_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL` 四档；`OPENAI_MODEL` 仅作未配置档位的 provider 兜底 | `OPENAI_MAX_TOKENS` |
| ChatGPT 订阅 | 同上 + `OPENAI_AUTH_MODE=chatgpt` | 设备码 OAuth | Codex 专有后端 | tier 常量（sol/terra/luna） | 不发（Codex 不收） |
| Gemini 原生 | `modelType:'gemini'` 或 `CLAUDE_CODE_USE_GEMINI=1` | `GEMINI_API_KEY` | `GEMINI_BASE_URL`（默认官方）；Antigravity 用 `ANTIGRAVITY_BASE_URL` | `GEMINI_MODEL` 或四档（**必须配一种**，无内置默认） | `GEMINI_MAX_TOKENS`（或通用 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，opt-in） |
| Grok | `modelType:'grok'` 或 `CLAUDE_CODE_USE_GROK=1` | `GROK_API_KEY`/`XAI_API_KEY` | `GROK_BASE_URL`（默认 api.x.ai/v1） | `GROK_MODEL` 或映射表 | `GROK_MAX_TOKENS`（同上，opt-in） |
| Anthropic 兼容端点 | `modelType:'anthropic'` + baseURL | `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL` | `ANTHROPIC_MODEL` 或四档 | （Anthropic 路径原生管理） |

国产模型（DeepSeek / 智谱 GLM / 千问 / MiMo）走 OpenAI 兼容矩阵；`/login → China LLM Providers` 有内置 preset（baseURL、模型表、Coding Plan 专用端点）。

> **Breaking change：Antigravity 的端点覆盖已从 `GEMINI_BASE_URL` 迁到独立的 `ANTIGRAVITY_BASE_URL`。** 两条线的路径形状根本不同（Antigravity 走 `/v1internal:streamGenerateContent`，Gemini 走 `/v1beta/models/...`），共用一个键意味着任何一方的代理设置都会打歪另一方。以前用 `GEMINI_BASE_URL` 给 Antigravity 配代理的，需要把值改到 `ANTIGRAVITY_BASE_URL`；两个键都不设时各走各的官方默认。

**一个 key 配的是整个供应商，不是一个模型。** 流程是「选供应商 →（有 Coding Plan 的再选计费方式）→ 填 API Key → 选各档位模型」：填完 key 之后该供应商的**所有**模型都能用，`/model` 里直接列出来（带官方标签、价格、上下文窗口），随时切换。

最后那一步走的是上面那个共用向导的 Step 2：**默认模型 + 四个档位，一共五个槽各是一个选择器**（默认模型写 `OPENAI_MODEL` 之类的 provider 单模型键，四档写各自的 `{PROVIDER}_DEFAULT_<TIER>_MODEL`），选项就是端点 `GET /models` 真正返回的模型表；只有端点无法列举模型时才用官方 preset 或手填兜底。**默认值预填 preset 的 `tiers` 映射**（例如 DeepSeek：`haiku`→`deepseek-v4-flash`，`sonnet`/`opus`/`fable`→`deepseek-v4-pro`）—— 一路回车即接受默认，想改哪个改哪个，之后也能用 `/models-setting` 再改。

默认模型与四个档位**彼此独立**：向导把 provider 默认写入 `OPENAI_MODEL`（或对应家族的 `*_MODEL`），把 Haiku / Sonnet / Opus / Fable 写入各自的 `{PROVIDER}_DEFAULT_<TIER>_MODEL`。默认请求使用 `modelSettings.default`，显式 `/model sonnet` 使用 `modelSettings.sonnet`；即使两者解析成同一个模型 ID，也不会再共享 effort 或 context 配置。`/model <具体 id>` 仍然原样透传，不会被 provider 默认值替换。

唯一故意不写的是 **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`**：一个全局值描述不了一份混着不同窗口的模型表（GLM 的 203K 和 205K 就挨在一起）。改为 `getContextWindowForModel()` 按模型从 preset 表里查真实窗口；它排在环境变量覆盖**之下**。中间的[分层模型设置](./model-settings.md)优先级是 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` > `modelSettings.<slot>.contextTokens` > 内置默认，环境变量仍然是最高优先级的纠正入口。

## 三、协议（wire API）

> **DeepSeek 是例外**：检测到 `OPENAI_BASE_URL` 指向 `api.deepseek.com` 时，occ 自动改走它的 **Anthropic 兼容端点**（`/anthropic`），因为那是它三条协议里唯一同时提供原生 thinking 块、零格式转换和**服务端 web 搜索**的一条。配置文件一字不改，存量配置继续有效。显式设置 `OPENAI_WIRE_API=chat|responses` 会覆盖这个选择，`CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` 则完全关闭它。详见 `src/utils/model/deepseekWire.ts`。
>
> 镜像**跟着配置走**，不是只在启动时跑一次：首次 `/login` 是在进程启动之后才写入 DeepSeek 的键，而 `getAPIProvider()` 在那一刻就翻成 `firstParty`。所以 `managedEnv` 的两个 apply 函数、以及两个直接写 `process.env` 的登录组件都会重跑它；换 provider 时它也会把自己上次写的键收回去。镜像只回收「当前值仍等于自己写入值」的键 —— 否则那是别人的值。
>
> 代价是 `getAPIProvider()` 对这类会话返回 `firstParty` —— 那是**协议**的答案。这里其实有三个问题，务必分开：`getAPIProvider()` 答协议；`isThirdPartyModelCatalog()` 答「谁的目录、谁的价目表」；`servesAnthropicModels()` 答「`claude-opus-5` 这个 id 是不是真指 Anthropic 的 Opus 5」。Bedrock/Vertex/Foundry 对第二个答「第三方」（独立计费），对第三个答「是」—— 它们跑的确实是 Claude，叫「Opus 5」没错。openai/gemini/grok 与 DeepSeek 线对第三个答否：`ALL_MODEL_CONFIGS` 给这几家映射的是同一批 `claude-*` 字符串，没配的档位会解析出字面量 `claude-fable-5`，DeepSeek 静默换成自家 checkpoint、其他家 404；显示成「Fable 5」等于对用户**和 system prompt** 撒谎。「这是不是 Anthropic 自家的模型目录」则问 `isThirdPartyModelCatalog()`。仓库里约四十处把两者写成了同一个表达式，于是 DeepSeek 用户的 `/model` 列出 Opus 5 并标着 `$5/$25 per Mtok`。判断准则：**改造前 DeepSeek 会话是 `provider === 'openai'`，这条线路不得打开任何当时是关着的 Anthropic 专属行为** —— 有意的例外只有协议本身、原生 thinking、prompt 缓存和服务端搜索适配器，都是对真实端点实测过的。定价文案、`/model` 列表、Anthropic 专属 beta 头、legacy 模型迁移、Fast mode、bootstrap 拉取一律问 catalog。

OpenAI 家族有两条线：`OPENAI_WIRE_API=chat`（默认，Chat Completions，打 `<base>/chat/completions`）或 `responses`（Responses API，打 `<base>/responses`）。`OPENAI_AUTH_MODE=chatgpt` 强制 responses；Codex 家族模型（id 含 `codex`、GPT-5 世代）在未显式指定时也默认 responses。

**协议在登录菜单里选，不是表单里的一个字段**：`/login` 有两个并列入口 —— **OpenAI Chat Completions** 与 **OpenAI Responses API**，选哪个就把 `OPENAI_WIRE_API` 写成哪个，后续走的是与其他 provider 相同的两步流（见上一节）。这样命名是因为"OpenAI 兼容"只描述了 chat 那条线，把 responses 塞进同一个表单会让人以为它也是"兼容"模式。

选定的协议对**整条链路**生效：主循环、side query（分类器、标题生成、模型校验等）、WebSearch 的 codex 源共用同一套解析（`resolveOpenAIWireProtocol`）。曾经只有主循环认这个键，side query 一律走 Chat Completions，只支持 `/responses` 的上游会直接拒掉那部分请求。

## 四、模型名解析

- 任意具体模型名（`glm-4.6`、`kimi-k2`、`deepseek-v4-pro`、`gpt-5.2`、`gemini-3-pro`）**都可透传**：`/model <具体 id>` 或 `settings.model` 的显式选择优先，不会再被 provider 级 `OPENAI_MODEL` / `GEMINI_MODEL` / `GROK_MODEL` 改写。
- 含家族子串的档位别名按 `{PROVIDER}_DEFAULT_{FAMILY}_MODEL` → provider 单模型键 → 内置家族表映射（映射逻辑在 `packages/@ant/model-provider/.../modelMapping.ts`）。

### 档位（family alias）

`/model` 与 `--model` 接受四个档位别名，从高到低：

| 别名 | 一方 API 解析到 | 定位 | 一方定价（每 Mtok） |
| --- | --- | --- | --- |
| `fable` | `claude-fable-5` | 能力最高档，面向最难的推理与长跨度 agent 任务 | $10 / $50 |
| `opus` | `claude-opus-5` | 复杂工作的主力 | $5 / $25 |
| `sonnet` | `claude-sonnet-5` | 日常任务默认档 | $3 / $15 |
| `haiku` | `claude-haiku-4-5` | 最快、最省，简单任务 | $1 / $5 |

四个别名都支持 `[1m]` 后缀（如 `fable[1m]`、`opus[1m]`）走 1M 上下文链路。`best` 仍解析到 `opus` 档——它没有跟随 `fable`，避免把既有用户静默换到贵一倍的档位。

`fable` 档没有 ChatGPT/Codex 对应层：OpenAI 用户通过 `OPENAI_DEFAULT_FABLE_MODEL`（或统一的 `ANTHROPIC_DEFAULT_FABLE_MODEL`）自行指定，未配置时回落到该 provider 的主模型键。

四个档位在首启向导 / `/login` 的 Step 2 里都有对应字段（`Fable tier model (optional)` 排在 Opus 之后 —— fable 是最高档），四家 provider 一致。端点提供了模型列表时它们是选择器，否则是手填框。留空即按上面的回落链走，不必先退出去改环境变量。Gemini 的「Model 或三个档位全填」校验不含 fable：它未配置时回落到主模型键，强制填会打断既有配置。

## 五、最大上下文（关键）

**`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** 是模型上下文窗口的用户覆盖，优先于一切自动探测。非 Anthropic 模型探测不到真实窗口时按 200k 兜底——128k 的模型会在 auto-compact 触发前就被端点以 prompt-too-long 拒掉，1M 的模型会浪费 80% 窗口并过早 compact。设置它之后**全链路生效**：

- auto-compact 阈值（窗口 − 20k 输出预留 − 13k 缓冲）与预测式 compact —— 即"靠近阈值触发 compact"
- 硬阻断线、statusline 的 `ctx:%`、`/context` 显示

配置面：`/provider` 档案随家族切换，或直接设环境变量。china preset 不写这个键 —— 它的模型窗口按模型查表（见上一节）。

**首启向导 / `/login` Step 2 的 Max ctx 与 Thinking effort 字段不再写这个键**，改为落进 `settings.modelSettings` 的**分层配置**（见 `docs/zh/features/model-settings.md`）。原因就是上面这条优先级：env 是「探测不到时的最终纠正手段」，写在登录里等于让一个开场值静默压过用户此后在 `/model` 里的每一次调整。保存时会顺带删掉旧版留下的该键（字段会把旧值带过去，不丢）。两个字段留空时写入默认模型与各档位自己的家族默认值 —— 于是登录结束后 `/model-settings` 显示的是彼此独立的 `default` / Haiku / Sonnet / Opus / Fable。重跑向导（`/models-setting` 或第二次 `/login`）时留空则**什么都不动**，不会把你在 `/model` 里分档调好的值压平；把 Thinking effort 明确选回 `(model default)` 会删除旧覆盖并立即恢复家族默认。

**按模型开启 1M 后缀**：`CLAUDE_CODE_1M_CONTEXT_MODELS`（逗号分隔模型名/子串，大小写不敏感）。主循环模型解析后命中即自动追加 `[1m]` 后缀，等价于手选 `sonnet[1m]`——走完整的后缀链路（1M 窗口 **+ 1M beta 头**），适用于支持 1M 上下文的 Anthropic 系模型；已带后缀的模型不重复追加。第三方模型只需要窗口数值时，用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 即可，无需该开关。

## 五点五、Prompt 缓存（各家的命中率从哪来）

各 provider 的缓存都是**前缀命中**：请求的前缀与上一轮完全一致才算命中。所以任何让前缀发生位移或改写的东西（工具表变动、system prompt 动态段变化、把上一轮的响应换个形状发回去）都会把整轮打成 miss。

| Provider | 机制 | occ 的处理 |
| --- | --- | --- |
| Anthropic | 显式 `cache_control` 断点 | system 块 + 单个消息断点；TTL 见 [system-prompt.mdx](../context/system-prompt.mdx) 的 `should1hCacheTTL` 一节（含 `CLAUDE_CODE_PROMPT_CACHING_1H`） |
| OpenAI Chat Completions | 自动前缀缓存 + `prompt_cache_key` 粘性路由 | 会话级稳定 key `occ:<sessionId>`，**默认对所有端点发送**，被拒即降级 |
| OpenAI Responses / Codex | 同上 + reasoning 回放 | key 恒发；reasoning 见下 |
| Gemini | 隐式缓存 | `promptTokenCount` 含缓存前缀，统计时须扣除（`normalizeGeminiUsage`） |
| Grok (xAI) | 自动前缀缓存 | 无需额外参数 |
| DeepSeek | 自动硬盘前缀缓存 | 无需额外参数；命中量按 `prompt_cache_hit_tokens` 上报 |
| GLM / Kimi 等兼容端点 | 自动前缀缓存 | 无需额外参数；命中量按 `prompt_tokens_details.cached_tokens` 或扁平化的 `cached_tokens` 上报 |

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

**`OPENAI_PROMPT_CACHE_KEY`**：**默认对所有端点都发**（两条协议线一致）。

早先的规则是 chat 线只发给官方 `api.openai.com`，理由是严格端点会 400 拒收未知顶层字段。代价是：**最大的那根杠杆对最需要它的人群默认关着** —— 把 OpenAI 挂在 chat 网关后面（LiteLLM / one-api / new-api / OpenRouter）的用户，除非正好读到这段文档，否则一直跑在上表 18.3% 那一行。

现在改成乐观发送 + 被拒即降级：端点若以「未知字段 / 不支持 / 不允许额外输入」之类的措辞拒收 `prompt_cache_key`，occ 去掉该字段重发一次，并在**本进程内**不再发给非官方端点（官方端点文档化了这个字段，不受一次网关拒收影响）。真会拒的端点每会话付一次失败请求；只是忽略未知键的端点（兼容生态里的绝大多数）什么都不付。`OPENAI_PROMPT_CACHE_KEY=0` 彻底关闭（用于既不接受、也不给出可识别拒绝信息的网关），`=1` 即使被拒过也强制发。

**注意**：`cache_creation_input_tokens` 的归属**不再**跟着「有没有发 key」走。`cache_write_tokens` 是 OpenAI 独有的 usage 字段，现在按端点判定 —— 兼容端点即使回显了这个字段也不采信，仍记 0。

**Responses / Codex 的 reasoning 回放**：推理模型走 `/responses` 且 `store: false` 时服务端不留状态，第 N 轮的 reasoning item 不回放就彻底丢失。occ 的做法是请求带 `include: ["reasoning.encrypted_content"]`，从 `response.output_item.done` 抓取后按 `_openaiReasoningItems` 挂在该轮 assistant 消息上（消息级而非内容块级——中途切模型时消息级附加字段会被丢弃，块级会跟着发给别的 provider），下一轮在该 assistant 轮最前面按原顺序回放；assistant 文本按 `{type:'message', content:[{type:'output_text'}]}` 回放而不是裸 `{role, content}`（后者归一成 `input_text`，等于告诉模型它自己上一轮的回答是用户输入）。

**这是保真修复，不是缓存修复**：同样的对照实验（6 轮，开/关回放）两边命中率都是 80.9%——OpenAI 的前缀缓存是拿客户端**自己上一次的请求**去匹配的，一个始终不回放的客户端也能和自己接上。回放买到的是模型在工具调用轮之间不用重新推导意图。

这条链路只在 `OPENAI_WIRE_API=responses` 时启用，Chat Completions 的消息体不会出现这个字段（严格端点会拒未知键）。

## 五点六、GPT 调优（仅 openai provider + GPT 家族模型生效）

接 GPT 模型时（`modelType:'openai'` 且解析后的模型 id 以 `gpt-` 开头或含 `codex`；Claude 别名如 `/model opus` 会先经模型映射再判定），occ 参照 OpenAI Codex CLI 做三层收敛。**Anthropic 路径与 openai 层跑非 GPT 模型（DeepSeek/GLM 等）完全不受影响。**

**行为提示词**：system prompt 末尾追加一段 GPT 执行纪律 overlay（少计划、不自审、不派审查子代理、压缩最终回复）；`EnterPlanMode`/`Agent` 工具描述与 plan mode 指令切换到克制版文案——针对 GPT 把"鼓励计划/鼓励子代理"条款当硬性命令执行的问题。

**请求参数默认值**（用户显式设置永远优先）：

- reasoning effort：GPT 家族出厂默认 `xhigh`；Responses 原样发送，Chat Completions 因协议最高只认 `high` 而夹到 `high`。`CLAUDE_CODE_EFFORT_LEVEL` 或 `/model` 当前档位的 effort 配置优先。
- `text.verbosity`：responses 线对 GPT 模型默认发 `low`（ChatGPT OAuth 路由与官方 baseURL；第三方网关默认不发）。`OPENAI_VERBOSITY=low|medium|high` 强制指定并对任意端点放行，`=off` 强制不发。
- 内部分类器（side query）对 GPT 模型显式用 `low` effort，不再落到服务端默认 medium。
- `reasoning.summary` 默认发 `auto`。**不发这个字段，流里就一个推理事件都没有** —— 官方原话是"This output will not be included unless you explicitly opt in to including reasoning summaries"。occ 此前只发 `reasoning:{effort}`，于是 GPT 整个思考阶段既没有 thinking 块、spinner 也进不了 `thinking` 状态，看起来就是在发呆。`OPENAI_REASONING_SUMMARY=auto|concise|detailed` 指定详细度，`=off`（或 `0`/`false`/`none`）关闭。端点若拒收这个字段（组织未完成 verification、第三方网关不认），会**自动去掉该字段重发一次并在本次会话内不再尝试** —— 丢掉思考显示远好过丢掉这一轮。side query 恒不发（没有 UI 展示它的思考，而且会挤占本就紧张的输出预算）。

**网络层**（responses 线此前是裸 fetch，无超时无重试）：

- 重试预算与分档见下面的「五点八、重试策略」——那一节对所有 lane（Anthropic / OpenAI 两线 / Gemini / Grok / DeepSeek / 搜索适配器）生效，不是 GPT 专属。
- 退避尊重 `Retry-After`；Responses 使用 200ms 起步、2 倍增长、±10% 抖动。SDK 内建重试在外层拥有预算的 chat lane 关闭，Responses 自己耗尽建流预算后也会打标，避免外层再叠一条 10 次预算。
- 空闲看门狗复用 `CLAUDE_STREAM_IDLE_TIMEOUT_MS`（默认 90s）：只有在尚未向外产出模型事件时才重试；一旦已产出文本、thinking 或工具参数就不回放，避免重复输出或工具调用。
- Responses 线接入代理配置（`HTTPS_PROXY` 等此前在 Bun 下对这条线不生效）。

## 五点七、DeepSeek 调优（仅请求 DeepSeek 模型时生效）

门控在 `src/utils/model/deepseekTuning.ts`，与 GPT 调优同构：**模型 id 含 `deepseek`**（覆盖 `deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-pro` / `deepseek-v4-flash`，以及自建部署的 `deepseek-ai/DeepSeek-V4-Pro`）**或 baseURL 指向 `api.deepseek.com`**（网关把模型改名成 `default`/`coder` 时仍能命中）。两个条件都不满足时，请求体与改造前**逐字节相同** —— GLM / Kimi / Qwen / MiMo / 本地 vLLM 不受任何影响。

**temperature = 0**：DeepSeek 未显式传参时默认 `1.0`，而官方参数指南把 `1.0` 归给"数据分析"、把**代码与数学归给 `0.0`**。occ 是编码 agent，所以未指定时补 `0.0`。调用方显式传的 temperature 永远优先；`DEEPSEEK_TEMPERATURE=<0..2>` 可单独退出这一项而保留其余调优（越界/非数字值忽略）。**thinking 模式下不发** —— 官方明确 thinking 模式不支持 `temperature`/`top_p`/`presence_penalty`/`frequency_penalty`。

**工具数上限 128**：DeepSeek 的 function 数量硬上限是 128，超出直接拒收（挂几个 MCP server 就能顶到）。超限时截断尾部并打 debug 日志 —— 工具表是 core 优先排的，砍尾巴丢掉的是 MCP 工具而不是 Read/Edit/Bash。

**`reasoning_content` 回传补齐**：thinking 模式下，带 `tool_calls` 的 assistant 轮**必须**把 `reasoning_content` 原样回传，否则 DeepSeek 返回 400（`reasoning_content ... must be passed back to the API`）。仅"保留已有 thinking 块"不够：被 compact 改写过的历史、thinking 开关打开之前记录的轮次、本地合成的消息都会走到没有 thinking 块的分支。现在这类轮次补 `reasoning_content: ''`。整个生态（langchain #37174、opencode #24190、goose #9200、anything-llm #5683）收敛到的也是这个修法。该补齐挂在 `enableThinking` 上，只有 DeepSeek/MiMo 或显式 `OPENAI_ENABLE_THINKING=1` 才会带上这个字段。不带 `tool_calls` 的轮次官方明说会忽略这个字段，所以不补。

**thinking 开关要说出口**：DeepSeek 的 `thinking` 字段**默认 `enabled`**。此前 occ 只在开启时发 `thinking:{type:'enabled'}`、关闭时什么都不发 —— 于是 `OPENAI_ENABLE_THINKING=0` 对官方端点根本没生效。现在两个方向都显式发。另外 baseURL 是 `api.deepseek.com` 时只发官方文档里的 `thinking` 字段，自建部署（模型名命中但 URL 不是官方）才附带 `enable_thinking` / `chat_template_kwargs` 这两种 chat-template 写法。

**`reasoning_effort` 接上 `/model` 的 effort 档**：DeepSeek 支持 `low`/`high`/`max`（默认 `high`），而 occ 此前只对 OpenAI 推理模型发这个字段 —— DeepSeek 的 effort 选择器是纯装饰，实际永远跑默认 `high`。现在按下表折叠：

| occ | DeepSeek | 说明 |
| --- | --- | --- |
| low | `low` | |
| medium | `high` | 三档梯子的中间那档 |
| high | `high` | |
| xhigh | `max` | high 与 max 之间没有别的档 |
| max | `max` | 官方对高强度 agent 场景的推荐值 |
| **未设置** | **`max`** | 见下 |

**默认档是 `max`**。DeepSeek 自己不传参时是 `high`，occ 早先也就跟着跑 `high`。改成 `max` 的理由是梯子只有三级：从默认到顶只差一步，而不是五档命名暗示的那种长爬升；而「高强度 agent 场景」正是这个工具的全部工作量。只有地板抬高了 —— `/effort` 和 `CLAUDE_CODE_EFFORT_LEVEL` 仍然优先，想跑便宜档说一声就有。

thinking 关闭时不发（此时它不控制任何东西，这也顺带让 `max` 默认不会落到不认这个字段的旧 checkpoint 上）。`deepseek-v4-pro` 目前只认 `high`/`max`，`low` 由服务端强制抬到 `high`，所以不用按模型再收窄；`deepseek-v4-flash` 是真正认全三档的，已一并加进 `modelSupportsEffort` 的允许列表。

**上下文窗口按 1M 算**。DeepSeek V4 是 1M 上下文族，而第三方模型探测不到窗口时的兜底是 200k —— 差 5 倍，直接后果是会话在还剩八成窗口时就开始 auto-compact。现在模型名含 `deepseek` 即按 1M 计（`getContextWindowForModel` 里，排在 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 覆盖**之下**）。这一项**只按模型名判定、不看 baseURL**：`getContextWindowForModel` 对所有 provider 都会跑，残留的 `OPENAI_BASE_URL` 不该把 1M 窗口发给 Anthropic 会话。网关把模型改名到认不出来时会落回 200k，`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 就是为这种情况准备的纠正入口；部署实际提供的窗口更小时也可以用 `CLAUDE_CODE_DISABLE_1M_CONTEXT` 退回默认。

**流式 thinking 块修复**：thinking 模式下 DeepSeek 会在多步之间穿插推理（官方原话是"multiple turns of reasoning and tool calls"），也就是 text → reasoning → text 是真实顺序。此前开 thinking 块时不关已开的 text 块，`currentContentIndex` 前移而 `textBlockOpen` 仍为 true，后续 `text_delta` 就打进了 thinking 块的 index —— **可见回答被追加进思维链里**，text 块还要拖到流末尾的兜底清理才关。已按 text/tool 处理器的既有约定补齐互关。

## 五点八、重试策略（对所有 lane 生效）

**每一个 API 错误都会重试。** 分歧只在「重试多少次值得」，判定真源是 `src/services/api/retryClassification.ts` 的 `classifyRetryableAPIError()`，它同时给出 `category`（报给 SDK / UI 的错误类别）与 `persistence`（落在哪条预算）。

| 档 | 谁进来 | 预算 |
| --- | --- | --- |
| `transient` | 网络/传输错误、408/409/425/429/5xx、无状态的上游失败、`upstream_error`/`stream_read_error` 这类网关合成错误、以及分类不出来的兜底 | **10 次重试**（初始请求之外，共 11 次尝试），指数退避 500ms → 32s，尊重 `Retry-After`（上限 60s） |
| `permanent` | 认证、权限、无效请求、计费、模型不存在等 4xx，确定性 TLS 失败（证书/握手），以及服务端明说 `x-should-retry: false` 的响应 | **1 次重试**，固定 250ms |

`permanent` 那一档为什么是 1 次 / 250ms：这些类别第二次基本还是同一个答案，多给一次只是为了兜住少数例外——比如请求发出到 401 之间凭据刚好被另一个进程轮换（`withRetry` 在决定重试**之前**就已丢弃过期凭据缓存，所以第二次是用新凭据构造的），或者网关短暂拒收了一个它随后会接受的 body。250ms 固定而非指数：这里没有拥塞需要退避，而工具 schema 写错时的 400 必须在一秒内浮出来（`transient` 那条梯子光第一步就是 500ms）。

**`CLAUDE_CODE_RETRY_ALL_ERRORS=0`**（也接受 `false` / `off` / `no`）**关掉这条策略**，恢复到旧行为：`permanent` 档一次尝试就失败。默认开启。

**两件事这个开关碰不到**，因为它们都不是「API 出错」：

1. **用户取消**。`APIUserAbortError`、`AbortError`、已 abort 的 signal 一律不重试——重试取消等于让 Esc 失效。
2. **producer 显式标了 `retryable: false`**。这是流适配器表达「这一次尝试的输出已经交付出去了」的方式：token 已经进了终端、进了 ACP 的 `agent_message_chunk`、进了 `--include-partial-messages` 的 stdout，而这三条都是只能追加、没有「撤回/替换」这种更新类型的。重放 = 用户看到两遍。见 `openai/responsesAdapter.ts` 的 `closesRetryWindow`，以及 `withTransientNetworkRetry` 里 `hasEmittedContent` 那道闸——**那道闸在策略之上，任何分类结果都越不过去**。occ 自己抛的 `NonRetryableError`（未登录、账号无 project）用的也是这个字段。

**报出来的 `category` 只取决于错误本身，与重试结论无关。** 曾经不是这样：同一个上游断流，走瞬态尾部时报 `server_error`、被钉成永久时报 `unknown`，同一个 bug 看起来像两个。

**预算覆盖**：`CLAUDE_CODE_MAX_RETRIES` 覆盖通用/Anthropic 与 OpenAI chat、Gemini、Grok lane，`OPENAI_REQUEST_MAX_RETRIES` 覆盖 Responses 建流；两个覆盖都校验并夹在 `0..10`，且都只抬 `transient` 档的上限——`permanent` 档取两者的较小值，所以调大 `CLAUDE_CODE_MAX_RETRIES` 不会让一个 400 重试十次。

**仍然独立于本策略的两个 bail**（它们说的是「再试一次不可能成功」，不是「这一类很少成功」）：非前台 querySource 的 529 直接放弃（避免容量雪崩时的放大），以及窗口型 429（Max/Pro 五小时窗）——每一步退避都夹在 60s，十次也熬不到窗口重开，只会把「5-hour limit reached」推迟十分钟。

## 六、Provider 档案

`/provider save <name>` 把当前整组 env 快照成档案，`/provider use <name>` 全形状切换（先清全部家族键再写目标，含 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`）。多模型来回切换的推荐方式。

## 七、登出会清掉什么

`/logout`（与 `occ logout`）重置**整个账户面**，不区分 OAuth 还是 API key：secure storage 里的 Claude OAuth 记录（`claudeAiOauth`）、ChatGPT / Antigravity 的 OAuth 凭据文件，以及 settings.env 与 `~/.occ.json` 里全部 provider 键（`ALL_PROFILE_ENV_KEYS` + `CLAUDE_CODE_OAUTH_TOKEN`），`modelType` 一并回到未设置；当前进程的 `process.env` 同步删除，DeepSeek 的内存镜像同时释放。两个入口语义一致：都会把 `hasCompletedOnboarding` 归零，下次启动重新走首启向导。

早期版本把第三方 key 当"配置而非登录态"保留，结果是非 Claude 用户登出后下一轮请求照旧打同一个端点、用同一把 key —— 等于没登出。更糟的是那些键会在下次启动被重新灌回 `process.env`，`isAnthropicAuthEnabled()` 于是判定这是第三方会话，向导连登录步骤都不再出现 —— 登出了，也没法再登回来。

**保留的**：secure storage 里其他凭据家族 —— MCP 的 OAuth token 与 plugin secrets **不受影响**（登出只移除 `claudeAiOauth` 这一条，不是清空整个存储）；`/provider save` 存下的档案本身（只清 active 指针），所以 `/provider use <name>` 可以一键恢复；MCP、hooks、主题、`/search-setting` 的搜索源开关等与账户无关的设置不受影响。登录（`installOAuthTokens`）**不**调用登出逻辑 —— 登录不该顺手删掉用户的端点设置。

同时清空的还有 `customApiKeyResponses` 的 `approved` 与 `rejected` 两份名单。`rejected` 必须一起清：CLI 里没有别的地方能清它，而进了这份名单的 key 会被永久拒绝 —— "Detected a custom API key" 对话框只对状态为「新」的 key 弹出，所以一次拒绝（或一次取消，取消按 No 计）就等于再也无法接受那把 key。

## 八、已知限制

- **thinking 字段**：仅 `deepseek`/`mimo` 模型名自动启用；GLM 等需手动 `OPENAI_ENABLE_THINKING=1`。启用时同时发三种格式字段，**严格校验未知字段的端点（Cerebras/Qwen 直连）可能 400**——此时 `OPENAI_ENABLE_THINKING=0` 关闭。
- `stream_options: {include_usage: true}` 恒发；个别严格端点会拒。
- Chat Completions 的 prompt cache 键默认只发给官方 api.openai.com（第三方隔离），网关场景用 `OPENAI_PROMPT_CACHE_KEY=1` 放行；`/responses` 恒发。见 §五点五。
- Gemini 只走隐式缓存，occ 不创建显式 `cachedContent`；Gemini 也不单独上报缓存写入量，所以 Gemini 的 `cache_creation_input_tokens` 恒为 0。
