import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import {
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_CAP,
  WORKFLOW_DIR_NAME,
  WORKFLOW_RUNS_DIR,
  WORKFLOW_TOOL_NAME,
} from '../constants.js'
import { resolveNamedWorkflow } from '../engine/namedWorkflows.js'
import { runWorkflow } from '../engine/runWorkflow.js'
import { parseScript } from '../engine/script.js'
import {
  assertValidRunId,
  containsPath,
  sanitizeWorkflowName,
} from '../engine/paths.js'
import type { WorkflowPorts } from '../ports.js'
import type { WorkflowRunResult } from '../types.js'
import { workflowInputSchema, type WorkflowInput } from './schema.js'
import { persistInlineScript } from './persistInline.js'

/** Self-contained tool descriptor (core wiring wraps it with buildTool). Zero core-layer dependencies. */
export type WorkflowToolDescriptor = {
  name: string
  inputSchema: z.ZodType<WorkflowInput>
  isEnabled: () => boolean
  isReadOnly: (input: WorkflowInput) => boolean
  description: () => Promise<string>
  prompt: () => Promise<string>
  renderToolUseMessage: (input: Partial<WorkflowInput>) => string
  call: (
    input: WorkflowInput,
    context: unknown,
    canUseTool: unknown,
    parentMessage: unknown,
    onProgress?: unknown,
  ) => Promise<{ data: { output: string } }>
  mapToolResultToToolResultBlockParam: (
    data: { output: string },
    toolUseId: string,
  ) => {
    tool_use_id: string
    type: 'tool_result'
    content: Array<{ type: 'text'; text: string }>
  }
}

/**
 * Concurrency tiers offered to the user when the model must ask before changing the value.
 * Derived from the *effective* default so the recommended option is the one the run would
 * get by omitting the input — offering a stale "6 (Recommended)" against a host default of
 * 12 trains the model to interrupt the user for the value it should have used silently.
 */
function concurrencyTiers(effectiveDefault: number): number[] {
  const tiers = [
    Math.max(1, Math.floor(effectiveDefault / 2)),
    effectiveDefault,
    Math.min(MAX_CONCURRENCY_CAP, effectiveDefault * 2),
  ]
  return [...new Set(tiers)].sort((a, b) => a - b)
}

/**
 * Built per descriptor rather than frozen at module load: the effective default can be
 * overridden by the host (OCC_WORKFLOW_MAX_CONCURRENCY), and a prompt quoting the compiled-in
 * constant would describe a run behaviour that no longer exists on this machine.
 */
function buildWorkflowToolPrompt(opts: {
  workflowDir: string
  defaultMaxConcurrency: number
}): string {
  const d = opts.defaultMaxConcurrency
  return `Use the Workflow tool to execute a workflow script that orchestrates multiple subagents deterministically. The script runs in the background; you receive a run_id immediately and are notified on completion.

Provide the script inline via "script", or reference a named workflow via "name" (resolved from ${opts.workflowDir}/), or an existing file via "scriptPath". Pass "args" as a real JSON value (object/array/string), not a stringified string.

Use "resumeFromRunId" to resume a prior run — completed agent() calls replay from the journal instantly.

Concurrency: the effective default is ${d} (hard ceiling ${MAX_CONCURRENCY_CAP}). OMIT maxConcurrency to use it. To set maxConcurrency to ANY other value, you MUST first ask the user via AskUserQuestion — propose ${concurrencyTiers(d).join(' / ')} (or other tiers matching the fan-out width) with ${d} marked "(Recommended)". The ONLY exception: the user has ALREADY specified a concurrency number in this session ("use 12", "maxConcurrency 9") — then honor it without re-asking. Never silently change concurrency just because the workflow fans out; ${d} is the recommended default.

Script execution model (common pitfalls — getting these wrong is the #1 cause of script errors): the script is the body of \`new AsyncFunction\` — NOT an ESM module, and TypeScript is NOT transpiled. Therefore:
- Do NOT use \`import\` — \`agent\`, \`parallel\`, \`pipeline\`, \`phase\`, \`log\`, \`workflow\`, \`args\`, and \`budget\` are injected as parameters; reference them directly.
- Do NOT use TS type annotations, \`interface\`, \`enum\`, \`as\`, or generics — the engine does not transpile, so even a .ts file with type syntax fails to parse.
- Keep EXACTLY ONE \`export const meta = {...}\` (plain literal) and remove every other \`export\` / \`export default\`.
- Return the result with a top-level \`return\`.
Prefer .js / .mjs. See /ultracode for the full playbook and quality patterns.`
}

