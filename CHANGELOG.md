# Changelog

open-claude-code(`occ`)的对外发布记录。

格式由应用内「更新说明」的解析器约束（`parseChangelog`，见 `src/utils/update/releaseNotes.ts`）：版本标题必须是 `## <semver>` 或 `## <semver> - <日期>`，条目必须是顶层 `- ` 列表项。嵌套列表会被拍平成同级条目，所以不要用；第一个 `## ` 之前的内容会被整段跳过。新版本小节由 `bun run release <version>` 插入。

## 2.23.0 - 2026-08-05

- **自动更新装完之后会话卡死、Ctrl+C 也退不出去，这次找到了真正的原因**。2.22.0 按「子进程吊住退出」修过一次，方向错了 —— 那条链修好之后问题照旧。真正的成因在产物形态上：occ 的 dist 是 **595 个内容哈希命名的 chunk**，会话在整个生命周期里持续惰性 `import()` 它们（这个代码分割是把 `--version` 的 RSS 从 966MB 压到 35MB 的前提，不是可选优化）。而 `npm|bun install -g` 会**删掉**它替换的那个包目录，相邻两个版本之间**大约半数 chunk 的文件名会变** —— 实测 2.21.0 → 2.22.0 是 595 个里消失 299 个。于是「后台装好新版本」这一步，等于把正在运行的那个会话剩余一半的代码从磁盘上抹掉：此后任何一次惰性 import 都抛 `ERR_MODULE_NOT_FOUND`，而症状不是崩溃、是**卡死** —— 界面不再响应，Ctrl+C 走不到退出路径，只能另开终端杀进程。官方 Claude Code 敢原地替换自己，是因为它是单文件产物、启动时就整体读完了；occ 不能。**现在后台更新只查版本、只排队，真正的 `install -g` 在会话退出之后由一个 detached 子进程完成**，提示文案相应变为 `✓ Update vX.Y.Z ready · installs on exit`。这不损失任何东西：老实现装完也只能提示「Restart to apply」，运行中的进程本来就无法采用新版本。**多开会话由最后退出的那个负责安装** —— 每个会话在 `~/.occ/live-sessions/<pid>` 登记自己的安装树，排队的安装在动手前先确认没有别的活会话跑在同一棵树上，否则受害的只是换成另一个会话；pid 已消失的登记条目顺手清理，崩溃的会话不会永久挡住更新。最后加了一道兜底：手工 `occ update` 或另一个终端里直接 `npm install -g` 仍然会原地替换，这种情况现在会打印一行说明并干净退出，而不是留下一个按什么都没反应的界面。
- **首启向导和 `/login` 的表单里可以直接配 `fable` 档模型了**。四档模型（haiku / sonnet / opus / fable）在 2.19.0 就已经打通，但表单里只有前三档的输入框，想给 fable 指定第三方模型只能退出 occ 去改环境变量。现在 OpenAI（`Fable tier model (optional)`）、Anthropic 兼容与 Gemini（`Fable` 行）三个表单都补上了对应字段，位置排在 Opus 之后 —— fable 是最高档。留空按原有回落链走（provider 专属键 → `ANTHROPIC_DEFAULT_FABLE_MODEL` → 该 provider 的主模型键），Gemini 那条「填 Model 或三个档位全填」的校验不含 fable，既有配置不受影响。
- **移除内置的 teach-me skill**，连同它在仓库根的学习记录目录。

## 2.22.0 - 2026-08-05

