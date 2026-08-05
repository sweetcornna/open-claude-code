# Changelog

open-claude-code(`occ`)的对外发布记录。

格式由应用内「更新说明」的解析器约束（`parseChangelog`，见 `src/utils/update/releaseNotes.ts`）：版本标题必须是 `## <semver>` 或 `## <semver> - <日期>`，条目必须是顶层 `- ` 列表项。嵌套列表会被拍平成同级条目，所以不要用；第一个 `## ` 之前的内容会被整段跳过。新版本小节由 `bun run release <version>` 插入。

## 2.18.0 - 2026-08-05

- **接 GPT 模型不再莫名进计划模式、狂发审查子代理**。为 Claude 设计的提示词里「优先进入计划模式」「尽量主动派子代理」「完成前必须验证」这类措辞会被 GPT 当成硬性命令逐字执行：随手一个小任务也要先计划、每完成一步就派子代理复查、进度被严重拖慢。现在 provider 为 openai 且解析后模型是 GPT 家族（`gpt-*` / 含 `codex`；`/model opus` 这类别名按映射后判定）时，system prompt 末尾追加一段 Codex CLI 风格的执行纪律（简单任务不做计划、禁单步计划、不派子代理自审、验证一次与风险成比例、编辑后不重读文件、压缩最终回复、并行读文件），EnterPlanMode / Agent 工具描述与计划模式指令同步换成克制版。Anthropic 会话与 openai 层跑非 GPT 模型（DeepSeek / GLM 等）逐字节不变。
- **GPT 请求参数对齐 Codex CLI 默认，缓解过度思考**。未设置 effort 时 `gpt-5.6-sol` 默认档从 medium 降到 low（Codex 自家的默认值，其模型说明明确写 Sol 低档已足够强；`CLAUDE_CODE_EFFORT_LEVEL` 或 settings 显式设置始终优先）；responses 线对 GPT 模型默认发 `text.verbosity: low` 收敛回答篇幅（ChatGPT 登录与官方端点默认发；第三方网关用 `OPENAI_VERBOSITY=low|medium|high` 显式开启，`=off` 强制不发）；内部分类器 side query 显式用 low 档，不再落到服务端默认 medium 白白变慢；chat 线打官方端点时改发 `max_completion_tokens`（GPT-5 世代拒收 `max_tokens`），兼容端点维持原样。
- **OpenAI responses 线补上了整个网络容错层**。这条线此前是裸 fetch：无超时、无重试，上游 hang 住只能 Ctrl-C，Bun 下连 `HTTPS_PROXY` 都不生效——「GPT 请求慢 / 卡死」的主要来源。现在建流阶段有指数退避重试（200ms 起步、2 倍增长、±10% 抖动、尊重 `Retry-After`；对网络错误 / 5xx / 408 / 带 Retry-After 的 429 重试，默认 4 次，`OPENAI_REQUEST_MAX_RETRIES` 可调）；SSE 读取加空闲看门狗（复用 `CLAUDE_STREAM_IDLE_TIMEOUT_MS`，默认 90 秒，首包前 stall 自动整请求重试）；代理 / mTLS / 自定义 CA 配置接入；SSE 解析消除长响应下的 O(n²) 字符串搬运。chat 线 SDK 客户端默认重试 0 → 2，并修复单例缓存键忽略重试配置导致的实例串用；ChatGPT token 刷新加 30 秒超时。
- **后台自动更新改为每 5 分钟周期检查（occ 本体与插件）**。此前每会话只在启动后查一次，长会话会一直停在启动时的版本。现在 occ 启动 5 分钟首查、插件 3 分钟首查（错开网络峰值），之后各自每 5 分钟一轮：occ 有新版就静默全局安装并低调提示重启生效；插件对 git 类 marketplace 做 `git pull`，仓库真有移动才重新物化缓存，提示 `/reload-plugins` 即可生效。会话期间再发新版会继续装上，同版本不重装。多开窗口不会成倍打 npm registry：检查时间戳跨实例共享，别的实例刚查过本轮就跳过。`OCC_UPDATE_CHECK_INTERVAL_MS` 调间隔（默认 5 分钟、下限 1 分钟），`DISABLE_AUTOUPDATER=1` 或 `~/.occ.json` 的 `"autoUpdates": false` 全关。

