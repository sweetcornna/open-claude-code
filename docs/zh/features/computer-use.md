<!-- lang-switcher -->
**中文**

# Computer Use

更新时间：2026-07-31
参考项目：`E:\源码\claude-code-source-main\claude-code-source-main`

## 后端选择

`computerUse.backend` 控制 occ 如何提供 Computer Use 工具：

| 值 | 行为 |
|---|---|
| `"builtin"` | 默认值。注册进程内的 `@ant/computer-use-mcp`，使用本项目的审批 UI 和安全层。 |
| `"external"` | 不注册、不连接进程内服务器。名为 `computer-use` 的服务器也不再视为内置保留名，必须通过普通 MCP 配置显式添加。 |

用户设置示例：

```json
{
  "computerUse": {
    "backend": "external"
  }
}
```

设置外部后端后，重启正在运行的 occ 会话，再按外部服务器自己的安装说明添加其 stdio 命令：

```bash
occ mcp add computer-use -s user -- <server-command> <server-args...>
occ mcp list
```

推荐使用 `computer-use` 作为服务器名，以得到稳定的
`mcp__computer-use__*` 工具前缀。在 `external` 模式下，该名称通过普通
stdio MCP 客户端启动，不会被替换为进程内服务器。切回 `builtin` 前应先移除同名外部配置：

```bash
occ mcp remove computer-use -s user
```

> **安全警告：外部后端会绕过本项目的 Computer Use 安全层。** 外部服务器的工具调用不经过
> `ComputerUseHostAdapter`、`toolCalls` 调度器或 Computer Use 审批 UI，因此没有
> `deniedApps` / `sentinelApps` 策略、每应用 `read` / `click` / `full` 授权层级、
> `keyBlocklist`、剪贴板保护、`pixelCompare` 点击校验、跨会话锁或 ESC 中止。
> 它只获得普通、粒度更粗的 MCP 工具权限提示。启用前必须独立审查服务器及其操作系统权限。

可调研的社区项目包括：

