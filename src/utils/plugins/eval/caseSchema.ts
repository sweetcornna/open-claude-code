/**
 * `occ plugin eval` — the case file contract.
 *
 * A case is a directory under `evals/` holding a single `case.yaml`. The
 * declaration answers four questions: what to ask the agent, what the agent is
 * allowed to touch, how to decide whether it succeeded, and how many times to
 * repeat before believing the answer.
 *
 * DESIGN: DETERMINISTIC ASSERTIONS ARE THE DEFAULT, THE JUDGE IS OPT-IN
 *
 * The upstream design offers six grader types and its `init` template scaffolds
 * an `llm` one, so the path of least resistance is "spend a model call to ask
 * whether a file got written". That is both slower and less trustworthy than
 * `stat()`. Here the `assert:` list is the primary surface and needs no model
 * at all; `judge:` is a separate optional block, so a case that never mentions
 * it provably costs zero judge tokens. `occ plugin eval --dry-run` reports the
 * two counts separately precisely so the split stays visible.
 *
 * WITH-ONLY ASSERTIONS
 *
 * An assertion like "the plugin's skill was invoked" can only pass in the arm
 * that has the plugin. Scoring it would manufacture a positive delta out of
 * nothing — the number would measure the tautology, not the plugin. Such
 * assertions carry `arm: with-only`: they run and are reported in the `with`
 * arm, but are excluded from both arms' scores. `skill_used` defaults to
 * `with-only` because that is essentially always what the author means.
 */

import { z } from 'zod/v4'

/** Which ablation arm an assertion participates in. */
export const AssertionArmSchema = z.enum(['both', 'with-only'])
export type AssertionArm = z.infer<typeof AssertionArmSchema>

/** Regex flags we accept — no `g`, which makes `.test()` stateful. */
const REGEX_FLAGS = /^[dimsuvy]*$/

const patternField = z.object({
  pattern: z.string().min(1),
  flags: z
    .string()
    .regex(REGEX_FLAGS, 'invalid regex flags (g is not allowed)')
    .optional(),
  /** `contains` (default) requires a match; `not_contains` requires none. */
  match: z.enum(['contains', 'not_contains']).default('contains'),
})

const graderBase = {
  /** Relative weight within the run's score. Defaults to 1. */
  weight: z.number().positive().max(1000).default(1),
  arm: AssertionArmSchema.default('both'),
}

/**
 * Deterministic assertions. Every one of these is answerable from the sandbox
 * filesystem, the run transcript, or an exit code — no model call.
 *
 * Paths are always relative to the run's workspace and are rejected if they
 * escape it (see `resolveWorkspacePath`).
 */
export const AssertionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file_exists'),
    path: z.string().min(1),
    ...graderBase,
  }),
  z.object({
    type: z.literal('file_absent'),
    path: z.string().min(1),
    ...graderBase,
  }),
  z.object({
    type: z.literal('file_matches'),
    path: z.string().min(1),
    ...patternField.shape,
    ...graderBase,
  }),
  z.object({
    type: z.literal('output_matches'),
    ...patternField.shape,
    ...graderBase,
  }),
  z.object({
    type: z.literal('tool_used'),
    /** Tool name as it appears in the transcript, e.g. `Write`. */
    tool: z.string().min(1),
    /** Optional regex against the JSON-serialised tool input. */
    input_matches: z.string().min(1).optional(),
    min: z.number().int().min(0).default(1),
    max: z.number().int().min(0).optional(),
    ...graderBase,
  }),
  z.object({
    type: z.literal('skill_used'),
    /** Skill name (`Skill` tool invocations are matched on their command). */
    skill: z.string().min(1),
    min: z.number().int().min(1).default(1),
    ...graderBase,
    // A skill from the plugin under test cannot fire in the control arm.
    arm: AssertionArmSchema.default('with-only'),
  }),
  z.object({
    type: z.literal('command'),
    /**
     * Shell command run in the workspace after the agent finishes.
     *
     * Gated behind `--allow-assert-commands`: a case file is data, and cases
     * arrive by cloning someone's plugin repo. Running their shell by default
     * would make `occ plugin eval` an arbitrary-code-execution vector.
     */
    run: z.string().min(1),
    expect_exit_code: z.number().int().default(0),
    stdout_matches: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().max(600_000).default(60_000),
    ...graderBase,
  }),
])
export type Assertion = z.infer<typeof AssertionSchema>
export type AssertionType = Assertion['type']

