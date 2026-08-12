/**
 * Web search's own copies of the two OAuth login files.
 *
 * WHY A COPY AND NOT A KEY
 *
 * `search-credentials.json` (searchCredentialStore.ts) pins an API key, and
 * that is all it can pin: `captureCredential.ts` refuses an access token
 * because those expire within the hour, so a copied one would be a dead secret
 * on disk within the hour. But two search sources authenticate with no key at
 * all — `gemini` through Antigravity (Google OAuth) and `codex` through a
 * ChatGPT login — and both live in a 0600 file of occ's own that `/logout`
 * DELETES. Search then degrades to the keyless scraping lane, silently, which
 * is the exact failure the pin store was built to end.
 *
 * The thing worth keeping is therefore not the access token but the file: it
 * carries the refresh token, which is what mints new access tokens after the
 * login it came from is gone. So a "pinned OAuth credential" is a copy of the
 * authorization file, with the same schema, under a name the account plane does
 * not know about.
 *
 * THE COPY'S EXISTENCE IS THE WHOLE MARKER
 *
 * No new field, no v2 of `search-credentials.json` — that file's format is
 * untouched. "Is this source's login pinned?" is answered by `existsSync` on a
 * path, which keeps the question synchronous (the panel asks it per render) and
 * keeps the two stores from having to agree about anything.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT KNOW
 *
 * Where the login files it copies FROM live. The source path is a parameter,
 * so this module imports neither `chatgptAuth.ts` nor the Antigravity store —
 * both of which have to import the copy PATH from here, to read and refresh
 * through it. Handing them a module that imported them back would close a
 * cycle. `autoPin.ts` owns the source-path mapping instead.
 *
 * ISOLATION: `occConfigPath()`, 0600, `writePrivateFileAtomic` — the same rules
 * as every other occ credential file. Never `~/.claude`, never a bare
 * `homedir()` join, and never `settings.json`.
 */

import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, unlink } from 'fs/promises'
import { occConfigDir, occConfigPath } from 'src/config/paths.js'
import { writePrivateFileAtomic } from 'src/utils/secureStorage/atomicWrite.js'

/**
 * The search sources whose credential is a login rather than a key.
 *
 * A subset of `SearchCredentialFamily` on purpose: `anthropic` and `deepseek`
 * have no occ-owned OAuth file to copy. The Claude subscription login is a
 * keychain record shared with the official CLI (CLAUDE.md's first isolation
 * rule), and copying a keychain entry into a file would be a downgrade of its
 * storage, not a pin.
 */
export const SEARCH_OAUTH_FAMILIES = ['gemini', 'codex'] as const

export type SearchOAuthFamily = (typeof SEARCH_OAUTH_FAMILIES)[number]

/**
 * Named after the login they hold, not after the search source, because that is
 * what a user finding one in `~/.occ` needs to recognise: the `gemini` source's
 * login is an Antigravity (Google) one, and `codex`'s is ChatGPT's.
 */
const COPY_FILES: Record<SearchOAuthFamily, string> = {
  gemini: 'search-oauth-antigravity.json',
  codex: 'search-oauth-chatgpt.json',
}

export function isSearchOAuthFamily(
  family: string,
): family is SearchOAuthFamily {
  return (SEARCH_OAUTH_FAMILIES as readonly string[]).includes(family)
}

/** Where this source's copied login lives. */
export function searchOAuthCopyPath(family: SearchOAuthFamily): string {
  return occConfigPath(COPY_FILES[family])
}

/**
 * Whether this source's login has been copied.
 *
 * Presence only — no parse. The readers (`chatgptAuth.ts`, the Antigravity
 * store) validate the contents, and a file that exists but is unusable has to
 * reach them to be reported as such; answering "not pinned" here would instead
 * make the panel offer a pin that is already there.
 */
export function hasSearchOAuthCopy(family: SearchOAuthFamily): boolean {
  return existsSync(searchOAuthCopyPath(family))
}

/** Which sources currently hold a copied login. Never the contents. */
export function listSearchOAuthCopies(): SearchOAuthFamily[] {
  return SEARCH_OAUTH_FAMILIES.filter(hasSearchOAuthCopy)
}

/** What one sync pass did. */
export type SearchOAuthCopyOutcome =
  /** There was no copy; the login file has now been copied. */
  | 'copied'
  /** A copy existed and the login file had moved on; they match again. */
  | 'synced'
  /** Already byte-identical. Nothing was written. */
  | 'unchanged'
  /** No login file to copy — nobody is logged in to this source. */
  | 'absent'

/**
 * Make this source's copy match the login file at `sourcePath`.
 *
 * COMPARES BEFORE WRITING, and that is not an optimisation. This runs on every
 * startup, and both login files carry a `last_refresh` timestamp, so an
 * unconditional copy would rewrite a credential file several times a session
 * and leave an mtime that says nothing about when the login was pinned. The
 * comparison is on the raw bytes rather than on parsed tokens: any difference —
 * a refreshed access token, a project id discovered later, a re-login as a
 * different account — is a reason to re-copy, and enumerating them is how one
 * gets missed.
 *
 * Deliberately NOT `copyFile`: that would create the destination with the
 * source's mode and without the atomic rename, so a crash mid-copy would leave
 * a truncated credential file where a valid one used to be.
 */
export async function syncSearchOAuthCopy(
  family: SearchOAuthFamily,
  sourcePath: string,
): Promise<SearchOAuthCopyOutcome> {
  let source: string
  try {
    source = await readFile(sourcePath, 'utf8')
  } catch {
    // Not logged in, or the file is unreadable. Either way there is nothing to
    // copy, and an existing copy is left exactly as it is — that copy is the
    // whole point: it outlives the login file's deletion.
    return 'absent'
  }
  const path = searchOAuthCopyPath(family)
  let existing: string | undefined
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === source) return 'unchanged'
  await mkdir(occConfigDir(), { recursive: true })
  await writePrivateFileAtomic(path, source)
  return existing === undefined ? 'copied' : 'synced'
}

/** Drop this source's copied login. Returns whether there was one. */
export async function removeSearchOAuthCopy(
  family: SearchOAuthFamily,
): Promise<boolean> {
  let removed = true
  await unlink(searchOAuthCopyPath(family)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      removed = false
      return
    }
    throw error
  })
  return removed
}

/**
 * The copy's raw contents, or undefined.
 *
 * Synchronous because the one caller that needs it is a synchronous credential
 * probe (`hasStoredChatGPTAuthSync`), which the search-source resolver runs
 * inside a factory that cannot await.
 */
export function readSearchOAuthCopySync(
  family: SearchOAuthFamily,
): string | undefined {
  try {
    return readFileSync(searchOAuthCopyPath(family), 'utf8')
  } catch {
    return undefined
  }
}
