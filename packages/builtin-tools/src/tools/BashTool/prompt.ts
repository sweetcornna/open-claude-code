/**
 * Bash tool prompt text.
 *
 * PURE LEAF — must not import from `src/`, and may only import other tools'
 * `constants.ts`. Every environment, settings, feature-flag and sandbox read
 * that used to live here now happens in BashTool.tsx's `prompt()` method,
 * which computes the params below and calls `renderBashPrompt()`.
 *
 * Why: this file used to pull SandboxManager, the attribution/settings stack,
 * the permissions filesystem helpers and the whole TodoWriteTool object into
 * the graph. Anything that merely wanted `BASH_TOOL_NAME` paid for all of it,
 * and the resulting import cycles were the dominant seed in the module graph.
 *
 * The output of these renderers feeds the API prompt cache. Changing a byte
 * busts the cached tools block for every session — see the characterization
 * snapshots in tools/__tests__/promptCharacterization.runner.ts.
 */
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/constants.js'
import { GLOB_TOOL_NAME } from '../GlobTool/constants.js'
import { GREP_TOOL_NAME } from '../GrepTool/constants.js'
import { BASH_TOOL_NAME } from './constants.js'

/**
 * Local copy of `prependBullets` from src/constants/prompts.ts. Importing it
 * would re-anchor this module in the src/ graph, which is exactly what the
 * leaf extraction removed. Six lines of duplication buys the whole isolation.
 */
function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap(item =>
    Array.isArray(item)
      ? item.map(subitem => `  - ${subitem}`)
      : [` - ${item}`],
  )
}

const BACKGROUND_USAGE_NOTE =
  "You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter."

export interface BashGitPromptParams {
  /**
   * Undercover instructions plus a trailing newline, or ''. Computed by the
   * caller because the text and the "am I undercover" check both live in
   * src/utils/undercover.ts.
   *
   * Defense-in-depth: this survives even when git instructions are disabled
   * entirely. Attribution stripping and model-ID hiding are mechanical and
   * work regardless, but the explicit "don't blow your cover" instructions
   * are the last line of defense against the model volunteering an internal
   * codename in a commit message.
   */
  undercoverSection: string
  /** settings.includeGitInstructions / CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS. */
  includeGitInstructions: boolean
  /** USER_TYPE === 'ant' — gets the short version pointing at skills. */
  antUser: boolean
  /** Ant users only: false under CLAUDE_CODE_SIMPLE. */
  includeSkillsSection: boolean
  /** External users only: attribution trailer for commits, or ''. */
  commitAttribution: string
  /** External users only: attribution trailer for PR bodies, or ''. */
  prAttribution: string
}

function renderCommitAndPRInstructions(p: BashGitPromptParams): string {
  if (!p.includeGitInstructions) return p.undercoverSection

  if (p.antUser) {
    const skillsSection = p.includeSkillsSection
      ? `For git commits and pull requests, use the \`/commit\` and \`/commit-push-pr\` skills:
- \`/commit\` - Create a git commit with staged changes
- \`/commit-push-pr\` - Commit, push, and create a pull request

These skills handle git safety protocols, proper commit message formatting, and PR creation.

Before creating a pull request, run \`/simplify\` to review your changes, then test end-to-end (e.g. via \`/tmux\` for interactive features).

`
      : ''
    return `${p.undercoverSection}# Git operations

${skillsSection}IMPORTANT: NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it.

Use the gh command via the Bash tool for other GitHub-related tasks including working with issues, checks, and releases. If given a Github URL use the gh command to get the information needed.

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`
  }

  const { commitAttribution, prAttribution } = p

  return `# Committing changes with git

Only create commits when requested by the user. If unclear, ask first.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

When committing: review the current state first (git status — never with the -uall flag, it can cause memory issues on large repos — plus git diff and recent git log so the message matches this repository's style), stage the relevant files by name, and write a concise message focused on the "why". Do not commit files that likely contain secrets (.env, credentials.json, etc); warn the user if they explicitly request it. Git commands with the -i flag (git rebase -i, git add -i) are not supported — interactive input is unavailable. Do not push to the remote unless the user explicitly asks.

To ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:
<example>
git commit -m "$(cat <<'EOF'
   Commit message here.${commitAttribution ? `\n\n   ${commitAttribution}` : ''}
   EOF
   )"
</example>

# Creating pull requests
Use the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.

When the user asks for a pull request: review ALL commits that will be included (git log and \`git diff [base-branch]...HEAD\` — not just the latest commit), create a branch and push with -u if needed, then create the PR with a short title (under 70 characters) and a HEREDOC body:
<example>
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]${prAttribution ? `\n\n${prAttribution}` : ''}
EOF
)"
</example>

Return the PR URL when you're done, so the user can see it.

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`
}