- [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)：面向 Windows。
- [QwenLM/open-computer-use](https://github.com/QwenLM/open-computer-use)：跨平台方向。

这些链接只是社区选项，不代表本项目的认可、安全审计或兼容性承诺；具体启动命令、工具名称和依赖以各项目文档为准。

## Host Adapter 合约

`packages/@ant/computer-use-mcp/src/index.ts` 导出的
`ComputerUseHostAdapter` / `ComputerExecutor` 是保留内置安全层时的受支持插入点。
它适合接入新的桌面宿主或原生自动化实现。它与 `external` 后端不是同一种扩展方式：
adapter 接入仍走本项目的授权和安全调度；外部 MCP 则替换整个实现。

相关公开接口包括：

```ts
import {
  bindSessionContext,
  createComputerUseMcpServer,
  type ComputerExecutor,
  type ComputerUseHostAdapter,
  type ComputerUseSessionContext,
  type CoordinateMode,
} from '@ant/computer-use-mcp'
```

宿主应构造一个进程生命周期内复用的 `ComputerUseHostAdapter`，并为每个会话构造
`ComputerUseSessionContext`。最直接的接法是把两者交给
`createComputerUseMcpServer(adapter, coordinateMode, sessionContext)`；若宿主已有 MCP
管理层，可调用 `bindSessionContext()` 得到会话绑定的工具分发函数。没有
`sessionContext` 的 `createComputerUseMcpServer()` 只适合列出工具，其工具调用处理器不会获得真实会话状态。

### `ComputerUseHostAdapter`

| 成员 | 宿主责任 | 安全触点 |
|---|---|---|
| `serverName`, `logger` | 提供稳定的 MCP 身份和五级日志实现。日志不得把截图、剪贴板或应用内容变成遥测字段。 | 调度异常会被记录并转换为工具错误。 |
| `executor` | 实现下述操作系统能力。所有异步操作必须在完成后才 resolve，失败时 reject。 | 输入只应由受保护的调度器调用。 |
| `ensureOsPermissions()` | 做纯检查，不弹窗、不重启。macOS 必须准确返回 Accessibility 和 Screen Recording 状态。 | kill switch 之后、任何 executor 调用之前的全局门。 |
| `isDisabled()` | 实时读取宿主的 Computer Use 总开关。 | 每次工具调用的第一道门。 |
| `getAutoUnhideEnabled()` | 返回回合结束时是否恢复被隐藏应用的宿主偏好。 | 用于授权 UI 的隐藏预告；实际清理由宿主负责。 |
| `getSubGates()` | 每次调用返回当前 `CuSubGates`，不要在 adapter 内冻结动态配置。 | 控制截图点击校验、剪贴板保护、隐藏、显示器选择等子门。 |
| `cropRawPatch()` | 将 base64 图片解码，裁剪矩形并返回稳定的原始像素字节；失败返回 `null`。 | `pixelCompare` 使用它验证点击区域。`null` 表示跳过校验，不应伪造像素。 |

### `ComputerExecutor`

必选方法按责任分组如下。完整签名以 `src/executor.ts` 的导出接口为准。

| 分组 | 方法 | 合约要求 |
|---|---|---|
| 能力 | `capabilities` | `hostBundleId` 必须标识宿主 UI；`screenshotFiltering` 必须如实声明是否能按应用过滤；`platform` 当前公开类型为 `darwin \| win32`。 |
| 显示器和截图 | `getDisplaySize`, `listDisplays`, `findWindowDisplays`, `resolvePrepareCapture`, `screenshot`, `zoom` | 坐标使用全局逻辑点并包含显示器原点。`ScreenshotResult` 的图像尺寸、捕获时显示器尺寸、原点和 `displayId` 必须属于同一次捕获。`resolvePrepareCapture` 应把选择显示器、隐藏应用和截图作为一个一致操作。 |
| 隐藏预处理 | `previewHideSet`, `prepareForAction` | `previewHideSet` 不得改变桌面；`prepareForAction` 隐藏非 allowlist 应用、移开宿主焦点，并返回实际隐藏的应用 ID。Finder/桌面等平台例外必须与宿主策略一致。 |
| 应用身份 | `listInstalledApps`, `listRunningApps`, `getFrontmostApp`, `appUnderPoint`, `getAppIcon`, `openApp` | 所有方法必须使用同一种稳定应用 ID。前台查询和命中测试的 ID 必须能与授权 grant 精确比较，否则每应用层级会失效。 |
| 键鼠输入 | `key`, `holdKey`, `type`, `moveMouse`, `click`, `mouseDown`, `mouseUp`, `getCursorPosition`, `drag`, `scroll` | 接收已经缩放的逻辑坐标。不要自行绕过调度器启动第二条全局输入路径。部分完成后失败必须 reject，便于上层 fail closed。 |
| 剪贴板 | `readClipboard`, `writeClipboard` | 精确读写文本，并保留空字符串。click-tier 剪贴板暂存、清空和恢复依赖这两个方法。 |

Windows 的窗口绑定、UI Automation、虚拟键鼠、状态指示器和终端启动方法在接口中均为可选。
未实现时保持 `undefined`；实现后用 `false` / `null` 表示“当前无绑定或未找到”，用 reject
表示执行故障。不要返回伪成功，否则模型会在错误的窗口状态上继续操作。

平台约束：

- `screenshotFiltering: "native"` 表示截图实现真的只暴露授权应用，并能提供有意义的前台应用和坐标命中测试。
- `screenshotFiltering: "none"` 会让审批 UI 告知用户所有应用可能可见；非 macOS 的全局前台门也不会被当成隔离保证。
- 公开 `ComputerExecutorCapabilities.platform` 目前只声明 `darwin | win32`。仓库内 Linux CLI 通过兼容层路由，尚不是 adapter 合约中的一等平台字面量。
- `CoordinateMode` 在工具 schema 建立后必须保持固定。截图和点击不能在会话中途从 `pixels` 切换为 `normalized_0_100`。

### 会话状态和安全层

`ComputerUseSessionContext` 不是可选的便利封装，而是多数安全状态的宿主边界：

- `onPermissionRequest` / `onTeachPermissionRequest` 必须展示用户可见的阻塞式审批，并响应传入的 `AbortSignal`；`onAllowedAppsChanged` 保存每会话 grant 和 grant flags。
- `getAllowedApps`、`getGrantFlags` 和 `getUserDeniedBundleIds` 必须读取最新状态。内置调度器据此执行 `deniedApps`、`sentinelApps` 和每应用授权层级。
- `checkCuLock` / `acquireCuLock` 必须原子地保证同一时间只有一个会话控制桌面。锁的释放属于宿主的 idle、stop 和 archive 生命周期。
- `isAborted` 必须连接到宿主的停止操作；ESC 热键由宿主捕获后也应更新同一中止状态，使批处理和长文本输入能在循环中停止。
- `getClipboardStash` / `onClipboardStashChanged` 保存 click-tier 剪贴板保护状态。宿主必须在回合结束时恢复并清除仍存在的 stash。
- `onAppsHidden` 记录本回合隐藏的应用。宿主必须在回合结束或中止时按偏好恢复它们。
- `onScreenshotCaptured` 应持久化不含 base64 的尺寸元数据；`bindSessionContext` 自己保留当前截图 blob，供坐标缩放和点击校验使用。

安全判断应留在 `@ant/computer-use-mcp` 的工具调度器中。adapter/executor 的职责是准确报告桌面状态并执行已批准的原语，而不是复制或放宽策略。executor 抛出的异常会转换为工具错误；宿主仍应让多步骤原语尽量幂等，并在中途失败时释放按键、鼠标键和临时资源。

---

## 跨平台实施记录

## 1. 现状

参考项目的 Computer Use **仅支持 macOS**——从入口到底层全部写死 darwin。我们的项目在 Phase 1-3 中已经完成了：

- ✅ `@ant/computer-use-mcp` stub 替换为完整实现（12 文件）
- ✅ `@ant/computer-use-input` 拆为 dispatcher + backends（darwin + win32）
- ✅ `@ant/computer-use-swift` 拆为 dispatcher + backends（darwin + win32）
- ✅ `CHICAGO_MCP` 编译开关已开
- ✅ `src/` 层 macOS 硬编码已移除（Phase 2 已完成）

## 2. 阻塞点全景

### 2.1 入口层

| # | 文件:行号 | 阻塞代码 | 影响 |
|---|----------|---------|------|
| 1 | `src/main.tsx:2366` | `feature("CHICAGO_MCP")` 门控 | CU 初始化入口 |

### 2.2 加载层

| # | 文件:行号 | 阻塞代码 | 影响 |
|---|----------|---------|------|
| 2 | `src/utils/computerUse/swiftLoader.ts` | macOS-only loader（已改为仅 darwin 加载） | 非 darwin 使用 platforms/ 替代 |
| 3 | `src/utils/computerUse/executor.ts:302` | `process.platform !== 'darwin'` → cross-platform executor | 非 darwin 走跨平台路径 |

### 2.3 macOS 特有依赖

| # | 文件:行号 | 依赖 | macOS 实现 | 需要替代方案 |
|---|----------|------|-----------|------------|
| 4 | `executor.ts:72-96` | 剪贴板 | `pbcopy`/`pbpaste` / PowerShell / xclip | Win: PowerShell `Get/Set-Clipboard`；Linux: `xclip`/`wl-copy` |
| 5 | `drainRunLoop.ts` | CFRunLoop pump | `cu._drainMainRunLoop()` | 非 darwin：直接执行 fn()，不需要 pump |
| 6 | `escHotkey.ts` | ESC 热键 | CGEventTap | 非 darwin：返回 false（已有 Ctrl+C fallback） |
| 7 | `hostAdapter.ts` | 系统权限 | TCC accessibility + screenRecording | Win：直接 granted；Linux：检查 xdotool |
| 8 | `common.ts:55-58` | 平台标识 | 动态获取 | 已改为 `process.platform` 分发 |
| 9 | `executor.ts:232` | 粘贴快捷键 | `command`/`ctrl` 分发 | 已按平台分发粘贴快捷键 |

### 2.4 缺失的 Linux 后端

| 包 | macOS | Windows | Linux |
|---|-------|---------|-------|
| `computer-use-input/backends/` | ✅ darwin.ts | ✅ win32.ts | ❌ 需新建 linux.ts |
| `computer-use-swift/backends/` | ✅ darwin.ts | ✅ win32.ts | ❌ 需新建 linux.ts |

## 3. 每个平台的能力依赖

### 3.1 computer-use-input（键鼠）

| 功能 | macOS | Windows | Linux |
|------|-------|---------|-------|
| 鼠标移动 | CGEvent JXA | SetCursorPos P/Invoke | xdotool mousemove |
| 鼠标点击 | CGEvent JXA | SendInput P/Invoke | xdotool click |
| 鼠标滚轮 | CGEvent JXA | SendInput MOUSEEVENTF_WHEEL | xdotool scroll |
| 键盘按键 | System Events osascript | keybd_event P/Invoke | xdotool key |
| 组合键 | System Events osascript | keybd_event 组合 | xdotool key combo |
| 文本输入 | System Events keystroke | SendKeys.SendWait | xdotool type |
| 前台应用 | System Events osascript | GetForegroundWindow P/Invoke | xdotool getactivewindow + /proc |
| 工具依赖 | osascript（内置） | powershell（内置） | xdotool（需安装） |

### 3.2 computer-use-swift（截图 + 应用管理）

| 功能 | macOS | Windows | Linux |
|------|-------|---------|-------|
| 全屏截图 | screencapture | CopyFromScreen | gnome-screenshot / scrot / grim |
| 区域截图 | screencapture -R | CopyFromScreen(rect) | gnome-screenshot -a / scrot -a / grim -g |
| 显示器列表 | CGGetActiveDisplayList JXA | Screen.AllScreens | xrandr --query |
| 运行中应用 | System Events JXA | Get-Process | wmctrl -l / ps |
| 打开应用 | osascript activate | Start-Process | xdg-open / gtk-launch |
| 隐藏/显示 | System Events visibility | ShowWindow/SetForegroundWindow | wmctrl -c / xdotool |
| 工具依赖 | screencapture + osascript | powershell | xdotool + scrot/grim + wmctrl |

### 3.3 executor 层

| 功能 | macOS | Windows | Linux |
|------|-------|---------|-------|
| drainRunLoop | CFRunLoop pump | 不需要 | 不需要 |
| ESC 热键 | CGEventTap | 跳过（Ctrl+C fallback） | 跳过（Ctrl+C fallback） |
| 剪贴板读 | pbpaste | `powershell Get-Clipboard` | xclip -o / wl-paste |
| 剪贴板写 | pbcopy | `powershell Set-Clipboard` | xclip / wl-copy |
| 粘贴快捷键 | command+v | ctrl+v | ctrl+v |
| 终端检测 | __CFBundleIdentifier | WT_SESSION / TERM_PROGRAM | TERM_PROGRAM |
| 系统权限 | TCC check | 直接 granted | 检查 xdotool 安装 |

## 4. 执行步骤

### Phase 1：已完成 ✅

- [x] `@ant/computer-use-mcp` stub → 完整实现
- [x] `@ant/computer-use-input` dispatcher + darwin/win32 backends
- [x] `@ant/computer-use-swift` dispatcher + darwin/win32 backends
- [x] `CHICAGO_MCP` 编译开关

### Phase 2：移除 6 处 macOS 硬编码（解锁 macOS + Windows）

**改动原则：macOS 代码路径不变，只在每处 darwin 守卫后加 win32/linux 分支。**

| 步骤 | 文件 | 改动 |
|------|------|------|
| 2.1 | `src/main.tsx:2366` | `feature("CHICAGO_MCP")` → 已为跨平台入口 |
| 2.2 | `src/utils/computerUse/swiftLoader.ts` | 已改为仅 darwin 加载，非 darwin 使用 platforms/ |
| 2.3 | `src/utils/computerUse/executor.ts:302-309` | 已改为 cross-platform dispatch（非 darwin → createCrossPlatformExecutor） |
| 2.4 | `src/utils/computerUse/executor.ts:72-96` | 剪贴板已按平台分发：darwin→pbcopy/pbpaste，win32→PowerShell，linux→xclip |
| 2.5 | `src/utils/computerUse/executor.ts:232` | 粘贴快捷键已按平台分发：darwin→command，其他→ctrl |
| 2.6 | `src/utils/computerUse/executor.ts:302-309` | 非 darwin 已改为 `createCrossPlatformExecutor()` |
| 2.7 | `src/utils/computerUse/drainRunLoop.ts` | 非 darwin 无需 pump（直接执行 fn） |
| 2.8 | `src/utils/computerUse/escHotkey.ts` | 非 darwin 返回 false（已有 Ctrl+C fallback） |
| 2.9 | `src/utils/computerUse/hostAdapter.ts` | 非 darwin 权限检查逻辑已实现 |
| 2.10 | `src/utils/computerUse/common.ts:58` | 已改为动态 `process.platform` 分发 |
| 2.11 | `src/utils/computerUse/common.ts:55` | 已改为 darwin→'native'，其他→'none' |
| 2.12 | `src/utils/computerUse/gates.ts:55` | 已更新（需验证 enabled 默认值） |
| 2.13 | `src/utils/computerUse/gates.ts:39` | `hasRequiredSubscription()` 已更新 |

### Phase 3：新增 Linux 后端

| 步骤 | 文件 | 内容 |
|------|------|------|
| 3.1 | `packages/@ant/computer-use-input/src/backends/linux.ts` | xdotool 键鼠（mousemove/click/key/type/getactivewindow） |
| 3.2 | `packages/@ant/computer-use-swift/src/backends/linux.ts` | scrot/grim 截图 + xrandr 显示器 + wmctrl 窗口管理 |
| 3.3 | `packages/@ant/computer-use-input/src/index.ts` | dispatcher 加 `case 'linux'` |
| 3.4 | `packages/@ant/computer-use-swift/src/index.ts` | dispatcher 加 `case 'linux'` |

### Phase 4：验证

| 测试项 | macOS | Windows | Linux |
|--------|-------|---------|-------|
| build 成功 | ✅ | 验证 | 验证 |
| MCP 工具列表非空 | 验证 | 验证 | 验证 |
| 鼠标移动 | 验证 | ✅ 已通过 | 验证 |
| 截图 | 验证 | ✅ 已通过 | 验证 |
| 键盘输入 | 验证 | 验证 | 验证 |
| 前台窗口 | 验证 | ✅ 已通过 | 验证 |
| 剪贴板 | 验证 | 验证 | 验证 |

## 5. 文件改动总览

### 不动的文件（14 个）

`cleanup.ts`、`computerUseLock.ts`、`wrapper.tsx`、`toolRendering.tsx`、`mcpServer.ts`、`setup.ts`、`appNames.ts`、`inputLoader.ts`、`src/services/mcp/client.ts`、`@ant/computer-use-mcp/src/*`（Phase 1 已完成）、`backends/darwin.ts`（两个包都不动）

### 改 src/ 的文件（8 个）

| 文件 | 改动量 | 风险 |
|------|--------|------|
| `main.tsx` | 1 行 | 低 |
| `swiftLoader.ts` | 2 行 | 低 |
| `executor.ts` | ~40 行（剪贴板分发 + 平台守卫 + paste 快捷键） | **中** |
| `drainRunLoop.ts` | 1 行 | 低 |
| `escHotkey.ts` | 3 行 | 低 |
| `hostAdapter.ts` | 5 行 | 低 |
| `common.ts` | 3 行 | 低 |
| `gates.ts` | 3 行 | 低 |

### 新增文件（2 个）

| 文件 | 行数估算 |
|------|---------|
| `packages/@ant/computer-use-input/src/backends/linux.ts` | ~150 行 |
| `packages/@ant/computer-use-swift/src/backends/linux.ts` | ~200 行 |

## 6. Linux 依赖工具

| 工具 | 用途 | 安装命令（Ubuntu） |
|------|------|-------------------|
| `xdotool` | 键鼠模拟 + 窗口管理 | `sudo apt install xdotool` |
| `scrot` 或 `gnome-screenshot` | 截图 | `sudo apt install scrot` |
| `xrandr` | 显示器信息 | 通常已预装 |
| `xclip` | 剪贴板 | `sudo apt install xclip` |
| `wmctrl` | 窗口列表/切换 | `sudo apt install wmctrl` |

Wayland 环境需要替代工具：`ydotool`（替代 xdotool）、`grim`（替代 scrot）、`wl-clipboard`（替代 xclip）。初期可先只支持 X11，Wayland 标记为 todo。

## 7. 执行顺序建议

```
Phase 2（解锁 macOS + Windows）
  ├── 2.1-2.3  移除 3 处硬编码 throw/skip
  ├── 2.4-2.5  剪贴板 + 粘贴快捷键平台分发
  ├── 2.6      swiftLoader → 直接实例化
  ├── 2.7-2.9  drainRunLoop / escHotkey / permissions 平台分支
  ├── 2.10-2.11 common.ts 平台标识动态化
  ├── 2.12-2.13 gates.ts 默认值
  └── 验证 Windows

Phase 3（Linux 后端）
  ├── 3.1  input/backends/linux.ts
  ├── 3.2  swift/backends/linux.ts
  ├── 3.3-3.4  dispatcher 加 linux case
  └── 验证 Linux

Phase 4（集成验证 + PR）
```

每个 Phase 可独立验证、独立提交。Phase 2 完成后 macOS + Windows 可用，Phase 3 完成后三平台全部可用。
