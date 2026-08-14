/**
 * Default artifact backend: write the rendered page to disk and hand back a
 * `file://` URL the user can open directly.
 *
 * The directory is derived from `occConfigPath()` so it follows
 * `OCC_CONFIG_DIR`/`CLAUDE_CONFIG_DIR` like every other occ path, and so
 * artifacts never land inside the user's working tree.
 *
 * No TTL: files written here are never swept. `ttlDays` is accepted (the store
 * interface is shared with the remote backends) and deliberately ignored.
 */
import { randomBytes } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { occConfigPath } from 'src/config/paths.js'
// From types.js, not store.js: store.js imports this module, so a type import
// pointing back at it would close a new import cycle.
import type { ArtifactStore } from './types.js'

/** Same charset the Worker enforces, so an id is portable between backends. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** `<occ config dir>/artifacts` — stable across runs, honours OCC_CONFIG_DIR. */
export function getLocalArtifactsDir(): string {
  return occConfigPath('artifacts')
}

/** True for a URL produced by this store, i.e. an on-disk artifact. */
export function isLocalArtifactUrl(url: string): boolean {
  return url.startsWith('file://')
}

/** 96 bits, base64url so the id is filename- and URL-safe. */
function generateId(): string {
  return randomBytes(12).toString('base64url')
}

export const localStore: ArtifactStore = {
  async upload({ html, hash }) {
    const id = hash ?? generateId()
    // The tool's zod schema already enforces this, but the store is a separate
    // entry point and `id` becomes a path segment.
    if (!ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid artifact hash: ${id}. Must match ${ID_PATTERN.source}.`,
      )
    }

    const dir = getLocalArtifactsDir()
    const filePath = join(dir, `${id}.html`)
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(filePath, html, 'utf8')
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      throw new Error(`Failed to write artifact to ${filePath}: ${detail}`)
    }

    return { id, url: pathToFileURL(filePath).href, expiresAt: undefined }
  },
}
