/**
 * Edit tool prompt text.
 *
 * PURE LEAF — must not import from `src/`, and may only import other tools'
 * `constants.ts`. `isCompactLinePrefixEnabled()` used to be read here, which
 * dragged in src/utils/file.js — a 22-importer hub — for one boolean. The tool
 * method resolves it now and passes `compactLinePrefix`.
 *
 * The output feeds the API prompt cache; see the characterization snapshots in
 * tools/__tests__/promptCharacterization.runner.ts.
 */
import { FILE_READ_TOOL_NAME } from '../FileReadTool/constants.js'

export interface EditPromptParams {
  /**
   * Whether Read output uses the compact `line number + tab` prefix rather
   * than the legacy `spaces + line number + arrow` form. The model has to
   * strip whichever prefix it sees before matching `old_string`.
   */
  compactLinePrefix: boolean
  /** Ant users get the extra "smallest unique old_string" nudge. */
  includeMinimalUniquenessHint: boolean
}

export function renderEditToolDescription(p: EditPromptParams): string {
  const preReadInstruction = `\n- You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. `
  const prefixFormat = p.compactLinePrefix
    ? 'line number + tab'
    : 'spaces + line number + arrow'
  const minimalUniquenessHint = p.includeMinimalUniquenessHint
    ? `\n- Use the smallest old_string that's clearly unique — usually 2-4 adjacent lines is sufficient. Avoid including 10+ lines of context when less uniquely identifies the target.`
    : ''
  return `Performs exact string replacements in files.

Usage:${preReadInstruction}
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: ${prefixFormat}. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.${minimalUniquenessHint}
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- The file_path must be a file path, not a directory path. If the path resolves to an existing directory, the tool will reject it. Use a path that points to an existing file.`
}
