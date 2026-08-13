# Changelog

open-claude-code(`occ`)的对外发布记录。

格式由应用内「更新说明」的解析器约束（`parseChangelog`，见 `src/utils/update/releaseNotes.ts`）：版本标题必须是 `## <semver>` 或 `## <semver> - <日期>`，条目必须是顶层 `- ` 列表项。嵌套列表会被拍平成同级条目，所以不要用；第一个 `## ` 之前的内容会被整段跳过。新版本小节由 `bun run release <version>` 插入。

## 2.44.0 - 2026-08-13

- **Auto Compact 现在真正使用会话级窗口并贯通所有执行路径。** `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`--autocompact <auto|tokens>`、`/autocompact`、SDK `apply_flag_settings`、设置热更新、子 Agent 与后台 handoff 共享同一状态；显式 `auto` 会覆盖持久设置而回到模型默认。compact 触发窗口与模型真实 hard-block 上限分离，较小窗口只会更早摘要，不会提前报 `Prompt is too long`；`/context`、token usage、预警和 1M reminder 也使用相同口径。
- **推理 API 改用单一的 Claude Code 2.1.228 重试内核。** 删除查询级整轮重放和第二套 exhausted 状态，避免 provider 内层重试叠成 10×10 或重复工具副作用；统一错误变换 token、退避、`Retry-After`、fallback、凭据恢复和 `max_tokens` 推进保护。401、AWS/GCP 凭据失败与 stale socket 会重建 client，而不只是清缓存后继续复用旧连接。
- **修复 `UND_ERR_SOCKET: other side closed` 等流中断无法恢复。** OpenAI Responses、Chat、Gemini、Grok 与 Anthropic 流统一按“尚无输出 / 仅 thinking / 已有可见文本或工具调用”处理：首字节前使用正常重试预算，仅 thinking 最多恢复两次；可见输出后只安全结束部分响应，绝不重放已经展示的文本或工具调用。协议字段降级作为唯一变换不消耗网络重试次数。
- **运行中排队消息会在正确的工具轮边界继续处理。** 普通 queued prompt 可折入当前 query chain；当达到 `maxTurns`、构造 attachment 失败或请求已 abort 时不再提前消费，而是完整留给 turn-end processor 自动开启下一轮。query 从 running 回到 idle 后会立即唤醒队列，无需等会话退出。
- **网页与文件读取的安全边界收紧。** WebFetch 的显式 `deny > ask > allow` 规则现在先于内置预批准域名，支持 `domain:*`、`domain:*.example.com`，并规范化大小写、尾点及编码路径边界；FileRead 在任何文件系统访问前阻止 `/proc/<pid>|self/{environ,cmdline,auxv,maps,mem,stat}`，普通 procfs 元数据仍可读取。
- **Headless 会话恢复更准确且可选择 fail-closed。** `--resume` 在 UUID、URL 与 JSONL 解析失败后可按标题精确搜索：唯一命中直接恢复，多命中列出 session ID 和修改时间要求消歧。新增隐藏的 `--resume-drops-turn <user-message-id>` 校验被截断 suffix 必须完整属于指定 user turn；queued command、compact summary、外部 user、系统注入和未知消息都会拒绝截断。
- **文件建议索引不再被旧异步任务覆盖。** FileIndex 使用单调 generation 取消过期 build，只在当前 build 完整结束后提交 signature；Typeahead 使用请求序号判定 stale，修复 `A1 → B → A2` 时最早的 A1 结果覆盖最新 A2。

## 2.43.0 - 2026-08-13

- **Workflow 执行内核改为加固的隔离 VM。** 工作流脚本禁用动态导入、字符串代码生成与 WASM，移除进程、模块加载等逃逸面，冻结内建对象，并在宿主边界严格校验跨 realm 数据、循环引用、访问器和超大数组；计时器由运行实例统一持有和清理。原有 `agent`、`parallel`、`pipeline`、`phase` 与嵌套 workflow 语义保持兼容。
- **Workflow 恢复改为链式检查点与最长前缀重放。** 普通 resume 不再因脚本末尾的展示或后处理改动而丢弃全部已完成调用；首个身份、输出或终态分歧之后才重跑后缀。OCC 的按范围/agent 选择性恢复继续保留，并在脚本身份变化时安全拒绝位置选择器。权限界面同步区分命名、内联、文件、状态与取消操作，持久运行列表读取真实的分目录状态。
- **重新划清 `/model`、`/model-settings` 与 `/provider-settings` 的职责。** `/model` 只改变当前会话，并提供按 default、haiku、sonnet、opus、fable 分槽的临时 effort/context 调整；值只存在于该会话的 AppState，不写配置，也不会影响同时运行的其他会话。`/model-settings` 独占持久模型策略并明确提示全局 `/effort` 的遮蔽关系；`/provider-settings` 统一负责档案与 provider 生命周期，成功切换后会完整重载会话状态。
- **跨 provider 模型选择不再隐式切换凭据。** `/model` 将保存档案中的模型放在独立分组，选中后先显示目标档案、模型和切换影响，确认后才整体替换 endpoint、凭据、wire protocol 与模型策略；脚本调用使用显式的 `/model profile <model-id[@profile]>`。聚合目录会过滤图片、音频、嵌入、实时和审核模型，普通 `/model <id>` 仍只作用于当前 provider。
- **终端前端与长会话恢复能力增强。** Diff 详情支持可配置滚动和实时视口；通知支持 pinned、diff 暂存与统一失效；事件循环长阻塞会记录有界诊断并在睡眠唤醒后恢复终端模式；损坏会话恢复会保留合法 provider 元数据和附件，同时清除无效恢复产物。
- **Agent 与构建边界进一步收紧。** Agent frontmatter 中的 MCP 服务器会拒绝保留名称和内部/IDE transport，日志不再暴露凭据载荷；bundle 完整性检查递归扫描嵌套 chunk，并检测缺失引用与运行时第三方依赖。
- **WebSearch 默认执行超时从 60 秒延长到 3 分钟。** 较慢的多源搜索不再过早终止；`CLAUDE_CODE_WEB_SEARCH_TIMEOUT_MS` 仍可显式调整，设为 `0` 仍可关闭工具级墙钟限制。

## 2.42.0 - 2026-08-12

- **API 重试完全对齐 Claude Code 2.1.227，不再重试确定性失败。** 默认最多重试 10 次、显式配置上限 15 次；连接中断、408/409/429/529 与 5xx 按指数退避恢复，用户取消、证书/TLS 配置错误、计费、权限、无效请求及其他永久 4xx 立即返回。服务端 `Retry-After` 与本地退避取较大值，普通模式要求等待超过 60 秒时终止；官方 `CLAUDE_CODE_RETRY_WATCHDOG` 容量模式保留 300 次预算、5 分钟最大退避、6 小时 reset 等待上限与 30 秒 keep-alive。前台 529 会重试，标题生成、建议与配额探针等后台请求不会放大拥塞。
- **修复 Responses API 报 `upstream_error / stream_read_error` 却没有重新请求。** 错误发生在输出交付之前时会真正重建请求；缓冲型内部读取可丢弃半截文本后恢复完整结果。正文、thinking 或工具调用一旦对终端、ACP 或结构化输出可见，重放窗口永久关闭，避免重复回答和重复执行工具。连续三次 529 的模型 fallback 不再受旧 Opus 限制，Sonnet 与自定义主模型同样可切换。
- **修复 OpenAI 兼容模式保存凭据后无法调用模型。** 用户输入裸域名或带尾随斜杠的地址时，Chat Completions、Responses 与模型目录会一致地使用 `/v1`；显式填写 `/chat/completions` 或 `/responses` 仍保留根路由语义，地址规范化可重复执行而不会改变结果。客户端缓存同时纳入地址查询参数，切换同一路径上的不同连接配置不再复用旧客户端。
- **兼容网关的流完成判定更稳健。** 部分网关会返回实际输出和终态 usage，却省略 `finish_reason` 与 `[DONE]`；现在仅在“已有输出”和“非零终态 usage”同时成立时接受该响应。空流、只有 usage、没有终态证据的半截输出仍按失败处理，不会把截断内容伪装成成功。
- **默认启用 Reactive Compact，并支持有序模型 fallback。** API 因提示词过长拒绝请求时会摘要旧轮次并自动重试；`settings.fallbackModel` 与 `--fallback-model` 可配置按顺序尝试的模型列表，每个新用户回合仍从主模型开始。退役模型提示只在真正提供 Anthropic 模型的目录中出现，并给出已发布的具体替代模型，不再向第三方 provider 展示虚假的营销名称。
- **搜索与文件工具的边界更准确。** Grep 单文件 count 保留路径，Glob/Grep 会区分“没有匹配”与无效输入，绝对 Glob 按真实搜索根做权限检查；Edit、Write 强制遵守 read-before-write 与 Read 拒绝，NotebookEdit 文案改用真实的 `cell_id` 语义，WebFetch 转换时移除脚本、样式与 iframe。Agent continuation 要求可扫读的 summary，AskUserQuestion 不再把 Other 自定义文本当成批准，Bash 的 sandbox override 与 timeout 也经过统一约束。
- **自动模式与沙箱信任边界加固。** 外部 auto-mode 无论用户如何替换 soft-deny 规则，都保留 Claude Code 2.1.227 的完整 Data Exfiltration 硬下限；Anthropic 内置模板保持原样。仓库可控制的 project/local settings 不能关闭文件系统隔离，只有 policy、flag 与 user 设置可请求该放宽；managed filesystem 策略存在时，低信任来源不能覆盖它。
- **`/diff` 在打开期间实时更新。** 工作树文件新增、修改和删除会触发 150ms 合并刷新；监听器避开 `.git` 与 occ 项目资产目录，并覆盖初始读取到 watcher ready 之间的盲区，关闭对话框时完整清理。主题设置同时进入隔离的 `settings.json`，旧 global 配置仍作为 fallback 并在成功保存后镜像；启动时所有宿主渲染路径使用同一 effective theme，`/config` 取消修改可恢复“原本没有 user theme”这一状态。
- **键绑定、认证提示与终端通知同步收口。** 公共 schema/help 补齐 Scroll、FormField、MessageActions、EffortPanel 及全部默认 action，默认绑定从此都有契约测试。`apiKeyHelper` 失败、组织禁用 API key 和服务端临时限流会给出对应处置指引；iTerm2、Kitty 与 Ghostty 通知在组装 OSC 序列前移除 C0、DEL、C1 控制字符，普通 Unicode 保持不变。

## 2.41.0 - 2026-08-12

- **新增 `/background`（`/bg`）与后台会话动词族。** `/background` 把当前会话移交为后台进程继续运行并腾出终端：对话完整随行（以 fork 恢复，原会话记录不动），进行中的回合会在后台重新驱动，确认框会列出将被终止的后台任务——丢失永远可见而非静默发生。新增 `occ stop <id>`（优雅停止，会话仍可恢复）与 `occ rm <id>`（删除后台会话记录与日志；被占用、进程仍在、记录不可读等七类情形会拒绝并说明原因，宁可报错不硬删）。`occ kill` 保持既有的强停升级链。
- **`occ agents` 在终端下变为全部会话的交互列表。** 跨项目列出活动与近期会话，按项目分组、当前项目置顶，行内区分运行中/启动中/已结束；后台会话可 attach、看日志、停止，已结束会话按 Enter 直接恢复。`occ agents --list` 保留原有的 agent 定义输出，管道与脚本调用不受影响。
- **新增 `occ import`：从 Codex 与 Gemini CLI 导入配置。** 确定性扫描 MCP 服务器、指令文件、自定义命令与子代理——外部配置一律视为不可信数据，不由模型自由读取；预览与确认之间用内容摘要绑定，防止确认的与看到的不一致。凭据默认剥离并列出剥离项，导入永远跳过同名项而不覆盖。
- **新增 `--safe-mode`：临时关闭全部自定义，用于排查坏配置。** hooks、插件、skills、自定义命令、statusline 与 CLAUDE.md 全部旁路，认证、模型、工具与权限保持正常。与 `--bare` 定位不同：后者还会收窄认证与工具面。
- **新增 `occ project purge [path]`：清除单个项目的本地状态。** 删除该项目的会话记录与全局配置中的项目条目（信任、历史、项目级 MCP 记录），`--dry-run` 先看清单，`--all` 清全部项目；shell-snapshots 非项目级，不受影响。
- **延迟工具列表不再每轮全量重发。** 延迟加载工具改为增量通告并随对话持久化，提示词缓存断点从此落在可复用的消息上，长会话的缓存命中率显著改善（`CLAUDE_CODE_DEFERRED_TOOLS_DELTA=0` 回退旧行为）。同批修复：ExecuteExtraTool 的内置示例与 CronCreate 实际参数不一致导致照抄必败；搜索不到工具时按 MCP 服务器状态分类说明（连接中/失败/需认证/已禁用）；相关服务器仍在连接时搜索会等待至多 5 秒；新增按服务器的 `alwaysLoad` 配置让指定 MCP 服务器的工具跳过延迟加载。
- **skill 列表进入上下文预算管理，新增 `/skill-doctor`。** 新设置 `skillListingMaxDescChars`（单个描述上限）与 `skillListingBudgetFraction`（列表总预算占上下文比例）；超预算时按使用频率决定谁保留完整描述——常用 skill 优先，所有 skill 始终保留名字、始终可调用。`/skill-doctor` 报告每个已加载 skill 的上下文成本与本会话使用情况，标出从未使用且成本高的项。
- **新增 `/cd`、`/autocompact`、`/pause-memory`、`/wellbeing` 四个会话命令。** `/cd` 移动会话工作目录（新目录未受信时先确认，信任按仓库粒度记忆）；`/autocompact` 查看与调整自动摘要的触发窗口（env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 优先）；`/pause-memory` 暂停本会话的自动记忆；`/wellbeing`（`/breaks`）配置休息提醒与安静时段。`/extra-usage` 新增别名 `/usage-credits`。
- **输入框支持 emoji 短码补全。** 输入 `:name:` 触发建议弹窗与内联替换，内置约 1200 个短码，零外部依赖；`emojiCompletionEnabled: false` 关闭。
- **hook 事件新增 `MessageDisplay` 与 `UserPromptExpansion`。** 前者可改写终端上显示的内容——模型可见历史与会话记录不受影响；后者在 slash 命令或 MCP prompt 展开前触发，可追加上下文或阻止执行，matcher 按命令名匹配。
- **慢 MCP 调用自动转后台。** 超过 120 秒未返回的 MCP 工具调用自动转为后台任务，完成时以通知送达（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` 可调，0 关闭）。新增 `WaitForMcpServers`（等待服务器就绪）与 `RefreshMcpTools`（手动刷新工具列表）两个工具。
- **两处防护加固。** 全局配置写入前重读磁盘，若磁盘副本在竞态中缺失内存持有的登录凭据则拒绝覆盖写，避免被并发写登出；workflow 脚本与参数中的隐藏控制字符（会在审批对话框中不可见的那类）在展示前即被拒绝。