## 2.17.0 - 2026-08-04

- **一次网络波动不再杀掉任务或 agent**。`fetch failed` / `terminated` / 网关的 `Upstream request failed` 此前一次都不重试直接中断：重试框架只认 `APIError` 实例，裸的传输层错误被瞬间判死；流中途断开更是完全在重试范围之外；OpenAI / Gemini / Grok 三方路径连重试层都没接。现在这类瞬时错误统一进入最高 10 次的指数退避（`CLAUDE_CODE_MAX_RETRIES` 单一旋钮），覆盖主循环、Agent 子代理与 workflow agent 的全部 provider；流已经产出内容时不重试（避免同一个工具被执行两次）；TLS 握手失败仍然秒败并给出可操作提示，不会盲烧三分钟。重试倒计时在界面上可见。
- **workflow 引擎与查看器大修**。默认并发 3→6（`OCC_WORKFLOW_MAX_CONCURRENCY` 可覆盖）；agent 失败重试从固定 2 秒一次改为最多 3 次指数退避，面板实时显示 `↻ n/3` 与失败原因，不再出现「token 计 0、几秒就死」的观感；git worktree 锁争用可自愈；kill 掉的 run 不再残留永远转圈的 agent，用户主动停止显示为中性的 ⊘ stopped 而非红色 failed。从任务管理器进入 workflow 详情后按键全部失效的问题（根节点漏了 `autoFocus`）、顶部多余横条（双重画框）、选中行高亮断成两段并逐帧跳变（行布局 + 合成器背景残留双根因）全部修复。
- **终端渲染乱码修复**。长会话切换界面或 compacting 时的叠印、右侧散落的单个字符、残留高亮块，定位到差量渲染器的四个具体缺陷：CJK/emoji 行尾占位格被跳过且无人清除、视口边缘宽字素按码位数误判、背景移除后子树从上一帧缓存把旧高亮拷回来、absolute 浮层部分相交时旧像素回拷。全部修复，并为此前零测试覆盖的差量引擎建立了带终端模型与 SGR 属性断言的回归测试基建。
- **`occ migrate` 支持迁移账号数据**。首启向导选项 1 现在完整迁移官方 Claude Code 的 OAuth 登录、API key 与 API 端点配置（读官方 keychain 不会触发系统弹窗；occ 已有登录时绝不覆盖；迁移后向导自动跳过登录步骤，并提示两个 CLI 共用 refresh token 的轮换风险），plugins / skills / MCP 两种模式都迁移。默认模式剥离一切密钥但保留 `*_BASE_URL` 等端点配置——此前会连端点一起丢；mTLS 的 cert/key 文件路径不再被误剥。新增 `--with-credentials` 支持事后补迁凭据，只回填缺失键、绝不覆盖已改的值。`~/.claude` 全程只读、会话历史永不复制的底线不变。
- **后台 agent 的完成通知即时送达**。此前所有 agent 完成通知要等主 agent 完全停下来才一股脑注入；现在 agent 一完成就排队，主 agent 当前这轮工具调用一结束立即插入。
- **后台 agent 实时 recap**。任务栏现在显示每个后台 agent 正在做什么：逐轮的工具活动（如 Reading src/foo.ts）加上每 30 秒一次的 AI 生成动作摘要（如 Verifying runtime sampler），完成后回落为任务描述。`OCC_AGENT_SUMMARIES=0` 可整体关闭；摘要 fork 有全局并发上限并跳过缓存写入以控制成本。
- **任务栏状态圆点改为语义色**：运行中灰、完成绿、失败红、手动停止黄——此前颜色编码的是「是否选中」，错误态根本没有颜色。
- **子 agent 的任务列表不再混入主 agent**。子 agent 用任务工具建的条目此前直接写进主会话任务目录，17 条任务里混着一堆子 agent 的内部条目；现在按 agent 打标隔离（模型伪造标签会被剥除），主界面、提醒与自动隐藏逻辑全部过滤，teammate 共享任务列表的协作行为保持不变。
- **粘贴不再卡死**。用错误快捷键粘贴图片后一直显示 Pasting text… 且回车失效的问题，根因是图片解析失败的 Promise 从不复位状态，外加 bracketed paste 状态机在缺失结束符时永久锁死键盘等共六处漏洞。全部修复：解析失败降级为文本粘贴、粘贴看门狗自动解锁、Esc 可随时取消（取消后迟到的图片不会再被注入）、剪贴板子进程加 3 秒超时。

