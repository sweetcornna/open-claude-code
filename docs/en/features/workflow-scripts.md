<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/workflow-scripts) · [日本語](/docs/ja/features/workflow-scripts)

# WORKFLOW_SCRIPTS — Deterministic Multi-Agent Workflow Orchestration

> Feature Flag: `FEATURE_WORKFLOW_SCRIPTS=1`
> Engine package: `@open-claude-code/workflow-engine` (`packages/workflow-engine/`; deterministic JS script orchestration with no runtime dependency on the core layer)
> Integration layer: `src/workflow/`

## 1. Overview

WORKFLOW_SCRIPTS lets Claude Code orchestrate multiple sub-agents with **deterministic JavaScript scripts**. It supports decomposition and parallelism, confidence from multiple perspectives, workloads larger than a single context, resumability, and auditability.

- **Orchestration primitives**: `agent` / `parallel` / `pipeline` / `phase` / `log` / `workflow` (provided by the engine package).
- **Determinism**: scripts run in a restricted sandbox that disables `Date.now()` / `Math.random()` / zero-argument `new Date()`, making journals replayable.
- **Integrated backend**: a single `claude-code` AgentAdapter connects to the current session system (provider / model / agentType / tools); `agent()` calls inside a workflow run real sub-agents.
- **Monitoring panel**: `/workflows` opens a live two-column panel (see §6).
- **Orchestration handbook**: `/ultracode` injects the orchestration methodology (see §7).

> Historical note: the original implementation used a YAML/JSON DSL and fully stubbed components such as `WorkflowDetailDialog`. It has been completely rewritten around the JS engine.

## 2. Implementation architecture

```
   .occ/workflows/<name>.ts           Workflow tool (name/script/scriptPath/args/resumeFromRunId)
            │                                       │
            ▼                                       ▼
   namedWorkflowCommands.ts              src/workflow/wiring.ts (createWorkflowToolCore)
   (/<name> command discovery)                       │
                                                   ▼
                                      WorkflowService (facade: launch/kill/subscribe/listRuns/listNamed)
                                                   │
                                  ┌────────────────┼─────────────────┐
                                  ▼                ▼                 ▼
                          ports.ts            registry.ts        progress/
                       (port aggregate)    (AgentAdapterRegistry)  bus + store
                                  │                │
                                  ▼                ▼
                      hostHandle.ts        backends/claudeCodeBackend.ts
                     (opaque host)         (integrates with session system; runs real agents)
                                  │
                                  ▼
                  @open-claude-code/workflow-engine
                  (runWorkflow / hooks / journal / budget / concurrency semaphore)
```

### 2.1 Module inventory

| Layer | File | Responsibility |
|----|------|------|
| Engine | `packages/workflow-engine/src/` | Deterministic script sandbox + hooks + journal + budget + semaphore; exports `createWorkflowTool` |
| Tool assembly | `src/workflow/wiring.ts` | `createWorkflowToolCore()` — assembles the `Workflow` tool from `WorkflowService.ports` |
| Service facade | `src/workflow/service.ts` | `WorkflowService` singleton: `launch` / `kill` / `subscribe` / `listRuns` / `listNamed` / `getWorkflowService()` |
| Ports | `src/workflow/ports.ts` | `createWorkflowPorts()` aggregates all ports (agentRunner/registry/progress/task/journal/permission/logger/hostFactory) |
| Backend registration | `src/workflow/registry.ts` | `buildRegistry()` registers the `claude-code` backend and makes it the default |
| Integrated backend | `src/workflow/backends/claudeCodeBackend.ts` | AgentAdapter: resolves the session system by `agentType`/`model`, runs real sub-agents, and returns structured output |
| Host handle | `src/workflow/hostHandle.ts` | `buildHostBundle()` wraps `toolUseContext`/`canUseTool`/`parentMessage` opaquely |
| Progress bus | `src/workflow/progress/bus.ts` | Set-based progress event emitter |
| Progress state | `src/workflow/progress/store.ts` | Reducer: correlates `agent_done` precisely by `agentId` to eliminate a concurrency race |
| Monitoring panel | `src/workflow/panel/*.tsx` | `/workflows` two-column UI (see §6) |
| Named commands | `src/workflow/namedWorkflowCommands.ts` | Scans `.occ/workflows/` and generates `/<name>` commands |
| Permission request | `src/workflow/WorkflowPermissionRequest.tsx` | Workflow launch-permission UI |

### 2.2 Registration points

