# Changelog

open-claude-code(`occ`)的对外发布记录。

格式由应用内「更新说明」的解析器约束（`parseChangelog`，见 `src/utils/update/releaseNotes.ts`）：版本标题必须是 `## <semver>` 或 `## <semver> - <日期>`，条目必须是顶层 `- ` 列表项。嵌套列表会被拍平成同级条目，所以不要用；第一个 `## ` 之前的内容会被整段跳过。新版本小节由 `bun run release <version>` 插入。

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