/** Optional LLM grader. Absent means the case costs zero judge calls. */
export const JudgeSchema = z.object({
  /** What a good answer looks like. Sent verbatim to the judge. */
  rubric: z.string().min(1),
  weight: z.number().positive().max(1000).default(1),
  /** Overrides `--judge-model` for this case. */
  model: z.string().min(1).optional(),
  arm: AssertionArmSchema.default('both'),
})
export type JudgeSpec = z.infer<typeof JudgeSchema>

export const EvalCaseSchema = z
  .object({
    /** Defaults to the case directory name. */
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),

    /** The user turn. Exactly one of `prompt` / `prompt_file` is required. */
    prompt: z.string().min(1).optional(),
    prompt_file: z.string().min(1).optional(),

    /** Directory copied into the workspace before each run. */
    files: z.string().min(1).optional(),

    runs: z.number().int().min(1).max(50).default(1),
    max_turns: z.number().int().min(1).max(200).default(12),
    timeout_ms: z.number().int().positive().max(3_600_000).optional(),
    model: z.string().min(1).optional(),
    /**
     * Tools the agent may use. Anything outside `FREELY_ALLOWED_TOOLS` also
     * needs the operator's `--allow-tools`, so a downloaded case cannot hand
     * itself `Bash` on your machine.
     */
    allowed_tools: z.array(z.string().min(1)).default([]),

    assert: z.array(AssertionSchema).default([]),
    judge: JudgeSchema.optional(),
  })
  .refine(c => (c.prompt === undefined) !== (c.prompt_file === undefined), {
    message: 'exactly one of `prompt` or `prompt_file` is required',
  })
  .refine(c => c.assert.length > 0 || c.judge !== undefined, {
    message:
      'a case needs at least one `assert` entry or a `judge` block — ' +
      'otherwise nothing decides whether the run succeeded',
  })
export type EvalCaseFile = z.infer<typeof EvalCaseSchema>

/**
 * Tools a case file may request on its own authority.
 *
 * Read-only tools plus writes, because the workspace is a throwaway directory
 * this command created. Deliberately absent: `Bash`/`PowerShell` (arbitrary
 * host code), `WebFetch`/`WebSearch` (network egress driven by case text) and
 * every MCP tool. Those need `--allow-tools` from whoever runs the eval.
 */
export const FREELY_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'NotebookEdit',
  'Skill',
  'TodoWrite',
  'Agent',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskOutput',
  'TaskStop',
  'LSP',
])

/** `Bash(git:*)` → `Bash`. Permission patterns gate on the base tool name. */
export function baseToolName(tool: string): string {
  const paren = tool.indexOf('(')
  return (paren === -1 ? tool : tool.slice(0, paren)).trim()
}

/**
 * Split a case's requested tools into those it may have and those needing
 * `--allow-tools`. Operator grants are matched on the base name too, so
 * `--allow-tools Bash` unlocks a case's `Bash(git:*)`.
 */
export function partitionRequestedTools(
  requested: readonly string[],
  operatorAllowed: readonly string[],
): { allowed: string[]; denied: string[] } {
  const granted = new Set(operatorAllowed.map(baseToolName))
  const allowed: string[] = []
  const denied: string[] = []
  for (const tool of requested) {
    const base = baseToolName(tool)
    if (FREELY_ALLOWED_TOOLS.has(base) || granted.has(base)) allowed.push(tool)
    else denied.push(tool)
  }
  return { allowed, denied }
}

/** Human-readable label used in reports and terminal output. */
export function assertionLabel(assertion: Assertion): string {
  switch (assertion.type) {
    case 'file_exists':
      return `file_exists ${assertion.path}`
    case 'file_absent':
      return `file_absent ${assertion.path}`
    case 'file_matches':
      return `file_matches ${assertion.path} ~ /${assertion.pattern}/`
    case 'output_matches':
      return `output_matches /${assertion.pattern}/`
    case 'tool_used':
      return `tool_used ${assertion.tool}`
    case 'skill_used':
      return `skill_used ${assertion.skill}`
    case 'command':
      return `command ${assertion.run}`
  }
}
