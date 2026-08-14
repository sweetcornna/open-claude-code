import { type as osType, version as osVersion, release as osRelease } from 'os'
import { BASH_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/PowerShellTool/toolName.js'
import { env } from '../../utils/config/env.js'
import { getCwd } from '../../utils/filesystem/cwd.js'
import { findGitBashPathOrNull } from '../../utils/filesystem/windowsPaths.js'
import { getIsGit } from '../../utils/git/git.js'
import { getCurrentWorktreeSession } from '../../utils/git/worktree.js'
import { isFastModeAvailable } from '../../utils/model/fastMode.js'
import {
  getCanonicalName,
  getMarketingNameForModel,
} from '../../utils/model/model.js'
import { servesAnthropicModels } from '../../utils/model/providers.js'
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js'
import { prependBullets } from './format.js'

/**
 * The latest first-party model id per family, as named in the "Model IDs —"
 * sentence below.
 *
 * These MUST stay in sync with the `firstParty` fields of the corresponding
 * entries in src/utils/model/configs.ts — this line tells the model which ids
 * to write into the user's code, so an id occ itself does not recognise is a
 * fabricated API string that will 404 for whoever pastes it.
 *
 * @[MODEL LAUNCH]: Update the model family IDs below to the latest in each tier.
 */
const CLAUDE_LATEST_MODEL_IDS = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
}

/**
 * Concurrency hazard specific to worktree sessions, emitted alongside the
 * worktree bullet. Not advice — the stash stack really is one shared ref
 * (`refs/stash` lives in the common dir), so a bare `git stash pop` in one
 * session can silently consume another session's entry.
 */
const WORKTREE_GIT_STASH_WARNING = `The git stash stack is shared with the main checkout and all other worktrees, and other Claude sessions may push or pop it concurrently. Never use bare \`git stash\` / \`git stash pop\` — you could pop another session's changes. Prefer a temporary WIP commit to set work aside; if you must stash, use \`git stash push -u -m "<unique-tag>"\`, immediately capture your entry's SHA via \`git stash list --format='%H %gs'\`, restore with \`git stash apply <sha>\` (not pop), and afterwards drop the entry, re-finding its current \`stash@{n}\` by tag first.`

// The former computeEnvInfo (XML <env> variant, subagent-only) was removed:
// it duplicated ~80% of computeSimpleEnvInfo and the two had already drifted.
// Subagents now consume computeSimpleEnvInfo with includeProductInfo: false.
export async function computeSimpleEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
  opts?: { includeProductInfo?: boolean },
): Promise<string> {
  const includeProductInfo = opts?.includeProductInfo ?? true
  const [isGit, unameSR] = await Promise.all([getIsGit(), getUnameSR()])

  // getMarketingNameForModel already answers undefined when this session does
  // not serve Anthropic checkpoints, so the fallback phrasing (bare id, no
  // marketing name) is what OpenAI/Gemini/Grok/DeepSeek sessions get.
  const marketingName = getMarketingNameForModel(modelId)
  const modelDescription = marketingName
    ? `You are powered by the model named ${marketingName}. The exact model ID is ${modelId}.`
    : `You are powered by the model ${modelId}.`

  const cutoff = getKnowledgeCutoff(modelId)
  const knowledgeCutoffMessage = cutoff
    ? `Assistant knowledge cutoff is ${cutoff}.`
    : null

  const cwd = getCwd()
  const isWorktree = getCurrentWorktreeSession() !== null

  // Which Claude ids to reach for when writing code against the API. Gated on
  // servesAnthropicModels() — NOT on getAPIProvider() (that answers "which
  // wire format") and NOT on isThirdPartyModelCatalog() (that answers "whose
  // rate card"). Bedrock/Vertex/Foundry serve real Claude checkpoints and do
  // want this line; an OpenAI-compatible endpoint resolves `claude-opus-5` to
  // a literal string it does not serve, so handing that id to the model there
  // would be dictating a 404.
  const modelCatalogLine =
    includeProductInfo && servesAnthropicModels()
      ? `The most recent Claude models are the Claude 5 family and Haiku 4.5. Model IDs — Fable 5: '${CLAUDE_LATEST_MODEL_IDS.fable}', Opus 5: '${CLAUDE_LATEST_MODEL_IDS.opus}', Sonnet 5: '${CLAUDE_LATEST_MODEL_IDS.sonnet}', Haiku 4.5: '${CLAUDE_LATEST_MODEL_IDS.haiku}'. When building AI applications, default to the latest and most capable Claude models.`
      : null

  // Upstream also lists the desktop app, web app and IDE extensions here.
  // occ ships none of them, so that sentence is simply false for this build
  // and is deliberately absent.
  //
  // /fast, by contrast, exists — but only where isFastModeAvailable() says so
  // (it folds in the third-party-catalog and subscription checks), and an
  // unusable toggle advertised to the model becomes a suggestion the user
  // cannot act on. Kept model-neutral: the supported-model list moves faster
  // than this prompt does.
  const fastModeLine =
    includeProductInfo && isFastModeAvailable()
      ? `Fast mode serves the same model with faster output. It does NOT switch to a different or smaller model. It can be toggled with /fast.`
      : null

  const envItems = [
    `Primary working directory: ${cwd}`,
    isWorktree
      ? `This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT \`cd\` to the original repository root.`
      : null,
    isWorktree ? WORKTREE_GIT_STASH_WARNING : null,
    [`Is a git repository: ${isGit}`],
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories:`
      : null,
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? additionalWorkingDirectories
      : null,
    `Platform: ${env.platform}`,
    getShellInfoLine(),
    `OS Version: ${unameSR}`,
    modelDescription,
    knowledgeCutoffMessage,
    modelCatalogLine,
    fastModeLine,
  ].filter(item => item !== null)

  return [
    `# Environment`,
    `You have been invoked in the following environment: `,
    ...prependBullets(envItems),
  ].join(`\n`)
}

