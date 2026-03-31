# Claude Code 项目运行记录

> 项目: `/Users/konghayao/code/ai/claude-code`
> 日期: 2026-03-31
> 包管理器: bun

---

## 一、项目目标

**将 claude-code 项目运行起来，必要时可以删减次级能力。**

这是 Anthropic 官方 Claude Code CLI 工具的源码反编译/逆向还原项目。

### 核心保留能力

- API 通信（Anthropic SDK / Bedrock / Vertex）
- Bash/FileRead/FileWrite/FileEdit 等核心工具
- REPL 交互界面（ink 终端渲染）
- 对话历史与会话管理
- 权限系统（基础）
- Agent/子代理系统

### 已删减的次级能力

| 模块 | 处理方式 |
|------|----------|
| Computer Use (`@ant/computer-use-*`) | stub |
| Claude for Chrome (`@ant/claude-for-chrome-mcp`) | stub |
| Magic Docs / Voice Mode / LSP Server | 移除 |
| Analytics / GrowthBook / Sentry | 空实现 |
| Plugins/Marketplace / Desktop Upsell | 移除 |
| Ultraplan / Tungsten / Auto Dream | 移除 |
| MCP OAuth/IDP | 简化 |
| DAEMON / BRIDGE / BG_SESSIONS / TEMPLATES 等 | feature flag 关闭 |

---

## 二、当前状态：Dev 模式已可运行

```bash
# dev 运行
bun run dev
# 直接运行
bun run src/entrypoints/cli.tsx
# 测试 -p 模式
echo "say hello" | bun run src/entrypoints/cli.tsx -p
# 构建
bun run build
```

| 测试 | 结果 |
|------|------|
| `--version` | `2.1.87 (Claude Code)` |
| `--help` | 完整帮助信息输出 |
| `-p` 模式 | 成功调用 API 返回响应 |

### TS 类型错误说明

仍有 ~1341 个 tsc 错误，绝大多数是反编译产生的源码级类型问题（unknown/never/{}），**不影响 Bun 运行时**。不再逐个修复。

---

## 三、关键修复记录

### 3.1 自动化 stub 生成

通过 3 个脚本自动处理了缺失模块问题：
- `scripts/create-type-stubs.mjs` — 生成 1206 个 stub 文件
- `scripts/fix-default-stubs.mjs` — 修复 120 个默认导出 stub
- `scripts/fix-missing-exports.mjs` — 补全 81 个模块的 161 个缺失导出

### 3.2 手动类型修复

- `src/types/global.d.ts` — MACRO 宏、内部函数声明
- `src/types/internal-modules.d.ts` — `@ant/*` 等私有包类型声明
- `src/entrypoints/sdk/` — 6 个 SDK 子模块 stub
- 泛型类型修复（DeepImmutable、AttachmentMessage 等）
- 4 个 `export const default` 非法语法修复

### 3.3 运行时修复

**Commander 非法短标志**：`-d2e, --debug-to-stderr` → `--debug-to-stderr`（反编译错误）

**`bun:bundle` 运行时 Polyfill**（`src/entrypoints/cli.tsx` 顶部）：
```typescript
const feature = (_name: string) => false;  // 所有 feature flag 分支被跳过
(globalThis as any).MACRO = { VERSION: "2.1.87", ... };  // 绕过版本检查
```

---

## 四、关键文件清单

| 文件 | 用途 |
|------|------|
| `src/entrypoints/cli.tsx` | 入口文件（含 MACRO/feature polyfill） |
| `src/main.tsx` | 主 CLI 逻辑（Commander 定义） |
| `src/types/global.d.ts` | 全局变量/宏声明 |
| `src/types/internal-modules.d.ts` | 内部 npm 包类型声明 |
| `src/entrypoints/sdk/*.ts` | SDK 类型 stub |
| `src/types/message.ts` | Message 系列类型 stub |
| `scripts/create-type-stubs.mjs` | 自动 stub 生成脚本 |
| `scripts/fix-default-stubs.mjs` | 修复默认导出 stub |
| `scripts/fix-missing-exports.mjs` | 补全缺失导出 |

---

## 五、Monorepo 改造（2026-03-31）

### 5.1 背景

`color-diff-napi` 原先是手工放在 `node_modules/` 下的 stub 文件，导出的是普通对象而非 class，导致 `new ColorDiff(...)` 报错：
```
ERROR Object is not a constructor (evaluating 'new ColorDiff(patch, firstLine, filePath, fileContent)')
```
同时 `@ant/*`、其他 `*-napi` 包也只有 `declare module` 类型声明，无运行时实现。

### 5.2 方案

将项目改造为 **Bun workspaces monorepo**，所有内部包统一放在 `packages/` 下，通过 `workspace:*` 依赖解析。

### 5.3 创建的 workspace 包

| 包名 | 路径 | 类型 |
|------|------|------|
| `color-diff-napi` | `packages/color-diff-napi/` | 完整实现（~1000行 TS，从 `src/native-ts/color-diff/` 移入） |
| `modifiers-napi` | `packages/modifiers-napi/` | stub（macOS 修饰键检测） |
| `audio-capture-napi` | `packages/audio-capture-napi/` | stub |
| `image-processor-napi` | `packages/image-processor-napi/` | stub |
| `url-handler-napi` | `packages/url-handler-napi/` | stub |
| `@ant/claude-for-chrome-mcp` | `packages/@ant/claude-for-chrome-mcp/` | stub |
| `@ant/computer-use-mcp` | `packages/@ant/computer-use-mcp/` | stub（含 subpath exports: sentinelApps, types） |
| `@ant/computer-use-input` | `packages/@ant/computer-use-input/` | stub |
| `@ant/computer-use-swift` | `packages/@ant/computer-use-swift/` | stub |

### 5.4 新增的 npm 依赖

| 包名 | 原因 |
|------|------|
| `@opentelemetry/semantic-conventions` | 构建报错缺失 |
| `fflate` | `src/utils/dxt/zip.ts` 动态 import |
| `vscode-jsonrpc` | `src/services/lsp/LSPClient.ts` import |
| `@aws-sdk/credential-provider-node` | `src/utils/proxy.ts` 动态 import |

### 5.5 关键变更

- `package.json`：添加 `workspaces`，添加所有 workspace 包和缺失 npm 依赖
- `src/types/internal-modules.d.ts`：删除已移入 monorepo 的 `declare module` 块，仅保留 `bun:bundle`、`bun:ffi`、`@anthropic-ai/mcpb`
- `src/native-ts/color-diff/` → `packages/color-diff-napi/src/`：移动并内联了对 `stringWidth` 和 `logError` 的依赖
- 删除 `node_modules/color-diff-napi/` 手工 stub

### 5.6 构建验证

```
$ bun run build
Bundled 5326 modules in 491ms
  cli.js  25.74 MB  (entry point)
```
