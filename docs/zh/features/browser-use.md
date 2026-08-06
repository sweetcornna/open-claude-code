<!-- lang-switcher -->
[English](/docs/en/features/browser-use) · **中文** · [日本語](/docs/ja/features/browser-use)

# 浏览器工具（browser-use）

## 1. 功能简介

occ 的浏览器控制由 [`browser-use`](https://github.com/browser-use/browser-use) 提供。它以 stdio MCP server 的身份被 occ 拉起，驱动一个真实的 Chrome/Chromium：

- 读取页面状态（`browser_get_state`）—— 页面上有什么、哪些元素可交互
- 抽取内容（`browser_extract_content`）—— 要信息而不是要结构时用它，比在原始状态上推理便宜得多
- 导航、点击、输入、滚动、后退
- 标签与会话管理
- `retry_with_browser_use_agent` —— 把整个任务交给一个自主浏览 agent

> **之前用的是 chrome-devtools-mcp，已删除。** 那套暴露的是原始 DevTools 面（网络请求、控制台、性能追踪、Lighthouse）。换成 browser-use 是为了拿到语义动作，代价是失去 DevTools 独有的那几项能力 —— 如果你依赖它们，这个版本不适合你。

## 2. 前置条件

| 条件 | 说明 |
|------|------|
| `uvx` | **必需**。browser-use 是 Python 工具。装 [uv](https://docs.astral.sh/uv/getting-started/installation/) 即可 |
| Chrome / Chromium | **必需**。browser-use 驱动的是真实浏览器 |
| 模型凭据 | 见下节。OAuth 登录的用户不需要额外配置 |
| 订阅 | **不需要**。这是本地进程，不经过 Anthropic |

`--chrome` 会先探测 `uvx`，找不到就直接给出安装地址并退出 —— 而不是把一个裸 ENOENT 丢给 MCP 层，那个错误无从下手。

## 3. 凭据

browser-use 要跑自己的模型调用（自主 agent 与内容抽取路径），所以需要一份自己的凭据。occ 会自动处理：

- **用 API key 登录**：环境里已有 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`，子进程直接继承，occ 不做任何干预。
- **用 OAuth 登录**：环境里没有任何 key，只有 keychain 里的 access token。occ 把它作为 `ANTHROPIC_AUTH_TOKEN`（Anthropic SDK 的 bearer 变量）传给子进程。

你自己显式设过的变量一律不会被覆盖。

## 4. 启用方式

| 方式 | 说明 |
|------|------|
| `occ --chrome` | 本次会话启用 |
| `occ --no-chrome` | 本次会话强制关闭，优先级最高 |
| `CLAUDE_CODE_ENABLE_CFC=1` | 环境变量启用 |
| `/chrome` 面板 | 查看状态、切换「默认启用」 |
| 配置键 `browserToolDefaultEnabled` | 持久化默认值（旧键 `chromeDevtoolsDefaultEnabled` 仍然读取） |

非交互会话（SDK、CI、`-p`）默认关闭，除非显式传了 `--chrome`。

## 5. 权限

只有四个**纯观察类**工具预授权、不弹权限提示：

`browser_get_state`、`browser_extract_content`、`browser_list_tabs`、`browser_list_sessions`

其余全部走正常 MCP 权限流程 —— 包括 `retry_with_browser_use_agent`，它会自主连续操作很多步，所以尤其需要你点头。

这个门槛是有意的：它驱动的是一个真实的、可能已登录的浏览器。

## 6. 排查

| 症状 | 原因 |
|------|------|
| `browser tools need \`uvx\`` | 没装 uv。见前置条件 |
| server 启动后第一次调用报认证错误 | browser-use 拿不到模型凭据。检查是否登录，或手动设 `ANTHROPIC_API_KEY` |
| 报找不到浏览器 | 没装 Chrome/Chromium。`occ doctor` 会显示检测结果 |
| 工具名调不到 | 开了工具搜索时 MCP 工具是延迟加载的，先用 SearchExtraTools 加载 `mcp__browser-use__*` |

## 7. 参考

- upstream repository: https://github.com/browser-use/browser-use
- MCP server 文档: https://docs.browser-use.com/customize/mcp-server
