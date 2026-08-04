<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/coordinator-mode) · [日本語](/docs/ja/features/coordinator-mode)

# COORDINATOR_MODE — Multi-Agent Orchestration

> Feature Flag: `FEATURE_COORDINATOR_MODE=1` + environment variable `CLAUDE_CODE_COORDINATOR_MODE=1`
> Implementation status: the coordinator is fully functional; worker agents use the general-purpose AgentTool worker
> References: 32

## I. Feature Overview

COORDINATOR_MODE turns the CLI into a coordinator. The coordinator does not manipulate files directly; it delegates tasks through AgentTool to multiple workers that execute in parallel. This mode is appropriate for decomposing large tasks, conducting parallel research, and separating implementation from verification.

### Core Constraints

- The coordinator may use only `Agent` (dispatch a worker), `SendMessage` (continue a worker), and `TaskStop` (stop a worker)
- Workers may use all standard tools (Bash, Read, Edit, etc.), MCP tools, and Skill tools
- Every coordinator message is visible to the user; worker results arrive as `<task-notification>` XML

## II. User Interaction

### Enabling the Mode

```bash
FEATURE_COORDINATOR_MODE=1 CLAUDE_CODE_COORDINATOR_MODE=1 bun run dev
```

Both the feature flag and the environment variable must be set. `CLAUDE_CODE_COORDINATOR_MODE` can switch automatically when a session is resumed (`matchSessionMode`).

### Typical Workflow

```
User: "Fix the null pointer in the auth module"

Coordinator:
  1. Dispatch two workers in parallel:
     - Agent({ description: "Investigate auth bug", prompt: "..." })
     - Agent({ description: "Study auth tests", prompt: "..." })

  2. Receive <task-notification>:
     - Worker A: "Found a null pointer at validate.ts:42"
     - Worker B: "Test coverage..."

  3. Synthesize the findings and continue Worker A:
     - SendMessage({ to: "agent-a1b", message: "Fix validate.ts:42..." })

  4. Receive the fix, then dispatch verification:
     - Agent({ description: "Verify the fix", prompt: "..." })
```

## III. Implementation Architecture

### 3.1 Mode Detection

File: `src/coordinator/coordinatorMode.ts:36-41`

```ts
export function isCoordinatorMode(): boolean {
  return feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
}
```

### 3.2 Restoring the Session Mode

When an existing session is resumed, `matchSessionMode(sessionMode)` checks its stored mode. If the current environment variable does not match the stored mode, it flips the environment variable automatically. This prevents a coordinator session from being resumed in normal mode, or vice versa.

### 3.3 Worker Tool Set

`getCoordinatorUserContext()` tells the coordinator which tools workers can use:

- **Standard mode**: `ASYNC_AGENT_ALLOWED_TOOLS`, excluding internal tools (TeamCreate, TeamDelete, SendMessage, SyntheticOutput)
- **Simple mode** (`CLAUDE_CODE_SIMPLE=1`): Bash, Read, and Edit only
- **MCP tools**: names of connected MCP servers
- **Scratchpad**: if GrowthBook `tengu_scratch` is enabled, a scratchpad directory shared across workers

### 3.4 System Prompt

File: `src/coordinator/coordinatorMode.ts:111-369`

The coordinator system prompt (`getCoordinatorSystemPrompt()`) is approximately 370 lines and contains:

| Section | Content |
|------|------|
| 1. Your Role | Defines the coordinator's responsibilities |
| 2. Your Tools | Explains how to use Agent/SendMessage/TaskStop |
| 3. Workers | Describes worker capabilities and constraints |
| 4. Task Workflow | Research → Synthesis → Implementation → Verification workflow |
| 5. Writing Worker Prompts | Guidance for writing self-contained prompts, with good and bad examples |
| 6. Example Session | Complete example conversation |

### 3.5 Worker Agent

File: `src/coordinator/workerAgent.ts`

This file is currently a stub. Workers use the general-purpose AgentTool `worker` subagent_type in practice.

### 3.6 Data Flow

```
User message
      │
      ▼
Coordinator REPL (restricted tool set)
      │
      ├──→ Agent({ subagent_type: "worker", prompt: "..." })
      │         │
      │         ▼
      │    Worker Agent (full tool set)
      │    ├── Execute task (Bash/Read/Edit/...)
      │    └── Return <task-notification>
      │
      ├──→ SendMessage({ to: "agent-id", message: "..." })
      │         │
      │         ▼
      │    Continue an existing Worker
      │
      └──→ TaskStop({ task_id: "agent-id" })
                │
                ▼
           Stop a running Worker
```

## IV. Key Design Decisions

1. **Two-gate design**: the feature flag controls whether the code is available, while the environment variable controls actual activation. This allows builds to include the feature without enabling it by default
2. **Restricted coordinator**: the coordinator can use only Agent/SendMessage/TaskStop, keeping it focused on delegation rather than execution
3. **Workers cannot see the coordinator conversation**: every worker prompt must be self-contained and include all required context
4. **Parallelism first**: the system prompt states that "Parallelism is your superpower" and encourages independent tasks to be dispatched concurrently
5. **Synthesize instead of forwarding**: the coordinator must understand worker findings and then write concrete implementation instructions. Lazy delegation such as "based on your findings" is prohibited
6. **Optional shared scratchpad**: a GrowthBook-gated shared directory lets workers persist and share knowledge

## V. Usage

```bash
# Basic enablement
FEATURE_COORDINATOR_MODE=1 CLAUDE_CODE_COORDINATOR_MODE=1 bun run dev

# With Fork Subagent
FEATURE_COORDINATOR_MODE=1 FEATURE_FORK_SUBAGENT=1 \
CLAUDE_CODE_COORDINATOR_MODE=1 bun run dev

# Simple mode (workers have only Bash/Read/Edit)
FEATURE_COORDINATOR_MODE=1 CLAUDE_CODE_COORDINATOR_MODE=1 \
CLAUDE_CODE_SIMPLE=1 bun run dev
```

## VI. File Index

| File | Lines | Responsibility |
|------|------|------|
| `src/coordinator/coordinatorMode.ts` | 370 | Mode detection + system prompt + user context |
| `src/coordinator/workerAgent.ts` | — | Worker agent definition (stub) |
| `src/constants/tools.ts` | — | `ASYNC_AGENT_ALLOWED_TOOLS` tool allowlist |