- **OpenAI 兼容端点的缓存命中率：把最大的那根杠杆默认打开**。粘性路由键 `prompt_cache_key` 是 OpenAI 侧影响最大的一项 —— 实测发与不发是 **75.8% 对 18.3%** 的累计命中率差（不发时只有第一次追问命中，之后每轮都落到不同的缓存节点）。但此前 Chat Completions 这条线只把它发给官方 `api.openai.com`，理由是严格端点会 400 拒收未知顶层字段。代价是：**最需要它的人群默认关着** —— 把 OpenAI 挂在 LiteLLM / one-api / new-api / OpenRouter 后面的用户，除非正好读到文档去设 `OPENAI_PROMPT_CACHE_KEY=1`，否则一直跑在 18.3% 那条线上。现在改为乐观发送、被拒即降级：端点若以"未知字段 / 不支持 / 不允许额外输入"之类措辞拒收，occ 去掉该字段重发一次并在本次会话内不再发给非官方端点。真会拒的端点每会话付一次失败请求，只是忽略未知键的端点（兼容生态里的绝大多数）什么都不付。`OPENAI_PROMPT_CACHE_KEY=0` 彻底关闭，`=1` 即使被拒过也强制发。附带修正一处会算错的账：`cache_creation_input_tokens` 的归属此前跟着"有没有发 key"走，而 `cache_write_tokens` 是 OpenAI 独有的 usage 字段，现在改为按端点判定 —— 兼容端点即使回显这个字段也不采信。
- **后台静默更新：中途关掉再打开会失效、Ctrl+C 会卡住，都修了**。**其一**，此前任何一种"本轮跳过"都会把整条检查循环终结掉。跳过原因其实分两类：本进程内不可能再变的（`NODE_ENV`、安装形态）终结循环是对的，但用户中途可以改回来的（`~/.occ.json` 的 `autoUpdates`、`DISABLE_AUTOUPDATER`）不该 —— 结果是会话里用 `/config` 重新打开自动更新根本不生效，必须重启。现在只有前者退休循环。**其二**，Ctrl+C 会被更新进程吊住：定时器本身是 `unref()` 的、从不保活进程，但它拉起的子进程会 —— `npm install -g`（上限 120 秒）、`npm view`（10 秒）、每个插件 marketplace 的 `git fetch`（30 秒），全都没绑中止信号。于是退出要等满 5 秒的兜底 failsafe 再硬杀，还会把 npm 安装孤儿在半路。现在这些子进程都挂在会话的中止信号上，Ctrl+C 直接取消在飞的那个，事件循环自然排空；插件那条还会在 marketplace 之间检查一次，取消之后不再起新的。
- **更新检查节奏改为 30 分钟一轮，启动 1 分钟后先查一次**（原本是 5 分钟首查、每 5 分钟一轮）。首查提前是为了让紧跟在一次发布之后启动的会话不必等满一个周期；不设为零是因为启动是进程最忙的时刻，一次 `npm view` 会和用户真正在等的东西抢资源。插件那条的首查仍是 3 分钟，维持与本体更新的错开；两条用同一个间隔，所以这个错位在整个会话期间都保持。`OCC_UPDATE_CHECK_INTERVAL_MS` 的默认值随之变为 `1800000`。
- **删掉一整套早已不再运行的更新器代码**。`AutoUpdaterWrapper` / `AutoUpdater` / `PackageManagerAutoUpdater` / `NativeAutoUpdater` 在后台更新服务化之后就没有任何地方渲染了，只剩隔离测试把它们的源码当文本读。死的还不止组件：从 REPL 一路传到 `Notifications` 的那四个 prop 一进函数就被改名丢弃，因此 setter 从未被调用、REPL 里那个 state 恒为 `null`、挂在它上面的 effect 从不执行。整条链连同 `useUpdateNotification` 一并移除，隔离断言改指向真正在跑的服务模块。（无用户可见行为变化。）

## 2.21.0 - 2026-08-05

