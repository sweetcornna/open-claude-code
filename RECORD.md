# Claude Code 项目运行记录

> 项目: `/Users/konghayao/code/ai/claude-code`
> 日期: 2026-03-31
> 包管理器: bun

---

## 零、项目目标

**将 claude-code 项目运行起来，必要时可以删减次级能力。**

这是一个 Anthropic 官方的 Claude Code CLI 工具的源码反编译/逆向还原项目。项目的核心目标是：

1. **使项目能够成功构建和运行** — 优先解决 `bun run build` 和 `bun run dev` 的阻塞问题
2. **删减次级能力以降低复杂度** — 对于依赖私有 npm 包（如 `@ant/*`）的功能，可以用 stub 替代或直接移除
3. **保留核心 CLI 交互能力** — 保留与 Anthropic API 通信、工具调用、REPL 交互等核心功能

### 可删减的次级能力

| 模块 | 说明 | 处理方式 |
|------|------|----------|
| Computer Use | `@ant/computer-use-*` 私有包 | stub 或移除 |
| Claude for Chrome | `@ant/claude-for-chrome-mcp` | stub 或移除 |
| Magic Docs | 私有文档处理 | 移除 |
| Voice Mode | 语音模式 | 移除 |
| LSP Server | `vscode-languageserver-*` | 移除 |
| Analytics/Telemetry | 数据上报 | 空实现 |
| GrowthBook | A/B 实验 | 空实现 |
| Plugins/Marketplace | 插件市场 | 移除 |
| Desktop Upsell | 桌面端推销 | 移除 |
| Ultraplan | 私有功能 | 移除 |
| Tungsten | 私有功能 | 移除 |
| Sentry | 错误上报 | 移除 |
| Auto Dream | 自动后台任务 | 移除 |
| MCP OAuth/IDP | 企业级认证 | 简化 |

### 核心保留能力

- API 通信（Anthropic SDK / Bedrock / Vertex）
- Bash/FileRead/FileWrite/FileEdit 等核心工具
- REPL 交互界面（ink 终端渲染）
- 对话历史与会话管理
- 权限系统（基础）
- Agent/子代理系统

---

## 一、整体进度

| 阶段 | 错误数 | 说明 |
|------|--------|------|
| 初始状态 | ~1800 | 仅缺少 npm 依赖的 TS2307 错误 |
| 补全依赖后 | ~1800 | npm 包已安装，开始处理类型 |
| 当前状态 | **2123** | 类型 stub 已创建，但存在质量待修问题 |

### 当前错误分布

| 错误码 | 数量 | 含义 |
|--------|------|------|
| TS2693 | 727 | `export type X` 被当作值使用（应为 `export const/function`） |
| TS2339 | 537 | 属性不存在（类型收窄、unknown 类型） |
| TS2614 | 468 | 模块只有默认导出，但代码用命名导入 |
| TS2322 | 128 | 类型不匹配 |
| TS2345 | 57 | 参数类型不匹配 |
| TS2300 | 34 | 重复标识符（stub 文件中 export 重复） |
| TS2307 | 29 | 仍有缺失模块 |
| TS2305 | 28 | 缺失导出成员 |
| TS2724 | 21 | 导出名称不匹配（如 HookEvent vs HOOK_EVENTS） |
| TS2367 | 17 | 比较类型无交集（`"external" === "ant"` 等） |
| 其他 | ~100 | TS2578/TS2315/TS2365/TS2741 等 |

---

## 二、已完成的工作

### 2.1 全局变量声明 (`src/types/global.d.ts`)

声明了编译时宏和内部标识符：

- **MACRO / MACRO.VERSION** — Bun 编译时宏，通过 `bun:bundle` 提供
- **MACRO.BUILD_TIME / FEEDBACK_CHANNEL / ISSUES_EXPLAINER** 等编译时常量
- **resolveAntModel / getAntModels / getAntModelOverrideConfig** — 内部模型解析
- **fireCompanionObserver** — Companion 观察器
- **apiMetricsRef / computeTtftText** — 指标计算
- **Gates / GateOverridesWarning / ExperimentEnrollmentNotice** — 功能门控
- **HOOK_TIMING_DISPLAY_THRESHOLD_MS** — Hook 时间阈值
- **UltraplanChoiceDialog / UltraplanLaunchDialog / launchUltraplan** — Ultraplan 功能
- **TungstenPill** — Tungsten 功能
- **T** — React compiler 输出泄露的泛型参数