## 2.40.1 - 2026-08-12

- **修复 `/provider-settings` 新增 provider 时看起来被添加两次。** 旧流程会先提议把当前会话自动保存为 `openai` 等家族名，随后又要求为真正要添加的 provider 命名，结果是一次操作留下两份档案。现在选择家族后直接要求命名，只保存新 provider 一次。聚合开关也会在档案尚无模型快照时立即刷新，不再要求另按 `R`；当前 provider 按完整配置识别而非依赖可能过期的活动指针，因此同一端点上的不同账号仍会作为可切换来源出现在 `/model`。
- **所有用户可见的 provider API 错误现在最多重试十次。** 与 Claude Code 的运行时约定一致，一次请求最多是首次尝试加十次重试；网络、限流与服务端错误走退避，认证、权限和无效请求等确定性错误走固定短延迟，内层 SDK 重试保持关闭以免叠成 10×10。`UND_ERR_SOCKET` / `other side closed` 不再显示 `retryable=no`；若错误发生在任何输出送达之前会正常重试，若文本或工具调用已经对外可见则只标记为不可重放并停止，避免重复回答或重复执行工具。

## 2.40.0 - 2026-08-11

- **网页搜索凭据现在默认自动固定，无需再手动按 `S`。** 上一版本引入的固定机制解决了登出与切换 provider 后搜索静默降级的问题，但它必须先被发现才起作用——而降级恰恰是静默的，「该打开面板」的时刻不会自己到来。现在环境中持有可用密钥的搜索源会在启动、打开 `/search-setting`、按 `R` 重新探测、provider 向导保存后自动固定；密钥轮换后自动跟随，内容未变时不写盘（时间戳也不动）。自动路径完整沿用既有的全部拒绝规则：镜像自其他 provider 的凭据、指向非官方端点的 codex 密钥等一概不存。`D` 取消固定并记住该源不再自动固定，`S` 重新固定并恢复自动。
- **Google 与 ChatGPT 登录的搜索凭据在登出后继续可用。** gemini（Antigravity/Google OAuth）与 codex（ChatGPT OAuth）两个搜索源可以完全不依赖密钥，凭据是 occ 自己的授权文件——而 `/logout` 会删除它，搜索随之静默降级，与密钥类凭据是同一个失败形态。固定这两源现在是把授权文件（含 refresh token）复制为搜索自有的 0600 副本：登出照常删除主登录、主循环确实退出账号；搜索经副本继续工作并自行刷新令牌，副本的刷新只写回副本，不会恢复已登出的账号。登出时会明确列出哪些搜索凭据被保留。`search-credentials.json` 的格式未变，无需迁移。

## 2.39.0 - 2026-08-11

- **修复切换 provider 后请求仍发往上一个端点，且只有登出才能恢复。** 标识会话类型的几个环境变量（如 OpenCode 的登录标记）此前在切换档案时可能被留下：清理规则要求变量的当前值仍等于旧配置中的值，这是为了保护你自己在 shell 中导出的设置，但这几个标记只由 occ 写入，且会在每次建立客户端时被读取。于是它们一旦残留，之后每个请求的地址都会被悄悄改写，而配置文件本身完全正常——表现为模型报「不支持」，换模型无效，只有 `/logout` 能收尾，因为登出是唯一无条件清除它们的路径。现在切换档案会直接回收这几个标记；其余变量的保护规则不变。
- **修复模型不被支持时提示为凭据失效。** 部分网关会用 HTTP 401 包裹「该模型不受支持」的响应，occ 此前只看状态码，于是提示登录失效并引导重新配置 provider——而密钥恰恰是有效的，网关正是先通过了鉴权才能查到模型并这样回答。现在响应内容的类型优先于 HTTP 状态，这类错误会明确指向模型而非凭据。
- **provider 档案现在记录各档位的思考强度与上下文上限。** 此前档案只保存端点与模型，切回一个档案会带回它的 provider 却留下上一个 provider 的档位设置——例如从上下文 1M、思考 max 的配置切到 GPT，那些数值会原样套用。现在这些设置随档案一同保存与恢复，并与端点在同一次写入中落盘。切换前保存的旧档案不含这些设置，激活时会将档位恢复为该 provider 的出厂默认值，而不是沿用上一个 provider 的；对这类档案执行一次 `/provider save <同名>` 即可记录当前设置。
- **修复聚合列表重复列出当前 provider 的模型。** 判断依据此前是逐个模型名比对，而 `/model` 自身的列表会过滤掉图像、音频、实时等对话用不到的模型，档案中保存的却是接口返回的完整列表——于是恰好被过滤掉的那些会重新出现在列表末尾，并标注「选中会切换 provider」，而你本就在这个 provider 上。现在当前会话所属的档案不再贡献任何行。其他 provider 提供同名模型仍会列出并标注归属。
- **网页搜索的 codex 源支持固定独立凭据。** 此前四个搜索源中只有它无法固定——该路径的认证在请求内部完成，没有凭据注入口，允许固定会让这一行显示为已连接却无法真正使用。现在请求层接受成对的密钥与地址，codex 与其余三个来源行为一致，登出与切换 provider 都不会影响它。地址与密钥必须成对传入，不会回退到会话当前的地址，避免固定的凭据被发往此后改指的端点。
- **修复 Gemini 会话中部分工具导致整个请求被拒。** Gemini 要求工具参数的顶层描述一个对象，并且实测其接口拒绝任何与 `anyOf` 并列设置了其他字段的结构（该限制未见于官方文档）。Workflow 工具以及 MCP 服务器提供的联合类型参数此前都以这种形状发出。现在在发往 Gemini 的边界处按结构归一化，不按工具名特判——MCP 的 schema 不由 occ 编写，同样的形状随时可能再次出现。运行时校验仍以原始 schema 为准，Anthropic 与 OpenAI 两条线的请求字节不变。
- **修复 `/search-setting` 中 codex 首次登录输入配对码失败。** 面板此前只提示「打开链接并输入配对码」，读起来是一个动作；而该页面在未登录时会先跳转到登录流程，输入配对码的表单要登录之后才出现——首次使用的用户会把配对码输入到登录页。现在分两步呈现、自动打开浏览器，配对码有独立的展示位置不会被其他提示覆盖（此前想找回它只能取消重来，而取消会作废该配对码），并说明短横线是配对码的一部分。

## 2.38.3 - 2026-08-11

