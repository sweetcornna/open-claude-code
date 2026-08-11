/**
 * Spawning npm / bun / npx portably.
 *
 * Kept dependency-free so any layer can import it without touching the cycle
 * ratchet.
 */

/**
 * Spawn options that let a package-manager binary actually start on Windows.
 *
 * npm, npx and bun ship as `.cmd` shims there, and CreateProcess cannot execute
 * a batch file — `spawn('npm', …)` fails with ENOENT. Node's documented
 * workaround is `shell: true`, which routes the call through cmd.exe.
 *
 * That means argv reaches a shell, so anything user-supplied must be validated
 * first: see `isSafeVersionSpec`. `windowsHide` keeps the cmd.exe console from
 * flashing over the TUI (it defaults to false in child_process, unlike execa).
 */
export function packageManagerSpawnOptions(): {
  shell: boolean
  windowsHide: boolean
} {
  return { shell: process.platform === 'win32', windowsHide: true }
}

/**
 * True for a version or dist-tag that is safe to interpolate into an install
 * spec such as `pkg@1.2.3`.
 *
 * On Windows that spec is parsed by cmd.exe (see `packageManagerSpawnOptions`),
 * where a value like `1.0.0 & calc` would run a second command. Restricting to
 * the characters npm versions and dist-tags actually use — alphanumerics plus
 * `.`, `+`, `-`, and never leading with a separator — closes that without
 * rejecting anything legitimate (`1.2.3`, `2.0.0-beta.1`, `1.0.0+build.5`,
 * `latest`, `next`).
 */
export function isSafeVersionSpec(spec: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(spec)
}

/**
 * True for a registry URL that is safe to put on an `install -g` command line.
 *
 * Same hazard as `isSafeVersionSpec`, one step further out: on Windows the
 * spawn goes through cmd.exe (see `packageManagerSpawnOptions`) and `occ
 * update` shells out directly, so `https://x/&calc` would run a second
 * command. Registry URLs are also read from places occ does not own — npmrc,
 * bunfig, environment — so "it came from config" is not a reason to trust it.
 *
 * The allowed set is what registry URLs actually contain (scheme, host, port,
 * path, percent-escapes, and the userinfo separators private registries use);
 * every shell metacharacter, quote, backslash and space is excluded.
 */
export function isSafeRegistryUrl(url: string): boolean {
  if (!/^https?:\/\/[A-Za-z0-9._~:@\-/%]+$/.test(url)) return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** Batch wrappers Windows cannot hand straight to CreateProcess. */
const WINDOWS_SHIM_EXTENSIONS = ['.cmd', '.bat']

/**
 * True when `command` can only be started through a shell.
 *
 * npm installs its bin entries as `.cmd` shims on Windows. CreateProcess cannot
 * execute a batch file, and since CVE-2024-27980 Node refuses to try, so
 * `spawn('typescript-language-server')` fails outright there. A shell is the
 * documented way to launch one.
 *
 * Deliberately narrow: a shell re-parses the command line, so this must not
 * turn on for native executables or for anything on POSIX. Extension-less
 * names count on Windows because PATHEXT resolution usually lands on a `.cmd`.
 */
export function needsShellToLaunch(command: string): boolean {
  if (process.platform !== 'win32') return false
  const lower = command.toLowerCase()
  if (WINDOWS_SHIM_EXTENSIONS.some(ext => lower.endsWith(ext))) return true
  // No extension at all — PATHEXT decides, and for npm bins that means .cmd.
  return !/\.[a-z0-9]+$/.test(lower)
}
