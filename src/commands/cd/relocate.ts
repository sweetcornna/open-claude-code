import { setOriginalCwd } from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import { getPlansDirectory } from '../../utils/agents/plans.js'
import { getProjectPathForConfig } from '../../utils/config/config.js'
import { getCwd } from '../../utils/filesystem/cwd.js'
import { getIsGit } from '../../utils/git/git.js'
import { resetGitFileWatcher } from '../../utils/git/gitFilesystem.js'
import { onCwdChangedForHooks } from '../../utils/hooks/fileChangedWatcher.js'
import { wrapInSystemReminder } from '../../utils/messages/text.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { clearMemoryFileCaches } from '../../utils/session/claudemd.js'
import { invalidateSessionEnvCache } from '../../utils/session/sessionEnvironment.js'
import { setCwd } from '../../utils/shell/Shell.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'

type CdSource = 'cd_command'

/**
 * Move the session to `directory`: this REPLACES the session's working
 * directory (process cwd + shell cwd state + originalCwd), unlike `/add-dir`
 * which only appends a directory to the permission context.
 *
 * Everything memoized on the old cwd has to be dropped here — the same set
 * `restoreWorktreeForResume()` clears when it chdirs mid-session, plus the
 * project-config path (trust / project settings key), the git caches and the
 * session env script.
 *
 * Throws if the move itself fails, after restoring the previous cwd; the
 * caller reports "staying put".
 */
export async function relocateSession(
  directory: string,
  source: CdSource,
): Promise<{ modelMessage: string }> {
  const previousCwd = getCwd()

  process.chdir(directory)
  try {
    // setCwd() re-resolves symlinks and throws if the directory vanished
    // between validation and now.
    setCwd(directory)
  } catch (e) {
    try {
      process.chdir(previousCwd)
    } catch {
      logForDebugging(
        `/cd: rollback chdir to ${previousCwd} failed after a failed move`,
        { level: 'error' },
      )
    }
    throw e
  }

  setOriginalCwd(getCwd())

  // Caches keyed on the old directory.
  getProjectPathForConfig.cache.clear?.()
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()
  getIsGit.cache.clear?.()
  resetGitFileWatcher()
  invalidateSessionEnvCache()
  SandboxManager.refreshConfig()

  logEvent('tengu_cd_command', { via_command: source === 'cd_command' })

  const newCwd = getCwd()
  // Fire-and-forget like the shell's own cwd-change path (Shell.ts): env hooks
  // must not block the command from returning.
  void onCwdChangedForHooks(previousCwd, newCwd).catch(() => {})

  return {
    modelMessage: wrapInSystemReminder(
      `The session's working directory has changed to ${newCwd} (via /cd). ` +
        'The environment block at the start of this conversation still names the ' +
        'previous directory — that information is stale. All tool calls and ' +
        `relative paths now resolve from ${newCwd}.`,
    ),
  }
}
