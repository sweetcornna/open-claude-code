// Pure leaf: tool names and static strings only. See BashTool/constants.ts.
export const FILE_READ_TOOL_NAME = 'Read'

export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

/**
 * Prefix of the model-facing banner emitted when a whole-file Read was
 * auto-paginated because its content exceeded the token cap. Kept as a
 * standalone constant because two consumers match on it: the transcript
 * scan that decides whether a persisted tool_result already carries the
 * notice, and tests.
 */
export const TRUNCATED_PARTIAL_VIEW_PREFIX = '[Truncated: PARTIAL view — '

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const LINE_FORMAT_INSTRUCTION =
  '- Results are returned using cat -n format, with line numbers starting at 1'

export const OFFSET_INSTRUCTION_DEFAULT =
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters"

export const OFFSET_INSTRUCTION_TARGETED =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'