## 2.16.0 - 2026-08-03

- **通过网关用 OpenAI 时，prompt 缓存基本没生效**。`prompt_cache_key` 此前只发给官方 `api.openai.com`，而把 OpenAI 挂在 LiteLLM / one-api / new-api / OpenRouter 后面是很常见的部署——没有这个粘性路由键，多轮会话每一轮都可能落到不同的缓存节点上。对一个真实网关实测（5 轮、约 4K token 的稳定前缀、其余变量全部固定）：**发键 75.8% 命中，不发键 18.3%**，逐轮看是「95 / 0 / 0 / 0 / 0」——只有第一次追问命中，之后全落空。现在按协议分开取默认值：`/responses` 恒发（提供这个端点就意味着实现了 Responses schema，这是其中的标准字段）；Chat Completions 仍只发官方端点，因为会拒收未知顶层字段的严格端点（GLM / Kimi / DeepSeek / Cerebras 直连）都在 chat 这条线上。`OPENAI_PROMPT_CACHE_KEY=1` 强制开启（chat 网关场景用它），`=0` 强制关闭。
- **Anthropic 的 1 小时缓存 TTL 此前是一段死代码**。启用它需要一份远端配置，而那份配置在 Anthropic 自家部署之外从不下发，回退值又是空列表——于是所有人都在跑 5 分钟 TTL，包括本来符合资格、且 1 小时写入不额外计费的订阅用户。任何超过 5 分钟的停顿（读个 diff、开个会、等一次长构建）都会把约 20–50K token 的前缀整个重写一遍。现在无配置时回退到一份合理的默认名单（主线程 / compact / SDK / 子 agent），显式下发空名单仍表示全员关闭。新增 `CLAUDE_CODE_PROMPT_CACHING_1H=1/0` 双向覆盖。
- **Gemini 的缓存命中率被算成了实际值的一半左右**。Gemini 上报的 `promptTokenCount` 本身就包含缓存前缀，而 occ 又把缓存部分单独加了一次，命中率算式变成 `缓存/(总量+缓存)`——数学上限只有 50%，一次完美命中的请求也只显示 40% 上下。流式与 side query 两处各有一份实现、各错各的，现在统一到同一套换算。
- **Grok 与 Gemini 的用量从来没落到消息上**。这两条路径在内容块结束时就用流开头的快照建消息，而它们的 token 数要到流的最后几个分片才到——结果每条消息的缓存读取恒为 0，statusline、`/context` 和低命中率提醒全都看不到任何缓存。现在与 OpenAI 路径一致，在流结束时组装。Gemini 顺带补上了此前完全缺失的成本统计（此前 Gemini 会话的花费一直记为 0）。
- **DeepSeek 系模型的缓存一律显示 0%**。DeepSeek 把缓存命中量报在 `prompt_cache_hit_tokens` 上，而 occ 只认 OpenAI 的字段名。现在三种常见写法都识别。
- **Codex / Responses 协议下，模型每一轮都要重新推导一遍思路**。推理模型走 `/responses` 且不在服务端存状态时，上一轮的 reasoning 必须由客户端回放，否则彻底丢失——在工具调用密集的场景里，这恰恰是承载「为什么这么做」的唯一载体。现在请求会索取可回放的推理内容并在下一轮原样送回；assistant 的文本也改成按模型原本的输出形状回放，而不是让模型误以为自己上一轮的回答是用户输入。（实测这一项对缓存命中率是中性的，它修的是连续性，不是缓存。）
- **`/workflows` 面板现在可以选中某个 agent 查看它的状态**。此前一行只有「标记 + 名字 + 两个数字」，一个失败的 agent 就是个无从解释的 ✗，想知道为什么只能手工去翻运行日志。在 agent 列表按 `↵` 或 `→` 进入详情：状态、所属阶段、模型、耗时、上下文与输出 token、工具调用次数；失败时直接给出原因（上下文超长、没产出结构化输出、API 终局错误……）、以及「这是确定性失败，重跑同样的调用不会成功」这类提示；成功时给出返回值预览。详情里 `↑`/`↓` 直接换上一个 / 下一个 agent。另外新增 `f` 循环切换状态筛选（全部 → 运行中 → 已完成 → 失败），列表也重新排版：名字更宽、独立的耗时列、模型名简写。`←` 改为逐级退出（详情 → 列表 → 阶段侧栏），关闭面板统一交给 `Esc`/`q`。后台任务面板（Shift+↓）里的 workflow 详情同步支持同样的手势。
- 文档站改为三语结构（英文 / 中文 / 日本語），每页顶部有语言切换入口。目前中文完整，英文与日文正在逐页补齐——未翻译的页面不会出现在对应语言的导航里，切换器也只显示实际存在的语言，不会把人送到 404。