### 2.2 内部包声明 (`src/types/internal-modules.d.ts`)

为 Anthropic 私有包提供了详细的类型导出：

- `@ant/claude-for-chrome-mcp` — BROWSER_TOOLS, ClaudeForChromeContext, Logger 等
- `@ant/computer-use-mcp` — ComputerExecutor, ScreenshotResult, buildComputerUseTools 等
- `@ant/computer-use-mcp/types` — ComputerUseHostAdapter, CoordinateMode 等
- `@ant/computer-use-mcp/sentinelApps` — getSentinelCategory
- `@ant/computer-use-input` — ComputerUseInput, ComputerUseInputAPI
- `@ant/computer-use-swift` — ComputerUseAPI
- `@anthropic-ai/mcpb` — McpbManifest, McpbUserConfigurationOption
- `color-diff-napi` — ColorDiff, SyntaxTheme, getSyntaxTheme
- `audio-capture-napi / image-processor-napi / url-handler-napi`
- `bun:bundle / bun:ffi`

### 2.3 SDK 模块补全 (`src/entrypoints/sdk/`)

为缺失的 SDK 子模块创建了 stub 文件：

| 文件 | 说明 |
|------|------|
| `controlTypes.ts` | 控制协议类型（SDKControlRequest/Response） |
| `runtimeTypes.ts` | 运行时类型（SDKSession, Query, Options, SdkMcpToolDefinition 等） |
| `coreTypes.generated.ts` | 从 Zod schema 生成的类型（ModelUsage, HookInput 系列, SDK 消息类型等） |
| `settingsTypes.generated.ts` | Settings 类型 |
| `toolTypes.ts` | 工具类型 |
| `sdkUtilityTypes.ts` | NonNullableUsage 等工具类型 |

### 2.4 自动化 stub 生成 (`scripts/create-type-stubs.mjs`)

编写了自动分析脚本，通过解析 `tsc` 错误和源码 `import` 语句，自动创建缺失模块的 stub 文件：

- 扫描 TS2305/TS2614/TS2724 获取缺失导出
- 扫描源码 import 语句获取命名导入
- 自动创建 `export type X = any` stub
- 已生成 **1206 个 stub 文件，覆盖 2067 个命名导出**

---

## 三、当前问题分析

### 3.1 TS2693 (727 个) — `export type` 被当作值使用 ⚠️ 关键

**原因**: `scripts/create-type-stubs.mjs` 统一使用 `export type X = any` 生成 stub，但代码中很多地方将导入的名称作为**值**使用（如调用函数、渲染 JSX 组件等）。

**示例**:

```typescript
// stub 中: export type performLogout = any
// 实际使用: performLogout()  // TS2693: only refers to a type, but is being used as a value
```

**修复方案**: 将 `export type X = any` 改为 `declare const X: any` 或 `export const X: any`。需要区分哪些是纯类型、哪些是值/函数/组件。

### 3.2 TS2614 (468 个) — 模块只有默认导出

**原因**: 部分 stub 文件使用 `export default {} as any`（早期手动创建），但代码用命名导入 `import { Message } from ...`。

**示例**: `src/types/message.ts` 当前内容为 `export default {} as any`，但代码 `import type { Message } from '../types/message.js'`

**修复方案**: 将默认导出改为命名导出。

### 3.3 TS2300 (34 个) — 重复标识符

**原因**: stub 文件中有 `export type X = any` 行，同时源文件中也存在同名定义，造成冲突。部分 stub 文件路径不正确（如 `src/components/CustomSelect/select.ts` 既有真实代码又有 stub 导出）。

**修复方案**: 检查这些文件，如果真实文件存在则删除 stub 中的重复导出。

### 3.4 TS2339 (537 个) — 属性不存在

**原因**: `any` 类型的 stub 过于宽松时可以正常工作，但部分地方类型收窄后（如联合类型判别、`unknown` 类型）无法访问属性。

**分类**:

- 内部代码中 `unknown` 类型需要类型断言（源码问题）
- `McpServerConfigForProcessTransport` 等类型定义过窄（stub 精度问题）
- `{ ok: true } | { ok: false; error: string }` 联合类型访问 `.error`（源码惯用模式）

**修复方案**: 调整相关 stub 类型定义使其更精确。

### 3.5 TS2307 (29 个) — 仍有缺失模块