| Location | Registration |
|------|------|
| `packages/builtin-tools/src/registry.ts` | Requires `src/workflow/wiring.js` behind `feature('WORKFLOW_SCRIPTS')` and registers the `Workflow` tool |
| `src/commands.ts` (`workflowsCmd`) | `/workflows` command (local-jsx, loads `panelCall.js`) |
| `src/skills/bundled/ultracode.ts` + `index.ts` | `/ultracode` knowledge skill (`registerBundledSkill`) |

## 3. Orchestration primitives

The following hooks are available inside a workflow script (see the engine package's `engine/hooks.ts` for complete semantics):

| Primitive | Semantics |
|------|------|
| `agent(prompt, opts?)` | Dispatches one sub-agent; returns its final text or, with `opts.schema`, a structured object. opts: `model` / `agentType` / `label` / `phase` / `schema` |
| `parallel([() => …])` | Runs an array of thunks concurrently with a **barrier** that waits for all of them; if one item throws, that item becomes `null` and all other results are retained |
| `pipeline(items, s1, s2, …)` | Passes each item through each stage in sequence; there is **no barrier between items**, while stages remain ordered within each item; if a stage throws for one item, that item becomes `null` |
| `phase(title)` | Marks a phase, which the panel uses for grouping |
| `log(msg)` | Emits a progress log for the panel without changing state |
| `workflow(name \| { scriptPath }, args?)` | Nests one child workflow; only one nesting level is allowed |

**Hard limits**: one `parallel`/`pipeline` call may contain at most `MAX_ITEMS_PER_CALL` (4096) items; one workflow may dispatch at most `MAX_TOTAL_AGENTS` (1000) agents in total; the default concurrency cap is `DEFAULT_MAX_CONCURRENCY` (3), the Workflow tool's `maxConcurrency` input may override it, and the absolute cap is `MAX_CONCURRENCY_CAP` (16).

## 4. Writing a workflow

Place scripts in `.occ/workflows/<name>.js|.mjs` (`.ts` is also accepted, but the **engine does not transpile TypeScript**, so type annotations cause syntax errors; prefer `.js`/`.mjs`). Each script automatically becomes a `/<name>` command.

```js
// .occ/workflows/review-changes.js
export const meta = {
  name: 'review-changes',
  description: 'Review changes by dimension, then verify adversarially',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: 'Find correctness bugs' },
  { key: 'perf', prompt: 'Find performance problems' },
]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review' }),
  review => parallel(
    (review.findings || []).map(f => () =>
      agent(`Verify adversarially: ${f.title}`, { phase: 'Verify' })
    )
  )
)
return results.flat().filter(Boolean)
```

**Script-execution constraints** (the engine reports an error immediately when a script violates one):

The script is the **function body** of `new AsyncFunction`, not an ESM module:

- **No `import`**: `agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow` and `args`/`budget` are injected parameters; use them directly.
- **No TypeScript syntax**: do not use type annotations (`x: number`), `interface`, `enum`, `as`, or generics. The engine does not transpile the source and reports the syntax error unchanged even for a `.ts` file.
- **Allow exactly one `export const meta = {...}`** (the engine extracts and removes it with a regular expression); do not use any other `export` or `export default`.
- **Use a top-level `return` for the result**.

**Determinism constraints** (violations make resume unavailable):
- Do not use `Date.now()` / `Math.random()` / zero-argument `new Date()`; the sandbox throws on these calls. Pass timestamps and random seeds through `args` instead.
- `export const meta = { ... }` must be a **pure literal** with no variables, function calls, or template interpolation. Otherwise load-time evaluation throws `ScriptError`.

## 5. The Workflow tool

The model launches workflows through the `Workflow` tool (see the engine package's `tool/schema.ts` for the input schema):

| Field | Description |
|------|------|
| `script` | Inline script string |
| `name` | Named workflow, corresponding to `.occ/workflows/<name>` |
| `scriptPath` | Script file path |
| `args` | `args` passed through to the script; accepts any JSON value |
| `resumeFromRunId` | Replays an existing runId; successful `agent()` calls return cached results immediately, **failed (dead) entries rerun**, and execution resumes live after the divergence point |
| `maxConcurrency` | Per-run concurrency override, clamped to `[1, 16]` |

## 6. Monitoring panel: `/workflows`

`/workflows` opens a full-screen, three-focus-region panel (local-jsx):

- **Top tabs**: one tab for each run (status dot + workflow name + `#runId short code`); running the same named script multiple times creates multiple tabs.
- **Left phase sidebar**: `All` plus the merged phases declared by meta (unstarted phases appear as gray `○` pending) and observed at runtime (`●` running / `✓` done); the selection controls the right-column filter.
- **Right agent list**: first filters by the selected phase, then by status (`f` cycles all → running → done → failed; when the filter is not all, the title adds `· <filter> only`). Each row contains a status-colored marker + label (28 characters wide, preserving the `#N` suffix) + `model · Nk tok` + a right-aligned duration. Model names are shortened (`us.anthropic.claude-sonnet-5-20260101` → `sonnet-5`). **Per-row tool-call counts moved into agent details** because the label benefits more from the available width.
- **Right agent details**: pressing `↵` or `→` in the agent list replaces the entire right column with the selected agent's status view: status / phase / model / elapsed / context tok / output tok / tool calls. A failure also shows the **failure reason** (engine reasons such as `no-structured-output`, `prompt-too-long`, and `api-error` rendered in plain language), a `retryable:false` warning that a deterministic failure will recur if the same call is rerun, and the engine detail. A success shows a result preview (object or text, truncated by the store to 400 characters). Within details, `↑`/`↓` moves directly to the previous or next agent without returning to the list.

**Keys**: `Tab`/`Shift+Tab` switch runs · `←`/`→` move among phases → agents → agent details · `↵` opens details for the selected agent · `↑`/`↓` move within a region · `f` changes the status filter · `r` resumes · `x` kills the selected agent · `K` kills the entire workflow · `n` opens the new-workflow prompt · `q`/`Esc` exits.

> `←` moves **back exactly one level** (details → list → phase sidebar), stops at the phase sidebar, and never closes the panel; closing is the responsibility of `Esc`/`q`. Changing the filter with `f` resets the selected item to row 0 because a different set of rows remains visible. Reusing the old index could silently retarget `x` to another agent.

**Visual design**: no inner border; one vertical separator between left and right; the focused column heading is bold orange; the selected/cursor row has an orange background (`backgroundColor`) while preserving the text color.

Progress correlates `agent_done` precisely by the engine's `agentId`, eliminating a concurrent LIFO race. Pending phases come from `meta.phases` carried by the `run_started` event; the store persists them as `declaredPhases`, and the panel's `mergePhases` merges them. `useSyncExternalStore` subscribes to `WorkflowService` with stable snapshots, so unchanged state does not rerender.

### Workflow details in the background-task UI

In the `/tasks` (Shift+↓) background-task list, selecting a workflow opens `WorkflowDetailDialog` (`src/components/tasks/WorkflowDetailDialog.tsx`). It provides a live single-column view backed by the same `ProgressStore` as the panel: status header + phase rows (`○/●/✓` + done/total) + per-agent rows (spinner/`✓`/`✗`/`⊘` + label + `model · tok · tool`, reusing the panel's `AgentList`). The agent list uses a sliding window around the selection (`MAX_VISIBLE_AGENTS=10`), with collapsed rows showing `… N earlier/more`.

Pressing `↵`/`→` likewise drills into details for the selected agent, reusing the `/workflows` panel's `AgentDetail`. Both interfaces render the same run, so their navigation gestures must not conflict.

**Keys**: `↑`/`↓` select an agent · `↵`/`→` open agent details · `x` kills the selected agent (through configurable `taskDetail:kill`) · `K` kills the entire workflow · both require `y`/`n` confirmation · `←` moves back one level (details → list → close dialog) · `Esc` closes immediately. The data/key projection layer is in `workflowDetailData.ts`; it has no React dependency and is unit-testable.

## 7. The `/ultracode` skill

`/ultracode` (`src/skills/bundled/ultracode.ts`) injects the multi-agent workflow orchestration methodology: when to use it and when not to, an orchestration-primitive reference, a quality-pattern library (adversarial-verify / judge-panel / loop-until-dry / multi-modal-sweep / completeness-critic), determinism constraints, backend routing, resume/budget behavior, and files and commands.

It is a **pure knowledge prompt skill** with no runtime side effects: it does not modify the main loop or toggle behavior. Invoking it only injects the handbook into the context.

## 8. Resume, journal, budget, and error recovery

- **Journal**: every run records `.occ/workflow-runs/<runId>/journal.jsonl`. `resumeFromRunId` replays the journal: successful results return from cache immediately, while **dead entries are recorded failures and rerun live during replay**. Checkpoint continuation exists to retry failures, not to replay them as failures. The rerun appends a result with the same `seq`; `read()` deduplicates by seq and **keeps the final entry**, so the new result replaces the old failure.
- **Journal corruption handling**: the reader parses line by line and retains the validated prefix. It ignores and warns only about a partial line that is **at the end of the file and lacks a trailing newline**, as left by a killed process. A corrupt or structurally invalid interior line throws `JournalCorruptionError` rather than silently treating the run as having no history: doing so would discard every checkpoint, rerun all work, incur duplicate charges, and repeat external side effects. I/O errors other than `ENOENT` propagate normally.
- **Journal divergence and `script.js`**: when agent keys diverge, the engine first rewrites the valid prefix to disk atomically, then appends new records. `truncate()` **clears only `journal.jsonl`** and preserves an inline `script.js` in the same directory, which is required for the inline → edit → `scriptPath` resume path. `deleteRun()` separately removes the entire directory.
- **`resumeFromRunId` format constraint**: only `^[A-Za-z0-9_-]{1,128}$` is accepted, with validation in both the schema and storage layers. This value becomes a path segment under the runs directory, and `deleteRun()` recursively removes that directory; without validation, "resume workflow" would become an arbitrary-directory deletion primitive.
- **In-place agent retry**: the engine retries a dead result or non-abort exception once after waiting `AGENT_RETRY_BACKOFF_MS` (2s; abort can interrupt the wait). **Deterministic failures with `retryable:false`, such as `prompt-too-long`, do not retry** because resending the same call must fail again.
- **Automatic run-level checkpoint continuation**: when script execution fails, commonly because a dead agent's `null` causes a TypeError in the script, the engine **automatically retries once by resuming from the journal**. Successful agents return immediately and only failed agents rerun. `WorkflowError` (deterministic configuration/limit failures) and `BudgetExhaustedError` (a new context would reset spent and permit overspending) do not trigger this behavior; `autoRetryOnFailure:false` disables it.
- **API error classification** (`claudeCodeBackend`): the query layer wraps terminal API errors as assistant messages satisfying `isApiErrorMessage` rather than throwing. The backend recognizes them explicitly and marks the agent `dead` with `reason: 'prompt-too-long'` (`retryable:false`) or `'api-error'` (transient and retryable). Before this fix, non-schema mode could misrepresent the error text as normal agent output. The API layer itself retries 529 overloads with exponential backoff; `'workflow'` is included in `FOREGROUND_529_RETRY_SOURCES`.
- **Budget**: `budget.total` is a hard token ceiling (`null` by default means unlimited); `budget.spent()` / `budget.remaining()` report live consumption; calling `agent()` after exhaustion throws.
- **Concurrency**: the engine `Semaphore` grants 3 permits by default (`DEFAULT_MAX_CONCURRENCY`). The Workflow tool's `maxConcurrency` input may override the value per run, clamped to `[1, MAX_CONCURRENCY_CAP=16]`.
- **Errors**: script syntax/meta errors make `parseScript` return an error immediately, before background execution. An agent exception becomes `kind:'dead'` → `null`, and the workflow continues because `parallel`/`pipeline` tolerate failures; **`WorkflowAbortedError` propagates**, because kill must terminate the run. `WorkflowAbortedError` produces `killed`.

## 9. File index

| File | Responsibility |
|------|------|
| `src/workflow/wiring.ts` | `Workflow` tool assembly (`createWorkflowToolCore`) |
| `src/workflow/service.ts` | `WorkflowService` facade |
| `src/workflow/ports.ts` | Port aggregation (`createWorkflowPorts`) |
| `src/workflow/registry.ts` | `AgentAdapterRegistry` + default backend |
| `src/workflow/backends/claudeCodeBackend.ts` | Integrated-backend AgentAdapter |
| `src/workflow/hostHandle.ts` | Opaque host handle (`buildHostBundle`) |
| `src/workflow/progress/bus.ts` | Progress event bus |
| `src/workflow/progress/store.ts` | Progress reducer (`agentId` correlation) |
| `src/workflow/panel/*.tsx` | `/workflows` two-column panel |
| `src/workflow/namedWorkflowCommands.ts` | `/<name>` command discovery |
| `src/workflow/WorkflowPermissionRequest.tsx` | Launch-permission UI |
| `src/components/tasks/WorkflowDetailDialog.tsx` | Workflow details in the background-task UI (live per-agent status + kill interaction) |
| `src/components/tasks/workflowDetailData.ts` | Detail-dialog window/key projection layer (React-free) |
| `src/skills/bundled/ultracode.ts` | `/ultracode` knowledge skill |
| `packages/builtin-tools/src/registry.ts` | Tool registration (feature-gated require) |
| `src/commands.ts` | `/workflows` command registration |
| `packages/workflow-engine/` | Engine package (hooks / journal / budget / concurrency) |