## 2.15.0 - 2026-08-03

- **`/logout` 此前对非 Claude 账号基本不起作用**：第三方 API key、端点地址和模型设置被当成「配置而非登录态」保留下来，`modelType` 也只在没有可回退配置时才清。于是登出之后下一轮请求照旧打同一个端点、用同一把 key——OAuth 和 API key 两种模式都一样。现在登出会清空整个账户面：Claude OAuth token、ChatGPT / Antigravity 凭据文件、secure storage，以及 settings.env 与 `~/.occ.json` 里全部 provider 键（含 `CLAUDE_CODE_OAUTH_TOKEN`），`modelType` 回到未设置。**`/provider save` 存下的档案会保留**，所以 `/provider use <名字>` 可以一键恢复原来的配置——想留住当前端点设置的话，登出前先存一个档案。登录不受影响：它内部清理旧状态时不动 provider 配置。
- **登录菜单里的「OpenAI Compatible」拆成两条**：**OpenAI Chat Completions**（`/chat/completions`，Ollama / DeepSeek / vLLM / One API 这类）与 **OpenAI Responses API**（`/responses`，Codex 风格服务端、GPT-5 世代）。协议原来是藏在表单里的一个字段，可选项之一叫 Responses——但「兼容」只描述了 chat 那条线。现在选哪条入口就写哪个协议，表单只剩 Base URL 和 API Key，标题会显示实际会打的路径。
- **选了 Responses 协议，仍有一半请求以 Chat Completions 发给上游**。此前 `OPENAI_WIRE_API=responses` 只移动了主循环，分类器、标题生成、模型校验等全部 side query 照旧走 `/chat/completions`——只支持 `/responses` 的上游会直接拒掉这部分请求，而界面上看会话是配置好的。现在整条链路跟随同一套协议判定。顺带给这条线的输出预算兜了下限：side query 默认只要 1024 token，而在 `/responses` 上推理 token 也吃这个预算，推理模型会把它吃光、返回空内容。
- **Gemini 官方搜索源对 Google 登录用户从来没成功过**。Antigravity 后端只服务它自己的模型 id（`gemini-3.1-*`），而搜索用的默认模型是公网 API 的 `gemini-2.5-flash`，每次都被回 404。失败的搜索源会被聚合器静默丢弃，所以表面上「有结果」——那些结果其实全来自免费抓取源。现在搜索按实际路由挑模型。
- **显式点名一个搜索源时（`WEB_SEARCH_ADAPTER` / `settings.webSearchAdapter`），它不知道自己是不是当前 provider**。点名 `gemini` 而会话跑在 OpenAI 上时，适配器会跳过 Google 登录已解锁的 Antigravity 路由、发出空的 API key，直接 403——凭据明明就在磁盘上。`api`（会把 Anthropic 的 web_search 塞进当前 provider 的管线）和 `codex` 有同样的问题。现在点名走与默认聚合完全一致的主路/增强路判定。
- **`~/.codex/auth.json` 只存了 API key 也被当成 ChatGPT 登录**。官方 Codex CLI 用 API key 认证时就往那里写这种文件——文件在、凭据真、但不是 OAuth 登录。此前只判断文件是否存在，于是 codex 搜索源一律走 OAuth 路线并报「ChatGPT account is not logged in」，而一把可用的 API key 闲着。现在校验真正的 OAuth token 字段，没有登录就回落到 API key。
- 清理仓库里 44 个一次性过程文档与历史归档（`progress.md`、`DEV-LOG.md`、若干审计与交接记录、已完成功能的规格存档）。仅影响仓库，不影响已安装的版本。