- **修复 OpenCode Console 登录后每次请求都返回「Invalid API key」。** Console 签发的令牌属于账号，其推理地址由账号接口下发，与 Zen、Go 是不同的端点；occ 此前把地址写死成产品常量，于是把令牌送到了一个只接受 API key 的地方。同一令牌实测：发往账号下发的地址返回正常结果，发往 Zen 返回 401。现在端点、组织标识与模型列表都从账号接口读取，并保存在账号信息旁而非令牌旁——令牌每小时刷新，跟着令牌保存会让地址在一小时后丢失。从旧版本升级的会话无需重新登录即可自愈。此外，「该模型对你的组织已禁用」此前被归类为认证失败并提示重新登录，而凭据本身完全正常；现在会指明模型名并引导到 `/model`。
- **搜索凭据独立保存，不再随登出或切换 provider 丢失。** 网页搜索此前从主 provider 的环境变量取密钥，而登出会清除这些变量、切换 provider 会整体覆盖它们——于是搜索能力会静默退化到无密钥的抓取模式，且没有任何提示。凭据现在存放在独立文件中（权限 0600，按来源分别保存），登出与切换 provider 都无法触及；未固定凭据的用户行为不变，无需迁移。固定的凭据是真正被使用的，而非仅显示为已配置；捕获自当前环境而非手动输入，因此任何界面都不会显示密钥内容。登出时会保留并明确列出保留了哪些来源。
- **`/provider-settings` 面板支持新增、重命名与聚合总览。** 此前添加一个 provider 必须离开面板、走登录流程再另行保存。现在可在面板内完成，并能看到聚合列表的整体构成——各档案分别贡献多少模型、哪些模型名重复。添加会切换当前会话，这一点在操作前明确告知；若当前配置尚未保存为档案，会先询问是否保存，以便随时切回。
- **修复聚合列表与当前 provider 的模型重复叠加。** 判断「这是我正在用的 provider」此前依赖一个仅在手动切换档案时才写入的指针，通过登录流程配置的会话根本没有它；比较模型时又是拿档位别名与具体模型名相比，两者根本不是同一种东西。现在按配置本身判断归属，并在解析成具体模型后比较。其他 provider 提供同名模型仍会列出并标注归属——那不是重复。
- **合并两组名称高度相似的命令。** `/models-setting` 与 `/model-settings` 合并为后者，`/provider` 与 `/provider-settings` 合并为后者；原有名称全部保留为别名，既有用法与脚本不受影响。合并后 `/model-settings` 在未配置 provider 的会话中也可用，此前该情形会进入死胡同。
- **修复 Responses API 会话在若干轮后持续失败。** 推理摘要项在某些配置下不携带可重放内容，occ 仍将其回放，服务端于是对之后每一轮返回「找不到该条目」。同时修复：省略参数增量或输出序号的网关会导致工具调用参数丢失、推理摘要各段之间缺少分隔而粘连、以及服务端已告知等待时长时仍立即重试。

## 2.38.2 - 2026-08-11

- **自动更新会先并发测速再下载，安装时间从数分钟降到数十秒。** 同一时刻实测，npm 官方源在部分网络上只有 17 KB/s，而公开镜像有 1.1 MB/s——相差 63 倍，一次完整安装因此需要近 6 分钟。更关键的是安装超时原本设为 120 秒而真实安装需要 347 秒，也就是每次都在三分之一处被中止；版本检查的 10 秒上限同样偏紧（冷启动实测 8.85 秒），超时后会被当作「没有可用更新」而只留下一行调试日志。现在 occ 在下载前并发探测候选源、择快者使用，两个上限也放宽到与实测相符。你自己配置过的源始终优先且不参与竞速，occ 不会修改你的 npm 或 bun 配置——镜像只按次传给它自己的更新命令。所选镜像必须公布与官方源一致的包摘要，否则弃用；`OCC_UPDATE_REGISTRY=official` 可关闭该行为。
- **新增本地离线语音输入，不需要任何账号。** 此前两个语音后端多数人都用不了：一个要求 claude.ai 的 OAuth 令牌（API key、Bedrock、Vertex、Foundry 与第三方 provider 均不满足），另一个依赖的上游服务已停止响应。设置 `voiceProvider: 'local'` 后，occ 会在首次使用时下载识别器与模型，此后完全离线运行，无密钥、无配额、无外发请求。识别在独立进程中完成，occ 自身的内存占用不受影响。默认模型覆盖中英日韩粤；纯中文听写可改用 `paraformer-zh-small`，实测准确率相同而内存占用与下载体积均显著更小。

## 2.38.1 - 2026-08-11

- **修复开启 workflows 时第三方端点每次请求都返回 400。** Workflow 工具的参数 schema 顶层是 `anyOf` 而不是 `type: "object"`：Anthropic 接受这种形状，而 OpenAI 的 function calling 规范不接受，严格的兼容端点会因此拒掉**整个请求**——GLM、Kimi、Qwen、DeepSeek 的 chat 线以及 OpenCode 上的会话完全不可用。工具 schema 现在在发往 OpenAI 线的边界处统一归一化为对象，且不按工具名特判：MCP 服务器提供的 schema 不由 occ 编写，同样的形状随时可能再次出现。运行时校验不受影响（仍以原始 schema 为准），Anthropic 线的请求字节不变。
- **修复一条消息被显示成两条。** 两个互相独立的原因：会话标题的后台生成在失败时被当作「下一轮再试」，于是在会返回错误的 provider 上退化为每轮都发一次请求，在按请求计费的中转上读起来就是同一条消息发了两次；此外，输入提交后的占位内容在超过 500 条消息的会话中会与真实消息同时出现，而该渲染路径正是 Windows 与 Windows Terminal 的默认，开启「减少动效」时同样如此。
- **OpenCode 登录会在写入配置之前先验证凭据。** 登录过程中的每个请求要么不需要凭据、要么容忍错误的凭据（模型列表在 Zen 与 Go 上都是公开的），所以第一次真正使用凭据的是用户发出的第一条消息，返回 `Invalid API key`，看起来像是 provider 故障。现在设备码登录与 API key 两条路径都会先对所选端点探测一次；被拒绝时不写入任何配置，并在登录界面说明是哪个产品、哪个地址，以及如何改用另一种方式。
- **所有 API 错误都会进入重试。** 此前认证失败、请求非法、计费与权限类错误一次即告失败。现在它们同样会重试，只是走单次、250 毫秒的短路径，因此一个确定不会改变的错误仍然在一秒内浮出来。用户主动取消永不重试；已经输出到界面的内容也不会被重放，因为下游是只追加的，重放会让内容显示两遍。`CLAUDE_CODE_RETRY_ALL_ERRORS=0` 可恢复旧的快速失败。同时修正了错误类别的显示：同一个故障不再因为重试判定不同而报出不同的类别。
- **并行运行子 agent 时的状态列表更易扫读。** 子 agent 的任务描述收紧为 2-4 词的祈使短语——它会逐字显示在状态列表中，每个 agent 占一行。

## 2.38.0 - 2026-08-10

- **新增 OpenCode provider，可直接接入 Zen 网关与 Go 订阅。** 同一个账号后面是两个不同的产品，`/login` 里并列列出：Zen 按量付费（61 个模型，含 Claude 全系），Go 为订阅制（25 个开源编码模型）。选错的表现是 `Insufficient balance`，而那句报错本身不解释原因，因此两者的端点与计费方式在选择时直接标明。凭据支持 Console 设备码登录与 API key 两种，二者在推理面等价；免费档无需账号即可使用。协议线按模型家族自动选择：Claude 走 Anthropic Messages 线，GPT 与 o 系走 Responses 线，其余走 Chat Completions 线。access token 仅保存在 0600 权限的凭据文件中，不写入 `settings.json`，也不进入 provider 档案。当前阶段一个会话只说一种协议，因此跨家族钉档位会有一档走错。
- **新增 `/provider-settings`，可同时配置多个 provider、自由切换，并把其中几个聚合成一份模型列表。** 面板列出已保存的 provider 及其端点与模型数量：`Enter` 切换、`Space` 加入或移出聚合、`R` 刷新该 provider 的模型列表。聚合后 `/model` 显示这些 provider 的模型并集，重名的模型标出归属（如 `gpt-5.4 (relay)`），选中即把会话切换到该模型所属的 provider。聚合的是模型列表而不是连接 —— 同一时刻仍然只有一个 provider 在服务，档位别名与子 agent 随之切换。面板只显示端点与「是否存有 key」，从不渲染凭据本身。原有的 `/provider save|use|list|delete` 全部保留。
- **自动更新改为检测到即在后台安装，不再等到所有会话退出。** 此前更新会排队等最后一个会话退出才安装，实际表现是开着会话等半小时也毫无动静。不能边运行边安装原本有其原因：occ 由约 612 个内容哈希命名的模块组成、在整个会话生命周期内按需加载，而 `install -g` 重建包目录会让运行中会话里尚未加载的模块消失，之后任何一次加载都会让界面卡死到无法退出。现在启动时会把运行文件硬链接到独立目录并从那里加载，包目录被替换不再影响运行中的会话，更新因此可以立即安装：启动约 60 秒后检测，发现新版即在后台安装，重启生效，且同一时间只会有一个安装进程。硬链接不额外占用磁盘，跨磁盘时自动回退为复制。
- **登出会一并清除分层模型设置，修复上一个 provider 的档位默认值污染下次配置。** 登出此前保留 `settings.modelSettings` 与遗留的 `effortLevel`，而这些值是按上一个 provider 的模型家族播种的。于是从 DeepSeek 登出后再配置 GPT，四个档位拿到的是 DeepSeek 那一行 —— 1M 上下文、max 思考档，而不应有的 272k 与 xhigh，并且配置向导会把这两个数字显示得像是用户自己选定的。

## 2.37.0 - 2026-08-10

- **登出恢复为重置整个账户面，修复登出后无法重新配置。** 此前登出只清除三个 Anthropic 凭据键，第三方 provider 的端点与 key 全部幸存并在下次启动被重新写回进程环境；`isAnthropicAuthEnabled()` 因此判定会话仍属第三方，首启向导不再插入登录步骤，用户登出后没有任何重新配置的入口。DeepSeek 会话中登出更是完全无效：内存镜像会用幸存的 `OPENAI_API_KEY` 重新生成 `ANTHROPIC_API_KEY`。现在登出会清除全部 provider 键与 `modelType`、移除 ChatGPT 与 Antigravity 的 OAuth 凭据、释放 DeepSeek 镜像；MCP OAuth token、plugin secrets 与已保存的 provider 档案不受影响，`occ auth logout` 与 `/logout` 语义一致。
- **登出会清空被拒绝的自定义 API key 名单。** 「Detected a custom API key」对话框仅对状态为「新」的 key 弹出，默认选项为 No 且取消按 No 计，此前一次拒绝即永久锁定该 key，且没有任何命令能恢复。
- **WebSearch 具备执行超时保护，单个工具卡死不再拖住会话。** 工具可显式声明墙钟上限并在独立的子取消控制器中执行，超时只终止该工具本身，不影响会话；WebSearch 默认 60 秒，可通过 `CLAUDE_CODE_WEB_SEARCH_TIMEOUT_MS` 调整或设为 `0` 关闭。聚合搜索的各路搜索源在宽限期结束或主路取消时会被真正中止，不再遗留仍在发送请求的后台分支。
- **第三方搜索路径统一接入 API 错误重试。** Anthropic、DeepSeek 与 Gemini 的直连搜索对可恢复错误重试，认证、权限、参数等永久性 4xx 与用户取消立即失败；Anthropic 路径的 SDK 客户端重试已关闭，避免与该层叠乘。

## 2.36.1 - 2026-08-09

