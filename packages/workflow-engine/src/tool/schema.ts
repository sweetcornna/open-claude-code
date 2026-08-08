import { z } from 'zod/v4'
import {
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_CAP,
  MAX_TOTAL_AGENTS,
  WORKFLOW_DIR_NAME,
} from '../constants.js'

const agentIdSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_TOTAL_AGENTS - 1)

export const resumePolicySchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('checkpoint') }).strict(),
  z.object({ scope: z.literal('all') }).strict(),
  z
    .object({
      scope: z.literal('range'),
      fromAgentId: agentIdSchema,
      toAgentId: agentIdSchema,
    })
    .strict()
    .refine(value => value.fromAgentId <= value.toAgentId, {
      message: 'fromAgentId must be less than or equal to toAgentId',
      path: ['toAgentId'],
    }),
  z
    .object({
      scope: z.literal('agents'),
      agentIds: z
        .array(agentIdSchema)
        .min(1)
        .refine(ids => new Set(ids).size === ids.length, {
          message: 'agentIds must be unique',
        }),
    })
    .strict(),
])

const runIdSchema = z
  .string()
  // Becomes a path segment under the runs directory, and deleteRun() removes
  // that directory recursively — an unvalidated id reaches the filesystem.
  // Mirrored by assertValidRunId at the store boundary.
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid run id')

/** Backward-compatible default operation: omitting operation still launches a run. */
export const workflowRunInputSchema = z
  .object({
    operation: z
      .literal('run')
      .optional()
      .describe('Launch a workflow run. This is the default when omitted.'),
    script: z
      .string()
      .optional()
      .describe('Self-contained workflow script source (inline)'),
    name: z
      .string()
      .optional()
      .describe(
        `Named workflow, resolved to ${WORKFLOW_DIR_NAME}/<name>.ts|js|mjs`,
      ),
    scriptPath: z
      .string()
      .optional()
      .describe('Absolute path to an existing script file'),
    args: z
      .unknown()
      .optional()
      .describe(
        'The args global variable passed through to the script. Pass a real JSON value (object/array/string), not a JSON string.',
      ),
    resumeFromRunId: runIdSchema
      .optional()
      .describe('Resume the specified run, replaying the journal'),
    resumePolicy: resumePolicySchema
      .optional()
      .describe(
        'Select completed agent calls to re-run while resuming. Agent ids are 0-based (the first agent() call of the run is 0), matching the ids shown in workflow progress. Omit or use checkpoint for the existing checkpoint behavior. Selecting a call does not guarantee the rest replays: if a re-run agent returns a different result than recorded, every later checkpoint is discarded and re-runs live.',
      ),
    description: z
      .string()
      .optional()
      .describe('A short description of this invocation (3-5 words)'),
    title: z.string().optional().describe('Progress viewer title'),
    maxConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONCURRENCY_CAP)
      .optional()
      .describe(
        // The schema is a module-level singleton, so it cannot see a host override of the
        // default (OCC_WORKFLOW_MAX_CONCURRENCY); it states the compiled-in value and defers
        // to the tool prompt, which is built per descriptor and quotes the effective one.
        `Concurrency cap for agent(). Omit to use the effective default (${DEFAULT_MAX_CONCURRENCY} unless the host overrides it — the tool description states the value in force); max ${MAX_CONCURRENCY_CAP}. When the workflow contains heavy parallel/pipeline fan-out, you may confirm the desired concurrency with the user via AskUserQuestion before launching.`,
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.resumePolicy !== undefined &&
      input.resumeFromRunId === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'resumePolicy is valid only with resumeFromRunId',
        path: ['resumePolicy'],
      })
    }
  })

export const workflowStatusInputSchema = z
  .object({
    operation: z.enum(['status', 'query']),
    runId: runIdSchema.describe('Run id to inspect'),
  })
  .strict()

export const workflowCancelInputSchema = z
  .object({
    operation: z.literal('cancel'),
    runId: runIdSchema.describe('Run id to cancel'),
    agentId: agentIdSchema
      .optional()
      .describe(
        'When present, cancel only this exact child agent (0-based, as shown in workflow progress)',
      ),
  })
  .strict()

/**
 * Strict operation union. The run variant deliberately excludes runId/agentId so a
 * missing or misspelled control operation cannot be silently treated as a launch.
 */
export const workflowInputSchema = z.union([
  workflowRunInputSchema,
  workflowStatusInputSchema,
  workflowCancelInputSchema,
])

/** Schema-derived input types keep the operation contract and runtime validation aligned. */
export type WorkflowRunInput = z.infer<typeof workflowRunInputSchema>
export type WorkflowStatusInput = z.infer<typeof workflowStatusInputSchema>
export type WorkflowCancelInput = z.infer<typeof workflowCancelInputSchema>
export type WorkflowInput = z.infer<typeof workflowInputSchema>

/** typeof type of the schema (used for "schema is the source of truth" precise signatures). */
export type WorkflowInputSchema = typeof workflowInputSchema