export type WorkflowToolOptions = {
  workflowDir?: string
  workflowRunsDir?: string
  /**
   * Default concurrency when the caller omits maxConcurrency (undefined → DEFAULT_MAX_CONCURRENCY;
   * still clamped by MAX_CONCURRENCY_CAP downstream). The host resolves it from
   * OCC_WORKFLOW_MAX_CONCURRENCY and passes it in — this package reads no process.env.
   */
  defaultMaxConcurrency?: number
}

export function createWorkflowTool(
  ports: WorkflowPorts,
  options: WorkflowToolOptions = {},
): WorkflowToolDescriptor {
  return {
    name: WORKFLOW_TOOL_NAME,
    inputSchema: workflowInputSchema,
    // No per-session runtime opt-in gate here: the "ultracode is on for the
    // session" signal is injected by the harness (claude.ai/client), not held
    // in any repo state. This tool is compiled in/out via feature('WORKFLOW_SCRIPTS')
    // in src/tools.ts; beyond that it is always enabled when present.
    isEnabled: () => true,
    isReadOnly: () => false,

    async description() {
      return 'Execute a workflow script that orchestrates multiple subagents to complete a task'
    },

    async prompt() {
      return buildWorkflowToolPrompt({
        workflowDir: options.workflowDir ?? WORKFLOW_DIR_NAME,
        defaultMaxConcurrency:
          options.defaultMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      })
    },

    renderToolUseMessage(input) {
      if (input.resumeFromRunId)
        return `Workflow resume: ${input.resumeFromRunId}`
      const id =
        input.name ?? input.scriptPath ?? (input.script ? 'inline' : 'unknown')
      return `Workflow: ${id}`
    },

    async call(input, context, canUseTool, parentMessage) {
      const host = ports.hostFactory({ context, canUseTool, parentMessage })

      // Resolve the script source
      let script: string
      let workflowFile: string | undefined
      try {
        const resolved = await resolveScriptSource(
          input,
          host.cwd,
          options.workflowDir ?? WORKFLOW_DIR_NAME,
        )
        script = resolved.script
        workflowFile = resolved.workflowFile
      } catch (e) {
        return { data: { output: `Error: ${(e as Error).message}` } }
      }

      // Quick validation (meta + syntax): on failure return an error to the model directly, do not enter the background
      try {
        parseScript(script)
      } catch (e) {
        return {
          data: {
            output: `Error: script validation failed: ${(e as Error).message}`,
          },
        }
      }

      const workflowName = input.name ?? input.title ?? 'workflow'
      const { runId, signal } = ports.taskRegistrar.register(
        {
          workflowName,
          ...(workflowFile ? { workflowFile } : {}),
          ...(input.description ? { summary: input.description } : {}),
          ...(host.toolUseId ? { toolUseId: host.toolUseId } : {}),
          ...(input.resumeFromRunId ? { runId: input.resumeFromRunId } : {}),
        },
        host.handle,
      )

      // Inline entry: persist the script to the run directory and return a reusable path (the
      // inline -> persist -> edit -> resubmit-as-scriptPath iteration loop promised by the ultracode skill).
      // On write failure degrade to a placeholder + warn, do not abort the run (script is already in memory).
      if (!workflowFile && input.script) {
        try {
          workflowFile = await persistInlineScript(
            input.script,
            runId,
            host.cwd,
            options.workflowRunsDir,
          )
        } catch (e) {
          ports.logger.warn?.(
            `inline script persist failed: ${(e as Error).message}`,
          )
        }
      }

      let scriptChanged = false
      try {
        scriptChanged = await persistScriptHash({
          script,
          runId,
          cwd: host.cwd,
          workflowRunsDir: options.workflowRunsDir ?? WORKFLOW_RUNS_DIR,
          resume: input.resumeFromRunId !== undefined,
        })
      } catch (e) {
        // A resume without trustworthy hash state must not replay checkpoints
        // from a script we can no longer prove is identical.
        scriptChanged = input.resumeFromRunId !== undefined
        ports.logger.warn?.(
          `workflow script hash persistence failed: ${(e as Error).message}`,
        )
      }

      // An explicit input always wins; the host-supplied default only fills the omitted case
      // (undefined leaves the engine's DEFAULT_MAX_CONCURRENCY in charge).
      const runConcurrency =
        input.maxConcurrency ?? options.defaultMaxConcurrency

      // Detached execution
      void runWorkflow({
        script,
        ...(input.args !== undefined
          ? { args: normalizeArgs(input.args) }
          : {}),
        runId,
        workflowName,
        ports,
        host: host.handle,
        signal,
        cwd: host.cwd,
        budgetTotal: host.budgetTotal,
        ...(runConcurrency !== undefined
          ? { maxConcurrency: runConcurrency }
          : {}),
        ...(input.resumeFromRunId ? { resume: true, scriptChanged } : {}),
        ...(options.workflowDir ? { workflowDir: options.workflowDir } : {}),
      })
        .then(result => onFinish(ports, result, runId))
        .catch(e => ports.taskRegistrar.fail(runId, (e as Error).message))

      const scriptPath = workflowFile ?? `<inline run ${runId}>`
      return {
        data: {
          output: [
            'Workflow started (running in the background).',
            `run_id: ${runId}`,
            `workflow: ${workflowName}`,
            `script: ${scriptPath}`,
            '',
            'You will be notified on completion. Use /workflows to view live progress.',
          ].join('\n'),
        },
      }
    },

    mapToolResultToToolResultBlockParam(data, toolUseId) {
      return {
        tool_use_id: toolUseId,
        type: 'tool_result',
        content: [{ type: 'text', text: data.output }],
      }
    },
  }
}

