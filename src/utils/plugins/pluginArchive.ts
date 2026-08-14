/**
 * Session-only plugins delivered as a `.zip` — the `--plugin-dir <file.zip>`
 * and `--plugin-url <https://…/plugin.zip>` half that lives under
 * `src/utils/plugins/`.
 *
 * **This module executes attacker-influenced code paths by construction.** A
 * plugin is hooks, MCP server commands, and prompt content; `--plugin-url`
 * means "fetch that from the internet and load it into this session". Three
 * guards are therefore non-negotiable, and each has a test that constructs the
 * attack rather than asserting on a message:
 *
 *  1. **Source validation** ({@link assertAllowedArchiveUrl}) — HTTPS only, no
 *     embedded credentials, no redirect off the origin the user named. An
 *     `http://` plugin URL is a network-position code-execution primitive.
 *  2. **Zip slip** ({@link resolveArchiveEntryPath}) — every entry path is
 *     resolved and re-checked against the extraction root before a single byte
 *     is written. `unzipFile` already rejects `..` segments and POSIX-absolute
 *     names, but that check is a *string* test in another module: a Windows
 *     drive path (`C:\evil`) and a UNC name (`\\host\share`) both slip past
 *     `isAbsolute()` when the CLI runs on POSIX, and `join()` would then
 *     happily produce a path outside the target. Containment is checked at the
 *     sink, where it cannot be bypassed by a future change upstream.
 *  3. **Size limits** ({@link PLUGIN_ARCHIVE_LIMITS}) — the shared
 *     `src/utils/dxt/zip.ts` caps (1GB uncompressed, 100k files) are sized for
 *     trusted marketplace bundles. Network-supplied plugins get their own,
 *     much tighter budget, enforced before extraction so a zip bomb is refused
 *     rather than survived.
 *
 * The extraction target is always a fresh session temp directory, never a
 * user-named path — nothing here can overwrite a checkout even if a guard is
 * defeated.
 */

import axios from 'axios'
import { randomBytes } from 'crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { BIN_NAME } from '../../config/paths.js'
import { unzipFile } from '../dxt/zip.js'
import { RM_RECURSIVE } from '../filesystem/rmOptions.js'
import { errorMessage } from '../runtime/errors.js'
import { logForDebugging } from '../telemetry/debug.js'

/**
 * Budgets for archives the user did not author. Deliberately far below
 * `src/utils/dxt/zip.ts`' limits: those cover MCPB bundles and the official
 * marketplace mirror, which are trusted inputs. A plugin is markdown, JSON,
 * and a few scripts — anything approaching these numbers is not a plugin.
 */
export const PLUGIN_ARCHIVE_LIMITS = {
  /** Compressed bytes accepted off the wire. */
  maxDownloadBytes: 32 * 1024 * 1024,
  /** Uncompressed bytes accepted out of the archive. */
  maxUncompressedBytes: 128 * 1024 * 1024,
  /** Entry count, so "many tiny files" can't exhaust inodes or time. */
  maxEntries: 10_000,
  /** Wall clock for the download. */
  downloadTimeoutMs: 60_000,
} as const

/** Thrown for every refusal here so callers can report without leaking stacks. */
export class PluginArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginArchiveError'
  }
}

/** True for a reference that should be treated as an archive rather than a directory. */
export function isPluginArchiveRef(ref: string): boolean {
  const withoutQuery = ref.split(/[?#]/)[0] ?? ''
  return withoutQuery.toLowerCase().endsWith('.zip')
}

/** True for a reference that should be fetched rather than read off disk. */
export function isRemotePluginRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)
}

/**
 * Accept only what we are willing to execute: `https:`, no userinfo, and a
 * host. Credentials in the URL are rejected outright rather than stripped —
 * a user who wrote them expects them to be sent, and silently not sending
 * them turns an auth failure into a confusing 404.
 *
 * `http:` is refused even for localhost. The exception would exist only for
 * developer convenience, and `--plugin-dir` already covers the local case
 * without a network hop.
 */
export function assertAllowedArchiveUrl(ref: string): URL {
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    throw new PluginArchiveError(`Not a valid URL: ${ref}`)
  }
  if (url.protocol !== 'https:') {
    throw new PluginArchiveError(
      `Plugin URLs must use https (got ${url.protocol.replace(':', '') || 'no scheme'}): ${ref}`,
    )
  }
  if (url.username || url.password) {
    throw new PluginArchiveError(
      'Plugin URLs must not embed credentials. Use a pre-signed URL instead.',
    )
  }
  if (!url.hostname) {
    throw new PluginArchiveError(`Plugin URL has no host: ${ref}`)
  }
  if (!isPluginArchiveRef(url.pathname)) {
    throw new PluginArchiveError(
      `Plugin URL must point at a .zip archive: ${ref}`,
    )
  }
  return url
}

