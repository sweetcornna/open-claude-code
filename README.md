# Open Claude Code (occ)

[![GitHub Stars](https://img.shields.io/github/stars/sweetcornna/open-claude-code?style=flat-square&logo=github&color=yellow)](https://github.com/sweetcornna/open-claude-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/sweetcornna/open-claude-code?style=flat-square&color=orange)](https://github.com/sweetcornna/open-claude-code/issues)
[![Last Commit](https://img.shields.io/github/last-commit/sweetcornna/open-claude-code?style=flat-square&color=blue)](https://github.com/sweetcornna/open-claude-code/commits/main)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)

> 一个可以和官方 Claude Code 并存的开源终端 AI 编程助手。

**open-claude-code**（简称 `occ`）是 Anthropic [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的完整复原工程。在此基础上补齐了企业版特性，扩展了 Goal、Ultracode 多 Agent 编排、Artifacts、ACP 等能力，并且**与官方 Claude Code 完全隔离** —— 两者可以装在同一台机器上，互不干扰。

## 与官方 Claude Code 的隔离

这是 occ 和其它 fork 最大的区别。隔离之前，fork 与官方共用 `~/.claude`、`~/.claude.json`、缓存树，**以及同一条 macOS keychain 记录** —— 任一边登录都会覆盖对方的 OAuth token。现在各走各的：

| | open-claude-code | 官方 Claude Code |
| --- | --- | --- |
| 用户配置 | `~/.occ/` | `~/.claude/` |
| 全局状态 | `~/.occ.json` | `~/.claude.json` |
| 项目内资产 | `.occ/` | `.claude/` |
| 缓存 | `~/.cache/occ-nodejs/` | `~/.cache/claude-cli-nodejs/` |
| 凭据（macOS） | `Open Claude Code-credentials-<hash>` | `Claude Code-credentials` |
| 企业策略 | `/etc/occ`、`win.open-claude-code.occ` | `/etc/claude-code`、`com.anthropic.claudecode` |
| 环境变量 | `OCC_CONFIG_DIR` | `CLAUDE_CONFIG_DIR`（occ 仍兼容读取） |

**故意共享的部分**：`CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` 记忆文件名不改（是跨工具生态约定，改名会让所有既有仓库丢上下文）；子进程仍然收到 `CLAUDECODE=1`（大量用户 hook 脚本靠它判断环境），同时额外收到 `OCC=1`；IDE 锁文件两个目录都会搜（插件是 Anthropic 的，写在 `~/.claude/ide`）。

### 从官方版迁移

```sh
occ migrate --dry-run   # 先看会拷什么
occ migrate             # 真的拷
```

会拷贝 settings、skills、agents、commands、output-styles、workflows、plugins、rules 和 MCP server 配置。

**不会拷贝凭据和会话历史** —— 凭据与官方共用，拷过来等于把要拆掉的耦合又搬回来；装好后跑一次 `/login` 即可。`~/.claude` 全程只读，不写不删不改。

## ⚡ 快速开始（安装版）

```sh
npm i -g open-claude-code

occ           # 以 Node.js 启动
occ-bun       # 以 Bun 启动
occ update    # 更新到最新版本
```

> 2.8 之前的 `ccb` / `ccb-bun` 命令名已移除，沿用旧命令的脚本请改为 `occ` / `occ-bun`。

> **安装/更新失败？** 先 `npm rm -g open-claude-code` 清理，再 `npm i -g open-claude-code@latest`。仍失败则指定版本号。

## ⚡ 快速开始（源码版）

### ⚙️ 环境要求

一定要最新版本的 bun，不然会遇到一堆奇怪的 BUG。

- 📦 [Bun](https://bun.sh/) >= 1.3.11

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# 已装过的话
bun upgrade
```

安装脚本会把 `~/.bun/bin` 写进 shell 配置。重开终端或 `source ~/.zshrc` / `source ~/.bashrc` 后，用 `bun --version` 验证。

### 📥 安装与运行

```bash
cd /path/to/open-claude-code
bun install

bun run dev      # 开发模式
bun run build    # 构建
```

构建采用 code splitting 多文件打包，产物在 `dist/`，Bun 和 Node.js 都能启动。

### 👤 首次配置 `/login`

首次运行后在 REPL 里输入 `/login`，选 **Anthropic Compatible** 就能对接第三方兼容服务（不需要 Anthropic 官方账号）。OpenAI、Gemini、Grok 各有对应栏目。

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| Base URL | API 服务地址 | `https://api.example.com/v1` |
| API Key | 认证密钥 | `sk-xxx` |
| Haiku Model | 快速模型 ID | `claude-haiku-4-5-20251001` |
| Sonnet Model | 均衡模型 ID | `claude-sonnet-4-6` |
| Opus Model | 高性能模型 ID | `claude-opus-4-6` |

**Tab / Shift+Tab** 切换字段，**Enter** 确认，最后一个字段按 Enter 保存。

## 主要特性

| 特性 | 说明 | 文档 |
| --- | --- | --- |
| **🎯 Goal 持续驱动** | `/goal <objective>` 设定目标后自动跨轮驱动 agent 直至完成；带 token budget、completion/blocked audit 与 `pause`/`resume`/`continue`/`clear` | [`src/commands/goal/`](./src/commands/goal/) |
| **🧠 Ultracode 多 Agent 编排** | `/ultracode` + `Workflow` 工具跑确定性 JS 脚本（`agent`/`pipeline`/`parallel`/`phase`），`/workflows` 双栏监控面板，支持 journal 重放与并发上限 | [文档](./docs/features/workflow-scripts.md) |
| **📦 Artifacts** | 模型把 HTML/看板/报告上传到公开 URL（7d/30d 自动过期），Cloudflare Worker + R2 可自托管 | [说明](./packages/cloud-artifacts/README.md) |
| **ACP 协议支持** | 接入 Zed、Cursor 等 IDE，支持会话恢复、Skills、权限桥接 | [文档](./docs/features/acp-zed.md) |
| **Remote Control 私有部署** | Docker 自托管远程界面，手机上也能看 | [文档](./docs/features/remote-control-self-hosting.md) |
| **Langfuse 监控** | 每次 agent loop 的细节都能看到，可一键转为数据集 | [文档](./docs/features/langfuse-monitoring.md) |
| **Web Search** | 内置网页搜索，支持 Bing / Brave | [文档](./docs/features/web-browser-tool.md) |
| **Poor Mode** | 穷鬼模式，关掉记忆提取和键入建议，大幅减少并发请求 | `/poor` 开关 |
| **Channels 频道通知** | MCP 服务器把外部消息推进会话（飞书/Slack/Discord 等） | [文档](./docs/features/channels.md) |
| **自定义模型供应商** | OpenAI / Anthropic / Gemini / Grok 兼容 | [文档](./docs/features/all-features-guide.md) |
| Voice Mode | 语音输入，支持豆包（`/voice doubao`） | [文档](./docs/features/voice-mode.md) |
| Computer Use | 屏幕截图、键鼠控制 | [文档](./docs/features/computer-use.md) |
| Chrome Use | 浏览器自动化、表单填写、数据抓取 | [文档](./docs/features/chrome-use-mcp.md) |
| /dream 记忆整理 | 自动整理和优化记忆文件 | [文档](./docs/features/auto-dream.md) |

## Feature Flags

功能开关通过 `FEATURE_<FLAG_NAME>=1` 环境变量启用：

```bash
FEATURE_BUDDY=1 FEATURE_FORK_SUBAGENT=1 bun run dev
```

默认启用的 34 个 flag 见 [`scripts/defines.ts`](./scripts/defines.ts) 的 `DEFAULT_BUILD_FEATURES`；不在表里的需要显式开。各 Feature 的说明见 [`docs/features/`](./docs/features/)。

## VS Code 调试

TUI (REPL) 模式需要真实终端，用 **attach 模式**：

```bash
bun run dev:inspect     # 输出 ws://localhost:8888/xxxx
```

然后在 `src/` 里打断点，F5 选择 **"Attach to Bun (TUI debug)"**。

## Teach Me 学习项目

内置 teach-me skill，通过问答式引导理解项目的任何模块（改编自 [sigma skill](https://github.com/sanyuan0704/sanyuan-skills)）：

```bash
/teach-me Claude Code 架构
/teach-me React Ink 终端渲染 --level beginner
/teach-me Tool 系统 --resume
```

会诊断你的水平、把主题拆成 5-15 个原子概念按依赖推进、用苏格拉底式提问引导，并支持 `--resume` 断点续学。

## 开发

```bash
bun run precheck      # typecheck + lint fix + test，任务完成后必须零错误通过
bun run typecheck
bun run test
bun run build:vite
```

架构说明、模块地图、路径与隔离不变式、测试规范都在 [`CLAUDE.md`](./CLAUDE.md) —— **改任何路径相关代码前先读它**。

## 致谢

- [doubaoime-asr](https://github.com/starccy/doubaoime-asr) — 豆包 ASR 语音识别 SDK，为 Voice Mode 提供无需 Anthropic OAuth 的语音输入方案

## 许可证

本项目仅供学习研究用途。Claude Code 的所有权利归 [Anthropic](https://www.anthropic.com/) 所有。
