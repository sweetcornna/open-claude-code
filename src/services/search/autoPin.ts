/**
 * Pinning a web-search credential without being asked for it.
 *
 * WHY THIS IS THE DEFAULT
 *
 * `/search-setting`'s `S` already copies the credential a source is
 * authenticating with into occ's own 0600 store, where `/logout` and
 * `activateProfile()` cannot reach it (searchCredentialStore.ts explains what
 * those two do to the provider env). The problem was never that the action did
 * not work — it was that nothing prompts anyone to press it. Web search
 * degrading to the keyless scraping lane is silent by construction: the tool
 * keeps answering, just worse, so the one moment a user would think to open
 * this panel never arrives. A remedy that has to be discovered before the
 * damage is not a remedy for the failure it was written for.
 *
 * So the capture runs on its own, at every point where the environment is known
 * to hold the credential the lane is using, and the panel keeps `S` as the way
 * back for anyone who switched it off.
 *
 * TWO CREDENTIALS, ONE OPT-OUT
 *
 * A source can authenticate with an API key, with an OAuth login, or with both,
 * and each is kept its own way:
 *
 *   - The key is COPIED OUT of the environment into `search-credentials.json`
 *     (searchCredentialStore.ts).
 *   - The login is copied FILE AND ALL into web search's own credential file
 *     (oauthCopies.ts), because what is worth keeping is the refresh token, not
 *     the access token that expires within the hour.
 *
 * Both run on every pass, because a session holding both would otherwise pin
 * one and lose the other on the next `/logout`. `webSearchAutoPin.<family>` is
 * a statement about the SOURCE and switches off both.
 *
 * WHAT MAKES THIS SAFE TO DO SILENTLY
 *
 * Nothing here decides what a key is — `captureSearchCredentialFromEnvironment`
 * does, and it refuses everything that would be wrong to store: a bare access
 * token, another provider's secret mirrored onto a provider-shaped env var (the
 * DeepSeek and OpenCode wires both do this), a key aimed at an endpoint that
 * does not run the lane's search. Automatic capture inherits every one of those
 * refusals rather than re-deriving a looser rule, which is why this module
 * reads as thin as it does. An unpinnable environment is the overwhelmingly
 * common outcome, and it is a no-op, not an error.
 *
 * The login copy needs no such judgement: it copies a file occ itself wrote,
 * byte for byte, into another file occ owns at the same 0600. There is no
 * chance of mistaking somebody else's secret for this one, which is exactly why
 * the thing the key path refuses to touch is safe here.
 *
 * WHAT IT WILL NOT DO
 *
 * - Write when nothing changed. A pin whose key and endpoint already match what
 *   the environment offers is left exactly as it is, `pinnedAt` included: this
 *   runs on every startup, and a file that churns its timestamp on each one is
 *   a file whose mtime says nothing. The login copy compares raw bytes for the
 *   same reason.
 * - Override a decision. `webSearchAutoPin.<family> = false` — written by the
 *   panel's `D` — is the only stored state, so "off" is always something the
 *   user did, and absent means the default.
 * - Throw. It is called fire-and-forget from startup and from a form's save
 *   path; a failed write is a debug line and a result row, never an exception
 *   into a caller that has no way to handle it. That is a structural promise,
 *   not an observation about today's dependencies — `runAutoPin` says where it
 *   is kept and why the settings read has to be inside it.
 */

import type { SearchCredentialFamily } from '@open-claude-code/tool-runtime/searchCredentials.js'
import { existsSync } from 'fs'
import { chatgptAuthFilePath } from 'src/services/api/openai/chatgptAuth.js'
import { antigravityAuthFilePath } from 'src/services/auth/antigravity/store.js'
import { errorMessage } from 'src/utils/runtime/errors.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from 'src/utils/settings/settings.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { captureSearchCredentialFromEnvironment } from './captureCredential.js'
import {
  isSearchOAuthFamily,
  removeSearchOAuthCopy,
  type SearchOAuthCopyOutcome,
  type SearchOAuthFamily,
  syncSearchOAuthCopy,
} from './oauthCopies.js'
import {
  PINNABLE_SEARCH_SOURCES,
  pinSearchCredential,
  readPinnedSearchCredential,
} from './searchCredentialStore.js'