- **`/goal` 不再被一次网络抖动判死**。此前只要出现一次 `API Error: fetch failed`，活跃目标就会被自动 pause，而且没有任何东西会再把它放回来。真实会话里的形态是这样的：09:05 设下的目标，10:15 因一次连接错误暂停，之后 5 个小时全程手动驱动，状态一直停在 paused —— 用户看到的就是"目标分明没完成，它却停下来了"。现在失败先分类再处理：网络类退避重试（10 秒 → 30 秒），**连续 3 次**才暂停；配额类立刻停（多跑几轮买不到额度）；认证 / 计费类需要人介入；其余 400 一类不计入错误预算，下一轮照常继续。暂停原因也记下来了，"你按的暂停"永远不会被自动撤销，"网络按的暂停"则在下一次请求成功时自己恢复。`/goal` 的状态输出会说明当前属于哪一种。
- **`/goal` 现在真的能标记完成了**。每一轮 goal-steering 提示词都在要求模型「use the GoalTool to mark it complete」，但 GoalTool 是延迟加载工具，压根不在模型的工具表里 —— 等于让模型去调一个它看不见的东西。后果是目标永远到不了终态，只能一路空转到轮次上限。现在存在活跃目标时该工具不再延迟加载（没有目标的会话不受影响，不用为它的 schema 付费）。另外 `Goal auto-continue (2/1)` 和 max-turns 提示里写死的 `1` 也修了 —— 上限早就是 150，显示得像刚开始就已经超限。
- **新增 DeepSeek 专属调优，只在请求 DeepSeek 模型时生效**。判定条件是模型 id 含 `deepseek`，或 baseURL 指向 `api.deepseek.com`（网关把模型改名成 `default`/`coder` 时仍能命中）；两者都不满足时请求体与改造前逐字节相同，GLM / Kimi / Qwen / MiMo / 本地 vLLM 完全不受影响。**temperature 未指定时补 `0`** —— DeepSeek 不传参的默认值是 `1.0`，而官方参数指南把 `1.0` 归给"数据分析"、代码与数学的推荐值是 `0.0`，occ 是编码 agent，此前每一次请求都比官方建议采样得烫得多（`DEEPSEEK_TEMPERATURE` 可单独退出，thinking 模式下不发）。**工具表截断到 128**：官方硬上限，超出整个请求被拒，挂几个 MCP server 就能顶到；截尾部，保住排在前面的核心工具。**thinking 开关两个方向都显式发**：DeepSeek 的 `thinking` 字段默认就是 `enabled`，此前只发"开"不发"关"，于是 `OPENAI_ENABLE_THINKING=0` 对官方端点根本没生效过。**`reasoning_effort` 接上 `/model` 的 effort 档**：这个字段此前只发给 OpenAI 推理模型，DeepSeek 的 effort 选择器是纯装饰、实际永远跑默认 `high`；现在按 DeepSeek 的 low/high/max 三档折叠 occ 的五档（medium 映射到 high —— 不发就等于 high，映射到别处会悄悄改掉所有存量用户的行为）。
- **DeepSeek thinking 模式下的两个具体故障修好了**。其一是多轮工具调用返回 400 `reasoning_content ... must be passed back to the API`：thinking 模式要求带 `tool_calls` 的 assistant 轮必须原样回传 `reasoning_content`，而"保留已有 thinking 块"并不够 —— 被 compact 改写过的历史、thinking 开关打开之前记录的轮次、本地合成的消息都会走到没有 thinking 块的分支，字段就这么消失了；现在这类轮次补空串（langchain、opencode、goose、anything-llm 收敛到的是同一个修法）。其二是**可见回答会被追加进思维链**：DeepSeek 会在多步之间穿插推理，也就是 文本 → 推理 → 文本 是真实顺序，而流适配器开 thinking 块时不关已经打开的文本块，后续文本增量就打进了 thinking 块里，文本块还要拖到流末尾的兜底清理才关上。
- **修复检测不到 GPT 正在思考**。整条链路其实是通的 —— 适配器认得推理事件、渲染层认得 thinking 块、spinner 认得 thinking 状态 —— 唯独请求里从来没发过 `reasoning.summary`，而官方明确写着不显式 opt-in 就不返回任何推理内容。于是流里一个推理事件都没有，GPT 在干最重活的那段时间看起来像在发呆。现在默认请求 `summary: auto`，`OPENAI_REASONING_SUMMARY` 可指定详细度（`auto`/`concise`/`detailed`）或关闭（`off`）。端点若拒收这个字段（组织未完成 verification、第三方网关不认），会自动去掉它重发一次并在本次会话内不再尝试 —— 丢掉思考显示远好过丢掉整轮；无关的 400 照常抛出。内部分类器恒不发：没有 UI 展示它的思考，而摘要会挤占那条路径本就紧张的输出预算。