// @[MODEL LAUNCH]: Add a knowledge cutoff date for the new model.
// Upstream reads this off the model catalog's `knowledge_cutoff` field; occ
// carries no such catalog data (ALL_MODEL_CONFIGS holds ids only), so the
// chain stays hand-maintained.
function getKnowledgeCutoff(modelId: string): string | null {
  const canonical = getCanonicalName(modelId)
  if (
    canonical.includes('claude-fable-5') ||
    canonical.includes('claude-opus-5') ||
    canonical.includes('claude-sonnet-5')
  ) {
    return 'May 2026'
  } else if (canonical.includes('claude-sonnet-4-6')) {
    return 'August 2025'
  } else if (canonical.includes('claude-opus-4-7')) {
    return 'January 2026'
  } else if (canonical.includes('claude-opus-4-6')) {
    return 'May 2025'
  } else if (canonical.includes('claude-opus-4-5')) {
    return 'May 2025'
  } else if (canonical.includes('claude-haiku-4')) {
    return 'February 2025'
  } else if (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4')
  ) {
    return 'January 2025'
  }
  return null
}

function getShellInfoLine(): string {
  const shell = process.env.SHELL || 'unknown'
  const shellName = shell.includes('zsh')
    ? 'zsh'
    : shell.includes('bash')
      ? 'bash'
      : shell
  if (env.platform !== 'win32') {
    return `Shell: ${shellName}`
  }
  // On Windows the Bash tool only works if Git Bash was discovered —
  // setShellIfWindows() runs the same lookup at startup (so this is a warm
  // memo, not a fresh `where.exe` spawn) and leaves SHELL unset when it finds
  // nothing. Without it, naming a POSIX shell and demanding POSIX syntax
  // describes a tool the session cannot run.
  if (findGitBashPathOrNull() === null) {
    return `Shell: ${POWERSHELL_TOOL_NAME}`
  }
  if (isPowerShellToolEnabled()) {
    return `Shell: ${POWERSHELL_TOOL_NAME} (primary); ${BASH_TOOL_NAME} tool also available for POSIX scripts — each takes its own syntax.`
  }
  return `Shell: ${shellName} (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)`
}

export function getUnameSR(): string {
  // os.type() and os.release() both wrap uname(3) on POSIX, producing output
  // byte-identical to `uname -sr`: "Darwin 25.3.0", "Linux 6.6.4", etc.
  // Windows has no uname(3); os.type() returns "Windows_NT" there, but
  // os.version() gives the friendlier "Windows 11 Pro" (via GetVersionExW /
  // RtlGetVersion) so use that instead. Feeds the OS Version line in the
  // system prompt env section.
  if (env.platform === 'win32') {
    return `${osVersion()} ${osRelease()}`
  }
  return `${osType()} ${osRelease()}`
}