- **Agent 与 Workflow 的切换和取消不再串线。** 前台 Agent 转入后台时继续消费同一个流，不再重复启动第二个 Agent；取消单个 Workflow agent 只终止该 agent，兄弟节点与后续阶段继续运行。agent 退出后，迟到的后台任务通知会回到主会话，RemoteAgent 终态任务也会按生命周期自动驱逐。
- **后台进程与连接的收尾完整执行。** 自然完成的 Shell 任务会注销 cleanup 回调，ACP 取消会等待查询生成器执行 `return()`，daemon 会话退出后清理其受管日志；旧 WebSocket 的延迟事件不能再破坏新连接。
- **第三方流式 API 会按真实原因超时或终止。** Anthropic 流默认启用空闲看门狗，Gemini 同时具备连接和逐次读取超时；Gemini 的安全拦截与畸形工具调用会保留部分输出并明确报错。Responses API 不再把内容过滤或未知终止原因误报为输出 token 截断，也只向实际支持的模型发送 reasoning effort。
- **延迟工具、MCP 与 teammate 邮箱在并发下保持最新。** 预取发现的工具可直接交给 ExecuteExtraTool，Anthropic 后续请求不会丢失延迟工具清单；并发 `tools/list_changed` 刷新不能回写旧连接的数据，邮箱轮询也不会误删快照之后到达的消息。
- **Provider、profile 与模型设置不再互相污染。** 跨档 Agent 使用其真实来源槽位读取 effort/context；切换 provider profile 会完整清理旧模型元数据，同时保留 shell 或后续用户覆盖的环境变量。仅配置 tier 的 Anthropic-compatible 端点会按第三方目录处理，显式 `FEATURE_*=0/false` 在 Bun build 中继续生效。
- **迁移与列表界面在竞态和尺寸变化下更安全。** 迁移执行阶段采用 no-clobber 语义，不会合并或覆盖规划后出现的目标文件与目录；终端高度变化后，CustomSelect 会立即重算可见窗口并保持当前项可见。

## 2.36.0 - 2026-08-09

- **订阅会话触达限额时立即给出结论，不再空等一轮无效重试。** Claude 订阅（Max/Pro）遇到 429 时优先读取服务端返回的限额重置时间，直接显示「已达限额」与恢复时刻；此前要走完约 10 分钟的重试倒计时才给出同一个结果。这条规则对所有 provider 生效：服务端明示的重置窗口一旦超过单次退避上限就不再重试，服务端没给这项信息时维持既有的订阅重试契约，OpenAI 两条线遵循同一判断。
- **配置类错误立即报错并给出处置指引。** ChatGPT 订阅未登录、Antigravity 未初始化项目这类由 occ 自己抛出的永久性错误不再进入重试阶梯，第一时间说明需要做什么，而不是拖满约 2 分钟后显示同一条消息。
- **容量过载（529）期间后台请求不再放大重试洪峰。** 标题生成、分类器等后台辅助请求在 529 上直接放弃并记录，把重试预算留给用户可见的前台请求。
- **API 错误消息附带结构化诊断信息。** 非标准形态的错误统一转换成同一种错误消息，并带上 provider、HTTP status、错误类别与是否可重试，便于判断是配置问题还是临时故障。
- **修复三处自动更新失效。** 关闭 `autoUpdates` 或设置 `DISABLE_AUTOUPDATER=1` 后，退出时不再执行此前排队的延迟安装；`occ -p` 的脚本化调用只登记会话，不再意外拉起全局安装；会话租约同时记录进程启动时间，pid 被系统复用不会再让自动更新永久静默停摆。
- **ultracode 收口为一个真正的开关。** 模式关闭时，模型不再收到 ultracode 与多 agent 编排的怂恿文本，Workflow 工具带明确的 opt-in 门槛；`/ultracode` 的显式调用仍然有效，作为仅限当前任务的一次性 opt-in；会话中途开关模式即时生效。
- **修复长会话 compaction 后界面出现重复消息。** compact 之后重放的历史消息按唯一 id 合并，同一条不再显示两次。

## 2.35.2 - 2026-08-09

- **补齐 Anthropic Messages、OpenAI Chat/Responses、Gemini 与 Grok 的错误分类和重试边界。** HTTP status、provider `type/code/status`、网络 errno 与 SSE error envelope 统一进入同一分类器；408/409/425/429/529、5xx、连接中断与暂时不可用会在既有上限内重试，认证、权限、计费、无效请求、model not found、确定性 TLS 错误与用户取消立即失败。Responses 的标准 `event: error`、顶层 `error` 与 `response.error/failed` 不再被忽略；Chat/Grok/Gemini/Responses 的流若未收到协议终止标记，不再把半截响应当成功。只有在没有可观察输出时才可重放；text、thinking、signature、tool identity/arguments 或 refusal 一旦出现即禁止重放。SDK/NDJSON 的 `error` 字段继续保持合法枚举，原始 producer error 仅保存在非枚举元数据中。
- **登录、刷新与 logout 不再误删或丢失其他 Provider 的凭证。** 新 Anthropic 凭证先可靠落盘，再清理旧 API key/OAuth；macOS Keychain 直接 upsert，不再先删旧项，删除失败也不再宣称成功。普通 Anthropic logout 只移除 Anthropic credential 字段，ChatGPT/Codex、Gemini/Antigravity、MCP/plugin secrets、其他 API key、provider profiles、模型/端点与 Web Search 配置全部保留；安全存储的 fallback 只有在确认旧 primary 不会遮蔽新值时才报告成功。
- **凭证文件写入改为 0600 原子替换，Web Search 设置失败会如实显示。** ChatGPT、Antigravity 与明文 secure-storage fallback 都通过同目录临时文件 write+fsync+rename，原子替换失败时不再退回直接截断目标文件。`/search-setting` 只 patch 当前 source 的 override，写入失败不会乐观翻转复选框或显示成功。
- **修复 SSH 重连与 LSP 启停竞态留下未受管进程。** 用户断开后才完成的 SSH reconnect 会立即关闭新进程；同一 LSP server 的并发首次请求共享一次启动。shutdown 开始后拒绝新的 initialize/start，并等待已登记的启动结束后再次 stop，避免清空 manager 后进程才复活。
- **Workflow 面板在窄/矮终端中始终保持当前选择可见。** phase 与 agent 列表按焦点分别导航，选中的 agent 不会滑入被裁剪区域，分页提示不再遮住选中行；当前 run tab 会旋转到可见窗口左端并按真实面板宽度裁剪。`Tab`/`Shift+Tab` 负责切 pane，`[`/`]` 切换 run。
- **长期后台任务与会话清理不再无界增长或留下空白 UI。** long-running RemoteAgent 只保留最近 200 条事件，同时继续累计总数、todo 与 rich result；`cleanupPeriodDays` 递归清理 `tool-results` 和 `subagents`，每层都拒绝跟随 symlink。teammate 退出导致详情对象消失时，TeamsDialog 自动返回成员列表，不再留下空白模态层。
- **禁用延迟工具网关的一半不再让全部延迟工具消失。** 只有 SearchExtraTools 与 ExecuteExtraTool 同时可用时才延迟 schema；任一端被权限规则移除时，不再宣告不可执行的搜索路径，其余 MCP/延迟工具改为直接随请求发送，保持可调用。

## 2.35.1 - 2026-08-08

- **修复 Bedrock inference-profile 后台查询延迟落地时污染全局模型缓存的隐患。** 该查询以 fire-and-forget 方式发出,结果可能在数秒后写回一个已不属于 Bedrock 会话的缓存;缓存只在为空时重新推导,一次过期写入即永久生效,此后所有默认模型解析均返回 `us.anthropic.*` 形式的 id。现写入前校验会话仍为 Bedrock 且缓存仍为空,过期结果直接丢弃。
- **测试套件:清理 18 个测试文件的跨文件 env/模块缓存泄漏(Linux CI 顺序性失败的根源),Bedrock 相关测试不再发起真实 AWS 请求。** 新增模块级注入点供测试替换 inference-profile 查询,未引入任何 `mock.module`。

## 2.35.0 - 2026-08-08

- **模型设置新增独立的 `default` 槽。** provider 默认模型与 haiku/sonnet/opus/fable 四档各自独立配置 effort 与上下文，即使解析为同一 model id 也互不影响；显式 model id 一律原样透传。出厂默认统一为：GPT（含 o 系）xhigh·272K、DeepSeek max·1M、Claude Opus/Fable xhigh·1M、Claude Sonnet/Haiku xhigh·200K、Gemini/Grok high·200K。自 2.34 升级时，原「Default」行的档位配置自动迁移至 `default` 槽。
- **`/models` 命令更名为 `/models-setting`（provider 的 HTTP `GET /models` 端点不变）。** 保存等待全部副作用完成后立即在当前会话生效，无需重启；Claude.ai、ChatGPT 订阅与 Antigravity 登录流程同样即时生效。ChatGPT 订阅与 Antigravity 会话在该页仅编辑模型与档位映射，凭据与登录状态不受影响。模型选择器仅展示端点实际返回的模型，内建模型表仅在官方端点兜底；重新打开 OpenAI 设置会保留 `OPENAI_WIRE_API`。
- **可恢复的 API 错误统一重试，上限 10 次。** 网络中断、429、临时 5xx、无状态 upstream 错误与 Responses 流首个输出前的 idle timeout 均重试；认证、权限、invalid request、model not found 与用户取消立即失败。`Retry-After` 上限 60 秒、退避单次上限 32 秒；SDK 内层重试关闭，避免重试放大；已提交 text/thinking/signature/tool 输出后不再重放请求。例外：Claude 订阅（Max/Pro）的 429 不重试（限额按时间窗口恢复）；`CLAUDE_CODE_UNATTENDED_RETRY` 由无限改为同样封顶 10 次。
- **Agent 与 Workflow 子 agent 共享执行看门狗。** 连续 40 分钟（默认）无工具产出即终止；占位文本不计为进展，活跃的 Bash/MCP/工具调用暂停计时；总时限默认关闭。`CLAUDE_CODE_AGENT_NO_PROGRESS_TIMEOUT_MS` 与 `CLAUDE_CODE_AGENT_TOTAL_TIMEOUT_MS` 可调，0 为禁用。被终止的 agent 保留已产出的部分结果并报告明确原因。空白或纯 thinking 响应不再被视为成功，包括主会话在内一律显示为模型错误。
- **主 Agent 可查询与控制 Workflow。** 状态含 run/phase/子 agent/进度/token 统计/失败原因与 run 目录；resume 支持 checkpoint、全量、agent 区间或指定列表；同一 runId 单飞，旧代际不覆盖新运行。
- **Workflow 与后台任务统一为固定尺寸面板。** `/workflows` 与任务入口共享同一视图，内容多少不改变布局；`↑/↓` 选择，`x` 取消选中 agent 或整个 run，独立的 `K` 快捷键移除。
- **MCP 工具池实时化。** SearchExtraTools 与 Execute 每次调用读取实时工具池（含子 agent 内）；动态注册、删除与 `tools/list_changed` 同轮生效。首次 `listTools` 失败不再缓存为空结果，失败的 server 明确显示为 failed；单个畸形工具不影响同 server 其他工具；同名 server 重连不复用旧 schema。
- **不再内置 Chrome MCP。** `chrome-devtools-mcp` 依赖、默认 server、CLI flag、`/chrome`、skill、settings 与 doctor 项全部移除；此前启用过内置 `mcp-chrome` 的用户需按普通 MCP 自行重新添加，任意浏览器类 MCP 均可正常配置。
- **交互式会话在无显式权限配置时默认 `auto`。** `-p`/headless 会话保持 `default`；显式 CLI/settings 配置一律优先。compact 摘要不再将一次性编排指令带入后续会话。
- **provider URL 拼接统一。** 不再产生重复版本段、不丢失多段自定义 base path、模型目录请求发往正确端点。Antigravity 的 base URL 覆盖键由 `GEMINI_BASE_URL` 迁移为独立的 `ANTIGRAVITY_BASE_URL`，原有代理配置需改键。
- **修复 Bing 搜索结果整页丢失。** Bing 的点击跟踪壳使用相对路径时，结果在解包前即被丢弃；现在两种写法均先解包取出真实地址。
- **配置了 key 的 Brave 与 Exa 自动参与多源搜索。** 与已登录官方源一致：有 key 即参与并行合并，无 key 不出现，可在 `/search-setting` 中关闭；不再需要独占式固定后端。

