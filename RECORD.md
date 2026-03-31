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
| 第一轮 stub 生成 | ~2163 | 自动 stub 生成但质量问题多（全用 `export type`） |
| **第二轮修复后** | **~1341** | 修复了默认导出、补充命名导出、泛型类型 |

### 当前错误分布（第二轮修复后）

| 错误码 | 数量 | 含义 | 性质 |
|--------|------|------|------|
| TS2339 | 701 | 属性不存在 | **主要是源码级问题**（unknown 344, never 121, {} 52） |
| TS2322 | 210 | 类型不匹配 | 源码级 |
| TS2345 | 134 | 参数类型不匹配 | 源码级 |
| TS2367 | 106 | 比较类型无交集 | 源码级（编译时死代码） |
| TS2307 | 29 | 缺失模块 | 可修但收益小 |
| TS2693 | 13 | type 当值用 | 少量残留 |
| TS2300 | 10 | 重复标识符 | 小问题 |
| 其他 | ~138 | TS2365/TS2554/TS2578/TS2538/TS2698 等 | 混合 |

### 关键发现

剩余 1341 个错误中，**绝大多数（~1200+）是源码级别的类型问题**，不是 stub 缺失导致的：

- `unknown` 类型访问属性 (344) — 反编译产生的 `unknown` 需要断言
- `never` 类型 (121) — 联合类型穷尽后的死路径
- `{}` 空对象 (52) — 空 stub 模块的残留影响
- ComputerUseAPI/ComputerUseInputAPI (42) — 私有包声明不够详细

**继续逐个修复类型错误的投入产出比很低。应该改变方向，尝试直接构建运行。**

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

### 2.5 第二轮修复 — 默认导出 & 缺失导出 (本次会话)

#### `scripts/fix-default-stubs.mjs` — 修复 120 个 `export default {} as any` 的 stub 文件

- 扫描源码中所有 import 语句，区分 `import type {}` vs `import {}`
- 将纯类型导出为 `export type X = any`，值导出为 `export const X: any = (() => {}) as any`
- **效果**: TS2614 从 632 → 0 (完全消除)

#### `scripts/fix-missing-exports.mjs` — 补全空模块的导出成员

- 解析 TS2339 中 `typeof import("...")` 的错误，给 81 个模块添加了 147 个缺失导出
- 解析 TS2305 添加了 10 个缺失导出
- 解析 TS2724 添加了 4 个命名不匹配的导出
- 创建了 2 个新 stub 文件修复 TS2307

#### 泛型类型修复

将以下类型从非泛型改为泛型（修复 86 个 TS2315）：

- `DeepImmutable<T>`, `Permutations<T>` (`src/types/utils.ts`)
- `AttachmentMessage<T>`, `ProgressMessage<T>`, `NormalizedAssistantMessage<T>` (`src/types/message.ts` 及其多个副本)
- `WizardContextValue<T>` (`src/components/wizard/types.ts`)

#### 语法修复

修复 4 个 `export const default` 非法语法（buddy/fork/peers/workflows 的 index.ts）

---

## 三、当前问题分析

### 3.1 剩余错误已触达 "源码级" 地板

剩余 ~1341 个错误绝大多数不是 stub 缺失问题，而是源码本身的类型问题：

- **unknown (344)**: 反编译代码中大量 `unknown` 类型变量直接访问属性
- **never (121)**: 联合类型穷尽后的 never 路径（通常是 switch/if-else 的 exhaustive check）
- **{} (52)**: 空对象类型
- **类型比较 (106 TS2367)**: 编译时死代码如 `"external" === "ant"`
- **类型不匹配 (210 TS2322 + 134 TS2345)**: stub 类型不够精确

### 3.2 继续修类型错误的问题

1. **投入产出比极低** — 每个 TS2339/TS2322 都需要理解具体上下文
2. **Bun bundler 不强制要求零 TS 错误** — Bun 可以在有类型错误的情况下成功构建
3. **大部分是运行时无影响的类型问题** — `unknown as any` 等模式不影响实际执行

---

## 四、后续方向建议

### 方向 A: 直接尝试 `bun build` 构建 ⭐ 推荐

Bun bundler 对类型错误比 tsc 宽容得多。应该直接尝试构建：

```bash
bun build src/entrypoints/cli.tsx --target=node --outdir=dist
```

遇到的构建错误才是真正需要修的问题（缺失模块、语法错误等），而非类型错误。

### 方向 B: 在 tsconfig 中进一步放宽

```json
{
  "compilerOptions": {
    "strict": false,
    "noImplicitAny": false,
    "strictNullChecks": false
  }
}
```

已经是 `strict: false`，但可以进一步添加 `"skipLibCheck": true`（已有）。

### 方向 C: 批量 `// @ts-nocheck`

对有大量源码级类型错误的文件加 `// @ts-nocheck`，快速消除错误。

---

## 五、关键文件清单

| 文件 | 用途 |
|------|------|
| `src/types/global.d.ts` | 全局变量/宏声明 |
| `src/types/internal-modules.d.ts` | 内部 npm 包类型声明 |
| `src/types/react-compiler-runtime.d.ts` | React compiler runtime |
| `src/types/sdk-stubs.d.ts` | SDK 通配符类型（备用） |
| `src/types/message.ts` | Message 系列类型 stub (39 types) |
| `src/types/tools.ts` | 工具进度类型 stub |
| `src/types/utils.ts` | DeepImmutable / Permutations 泛型 |
| `src/entrypoints/sdk/controlTypes.ts` | SDK 控制类型 stub |
| `src/entrypoints/sdk/runtimeTypes.ts` | SDK 运行时类型 stub |
| `src/entrypoints/sdk/coreTypes.generated.ts` | SDK 核心类型 stub |
| `src/entrypoints/sdk/settingsTypes.generated.ts` | SDK 设置类型 stub |
| `src/entrypoints/sdk/toolTypes.ts` | SDK 工具类型 stub |
| `src/entrypoints/sdk/sdkUtilityTypes.ts` | SDK 工具类型 |
| `scripts/create-type-stubs.mjs` | 自动 stub 生成脚本 |
| `scripts/fix-default-stubs.mjs` | 修复 `export default` stub 为命名导出 |
| `scripts/fix-missing-exports.mjs` | 补全空模块缺失的导出成员 |
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

# 修复默认导出 stub
node scripts/fix-default-stubs.mjs

# 补全缺失导出
node scripts/fix-missing-exports.mjs

# 尝试构建（下一步）
bun build src/entrypoints/cli.tsx --target=node --outdir=dist
```
