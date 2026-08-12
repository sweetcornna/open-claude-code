/**
 * Guards applied to every byte that crosses from a foreign agent's config into
 * occ. Nothing in `occ import` may bypass these.
 *
 * The threat model is not "the user is malicious" — it is that `~/.codex` and
 * `~/.gemini` are written by other tools, syncable across machines, and (for
 * the project-scope halves) authored by anyone with push access to the repo
 * the user just cloned. So:
 *
 *   - names become filenames, therefore `toSafeName()`;
 *   - paths from the config are resolved against a base and re-checked,
 *     therefore `containedPath()` / `containedRealPath()`;
 *   - symlinked components can redirect a write outside the base after the
 *     check, therefore `hasNoSymlinkComponent()`;
 *   - labels and descriptions end up in a terminal AND in a model prompt,
 *     therefore `displayLabel()` / `displayDetail()`.
 *
 * occ additionally never EXECUTES anything it read, and never evaluates a
 * config value; every import path is data-in / data-out.
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Refuse to read anything larger than this from a foreign config tree. A
 * runaway file is not worth OOMing the CLI over, and nothing legitimate in
 * `~/.codex` or `~/.gemini` is remotely this big.
 */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024

/**
 * Turn an arbitrary name from a foreign config into something safe to use as a
 * filename and as a slash-command name.
 *
 * The three rules, in order and each load-bearing:
 *   1. everything outside `[A-Za-z0-9_-]` becomes `_` — this is also exactly
 *      the character class occ's MCP server-name validation accepts, so a name
 *      that survives here cannot be rejected downstream;
 *   2. runs of three or more hyphens become underscores — `---` at the start of
 *      a generated markdown file opens a YAML frontmatter block;
 *   3. leading hyphens collapse to one `_` so the name cannot be read as a flag.
 */
export function toSafeName(raw: string): string {
  return (
    raw
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/-{3,}/g, run => '_'.repeat(run.length))
      .replace(/^-+/, '_') || '_'
  )
}

/**
 * A frontmatter `description:` must not be able to close the frontmatter block.
 */
export function safeFrontmatterText(raw: string): string {
  return raw.replace(/-{3,}/g, '—')
}

/**
 * Resolve `relativePath` against `base` and return it only if the result is
 * strictly inside `base`. Returns null otherwise (including for `base` itself).
 *
 * Purely lexical — pair it with `containedRealPath` or
 * `hasNoSymlinkComponent` whenever the path will actually be opened.
 */
export function containedPath(
  base: string,
  relativePath: string,
): string | null {
  const target = resolve(base, relativePath)
  const rel = relative(base, target)
  if (
    rel === '' ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${sep}`)
  ) {
    return null
  }
  // Guards against a `rel` that re-resolves elsewhere (e.g. odd separators).
  if (resolve(base, rel) !== target) return null
  return target
}

/**
 * `containedPath`, then re-checked after resolving symlinks on both ends.
 * Used before READING a path that the foreign config chose.
 */
export async function containedRealPath(
  base: string,
  relativePath: string,
): Promise<string | null> {
  const target = containedPath(base, relativePath)
  if (target === null) return null
  try {
    const realBase = await realpath(base)
    const realTarget = await realpath(target)
    return containedPath(realBase, relative(realBase, realTarget))
  } catch {
    return null
  }
}

/**
 * Walk every component of `target` and return null if ANY of them is a
 * symlink. Used before WRITING into a directory the user did not choose (the
 * project-scope halves), where a symlinked component is a redirect out of the
 * repo. A component that does not exist yet is fine — it cannot be a symlink.
 */
export async function hasNoSymlinkComponent(
  base: string,
  target: string,
): Promise<string | null> {
  const resolved = resolve(target)
  const rel = relative(resolve(base), resolved)
  if (
    rel !== '' &&
    (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
  ) {
    return null
  }
  const segments = rel === '' ? [] : rel.split(sep)
  let current = resolve(base)
  for (const segment of ['', ...segments]) {
    current = segment === '' ? current : resolve(current, segment)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) return null
    } catch {
      // Does not exist yet: no symlink here, and nothing below it either.
      return resolved
    }
  }
  return resolved
}

/**
 * Read a file, refusing anything over `MAX_IMPORT_FILE_BYTES`.
 * Throws for a missing file so callers can distinguish "absent" from "huge".
 */
export async function readCappedText(path: string): Promise<string> {
  const stats = await stat(path)
  if (stats.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error(
      `file exceeds ${MAX_IMPORT_FILE_BYTES} bytes; refusing to load`,
    )
  }
  return readFile(path, 'utf8')
}

export function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Does this text contain a Claude Code shell-exec marker?
 *
 * The markers are INERT in Codex prompt files and LIVE in occ commands, so
 * copying such a file verbatim would silently turn documentation into a
 * command that runs on invocation. Anything matching is held back.
 */
export function hasShellExecMarker(text: string): boolean {
  return text.includes('```!') || /(?<=^|\s)!`[^`]+`/m.test(text)
}

/**
 * Strip control characters and collapse a value to one printable line.
 * Everything untrusted goes through this before it reaches a terminal or a
 * model prompt: a raw label could otherwise carry ANSI escapes, line
 * separators, or enough text to push the real content out of view.
 */
function sanitiseForDisplay(raw: string, maxLength: number): string {
  const cleaned = raw
    .replace(/\p{C}|\p{DI}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 1)}…`
}

/** For item labels and other short untrusted strings. */
export function displayLabel(raw: string): string {
  return sanitiseForDisplay(raw, 120)
}

/** For descriptions, skip reasons and error text. */
export function displayDetail(raw: string): string {
  return sanitiseForDisplay(raw, 500)
}
