import { z } from 'zod/v4'
import { lazySchema } from '@open-claude-code/tool-runtime/lazySchema.js'
import { semanticBoolean } from '@open-claude-code/tool-runtime/semanticBoolean.js'

/**
 * Rescues the near-miss field names models reach for when writing an edit:
 * `path`, `old_str`, `new_str` (the Anthropic text_editor tool's spelling) and
 * `replace_name` (a hallucinated alias for `replace_all`).
 *
 * Without this the schema is `z.strictObject`, so a single wrong key produces
 * BOTH "unrecognized key" and "required field missing" errors and the call
 * fails outright — the model then retries the whole edit, paying for the file
 * content twice. Only aliases whose canonical key is absent are promoted, so
 * an input that already has the right key is never overwritten.
 *
 * Correction is silent by design: the JSON Schema sent to the API still shows
 * only the canonical names (an identity-shaped `z.preprocess` is invisible to
 * `toJSONSchema`, same as `semanticBoolean`), so this tolerates a mistake
 * without advertising the wrong spelling as valid input.
 */
export function coerceEditInput(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }
  const input = value as Record<string, unknown>
  let coerced: Record<string, unknown> | null = null
  const rename = (alias: string, canonical: string): void => {
    if (!(alias in input) || canonical in input) return
    if (typeof input[alias] !== 'string') return
    coerced ??= { ...input }
    coerced[canonical] = coerced[alias]
    delete coerced[alias]
  }

  rename('path', 'file_path')
  rename('old_str', 'old_string')
  rename('new_str', 'new_string')

  // replace_name carries a boolean-ish, not a string, so it can't use rename().
  if ('replace_name' in input) {
    coerced ??= { ...input }
    if (!('replace_all' in input)) {
      const raw = coerced.replace_name
      coerced.replace_all = raw === true || raw === 'true'
    }
    delete coerced.replace_name
  }

  return coerced ?? input
}

// The input schema with optional replace_all
const inputSchema = lazySchema(() =>
  z.preprocess(
    coerceEditInput,
    z.strictObject({
      file_path: z.string().describe('The absolute path to the file to modify'),
      old_string: z.string().describe('The text to replace'),
      new_string: z
        .string()
        .describe(
          'The text to replace it with (must be different from old_string)',
        ),
      replace_all: semanticBoolean(
        z.boolean().default(false).optional(),
      ).describe('Replace all occurrences of old_string (default false)'),
    }),
  ),
)
type InputSchema = ReturnType<typeof inputSchema>

// Parsed output — what call() receives. z.output not z.input: with
// semanticBoolean the input side is unknown (preprocess accepts anything).
export type FileEditInput = z.output<InputSchema>

// Individual edit without file_path
export type EditInput = Omit<FileEditInput, 'file_path'>

// Runtime version where replace_all is always defined
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),
    status: z.enum(['modified', 'added']),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string(),
    repository: z
      .string()
      .nullable()
      .optional()
      .describe('GitHub owner/repo when available'),
  }),
)

// Output schema for FileEditTool
const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('The file path that was edited'),
    oldString: z.string().describe('The original string that was replaced'),
    newString: z.string().describe('The new string that replaced it'),
    originalFile: z
      .string()
      .describe('The original file contents before editing'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    userModified: z
      .boolean()
      .describe('Whether the user modified the proposed changes'),
    replaceAll: z.boolean().describe('Whether all occurrences were replaced'),
    gitDiff: gitDiffSchema().optional(),
    redactionNote: z
      .string()
      .optional()
      .describe(
        'Present when secrets were redacted from a Claude-managed memory file before writing',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, outputSchema }
