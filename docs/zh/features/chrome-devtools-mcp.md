<!-- lang-switcher -->
[English](/docs/en/features/chrome-devtools-mcp) · **中文** · [日本語](/docs/ja/features/chrome-devtools-mcp)

# Chrome 浏览器工具（chrome-devtools-mcp）

## 1. 功能简介

occ 的浏览器控制由 Google 官方的 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)（Apache-2.0）提供。它以 stdio MCP server 的身份被 occ 拉起，通过 Chrome DevTools Protocol 操作浏览器：

- 列出/切换/新建/关闭页面，导航前进后退
- 点击、输入、拖拽、填表、上传文件、处理弹窗
- 页面可访问性快照（`take_snapshot`）与截图
- 读取控制台消息与网络请求
- 性能 trace 与 Lighthouse 审计
- 设备模拟与窗口尺寸调整

> **旧的扩展方案已删除。** occ 此前继承了一套基于 Chrome 扩展 + native messaging host 的实现，但那套链路只认官方 Claude Code 的 host 身份 —— occ 装上去等于劫持另一个产品的浏览器集成。所以它一直是 fail-closed 的（`--chrome` 只会打印一条错误）。改用 stdio MCP server 之后，occ 与官方 Claude Code 之间**没有任何共享身份**：这只是 occ 自己 spawn 的一个子进程。

## 2. 前置条件

| 条件 | 说明 |
|------|------|
| Node.js | LTS 版本。occ 用它来跑 MCP server 进程 |
| Google Chrome | `--autoConnect` 需要 **Chrome 144+**；低版本仍可用，但会另开一个空白 profile 的浏览器 |
| 订阅 | **不需要**。这是本地进程，不经过 Anthropic |

`chrome-devtools-mcp` 是 occ 的运行时依赖，随 npm 包一起安装，无需单独装扩展或注册 native host。若依赖在运行时解析不到，occ 会回退到 `npx -y chrome-devtools-mcp@latest`。

## 3. 启用方式

```bash
# Dev 模式
bun run dev -- --chrome

# 构建产物
node dist/cli.js --chrome

# 禁用
occ --no-chrome
```

也可以：

- 设 `CLAUDE_CODE_ENABLE_CFC=1` 环境变量；
- 在 `/config` 面板里把「Chrome browser tools enabled by default」打开（写入 `chromeDevtoolsDefaultEnabled`）。

优先级：`--chrome` / `--no-chrome` > `CLAUDE_CODE_ENABLE_CFC` > `chromeDevtoolsDefaultEnabled`，默认关闭。**非交互会话（SDK / CI / `-p`）默认不启用**，除非显式传 `--chrome` —— 在 CI 里悄悄拉起一个浏览器不会是任何人的本意。

在 REPL 里用 `/chrome` 查看当前状态：Chrome 版本、连接模式、是否已连上、默认开关。

## 4. 连接模式

### autoConnect（默认）

附着到用户**已经开着的** Chrome，用真实 profile 和已登录状态，而不是另开一个需要重新登录的空白浏览器。

要求：

- Chrome 144 或更新；
- 在该 Chrome 里通过 `chrome://inspect/#remote-debugging` 打开远程调试。

版本不够时 `chrome-devtools-mcp` 会自己启动一个带临时 profile 的浏览器 —— 页面能开，但所有站点都是登出状态。这个失败是无声的，所以 `occ doctor` 会提前把它讲出来。

### browser-url（WSL / 远程 / 容器）

设 `OCC_CHROME_BROWSER_URL`，occ 改用 `--browserUrl` 连过去：

```bash
# Windows 侧启动 Chrome
chrome.exe --remote-debugging-port=9222

# WSL 侧
export OCC_CHROME_BROWSER_URL=http://127.0.0.1:9222
occ --chrome
```

这是 WSL 下唯一可行的路径：Chrome 装在 Windows 上，Linux namespace 里根本没有可驱动的浏览器。同样适用于远程桌面和容器场景。

### 让 server 自己启动浏览器

设 `OCC_CHROME_AUTOCONNECT=0`，不传 `--autoConnect`，由 `chrome-devtools-mcp` 自行拉起 Chrome。适合不想让 agent 碰自己登录态的场合。

## 5. 权限模型

工具全名形如 `mcp__chrome-devtools__<tool>`，走的是**和其他 MCP server 完全一样的权限流程**，只有一个例外：

**免确认（只读观察类，共 9 个）**

`take_snapshot`、`take_screenshot`、`list_pages`、`list_console_messages`、`get_console_message`、`list_network_requests`、`get_network_request`、`performance_analyze_insight`、`wait_for`

**需要确认（其余全部）**

`click`、`drag`、`fill`、`fill_form`、`hover`、`press_key`、`type_text`、`upload_file`、`handle_dialog`、`navigate_page`、`new_page`、`close_page`、`select_page`、`emulate`、`resize_page`、`evaluate_script`、`performance_start_trace`、`performance_stop_trace`、`lighthouse_audit`、`take_heapsnapshot`

分界线是「会不会改变浏览器状态」。因为这套工具驱动的通常是用户**本人的、已登录的**浏览器，所以任何点击、输入、导航、脚本执行都必须先问过。`chrome-devtools` skill 的 `allowedTools` 刻意用的是同一份只读列表 —— skill 的 `allowedTools` 会变成 always-allow 规则，把动作类工具列进去等于悄悄拆掉这道闸。

## 6. 遥测

occ 默认关闭 `chrome-devtools-mcp` 的上游遥测，两条 Google 官方支持的开关都用上了：

- 命令行 `--no-usage-statistics`
- 环境变量 `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`、`CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`

occ 不会替用户向第三方发送使用统计。

## 7. 诊断

`occ doctor` 会报告：

```
└ Chrome (--chrome): 144.0.7204.50 (autoConnect)
```

或在有问题时给出一行处置建议，例如：

- `Chrome not found. Install Google Chrome, or set OCC_CHROME_BROWSER_URL ...`
- `Chrome 138.x is below 144, so --autoConnect cannot attach to it. A separate browser with an empty profile will be launched instead (no logins).`
- `WSL detected. Chrome on the Windows side is not reachable from here — start it with --remote-debugging-port=9222 and set OCC_CHROME_BROWSER_URL=http://127.0.0.1:9222`

## 8. 常见问题

### 工具没出现在工具列表里

确认启动时带了 `--chrome`，然后 `/mcp` 看 `chrome-devtools` 是否 connected。启用了工具搜索（`EXPERIMENTAL_SEARCH_EXTRA_TOOLS`）时 MCP 工具是延迟加载的，模型需要先用 `SearchExtraTools` 把它们取出来 —— 系统提示里已经写了这一步。

### 连上了但所有网站都是登出状态

`--autoConnect` 没能附着上，`chrome-devtools-mcp` 另开了一个临时 profile 的浏览器。跑 `occ doctor` 看 Chrome 版本是否 ≥ 144，以及是否在 `chrome://inspect/#remote-debugging` 里开了远程调试。

### WSL 下连不上

见上面的 browser-url 一节。WSL 里的 Linux 侧通常压根没装 Chrome。

### 不用浏览器功能时

不带 `--chrome` 正常启动即可，不会 spawn 任何浏览器相关进程。

## 9. 相关文档

- 上游仓库与工具参考：https://github.com/ChromeDevTools/chrome-devtools-mcp
- `docs/zh/features/chrome-use-mcp.md` 讲的是**另一个东西** —— 第三方 `hangwin/mcp-chrome`（默认注册但默认禁用的 `mcp-chrome` HTTP server，端口 12306），与本文无关。