/**
 * Per-source opt-outs, as stored under `webSearchAutoPin` in settings.json.
 *
 * Explicit choices only, exactly like `webSearchSources`: an absent source
 * follows the default (pin it), so a fresh install has nothing here and a user
 * who never opens the panel never grows the key.
 */
export type SearchAutoPinOverrides = Partial<
  Record<SearchCredentialFamily, boolean>
>

type SettingsWithAutoPin = {
  webSearchAutoPin?: SearchAutoPinOverrides
}

export type SearchAutoPinAction =
  /** Nothing was pinned for this source; the captured credential now is. */
  | 'pinned'
  /** A pin existed and the environment had moved on; it now matches again. */
  | 'refreshed'
  /** Already identical, down to the endpoint. Nothing was written. */
  | 'unchanged'
  /** `webSearchAutoPin.<family>` is false — the user pressed D. */
  | 'opted-out'
  /** The capture refused: no key, an OAuth login, a mirrored secret, … */
  | 'nothing-to-capture'
  /** The store could not be written. Swallowed; reported here. */
  | 'failed'

/**
 * What happened to this source's OAuth login, which is a different credential
 * from the API key `action` is about — a source can have both, and a session
 * that pins a key must still keep the login that would serve the lane after
 * that key is rotated away.
 *
 * Always present, like `action`, so every lookup on a result is total: the two
 * key-only families answer `'unsupported'` rather than leaving the field
 * undefined, which the union does not describe.
 */
export type SearchOAuthPinAction =
  /** No copy existed; this source's login file has now been copied. */
  | 'oauth-copied'
  /** A copy existed and the login had moved on; they match again. */
  | 'oauth-synced'
  /** Already byte-identical. Nothing was written. */
  | 'oauth-unchanged'
  /** Nobody is logged in to this source, so there was no file to copy. */
  | 'oauth-absent'
  /** `webSearchAutoPin.<family>` is false — the same opt-out the key obeys. */
  | 'oauth-opted-out'
  /** This source has no occ-owned login file (see SEARCH_OAUTH_FAMILIES). */
  | 'oauth-unsupported'
  /** The copy could not be written. Swallowed; reported here. */
  | 'oauth-failed'

export type SearchAutoPinResult = {
  family: SearchCredentialFamily
  action: SearchAutoPinAction
  oauth: SearchOAuthPinAction
  /** Why, for the two actions that have a reason worth reading. */
  detail?: string
}

/**
 * The opt-outs as the user's own settings hold them.
 *
 * Deliberately `userSettings` rather than the merged view: this is a statement
 * about one person's credential store, and a project checkout has no business
 * deciding whether the machine it was cloned onto keeps a key.
 */
export function readSearchAutoPinOverrides(): SearchAutoPinOverrides {
  const settings = getSettingsForSource(
    'userSettings',
  ) as unknown as SettingsWithAutoPin | null
  const raw = settings?.webSearchAutoPin
  return raw && typeof raw === 'object' ? raw : {}
}

/** Whether this source may still be pinned automatically. */
export function isSearchAutoPinEnabled(
  family: SearchCredentialFamily,
  overrides: SearchAutoPinOverrides = readSearchAutoPinOverrides(),
): boolean {
  return overrides[family] !== false
}

/**
 * Record an opt-out, or clear one.
 *
 * Patches only the one nested key, for the reason `writeOverride` in
 * `/search-setting` gives about `webSearchSources`: rewriting the whole block
 * from a render-time snapshot lets a stale copy erase a sibling source's
 * choice. Re-enabling therefore deletes the key (the settings merge reads
 * `undefined` as a deletion) rather than storing `true`, so the file only ever
 * carries the decisions that differ from the default — at the cost of leaving
 * an empty `webSearchAutoPin: {}` behind once the last opt-out is cleared,
 * which is the price of not touching sibling keys we did not read.
 *
 * Throws on a settings-write failure — every caller is an interactive keypress
 * with somewhere to put the message.
 */
export function setSearchAutoPinEnabled(
  family: SearchCredentialFamily,
  enabled: boolean,
): void {
  const { error } = updateSettingsForSource('userSettings', {
    webSearchAutoPin: { [family]: enabled ? undefined : false },
  } as unknown as Parameters<typeof updateSettingsForSource>[1])
  if (error) throw error
}

