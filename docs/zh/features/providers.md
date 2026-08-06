# 多模型 / 多协议配置（GPT · GLM · Kimi · DeepSeek · Gemini · Grok）

occ 不只连 Claude：任何 OpenAI 兼容端点、Gemini 原生 API、Grok、以及自建的 Anthropic 兼容服务都能当主力模型用。实现方式是流适配器——第三方 API 的请求/响应在边界处转成内部 Anthropic 格式，工具调用、流式输出、上下文管理等所有下游逻辑零改动。

**大多数人不需要读完本文**：首次运行 `occ` 的向导（或之后的 `/login`）会引导你选供应商、填 key 和模型，国产模型还有现成 preset。本文是给需要手动调环境变量、写脚本或排查问题的人准备的配置真源。

## 〇、登录表单：四家共用的两步流

OpenAI（两条线）、Anthropic 兼容端点、Gemini、Grok 走的是**同一个向导**（`src/components/providerSetup/`，各家差异全部收在 `specs.ts` 的表里）：

1. **Step 1 —— 连接信息**。只填 Base URL 和 API Key。这一步不写任何设置，填完按 Enter 只做一件事：拿刚输入的凭据去问端点 `GET /models`。
2. **Step 2 —— 选模型**。端点答上来了，默认模型和四个档位就都是选择器，从它**实际提供**的模型里挑。答不上来（URL 写错、没有 key、网关不实现 `/models`）时分两种：**occ 自己有该 provider 的模型表**就用那张表继续给选择器，并在顶部说明这是 occ 的猜测、失败原因是什么；**没有表**才退回手填，并显示 `fetch failed (connect ECONNREFUSED 127.0.0.1:9)` 这样的原因 —— 端点能用但没有模型列表，从来不该挡住配置。

内置表**只覆盖 occ 本来就在维护的两家**：Anthropic 兼容用 Claude 全系 id（`ALL_MODEL_CONFIGS`），OpenAI 用 GPT 列表（`CHATGPT_CODEX_MODEL_OPTIONS`）。Gemini 和 Grok **故意没有** —— 给它们现编一张第三方 model id 表意味着长期手工维护一份会过时的清单，而那正是 `/models` 探测要解决的问题。端点答上来时两者会合并（端点的排前面），所以服务器漏报某个 occ 认识的模型也仍然可选。

**`/models` 随时重开这套设置**。改一个档位不必重走 `/login` 把端点和 key 再敲一遍：端点、key、四个档位当前值都从 env 读回来，只改模型再写回去。候选表来自后台 catalog 刷新缓存的 `/models` 结果（外加上面那两张内置表），所以是瞬时且离线的。与新登录不同，**候选表里没有的已配置值不会被丢弃** —— 用户是故意配的，缓存可能只是旧了。纯一方登录的会话里这个命令不出现：它的档位走内置 Claude 表，没有 `*_DEFAULT_*_MODEL` 可指。

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
| OpenAI 兼容（GPT/GLM/Kimi/DeepSeek/Ollama/vLLM/One API…） | `modelType:'openai'` 或 `CLAUDE_CODE_USE_OPENAI=1` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `OPENAI_MODEL`（最高优先级，透传）或 `OPENAI_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL` 四档 | `OPENAI_MAX_TOKENS` |
| ChatGPT 订阅 | 同上 + `OPENAI_AUTH_MODE=chatgpt` | 设备码 OAuth | Codex 专有后端 | tier 常量（sol/terra/luna） | 不发（Codex 不收） |
| Gemini 原生 | `modelType:'gemini'` 或 `CLAUDE_CODE_USE_GEMINI=1` | `GEMINI_API_KEY` | `GEMINI_BASE_URL`（默认官方） | `GEMINI_MODEL` 或四档（**必须配一种**，无内置默认） | `GEMINI_MAX_TOKENS`（或通用 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，opt-in） |
| Grok | `modelType:'grok'` 或 `CLAUDE_CODE_USE_GROK=1` | `GROK_API_KEY`/`XAI_API_KEY` | `GROK_BASE_URL`（默认 api.x.ai/v1） | `GROK_MODEL` 或映射表 | `GROK_MAX_TOKENS`（同上，opt-in） |
| Anthropic 兼容端点 | `modelType:'anthropic'` + baseURL | `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL` | `ANTHROPIC_MODEL` 或四档 | （Anthropic 路径原生管理） |

国产模型（DeepSeek / 智谱 GLM / 千问 / MiMo）走 OpenAI 兼容矩阵；`/login → China LLM Providers` 有内置 preset（baseURL、模型表、Coding Plan 专用端点）。

**一个 key 配的是整个供应商，不是一个模型。** 流程是「选供应商 →（有 Coding Plan 的再选计费方式）→ 填 API Key → 选各档位模型」：填完 key 之后该供应商的**所有**模型都能用，`/model` 里直接列出来（带官方标签、价格、上下文窗口），随时切换。

