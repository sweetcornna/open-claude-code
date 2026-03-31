# Claude Code (Reverse-Engineered)

Anthropic 官方 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 工具的源码反编译/逆向还原项目。目标是将 Claude Code 核心功能跑通，必要时删减次级能力。

## 核心能力

- API 通信（Anthropic SDK / Bedrock / Vertex）
- Bash / FileRead / FileWrite / FileEdit 等核心工具
- REPL 交互界面（ink 终端渲染）
- 对话历史与会话管理
- 权限系统
- Agent / 子代理系统

## 已删减模块

| 模块 | 处理方式 |
|------|----------|
| Computer Use (`@ant/computer-use-*`) | stub |
| Claude for Chrome MCP | stub |
| Magic Docs / Voice Mode / LSP Server | 移除 |
| Analytics / GrowthBook / Sentry | 空实现 |
| Plugins / Marketplace / Desktop Upsell | 移除 |
| Ultraplan / Tungsten / Auto Dream | 移除 |
| MCP OAuth/IDP | 简化 |
| DAEMON / BRIDGE / BG_SESSIONS / TEMPLATES 等 | feature flag 关闭 |

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.0
- Node.js >= 18（部分依赖需要）
- 有效的 Anthropic API Key（或 Bedrock / Vertex 凭据）

### 安装

```bash
bun install
```

### 运行

```bash
# 开发模式（watch）
bun run dev

# 直接运行
bun run src/entrypoints/cli.tsx

# 管道模式（-p）
echo "say hello" | bun run src/entrypoints/cli.tsx -p

# 构建
bun run build
```

构建产物输出到 `dist/cli.js`（~25.75 MB，5326 模块）。

## 项目结构

```
claude-code/
├── src/
│   ├── entrypoints/
│   │   ├── cli.tsx          # 入口文件（含 MACRO/feature polyfill）
│   │   └── sdk/             # SDK 子模块 stub
│   ├── main.tsx             # 主 CLI 逻辑（Commander 定义）
│   └── types/
│       ├── global.d.ts      # 全局变量/宏声明
│       └── internal-modules.d.ts  # 内部 npm 包类型声明
├── packages/                # Monorepo workspace 包
│   ├── color-diff-napi/     # 完整实现（终端 color diff）
│   ├── modifiers-napi/      # stub（macOS 修饰键检测）
│   ├── audio-capture-napi/  # stub
│   ├── image-processor-napi/# stub
│   ├── url-handler-napi/    # stub
│   └── @ant/               # Anthropic 内部包 stub
│       ├── claude-for-chrome-mcp/
│       ├── computer-use-mcp/
│       ├── computer-use-input/
│       └── computer-use-swift/
├── scripts/                 # 自动化 stub 生成脚本
├── dist/                    # 构建输出
└── package.json             # Bun workspaces monorepo 配置
```

## 技术说明

### 运行时 Polyfill

入口文件 `src/entrypoints/cli.tsx` 顶部注入了必要的 polyfill：

- `feature()` — 所有 feature flag 返回 `false`，跳过未实现分支
- `globalThis.MACRO` — 模拟构建时宏注入（VERSION 等）

### 类型状态

经过系统性修复，tsc 错误从 ~1341 降至 **~289**（减少 78%）。剩余错误分散在小文件中，均为反编译产生的源码级类型问题，**不影响 Bun 运行时**。详见 [RECORD.md](./RECORD.md) 第六节。

### Monorepo

项目采用 Bun workspaces 管理内部包。原先手工放在 `node_modules/` 下的 stub 已统一迁入 `packages/`，通过 `workspace:*` 解析。

## 许可证

本项目仅供学习研究用途。Claude Code 的所有权利归 [Anthropic](https://www.anthropic.com/) 所有。