## 2.34.0 - 2026-08-07

- **修复：跑子 agent 的长会话内存会一直涨，最后整个崩掉。** 症状是 `FATAL ERROR: Ineffective mark-compacts near heap limit`，实测一次崩在 4GB。原因是子 agent 产生的**每一条**消息都会留在父会话里，而且永不清理 —— 一次真实会话跑了 216 个子 agent、其中一个自己就产生了 1,270 条消息。现在子 agent 结束时它的过程记录会被裁掉，只留尾部若干条。运行中的 agent 完全不受影响，短的 agent 也一条不少；被裁掉的完整内容本来就在 `subagents/agent-<id>.jsonl` 里。`CLAUDE_CODE_AGENT_PROGRESS_RETAIN` 可调保留条数。
- **内存跨过 1.5 / 2.5 / 3.5GB 时会记录一条诊断日志**，带占用、增长速率和已运行时长 —— 判断「是不是在漏」看的就是速率。此前这个自动诊断的开关存在但没有任何地方调用它，所以上面那次崩溃什么线索都没留下。设 `CLAUDE_CODE_AUTO_HEAP_DUMP=1` 可额外抓堆快照（默认不抓：几 GB 的堆会写出同等大小的文件并让进程卡住数秒）。
- **修复：从 `.mcp.json` 删掉一个 server 后，它的进程还活着、工具还能被调用。** 之前只有插件来源的 server 会被回收，`.mcp.json` 里的不会；而且改了文件也不会触发任何重扫，得重启或 `/clear`。现在 `.mcp.json` 的改动会在会话内生效，被删的 server 连同它的子进程一起回收。两处刻意的例外：claude.ai 的连接器不会因为「不在文件里」被回收，某个配置文件解析失败时那一作用域这一轮也不参与回收 —— 否则一个手误就会把正在用的服务全断掉。
- **修复：workflow 跑完后查不到它。** 后台任务在完成的那一刻就满足了被回收的条件，于是查询它的结果只会得到「找不到该任务」；resume 过的 run 更是从一开始就查不到（它保留原 runId，但注册用的是新 id）。现在完成后有宽限期，用 runId 也能查到。
- **workflow 的返回值和完成通知现在会给出 run 目录的完整路径**（含 `journal.jsonl` 与 `state.json`）。此前只给一个 runId，要诊断「这次 run 为什么返回了空」只能猜文件在哪。
- **workflow 的 resume 在缓存失效时不再一声不吭。** 改动了脚本或改动了提给 agent 的问题，都会让缓存整体失效、退化成全量重跑 —— 但此前它看起来和成功续跑一模一样，只是白花一遍钱。现在会明确说明在第几次调用上分歧、复用了几条、丢弃了几条。
- **网页搜索取消了每会话 200 次的上限。** 那个计数按进程累计且永不重置，长会话最终会整个失去搜索能力，而报错落在一次普通搜索上、离真正失控的循环很远。要硬上限的话设 `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`。
- **子 agent 取消了每会话 200 个的上限**，同样原因（前述那次会话跑了 216 个）。并发上限 20 和嵌套深度 3 保留 —— 那两个限的是同时占用的资源，会随 agent 结束释放。

## 2.33.0 - 2026-08-07

- **新增 DeepSeek 搜索源。** DeepSeek 自己就提供服务端网页搜索，此前 occ 用的是 Anthropic 那一源的名字来跑它 —— `/search-setting` 里因此会出现一行「已连接的 Anthropic」，而它的每个字节都发往 DeepSeek，同一个端点还被当成两家各发一路。现在它是独立的一源，显示的是它真实的名字。覆盖面也更宽：这条线不再取决于主循环用的是哪种协议，所以把 `OPENAI_WIRE_API` 固定成 `chat` 的会话 —— 那是唯一一条完全没有内建搜索的协议 —— 也能用上服务端搜索，而不是掉回免密钥抓取。
- **配好 DeepSeek 端点后会自动探测搜索是否可用。** 有 key 不等于那个部署真的实现了搜索工具（自建镜像、老网关会收下 key 然后拒掉工具）。occ 现在发一个极小的请求先问端点收不收，不会真跑一次搜索去试；答不认就把这一源灰掉，并把端点的原话显示出来。网络抖动、限流、密钥过期不会被误判成「不支持」。
- **修复：搜索结果里偶尔出现打不开的空条目。** DeepSeek 把失败的那次搜索作为结果列表里的一项上报，occ 只认得另一种错误形状，于是把它当成了一条真实结果。
- **`/search-setting` 支持断开、取消和重新探测。** `D` 断开已登录的搜索源（Gemini / Codex），`Esc` 在登录进行中先取消登录而不是关闭面板，`R` 重新探测所有源。
- **修复：登录了却仍然用不了那个搜索源。** 某个源在会话里失败过一次就会被停用到重启为止 —— 即使你随后登录或改好了配置，它也一直是灰的。现在登录成功、断开成功和按 `R` 都会重新评估。断开后如果那一源仍显示已连接，面板会说明原因（例如 `~/.codex/auth.json` 属于 Codex CLI、不归 occ 删，或 `GEMINI_API_KEY` 还在你的环境里）。
- **修复：Gemini 和 Grok 上 `/effort` 完全没有作用。** 选了、显示了，然后被丢掉，一路都没发出去。现在两家都真正映射到各自的参数上；Grok-4 系拒收该参数，所以那些模型不再假装提供这个选项。
- **修复：DeepSeek 上 `/effort` 与实际发送的不一致。** 配置成 `deepseek-chat` / `deepseek-reasoner`（DeepSeek 官方文档教人填的两个名字）时，界面装作没有这个旋钮，请求却一直在被它操纵。另外 DeepSeek 只有三档，occ 有五档，多出来的两档它会静默忽略并回落到自己的默认 —— 而状态栏还在显示你选的那一档。现在两条线上折叠一致。
- **Claude 系模型的出厂思考强度由 `high` 提升为 `xhigh`**（opus / fable / sonnet / haiku 一致）。显式设过 `/effort` 或 `modelSettings` 的不受影响。
- 网页搜索工具的说明改为如实描述：它是一次调用并行扇出到免密钥引擎池加上所有已登录的官方源、合并去重的聚合搜索，不需要单独的 key，在非 Anthropic 端点上同样可用。此前那句「仅在美国可用」对 occ 是不成立的，而且会让模型放弃使用它。

## 2.32.4 - 2026-08-07

- **修复：交互式会话里配好第三方 provider 后仍然 `Not logged in · Please run /login`。** occ 对环境里的 `ANTHROPIC_API_KEY` 有一道审批弹窗（「Detected a custom API key in your environment」），而且**默认选中「No (recommended)」**。问题是：occ 自己配好的 key 也被当成「在环境里发现的」—— 你在 `/login` 里输入的那把 provider key，被 occ 复制到内部后又反过来问你要不要用它，而你从来没有机会批准过它。按默认答一下，就把刚配好的 key 拒了。现在 occ 自己写入的 key 不再走这道审批：DeepSeek、以及任何通过「Anthropic 兼容」入口配置的网关/代理都适用。
- 说明：`-p`（非交互）走的是另一条认证分支，完全不经过这道弹窗 —— 所以此前几个版本 headless 测试全绿、而 REPL 一直坏。这次是用真实交互式会话验证的：已发布的 2.32.3 弹出审批窗且一轮都没跑成，本版无弹窗并正常完成对话（确认由 `deepseek-v4-flash` 应答）。

## 2.32.3 - 2026-08-07

- **修复：2.32.2 没有真正修好 `Not logged in · Please run /login`。** 上一版把修复挂在几个已知的入口上，但那是打地鼠 —— 还有别的地方会在会话中途改写 provider 配置，同样不会触发 DeepSeek 路由的内部镜像，于是请求照旧打到 Anthropic 官方接口、不带凭据。这一版把兜底放在**构造 API 客户端的那一步**：请求不可能再由一份没应用的配置构造出来，无论是谁、在什么时候改的配置。
- 这次是对着**真实构建产物**端到端验证的，不再只跑单元测试：同一份「配置中途到达」的输入，2.32.2 返回 `Not logged in`，本版返回正常回复并确认用的是 `deepseek-v4-flash`；两个启动入口的常规路径也回归过。

## 2.32.2 - 2026-08-07

- **修复：配置完 DeepSeek 后立刻报 `Not logged in · Please run /login`，模型也显示成 `claude-sonnet-5`。** occ 把 DeepSeek 路由到它的 Anthropic 兼容接口，这需要在内部把配置镜像一份；但那个镜像**只在启动时跑一次**，而且要求 API key 当时就已存在。首次登录时进程启动阶段还没有 key，镜像就没做；随后登录写入配置，occ 立刻认为自己在走这条线，却没有真的应用它 —— 请求打到了 Anthropic 官方接口、没带任何凭据（于是 401），模型别名也解析成了 Anthropic 的名字。一个漏掉的调用，三个症状。现在镜像跟着配置走：登录、`/models`、`/provider use`、切换 provider 都会重新应用。
- **修复：中途改了某个档位的模型，实际请求仍然用旧模型。** 同一个镜像此前只会「填空」，不会更新自己写过的值 —— 改成 `deepseek-v4-pro` 之后，真正发出去的还是原来那个。切换到别的 provider 时，镜像也会正确撤销，不再继续指向 DeepSeek。
- **修复：第三方模型被加上 `[1m]` 后缀。** 那个后缀的唯一作用是发送 Anthropic 的 1M 上下文 beta 头，对别家没有意义。
- 修复首启向导里新增的「思考强度」字段按 Enter 到不了（保存动作还绑在它前面那个字段上）。

## 2.32.1 - 2026-08-07

- **修复：用第三方 provider 时，界面把模型显示成 Claude 系列的名字。** 状态栏、`/model` 的确认消息、模型列表都可能出现「Fable 5 (1M context)」这类名字，而实际跑的是 DeepSeek / GLM / Qwen 的模型。原因是 occ 内部给这几家 provider 映射的是与 Anthropic 相同的模型 id 字符串，于是没有配置模型的档位会解析出一个字面量 `claude-fable-5` —— DeepSeek 会静默换成自己的模型，其他家则直接报错。**这个名字还会写进系统提示词**（「你是名为 Fable 5 的模型」），所以模型自己也被告知了错误的身份。
- **修复：`/model` 会把 Anthropic 的模型 id 当成可选项列给第三方用户。** 现在第三方会话只列出四个档位（haiku / sonnet / opus / fable）加上 provider 自己的目录；没有配置模型的档位会直接写明「no model configured」，而不是伪装成一个能用的 Claude 模型。
- Bedrock、Vertex、Foundry **不受影响**：它们跑的确实是 Claude，模型名和选项列表保持原样。

## 2.32.0 - 2026-08-07

2.31.0 的分层模型设置对第三方 provider 基本是失效的，这一版把它修好并搬进 `/model`。DeepSeek 用户受影响最大。