## 2.14.1 - 2026-08-03

- **修复子代理完全派不出去：一发就报「子任务嵌套达到上限」**。只要当前这一轮已经调用过 3 次工具（读文件、grep、跑命令——日常几乎必然），接下来无论派哪种子代理、哪怕只派一个，都会被拦下并提示嵌套深度超限，而实际上一层嵌套都还没有。原因是深度守卫读错了计数器：它拿的是「本轮对话的 API 往返次数」（每调用一次工具就 +1），而不是「子代理嵌套层数」。Workflow、Skill 以及斜杠命令派生的子代理走的是同一条路径，同样中招。现在按真实嵌套层数计数，默认仍允许 3 层，`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 照旧可调。

## 2.14.0 - 2026-08-03

- **安全：项目里的 `.occ` 符号链接可以把 workflow 的写入重定向到项目外**。路径拼接是词法的，对 `<project>/.occ` 其实是个指向别处的符号链接一无所知——克隆一个带这种链接的仓库，模型生成的 inline workflow 脚本就会被写到仓库作者选定的位置。现在写入前会解析真实路径并确认仍在项目内，正常项目不受影响。（对照官方对 `.claude` 同类问题的修复逐条核查 workflow 模块时发现。）
- MCP 服务器连接成功后打印到 stderr 的启动横幅不再被记成错误。stdio 传输下 stdout 是 JSON-RPC 通道，stderr 是服务器唯一能打日志的地方，规矩的服务器都会在那里打一行 banner——此前连接明明成功了，日志里却每次都留下一条 error，让每次启动看起来都有一堆失败。

## 2.13.3 - 2026-08-03

- **Antigravity / Gemini 登录失败时终于说得清哪里出了问题**。此前不论是网络不通、TLS 被拦截还是代理挂了，界面一律只显示 `login failed: fetch failed`——Node 的 fetch 在传输层失败时消息恒为这两个词，真正的原因（`ECONNREFUSED`、`ENOTFOUND`、TLS 握手失败等）放在 `error.cause` 里，而这一层被丢掉了。现在会告诉你是哪一个 Google 主机、卡在哪一步（换取令牌 / 账号查询 / 项目发现）、底层的具体错误码，并提示可以设 `HTTPS_PROXY`。如果你之前登录 Gemini 搜索源失败又不知道原因，升级后重试一次就能看到真正的报错。

## 2.13.2 - 2026-08-03

- 修复发版脚本写 CHANGELOG 时会吞掉空行，导致从第二次发版起版本小节在「更新说明」里静默消失。标题被粘到前一行末尾后解析器就看不见它了，而这个过程不报任何错——v2.13.0 的说明就是这么差点变成空白的。这条只影响发布流程本身，对已安装的版本没有影响。

## 2.13.1 - 2026-08-03

- 修复 `occ migrate --help` 会**真的执行一次迁移**：帮助请求此前被迁移的快速路径拦下当成了「没有任何参数的真实迁移」，只是想看看这个命令做什么，文件就已经被拷进配置目录了。现在 `--help` 正常打印用法，不再有副作用。

## 2.13.0 - 2026-08-03

- **从官方 Claude Code 迁移时可以不带走账号绑定的数据**：换账号的场景此前只有「全迁」或「不迁」两种选择。凭据和会话历史本来就永不复制，但已安装的 plugins、skills、MCP server 定义，以及 `settings.json` 里的 `env`、`apiKeyHelper`、`awsAuthRefresh`、`forceLoginMethod`、`enabledPlugins`、`extraKnownMarketplaces` 仍然绑定着上一个账号。现在首启向导的迁移步骤多了一个「跳过账号数据」选项，命令行也支持 `occ migrate --skip-account-data`；主题、权限、agents、commands、workflows、rules 和 CLAUDE.md 照常带走。MCP server 是整条排除而不是抹掉密钥——只清空会留下一个看着已配置、一用就失败的条目。排除了什么会在迁移前逐条列出，不会静默丢弃。默认行为不变。

## 2.12.0 - 2026-08-03

本次是一轮以安全和数据安全为主的集中修复，另有一个能明显改变日常体验的新默认行为。升级后建议看一眼下面前四条——它们会改变你已有的使用方式。

- **插件市场默认可用**：首次启动会自动装上官方的 `claude-plugins-official`，`/plugin` 里能浏览安装的插件从 27 个变成 300+。此前它只在「你已经启用了引用它的插件」时才会安装，等于新装的机器永远等不到。不想要可以 `occ plugin marketplace remove claude-plugins-official`（移除会记住，不会自己装回来），或设 `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`。
- **`/issue` 不再默认上传对话内容**：以前只要带标题，最近 5 轮对话和 3 条工具错误就会未经脱敏、无预览地进 issue 正文——对公开仓库等于当场公开路径、代码和错误里的 token。现在默认只发标题和模板，要带上下文得显式 `--include-context`，它会先给出脱敏预览，再确认才上传。
- **`/provider` 切到 Bedrock / Vertex / Foundry 后请重新确认**：此前这几个云供应商只写环境变量、不清理已保存的 `modelType`，而后者优先级更高——命令提示切换成功，请求却仍然发往原来的 OpenAI 等供应商，代码和费用流向你以为已经退出的服务。已修复；如果你之前切换过，建议重新执行一次并核对 `/status`。
- **`FEATURE_<NAME>=0` 现在真的会关闭功能**：以前 dev 和发布构建都只判断环境变量存不存在，写 `=0`、`=false` 反而把功能编了进去。现在 `1`/`true` 开、`0`/`false`/留空关，且能用来关掉默认启用的 flag。
- 修复 `/update-config`（以及任何走 settings JSON Schema 的路径）一加载就报 “Undefined cannot be represented in JSON Schema” 而中断。
- 修复远程会话拉取失败时会清空本地对话记录：网络抖动或登录过期都可能让已有 transcript 被截断且不可恢复。现在只有确认成功或远端确实为空才会覆盖本地文件。
- 安全：MCP 服务器返回的工具描述与提示词此前只过滤控制字符，零宽字符、双向覆盖、Unicode Tag 等可以藏进模型能读、你看不见的指令。现已按完整规则清洗。
- 安全：MCP 提供的 skill 不再能通过 frontmatter 隐式索要工具权限或注册可执行 hook——你批准的只是「使用这个 skill」。同时限制了单个服务器的 skill 数量与体积，避免恶意服务器拖垮启动。
- 安全：插件市场保留名（如 `claude-plugins-official`）的来源校验此前用字符串包含判断，`https://evil.example/github.com/anthropics/fake.git` 能冒充官方；且恶意来源在被拒绝之前就已覆盖了本地官方缓存。两处均已修复。
- 安全：`occ` 安装时下载的 ripgrep 现在校验 SHA-256 才会安装，并移除了失败自动回退第三方镜像的行为。
- 安全：团队协作中，普通成员伪造的控制消息此前可以往其他成员的会话里注入工具授权规则（如 Bash、Write），现已校验发送方身份。
- 安全：不再把凭据写进日志与终端——`mcp add --header` 曾原样打印 Authorization 和 API key，MCP 日志只过滤 `Authorization` 而漏掉 Cookie、X-API-Key 及 URL 里的 token，`/doctor` 会原样回显带 token 的浏览器地址。
- 安全：企业策略边界修复——项目或用户配置不再能扩宽管理员设定的模型白名单（空名单现在真的表示全部禁止），`--setting-sources` 也不再能改变策略的优先级顺序。
- 修复 `/share` 在 Gist 失败回退到公开图床时，仍向你显示 “Visibility: secret”。
- 修复预发布版本（如 `2.11.0-beta.1`）用户永远收不到正式版更新——版本比较忽略了预发布标识，`occ update` 一直认为已是最新。
- 后台会话修复：tmux 模式下 `attach` 找不到会话、`daemon logs` 拿不到日志；日志轮转后 tail 会长时间漏读；陈旧的 PID 记录可能让 `daemon kill` 误伤无关进程（现在无法确认身份时会拒绝发送信号）。
- 工作流修复：`resumeFromRunId` 未做校验，特制的 run id 可以删除任意目录；journal 中任意一行损坏会导致整段历史被当作不存在、恢复时重跑全部 agent（重复计费）；分歧时不再删掉整个 run 目录和其中的 inline 脚本。
- 其他稳定性修复：MCP 工具调用现在会响应取消与超时；超大 MCP 输出在计数失败时不再放行；本地密钥库并发写入不再静默丢失；LSP 关闭无响应不再卡住退出；写日志失败不再让 CLI 崩溃。

