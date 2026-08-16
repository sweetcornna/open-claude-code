<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/kairos) · [日本語](/docs/ja/features/kairos)

# KAIROS — Resident Assistant Mode

> Feature Flag: `FEATURE_KAIROS=1` (and subfeatures)
> Implementation status: The core framework is complete, some submodules are stubs, and proactive pacing is available
> References: 154 (highest in the repository)

## 1. Feature overview

KAIROS changes the Claude Code CLI from a question-and-answer tool into a resident assistant. When enabled, the CLI continues running in the background and supports:

- **Persistent bridge sessions**: Reuse a session across terminal restarts, with a connection to claude.ai through Anthropic OAuth
- **Background task execution**: Continue working while the user is away from the terminal, together with the PROACTIVE feature
- **Push notifications to mobile devices**: Send a notification when a task completes or requires input, together with `KAIROS_PUSH_NOTIFICATION`
- **Daily memory logs**: Automatically record and review work, together with `KAIROS_DREAM`
- **External channel message ingestion**: Forward Slack/Discord/Telegram messages to the CLI, together with `KAIROS_CHANNELS`
- **Structured Brief output**: Produce structured messages through BriefTool, together with `KAIROS_BRIEF`

### Subfeature dependencies

```
KAIROS (main switch)
├── KAIROS_BRIEF (BriefTool, structured output)
├── KAIROS_CHANNELS (external channel messages)
├── KAIROS_PUSH_NOTIFICATION (mobile push notifications)
├── KAIROS_GITHUB_WEBHOOKS (GitHub PR webhook)
└── KAIROS_DREAM (memory distillation)
```

**Note**: PROACTIVE and KAIROS are tightly coupled. Every code check uses `feature('PROACTIVE') || feature('KAIROS')`, so enabling KAIROS automatically provides proactive capabilities.

## 2. System prompt

KAIROS injects two major sections into the system prompt:

### 2.1 Brief section (`getBriefSection`)

File: `src/constants/prompts.ts:847-858`

This section is injected when `feature('KAIROS') || feature('KAIROS_BRIEF')` is true. It instructs the Brief tool (`SendUserMessage`) to produce structured message output. The `/brief` toggle and `--brief` flag control display filtering only and do not affect model behavior.

### 2.2 Proactive/Autonomous Work section (`getProactiveSection`)

File: `src/constants/prompts.ts:864-918`

This section is injected when `feature('PROACTIVE') || feature('KAIROS')` is true and `isProactiveActive()` is true. Its core behavior instructions are:

- **Tick-driven operation**: Use the `<tick_tag>` prompt to keep the session alive; each tick includes the user's current local time
- **Pacing control**: The tick scheduler wakes the model. For a wake-up at a specific time, use the `Monitor` `wait_seconds` timer; the prompt cache expires after 5 minutes
- **End no-op turns immediately**: Do not output text such as "still waiting," which wastes turns and tokens
- **Bias toward action**: Read files, search code, modify files, and commit without asking
- **Terminal-focus awareness**: The `terminalFocus` field indicates whether the user is viewing the terminal
  - Unfocused → act with high autonomy
  - Focused → collaborate more and present choices

## 3. Implementation architecture

### 3.1 Core modules

| Module | File | Status | Responsibility |
|------|------|------|------|
| Assistant entry point | `src/assistant/index.ts` | Stub | `isAssistantMode()` and `initializeAssistantTeam()` |
| Session discovery | `src/assistant/sessionDiscovery.ts` | Stub | Discover available bridge sessions |
| Session history | `src/assistant/sessionHistory.ts` | Stub | Persist session history |
| Gate control | `src/assistant/gate.ts` | Stub | GrowthBook gate checks |
| Session chooser | `src/assistant/AssistantSessionChooser.ts` | Stub | Session-selection UI |
| BriefTool | `src/tools/BriefTool/` | Stub | Structured-message output tool |
| Channel Notification | `src/services/mcp/channelNotification.ts` | Stub | External channel message ingestion |
| Dream Task | `src/components/tasks/src/tasks/DreamTask/` | Stub | Memory-distillation task |
| Memory Directory | `src/memdir/memdir.ts` | Stub | Memory-directory management |

### 3.2 Pacing control (shared with Proactive)

