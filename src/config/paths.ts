/**
 * Single source of truth for every path open-claude-code (occ) reads or writes.
 *
 * WHY THIS EXISTS
 *
 * occ is a separate product from Anthropic's official Claude Code, and the two
 * must be able to run on the same machine without touching each other's state.
 * Before this module the fork shared essentially the whole official namespace:
 * `~/.claude/`, `~/.claude.json`, the `claude-cli` cache tree, the XDG
 * `claude/` install tree, and — worst of all — the same macOS keychain entry,
 * so logging into one CLI could overwrite the other's OAuth token.
 *
 * Every path must be derived here. Do not write `join(homedir(), '.claude')`
 * or `join(homedir(), '.occ')` anywhere else: nine such call sites existed
 * before this module and every one of them silently ignored the config-dir
 * override, which is why `CLAUDE_CONFIG_DIR` isolation was already leaky.
 *
 * ENV PRECEDENCE
 *
 * `OCC_CONFIG_DIR` is the canonical override. `CLAUDE_CONFIG_DIR` is still
 * honoured as a deprecated fallback so that existing scripts, CI jobs and the
 * ~50 test files that set it keep working; it will be dropped in a later
 * release. Neither is consulted if the caller passes an explicit path.
 */

import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join, resolve } from 'path'

/**
 * Directory name for project-level assets (settings, skills, agents,
 * commands, workflows, mcp.json) discovered by walking up from the cwd.
 */
export const PROJECT_DIR_NAME = '.occ'

/**
 * Directory name the official Claude Code uses for the same purpose. Read-only:
 * used by the first-run migration and by compatibility fallbacks, never written.
 */
export const LEGACY_PROJECT_DIR_NAME = '.claude'

/** Both executable project-config roots must remain protected from writes. */
export const PROJECT_CONFIG_DIR_NAMES = [
  PROJECT_DIR_NAME,
  LEGACY_PROJECT_DIR_NAME,
] as const

/** Basename of the user-level config root, under the home directory. */
export const CONFIG_DIR_BASENAME = '.occ'

/**
 * Re-exported from `src/constants/brand.ts` so path code has one import.
 *
 * The binary name is an isolation concern, not just cosmetics: installing occ
 * under the name `claude` would overwrite the official CLI's binary on PATH.
 * brand.ts has no imports of its own, so pulling it in here is safe for the
 * startup keychain prefetch (see macOsKeychainHelpers.ts).
 */
export { BIN_NAME } from '../constants/brand.js'

/**
 * Namespace for the `env-paths` cache tree (`~/.cache/occ-nodejs` on Linux).
 * Was `claude-cli`, i.e. shared with the official CLI.
 */
export const CACHE_NAMESPACE = 'occ'

/** Subdirectory used inside the XDG data/cache/state roots. */
export const XDG_SUBDIR = 'occ'

/** The official Claude Code config root basename. Read-only, for migration. */
export const LEGACY_CONFIG_DIR_BASENAME = '.claude'

function configDirKey(): string {
  // Memo key must cover both vars, or a test that swaps one would read a
  // stale value cached under the other.
  return `${process.env.OCC_CONFIG_DIR ?? ''}\u0000${process.env.CLAUDE_CONFIG_DIR ?? ''}`
}

/**
 * User-level config root: `~/.occ` unless overridden.
 *
 * Holds settings.json, .credentials.json, projects/, skills/, agents/,
 * commands/, plugins/, mcp.json, logs/, todos/, shell-snapshots/.
 *
 * Memoized because this sits on hot startup paths with ~120 callers.
 */
export const occConfigDir = memoize((): string => {
  const configured = process.env.OCC_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  return (
    configured ? resolve(configured) : join(homedir(), CONFIG_DIR_BASENAME)
  ).normalize('NFC')
}, configDirKey)

/**
 * The official Claude Code config root. Only the first-run migration and
 * `occ doctor` may read this; nothing may ever write to it.
 */
export function legacyClaudeConfigDir(): string {
  return join(homedir(), LEGACY_CONFIG_DIR_BASENAME).normalize('NFC')
}

/** Resolve a path inside the occ config root. */
export function occConfigPath(...segments: string[]): string {
  return join(occConfigDir(), ...segments)
}

/** Config roots that sandboxed shell commands must never modify. */
export function getProtectedConfigDirectories(
  workingDirectories: readonly string[],
): string[] {
  const projectDirectories = workingDirectories.flatMap(directory =>
    PROJECT_CONFIG_DIR_NAMES.map(projectConfigDirectory =>
      resolve(directory, projectConfigDirectory),
    ),
  )
  return [
    ...new Set([
      occConfigDir(),
      legacyClaudeConfigDir(),
      ...projectDirectories,
    ]),
  ]
}

/** Basename of the global state file, without the `.json` extension. */
export const GLOBAL_CONFIG_BASENAME = '.occ'

/**
 * Global state file: `~/.occ.json`, holding mcpServers, per-project state,
 * cached Statsig gates and the OAuth account record.
 *
 * Note the deliberately odd shape, inherited from the original: when no config
 * dir is set this file is a SIBLING of the config directory (`~/.occ.json`
 * next to `~/.occ/`), but when one is set it lives INSIDE it. Preserved so a
 * caller who overrides the dir gets everything in one place.
 *
 * `oauthSuffix` is passed in rather than imported so this module stays free of
 * `src/constants/oauth.ts` — `macOsKeychainHelpers.ts` pulls this file during
 * the startup keychain prefetch and must not drag in extra module init.
 */
export function occGlobalConfigFile(oauthSuffix: string = ''): string {
  const configured = process.env.OCC_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  const base = configured ? resolve(configured) : homedir()
  return join(base, `${GLOBAL_CONFIG_BASENAME}${oauthSuffix}.json`)
}