## 2.11.0 - 2026-08-03

- 修复 Ctrl+C 无法退出、进程卡死的问题：关闭流程的兜底保险丝提前布防，任何一步卡住时再按一次 Ctrl+C 都会立即强制退出；首启向导、信任对话框等界面双击 Ctrl+C 也能干净退出，不再挂死。
- ChatGPT / Antigravity 登录的等待授权界面按 Esc 现在可以返回登录方式选择，取消后设备码轮询立即停止，不再空转等待。
- OpenAI Compatible 登录改为两步式配置：第一步填 Base URL、API Key 并选择 Wire API 协议（Chat Completions 或 Responses，选项带完整说明）；occ 随后自动拉取服务器的可用模型列表，第二步的默认模型与 Haiku/Sonnet/Opus 档位直接从列表中选择，拉取失败自动降级为手动输入并显示原因。
- 登录配置界面文案全面去缩写：「Max ctx」统一改为「Max context tokens」并附完整说明，Anthropic Compatible / Gemini / Grok 表单同步更新。
- ChatGPT 订阅模型描述对齐官方文档：标注 gpt-5.4 / gpt-5.4-mini 将于 2026-08-31 退役及替代模型，gpt-5.2 / gpt-5.3-codex 在 ChatGPT 登录下已弃用。

