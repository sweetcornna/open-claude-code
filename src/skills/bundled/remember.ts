import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerRememberSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  const SKILL_PROMPT = `# Memory Review

## Goal
Review the user's memory landscape and produce a clear report of proposed changes, grouped by action type. Do NOT apply changes — present proposals for user approval.

## Steps

### 1. Gather all memory layers
Read CLAUDE.md and CLAUDE.local.md from the project root (if they exist). Review the user-level CLAUDE.md instructions and auto-memory content already present in your context. These are the supported personal memory layers.

**Success criteria**: You have the contents of all supported memory layers and can compare them.

### 2. Classify each auto-memory entry
For each substantive entry in auto-memory, determine the best destination or action:

| Destination | What belongs there | Examples |
|---|---|---|
| **Project CLAUDE.md** | Project conventions and instructions for Claude that all contributors should follow | "use bun not npm", "API routes use kebab-case", "test command is bun test" |
| **User CLAUDE.md** | Personal instructions for Claude that apply across all projects | "I prefer concise responses", "always explain trade-offs", "don't auto-commit" |
| **CLAUDE.local.md** | Personal instructions for Claude that apply only in this project | "use my local test fixture", "ask before changing this project's deployment config" |
| **Auto-memory — user** | The user's role, goals, preferences, responsibilities, and knowledge used to tailor future collaboration | "I maintain the payments service", "I'm learning Rust" |
| **Auto-memory — feedback** | Guidance about how to approach work, including what to avoid or repeat and why | "show the failing assertion first" plus why and how to apply it |
| **Auto-memory — project** | Ongoing work, goals, initiatives, bugs, or incidents that are not derivable from code or git history | Deadlines, incident context, decisions and their rationale |
| **Auto-memory — reference** | Pointers to external systems where information can be found | Linear projects, Slack channels, Grafana dashboards |
| **Remove from auto-memory** | Ephemeral task details, derivable project state, or content already documented in a CLAUDE.md file | Current-session notes, file structure, duplicated instructions |

**Important distinctions:**
- CLAUDE.md and CLAUDE.local.md contain instructions for Claude, not facts merely worth recalling or user preferences for external tools (editor theme, IDE keybindings, etc.)
- Preserve the established CLAUDE.md and CLAUDE.local.md filenames; do not invent renamed instruction files
- Keep durable non-instruction context in auto-memory with the correct user, feedback, project, or reference type
- Feedback memories should include the rule or fact, followed by **Why:** and **How to apply:** guidance
- Workflow practices (PR conventions, merge strategies, branch naming) are ambiguous — ask whether the instruction is shared by this project, personal to this project, or personal across projects
- Temporary context and facts derivable from current code, project structure, or git history should be removed rather than retained as memory
- When unsure, ask rather than guess

**Success criteria**: Each entry has a proposed destination, type, removal action, or is flagged as ambiguous.

### 3. Identify cleanup opportunities
Scan across all supported layers for:
- **Duplicates**: Auto-memory entries already captured in a user/project CLAUDE.md or CLAUDE.local.md → propose removing them from auto-memory
- **Outdated**: Instruction files or auto-memory entries contradicted by newer information → propose updating or removing the older entry
- **Conflicts**: Contradictions between any two supported layers → propose resolution, noting which is more recent
- **Mistyped memories**: Auto-memory entries whose user, feedback, project, or reference type no longer matches their content → propose retagging them

**Success criteria**: All cross-layer issues identified.

### 4. Present the report
Output a structured report grouped by action type:
1. **Promotions** — entries to move to a user/project CLAUDE.md or CLAUDE.local.md, with destination and rationale
2. **Auto-memory maintenance** — entries to retain or retag as user, feedback, project, or reference memory
3. **Cleanup** — duplicates, outdated entries, conflicts, and removals
4. **Ambiguous** — entries where you need the user's input on destination
5. **No action needed** — brief note on entries that should stay put

If auto-memory is empty, say so and offer to review the CLAUDE.md instruction files for cleanup.

**Success criteria**: User can review and approve/reject each proposal individually.

## Rules
- Present ALL proposals before making any changes
- Do NOT modify files without explicit user approval
- Do NOT create new files unless the target doesn't exist yet
- Use only the supported personal memory layers and auto-memory types described above
- Ask about ambiguous entries — don't guess
`

  registerBundledSkill({
    name: 'remember',
    description:
      'Review auto-memory entries and propose promotions to user/project CLAUDE.md or CLAUDE.local.md while preserving user, feedback, project, and reference memory semantics. Also detects outdated, conflicting, duplicate, and mistyped entries.',
    whenToUse:
      'Use when the user wants to review, organize, or promote their auto-memory entries. Also useful for cleaning up outdated or conflicting entries across user/project CLAUDE.md, CLAUDE.local.md, and auto-memory.',
    userInvocable: true,
    isEnabled: () => isAutoMemoryEnabled(),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## Additional context from user\n\n${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
