import {
  isScratchpadEnabled,
  getScratchpadDir,
} from '../../utils/permissions/filesystem.js'

/**
 * Per-session directory the agent may write to without a permission prompt.
 * Absent when the feature is off, in which case the model must not be told
 * about a path it cannot use.
 */
export function getScratchpadInstructions(): string | null {
  if (!isScratchpadEnabled()) return null

  const scratchpadDir = getScratchpadDir()

  return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${scratchpadDir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can be used freely without permission prompts.`
}