const SCRIPT_HASH_FILE = 'script.sha256'

async function persistScriptHash(opts: {
  script: string
  runId: string
  cwd: string
  workflowRunsDir: string
  resume: boolean
}): Promise<boolean> {
  const runId = assertValidRunId(opts.runId)
  const runDir = join(opts.cwd, opts.workflowRunsDir, runId)
  const hashPath = join(runDir, SCRIPT_HASH_FILE)
  const currentHash = createHash('sha256').update(opts.script).digest('hex')
  let previousHash: string | undefined

  if (opts.resume) {
    try {
      previousHash = (await readFile(hashPath, 'utf-8')).trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  await mkdir(runDir, { recursive: true })
  await writeFile(hashPath, `${currentHash}\n`, 'utf-8')
  return opts.resume && previousHash !== currentHash
}

function onFinish(
  ports: WorkflowPorts,
  result: WorkflowRunResult,
  runId: string,
): void {
  if (result.status === 'completed') {
    const summary =
      result.returnValue == null
        ? '(no return value)'
        : formatValue(result.returnValue)
    ports.taskRegistrar.complete(runId, summary)
  } else if (result.status === 'failed') {
    ports.taskRegistrar.fail(runId, result.error ?? 'workflow failed')
  } else {
    ports.taskRegistrar.kill(runId)
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 500)
  try {
    return JSON.stringify(v).slice(0, 500)
  } catch {
    return String(v)
  }
}

/**
 * Defensively normalize args: under the legacy `z.string()` contract the model may send a stringified JSON object.
 * Only normalize when the string JSON.parses to an object/array; plain strings, numbers, etc. are preserved as-is.
 */
function normalizeArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) return parsed
    return raw
  } catch {
    return raw
  }
}

async function resolveScriptSource(
  input: WorkflowInput,
  cwd: string,
  workflowDir: string,
): Promise<{ script: string; workflowFile?: string }> {
  if (input.script) return { script: input.script }
  if (input.scriptPath) {
    const resolved = resolve(cwd, input.scriptPath)
    if (!containsPath(cwd, resolved)) {
      throw new Error(
        `scriptPath "${input.scriptPath}" is out of bounds (after resolve, ${resolved} is not within cwd ${cwd})`,
      )
    }
    return {
      script: await readFile(resolved, 'utf-8'),
      workflowFile: resolved,
    }
  }
  if (input.name) {
    if (sanitizeWorkflowName(input.name) === null) {
      throw new Error(
        `Named workflow name "${input.name}" is invalid (contains path separators or is . / ..)`,
      )
    }
    const found = await resolveNamedWorkflow(join(cwd, workflowDir), input.name)
    if (!found) {
      throw new Error(
        `Named workflow "${input.name}" not found (looked in ${workflowDir}/)`,
      )
    }
    return { script: found.content, workflowFile: found.path }
  }
  throw new Error('One of script, name, or scriptPath must be provided')
}