## 2.20.0 - 2026-08-05

- **终端乱码 / diff 背景越界修好了，成因是宽度在 Node 下算错**。`color-diff` 自己判定显示宽度：有 Bun 用 `Bun.stringWidth`，否则回退 `str.length`。而 `occ` 的默认入口是 `dist/cli-node.js`（node），**回退分支才是绝大多数用户实际走的路径** —— 一个 CJK 字符按 1 算而终端占 2 格，于是补白算多：删除行的红条溢出右边缘、新增行的绿条短一截，宽字符行尾还会留下残影。改为直接复用 Ink 的 `stringWidth`（下游负责排版的同一个函数），两边不可能再对不上。同时修了换行按码点而非字素簇切分：`❤️` 是 U+2764 + 变体选择符，两个码点合计宽度 1 而实际占 2 格，ZWJ emoji 同理 —— 按码点会把行塞爆，还会把变体选择符/ZWJ 拆到下一行。**这一条也是 2.19.0 里「残影问题还没结案」的后续**：那次的模糊测试证明了增量渲染路径本身是干净的，成因确实在别处，就是这里。
- **调用 Monitor / DiscoverSkills 这类工具不再报「缺少参数 / 多了参数」**。延迟加载的工具不进 API 的工具列表，模型能看到它们参数的唯一渠道是 `SearchExtraTools` 的返回文本 —— 但那份索引只读 MCP 工具才有的 `inputJSONSchema`，内置工具用的 zod schema 一直是空的。于是模型只能按工具名猜字段，而真正执行时又拿完整 schema 严格校验（多一个键都拒）。`DiscoverSkills` 少 `description`、多 `query`，`Monitor` 多 `task_id`，都是这么来的：不是模型犯错，是接口从没把参数契约交出去。另外 `discover:` 那条路径本来就拼好了 schema 文本，却在返回前原样丢弃，从没生效过。三条查询路径现在统一带上参数表（含必填项与「不接受额外字段」）。
- **一条 Bash 失败不再连坐取消同批其他工具**。此前任一 Bash 非零退出就会中止同批全部未完成的调用，而批次是按顺序派发的 —— 等于第一条命令的退出码决定其余全部的命运，且它们是在**开始执行之前**就被取消的。实际后果：一个 `gh release view` 查不到 tag，能把三条毫不相干的 ssh 诊断全部抹掉，每条只回一句 "Cancelled"。非零退出本身也不可靠地等于出错（`grep` 无匹配、`test`、`diff` 都按设计返回非零）。现在只在失败命令真的会改工作目录时（`cd`/`pushd`/`popd` —— 跨命令持久的唯一状态）才取消后续，取消文案也改成说明「未执行、请重跑」。
- **思考到一半断网不再直接废掉整轮对话**。连接在模型思考阶段断掉时，错误分类和退避重试本来都是对的，却被一道防重复执行工具的护栏挡住了 —— 那道护栏把「已产出思考内容」也算作「已经做了不可撤销的事」。思考既不回放给用户也不启动任何工具，断在那里没有任何东西需要担心重复。现在这种情况会正常重试；已经上屏的文本和已经开始成形的工具调用仍然照旧不重试。
- **按 Esc 打断不再冒出一条红色的 `API Error`**。OpenAI / Gemini / Grok 三条第三方链路的错误兜底完全没有区分「用户主动取消」，于是主动打断会得到一条看起来像故障的报错，还会留在对话历史里被模型读到。首方链路的判定也漏了被中间层包装过的取消，一并收口。
- **新增 `auto` 主题，跟随终端明暗自动切换**。`/theme` 与 `/config` 里多一档「Auto (match terminal)」。判定依据是终端的**背景色**（OSC 11 查询），不是系统外观设置 —— 浅色系统里开着深色终端，仍然应该用深色配色，否则字压根看不清。终端不应答查询时自动停止探测，不会持续空跑。
- **内部重绘不再清空终端的滚动历史**。渲染器因为窗口尺寸变化、内容超出视口、旧版 Windows 控制台自愈等原因触发整屏重绘时，用的是一段**包含清除滚回缓冲**的序列。也就是说：一次用户根本没要求的内部重绘，会把整个会话往上翻的历史全部销毁、并把视口弹回顶部 —— 这正是「某些终端里点一下右键就回到顶部」的成因。重绘现在只擦可见屏幕，滚动历史原样保留。