主要是路径解析问题产生的重复 stub（如 `src/cli/src/` 下的文件已被删除）以及一些深度嵌套的相对路径。

### 3.6 路径问题

部分 stub 文件被错误创建在 `src/cli/src/` 等嵌套路径下（因为 `import { X } from 'src/something'` 从 `src/cli/handlers/auth.ts` 解析时路径计算错误）。已手动删除部分重复文件，但可能仍有残留。

---

## 四、后续处理方案

### Phase 1: 修复脚本 — 区分类型导出 vs 值导出 (预计解决 ~1200 个错误)

改进 `scripts/create-type-stubs.mjs`：

1. **分析 import 语句上下文**：
   - `import type { X }` → 纯类型，用 `export type X = any`
   - `import { X }` (无 type) → 可能是值，用 `export const X: any = (() => {}) as any`
   - JSX 组件（大写开头 + 在 JSX 中使用）→ `export const X: React.FC<any> = () => null`

2. **分析使用上下文**：
   - `X()` 调用 → 函数/值导出
   - `<X />` → React 组件
   - `X.property` → 对象/命名空间

### Phase 2: 修复默认导出问题 (预计解决 ~468 个 TS2614)

将所有 `export default {} as any` 的 stub 文件替换为带命名导出的版本：

```typescript
// 之前
export default {} as any

// 之后 — 根据导入需求
export type Message = any
export type NormalizedUserMessage = any
// ... 等
```

### Phase 3: 清理冲突和路径问题 (预计解决 ~34 个 TS2300 + 29 个 TS2307)

1. 检查所有带 `TS2300` 错误的文件，删除与真实代码冲突的 stub
2. 清理 `src/cli/src/`、`src/components/*/src/` 等错误路径下的 stub 残留
3. 修复 `tsconfig.json` 的 `paths` 配置，确保 `src/*` 映射正确

### Phase 4: 精化关键类型定义 (预计解决 ~100+ 个 TS2322/TS2345)

对高频使用的类型提供更精确的定义：

1. **SDK 消息类型** — 使 `type` 字段为字面量联合类型，而非 `string`
2. **McpServerConfig** — 改为联合类型（stdio | sse | http | sse-ide）
3. **HookInput** 系列 — 添加 `hook_event_name` 字面量类型
4. **PermissionResult** — 改为判别联合 `allow | deny`

### Phase 5: 处理源码级别的类型问题 (需评估)

这些是源码本身的问题，不属于 stub 范畴：

- `TS2367`: `"external" === "ant"` — 构建时消除的死代码
- `TS2339`: 联合类型属性访问 — 需要类型收窄或断言
- `TS2322`: 类型字面量不匹配（如 `"result"` vs `"result_success"`）

---

## 五、关键文件清单

| 文件 | 用途 |
|------|------|
| `src/types/global.d.ts` | 全局变量/宏声明 |
| `src/types/internal-modules.d.ts` | 内部 npm 包类型声明 |
| `src/types/react-compiler-runtime.d.ts` | React compiler runtime |
| `src/types/sdk-stubs.d.ts` | SDK 通配符类型（备用） |
| `src/entrypoints/sdk/controlTypes.ts` | SDK 控制类型 stub |
| `src/entrypoints/sdk/runtimeTypes.ts` | SDK 运行时类型 stub |
| `src/entrypoints/sdk/coreTypes.generated.ts` | SDK 核心类型 stub |
| `src/entrypoints/sdk/settingsTypes.generated.ts` | SDK 设置类型 stub |
| `src/entrypoints/sdk/toolTypes.ts` | SDK 工具类型 stub |
| `src/entrypoints/sdk/sdkUtilityTypes.ts` | SDK 工具类型 |
| `scripts/create-type-stubs.mjs` | 自动 stub 生成脚本 |
| `tsconfig.json` | TypeScript 配置 |
| `package.json` | 依赖配置 |

---

## 六、运行命令

```bash
# 检查当前错误数
cd /Users/konghayao/code/ai/claude-code && npx tsc --noEmit 2>&1 | grep "error TS" | wc -l

# 错误分类统计
npx tsc --noEmit 2>&1 | grep "error TS" | sed 's/.*error //' | sed 's/:.*//' | sort | uniq -c | sort -rn

# 重新生成 stub（修复脚本后）
node scripts/create-type-stubs.mjs
```
