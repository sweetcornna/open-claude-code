# @open-claude-code/workflow-engine

Deterministic JS script orchestration engine for multi-agent workflows. The core layer has zero runtime dependencies and talks to the outside world exclusively through **port adapters** — you bring your own agent backend, journal store, and progress sink.

## Why

When you orchestrate multiple LLM agents, you want the orchestration itself to be **deterministic, replayable, and testable**. This engine executes a plain JavaScript function body with `AsyncFunction` and injects primitives such as `agent()`, `phase()`, `parallel()`, and `pipeline()`. It does not transpile TypeScript and does not support imports. Named workflows may use `.js`, `.mjs`, or `.ts` extensions, but their contents must use JavaScript syntax; prefer `.js` or `.mjs`. The non-deterministic parts (the LLM, the file system, and the clock) are isolated behind ports.

## Installation

```bash
bun add @open-claude-code/workflow-engine
# or
npm install @open-claude-code/workflow-engine
```

Runtime peer requirements: `ajv` and `zod` are pulled in automatically as dependencies.

## Minimal example

```ts
import { join } from 'node:path'
import {
  createFileJournalStore,
  createHostHandle,
  runWorkflow,
  WORKFLOW_RUNS_DIR,
  type WorkflowPorts,
} from '@open-claude-code/workflow-engine'

const script = `
export const meta = { name: 'hello', description: 'minimal demo' }
phase('Greet')
const reply = await agent('Say hi in one short sentence.', { label: 'greeting' })
log('Greeting complete')
return { reply }
`

const host = createHostHandle(null)
const ports: WorkflowPorts = {
  agentRunner: {
    async runAgentToResult({ prompt }) {
      return { kind: 'ok', output: `Agent received: ${prompt}`, usage: { outputTokens: 4 } }
    },
  },
  journalStore: createFileJournalStore(join(process.cwd(), WORKFLOW_RUNS_DIR)),
  progressEmitter: { emit: event => console.log(event) },
  taskRegistrar: {
    register: () => ({ runId: 'hello', signal: new AbortController().signal }),
    complete() {},
    fail() {},
    kill() {},
    pendingAction: () => null,
  },
  permissionGate: { isAborted: () => false },
  logger: { debug() {}, event() {} },
  hostFactory: () => ({ handle: host, cwd: process.cwd(), budgetTotal: null }),
}

const result = await runWorkflow({
  script,
  runId: 'hello',
  ports,
  host,
  signal: new AbortController().signal,
  cwd: process.cwd(),
  budgetTotal: null,
})
```

For a fully wired end-to-end example with the Anthropic SDK, see [`examples/smoke.ts`](./examples/smoke.ts).

## Core primitives

- `agent(prompt, options?)` — call the configured agent runner; `options.schema` enables structured output.
- `phase(name)` — declare a logical phase for progress grouping.
- `parallel([thunk, ...])` — run async thunks with bounded agent concurrency and wait for all results.
- `pipeline(items, ...stages)` — process each item through async stages.
- `workflow(nameOrRef, args?)` — run one named or path-referenced sub-workflow.
- `log(message)` — emit a workflow log event.
- `args` and `budget` — access invocation arguments and the run's token budget.

Named workflows resolve from `.occ/workflows` by default, and inline run scripts persist under `.occ/workflow-runs`. Direct consumers can override these paths with `workflowDir` and `workflowRunsDir` when creating the Workflow tool.

## Building from source

```bash
bun install            # from the repo root
bun run build          # outputs dist/index.js + dist/**/*.d.ts
bun test               # 178 tests
```

## License

MIT © open-claude-code
