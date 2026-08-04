<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/computer-use) · [日本語](/docs/ja/features/computer-use)

# Computer Use

Last updated: 2026-07-31
Reference project: `E:\源码\claude-code-source-main\claude-code-source-main`

## Backend selection

`computerUse.backend` controls how occ provides Computer Use tools:

| Value | Behavior |
|---|---|
| `"builtin"` | Default. Registers the in-process `@ant/computer-use-mcp` and uses this project's approval UI and security layer. |
| `"external"` | Does not register or connect the in-process server. A server named `computer-use` is no longer treated as a reserved built-in name and must be added explicitly through ordinary MCP configuration. |

Example user setting:

```json
{
  "computerUse": {
    "backend": "external"
  }
}
```

After selecting the external backend, restart the running occ session, then add the external server's stdio command according to that server's installation instructions:

```bash
occ mcp add computer-use -s user -- <server-command> <server-args...>
occ mcp list
```

Use `computer-use` as the server name to obtain the stable
`mcp__computer-use__*` tool prefix. In `external` mode, this name starts through the ordinary
stdio MCP client and is not replaced by the in-process server. Remove an external configuration with the same name before switching back to `builtin`:

```bash
occ mcp remove computer-use -s user
```

> **Security warning: an external backend bypasses this project's Computer Use security layer.** Calls to an external server's tools do not pass through
> `ComputerUseHostAdapter`, the `toolCalls` dispatcher, or the Computer Use approval UI. They therefore receive no
> `deniedApps` / `sentinelApps` policy, per-application `read` / `click` / `full` authorization tiers,
> `keyBlocklist`, clipboard protection, `pixelCompare` click validation, cross-session lock, or ESC abort.
> They receive only the ordinary, coarser MCP tool-permission prompt. Before enabling an external backend, review the server and its operating-system permissions independently.

Community projects worth investigating include:

- [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP): targets Windows.
- [QwenLM/open-computer-use](https://github.com/QwenLM/open-computer-use): targets cross-platform support.

These links are community options, not endorsements, security audits, or compatibility commitments by this project. Refer to each project's documentation for its exact startup commands, tool names, and dependencies.

## Host Adapter contract

The `ComputerUseHostAdapter` / `ComputerExecutor` exports from
`packages/@ant/computer-use-mcp/src/index.ts` are the supported extension point when retaining the built-in security layer.
Use them to integrate a new desktop host or native automation implementation. This is not the same extension model as the `external` backend:
an adapter integration still passes through this project's authorization and security dispatch, while an external MCP replaces the entire implementation.

Relevant public interfaces include:

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

The host should construct one `ComputerUseHostAdapter` reused for the lifetime of the process and construct a
`ComputerUseSessionContext` for each session. The most direct integration passes both to
`createComputerUseMcpServer(adapter, coordinateMode, sessionContext)`. If the host already has an MCP
management layer, call `bindSessionContext()` to obtain a session-bound tool dispatch function. Calling
`createComputerUseMcpServer()` without `sessionContext` is suitable only for listing tools; its tool-call handlers do not receive real session state.

### `ComputerUseHostAdapter`

| Member | Host responsibility | Security touchpoint |
|---|---|---|
| `serverName`, `logger` | Provide a stable MCP identity and a five-level logging implementation. Logs must not turn screenshots, clipboard contents, or application contents into telemetry fields. | Dispatch exceptions are logged and converted into tool errors. |
| `executor` | Implement the operating-system capabilities below. Every asynchronous operation must resolve only after completion and reject on failure. | Input should be invoked only by the protected dispatcher. |
| `ensureOsPermissions()` | Perform a pure check: do not display prompts or restart. macOS must report Accessibility and Screen Recording status accurately. | Global gate after the kill switch and before every executor call. |
| `isDisabled()` | Read the host's global Computer Use switch in real time. | First gate for every tool call. |
| `getAutoUnhideEnabled()` | Return the host preference for whether hidden applications are restored at the end of a turn. | Used for the hidden-app preview in the authorization UI; the host performs the actual cleanup. |
| `getSubGates()` | Return the current `CuSubGates` on every call; do not freeze dynamic configuration inside the adapter. | Controls subgates for screenshot click validation, clipboard protection, hiding, display selection, and other behavior. |
| `cropRawPatch()` | Decode a base64 image, crop a rectangle, and return stable raw pixel bytes; return `null` on failure. | `pixelCompare` uses it to validate the click region. `null` means skip validation; do not fabricate pixels. |

### `ComputerExecutor`

Required methods are grouped by responsibility below. The exported interface in `src/executor.ts` defines the complete signatures.

| Group | Methods | Contract requirements |
|---|---|---|
| Capabilities | `capabilities` | `hostBundleId` must identify the host UI; `screenshotFiltering` must state truthfully whether filtering by application is supported; the public `platform` type is currently `darwin \| win32`. |
| Displays and screenshots | `getDisplaySize`, `listDisplays`, `findWindowDisplays`, `resolvePrepareCapture`, `screenshot`, `zoom` | Coordinates use global logical points and include display origins. The image dimensions, display dimensions at capture time, origin, and `displayId` in `ScreenshotResult` must belong to the same capture. `resolvePrepareCapture` should make display selection, application hiding, and screenshot capture one consistent operation. |
| Hide preprocessing | `previewHideSet`, `prepareForAction` | `previewHideSet` must not change the desktop. `prepareForAction` hides applications outside the allowlist, moves focus away from the host, and returns the application IDs it actually hid. Platform exceptions such as Finder/the desktop must remain consistent with host policy. |
| Application identity | `listInstalledApps`, `listRunningApps`, `getFrontmostApp`, `appUnderPoint`, `getAppIcon`, `openApp` | Every method must use the same stable application ID. IDs from foreground queries and hit testing must compare exactly with authorization grants, or per-application tiers fail. |
| Keyboard and mouse input | `key`, `holdKey`, `type`, `moveMouse`, `click`, `mouseDown`, `mouseUp`, `getCursorPosition`, `drag`, `scroll` | Accept already-scaled logical coordinates. Do not bypass the dispatcher by starting a second global input path. Reject if an operation fails after partial completion so the upper layer can fail closed. |
| Clipboard | `readClipboard`, `writeClipboard` | Read and write text exactly, preserving empty strings. Click-tier clipboard stashing, clearing, and restoration depend on these methods. |

Windows methods for window binding, UI Automation, virtual keyboard/mouse input, status indicators, and terminal startup are all optional in the interface.
Leave them `undefined` when unimplemented. Once implemented, use `false` / `null` for “currently unbound or not found” and reject
on execution failure. Do not return false success, or the model will continue operating against incorrect window state.

Platform constraints:

- `screenshotFiltering: "native"` means the screenshot implementation truly exposes only authorized applications and can provide meaningful foreground-application and coordinate hit testing.
- `screenshotFiltering: "none"` makes the approval UI tell the user that every application may be visible; on non-macOS systems, the global foreground gate is not treated as an isolation guarantee either.
- The public `ComputerExecutorCapabilities.platform` currently declares only `darwin | win32`. The repository's Linux CLI is routed through a compatibility layer and is not yet a first-class platform literal in the adapter contract.
- `CoordinateMode` must remain fixed after the tool schema is constructed. Screenshots and clicks cannot switch from `pixels` to `normalized_0_100` during a session.

### Session state and the security layer

`ComputerUseSessionContext` is not an optional convenience wrapper; it is the host boundary for most security state:

- `onPermissionRequest` / `onTeachPermissionRequest` must present a user-visible, blocking approval and honor the supplied `AbortSignal`; `onAllowedAppsChanged` persists per-session grants and grant flags.
- `getAllowedApps`, `getGrantFlags`, and `getUserDeniedBundleIds` must read the latest state. The built-in dispatcher uses them to enforce `deniedApps`, `sentinelApps`, and per-application authorization tiers.
- `checkCuLock` / `acquireCuLock` must atomically ensure that only one session controls the desktop at a time. The host's idle, stop, and archive lifecycles are responsible for releasing the lock.
- `isAborted` must connect to the host's stop operation. The host should also update the same abort state when it captures the ESC hotkey so batch processing and long text input can stop inside their loops.
- `getClipboardStash` / `onClipboardStashChanged` persist click-tier clipboard-protection state. At the end of a turn, the host must restore and clear any remaining stash.
- `onAppsHidden` records applications hidden during the current turn. At turn completion or abort, the host must restore them according to the preference.
- `onScreenshotCaptured` should persist dimension metadata without base64. `bindSessionContext` retains the current screenshot blob itself for coordinate scaling and click validation.

Security decisions should remain in the tool dispatcher in `@ant/computer-use-mcp`. The adapter/executor must report desktop state accurately and execute approved primitives, not duplicate or weaken policy. Exceptions thrown by the executor are converted into tool errors. The host should still make multistep primitives as idempotent as possible and release keys, mouse buttons, and temporary resources after partial failure.

---

## Cross-platform implementation notes

## 1. Current status

The reference project's Computer Use supports **macOS only**: every layer from the entry point to the implementation is hard-coded for darwin. In Phases 1–3, this project has completed:

- `@ant/computer-use-mcp` stub replaced with a complete implementation (12 files)
- `@ant/computer-use-input` split into dispatcher and backends (darwin + win32)
- `@ant/computer-use-swift` split into dispatcher and backends (darwin + win32)
- `CHICAGO_MCP` compile-time switch enabled
- macOS hard-coding removed from the `src/` layer (Phase 2 complete)

## 2. Complete view of blockers

### 2.1 Entry-point layer

| # | File:line | Blocking code | Impact |
|---|----------|---------|------|
| 1 | `src/main.tsx:2366` | Gated by `feature("CHICAGO_MCP")` | CU initialization entry point |

### 2.2 Loading layer

| # | File:line | Blocking code | Impact |
|---|----------|---------|------|
| 2 | `src/utils/computerUse/swiftLoader.ts` | macOS-only loader (changed to load only on darwin) | Non-darwin uses platforms/ instead |
| 3 | `src/utils/computerUse/executor.ts:302` | `process.platform !== 'darwin'` → cross-platform executor | Non-darwin uses the cross-platform path |

### 2.3 macOS-specific dependencies

| # | File:line | Dependency | macOS implementation | Required replacement |
|---|----------|------|-----------|------------|
| 4 | `executor.ts:72-96` | Clipboard | `pbcopy`/`pbpaste` / PowerShell / xclip | Windows: PowerShell `Get/Set-Clipboard`; Linux: `xclip`/`wl-copy` |
| 5 | `drainRunLoop.ts` | CFRunLoop pump | `cu._drainMainRunLoop()` | Non-darwin: execute fn() directly; no pump required |
| 6 | `escHotkey.ts` | ESC hotkey | CGEventTap | Non-darwin: return false (Ctrl+C fallback already exists) |
| 7 | `hostAdapter.ts` | System permissions | TCC accessibility + screenRecording | Windows: directly granted; Linux: check xdotool |
| 8 | `common.ts:55-58` | Platform identifier | Determined dynamically | Changed to dispatch on `process.platform` |
| 9 | `executor.ts:232` | Paste shortcut | Dispatches `command`/`ctrl` | Paste shortcut now dispatches by platform |

### 2.4 Missing Linux backends

| Package | macOS | Windows | Linux |
|---|-------|---------|-------|
| `computer-use-input/backends/` | darwin.ts complete | win32.ts complete | linux.ts must be added |
| `computer-use-swift/backends/` | darwin.ts complete | win32.ts complete | linux.ts must be added |

## 3. Capability dependencies by platform

### 3.1 computer-use-input (keyboard and mouse)

| Capability | macOS | Windows | Linux |
|------|-------|---------|-------|
| Mouse movement | CGEvent JXA | SetCursorPos P/Invoke | xdotool mousemove |
| Mouse click | CGEvent JXA | SendInput P/Invoke | xdotool click |
| Mouse wheel | CGEvent JXA | SendInput MOUSEEVENTF_WHEEL | xdotool scroll |
| Key press | System Events osascript | keybd_event P/Invoke | xdotool key |
| Key combination | System Events osascript | keybd_event combination | xdotool key combo |
| Text input | System Events keystroke | SendKeys.SendWait | xdotool type |
| Foreground application | System Events osascript | GetForegroundWindow P/Invoke | xdotool getactivewindow + /proc |
| Tool dependency | osascript (built in) | powershell (built in) | xdotool (installation required) |

### 3.2 computer-use-swift (screenshots and application management)

| Capability | macOS | Windows | Linux |
|------|-------|---------|-------|
| Full-screen screenshot | screencapture | CopyFromScreen | gnome-screenshot / scrot / grim |
| Region screenshot | screencapture -R | CopyFromScreen(rect) | gnome-screenshot -a / scrot -a / grim -g |
| Display list | CGGetActiveDisplayList JXA | Screen.AllScreens | xrandr --query |
| Running applications | System Events JXA | Get-Process | wmctrl -l / ps |
| Open application | osascript activate | Start-Process | xdg-open / gtk-launch |
| Hide/show | System Events visibility | ShowWindow/SetForegroundWindow | wmctrl -c / xdotool |
| Tool dependencies | screencapture + osascript | powershell | xdotool + scrot/grim + wmctrl |

### 3.3 Executor layer

| Capability | macOS | Windows | Linux |
|------|-------|---------|-------|
| drainRunLoop | CFRunLoop pump | Not required | Not required |
| ESC hotkey | CGEventTap | Skipped (Ctrl+C fallback) | Skipped (Ctrl+C fallback) |
| Clipboard read | pbpaste | `powershell Get-Clipboard` | xclip -o / wl-paste |
| Clipboard write | pbcopy | `powershell Set-Clipboard` | xclip / wl-copy |
| Paste shortcut | command+v | ctrl+v | ctrl+v |
| Terminal detection | __CFBundleIdentifier | WT_SESSION / TERM_PROGRAM | TERM_PROGRAM |
| System permissions | TCC check | Directly granted | Check xdotool installation |

## 4. Implementation steps

### Phase 1: complete

- [x] `@ant/computer-use-mcp` stub → complete implementation
- [x] `@ant/computer-use-input` dispatcher + darwin/win32 backends
- [x] `@ant/computer-use-swift` dispatcher + darwin/win32 backends
- [x] `CHICAGO_MCP` compile-time switch

### Phase 2: remove 6 macOS hard-coded paths (enable macOS + Windows)

**Change principle: preserve the macOS code path and add win32/linux branches only after each darwin guard.**

| Step | File | Change |
|------|------|------|
| 2.1 | `src/main.tsx:2366` | `feature("CHICAGO_MCP")` → now a cross-platform entry point |
| 2.2 | `src/utils/computerUse/swiftLoader.ts` | Changed to load only on darwin; non-darwin uses platforms/ |
| 2.3 | `src/utils/computerUse/executor.ts:302-309` | Changed to cross-platform dispatch (non-darwin → createCrossPlatformExecutor) |
| 2.4 | `src/utils/computerUse/executor.ts:72-96` | Clipboard now dispatches by platform: darwin→pbcopy/pbpaste, win32→PowerShell, linux→xclip |
| 2.5 | `src/utils/computerUse/executor.ts:232` | Paste shortcut now dispatches by platform: darwin→command, other→ctrl |
| 2.6 | `src/utils/computerUse/executor.ts:302-309` | Non-darwin changed to `createCrossPlatformExecutor()` |
| 2.7 | `src/utils/computerUse/drainRunLoop.ts` | Non-darwin requires no pump (execute fn directly) |
| 2.8 | `src/utils/computerUse/escHotkey.ts` | Non-darwin returns false (Ctrl+C fallback already exists) |
| 2.9 | `src/utils/computerUse/hostAdapter.ts` | Non-darwin permission-check logic implemented |
| 2.10 | `src/utils/computerUse/common.ts:58` | Changed to dynamic `process.platform` dispatch |
| 2.11 | `src/utils/computerUse/common.ts:55` | Changed to darwin→'native', other→'none' |
| 2.12 | `src/utils/computerUse/gates.ts:55` | Updated (the default value of enabled requires verification) |
| 2.13 | `src/utils/computerUse/gates.ts:39` | `hasRequiredSubscription()` updated |

### Phase 3: add Linux backends

| Step | File | Content |
|------|------|------|
| 3.1 | `packages/@ant/computer-use-input/src/backends/linux.ts` | xdotool keyboard/mouse (mousemove/click/key/type/getactivewindow) |
| 3.2 | `packages/@ant/computer-use-swift/src/backends/linux.ts` | scrot/grim screenshots + xrandr displays + wmctrl window management |
| 3.3 | `packages/@ant/computer-use-input/src/index.ts` | Add `case 'linux'` to the dispatcher |
| 3.4 | `packages/@ant/computer-use-swift/src/index.ts` | Add `case 'linux'` to the dispatcher |

### Phase 4: verification

| Test item | macOS | Windows | Linux |
|--------|-------|---------|-------|
| Build succeeds | Passed | Verify | Verify |
| MCP tool list is nonempty | Verify | Verify | Verify |
| Mouse movement | Verify | Passed | Verify |
| Screenshot | Verify | Passed | Verify |
| Keyboard input | Verify | Verify | Verify |
| Foreground window | Verify | Passed | Verify |
| Clipboard | Verify | Verify | Verify |

## 5. File-change overview

### Files that remain unchanged (14)

`cleanup.ts`, `computerUseLock.ts`, `wrapper.tsx`, `toolRendering.tsx`, `mcpServer.ts`, `setup.ts`, `appNames.ts`, `inputLoader.ts`, `src/services/mcp/client.ts`, `@ant/computer-use-mcp/src/*` (Phase 1 complete), `backends/darwin.ts` (unchanged in both packages)

### Files changed under src/ (8)

| File | Change size | Risk |
|------|--------|------|
| `main.tsx` | 1 line | Low |
| `swiftLoader.ts` | 2 lines | Low |
| `executor.ts` | ~40 lines (clipboard dispatch + platform guard + paste shortcut) | **Medium** |
| `drainRunLoop.ts` | 1 line | Low |
| `escHotkey.ts` | 3 lines | Low |
| `hostAdapter.ts` | 5 lines | Low |
| `common.ts` | 3 lines | Low |
| `gates.ts` | 3 lines | Low |

### New files (2)

| File | Estimated lines |
|------|---------|
| `packages/@ant/computer-use-input/src/backends/linux.ts` | ~150 lines |
| `packages/@ant/computer-use-swift/src/backends/linux.ts` | ~200 lines |

## 6. Linux tool dependencies

| Tool | Purpose | Installation command (Ubuntu) |
|------|------|-------------------|
| `xdotool` | Keyboard/mouse emulation and window management | `sudo apt install xdotool` |
| `scrot` or `gnome-screenshot` | Screenshots | `sudo apt install scrot` |
| `xrandr` | Display information | Usually preinstalled |
| `xclip` | Clipboard | `sudo apt install xclip` |
| `wmctrl` | Window listing/switching | `sudo apt install wmctrl` |

Wayland environments require alternative tools: `ydotool` instead of xdotool, `grim` instead of scrot, and `wl-clipboard` instead of xclip. The initial implementation can support X11 only and mark Wayland as todo.

## 7. Recommended implementation order

```
Phase 2 (enable macOS + Windows)
  ├── 2.1-2.3  Remove 3 hard-coded throw/skip paths
  ├── 2.4-2.5  Dispatch clipboard + paste shortcut by platform
  ├── 2.6      swiftLoader → instantiate directly
  ├── 2.7-2.9  Add platform branches for drainRunLoop / escHotkey / permissions
  ├── 2.10-2.11 Make common.ts platform identifiers dynamic
  ├── 2.12-2.13 gates.ts defaults
  └── Verify Windows

Phase 3 (Linux backends)
  ├── 3.1  input/backends/linux.ts
  ├── 3.2  swift/backends/linux.ts
  ├── 3.3-3.4  Add the linux case to dispatchers
  └── Verify Linux

Phase 4 (integration verification + PR)
```

Each Phase can be verified and committed independently. After Phase 2, macOS and Windows are available; after Phase 3, all three platforms are available.