function sameCredential(
  pinned: { apiKey: string; baseURL?: string } | undefined,
  captured: { apiKey: string; baseURL?: string },
): boolean {
  return (
    pinned !== undefined &&
    pinned.apiKey === captured.apiKey &&
    pinned.baseURL === captured.baseURL
  )
}

/**
 * The login file each OAuth-backed source authenticates from.
 *
 * The mapping lives here rather than in `oauthCopies.ts` because that module is
 * imported BY both auth modules (they read and refresh through the copy path it
 * owns); knowing where their login files are would close a cycle. This module
 * is a policy layer with no reverse edges, so it is where the two halves meet.
 */
const SEARCH_OAUTH_LOGIN_PATHS: Record<SearchOAuthFamily, () => string> = {
  gemini: antigravityAuthFilePath,
  codex: chatgptAuthFilePath,
}

/**
 * Keep this source's copied login in step with the login itself.
 *
 * Runs regardless of whether the API-key capture above found anything, because
 * they are two different credentials: a session can hold both a `GEMINI_API_KEY`
 * and a Google login, and pinning only the first would still leave the OAuth
 * route dark after a `/logout`.
 */
async function syncOAuthLogin(
  family: SearchCredentialFamily,
  optedOut: boolean,
): Promise<SearchOAuthPinAction> {
  if (!isSearchOAuthFamily(family)) return 'oauth-unsupported'
  if (optedOut) return 'oauth-opted-out'
  try {
    const outcome = await syncSearchOAuthCopy(
      family,
      SEARCH_OAUTH_LOGIN_PATHS[family](),
    )
    if (outcome === 'copied' || outcome === 'synced') {
      // Never a token, never a fragment of one: this line can land in a debug
      // log a user attaches to a bug report.
      logForDebugging(`[search] auto-${outcome} the ${family} search login`)
    }
    return `oauth-${outcome}` as const
  } catch (error) {
    logForDebugging(
      `[search] auto-copy of the ${family} search login failed: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return 'oauth-failed'
  }
}

async function autoPinOne(
  family: SearchCredentialFamily,
  overrides: SearchAutoPinOverrides,
): Promise<SearchAutoPinResult> {
  // One opt-out covers both credentials: `webSearchAutoPin.<family>` is a
  // statement about a SOURCE ("stop keeping this one's credential"), and
  // splitting it in two would make D's meaning depend on which credential the
  // row happened to be showing when it was pressed.
  const optedOut = !isSearchAutoPinEnabled(family, overrides)
  const oauth = await syncOAuthLogin(family, optedOut)
  try {
    if (optedOut) {
      return { family, action: 'opted-out', oauth }
    }
    const captured = captureSearchCredentialFromEnvironment(family)
    if ('error' in captured) {
      // The common case by a wide margin — most sessions configure one
      // provider, and a subscription login has no key to copy. Not an error,
      // and deliberately not logged at the default level.
      return {
        family,
        action: 'nothing-to-capture',
        oauth,
        detail: captured.error,
      }
    }
    const pinned = readPinnedSearchCredential(family)
    if (sameCredential(pinned, captured.credential)) {
      return { family, action: 'unchanged', oauth }
    }
    await pinSearchCredential(family, captured.credential)
    const action: SearchAutoPinAction = pinned ? 'refreshed' : 'pinned'
    // Never the value, and never a fragment of it: this line can land in a
    // debug log a user attaches to a bug report.
    logForDebugging(`[search] auto-${action} the ${family} search credential`)
    return { family, action, oauth }
  } catch (error) {
    const detail = errorMessage(error)
    logForDebugging(`[search] auto-pin of ${family} failed: ${detail}`, {
      level: 'warn',
    })
    return { family, action: 'failed', oauth, detail }
  }
}

/**
 * Whether this source has a login on disk that could be copied.
 *
 * For `/search-setting`'s `S` offer: a source can be connected, unpinnable by
 * key (no API key in the environment) and still have something to pin, and
 * offering nothing there is how the OAuth case stayed invisible.
 */
export function hasSearchOAuthLogin(family: SearchCredentialFamily): boolean {
  return (
    isSearchOAuthFamily(family) &&
    existsSync(SEARCH_OAUTH_LOGIN_PATHS[family]())
  )
}

/**
 * Copy this source's login now, ignoring the opt-out — `S`'s half of the OAuth
 * axis, exactly as `pinSearchCredential` is `S`'s half of the key axis. The
 * keypress IS the decision, and the caller clears the opt-out alongside it.
 */
export async function copySearchOAuthLogin(
  family: SearchCredentialFamily,
): Promise<SearchOAuthCopyOutcome> {
  if (!isSearchOAuthFamily(family)) return 'absent'
  return syncSearchOAuthCopy(family, SEARCH_OAUTH_LOGIN_PATHS[family]())
}

/**
 * Drop this source's copied login — `D`'s half of the OAuth axis. Returns
 * whether there was one. A source with no copyable login answers false rather
 * than throwing: `D` is one keypress over a row that may hold either kind of
 * credential, or both.
 */
export async function removeSearchOAuthLogin(
  family: SearchCredentialFamily,
): Promise<boolean> {
  if (!isSearchOAuthFamily(family)) return false
  return removeSearchOAuthCopy(family)
}

/** Whether one pass actually wrote something — the panel's re-render trigger. */
export function wroteSearchCredential(result: SearchAutoPinResult): boolean {
  return (
    result.action === 'pinned' ||
    result.action === 'refreshed' ||
    result.oauth === 'oauth-copied' ||
    result.oauth === 'oauth-synced'
  )
}

/**
 * One pass over every pinnable source.
 *
 * The try wraps the WHOLE body, including the settings read, and that placement
 * is the point rather than an accident. `autoPinOne` guards itself, so it is
 * tempting to leave the loop's preamble outside — but an `async` function's
 * synchronous prologue is not exempt from rejecting: anything thrown before the
 * first `await` still comes back as a rejected promise, and the callers are
 * `void autoPinSearchCredentials()` on the startup path and a bare `.then()` in
 * the panel. There is no `.catch` anywhere downstream to add one to, because
 * "never rejects" is this module's contract and not the callers' problem. A
 * throwing `getSettingsForSource` — today it swallows everything, tomorrow it
 * is a cache plus a file read plus a validator — would otherwise be an
 * unhandled rejection during startup.
 */
async function runAutoPin(): Promise<SearchAutoPinResult[]> {
  try {
    const overrides = readSearchAutoPinOverrides()
    const results: SearchAutoPinResult[] = []
    // Sequential on purpose: `pinSearchCredential` is a read-modify-write of
    // one file, so four concurrent pins would each serialize a map built from
    // the same pre-write snapshot and the last writer would drop the other
    // three.
    for (const family of PINNABLE_SEARCH_SOURCES) {
      results.push(await autoPinOne(family, overrides))
    }
    return results
  } catch (error) {
    const detail = errorMessage(error)
    logForDebugging(`[search] auto-pin run aborted: ${detail}`, {
      level: 'warn',
    })
    // A row per source rather than an empty array. The result is how a caller
    // asks "what happened to gemini", and an empty array answers `undefined` —
    // a state the action union does not describe, on the one path nobody
    // exercises. Every source did fail to be pinned, and they all failed for
    // this reason, so saying so keeps every lookup total.
    return PINNABLE_SEARCH_SOURCES.map(family => ({
      family,
      action: 'failed' as const,
      oauth: isSearchOAuthFamily(family)
        ? ('oauth-failed' as const)
        : ('oauth-unsupported' as const),
      detail,
    }))
  }
}

/**
 * Serializes runs against each other for the same reason the loop above is
 * sequential: startup, the panel mounting, `R`, and a provider save can all
 * fire within a second of one another, and two overlapping runs would race on
 * the same file.
 */
let queue: Promise<SearchAutoPinResult[]> = Promise.resolve([])

/**
 * Pin whatever the environment currently offers, for every source that has not
 * opted out. Never rejects — see `runAutoPin`.
 */
export function autoPinSearchCredentials(): Promise<SearchAutoPinResult[]> {
  // `runAutoPin` in both slots: it is total, so the rejection slot is dead
  // today, and it is there so that a queue somehow left rejected cannot make
  // every later run reject too — the failure mode a shared chain has and a
  // single call does not.
  queue = queue.then(runAutoPin, runAutoPin)
  return queue
}