## 2.19.0 - 2026-08-05

- **模型档位从三档扩到四档，新增 `fable`；`sonnet` / `opus` 升到 Claude 5 世代**。`/model` 里现在是 haiku < sonnet < opus < fable：`fable` 解析到 `claude-fable-5`（$10 / $50 每 Mtok），定位在 opus 之上，面向最难的推理与长跨度 agent 任务；`sonnet` → `claude-sonnet-5`、`opus` → `claude-opus-5`，Opus 4.7 作为「上一代」选项继续留在 picker 里。四个档位都支持 `[1m]` 后缀，effort、adaptive thinking、1M 上下文的能力判定与定价、成本统计一并跟上。第三方 provider 侧新增 `ANTHROPIC_` / `OPENAI_` / `GEMINI_` / `GROK_DEFAULT_FABLE_MODEL` 四个键（`/provider` 档案与托管 env 白名单同步），未配置时回落到该 provider 的主模型键；子代理配置里的 `model:` 也认 `fable`。**`best` 仍然解析到 `opus` 而不是 `fable`** —— 跟过去会把所有用 `best` 的既有会话静默换到贵一倍的档位。另外 Opus 5 的 fast mode 是 $10 / $50，与 Opus 4.6 fast mode 的 $30 / $150 分开计价，不会再按后者估算花费。
- **终端残影：增量渲染路径已经被随机化回归测试证明是干净的，但问题还没结案**。2.17.0 修掉四类叠印/残影之后仍有偶发反馈，因此给差量引擎补了一套种子化的多帧模糊测试：随机帧「链」跑真实渲染管线进终端模型，每帧之后逐格比对内容。残影几乎都是跨帧继承型 —— 某一帧漏刷一格，引擎认定它已经正确，之后再也不会回访，旧字符一直活到全量重绘；只比较两帧的用例看不见这类问题，第三帧才定型。400 链 × 5 帧 + 100 链 × 20 帧全部通过，覆盖 CJK、ZWJ emoji、需要宽度补偿的 emoji 以及行尾放不下的宽字符。**这一条不是修复**：结论是非滚动、无样式的增量路径没有问题，成因收敛到滚动（内容高于视口）、带背景样式的单元格、blit 快路径、absolute 浮层与 resize 这几条路上，排查继续。
- **README 默认语言改为英文，并新增日文版**。`README.md` 现在是英文，中文移到 `README.zh.md`，另有新的 `README.ja.md`，三份互相挂语言切换行 —— 此前 GitHub 首页是中文，而且中文 README 里连一个指向英文版的链接都没有。文档站的 `docs.json` 里英文 locale 标着「默认」，导航分组名却全是中文（「开始」「工具：AI 的双手」……），日文 locale 同样显示中文；两边的分组名现在都译过来了，页面路径本来就分别指向各自语言的目录，只有标签是错的。三份 README 的模型表与 `docs/zh/features/providers.md` 也同步了新的四档位（含别名 → 模型 → 定位 → 定价对照表）。

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
