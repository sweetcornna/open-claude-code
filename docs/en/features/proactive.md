<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/proactive) · [日本語](/docs/ja/features/proactive)

# PROACTIVE — Proactive Mode

> Feature Flag: `FEATURE_PROACTIVE=1` (shares functionality with `FEATURE_KAIROS=1`)
> Implementation status: The core loop is implemented; some peripheral documentation remains incomplete
> References: 37

## 1. Feature overview

PROACTIVE implements a tick-driven autonomous agent. The CLI can continue working without user input: it wakes on a schedule to perform tasks, with pacing controlled by the tick scheduler. This mode is suitable for long-running background tasks such as waiting for CI, monitoring file changes, and performing scheduled checks.

### Relationship to KAIROS

Every code check uses `feature('PROACTIVE') || feature('KAIROS')`. Therefore:
- Enabling only `FEATURE_PROACTIVE=1` provides proactive capabilities.
- Enabling only `FEATURE_KAIROS=1` automatically provides proactive capabilities.
- Enabling both has the same effect; capabilities are not duplicated.

## 2. Implementation architecture

### 2.1 Module status

| Module | File | Status | Description |
|------|------|------|------|
| Core logic | `src/proactive/index.ts` | **Implemented** | `activateProactive()`, `deactivateProactive()`, `pause/resume`, and `nextTickAt` scheduling state |
| Command registration | `src/commands.ts:62-65` | **Wired** | Dynamically loads `./commands/proactive.js` |
| REPL integration | `src/screens/REPL.tsx` | **Implemented** | Tick driving, standby state, footer, and bridge automation metadata reporting |
| System prompt | `src/constants/prompts.ts:864-918` | **Complete** | Autonomous-work behavior instructions (~55 lines of detailed prompt text) |
| Remote-control state mirror | `src/utils/sessionState.ts` | **Implemented** | Exposes `automation_state` metadata to remote-control/CCR |

### 2.2 System prompt contents

The autonomous-work instructions injected by `getProactiveSection()` include:

| Section | Contents |
|------|------|
| Tick driving | The `<tick_tag>` prompt keeps the session alive and includes the user's local time |
| Pacing control | The tick scheduler controls wake intervals. For a wake-up at a specific time, use the `Monitor` `wait_seconds` timer. The prompt cache expires after 5 minutes |
| No-op rule | When there is nothing to do, **end the turn immediately** without producing output; do not output "still waiting" |
| First wake-up | Provide a brief greeting, then wait for direction without exploring proactively |
| Subsequent wake-ups | Look for useful work to investigate, validate, or inspect without spamming the user |
| Bias toward action | Read files, search code, and commit without asking |
| Terminal focus | The `terminalFocus` field adjusts the level of autonomy |

### 2.3 Data flow

```
activateProactive()
      │
      ▼
Tick scheduler starts
      │
      ├── Periodically generates <tick_tag> messages
      │   ├── Includes the user's current local time
      │   └── Injects them into the conversation stream (sessionStorage)
      │
      ▼
Model processes the tick
      │
      ├── Work is available → use tools to perform it → end turn
      ├── Timed wake-up required → start Monitor(wait_seconds) background timer → end turn
      └── Nothing to do → end turn immediately (no output)
      │
      ▼
Wait for the next wake-up
      │
      ├── Next tick arrives
      ├── Monitor timer completes → task notification wakes the model
      └── User inserts new work / command is present in the queue → wake immediately
```

## 3. Additional current behavior

- `standby`: Proactive mode is enabled, no turn is currently executing, and the next tick is scheduled.
- `sleeping`: **Legacy value**. Since removal of the Sleep tool, no code emits this state. The protocol retains it only for compatibility with older remote-control clients.
- remote-control/CCR receives the state through `external_metadata.automation_state` for the Autopilot state shown in the web UI.
- To "wait N seconds and check again," use the `Monitor` `wait_seconds` mode. It runs a timer in the background, the model ends the turn immediately, and a task notification wakes it when the timer completes. Never block with a foreground `Bash(sleep ...)` call.

## 4. Key design decisions

1. **Tick-driven operation**: The tick scheduler wakes the model rather than relying on external event pushes. The model starts a Monitor timer when it requires a wake-up at a specific time.
2. **End no-op turns immediately**: This prevents empty messages such as "still waiting" from consuming turns and tokens.
3. **Prompt-cache considerations**: The cache expires after 5 minutes, which constrains the choice of wait interval.
4. **Terminal Focus awareness**: The model adjusts its level of autonomy based on whether the user is viewing the terminal.

## 5. Usage

```bash
# Enable proactive mode independently
FEATURE_PROACTIVE=1 bun run dev

# Enable it indirectly through KAIROS
FEATURE_KAIROS=1 bun run dev

# Combine the features
FEATURE_PROACTIVE=1 FEATURE_KAIROS=1 FEATURE_KAIROS_BRIEF=1 bun run dev
```

## 6. File index

| File | Responsibility |
|------|------|
| `src/proactive/index.ts` | Core logic and next-tick state |
| `packages/builtin-tools/src/tools/MonitorTool/MonitorTool.tsx` | Monitor tool, including the `wait_seconds` timer mode |
| `src/constants/prompts.ts:864-918` | Autonomous-work system prompt |
| `src/screens/REPL.tsx` | REPL tick integration and automation-state reporting |
| `src/utils/sessionStorage.ts:4892-4912` | Tick-message injection |
| `src/utils/sessionState.ts` | bridge/CCR metadata mirror |
| `src/components/PromptInput/PromptInputFooterLeftSide.tsx` | Footer UI state |