export interface BashSandboxPromptParams {
  /**
   * `jsonStringify` of the filesystem config, or null when it has no keys.
   *
   * Serialized by the caller: SandboxManager merges config from multiple
   * sources (settings layers, defaults, CLI flags) without deduping, so paths
   * like ~/.cache appear 3× in allowOnly, and the per-UID temp dir has to be
   * rewritten to "$TMPDIR" so the prompt is identical across users. Both are
   * data-shaping concerns that belong next to SandboxManager, not here.
   */
  filesystemJson: string | null
  /** `jsonStringify` of the network config, or null when it has no keys. */
  networkJson: string | null
  /** `jsonStringify` of the ignored-violations config, or null when unset. */
  ignoredViolationsJson: string | null
  /** Whether `dangerouslyDisableSandbox: true` is permitted by policy. */
  allowUnsandboxedCommands: boolean
}

function renderSandboxSection(p: BashSandboxPromptParams | null): string {
  if (p === null) return ''

  const restrictionsLines = []
  if (p.filesystemJson !== null) {
    restrictionsLines.push(`Filesystem: ${p.filesystemJson}`)
  }
  if (p.networkJson !== null) {
    restrictionsLines.push(`Network: ${p.networkJson}`)
  }
  if (p.ignoredViolationsJson !== null) {
    restrictionsLines.push(`Ignored violations: ${p.ignoredViolationsJson}`)
  }

  const sandboxOverrideItems: Array<string | string[]> =
    p.allowUnsandboxedCommands
      ? [
          'You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:',
          [
            'The user *explicitly* asks you to bypass sandbox',
            'A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).',
          ],
          'Evidence of sandbox-caused failures includes:',
          [
            '"Operation not permitted" errors for file/network operations',
            'Access denied to specific paths outside allowed directories',
            'Network connection failures to non-whitelisted hosts',
            'Unix socket connection errors',
          ],
          'When you see evidence of sandbox-caused failure:',
          [
            "Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)",
            'Briefly explain what sandbox restriction likely caused the failure. Be sure to mention that the user can use the `/sandbox` command to manage restrictions.',
            'This will prompt the user for permission',
          ],
          'Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.',
          'Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.',
        ]
      : [
          'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.',
          'Commands cannot run outside the sandbox under any circumstances.',
          'If a command fails due to sandbox restrictions, work with the user to adjust sandbox settings instead.',
        ]

  const items: Array<string | string[]> = [
    ...sandboxOverrideItems,
    'For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.',
  ]

  return [
    '',
    '## Command sandbox',
    'By default, your command will be run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.',
    '',
    'The sandbox has the following restrictions:',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

export interface BashPromptParams {
  /**
   * Ant-native builds alias find/grep to embedded bfs/ugrep in Claude's shell,
   * so we don't steer away from them (and Glob/Grep tools are removed).
   */
  embeddedSearchTools: boolean
  /** Ceiling accepted by the `timeout` parameter, in milliseconds. */
  maxTimeoutMs: number
  /** Timeout applied when the model omits `timeout`, in milliseconds. */
  defaultTimeoutMs: number
  /** False under CLAUDE_CODE_DISABLE_BACKGROUND_TASKS. */
  backgroundTasksEnabled: boolean
  /** feature('MONITOR_TOOL') — swaps in the Monitor-aware sleep guidance. */
  monitorTool: boolean
  /**
   * Windows: this tool runs Git Bash, not cmd.exe/PowerShell. Without saying
   * so the model writes `NUL`, `%VAR%` and backslash paths, which Git Bash
   * accepts as literals and silently does the wrong thing.
   */
  windowsGitBash: boolean
  /**
   * Windows + PowerShell tool present: the model has a sibling tool that DOES
   * take PowerShell syntax, so it needs the extra "not here" cases.
   */
  powershellToolAvailable: boolean
  /** Null when sandboxing is disabled. */
  sandbox: BashSandboxPromptParams | null
  git: BashGitPromptParams
}

function renderWindowsShellNote(p: BashPromptParams): string | null {
  if (!p.windowsGitBash) return null
  const base =
    'This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell syntax: `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%` or `$env:VAR`.'
  if (!p.powershellToolAvailable) return base
  return `${base} Do not use PowerShell here-strings (\`@'…'@\`) or backtick continuation here — for multi-line strings use a heredoc.`
}

export function renderBashPrompt(p: BashPromptParams): string {
  const embedded = p.embeddedSearchTools

  const toolPreferenceItems = [
    ...(embedded
      ? []
      : [
          `File search: Use ${GLOB_TOOL_NAME} (NOT find or ls)`,
          `Content search: Use ${GREP_TOOL_NAME} (NOT grep or rg)`,
        ]),
    `Read files: Use ${FILE_READ_TOOL_NAME} (NOT cat/head/tail)`,
    `Edit files: Use ${FILE_EDIT_TOOL_NAME} (NOT sed/awk)`,
    `Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
    'Communication: Output text directly (NOT echo/printf)',
  ]

  const avoidCommands = embedded
    ? '`cat`, `head`, `tail`, `sed`, `awk`, or `echo`'
    : '`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`'

  const multipleCommandsSubitems = [
    `If the commands are independent and can run in parallel, make multiple ${BASH_TOOL_NAME} tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two ${BASH_TOOL_NAME} tool calls in parallel.`,
    `If the commands depend on each other and must run sequentially, use a single ${BASH_TOOL_NAME} call with '&&' to chain them together.`,
    "Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.",
    'DO NOT use newlines to separate commands (newlines are ok in quoted strings).',
  ]

  const gitSubitems = [
    'Prefer to create a new commit rather than amending an existing commit.',
    'Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.',
    'Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.',
  ]

  const sleepSubitems = [
    'Do not sleep between commands that can run immediately — just run them.',
    ...(p.monitorTool
      ? [
          'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.',
        ]
      : []),
    'For long-running commands, use `run_in_background` — you will be notified when it completes. Do not poll.',
    'Do not retry failing commands in a sleep loop — diagnose the root cause.',
    ...(p.monitorTool
      ? [
          // detectBlockedSleepPattern only inspects the FIRST subcommand, so
          // `until <check>; do sleep 2; done` is genuinely allowed — and so is
          // `sleep 1 && sleep 1 && …`, which is why the anti-chaining clause
          // has to be stated rather than enforced.
          '`sleep N` as the first command with N ≥ 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.',
          'To wait for a condition, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`) — you are notified when the loop exits. Do not chain shorter sleeps to work around the block.',
        ]
      : [
          'If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.',
        ]),
  ]

  const instructionItems: Array<string | string[]> = [
    'If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.',
    'Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")',
    'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it. In particular, never prepend `cd <current-directory>` to a `git` command — `git` already operates on the current working tree, and the compound triggers a permission prompt.',
    `You may specify an optional timeout in milliseconds (up to ${p.maxTimeoutMs}ms / ${p.maxTimeoutMs / 60000} minutes). By default, your command will timeout after ${p.defaultTimeoutMs}ms (${p.defaultTimeoutMs / 60000} minutes).`,
    ...(p.backgroundTasksEnabled ? [BACKGROUND_USAGE_NOTE] : []),
    'When issuing multiple commands:',
    multipleCommandsSubitems,
    'For git commands:',
    gitSubitems,
    'Avoid unnecessary `sleep` commands:',
    sleepSubitems,
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ]

  const gitInstructions = renderCommitAndPRInstructions(p.git)
  const windowsShellNote = renderWindowsShellNote(p)

  return [
    'Executes a given bash command and returns its output.',
    ...(windowsShellNote ? ['', windowsShellNote] : []),
    '',
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
    '',
    // Environment facts the model cannot observe: it never sees the user's
    // terminal, so it assumes echoing a result to stdout has "told the user".
    'Command output is displayed to you, not reliably to the user.',
    'Commands are cheap to run and their errors are informative: run the straightforward command rather than perfecting it mentally first, and adjust from what it prints.',
    '',
    `IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:`,
    '',
    ...prependBullets(toolPreferenceItems),
    `While the ${BASH_TOOL_NAME} tool can do similar things, it’s better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.`,
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    renderSandboxSection(p.sandbox),
    ...(gitInstructions ? ['', gitInstructions] : []),
  ].join('\n')
}
