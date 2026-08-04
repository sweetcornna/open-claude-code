<!-- lang-switcher -->
**中文**

# KAIROS — 常驻助手模式

> Feature Flag: `FEATURE_KAIROS=1`（及子 Feature）
> 实现状态：核心框架完整，部分子模块为 stub；proactive 节奏控制已可用
> 引用数：154（全库最大）

## 一、功能概述

KAIROS 将 Claude Code CLI 从"问答工具"转变为"常驻助手"。开启后，CLI 持续运行在后台，支持：

- **持久化 bridge 会话**：跨终端重启复用 session，通过 Anthropic OAuth 连接 claude.ai
- **后台执行任务**：用户离开终端时继续工作（配合 PROACTIVE feature）
- **推送通知到移动端**：任务完成或需要输入时推送（配合 `KAIROS_PUSH_NOTIFICATION`）
- **每日记忆日志**：自动记录和回顾工作内容（配合 `KAIROS_DREAM`）
- **外部频道消息接入**：Slack/Discord/Telegram 消息转发到 CLI（配合 `KAIROS_CHANNELS`）
- **结构化 Brief 输出**：通过 BriefTool 输出结构化消息（配合 `KAIROS_BRIEF`）

### 子 Feature 依赖关系

```
KAIROS (主开关)
├── KAIROS_BRIEF (BriefTool, 结构化输出)
├── KAIROS_CHANNELS (外部频道消息)
├── KAIROS_PUSH_NOTIFICATION (移动端推送)
├── KAIROS_GITHUB_WEBHOOKS (GitHub PR webhook)
└── KAIROS_DREAM (记忆蒸馏)
```

**注意**：PROACTIVE 与 KAIROS 强绑定。所有代码检查都是 `feature('PROACTIVE') || feature('KAIROS')`，即 KAIROS 开启时自动获得 proactive 能力。

## 二、系统提示

KAIROS 在系统提示中注入两大段落：

### 2.1 Brief 段落 (`getBriefSection`)

文件：`src/constants/prompts.ts:847-858`

当 `feature('KAIROS') || feature('KAIROS_BRIEF')` 时注入。Brief 工具（`SendUserMessage`）的结构化消息输出指令。`/brief` toggle 和 `--brief` flag 只控制显示过滤，不影响模型行为。

### 2.2 Proactive/Autonomous Work 段落 (`getProactiveSection`)

文件：`src/constants/prompts.ts:864-918`

当 `feature('PROACTIVE') || feature('KAIROS')` 且 `isProactiveActive()` 时注入。核心行为指令：

- **Tick 驱动**：通过 `<tick_tag>` prompt 保持存活，每个 tick 包含用户当前本地时间
- **节奏控制**：由 tick 调度器唤醒；需要定点唤醒时用 `Monitor` 的 `wait_seconds` 计时器（prompt cache 5 分钟过期）
- **空操作时直接结束 turn**：禁止输出 "still waiting" 类文本（浪费 turn 和 token）
- **偏向行动**：读文件、搜索代码、修改文件、commit — 都不需询问
- **终端焦点感知**：`terminalFocus` 字段指示用户是否在看终端
  - Unfocused → 高度自主行动
  - Focused → 更协作，展示选择

## 三、实现架构

### 3.1 核心模块

| 模块 | 文件 | 状态 | 职责 |
|------|------|------|------|
| Assistant 入口 | `src/assistant/index.ts` | Stub | `isAssistantMode()`、`initializeAssistantTeam()` |
| Session 发现 | `src/assistant/sessionDiscovery.ts` | Stub | 发现可用 bridge session |
| Session 历史 | `src/assistant/sessionHistory.ts` | Stub | 持久化 session 历史 |
| Gate 控制 | `src/assistant/gate.ts` | Stub | GrowthBook 门控检查 |
| Session 选择器 | `src/assistant/AssistantSessionChooser.ts` | Stub | UI 选择 session |
| BriefTool | `src/tools/BriefTool/` | Stub | 结构化消息输出工具 |
| Channel Notification | `src/services/mcp/channelNotification.ts` | Stub | 外部频道消息接入 |
| Dream Task | `src/components/tasks/src/tasks/DreamTask/` | Stub | 记忆蒸馏任务 |
| Memory Directory | `src/memdir/memdir.ts` | Stub | 记忆目录管理 |

### 3.2 节奏控制（与 Proactive 共享）

历史上 KAIROS/Proactive 靠一个专用的 `Sleep` 工具控制节奏。该工具已移除 —— 它在非 proactive 会话里必定立刻返回 `interrupted: true`（"Sleep interrupted after 0s"），且 tick 调度器本来就会重新唤醒模型。

