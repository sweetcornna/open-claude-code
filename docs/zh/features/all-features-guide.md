# Open Claude Code (occ) — 全功能使用指南

本文档覆盖我们为 occ 恢复/新增的主要功能，按类别组织，每个功能包含说明、使用方法和示例。

---

## 目录

2. [Remote Control 远程控制](#2-remote-control-远程控制)
3. [定时任务 /triggers](#3-定时任务-triggers)
4. [Voice Mode 语音模式](#4-voice-mode-语音模式)
6. [Computer Use 屏幕操控](#6-computer-use-屏幕操控)
7. [Feature Flags 与 GrowthBook](#7-feature-flags-与-growthbook)
8. [/ultraplan 高级规划](#8-ultraplan-高级规划)
9. [Daemon 后台守护](#9-daemon-后台守护)
10. [Monitor 后台监控](#10-monitor-后台监控)
11. [Workflow 工作流脚本](#11-workflow-工作流脚本)
12. [Coordinator 多Worker协调](#12-coordinator-多worker协调)
13. [Proactive 自主模式](#13-proactive-自主模式)
14. [Fork 子Agent](#14-fork-子agent)
15. [其他恢复的工具](#15-其他恢复的工具)

---

## 2. Remote Control 远程控制

**Feature Flag**: `ACP`（默认编译进）

### 说明
从手机或浏览器控制会话。occ 提供 ACP agent（`occ --acp`），客户端和中继交给 [Happy](https://github.com/slopus/happy)（MIT）—— 手机 App、Web、端到端加密、服务端可自托管。

### 使用
```bash
# 安装 Happy CLI（一次性）
npm install -g happy-coder

# 在项目目录里启动；等价于 happy acp -- <occ> --acp
occ remote-control

# 自托管中继
HAPPY_SERVER_URL=https://happy.example.com occ remote-control
```

### 命令
- `occ remote-control` / `occ rc` / `occ remote` / `occ sync` / `occ bridge` — 同一个命令的别名

> occ 自建的 bridge、`packages/remote-control-server/`、`packages/acp-link/` 和 `BRIDGE_MODE` 已于 2026-07 删除。迁移见 [Remote Control 文档](./remote-control-self-hosting.md)。

---

## 3. 定时任务 /triggers

**PR**: #88 `feat: enable /schedule by adding AGENT_TRIGGERS_REMOTE`
**Feature Flag**: `AGENT_TRIGGERS_REMOTE`

> 命令名已从 `/schedule` 改为 `/triggers`，避免与上游 bundled skill `schedule` 冲突。`/cron` 是别名。

### 说明
创建定时执行的远程 agent 任务，支持 cron 表达式。

### 使用
```
/triggers create "每天检查依赖更新" --cron "0 9 * * *" --prompt "检查 package.json 中的过期依赖并创建更新 PR"
/triggers list          — 列出所有定时任务
/triggers delete <id>   — 删除指定任务
```

---

## 4. Voice Mode 语音模式

**PR**: #92 `feat: enable /voice mode with native audio binaries`
**Feature Flag**: `VOICE_MODE`

### 说明
Push-to-Talk 语音输入，音频通过 WebSocket 流式传输到 Anthropic STT（Nova 3）。需要 Anthropic OAuth 认证（非 API key）。

### 使用
```bash
# 确保已通过 OAuth 登录
occ auth login

# 在会话中按住指定键说话
# 松开后自动转写为文字输入
```

### 前提条件
- Anthropic OAuth 认证（不支持 API key 模式）
- 系统麦克风权限

---

## 6. Computer Use 屏幕操控

**PR**: #98 + #137 `feat: Computer Use — 跨平台 Executor + Python Bridge + GUI 无障碍`
**Feature Flag**: `CHICAGO_MCP`

### 说明
跨平台屏幕操控：截图、键鼠模拟、应用管理。支持 macOS + Windows，Linux 后端待完成。

### 使用
```bash
# 启动后 AI 可自动调用屏幕操控工具
bun run dev

# AI 可以：
# - 截取屏幕/窗口截图
# - 模拟键盘输入和鼠标操作
# - 列出运行的应用
# - 使用剪贴板
```

### 平台支持
| 平台 | 截图 | 键鼠 | 应用管理 |
|------|------|------|----------|
| macOS | ✅ | ✅ | ✅ |
| Windows | ✅ | ✅ | ✅ |
| Linux | ⏳ | ⏳ | ⏳ |

---

## 7. Feature Flags 与 GrowthBook

**PR**: #140 + #153 `feat: enable GrowthBook local gate defaults`
**Feature Flags**: `PROMPT_CACHE_BREAK_DETECTION`, `TOKEN_BUDGET`

### 说明
本地 GrowthBook gate defaults 机制，绕过远程 feature flag 服务，确保功能在无网络时也可使用。

### 使用
```bash
# 通过环境变量启用任意 feature
FEATURE_PROACTIVE=1 bun run dev

# dev/build 模式有各自的默认启用列表
# 查看 scripts/dev.ts 中的 DEFAULT_FEATURES
```

### 关键 feature flags
| Flag | 说明 |
|------|------|
| `TOKEN_BUDGET` | Token 预算控制 |
| `PROMPT_CACHE_BREAK_DETECTION` | Prompt 缓存命中检测 |

---

## 8. /ultraplan 高级规划

**PR**: #156 `feat: enable /ultraplan and harden GrowthBook fallback chain`
**Feature Flag**: `ULTRAPLAN`

### 说明
高级多 agent 规划模式。将复杂任务分解为多个阶段，每阶段可分配给不同 agent 并行执行。

### 使用
```
/ultraplan 实现一个完整的用户认证系统，包括注册、登录、密码重置、OAuth 集成
```

AI 会生成：
1. 任务分解（多阶段）
2. 每阶段的 agent 分配
3. 依赖关系图
4. 并行执行计划

---

## 9. Daemon 后台守护

**PR**: #170 `feat: restore daemon supervisor and remoteControlServer command`
**Feature Flag**: `DAEMON`

### 说明
Daemon 模式允许 Claude Code 作为后台长驻进程运行，管理多个 worker。

### 使用
```bash
# 启动 daemon
occ daemon start

# 查看状态
occ daemon status

# 停止
occ daemon stop

# 启动远程控制服务器
bun run rcs
```

---

## 10. Monitor 后台监控

**PR**: #241（同上）
**Feature Flag**: `MONITOR_TOOL`

### 说明
在后台运行 shell 命令持续监控输出（类似 `watch` 命令）。AI 也可自主调用 MonitorTool。

### 使用

**用户命令**：
```
/monitor tail -f /var/log/syslog
/monitor watch -n 5 docker ps
/monitor "while true; do curl -s localhost:3000/health; sleep 10; done"
```

**查看监控**：
- 按 `Shift+Down` 展开后台任务面板
- 查看监控输出和状态

**Windows 兼容**：
`watch -n <sec> <cmd>` 自动转为 PowerShell 循环：
```powershell
while($true){ <cmd>; Start-Sleep -Seconds <sec> }
```

**AI 调用**：
AI 可在对话中自动调用 `MonitorTool` 监控日志、构建输出等。

**定时唤醒模式（`wait_seconds`）**：
`MonitorTool` 接受 `command` 或 `wait_seconds` 之一（不能同时给）。传 `wait_seconds` 时它在后台跑一个计时器，AI 立刻结束当前 turn，计时结束由 task notification 唤醒 —— 用来替代会阻塞会话的前台 `Bash(sleep ...)`。要等的是**条件**而非固定时长时，仍用 command 模式跑 until 循环（例如 `until curl -sf localhost:3000/health; do sleep 2; done`）。

---

## 11. Workflow 工作流脚本

**PR**: #241（同上）
**Feature Flag**: `WORKFLOW_SCRIPTS`

### 说明
执行 `.occ/workflows/` 目录下的用户定义工作流脚本。

### 使用

**创建工作流**：
```bash
mkdir -p .occ/workflows
cat > .occ/workflows/deploy.mjs << 'EOF'
export const meta = { name: 'deploy', description: 'verify a release build' }
phase('Verify')
const tests = await agent('Run the project test suite and summarize the result.', { label: 'tests' })
const build = await agent('Run the production build and summarize the result.', { label: 'build' })
log('Deployment checks finished')
return { tests, build }
EOF
```

**列出可用工作流**：
```
/workflows
```

**AI 调用**：
AI 可通过 `WorkflowTool` 自动执行工作流：
```
请执行 deploy 工作流
```

---

## 12. Coordinator 多Worker协调

**PR**: #241（同上）
**Feature Flag**: `COORDINATOR_MODE`

### 说明
启用 coordinator 模式后，AI 可自动将任务分配给多个 worker 并行执行。

### 使用
```
/coordinator       — 切换 coordinator 模式开/关
```

启用后，AI 在处理复杂任务时会：
1. 分析任务可并行的部分
2. 自动创建 worker 分支
3. 分配子任务
4. 汇总结果

---

## 13. Proactive 自主模式

**PR**: #241（同上）
**Feature Flag**: `PROACTIVE` / `KAIROS`

### 说明
启用后 AI 会主动发起操作（而不仅回应用户输入），例如自动检测文件变更、主动提出优化建议。

### 使用
```
/proactive         — 切换 proactive 模式开/关
```

---

## 14. Fork 子Agent

**PR**: #241（同上）
**Feature Flag**: `FORK_SUBAGENT`（不在默认启用列表中，需 `FEATURE_FORK_SUBAGENT=1`）

### 说明
在当前对话上下文中 fork 一个独立的子 agent，继承完整会话状态独立执行。

### 使用
该功能没有专属斜杠命令 —— `/fork` 现在只是 `/branch`（对话分支）的别名。fork 路径通过 AgentTool 触发：`subagent_type` 本身一直是可选参数，flag 关闭时省略它会回落到 general-purpose，flag 启用后省略它即进入 fork 分支。

```bash
FEATURE_FORK_SUBAGENT=1 bun run dev
```

> 与 coordinator 模式互斥；非交互式会话下不启用。

子 agent 会：
- 继承当前的全部对话历史
- 在独立的执行环境中运行
- 不影响主会话状态

---

## 15. 其他恢复的工具

以下工具从 stub 恢复为完整实现：

| 工具 | 说明 | 使用 |
|------|------|------|
| `MonitorTool` | 后台监控命令输出；`wait_seconds` 模式作为定时唤醒器 | AI 在轮询/等待场景自动调用 |
| `WebBrowserTool` | 终端内网页交互 | AI 需要查看网页时调用 |
| `SubscribePRTool` | 订阅 GitHub PR 变更 | `/subscribe-pr` 或 AI 调用 |
| `TerminalCaptureTool` | 截取终端屏幕 | AI 需要看终端输出时调用 |
| `REPLTool` | 启动子 REPL 会话 | AI 需要独立交互环境时调用 |
| `VerifyPlanExecutionTool` | 验证执行计划完成度 | AI 完成计划后自动验证 |
| `SuggestBackgroundPRTool` | 建议创建后台 PR | AI 发现可独立的变更时提议 |

---

## 附录：全部 Feature Flags

| Flag | 默认 | 说明 |
|------|------|------|
| `VOICE_MODE` | ✅ dev+build | 语音模式 |
| `CHICAGO_MCP` | ✅ dev+build | Computer Use |
| `AGENT_TRIGGERS_REMOTE` | ✅ dev+build | 定时任务 |
| `TOKEN_BUDGET` | ✅ dev+build | Token 预算 |
| `PROMPT_CACHE_BREAK_DETECTION` | ✅ dev+build | 缓存检测 |
| `ULTRAPLAN` | ✅ dev+build | 高级规划 |
| `DAEMON` | ✅ dev+build | 后台守护 |
| `MONITOR_TOOL` | ✅ dev+build | 后台监控 |
| `WORKFLOW_SCRIPTS` | ✅ dev+build | 工作流脚本 |
| `FORK_SUBAGENT` | ❌ 需手动启用（`FEATURE_FORK_SUBAGENT=1`） | 子 Agent |
| `KAIROS` | ✅ dev+build | Kairos 调度 |
| `COORDINATOR_MODE` | ✅ dev+build | 多 Worker |
| `ULTRATHINK` | ✅ dev+build | 扩展思考 |
| `EXTRACT_MEMORIES` | ✅ dev+build | 自动记忆提取 |
| `VERIFICATION_AGENT` | ✅ dev+build | 验证 Agent |
| `KAIROS_BRIEF` | ✅ dev+build | Brief 模式 |
| `AWAY_SUMMARY` | ✅ dev+build | 离开摘要 |
| `ACP` | ✅ dev+build | ACP 协议 |
| `LODESTONE` | ✅ dev+build | 深度链接 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | ✅ dev+build | 内置 Explore/Plan agent |
| `AGENT_TRIGGERS` | ✅ dev+build | 本地定时任务 |
| `BG_SESSIONS` | ✅ dev only | 后台会话 |
| `TEMPLATES` | ✅ dev only | 模板系统 |
| `TRANSCRIPT_CLASSIFIER` | ✅ dev only | 对话分类 |

手动启用任意 flag：
```bash
FEATURE_FLAG_NAME=1 bun run dev
```

---

## 附录：PR 列表

| PR | 日期 | 标题 |
|----|------|------|
| #60 | 2026-04-02 | feat: enable Remote Control (BRIDGE_MODE) |
| #82 | 2026-04-03 | refactor(buddy): align companion system |
| #88 | 2026-04-03 | feat: enable /schedule (AGENT_TRIGGERS_REMOTE) |
| #89 | 2026-04-03 | feat: built-in status line |
| #92 | 2026-04-03 | feat: enable /voice mode |
| #98 | 2026-04-03 | feat: enable Computer Use (macOS + Windows + Linux) |
| #137 | 2026-04-05 | feat: Computer Use v2 — 跨平台 Executor |
| #140 | 2026-04-05 | feat: enable SHOT_STATS, TOKEN_BUDGET |
| #153 | 2026-04-06 | feat: enable GrowthBook local gate defaults |
| #156 | 2026-04-06 | feat: enable /ultraplan |
| #170 | 2026-04-07 | feat: restore daemon supervisor |
| #241 | 2026-04-11 | feat: restore pipe IPC, LAN pipes, monitor tool |

> 说明：#241 中的 pipe IPC（`UDS_INBOX`）与 LAN Pipes（`LAN_PIPES`）已于 2026-07 移除（`MONITOR_TOOL` 不受影响）；同期移除的还有 History / Snip（`HISTORY_SNIP`）、上下文折叠（`CONTEXT_COLLAPSE`，非 #241 引入）及 `SnipTool`、`CtxInspectTool`、`ListPeersTool` 等工具，对应章节与 flag 已从本指南删除。