- **修复：DeepSeek 会话的 `/model` 列出的全是 Claude 模型**，还标着 Anthropic 的 `$5/$25 per Mtok` —— 而你的 key 只能打到 api.deepseek.com。2.31.0 让 DeepSeek 改走 Anthropic 兼容接口，代码里问「用哪套协议」和问「这是不是 Anthropic 自家的模型目录」用的是同一个判断，于是后者跟着答错了。现在 `/model` 列出的是你自己配的档位模型，加上 DeepSeek 的完整目录。
- **修复：分层模型设置对第三方模型一直是摆设。** 设置以档位为键，请求里流的却是解析后的模型 id；`deepseek-v4-pro`、`glm-5.2`、`gpt-5.6-sol` 这类名字里不带 opus/sonnet 字样，档位就查不出来，于是你在 `/model-settings` 里写的每个值都被**静默丢弃**。现在会反查你配的 `*_DEFAULT_<档位>_MODEL` 映射。**如果你之前设过分层配置却觉得没生效，是这个原因，现在会生效了。**
- **修复：给非 Claude 模型设 1M 上下文会被砍回 200k。** 1M 需要 Anthropic 的 beta 头，这是 Anthropic 模型的限制，此前却套用到了所有 provider 上 —— 结果是「1M 模型不叫 Claude」的每一家（DeepSeek V4、GLM 等）都设不了真实窗口。
- **`/model` 里可以直接按档位调思考强度和最大上下文了。** 高亮任意一行：`←/→` 调该档位的思考强度，`Space` 循环该档位的最大上下文（默认 → 128k → 200k → 272k → 512k → 1M）。调过的档位全部保存，不只是最后按 Enter 的那一行。`Space` 从前是「1M 开/关」二元开关，现在是同一件事的完整梯子。
- **登录时选的最大上下文和思考强度会持久化了**，按档位存进 `settings.modelSettings`。此前最大上下文被写成 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` —— 那个环境变量的优先级在分层配置**之上**，等于让登录时的一个开场值静默压过你此后在 `/model` 里的每一次调整；保存时会顺手清掉它。首启向导也新增了「思考强度」字段。留空 = 存入各档位自己的默认值；重跑向导时留空 = 什么都不动，不会把你分档调好的值压平。
- 修复一批同源问题：Anthropic 专属的 beta 头发给了 DeepSeek；Fast mode 对第三方 provider 显示为可用；`/login` 把 DeepSeek 显示成 `anthropic`；Claude.ai 订阅用户切到第三方 provider 后仍看到订阅模型表；Grok 的档位模型配置写了从来不读。
- 内部：publish 门禁加回全量单测（分片），CI、发布脚本三处共用同一个脚本。

## 2.31.1 - 2026-08-07

- **修复 DeepSeek 用户的 `CLAUDE_CODE_DISABLE_THINKING` 一直无效**。DeepSeek 把「请求里没有 `thinking` 字段」当作**启用**，而 occ 关闭 thinking 时恰恰就是不发该字段 —— 于是你关了，模型照样思考。现在会显式发送关闭指令。走 DeepSeek 的 Anthropic 端点时生效。
- **DeepSeek 未指定 temperature 时补 `0`**（此前是该端点的隐式默认 `1.0`）。DeepSeek 官方参数指南把代码与数学场景定为 `0.0`，而这正是 occ 的全部工作负载。仅在 thinking 关闭时发送；`DEEPSEEK_TEMPERATURE` 仍可单项退出。
- 内部：测试 mock 卫生棘轮清零（241 → 0）。过程中修掉一批测试桩与真实签名不符的问题，其中若干会让被 mock 的模块对同一进程内的后续测试文件返回错误结果。不影响运行时行为。

## 2.31.0 - 2026-08-07

按模型档位分别配置思考强度和上下文窗口；DeepSeek 换用更合适的接口，顺带拿到免费的联网搜索；修掉两个一直有人反馈的界面问题。

- **⚠️ 行为变更：GPT 模型的默认思考强度提高了。** 之前 `gpt-5.6-sol` 默认 low、其余 GPT 默认 medium，现在统一是 xhigh，**推理 token 消耗会明显上升**。同样地，此前不发送思考强度的第三方 provider（GLM、Qwen、Kimi、本地模型等）现在默认发送 xhigh。想回到原来的花销，用 `/model-settings <档位> effort medium`，或设 `CLAUDE_CODE_EFFORT_LEVEL`。两处都只对确认支持该参数的模型发送。
- **⚠️ 行为变更：Claude Opus 和 Fable 默认使用 1M 上下文窗口。** 超过 200k 的请求走 Anthropic 的 1M 计价档。Sonnet 和 Haiku 不受影响，仍是 200k。
- **新增 `/model-settings`**，按 haiku / sonnet / opus / fable 分别设置思考强度和上下文窗口。此前这两项都只有一个全局值，说不出「重活多想一点、杂活省着点」。出厂默认按 provider 分：DeepSeek 用 max 强度和 1M 窗口，GPT 用 xhigh 和 272k，Claude 用 high（Opus 和 Fable 给 1M），其余用 xhigh 和 200k。环境变量仍然优先于这里的设置。
- **DeepSeek 用户现在有联网搜索了，而且是免费的。** occ 改用 DeepSeek 的 Anthropic 兼容接口，那是它唯一提供服务端搜索的一条；此前 DeepSeek 用户的 WebSearch 一直退化成无密钥网页抓取。同时思考过程不再需要拼接转换，格式转换的损耗也没有了。**不需要改任何配置**，检测到 DeepSeek 端点就自动生效；`CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` 可关闭。
- **修复：Ctrl+C 退出后终端里残留一串乱码。** 形如 `^[]11;rgb:...` 和 `^[[?62;22;52c`，是 occ 询问终端配色时收到的回复没来得及读走。退出流程现在会先停掉这些后台询问，再关闭输入。
- **修复：状态栏出现一个不存在的子代理，按 x 也关不掉。** 子代理在恰好完成的同时被转入后台时，清理逻辑会跳过它，任务就永远停在「运行中」。
- 修复：管道和文件输出里可能混入终端控制字符——只有真正的终端才会收到这些询问了。

## 2.30.0 - 2026-08-06

Windows 上的一批实际故障，加上一个所有平台都存在的渲染问题。

- **Windows 上每次报错都弹出 WSL 窗口，而且所有 hook 都失败。** 根因是同一处：occ 把 `C:\Windows\System32\bash.exe` 当成了 shell，那其实是 WSL 启动器。Bash 工具和 hook 都走这条查找逻辑，所以两个症状一起出现。现在会跳过它，去找真正的 Git Bash。
- **Windows 上 Bash 工具的所有命令都提示 command not found。** occ 写进 shell 环境的 PATH 是字面量 `$PATH` 五个字符，因为它用 cmd.exe 去执行了一段只有 POSIX shell 才懂的命令。
- **Windows 上自动更新从未成功过，而且完全静默。** `occ update`、`occ rollback` 和 LSP 语言服务器都无法启动 npm 安装的程序——Windows 上它们是 `.cmd` 包装脚本，需要另一种启动方式。自动更新的失败还被完全丢弃，所以没有任何迹象。
- **Windows 上 `occ bg kill` 始终拒绝执行**，提示无法验证进程身份。同一处问题也让 Computer Use 在 Windows 上第一次调用就崩溃。
- 修复终端界面错位：背景色块横向溢出、文字左侧被截断、行间出现大片空白。三个原因叠加，其中两个在 macOS 和 Linux 上同样存在。如果你见过这种花屏，这次应该好了。
- **后台 agent 的计时一直显示 0s**，而旁边的 token 计数在正常增长。原因是用会被系统回拨的时钟去测时长——Windows 休眠恢复后回拨很常见。
- **hook 失败时现在会告诉你是哪个 hook、为什么失败。** 之前只显示一行「UserPromptSubmit hook error」，即使 hook 自己输出了完整的排查说明也看不到。
- MCP 服务器认证失败时不再只说 `fetch failed`，会给出实际原因（连接被拒绝、域名解析失败、证书问题、代理错误）。
- 等待响应时的动画：只是慢会渐变成黄色，上游完全没有返回数据才变红。此前两种情况都是红色。
- Windows 上还修了：shell 补全从未安装成功、ChatGPT 凭据被写到当前项目目录而非用户目录、worktree 的目录链接静默失效、插件安装/卸载在杀毒软件占用文件时随机失败、MCP 服务器进程残留累积。
- 修复 SSH 与 Computer Use：这两块在**所有平台**上都无法使用，macOS 上「粘贴剪贴板图片」同样受影响。

## 2.29.4 - 2026-08-06

- **README 的一行式安装指令装的是别人的空壳包,照着做完机器上不会有 `occ` 命令**。英文与日文 README 的「快速开始」写的是无 scope 的 `npm i -g open-claude-code` —— 而那个名字在 npm 上是第三方抢注的 `0.0.0` 占位包:没有 `bin`、没有任何文件。装它时 npm 打印 `added 1 package` 就成功返回,**连 `bin/` 目录都不会创建**,于是"安装成功"和"命令不存在"同时成立。**这是最难自查的一类失败**:没有报错、没有权限问题、`npm ls -g` 里还确实躺着一个叫 `open-claude-code` 的包,唯一的线索是它的版本号是 `0.0.0`。正确的包名是 `@sweetcornna/open-claude-code`(无 scope 的那个名字被抢注,所以本项目发不了,只能带 scope)。
- 真正漂掉的只有 README:`package.json`、`src/constants/brand.ts` 的 `NPM_PACKAGE_NAME`、`scripts/install.sh` 和 `docs/` 一直是对的,中文 README 此前也已修好,只有英文和日文两份没跟上。原因是包名钉住的五处里,**README 是唯一没有测试覆盖的一处** —— 所以也只有它会漂。现在补了覆盖三份 README 的断言:任何全局安装命令行都必须含 `NPM_PACKAGE_NAME`,且剥掉带 scope 的写法后不得再残留裸的 `open-claude-code`;该断言对修复前的 README 确认会红。
- 如果你之前照 README 装过一次,先 `npm rm -g open-claude-code` 把那个空壳包清掉,再按新指令装。

## 2.29.3 - 2026-08-06

- **workflow 的 schema 模式会把「解析失败的那个对象」的嵌套值当成答案返回,静默丢字段且不重试**。表现是某个 agent 的结果只剩内层的几个键、外层键(连同你用来做校验的审计字段)整段消失,而它是以 `kind:'ok'` 回来的 —— 没有报错、没有触发引擎重试、下游直接拿残缺数据往下算。**最难受的是它看起来完全不像解析器的问题**:结果本身是一个结构良好的 JSON 对象,于是排查方向自然指向"agent 没按 schema 写"或"某个执行闸没生效",而真正发生的事是解析器换了一个对象给你。根因在裸文本扫描:它对每个 `{` 尝试配平并解析,**顶层对象配平成功但 `JSON.parse` 拒绝时,循环从 `i + 1` 继续,等于走进这个坏对象内部** —— 而里面每一个 `{` 都是它自己的嵌套值,于是某个子对象(实测是 `fields` 的值)被当作完整答案返回。触发条件比想象中常见:agent 只要在字符串值里写了一个未转义的 ASCII 双引号,整个顶层对象就会被拒 —— 实测是中文 prose 里的 `属"扩张中的尾部收缩"`,中文排版引号和 ASCII 引号在键盘上紧挨着。现在解析失败即**整块跳过**(不再下钻),失败落到 `no-structured-output`,由引擎按 `AGENT_MAX_RETRIES_BY_REASON` 重跑,而不是返回残片。**未配平**的 `{` 仍然按原样跳到下一个字符 —— 那通常是散文里的噪声(`use { like this`)而不是被截断的对象,因它放弃整段文本会误伤本来能解析的答案。
- **同一处的失败信息此前会把排查引向完全无关的方向**。原本的 dead 原因只带 agent 最终文本的前 200 字,而对这种"JSON 语法错"的答案,前 200 字恰好是 `{"market": "US", ...` 这样健康的开头 —— 读起来像"agent 压根没输出 JSON",于是去查 agent、查工具、查 hooks,唯独不会怀疑那段就在眼前的 JSON。现在语法错会直接报 `JSON.parse` 的原文与**出错位置附近**的文本(node/V8 给出 position 时居中截取;`bun run dev` 走的 JSC 不给 position,但它会点名出错的 token)。
- workflow schema 模式的提示词补了一条:字符串值内的双引号与换行必须转义 —— 直接堵住上面那个触发条件,而不是只在事后重试。
- 回归验证用的是真实 workflow 运行留下的 81 份 agent transcript:改动后只有 2 个结果发生变化,正是被污染的那两个(转为可重试的失败),其余 79 个字节不变。

## 2.29.2 - 2026-08-06

- **WebSearch 稳定返回不相关内容，根因是聚合结果被单条通道垄断、真正相关的那条被整段截掉**。合并多路结果时按严格优先级把通道逐个排干，而那个"优先级"其实是 `SEARCH_SOURCE_IDS` 的**面板展示顺序**（`free` 恒定排最后），不是质量排序。于是只要 grounding 类通道在线，它就能把 8 条预算全部占满，返回真正排序过 SERP 的免费通道一条都进不来。实测 `Zod v4 strictObject usage`：单独跑免费通道，rank 1 就是 `zod.dev/api?id=zstrictobject`（官方 API 文档正文）；跑聚合，前六条全是 grounding 给的 GitHub issue 讨论帖，那个文档页一条没有。**这也是为什么它看起来像"搜索质量差"而不是"哪里坏了"** —— 每条结果单看都是真实网页，只是没一条回答问题。现在改为**轮转交错**：通道 0 仍然占 rank 1（"官方源权威"的约定不变），但每个通道放完下一条才轮到别人放第二条，任何通道都无法饿死其它通道。同一查询修复后 rank 2 就是那个文档页。
- **Gemini 通道的摘要张冠李戴**。grounding 返回的是模型作答时引用的来源，一句话经常同时挂着三四个来源，而摘要是按"引用了这句话的 chunk 全都拿这句话"分配的 —— 于是四个不同 URL 带着**完全相同**的摘要：既没有任何区分度可供挑选，对其中三个还是**根本不属于该页面**的描述。现在一段答案文本至多被一个来源认领，认领不到的来源宁可没有摘要 —— 缺摘要好过错摘要，标题和 URL 仍然能标识页面。
- **codex 主通道此前是死的：点亮它的凭据不是它实际使用的凭据**。机器上存在 ChatGPT 登录时，codex 源被判定为"已连接"（2.29.0 加的 base-URL 收紧对这条分支不生效，它在更上面短路），但主通道是以 `forceChatGPTAuth: false` 构造的，于是顺着 `OPENAI_BASE_URL` 打到第三方兼容端点——那里能接受请求、也真的跑了搜索，却不返回 `url_citation` / `action.sources`，所以**每次 0 条且全程不报错**，正是 2.29.0 修的那类静默空结果换了个入口复现。现在的规则是：端点不是 OpenAI 官方时，存在 ChatGPT 登录就走 Codex 后端 —— 让"算数的那把凭据"和"实际用的那把凭据"是同一把。修好路由后暴露了第二层问题：它把主循环模型（例如 `deepseek-v4-flash`）原样发给 Codex 后端，被 400 拒收（`... is not supported when using Codex with a ChatGPT account`），而聚合层会静默吞掉这个错误 —— 等于把"静默 0 条"换成了另一种"静默 0 条"。因此补上 `resolveCodexSearchModel`：走 Codex 后端时，该后端不认识的模型 id 一律换成便宜档（搜索轮只需要调用工具、吐引用），与既有 `resolveGeminiSearchModel` 处理 Antigravity 同一问题的做法一致。**走官方 OpenAI 端点的用户行为完全不变。**
- 上述三条对 Anthropic 会话同样生效的只有第一条（结果交错）；后两条只影响 Gemini / codex 通道。

## 2.29.1 - 2026-08-06

- **修复 `.mcp.json` 里的 `${VAR}` 被原样传给 MCP server，项目级 `settings.local.json` 的 env 形同虚设**。表现是需要密钥的 server 全线失效（FRED 直接回 400 `api_key is not a 32 character alpha-numeric lower-case string`，SEC 的列表通道正常、正文通道返 NO_DATA），而不依赖密钥的 server 一切正常 —— 于是很容易误判成"某个源坏了"或"设置没写对"。**根因是展开时机早于 env 落地，不是读不到设置**：occ 在启动阶段就把 MCP 配置读进来了（那段代码的注释写着"safe - just reads files, no execution"，就执行而言确实安全，但它同时把 `${VAR}` 也一并定死了），而项目级 settings 的 env 要等信任对话框跑完才进 `process.env` —— 启动期只应用一份安全白名单，用户自定义的密钥键不在其中。真正让这件事变得诡异的是**它同时留下了正确的那一份**：信任之后界面会重新读一次配置，这次展开是对的，但两份 config 的 JSON 不同，而 MCP 连接的缓存正是按 `名字 + config JSON` 做键 —— 于是**每个 server 有两个活着的子进程，一个 env 正确、一个是字面量，接管工具调用的偏偏是坏的那个**。`ps eww` 能同时看到这两份。`-p` 模式只走早期快照那一条，所以是稳定失败。修法是让展开结果与展开时机无关（解析器改为同时查 settings.env，顺序与信任后 `process.env` 的最终状态一致），而不是去挪启动顺序：解析期本来就不执行任何东西，信任后的那条路径也早就插值了同样的值，所以信任边界没有放宽 —— 顺带让两个缓存键收敛，每个 server 回到单进程。插件贡献的 MCP / LSP server 走同一处修复。
- 修掉一个只在登录过 ChatGPT 的机器上才会红的搜索测试（它要测 API-key 路由，却去读了真实凭据的落盘状态）。不影响运行时行为。

## 2.29.0 - 2026-08-06

- **端点不具备 OpenAI 官方搜索能力时，不再拿它去跑搜索**。occ 此前把「`OPENAI_API_KEY` 有值」当成「OpenAI 服务端 `web_search` 可用」，但在 occ 最常见的那种配置里，`OPENAI_BASE_URL` 指向的是第三方 OpenAI 兼容端点，那把 key 属于**该厂商**而不是 OpenAI。**失败形态是静默的，所以它一直没被发现**：以 DeepSeek 为例，provider 是 `openai`，于是 codex 被选为会话的**主搜索通道**；请求被正常接受（DeepSeek 确实实现了 Responses API），搜索也**真的执行了** —— 响应里能看到 `web_search_call` 条目。但 DeepSeek 既不返回 `url_citation` 注解、也不返回 `action.sources`，而这是 occ 仅有的两个结果提取点。于是主通道每一次查询都返回 0 条、全程不报任何错，模型把空列表读成「网上没有这个答案」。现在的判定是：**ChatGPT/Codex OAuth 登录直接算数**（那条路按构造就打到 OpenAI 自己的后端，`OPENAI_BASE_URL` 写什么都无关）；**只有 API key 时，还要求端点确实是 OpenAI**（复用既有的 `isOfficialOpenAIBaseURL`，它本来就是为「不要把 OpenAI 专属参数发给兼容端点」而写的）。判定刻意从严：一个真的把 web_search 透传出去的网关，和一个不透传的网关，从外部无法区分。
- **`/search-setting` 面板不再自己重算一遍连接状态**。它此前对 codex 单独写了一次 `OPENAI_API_KEY` 判断，于是对着一把 DeepSeek key 显示「✓ connected」—— 用户正是照着这个提示去勾选了一个只能返回空结果的源。现在面板和真正执行搜索的解析器共用同一个探针，两边不会再各说各话。
- **勾选开关改为单向：显式「关」始终生效，显式「开」不再能凭空造出能力**。勾选记录的是「能用的时候请用它」，而不是「请把请求打到一个无法完成搜索的后端」—— 一个被强制点亮却只会返回空的源，比没有这个源更糟。相应地，勾选一个未连接的源时不再静默写入一条无效覆写（勾上了、灯还是暗的），而是直接给出可操作的补救：**去登录该 provider 的 OAuth，或把端点换成能提供该搜索能力的配置**。已经存在的 `webSearchSources` 覆写不需要手工清理，它自动变成无害的空操作。

## 2.28.0 - 2026-08-06

- **WebSearch 在没有官方搜索源的会话里返回空结果或垃圾，根因是免费源被整体反爬挡死**。实测三个引擎无一幸免：DuckDuckGo 回的是 HTTP 202 anomaly 挑战页（页面里从头到尾没有 "captcha" 字样，只是让你"选出所有含鸭子的方块"），Mojeek 回 ALTCHA 验证码，Bing 的 www4 边缘也回验证码 —— 而且它的 `<title>` 仍然写着「<查询词> - Search」，看起来跟正常结果页一模一样。连兜底用的 9 个公共 SearXNG 实例也全军覆没：要么只回首页，要么挡在 Anubis 工作量证明页后面，其中一个直接超时。**真正让这件事变成"垃圾结果"而不是"报错"的，是这些页面解析出 0 条却不报错** —— 空列表一路传到模型，被读成"网上没有这个答案"，然后模型把这个错误结论转述给你。选择器本身是对的：把同样的页面喂给解析器，它们干净地返回 0 条。问题出在请求被认成了机器人。**补全 Chrome 131 的 client-hints 请求头之后 DuckDuckGo 直接恢复** —— 从 202、0 条变成 200、10 条组织结果。这里要如实说明**没修好的那半边**：Mojeek 和 Bing 认的是 TLS 握手指纹（JA3）和 HTTP/2 SETTINGS 帧，不是请求头；上游 free-search-mcp 靠 curl_cffi 的浏览器指纹伪装绕过，occ 移植时把它连同 Playwright 兜底一起砍掉了，而这两条在 Node/Bun 里都没有无依赖的等价物。所以这两个引擎继续留在池子里尽力而为，真正接住它们的是下面那条。另外新增了**反爬页识别**：被墙的页面现在记为错误而不是静默的 0 条 —— 这既是降级链能不能触发的前提，也让全灭时抛出的是「mojeek was captcha-gated」这种能照着查的话，而不是一个空列表。
- **免费搜索改成三层降级，并新增一批不会被验证码挡的 keyless API 源**。层次是 SERP 抓取（DuckDuckGo / Mojeek / Bing）→ 公共 SearXNG → **keyless JSON/Atom API**（Wikipedia、Stack Exchange、Hacker News、GitHub、arXiv），**只在上一层被墙或结果过少时才下探**，所以正常路径一次网络都不多花。加这一层的理由不是"多几个源"，而是它是**另一类**源：前两层都是 HTML 端点，会按客户端逐个决定给结果还是给验证码，是同一种失败模式；API 层是面向机器的公开接口，只要带 User-Agent 就应答，不会被指纹掉。两个刻意的设计：**API 结果追加在网页结果之后，不并入 RRF 融合** —— Wikipedia 在自己那一桶里永远是 rank 1，平级合并会让兜底源顶掉真正的答案；**GitHub 和 arXiv 按查询路由**，免得"东京天气"给你返回机器学习预印本，那是另一种垃圾。配额也是按兜底定位安排的：Stack Exchange 匿名 300 次/天、GitHub 搜索 10 次/分钟，常驻会烧穿，兜底则几乎不动用。同时**刷新了 SearXNG 实例清单**（原有 9 个实测全死），换上验证可用的 `paulgo.io` 与 `searxng.site`，并新增 `OCC_SEARX_INSTANCES`（逗号或空格分隔）供公共实例再次腐烂时自行指定 —— 这类清单腐烂得比这个文件里任何东西都快，不该每次都等一个版本。
- 已登录的官方搜索源（Anthropic 服务端 `web_search`、Gemini/Antigravity grounding、Codex Responses `web_search`）**行为不变**：它们本来就参与聚合，登录即点亮，这次改动只涉及免费源那条通道。

## 2.27.1 - 2026-08-06

- **修复模型选择页 ↑/↓ 选不动、Esc 退不回上一页**。两条症状成因不同。**方向键**：2.24.0 给模型步骤加 Tab 导航时用的键位上下文，把 `↑`/`↓` 也绑成了「上一个字段 / 下一个字段」—— 于是方向键在切**字段**而不是切**选项**，选择器根本拿不到方向键，整个列表无法驱动。现在当前字段是选择器时，那两个绑定让位给选择器本身；Tab 只在文本输入框上还有意义。**Esc**：登录流是在一个组件里按分支挂键位处理器的，切屏之后上一屏的处理器仍然注册着、而且排在前面先执行，而键位框架把「没有明确弃权」当成「已消费」—— 于是一次 Esc 要么退两屏（两个处理器都导航），要么直接死在旧的那个手里。现在过期的处理器会明确弃权，把按键交给真正当前的那一屏，Esc 稳定只退一级。

## 2.27.0 - 2026-08-06

- **国产模型：每个档位用哪个模型，现在自己说了算**。2.25.0 让一把 Key 配通整个供应商，但四个档位别名（`haiku` / `sonnet` / `opus` / `fable`）指向谁是 preset 表写死的。现在填完 Key 会进入一屏「<供应商> — Models」，四个档位各是一个选择器，选项就是该供应商的完整模型表，**默认值预填原来的映射** —— 一路回车就是老行为，想改哪个改哪个。这里刻意**没有「默认模型」字段**：那个字段写的是 `OPENAI_MODEL`，它压过所有档位别名**和** `/model <具体 id>`，一旦写上，切模型就成了无效操作。
- **新增 `/models`：随时改档位模型，不用重填 API Key**。此前想把 `opus` 从一个模型换到另一个，得重走一遍 `/login`，把端点和密钥再敲一次 —— 为了改一个跟凭据无关的字段而重输密钥，这种摩擦足以让人干脆不去动这个设置。`/models` 直接打开各登录流最后停的那一屏，端点、Key、四个档位的当前值全部从现有配置读回来，只改模型再写回去。候选模型来自后台已经缓存的 `/models` 结果，所以是瞬时且离线的。和新登录有一处刻意的不同：**候选表里没有的已配置值不会被清掉** —— 那是你有意配的，缓存可能只是旧了。纯 Anthropic 账号登录的会话里这个命令不出现，它的档位走内置 Claude 表，没有可指向的键。
- **端点不提供模型列表时，改用 occ 自己的表，而不是丢一个空输入框**。不实现 `GET /models` 的网关很常见，此前碰上就只能凭记忆手敲模型名。现在 occ 本来就维护着模型表的两家会拿那张表继续给选择器，并在顶部说明这是 occ 的已知列表、以及探测失败的原因：**Anthropic 兼容**用 Claude 全系 id，**OpenAI** 用 GPT 列表。端点答得上来时两边**合并**（端点的排前面），所以服务器漏报某个 occ 认识的模型也仍然可选。**Gemini 和 Grok 故意没有内置表** —— 给它们现编一份第三方模型 id 清单意味着长期手工维护一份注定过时的东西，而那正是端点探测要解决的问题；这两家继续「探测 + 手填」。

## 2.26.1 - 2026-08-05

- **修复 2.26.0 的两项 DeepSeek 默认值对默认会话一项都没生效**。上一版加的 `max` effort 和 1M 上下文，只有手动用 `/model` 选了具体模型 id 的会话才吃得到。原因是主循环模型通常是**家族别名** —— 没显式选过模型时它就是 `sonnet`，而 `deepseek-v4-pro` 要等适配器把 `OPENAI_DEFAULT_SONNET_MODEL` 应用之后才出现。拿别名去问「这是不是 DeepSeek」永远得到否，于是恰好对最需要它的那批会话全部失效。同一处还牵出第二个症状：判断模型是否支持 effort 的函数拿到别名后会走进 haiku/sonnet/opus 的排除分支，对**任何** OpenAI 兼容 provider 的默认会话都报「不支持 effort」，于是状态栏的 effort 指示器干脆隐藏。两处现在都先解析别名再判断。需要说明的是，真正发出去的请求那半边从 2.26.0 起就是对的（适配器用的一直是解析后的模型名，`reasoning_effort: max` 确实在发）—— 坏掉的是状态栏显示，以及上下文窗口：窗口停在 200k 会让会话在还剩八成空间时就开始 auto-compact，那一项是实打实的影响。

## 2.26.0 - 2026-08-05

- **DeepSeek 会话默认跑 `max` effort，上下文按 1M 算**。两项都只在 DeepSeek 门控内生效，其他 OpenAI 兼容端点（GLM / Kimi / 千问 / MiMo / 本地 vLLM）请求体逐字节不变。**effort**：DeepSeek 的梯子只有三级（`low`/`high`/`max`），不传参时是 `high`，occ 早先也就跟着跑 `high`。改成 `max` 的理由是从默认到顶只差一步，而不是五档命名暗示的那种长爬升 —— 而「高强度 agent 场景」正是这个工具的全部工作量。只有地板抬高了：`/effort` 和 `CLAUDE_CODE_EFFORT_LEVEL` 仍然优先，想跑便宜档说一声就有；thinking 关闭时照旧不发这个字段，这也顺带让新默认不会落到不认它的旧 checkpoint 上。**上下文**：DeepSeek V4 是 1M 上下文族，而第三方模型探测不到窗口时的兜底是 200k —— 差 5 倍，直接后果是会话在还剩八成窗口时就开始 auto-compact。现在模型名含 `deepseek` 即按 1M 计，贯通 auto-compact 阈值、硬阻断线、statusline 的 `ctx:%` 和 `/context`。这一项**只按模型名判定、不看 baseURL**（和请求路径的门控不同）：窗口解析对所有 provider 都会跑，残留一个指向 DeepSeek 的 `OPENAI_BASE_URL` 不该把 1M 窗口发给 Anthropic 会话。网关把模型改名到认不出来时会落回 200k，`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 就是为这种情况准备的纠正入口；部署实际提供的窗口更小时用 `CLAUDE_CODE_DISABLE_1M_CONTEXT` 退回默认。

## 2.25.0 - 2026-08-05

- **国产模型：一个 API Key 配的是整个供应商，不再是一个模型**。原来的流程是「选供应商 → 选计费方式 → **选一个模型** → 填 Key」，保存时把选中的那个模型同时写进 haiku/sonnet/opus 三个档位键。也就是说一把 Key 只换来一个模型：三个档位指向同一个 id，想换成同一家的另一个模型得重新走一遍 `/login`。现在**没有选模型这一步** —— 填完 Key，该供应商的所有模型立刻都能用，`/model` 里直接列出完整模型表（带官方标签、价格、上下文窗口），随时切换。四个档位别名按 preset 映射到各自对应的模型：DeepSeek 的 `haiku` 是 V4 Flash，`sonnet`/`opus`/`fable` 是 V4 Pro；GLM 的 `haiku` 是 4.7-Flash、`sonnet` 是 4.7、`opus`/`fable` 是 5.1；千问和 MiMo 同理。有两个键是**刻意不写**的，也是老行为的成因所在：`OPENAI_MODEL` 的优先级压过四个档位别名**和** `/model <具体 id>`，写了它切模型就是无效操作；`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 是单个全局值，描述不了一份混着不同窗口的模型表（GLM 的 203K 和 205K 就挨在一起），现在改为按模型从 preset 表查真实窗口，排在环境变量覆盖**之下** —— 那个键仍然是唯一的用户纠正入口。
- **渲染残影的排查进展（这条不是修复）**。有一例输入框里冒出孤立残字的报告。2.19.0 那轮模糊测试证明了「非滚动、无样式的增量渲染路径」是干净的，但它每帧都新建一块缓冲，而实际运行时是**双缓冲** —— 复用两帧之前那块缓冲原地重置。这个差异一直写在测试的注释里、从没被覆盖过。这次把它补上了，又叠了一层子树复用快路径（未变的行不重绘、直接从上一帧复制）。两种模式各跑 20000 个种子 × 5 帧和 20 帧，**零分歧** —— 结论是阴性：缓冲复用和复用快路径都不是成因。嫌疑因此收窄到滚动、带背景样式的单元格、absolute 浮层、窗口尺寸变化，以及绕过输出拦截直接写 stdout 的第三方代码。排查继续。

## 2.24.0 - 2026-08-05

- **配 Anthropic 兼容 / Gemini / Grok 端点时，不用再凭记忆手打模型名了**。此前只有 OpenAI 的两条线是两步流：先填 Base URL 和 API Key，occ 拿着刚输入的凭据去问端点 `GET /models`，再让你从它**实际提供**的模型里选。另外三家是扁平表单 —— 端点、key、模型名挤在一屏里，模型名全靠自己敲对，敲错要等到第一次真实请求失败才知道。现在四家走的是同一个向导：**Step 1** 只填连接信息（这一步不写任何设置），**Step 2** 默认模型和四个档位都是从端点返回的列表里选。拉不到列表就退回手填，并把失败原因显示出来（比如 `fetch failed (connect ECONNREFUSED 127.0.0.1:9)`，而不是光一句 "fetch failed"）—— 端点能用但不实现 `/models` 的网关很常见，那从来不该挡住配置。**Grok 表单同时补上了四个档位字段**：`GROK_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL` 这四个键早就在配置系统里，只是表单从没给过入口。另外三处此前各写各的行为也统一了：Base URL 合法性校验（原来只有 OpenAI 做）、保存后清 provider client 缓存（原来只有 OpenAI 和 Grok 做）、以及档位字段的有无。三条刻意保留的差异：Base URL 留空时探测发往该 provider 的默认端点但**不写入** `*_BASE_URL`（写进去等于把会话钉死在今天这个地址）；API Key 留空只有 OpenAI 会拦，其余三家跳过探测直接进手填，好让无鉴权的本地网关（套 Anthropic 兼容壳的 vLLM 之类）继续能配；校验按家不同 —— OpenAI 必须选默认模型，Gemini 要么填默认模型要么三档填全，Anthropic 兼容与 Grok 可以全空靠内置默认。

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
