<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/fork-subagent) · [日本語](/docs/ja/features/fork-subagent)

# FORK_SUBAGENT — Context-Inheriting Sub-Agents

> Feature Flag: `FEATURE_FORK_SUBAGENT=1`
> Implementation status: fully functional
> References: 4

## I. Feature Overview

FORK_SUBAGENT lets AgentTool create a "fork sub-agent" that inherits the parent's complete conversation context. The sub-agent sees all parent history, tools, and the system prompt. It also shares the parent's API request prefix to maximize prompt-cache hits.

### Core Advantages

- **Maximum Prompt Cache Reuse**: parallel forks share the same API request prefix; only the final directive text block differs
- **Complete Context**: the sub-agent inherits the parent's complete conversation history, including the thinking config
- **Permission Bubbling**: the sub-agent's permission prompts surface in the parent terminal
- **Worktree Isolation**: git worktree isolation lets the sub-agent work on an independent branch

## II. User Interaction

### Trigger

When `FORK_SUBAGENT` is enabled, an AgentTool call automatically takes the fork path if it does not specify `subagent_type`:

```
// Fork path (inherits context)
Agent({ prompt: "Fix this bug" })  // no subagent_type

// Normal agent path (fresh context)
Agent({ subagent_type: "general-purpose", prompt: "..." })
```

### About the `/fork` Command

This repository has **no** `/fork` slash command for creating a fork sub-agent. Only an AgentTool call without `subagent_type` can trigger the fork path. `fork` is now an unconditional alias of the `/branch` command for session branching; see `aliases: ['fork']` at `src/commands/branch/index.ts:6`. It is not controlled by the `FORK_SUBAGENT` flag.

## III. Implementation Architecture

### 3.1 Gating and Mutual Exclusion

File: `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts:32-39`

```ts
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false   // Coordinator uses its own delegation model
    if (getIsNonInteractiveSession()) return false  // disabled in pipe/SDK mode
    return true
  }
  return false
}
```

### 3.2 FORK_AGENT Definition

```ts
export const FORK_AGENT = {
  agentType: 'fork',
  tools: ['*'],              // wildcard: use the parent's complete tool set
  maxTurns: 200,
  model: 'inherit',          // inherit the parent model
  permissionMode: 'bubble',  // bubble permissions to the parent terminal
  getSystemPrompt: () => '', // unused: pass the parent's rendered prompt directly
}
```

### 3.3 Core Call Flow

```
AgentTool.call({ prompt, name })
      │
      ▼
isForkSubagentEnabled() && !subagent_type?
      │
      ├── No → Normal agent path
      │
      └── Yes → Fork path
            │
            ▼
      Recursion guard
      ├── querySource === 'agent:builtin:fork' → Reject
      └── isInForkChild(messages) → Reject
            │
            ▼
      Obtain the parent system prompt
      ├── toolUseContext.renderedSystemPrompt (preferred)
      └── buildEffectiveSystemPrompt (fallback)
            │
            ▼
      buildForkedMessages(prompt, assistantMessage)
      ├── Clone the parent assistant message
      ├── Generate placeholder tool_result
      └── Append directive text block
            │
            ▼
      [optional] buildWorktreeNotice()
            │
            ▼
      runAgent({
        useExactTools: true,
        override.systemPrompt: parent,
        forkContextMessages: parent messages,
        availableTools: parent tools,
      })
```

### 3.4 Message Construction: buildForkedMessages

File: `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts:107-169`

The constructed message sequence is:

```
[
  ...history (filterIncompleteToolCalls),  // complete parent history
  assistant(all tool_use blocks),          // parent assistant message for the current turn
  user(
    placeholder tool_result × N +          // identical placeholder text
    <fork-boilerplate> directive           // different for each fork
  )
]
```

**Every fork uses the same placeholder text**: `"Fork started — processing in background"`. This makes the API request prefixes for parallel forks identical and maximizes prompt-cache hits.

### 3.5 Recursion Guard

Two checks prevent nested forks:

1. **querySource check**: `toolUseContext.options.querySource === 'agent:builtin:fork'`. It is stored on `context.options`, so it survives autocompaction, which rewrites only messages and not options
2. **Message scan**: `isInForkChild()` scans message history for the `<fork-boilerplate>` tag

### 3.6 Worktree Isolation Notice

When fork mode and worktree isolation are combined, the child receives this additional notice:

> "You inherited the parent agent's conversation context from `{parentCwd}`, but you are operating in the separate git worktree `{worktreeCwd}`. Convert paths and reread files before editing."

### 3.7 Forced Asynchrony

When `isForkSubagentEnabled()` returns true, all agent launches are forced to run asynchronously. The `run_in_background` parameter is removed from the schema. All interaction uses `<task-notification>` XML messages.

## IV. Prompt Cache Optimization

This is the primary optimization objective of the fork design:

| Optimization | Implementation |
|--------|------|
| **Identical system prompt** | Pass `renderedSystemPrompt` directly to avoid rerendering, because GrowthBook state may differ |
| **Identical tool set** | Set `useExactTools: true` to use the parent's tools directly, bypassing `resolveAgentTools` filtering |
| **Identical thinking config** | Inherit the parent's thinking config; non-fork agents disable thinking by default |
| **Identical placeholder result** | Every fork uses the same `FORK_PLACEHOLDER_RESULT` text |
| **ContentReplacementState clone** | Clone the parent's replacement state by default to keep the wire prefix identical |

## V. Child-Agent Instructions

`buildChildMessage()` generates instructions wrapped in `<fork-boilerplate>`:

- You are a fork worker, not the primary agent
- Do not spawn another sub-agent; execute the task directly
- Do not engage in small talk or meta-commentary
- Use tools directly
- After modifying files, commit the changes and report the commit hash
- Report format: `Scope:` / `Result:` / `Key files:` / `Files changed:` / `Issues:`

## VI. Key Design Decisions

1. **Fork ≠ normal agent**: a fork inherits the complete context, while a normal agent starts from scratch. The presence of `subagent_type` determines which path is selected
2. **Pass renderedSystemPrompt directly**: do not call `getSystemPrompt()` again when forking. The parent freezes the prompt bytes at the start of the turn
3. **Share placeholder results**: parallel forks use exactly the same placeholder, and only the directive differs
4. **Mutually exclusive with Coordinator**: fork mode is disabled in Coordinator mode because the two use incompatible delegation models
5. **Disabled for non-interactive sessions**: disable it in pipe and SDK modes to prevent invisible nested forks

## VII. Usage

```bash
# Enable the feature
FEATURE_FORK_SUBAGENT=1 bun run dev

# Use it in the REPL (omit subagent_type to take the fork path)
# Agent({ prompt: "Study the structure of this module" })
# Agent({ prompt: "Implement this feature" })
```

## VIII. File Index

| File | Lines | Responsibility |
|------|------|------|
| `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts` | ~210 | Core definition + message construction + recursion guard |
| `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` | — | Fork routing + forced asynchrony |
| `packages/builtin-tools/src/tools/AgentTool/prompt.ts` | — | "When to Fork" prompt section |
| `packages/builtin-tools/src/tools/AgentTool/runAgent.ts` | — | useExactTools path |
| `packages/builtin-tools/src/tools/AgentTool/resumeAgent.ts` | — | Fork-agent resumption |
| `src/constants/xml.ts` | — | XML tag constants |
| `src/utils/forkedAgent.ts` | — | CacheSafeParams + ContentReplacementState cloning |