现在的模型：
- 无事可做 → 直接结束 turn，等下一个 tick
- 需要在某个时间点再看一眼 → `Monitor` 的 `wait_seconds` 模式后台计时，结束 turn，计时到点由 task notification 唤醒
- 需要等一个*条件*成立 → `Monitor` 的 command 模式跑 until 循环
- 远程控制 surfaces 通过 `automation_state` 可看到 `standby`；`sleeping` 是仅为兼容旧客户端保留的遗留值，不再发出

### 3.3 远程接入

> **已变更（2026-07）**：KAIROS 原先通过自建的 Bridge Mode（`src/bridge/`）长轮询 claude.ai 服务器。`src/bridge/` 与 `BRIDGE_MODE` 已删除。

现在的远程接入走 ACP：occ 作为 ACP agent（`occ --acp`），客户端由 [Happy](https://github.com/slopus/happy) 提供，`occ remote-control` 把两者接起来。

```
Happy 手机 App / Web
      │
      ▼ (E2E 加密，服务端可自托管)
┌──────────────────────┐
│  Happy Server        │
└──────────┬───────────┘
           │ ACP over stdio
           ▼
┌──────────────────────┐
│  occ ACP Agent       │  src/services/acp/
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  REPL + Proactive    │  Tick 驱动自主工作
│  Tick Loop           │
└──────────────────────┘
```

KAIROS 的本地能力（tick 调度、Brief 结构化输出、terminal focus 感知）不依赖任何远程传输，单机也完整可用。

## 四、关键设计决策

1. **Tick 驱动而非事件驱动**：由 tick 调度器唤醒模型（模型可另起 Monitor 计时器做定点唤醒），而非外部事件推送。简化架构但增加 API 调用开销
2. **KAIROS ⊃ PROACTIVE**：所有 proactive 检查都包含 KAIROS，无需同时开启两个 flag
3. **Brief 显示/行为分离**：`/brief` toggle 只控制 UI 过滤，模型始终可以使用 BriefTool
4. **Terminal Focus 感知**：模型根据用户是否在看终端自动调节自主程度
5. **GrowthBook 门控**：部分功能即使 feature flag 开启还需要服务端 GrowthBook 开关

## 五、使用方式

```bash
# 最小启用（常驻助手 + Brief）
FEATURE_KAIROS=1 FEATURE_KAIROS_BRIEF=1 bun run dev

# 全功能启用
FEATURE_KAIROS=1 \
FEATURE_KAIROS_BRIEF=1 \
FEATURE_KAIROS_CHANNELS=1 \
FEATURE_KAIROS_PUSH_NOTIFICATION=1 \
FEATURE_KAIROS_GITHUB_WEBHOOKS=1 \
FEATURE_PROACTIVE=1 \
bun run dev

# 配合 Token Budget 使用
FEATURE_KAIROS=1 FEATURE_TOKEN_BUDGET=1 bun run dev
```

## 六、外部依赖

- **Anthropic OAuth**：必须使用 claude.ai 订阅登录（非 API key）
- **GrowthBook**：服务端特性门控
- **远程接入**（可选）：Happy CLI（`npm install -g happy-coder`）

## 七、文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/assistant/index.ts` | 9 | Assistant 模块入口（stub） |
| `src/assistant/gate.ts` | — | GrowthBook 门控（stub） |
| `src/assistant/sessionDiscovery.ts` | — | Session 发现（stub） |
| `src/assistant/sessionHistory.ts` | — | Session 历史（stub） |
| `src/assistant/AssistantSessionChooser.ts` | — | Session 选择 UI（stub） |
| `src/tools/BriefTool/` | — | BriefTool 实现（stub） |
| `packages/builtin-tools/src/tools/MonitorTool/MonitorTool.tsx` | ~230 | Monitor 工具（含 `wait_seconds` 计时器模式） |
| `src/services/mcp/channelNotification.ts` | 5 | 频道消息接入（stub） |
| `src/memdir/memdir.ts` | — | 记忆目录管理（stub） |
| `src/constants/prompts.ts:557,847-918` | 72 | 系统提示注入 |
| `src/components/tasks/src/tasks/DreamTask/` | 3 | Dream 任务（stub） |
| `src/proactive/index.ts` | — | Proactive 核心（KAIROS 共享） |
| `src/utils/sessionState.ts` | — | 向 bridge/CCR 暴露 automation 状态 |