/**
 * Resolve one archive entry to an absolute path guaranteed to live inside
 * `targetDir`, or throw.
 *
 * Rejects, in order: empty names, POSIX-absolute names, Windows drive-absolute
 * and UNC names (which `path.isAbsolute` does not recognise when the CLI runs
 * on POSIX), any `..` segment, and finally anything that still resolves
 * outside the root. The last check is the one that actually holds — the
 * earlier ones exist so the error message names the real problem.
 */
export function resolveArchiveEntryPath(
  targetDir: string,
  entryName: string,
): string {
  const refuse = (why: string): never => {
    throw new PluginArchiveError(
      `Refusing archive entry "${entryName}": ${why}`,
    )
  }

  if (!entryName || entryName.trim() === '') refuse('empty path')
  // fflate always reports forward slashes; a backslash here is either a
  // Windows-authored path or a deliberate attempt to dodge a '/'-only check.
  const normalizedSeparators = entryName.replace(/\\/g, '/')
  if (normalizedSeparators.startsWith('//')) refuse('UNC path')
  if (normalizedSeparators.startsWith('/')) refuse('absolute path')
  if (/^[a-zA-Z]:/.test(normalizedSeparators)) refuse('drive-absolute path')
  if (isAbsolute(normalizedSeparators)) refuse('absolute path')
  if (normalize(normalizedSeparators).split(/[/\\]/).includes('..')) {
    refuse('path traversal')
  }

  const root = resolve(targetDir)
  const full = resolve(root, normalizedSeparators)
  const rel = relative(root, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    refuse('escapes the extraction directory')
  }
  return full
}

/**
 * Extract archive bytes into `targetDir`, enforcing this module's limits and
 * containment on every entry.
 *
 * Executable bits are deliberately *not* restored. `zipCache.ts` does restore
 * them because those archives were produced by occ itself from a git clone the
 * user installed; a downloaded plugin has no such provenance, and handing a
 * `+x` script to a hook runner is precisely the thing to avoid.
 */
export async function extractPluginArchive(
  bytes: Uint8Array,
  targetDir: string,
): Promise<void> {
  if (bytes.byteLength > PLUGIN_ARCHIVE_LIMITS.maxDownloadBytes) {
    throw new PluginArchiveError(
      `Archive is too large: ${formatBytes(bytes.byteLength)} (max ${formatBytes(PLUGIN_ARCHIVE_LIMITS.maxDownloadBytes)})`,
    )
  }

  let files: Record<string, Uint8Array>
  try {
    files = await unzipFile(Buffer.from(bytes))
  } catch (error) {
    throw new PluginArchiveError(
      `Could not read archive: ${errorMessage(error)}`,
    )
  }

  const entries = Object.entries(files)
  if (entries.length > PLUGIN_ARCHIVE_LIMITS.maxEntries) {
    throw new PluginArchiveError(
      `Archive has too many entries: ${entries.length} (max ${PLUGIN_ARCHIVE_LIMITS.maxEntries})`,
    )
  }

  // Validate every entry before writing any of them. A half-extracted archive
  // that is then rejected leaves a directory the loader might still read.
  let totalBytes = 0
  const planned: Array<{ path: string; data: Uint8Array }> = []
  for (const [name, data] of entries) {
    if (name.endsWith('/')) {
      // Directory entry: still path-checked, but contributes no bytes.
      resolveArchiveEntryPath(targetDir, name.slice(0, -1))
      continue
    }
    totalBytes += data.byteLength
    if (totalBytes > PLUGIN_ARCHIVE_LIMITS.maxUncompressedBytes) {
      throw new PluginArchiveError(
        `Archive expands to more than ${formatBytes(PLUGIN_ARCHIVE_LIMITS.maxUncompressedBytes)}`,
      )
    }
    planned.push({ path: resolveArchiveEntryPath(targetDir, name), data })
  }

  await mkdir(targetDir, { recursive: true })
  for (const { path, data } of planned) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data, { mode: 0o600 })
  }

  logForDebugging(
    `Extracted plugin archive to ${targetDir}: ${planned.length} files, ${formatBytes(totalBytes)}`,
  )
}

/**
 * Download an archive, refusing anything oversized or served from an origin
 * the user did not name.
 *
 * `maxRedirects: 0` is the source check that matters: a redirect chain is how
 * `https://trusted.example/x.zip` becomes bytes from somewhere else, and the
 * URL the user vetted is the only one this should ever read from. Callers that
 * need a redirect can pass the final URL.
 */
