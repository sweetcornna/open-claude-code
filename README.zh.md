# Open Claude Code (occ)

[![GitHub Stars](https://img.shields.io/github/stars/sweetcornna/open-claude-code?style=flat-square&logo=github&color=yellow)](https://github.com/sweetcornna/open-claude-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/sweetcornna/open-claude-code?style=flat-square&color=orange)](https://github.com/sweetcornna/open-claude-code/issues)
[![Last Commit](https://img.shields.io/github/last-commit/sweetcornna/open-claude-code?style=flat-square&color=blue)](https://github.com/sweetcornna/open-claude-code/commits/main)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)

> Claude Code 社区版 —— 官方 Claude Code 的优化衍生版，可与官方版装在同一台机器上共存。

[English](./README.md) · **简体中文** · [日本語](./README.ja.md)

**open-claude-code**（简称 `occ`）是 Anthropic 官方 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的**社区版（Community Edition）**：以逆向复原（reverse-engineered restoration）的代码为基座，由社区维护和优化的衍生版本。三件事说清它的定位：

- **它是什么** —— 一份可运行、可构建、可调试的 Claude Code 完整复原实现。在此基础上补齐了企业版特性，并扩展了 Goal 持续驱动、Ultracode 多 Agent 编排、Artifacts、多模型供应商、ACP 等能力。
- **和官方什么关系** —— 独立的社区项目，与 Anthropic 无关联、未获其背书。跟随官方功能演进，但补什么、裁什么由社区决定。
- **为什么能共存** —— occ 与官方版做了用户态完全隔离：配置、状态、缓存、凭据各走各的（见下表），两者装在同一台机器上互不干扰，登录也不会互相覆盖 token。

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
occ migrate --dry-run              # 先看会拷什么
occ migrate                        # 真的拷（默认剥离密钥）
occ migrate --with-credentials     # 连登录一起拷，装好即用
```

两种模式拷的**东西一样**：settings、skills、agents、commands、output-styles、workflows、plugins、rules 和 MCP server 定义。区别只在**密钥要不要跟着走**。首启向导里是同样的三个选项。

- **默认（不带凭据）**：剥离 OAuth token、API key、`settings.env` 里的密钥类变量、MCP server 的 `env`/`headers`，以及 `apiKeyHelper` / `awsAuthRefresh` / `awsCredentialExport` / `gcpAuthRefresh` / `otelHeadersHelper` 这些「跑个命令换出凭据」的键。**路由配置照常带走**：`*_BASE_URL`、`*_MODEL`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_CODE_USE_*`、`*_AUTH_MODE`，以及 `CLAUDE_CODE_CLIENT_CERT` / `CLAUDE_CODE_CLIENT_KEY` 这类**证书路径**（路径不是密钥，成对保留，只剥 `..._PASSPHRASE`）。你只需要把 key 重新填一遍。剥了哪些键会在迁移前逐条列出来，不会静默丢。
- **`--with-credentials`**：OAuth token、legacy API key 和 `~/.claude.json` 里的账号键（`primaryApiKey`、`oauthAccount`、`customApiKeyResponses`、`workspaceApiKey`）一并带走，不用再 `/login`。**注意**：refresh token 由服务端轮换，两边 CLI 拿的是同一个，谁先刷新另一边就得重新登录——建议日常固定主用一边。
- 先选了默认模式、之后又想要凭据，直接补跑 `occ migrate --with-credentials` 即可：除了登录本身，它还会把上一次被剥掉的 `settings.json` 密钥补回去（**只补缺失的键**，你在 occ 侧已经改过的值一律不动）。`.migrated` 标记记录了已迁移的类别，不会把你挡在外面。
- `--skip-account-data` / `--no-account-data` 是旧版拼写，现在等价于默认模式。
- 有两处 occ 无从判断、因此**原样带走并在报告里点名**：`settings.json` 的 `pluginConfigs`，以及 `plugins/` 目录里的文件。插件声明为 `sensitive` 的字段本来就存在 secure storage、默认模式压根不碰；但这条约定由各插件自己的 manifest 保证，所以残留由你过目。

**会话历史永不拷贝**。凭据是单向、no-clobber 的：occ 这边已经有登录就保留 occ 的，官方 keychain 条目从头到尾不改。`~/.claude` 全程只读，不写不删不改。

## ⚡ 快速开始（安装版）

一条命令安装（自动选择 bun/npm，装完自检）：

```sh
curl -fsSL https://raw.githubusercontent.com/sweetcornna/open-claude-code/main/scripts/install.sh | bash
```

或手动：

```sh
npm i -g @sweetcornna/open-claude-code

occ           # 以 Node.js 启动
occ-bun       # 以 Bun 启动
occ update    # 更新到最新版本
```

首次运行 `occ` 会进入配置向导：可选从官方 Claude Code（`~/.claude`）迁移既有配置，然后选择 OAuth 登录或 API 配置（Anthropic 兼容 / OpenAI 兼容 / 国产模型 preset / Gemini / Grok），API 模式下可直接填协议（chat/responses）、模型名和模型最大上下文（自动联动 auto-compact 阈值）。详见 `docs/zh/features/providers.md`。

> 2.8 之前的 `ccb` / `ccb-bun` 命令名已移除，沿用旧命令的脚本请改为 `occ` / `occ-bun`。

> **安装/更新失败？** 先 `npm rm -g @sweetcornna/open-claude-code` 清理，再 `npm i -g @sweetcornna/open-claude-code@latest`。仍失败则指定版本号。

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

### 👤 首次配置（向导 / `/login`）

第一次运行 `occ` 会自动进入配置向导；之后想换供应商，在 REPL 里输入 `/login` 随时重配。向导里能选：

- **Claude 订阅 / Anthropic Console** —— 浏览器 OAuth 登录，不用填任何东西；
- **Anthropic 兼容 / OpenAI 兼容 / Gemini / Grok** —— 自己填端点和 key，跑 GPT、GLM、Kimi、DeepSeek、Ollama、vLLM 等任意兼容服务；
- **国产模型 preset** —— DeepSeek / 智谱 GLM / 千问 / MiMo，选好模型填个 key 就能用，上下文窗口自动配好。

手填表单的字段（除 Base URL / API Key 外都可留空）：

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| Base URL | API 服务地址 | `https://api.example.com/v1` |
| API Key | 认证密钥 | `sk-xxx` |
| Model | 单一模型名，填了就全程用它 | `glm-4.6` |
| Wire API | 协议（仅 OpenAI 表单）：`chat`（默认）或 `responses` | `chat` |
| Max ctx | 模型的最大上下文。填对了，occ 会在快满时自动压缩对话，而不是撞上"prompt is too long" | `128k` / `1m` / `200000` |
| Haiku / Sonnet / Opus / Fable | 按档位分别指定模型（不想区分就只填 Model）；档位从低到高为 haiku → sonnet → opus → fable | `claude-sonnet-5` |

**Tab / Shift+Tab** 切换字段，**Enter** 确认，最后一个字段按 Enter 保存。配置细节（环境变量、按模型开 1M 上下文、`/provider` 档案切换）见 [`docs/zh/features/providers.md`](./docs/zh/features/providers.md)。

## 主要特性

| 特性 | 说明 | 文档 |
| --- | --- | --- |
| **🎯 Goal 持续驱动** | `/goal <objective>` 设定目标后自动跨轮驱动 agent 直至完成；带 token budget、completion/blocked audit 与 `pause`/`resume`/`continue`/`clear` | [`src/commands/goal/`](./src/commands/goal/) |
| **🧠 Ultracode 多 Agent 编排** | `/ultracode` + `Workflow` 工具跑确定性 JS 脚本（`agent`/`pipeline`/`parallel`/`phase`），`/workflows` 双栏监控面板，支持 journal 重放与并发上限 | [文档](./docs/zh/features/workflow-scripts.md) |
| **🧩 插件市场** | 首次启动自动装上官方 `claude-plugins-official`（300+ 插件），`/plugin` 浏览安装；保留名只认 `github.com/anthropics/*` 严格来源 | `/plugin` |
| **📦 Artifacts** | 模型把 HTML/看板/报告上传到公开 URL（7d/30d 自动过期），Cloudflare Worker + R2 可自托管 | [说明](./packages/cloud-artifacts/README.md) |
| **ACP 协议支持** | 接入 Zed、Cursor 等 IDE，支持会话恢复、Skills、权限桥接 | [文档](./docs/zh/features/acp-zed.md) |
| **Remote Control** | `occ remote-control` 把会话交给 [Happy](https://github.com/slopus/happy)（手机 / Web / 端到端加密），走的是 occ 自己的 ACP agent；服务端可自托管 | [文档](./docs/zh/features/remote-control-self-hosting.md) |
| **Langfuse 监控** | 每次 agent loop 的细节都能看到，可一键转为数据集 | [文档](./docs/zh/features/langfuse-monitoring.md) |
| **Web Search** | 内置网页搜索，支持 Bing / Brave | [文档](./docs/zh/features/web-browser-tool.md) |
| **Poor Mode** | 穷鬼模式，关掉记忆提取和键入建议，大幅减少并发请求 | `/poor` 开关 |
| **Channels 频道通知** | MCP 服务器把外部消息推进会话（飞书/Slack/Discord 等） | [文档](./docs/zh/features/channels.md) |
| **自定义模型供应商** | OpenAI 兼容（GPT/GLM/Kimi/DeepSeek）/ Anthropic 兼容 / Gemini / Grok，可配协议、模型与最大上下文 | [文档](./docs/zh/features/providers.md) |
| Voice Mode | 语音输入，支持豆包（`/voice doubao`） | [文档](./docs/zh/features/voice-mode.md) |
| Computer Use | 屏幕截图、键鼠控制 | [文档](./docs/zh/features/computer-use.md) |
| **Chrome 浏览器工具** | `occ --chrome` 接上 Google `chrome-devtools-mcp`：导航、点击、快照、控制台/网络、性能 trace。改页面的操作都要确认 | [文档](./docs/zh/features/chrome-devtools-mcp.md) |
| Chrome Use（第三方） | 另一套方案：`hangwin/mcp-chrome` 扩展 | [文档](./docs/zh/features/chrome-use-mcp.md) |
| /dream 记忆整理 | 自动整理和优化记忆文件 | [文档](./docs/zh/features/auto-dream.md) |

## Feature Flags

功能开关通过 `FEATURE_<FLAG_NAME>` 环境变量控制，`1` / `true` 开，`0` / `false` / 留空关：

```bash
FEATURE_FORK_SUBAGENT=1 bun run dev    # 开一个默认没编进去的 flag
FEATURE_GOAL=0 bun run build           # 关掉一个默认开着的 flag
```

默认启用的 33 个 flag 见 [`scripts/defines.ts`](./scripts/defines.ts) 的 `DEFAULT_BUILD_FEATURES`；不在表里的需要显式开。dev 与 build 共用同一套解析逻辑，所以两边行为一致。各 Feature 的说明见 [`docs/zh/features/`](./docs/zh/features/)。

## VS Code 调试

TUI (REPL) 模式需要真实终端，用 **attach 模式**：

```bash
bun run dev:inspect     # 输出 ws://localhost:8888/xxxx
```

然后在 `src/` 里打断点，F5 选择 **"Attach to Bun (TUI debug)"**。

## 开发

```bash
bun run precheck      # typecheck + lint fix + test，任务完成后必须零错误通过
bun run typecheck
bun run test
bun run build:vite
```

架构说明、模块地图、路径与隔离不变式、测试规范都在 [`CLAUDE.md`](./CLAUDE.md) —— **改任何路径相关代码前先读它**。

## 致谢

- [claude-code-best/claude-code](https://github.com/claude-code-best/claude-code) — 可运行、可构建、可调试的 Claude Code 还原工程（"原汁原味 Claude Code"）。occ 从该仓库 fork 而来，复原基座与大量企业特性还原工作源自该项目
- [doubaoime-asr](https://github.com/starccy/doubaoime-asr) — 豆包 ASR 语音识别 SDK，为 Voice Mode 提供无需 Anthropic OAuth 的语音输入方案
- [free-search-mcp](https://github.com/sweetcornna/free-search-mcp) — 免 API key 的本地优先搜索 MCP server。WebSearch 的 `free` 搜索源移植自它的无密钥引擎池（DuckDuckGo / Mojeek / Bing）、RRF 融合与 SearXNG 救援策略

## 许可证

本仓库的还原与原创工作以 [MIT License](./LICENSE) 发布，仅供学习研究用途。"Claude"、"Claude Code" 与 "Anthropic" 是 [Anthropic](https://www.anthropic.com/) 的商标；本项目与 Anthropic 无关联、未获其背书。