## 2.10.0 - 2026-08-03

- 网页搜索改为多源聚合：同一次搜索可并行查询多个搜索源并合并结果，新增 `/search-setting` 面板管理各源的启用状态与凭据；同时移除内置的 tavily 源。
- 新增 Antigravity OAuth 登录：`/login` 里可直接用 Antigravity 账号授权，内置 installed-app 客户端凭据，授权完成后自动写好 provider 配置，不用再手填 base URL 和模型名。
- 模型选择器会自动同步上游可用的模型列表，新模型上线后无需等待版本更新或手动填写模型名。
- occ 自身与插件市场支持静默自动更新：交互会话启动后在后台检查新版本，安装成功后只在右下角显示一条低调提示，失败时只写调试日志、不打断会话。
- 默认接入官方 claude-code 插件市场，安装后即可浏览和安装插件，无需手动添加市场地址。
- 新增 ultracode 思考层级：`/effort` 多出一档更高强度的推理模式，并按当前模型映射到各家 API 各自的 effort 参数。
- 计划模式的批准对话框新增 auto / bypass permissions 运行选项，批准计划时就能选定后续执行的权限模式。
- 提示词缓存命中优化：长会话中重复的上下文更容易命中缓存，降低响应延迟与 token 费用。
- Codex 家族模型默认走 responses 协议，订阅额度与计费信息显示正确。
- 应用内「更新说明」改为读取 occ 自己的 CHANGELOG，此前错误地显示官方 Claude Code 的日志。
- 移除 `/mode` 人格子系统与 buddy 桌宠模块。
- 文档全量更新为社区版定位，覆盖上述新特性。

## 2.9.0 - 2026-08-02

- 首个对外发布版本：社区版 open-claude-code(`occ`)发布到 npm(`@sweetcornna/open-claude-code`)，与官方 Claude Code 完成用户态隔离，两者可装在同一台机器上互不干扰。