最后那一步走的是上面那个共用向导的 Step 2：四个档位各是一个选择器，选项就是该供应商的模型表，**默认值预填 preset 的 `tiers` 映射**（例如 DeepSeek：`haiku`→`deepseek-v4-flash`，`sonnet`/`opus`/`fable`→`deepseek-v4-pro`）—— 一路回车即接受默认，想改哪个改哪个，之后也能用 `/models` 再改。这里**没有「默认模型」字段**，因为那个字段写的是 `OPENAI_MODEL`，见下。

两个键**故意不写**：

- **`OPENAI_MODEL`** —— 它的优先级高于一切，不只压过四个档位别名，连 `/model <具体 id>` 也会被它顶掉（见 `resolveOpenAIModel`）。写了它就等于把会话锁死在一个模型上，正是这次要去掉的行为。
- **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** —— 一个全局值描述不了一份混着不同窗口的模型表（GLM 的 203K 和 205K 就挨在一起）。改为 `getContextWindowForModel()` 按模型从 preset 表里查真实窗口；它排在环境变量覆盖**之下**，所以那个键仍然是唯一的用户纠正入口。

## 三、协议（wire API）

OpenAI 家族有两条线：`OPENAI_WIRE_API=chat`（默认，Chat Completions，打 `<base>/chat/completions`）或 `responses`（Responses API，打 `<base>/responses`）。`OPENAI_AUTH_MODE=chatgpt` 强制 responses；Codex 家族模型（id 含 `codex`、GPT-5 世代）在未显式指定时也默认 responses。

**协议在登录菜单里选，不是表单里的一个字段**：`/login` 有两个并列入口 —— **OpenAI Chat Completions** 与 **OpenAI Responses API**，选哪个就把 `OPENAI_WIRE_API` 写成哪个，后续走的是与其他 provider 相同的两步流（见上一节）。这样命名是因为"OpenAI 兼容"只描述了 chat 那条线，把 responses 塞进同一个表单会让人以为它也是"兼容"模式。

选定的协议对**整条链路**生效：主循环、side query（分类器、标题生成、模型校验等）、WebSearch 的 codex 源共用同一套解析（`resolveOpenAIWireProtocol`）。曾经只有主循环认这个键，side query 一律走 Chat Completions，只支持 `/responses` 的上游会直接拒掉那部分请求。

## 四、模型名解析

- 任意模型名（`glm-4.6`、`kimi-k2`、`deepseek-v4-pro`、`gpt-5.2`、`gemini-3-pro`）**都可透传**：设 `OPENAI_MODEL` 等单一模型键最直接；或设 `ANTHROPIC_MODEL`/`settings.model`（不含 haiku/sonnet/opus/fable 子串的名字原样透传）。
- 含家族子串的名字按 `{PROVIDER}_DEFAULT_{FAMILY}_MODEL` → 内置家族表映射（映射逻辑在 `packages/@ant/model-provider/.../modelMapping.ts`）。

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

配置面：首启向导 / `/login` 各表单的 **Max ctx** 字段（接受 `128000` / `128k` / `1m`）、`/provider` 档案随家族切换、或直接设环境变量。china preset **不再**写这个键 —— 它的模型窗口按模型查表（见上一节）。

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

- reasoning effort：未设置时 `gpt-5.6-sol` 默认 `low`（对齐 codex："Sol is highly capable at lower reasoning efforts"），其余 GPT 模型默认 `medium`。用 `CLAUDE_CODE_EFFORT_LEVEL` 或 `/model` 的 effort 档覆盖。
- `text.verbosity`：responses 线对 GPT 模型默认发 `low`（ChatGPT OAuth 路由与官方 baseURL；第三方网关默认不发）。`OPENAI_VERBOSITY=low|medium|high` 强制指定并对任意端点放行，`=off` 强制不发。
- 内部分类器（side query）对 GPT 模型显式用 `low` effort，不再落到服务端默认 medium。
- `reasoning.summary` 默认发 `auto`。**不发这个字段，流里就一个推理事件都没有** —— 官方原话是"This output will not be included unless you explicitly opt in to including reasoning summaries"。occ 此前只发 `reasoning:{effort}`，于是 GPT 整个思考阶段既没有 thinking 块、spinner 也进不了 `thinking` 状态，看起来就是在发呆。`OPENAI_REASONING_SUMMARY=auto|concise|detailed` 指定详细度，`=off`（或 `0`/`false`/`none`）关闭。端点若拒收这个字段（组织未完成 verification、第三方网关不认），会**自动去掉该字段重发一次并在本次会话内不再尝试** —— 丢掉思考显示远好过丢掉这一轮。side query 恒不发（没有 UI 展示它的思考，而且会挤占本就紧张的输出预算）。

**网络层**（responses 线此前是裸 fetch，无超时无重试）：

- 建流重试：指数退避（200ms 起步、2 倍增长、±10% 抖动、尊重 `Retry-After`），对网络错误/5xx/408/带 `Retry-After` 的 429 重试，默认 4 次，`OPENAI_REQUEST_MAX_RETRIES` 覆盖。
- 空闲看门狗：复用 `CLAUDE_STREAM_IDLE_TIMEOUT_MS`（默认 90s），首事件前 stall 自动重试整个请求。
- responses 线接入代理配置（`HTTPS_PROXY` 等此前在 Bun 下对这条线不生效）；chat 线 SDK 客户端默认重试 0 → 2。

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