Historically, KAIROS/Proactive used a dedicated `Sleep` tool for pacing. That tool has been removed: in a non-proactive session, it always returned `interrupted: true` immediately ("Sleep interrupted after 0s"), and the tick scheduler already wakes the model again.

The current model is:
- Nothing to do → end the turn immediately and wait for the next tick
- A check is required at a specific time → start the `Monitor` `wait_seconds` timer in the background, end the turn, and let the task notification wake the model when the timer completes
- A *condition* must become true → run an until loop through the `Monitor` command mode
- Remote-control surfaces can observe `standby` through `automation_state`; `sleeping` is a legacy value retained only for older-client compatibility and is no longer emitted

### 3.3 Remote access

KAIROS uses occ's native Remote Control bridge. `useReplBridge` synchronizes the current REPL with the official endpoint or a self-hosted RCS; it does not start a separate ACP session.

```
Browser / Remote Control client
      │
      ▼ WebSocket / SSE + HTTP
┌──────────────────────┐
│ Remote Control Server│  Official endpoint or self-hosted RCS
└──────────┬───────────┘
           │ Native bridge protocol
           ▼
┌──────────────────────┐
│  REPL + Proactive    │  Tick-driven autonomous work
│  Tick Loop           │
└──────────────────────┘
```

KAIROS's local capabilities—tick scheduling, structured Brief output, and terminal-focus awareness—do not depend on any remote transport and remain fully available on a single machine.

## 4. Key design decisions

1. **Tick-driven rather than event-driven**: The tick scheduler wakes the model, which may start a Monitor timer when it needs a wake-up at a specific time, rather than relying on external event pushes. This simplifies the architecture but increases API-call overhead.
2. **KAIROS ⊃ PROACTIVE**: Every proactive check includes KAIROS, so both flags do not need to be enabled.
3. **Separate Brief display from behavior**: The `/brief` toggle controls only UI filtering; the model can always use BriefTool.
4. **Terminal Focus awareness**: The model automatically adjusts its level of autonomy based on whether the user is viewing the terminal.
5. **GrowthBook gating**: Some features require a server-side GrowthBook switch even when their feature flag is enabled.

## 5. Usage

```bash
# Minimal enablement (resident assistant + Brief)
FEATURE_KAIROS=1 FEATURE_KAIROS_BRIEF=1 bun run dev

# Enable all features
FEATURE_KAIROS=1 \
FEATURE_KAIROS_BRIEF=1 \
FEATURE_KAIROS_CHANNELS=1 \
FEATURE_KAIROS_PUSH_NOTIFICATION=1 \
FEATURE_KAIROS_GITHUB_WEBHOOKS=1 \
FEATURE_PROACTIVE=1 \
bun run dev

# Use with Token Budget
FEATURE_KAIROS=1 FEATURE_TOKEN_BUDGET=1 bun run dev
```

## 6. External dependencies

- **Anthropic OAuth**: Requires a claude.ai subscription login, not an API key
- **GrowthBook**: Server-side feature gating
- **Remote access** (optional): the native bridge; run `packages/remote-control-server/` when self-hosting

## 7. File index

| File | Lines | Responsibility |
|------|------|------|
| `src/assistant/index.ts` | 9 | Assistant module entry point (stub) |
| `src/assistant/gate.ts` | — | GrowthBook gating (stub) |
| `src/assistant/sessionDiscovery.ts` | — | Session discovery (stub) |
| `src/assistant/sessionHistory.ts` | — | Session history (stub) |
| `src/assistant/AssistantSessionChooser.ts` | — | Session-selection UI (stub) |
| `src/tools/BriefTool/` | — | BriefTool implementation (stub) |
| `packages/builtin-tools/src/tools/MonitorTool/MonitorTool.tsx` | ~230 | Monitor tool, including the `wait_seconds` timer mode |
| `src/services/mcp/channelNotification.ts` | 5 | Channel-message ingestion (stub) |
| `src/memdir/memdir.ts` | — | Memory-directory management (stub) |
| `src/constants/prompts.ts:557,847-918` | 72 | System-prompt injection |
| `src/components/tasks/src/tasks/DreamTask/` | 3 | Dream task (stub) |
| `src/proactive/index.ts` | — | Proactive core shared by KAIROS |
| `src/utils/sessionState.ts` | — | Exposes automation state to bridge/CCR |
