import { resolve } from 'path'
import {
  type ProjectConfig,
  saveGlobalConfig,
} from '../../utils/config/config.js'
import { normalizePathForConfigKey } from '../../utils/filesystem/path.js'
import { findCanonicalGitRoot } from '../../utils/git/git.js'

/**
 * Where trust for `directory` is persisted in the global config's `projects`
 * map.
 *
 * MUST stay in sync with `getProjectPathForConfig()` (git root, else the
 * resolved path, normalized for JSON keys) — that is the key the session will
 * read its project config from once `/cd` has moved originalCwd here, and
 * `isPathTrusted()` walks the same normalized keys upward. Trusting the git
 * root (not the exact subdirectory) is deliberate and matches the official
 * client: it is what makes the prompt's "trusting it trusts that whole
 * repository, including its other worktrees and subdirectories" true.
 */
export function persistedTrustKeyForPath(directory: string): string {
  return normalizePathForConfigKey(
    findCanonicalGitRoot(directory) ?? resolve(directory),
  )
}

/**
 * Persist trust for an arbitrary directory (the session may not have moved
 * there yet). `saveCurrentProjectConfig` can't be used here because it always
 * writes the *current* project's key.
 */
export function setPathTrusted(directory: string): void {
  const key = persistedTrustKeyForPath(directory)
  saveGlobalConfig(config => {
    // Return the same reference when nothing changes: saveGlobalConfig skips
    // the write (and the lock) in that case.
    if (config.projects?.[key]?.hasTrustDialogAccepted) {
      return config
    }
    const existing = config.projects?.[key]
    const next: ProjectConfig = existing
      ? { ...existing, hasTrustDialogAccepted: true }
      : {
          allowedTools: [],
          mcpContextUris: [],
          projectOnboardingSeenCount: 0,
          hasTrustDialogAccepted: true,
        }
    return {
      ...config,
      projects: {
        ...config.projects,
        [key]: next,
      },
    }
  })
}