export async function downloadPluginArchive(
  ref: string,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const url = assertAllowedArchiveUrl(ref)

  let response
  try {
    response = await axios.get<ArrayBuffer>(url.toString(), {
      responseType: 'arraybuffer',
      maxRedirects: 0,
      maxContentLength: PLUGIN_ARCHIVE_LIMITS.maxDownloadBytes,
      maxBodyLength: PLUGIN_ARCHIVE_LIMITS.maxDownloadBytes,
      timeout: PLUGIN_ARCHIVE_LIMITS.downloadTimeoutMs,
      signal: options.signal,
      // Treat redirects as an error we can describe, not an axios throw with
      // an opaque message.
      validateStatus: status => status >= 200 && status < 300,
    })
  } catch (error) {
    throw new PluginArchiveError(
      `Could not download ${url.toString()}: ${errorMessage(error)}`,
    )
  }

  const bytes = new Uint8Array(response.data)
  if (bytes.byteLength === 0) {
    throw new PluginArchiveError(`Downloaded archive is empty: ${url}`)
  }
  if (bytes.byteLength > PLUGIN_ARCHIVE_LIMITS.maxDownloadBytes) {
    throw new PluginArchiveError(
      `Archive is too large: ${formatBytes(bytes.byteLength)} (max ${formatBytes(PLUGIN_ARCHIVE_LIMITS.maxDownloadBytes)})`,
    )
  }
  if (!hasZipMagic(bytes)) {
    throw new PluginArchiveError(
      `${url} did not return a ZIP archive (wrong content, or an HTML error page)`,
    )
  }
  return bytes
}

/** PKZIP local-file-header magic. Catches an HTML error page served with a 200. */
function hasZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  )
}

/**
 * Locate the plugin root inside an extracted tree.
 *
 * Archives produced by `git archive` or GitHub's "Download ZIP" wrap
 * everything in a single top-level directory, so the manifest is one level
 * down. Only that one extra level is searched: a deeper walk would start
 * guessing which of several plugins in a monorepo the user meant.
 */
export async function findExtractedPluginRoot(
  extractedDir: string,
): Promise<string> {
  if (await hasManifest(extractedDir)) return extractedDir

  const { readdir } = await import('fs/promises')
  const entries = await readdir(extractedDir, { withFileTypes: true })
  const dirs = entries.filter(e => e.isDirectory())
  if (dirs.length === 1) {
    const nested = join(extractedDir, dirs[0]!.name)
    if (await hasManifest(nested)) return nested
  }

  throw new PluginArchiveError(
    'Archive does not contain a plugin: no .claude-plugin/plugin.json at the root or in a single top-level directory',
  )
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, '.claude-plugin', 'plugin.json'))).isFile()
  } catch {
    return false
  }
}

// Session-scoped extraction root, cleaned up by cleanupPluginArchives().
let archiveRoot: string | null = null

async function getArchiveRoot(): Promise<string> {
  if (!archiveRoot) {
    const dir = join(
      tmpdir(),
      `${BIN_NAME}-plugin-archive-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dir, { recursive: true, mode: 0o700 })
    archiveRoot = dir
  }
  return archiveRoot
}

/** Remove everything this module extracted this session. */
export async function cleanupPluginArchives(): Promise<void> {
  if (!archiveRoot) return
  const dir = archiveRoot
  archiveRoot = null
  await rm(dir, RM_RECURSIVE).catch(() => {})
}

/** Test seam: forget the session root without touching disk. */
export function resetPluginArchiveRootForTesting(): void {
  archiveRoot = null
}

/**
 * Turn one `--plugin-dir` / `--plugin-url` reference into a plugin directory.
 *
 * Plain directories pass through untouched — this is the single funnel the
 * flag handlers call, so they never have to branch on "is it a zip".
 */
export async function materializePluginRef(
  ref: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (!isPluginArchiveRef(ref)) {
    if (isRemotePluginRef(ref)) {
      throw new PluginArchiveError(
        `Remote plugins must be a .zip archive: ${ref}`,
      )
    }
    return ref
  }

  const bytes = isRemotePluginRef(ref)
    ? await downloadPluginArchive(ref, options)
    : new Uint8Array(await readFile(ref))

  const root = await getArchiveRoot()
  const dest = join(root, randomBytes(6).toString('hex'))
  await extractPluginArchive(bytes, dest)
  return findExtractedPluginRoot(dest)
}

/**
 * Resolve a whole `--plugin-dir` / `--plugin-url` list to directories.
 *
 * Returns errors instead of throwing: one bad archive must not stop the
 * session from starting with the plugins that did load, which is how
 * `loadSessionOnlyPlugins` already treats a missing directory.
 */
export async function materializePluginRefs(
  refs: string[],
  options: { signal?: AbortSignal } = {},
): Promise<{ dirs: string[]; errors: Array<{ ref: string; error: string }> }> {
  const dirs: string[] = []
  const errors: Array<{ ref: string; error: string }> = []
  for (const ref of refs) {
    try {
      dirs.push(await materializePluginRef(ref, options))
    } catch (error) {
      errors.push({ ref, error: errorMessage(error) })
      logForDebugging(
        `Plugin archive ${ref} rejected: ${errorMessage(error)}`,
        {
          level: 'warn',
        },
      )
    }
  }
  return { dirs, errors }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${Math.round(bytes / 1024 / 1024)}MB`
}
