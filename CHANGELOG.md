# Changelog

open-claude-code(`occ`)的对外发布记录。

格式由应用内「更新说明」的解析器约束（`parseChangelog`，见 `src/utils/update/releaseNotes.ts`）：版本标题必须是 `## <semver>` 或 `## <semver> - <日期>`，条目必须是顶层 `- ` 列表项。嵌套列表会被拍平成同级条目，所以不要用；第一个 `## ` 之前的内容会被整段跳过。新版本小节由 `bun run release <version>` 插入。

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
