// Pure leaf: tool names and static strings only.
//
// Nothing here may import from `src/` or from a sibling module other than
// another tool's `constants.ts`. Reading a tool's name must never boot the
// API client, auth, or analytics — see scripts/check-prompt-purity.ts.
export const BASH_TOOL_NAME = 'Bash'
