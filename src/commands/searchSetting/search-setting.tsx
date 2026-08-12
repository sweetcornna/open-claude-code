/**
 * /search-setting — pick which sources an aggregated web search uses.
 *
 * The five sources are symmetric (see
 * packages/builtin-tools/.../adapters/searchSources.ts): four provider search
 * layers plus the keyless one. A source is ticked when its credentials exist,
 * unless the user said otherwise, and settings store only those explicit
 * choices — so a fresh login shows up here already ticked, with nothing to
 * configure.
 *
 * Every ticked source runs as its own lane, in parallel, and the results merge
 * (aggregateAdapter.ts). Nothing in this panel picks *one* backend; ticking a
 * second source adds a lane, it never replaces one.
 *
 * Pinning happens by itself. Every provider source reads the provider env
 * unpinned, and that env is what `/logout` deletes and `/provider use` replaces
 * wholesale — so switching providers used to drop web search to the keyless
 * lane with nothing said. The same was true one credential over: `gemini` and
 * `codex` can authenticate with an OAuth login instead of a key, and `/logout`
 * deletes those login files too. autoPin.ts keeps both — the key in occ's own
 * 0600 store (searchCredentialStore.ts), the login as a copy of its file
 * (oauthCopies.ts) — on startup, when this panel opens, on `r`, and after a
 * provider save; the keys below are the manual half of that.
 *
 * Four things a row can do beyond being ticked:
 *   - Enter on a disconnected provider source starts that provider's OAuth flow
 *     and the row flips to connected + ticked when it returns.
 *   - `s` PINS whatever the source is authenticating with right now — an API
 *     key, an OAuth login, or both — and clears any opt-out `d` left behind. It
 *     is the way back, not the only way in: a source that is connected and
 *     still unpinned either opted out or has nothing occ can keep (a Claude
 *     subscription is a keychain record, not a file of ours).
 *   - `d` removes the pin if there is one — both kinds, and records that this
 *     source is not to be pinned again, or the next startup would silently put
 *     it back — and otherwise disconnects a source whose login this panel owns.
 *     Two distinct undos, in that order, because they are two distinct
 *     credentials: the first `d` stops search keeping its own copy, the second
 *     signs the account out.
 *   - `r` re-checks every row, which also clears the session-scoped "this source
 *     failed, stop using it" flags, re-reads the pin store and re-runs the
 *     automatic capture. Without that, a source retired before the user fixed
 *     the underlying problem stays greyed out until restart — the "I logged in
 *     and it still does not work" shape.
 *
 * Anything that touches the network is cancellable: Esc while an operation is in
 * flight aborts it rather than closing the panel. An OAuth flow parked on a
 * callback listener the user has already abandoned is otherwise unbounded.
 *
 * Interaction copies /web-tools and EffortPanel: ↑/↓ move, space/enter act,
 * Esc closes, Ctrl+C/D exit through the shared hook.
 */

import { Box, Text, useInput } from '@anthropic/ink';
import type { SearchCredentialFamily } from '@open-claude-code/tool-runtime/searchCredentials.js';
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { errorMessageWithCause } from '../../utils/runtime/errors.js';
import {
  getGeminiOAuthAccessToken,
  removeGeminiOAuthCredentials,
  startGeminiOAuthLogin,
} from '../../services/api/gemini/oauthToken.js';
import {
  type ChatGPTDeviceCode,
  completeChatGPTDeviceLogin,
  getStoredChatGPTAccountId,
  hasStoredChatGPTAuth,
  removeChatGPTAuth,
  requestChatGPTDeviceCode,
} from '../../services/api/openai/chatgptAuth.js';
import { openBrowser } from '../../utils/network/browser.js';
import {
  autoPinSearchCredentials,
  copySearchOAuthLogin,
  hasSearchOAuthLogin,
  readSearchAutoPinOverrides,
  removeSearchOAuthLogin,
  type SearchAutoPinOverrides,
  setSearchAutoPinEnabled,
  wroteSearchCredential,
} from '../../services/search/autoPin.js';
import { captureSearchCredentialFromEnvironment } from '../../services/search/captureCredential.js';
import { listSearchOAuthCopies } from '../../services/search/oauthCopies.js';
import {
  isPinnableSearchSource,
  listPinnedSearchSources,
  pinSearchCredential,
  readPinnedSearchCredential,
  reloadPinnedSearchCredentials,
  unpinSearchCredential,
} from '../../services/search/searchCredentialStore.js';
import {
  hasAnthropicSearchCredentials,
  hasCodexSearchCredentials,
  hasDeepSeekSearchCredentials,
} from '../../services/search/sourceCredentials.js';
import type { LocalJSXCommandCall, LocalJSXCommandContext } from '../../types/command.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import {
  probeDeepSeekSearchSupport,
  resetDeepSeekSearchProbe,
} from '@open-claude-code/builtin-tools/tools/WebSearchTool/adapters/deepseekAdapter.js';
import {
  hasSourceCredentials,
  isSourceAvailable,
  isSourceEnabled,
  primarySourceId,
  resetSourceAvailability,
  SEARCH_SOURCE_IDS,
  SEARCH_SOURCE_LABELS,
  type SearchSourceId,
} from '@open-claude-code/builtin-tools/tools/WebSearchTool/adapters/searchSources.js';

type SourceOverrides = Partial<Record<SearchSourceId, boolean>>;

type SettingsJson = Record<string, unknown> & {
  webSearchSources?: SourceOverrides;
};

type ConnectionState = 'connected' | 'disconnected' | 'checking';

type SourceRow = {
  id: SearchSourceId;
  label: string;
  hint: string;
  enabled: boolean;
  available: boolean;
  connection: ConnectionState;
  account?: string;
  detail?: string;
  isCurrentProvider: boolean;
  canLogin: boolean;
  canDisconnect: boolean;
  /**
   * A credential for this source is stored in a file of occ's own that the
   * account plane does not touch — either a key in search-credentials.json or a
   * copy of the source's OAuth login.
   */
  pinned: boolean;
  /** This source's lane reads the pin store, so pinning it would mean something. */
  canPin: boolean;
  /**
   * This source is still eligible for automatic pinning — i.e. `d` has not
   * been pressed on it since the last `s`. True for anything that cannot be
   * pinned at all, which keeps the copy on those rows about the lane rather
   * than about a switch that does not apply to them.
   */
  autoPin: boolean;
};

const SOURCE_HINTS: Record<SearchSourceId, string> = {
  anthropic: 'Anthropic runs the search server-side and returns cited results',
  deepseek: 'DeepSeek runs the search server-side, over its Anthropic-compatible endpoint',
  gemini: 'Google Search grounding through your Google account',
  codex: 'OpenAI Responses API web_search through your ChatGPT account',
  brave: "Brave's independent index through your Brave Search API key",
  exa: "Exa's neural search through your Exa API key",
  free: 'DuckDuckGo + Mojeek + Bing scraping — no account needed',
};

/** Only the OAuth-backed provider sources have a login flow to offer. */
const LOGIN_CAPABLE: ReadonlySet<SearchSourceId> = new Set(['gemini', 'codex']);

/**
 * Sources whose credentials this panel stores and can therefore remove.
 *
 * `anthropic` and `deepseek` are deliberately absent: their credential IS the
 * session's provider login, so "disconnecting" one would sign the user out of
 * the CLI from inside a search settings panel. Space switches those lanes off,
 * which is what a user asking to disconnect them actually wants.
 */
const DISCONNECT_CAPABLE: ReadonlySet<SearchSourceId> = new Set(['gemini', 'codex']);

/**
 * The four provider sources whose ids are also credential-family names.
 * `brave`, `exa` and `free` have no entry in the credential store: the first
 * two are keys the user holds in their own settings, and the third needs none.
 */
const CREDENTIAL_FAMILIES: ReadonlySet<SearchSourceId> = new Set(['anthropic', 'deepseek', 'gemini', 'codex']);

function toCredentialFamily(id: SearchSourceId): SearchCredentialFamily | undefined {
  return CREDENTIAL_FAMILIES.has(id) ? (id as SearchCredentialFamily) : undefined;
}

function isPinnableSearchSourceId(id: SearchSourceId): boolean {
  const family = toCredentialFamily(id);
  return family !== undefined && isPinnableSearchSource(family);
}

/**
 * Whether the automatic capture may still pin this row.
 *
 * A source with no credential family answers true — there is no opt-out to
 * store for it, and reporting "automatic pinning is off" on a row that was
 * never pinnable would be a switch the user cannot find.
 */
function isAutoPinAllowed(id: SearchSourceId, overrides: SearchAutoPinOverrides): boolean {
  const family = toCredentialFamily(id);
  return family === undefined || overrides[family] !== false;
}

/**
 * Connection state for one source: whether it is usable, and (when the
 * credential carries one) which account it belongs to, so a user with several
 * logins can tell which one is feeding their searches.
 *
 * `deepseek` is the one probe that goes to the network. Holding a DeepSeek key
 * is not the same as that deployment implementing `web_search_20250305` — a
 * self-hosted mirror or an older gateway takes the key and rejects the tool —
 * and a ticked source that can only return nothing is the failure this registry
 * exists to prevent. So the capability is measured, and `detail` carries what
 * the endpoint actually said.
 */
async function readConnection(
  id: SearchSourceId,
  signal?: AbortSignal,
): Promise<{ connected: boolean; account?: string; detail?: string }> {
  switch (id) {
    case 'anthropic':
      return { connected: hasAnthropicSearchCredentials() };
    case 'deepseek': {
      if (!hasDeepSeekSearchCredentials()) return { connected: false };
      const probe = await probeDeepSeekSearchSupport(signal ? { signal } : {});
      switch (probe.status) {
        case 'supported':
          return { connected: true };
        case 'unsupported':
          return { connected: false, detail: `endpoint rejected web_search — ${probe.detail}` };
        case 'unreachable':
          return { connected: false, detail: `endpoint unreachable — ${probe.detail}` };
        case 'unconfigured':
          return { connected: false };
      }
    }
    case 'gemini':
      return {
        // The pinned KEY first, and without awaiting anything: it is the
        // credential the lane will actually send (usesAntigravityRoute stands
        // down for an explicit key), so a row backed by one must not be
        // reported through a Google token that request is not going to carry.
        // A pinned LOGIN needs no separate branch — getGeminiOAuthAccessToken
        // reads the copy itself, so after a /logout this still answers "yes"
        // with the same token the search will use.
        connected:
          readPinnedSearchCredential('gemini') !== undefined ||
          (await getGeminiOAuthAccessToken()) !== null ||
          Boolean(process.env.GEMINI_API_KEY),
      };
    case 'codex': {
      // The pin first, and without awaiting the login probe — same rule as the
      // gemini row above. A pinned key stands the ChatGPT route down
      // (shouldUseChatGPTAuth), so naming an account here would attribute the
      // row to a credential the request is not going to carry.
      if (readPinnedSearchCredential('codex')) {
        return { connected: hasCodexSearchCredentials() };
      }
      // Counts the copied login as well as the live one, and names the account
      // from whichever the lane would pick — so after a /logout this row keeps
      // reporting the ChatGPT account the searches are still running as,
      // instead of going dark while the lane quietly keeps working.
      const oauth = await hasStoredChatGPTAuth();
      return {
        // Deliberately the shared probe rather than a second `OPENAI_API_KEY`
        // check: an API key only means "OpenAI's web_search is reachable" when
        // OPENAI_BASE_URL actually points at OpenAI. Re-deriving it here is how
        // this panel came to report "✓ connected" for a DeepSeek key, which is
        // what led users to tick a source that can only return zero results.
        connected: oauth || hasCodexSearchCredentials(),
        ...(oauth ? { account: await getStoredChatGPTAccountId() } : {}),
      };
    }
    // Key-only sources: the same resolver the adapter authenticates with, so
    // "connected" here means the request would carry a key, never just "some
    // key-shaped setting exists".
    case 'brave':
    case 'exa':
      return { connected: hasSourceCredentials(id) };
    case 'free':
      return { connected: true };
  }
}

/**
 * The two things a user must do with a device code, in the order the server
 * enforces.
 *
 * Signing in comes first and is not optional: a signed-out browser opening
 * `/codex/device` is 302'd to `/api/accounts/deviceauth/authorize` and on into
 * `/oauth/authorize`, and the field that accepts the code only exists after
 * that round trip. Phrasing this as one instruction ("open X and enter Y", as
 * it was) sends a first-time user to type their code into a login page, which
 * is why the first attempt failed for everyone who was not already signed in
 * and the retry — now signed in — worked.
 *
 * The dash is called out because the code arrives as `M1G0-1YEMB` and the form
 * inserts its own separator; pasting the whole thing is the other way a first
 * attempt is rejected.
 */
export function deviceCodeSteps(code: {
  verificationUrl: string;
  userCode: string;
}): [signIn: string, enterCode: string] {
  return [`Sign in to ChatGPT at ${code.verificationUrl}`, `Then enter this code, dash included: ${code.userCode}`];
}

function writeOverride(id: SearchSourceId, enabled: boolean): void {
  // Patch only the selected user-level key. Rewriting the effective merged
  // object would promote project/policy choices into settings.json and lets a
  // stale full-shape snapshot erase a source added by another write.
  const { error } = updateSettingsForSource('userSettings', {
    webSearchSources: { [id]: enabled },
  } as unknown as SettingsJson);
  if (error) throw error;
}

/**
 * What the user would have to do to make a disconnected source usable.
 *
 * Spelled out per source because "not connected" is not actionable on its own —
 * `codex` in particular is most often dark not because nothing is configured,
 * but because OPENAI_BASE_URL points at an OpenAI-COMPATIBLE endpoint whose
 * vendor does not run OpenAI's server-side web_search. That reads as "but I set
 * an API key" unless the message names the real condition.
 */
function remedyFor(row: SourceRow): string {
  if (row.detail) return `${row.label}: ${row.detail}`;
  switch (row.id) {
    case 'codex':
      return (
        `${row.label} needs OpenAI's own backend: press enter to log in with a ` +
        `ChatGPT account, or point OPENAI_BASE_URL at api.openai.com with an ` +
        `OpenAI key. A key for an OpenAI-compatible endpoint does not serve ` +
        `OpenAI's web_search.`
      );
    case 'gemini':
      return `${row.label} is not connected — press enter to log in with Google, or set GEMINI_API_KEY.`;
    case 'anthropic':
      return `${row.label} is not connected — log in with /login, or set ANTHROPIC_API_KEY.`;
    case 'deepseek':
      return (
        `${row.label} is not connected — point OPENAI_BASE_URL at api.deepseek.com ` +
        `with a DeepSeek key (/login), then press R to re-check.`
      );
    case 'brave':
      return `${row.label} has no key — set BRAVE_SEARCH_API_KEY (or BRAVE_API_KEY), or store braveApiKey in your settings.`;
    case 'exa':
      return `${row.label} has no key — store exaApiKey in your settings.`;
    case 'free':
      return `${row.label} needs no account.`;
  }
}

/**
 * Why `D` did nothing, said in terms of what the user would have to do instead.
 *
 * There are three reasons a source has no disconnect, not one: it has no
 * credential at all, its credential is a key the user put somewhere themselves,
 * or its credential IS the session's provider login (which this panel has no
 * business revoking). Collapsing them lands the wrong instruction on the wrong
 * row — telling someone to run /logout to stop sending their Brave key.
 */
function noDisconnectHint(row: SourceRow): string {
  switch (row.id) {
    case 'free':
      return `${row.label} has no account to disconnect — press Space to switch the lane off.`;
    case 'brave':
    case 'exa':
      return (
        `${row.label} is configured by a key you hold, not a login occ can revoke. ` +
        `Press Space to switch the lane off, or remove the key from your settings/environment.`
      );
    default:
      // Two different reasons a pinnable source has no pin, and the automatic
      // capture is what separates them: with it on, "nothing pinned" means the
      // environment held nothing copyable, and telling that user to press S
      // sends them at a refusal. With it off, S is exactly the answer.
      return row.autoPin
        ? `${row.label} uses this session's provider login — nothing pinned to remove. ` +
            `An API key in your environment, or an OAuth login stored by occ, would be pinned here on its own. ` +
            `Press Space to switch the lane off, or /logout to sign out.`
        : `${row.label} is not pinned and is set never to be pinned automatically. ` +
            `Press S to pin its credential and turn automatic pinning back on, ` +
            `Space to switch the lane off, or /logout to sign out.`;
  }
}

function checkbox(row: SourceRow): string {
  if (!row.available) return '[-]';
  return row.enabled ? '[✓]' : '[ ]';
}

function statusBadge(row: SourceRow): {
  text: string;
  color?: 'success' | 'warning';
  dim?: boolean;
} {
  if (!row.available) {
    return { text: row.detail ?? 'unavailable for this account', dim: true };
  }
  if (row.connection === 'checking') {
    return { text: 'checking…', dim: true };
  }
  if (row.connection === 'connected') {
    if (row.id === 'free') return { text: '✓ no account needed', color: 'success' };
    // "pinned" is the only credential detail ever shown. Never the key, never a
    // prefix of it, never its length — the store exists so the value stays on
    // disk at 0600, and a settings panel is exactly where it would leak from.
    const suffix = row.pinned ? ' · pinned' : '';
    return {
      text: row.account ? `✓ connected (${row.account})${suffix}` : `✓ connected${suffix}`,
      color: 'success',
    };
  }
  if (row.detail) return { text: row.detail, dim: true };
  return row.canLogin
    ? { text: 'not connected → enter to log in', color: 'warning' }
    : { text: 'not connected', dim: true };
}

/**
 * The `S` affordance for the highlighted row, when it would do something.
 *
 * Only offered on a connected, pinnable, not-yet-pinned source that really has
 * something to keep — an offer that answers with a refusal reads as a broken
 * key, and now that pinning is automatic, "connected but unpinned" most often
 * means precisely that there was nothing to capture. Two things count as
 * something: a key the environment is holding, or an OAuth login file occ
 * itself wrote. Both probes are local reads (process.env plus the wires' own
 * bookkeeping; one existsSync), and this runs for the highlighted row only, so
 * asking per render costs nothing.
 */
function pinOffer(row: SourceRow): string {
  if (!row.canPin || row.pinned || row.connection !== 'connected') return '';
  const family = toCredentialFamily(row.id);
  if (!family) return '';
  const hasKey = !('error' in captureSearchCredentialFromEnvironment(family));
  if (!hasKey && !hasSearchOAuthLogin(family)) return '';
  const what = hasKey ? 'credential' : 'login';
  return row.autoPin ? ` · S pins this ${what} now` : ` · S pins this ${what} and turns automatic pinning back on`;
}

/** What an in-flight operation is, so Esc can say what it would cancel. */
type Busy = { id: SearchSourceId; kind: 'login' | 'disconnect' | 'pin' };

function SearchSettingPanel({
  onClose,
  _context: __context,
}: {
  onClose: (result?: string) => void;
  _context: LocalJSXCommandContext;
}): React.ReactNode {
  const [cursor, setCursor] = useState(0);
  const [connections, setConnections] = useState<Record<SearchSourceId, ConnectionState>>({
    anthropic: 'checking',
    deepseek: 'checking',
    gemini: 'checking',
    codex: 'checking',
    brave: 'checking',
    exa: 'checking',
    free: 'connected',
  });
  const [accounts, setAccounts] = useState<Partial<Record<SearchSourceId, string>>>({});
  const [details, setDetails] = useState<Partial<Record<SearchSourceId, string>>>({});
  const [overrideVersion, setOverrideVersion] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<Busy | undefined>(undefined);
  const busyAbort = useRef<AbortController | undefined>(undefined);
  // The pairing code gets its own slot rather than riding `notice`. A device
  // code is on screen for however long the user needs to switch to a browser,
  // sign in, and type it — minutes, during which any other message (a probe
  // result, a toggle refusal) would otherwise overwrite the one thing they
  // cannot recover: pressing Esc to "get it back" cancels the device auth and
  // mints a different code.
  const [deviceCode, setDeviceCode] = useState<ChatGPTDeviceCode | undefined>(undefined);
  // Set synchronously, unlike `busy`. A second Enter arriving in the same tick
  // (terminals that deliver CRLF as two key events, or a double-tap) still sees
  // the pre-render closure where `busy` is undefined, so the state check alone
  // starts a second device authorization: two live codes, one displayed, the
  // other polling unattended for its full 15 minutes.
  const loginInFlight = useRef(false);

  const insideModal = useIsInsideModal();
  const { rows } = useTerminalSize();
  const contentHeight = insideModal ? rows + 1 : Math.max(16, Math.min(Math.floor(rows * 0.7), 26));

  useExitOnCtrlCDWithKeybindings();

  const refreshConnections = useCallback(() => {
    const controller = new AbortController();
    for (const id of SEARCH_SOURCE_IDS) {
      setConnections(prev => ({ ...prev, [id]: 'checking' }));
      void readConnection(id, controller.signal)
        .then(({ connected, account, detail }) => {
          if (controller.signal.aborted) return;
          setConnections(prev => ({ ...prev, [id]: connected ? 'connected' : 'disconnected' }));
          setAccounts(prev => ({ ...prev, [id]: account }));
          setDetails(prev => ({ ...prev, [id]: detail }));
        })
        .catch(() => {
          // A probe that threw (aborted, or a transport failure the probe did
          // not classify) reads as "not connected" rather than leaving the row
          // stuck on "checking…" forever.
          if (controller.signal.aborted) return;
          setConnections(prev => ({ ...prev, [id]: 'disconnected' }));
        });
    }
    return () => controller.abort();
  }, []);

  useEffect(() => refreshConnections(), [refreshConnections]);

  // Opening the panel is one of the moments the environment is known to hold
  // whatever the lanes are authenticating with, so it is one of the moments the
  // capture runs. Fire-and-forget, and only re-render when it actually wrote
  // something — a run that pinned nothing (the usual outcome) must not restart
  // the connection probes underneath a user who is already reading the rows.
  useEffect(() => {
    let live = true;
    void autoPinSearchCredentials().then(results => {
      if (!live) return;
      if (results.some(wroteSearchCredential)) {
        setOverrideVersion(v => v + 1);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const provider = primarySourceId();
  // Same render-key trick as `enabled` below: the store is memoized, so this
  // re-reads it only after a pin/unpin bumps the version.
  //
  // Two stores, one badge. A source's credential is either a key (in
  // search-credentials.json) or a login (a copied file of its own), and a row
  // reads "pinned" when EITHER is kept — the user's question is "does this
  // survive /logout", and the answer does not depend on which kind of
  // credential happens to be answering it.
  const pinnedSources = new Set<SearchSourceId>(
    overrideVersion >= 0 ? [...listPinnedSearchSources(), ...listSearchOAuthCopies()] : [],
  );
  const autoPinOverrides = overrideVersion >= 0 ? readSearchAutoPinOverrides() : {};

  const sourceRows: SourceRow[] = SEARCH_SOURCE_IDS.map(id => ({
    id,
    label: SEARCH_SOURCE_LABELS[id],
    hint: SOURCE_HINTS[id],
    // overrideVersion is a render key: settings are read fresh after a toggle.
    enabled: overrideVersion >= 0 && isSourceEnabled(id),
    available: isSourceAvailable(id),
    connection: connections[id],
    ...(accounts[id] ? { account: accounts[id] } : {}),
    ...(details[id] ? { detail: details[id] } : {}),
    isCurrentProvider: id === provider,
    canLogin: LOGIN_CAPABLE.has(id),
    // A pinned credential is something this panel stored and can therefore
    // remove, whatever the source's login situation is.
    canDisconnect: DISCONNECT_CAPABLE.has(id) || pinnedSources.has(id),
    pinned: pinnedSources.has(id),
    canPin: isPinnableSearchSourceId(id),
    autoPin: isAutoPinAllowed(id, autoPinOverrides),
  }));

  const toggleSource = useCallback((row: SourceRow) => {
    if (!row.available) {
      setNotice(`${row.label} is unavailable: ${row.detail ?? 'this account cannot serve it'}. Press R to re-check.`);
      return;
    }
    // Ticking a disconnected source is refused rather than recorded: the
    // override cannot manufacture the capability (see isSourceEnabled), so
    // writing it would leave the box ticked and the lane still dark. Say what
    // would actually fix it instead.
    if (!row.enabled && row.connection !== 'connected') {
      setNotice(remedyFor(row));
      return;
    }
    try {
      writeOverride(row.id, !row.enabled);
      setOverrideVersion(v => v + 1);
      setNotice(`${row.label} ${row.enabled ? 'disabled' : 'enabled'}.`);
    } catch (error) {
      setNotice(`${row.label} settings update failed: ${errorMessageWithCause(error)}`);
    }
  }, []);

  /**
   * Re-check everything, forgetting what this session concluded earlier.
   *
   * Both caches have to go, not just one: a source retired by a failed search
   * (unavailableSources) and a DeepSeek endpoint that answered "no" once are
   * separate memories, and leaving either in place is how a row stays greyed out
   * after the user has already fixed the cause.
   */
  const recheck = useCallback(() => {
    resetSourceAvailability();
    resetDeepSeekSearchProbe();
    // The pin store is memoized for the process (it is read on every row of
    // every render), so R is also what picks up a file edited from outside.
    reloadPinnedSearchCredentials();
    // After the reload, never before: the capture compares against what is
    // pinned, and comparing against a stale cache would rewrite a file that
    // already agreed with the environment.
    void autoPinSearchCredentials().then(() => setOverrideVersion(v => v + 1));
    setDetails({});
    setOverrideVersion(v => v + 1);
    refreshConnections();
    setNotice('Re-checking every source…');
  }, [refreshConnections]);

  const startLogin = useCallback(
    (row: SourceRow) => {
      if (busy || loginInFlight.current) return;
      loginInFlight.current = true;
      const controller = new AbortController();
      busyAbort.current = controller;
      setBusy({ id: row.id, kind: 'login' });
      setNotice(`Starting ${row.label} login… (Esc cancels)`);

      const run = async (): Promise<void> => {
        if (row.id === 'gemini') {
          await startGeminiOAuthLogin(controller.signal);
          return;
        }
        const code = await requestChatGPTDeviceCode();
        setDeviceCode(code);
        setNotice(undefined);
        // Opened for the user, as the ChatGPT subscription login does. Hand
        // copying a URL out of a status line is the step this panel used to
        // leave them, and the destination is not a page they can guess.
        void openBrowser(code.verificationUrl);
        await completeChatGPTDeviceLogin(code, controller.signal);
      };

      void run()
        .then(() => {
          if (controller.signal.aborted) return;
          // A fresh login has credentials, so the source is on by default —
          // clear any stale explicit "off" so the row really is ticked.
          const settings = (getSettingsForSource('userSettings') ?? {}) as unknown as SettingsJson;
          if (settings.webSearchSources?.[row.id] === false) {
            writeOverride(row.id, true);
          }
          // A source this session already retired (one failed search before the
          // login) would otherwise stay greyed out with credentials sitting
          // right there — "I logged in and it still does not work".
          resetSourceAvailability();
          setOverrideVersion(v => v + 1);
          refreshConnections();
          setNotice(`${row.label} connected.`);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            setNotice(`${row.label} login cancelled.`);
            return;
          }
          // errorMessageWithCause, not `.message`: a transport failure rejects
          // with the bare string "fetch failed" and keeps the reason in `cause`.
          setNotice(`${row.label} login failed: ${errorMessageWithCause(error)}`);
        })
        .finally(() => {
          if (busyAbort.current === controller) busyAbort.current = undefined;
          loginInFlight.current = false;
          setDeviceCode(undefined);
          setBusy(undefined);
        });
    },
    [busy, refreshConnections],
  );

  /**
   * Copy whatever this source is authenticating with right now into occ's own
   * store, where the account plane cannot reach it.
   *
   * Both credentials, in one keypress. A key is captured out of the environment
   * — refused rather than approximated when there is nothing pinnable there,
   * most importantly when `ANTHROPIC_API_KEY` is a mirror of some other
   * provider's secret (captureCredential.ts). An OAuth login is copied file and
   * all (oauthCopies.ts), which is what makes `S` mean something on a row whose
   * credential is a ChatGPT or Google account rather than a key.
   */
  const pin = useCallback(
    (row: SourceRow) => {
      if (busy) return;
      const family = toCredentialFamily(row.id);
      if (!family) {
        setNotice(
          row.id === 'free'
            ? `${row.label} needs no account, so there is nothing to pin.`
            : `${row.label} is configured by a key you hold in your own settings, which /logout never touches.`,
        );
        return;
      }
      const captured = captureSearchCredentialFromEnvironment(family);
      // The capture's refusal is only the answer when there is no login to copy
      // either. Reporting "no OPENAI_API_KEY to pin" to somebody who is signed
      // in to ChatGPT is how this key looked broken for exactly the users it
      // now serves.
      if ('error' in captured && !hasSearchOAuthLogin(family)) {
        setNotice(`${row.label}: ${captured.error}`);
        return;
      }
      setBusy({ id: row.id, kind: 'pin' });
      const run = async (): Promise<string> => {
        const key = 'error' in captured ? undefined : captured.credential;
        if (key) await pinSearchCredential(family, key);
        const login = await copySearchOAuthLogin(family);
        const kept = [...(key ? ['its API key'] : []), ...(login === 'absent' ? [] : ['its login'])].join(' and ');
        // The login file can go away between the offer and the keypress (a
        // /logout in another window), which would otherwise print a sentence
        // with a hole where the credential's name belongs.
        if (!kept) return `${row.label} had nothing left to pin — press R to re-check.`;
        // S is also the undo for D's opt-out. Pinning by hand and then having
        // the next startup refuse to keep the pin fresh is the shape nobody
        // would predict from either key's description.
        let automatic = true;
        try {
          setSearchAutoPinEnabled(family, true);
        } catch {
          // The pin itself landed, which is what the keypress was for. Say so
          // rather than reporting a failure over a successful write.
          automatic = false;
        }
        return automatic
          ? `${row.label} pinned ${kept} — kept through /logout and provider switches, and refreshed automatically. D removes it.`
          : `${row.label} pinned ${kept} — kept through /logout and provider switches. Automatic pinning could not be re-enabled.`;
      };
      void run()
        .then(message => {
          setOverrideVersion(v => v + 1);
          refreshConnections();
          setNotice(message);
        })
        .catch((error: unknown) => {
          setNotice(`${row.label} pin failed: ${errorMessageWithCause(error)}`);
        })
        .finally(() => setBusy(undefined));
    },
    [busy, refreshConnections],
  );

  const disconnect = useCallback(
    (row: SourceRow) => {
      if (busy) return;
      // The pin goes first when there is one. It and a login are two different
      // credentials, so collapsing them would make one D revoke a Google
      // account the user only meant to stop pinning a key for.
      const family = toCredentialFamily(row.id);
      if (row.pinned && family) {
        setBusy({ id: row.id, kind: 'disconnect' });
        // Both stores, because the badge names both: leaving the copied login
        // behind after `D` would clear the pin, redraw the row as still pinned,
        // and keep serving searches from the credential the user just removed.
        // Sequentially — two independent files, and the second must run even
        // though the first is the one that usually has something to delete.
        void unpinSearchCredential(family)
          .then(() => removeSearchOAuthLogin(family))
          .then(() => {
            // Removing the pin without recording the decision would last until
            // the next startup, which then puts the same credential back. D has
            // to mean "stop doing this", or it means nothing.
            let optedOut = true;
            try {
              setSearchAutoPinEnabled(family, false);
            } catch {
              optedOut = false;
            }
            resetSourceAvailability();
            setOverrideVersion(v => v + 1);
            refreshConnections();
            setNotice(
              optedOut
                ? `${row.label} unpinned, and this source will not be pinned automatically again. ` +
                    `Press S to pin it and restore automatic pinning.`
                : `${row.label} unpinned — this source follows your provider configuration and login again. ` +
                    `The opt-out could not be saved, so a later session may pin it again.`,
            );
          })
          .catch((error: unknown) => {
            setNotice(`${row.label} unpin failed: ${errorMessageWithCause(error)}`);
          })
          .finally(() => setBusy(undefined));
        return;
      }
      if (!row.canDisconnect) {
        setNotice(noDisconnectHint(row));
        return;
      }
      setBusy({ id: row.id, kind: 'disconnect' });
      setNotice(`Disconnecting ${row.label}…`);

      const run = async (): Promise<string> => {
        if (row.id === 'gemini') {
          await removeGeminiOAuthCredentials();
          return process.env.GEMINI_API_KEY
            ? `${row.label} login removed — still connected through GEMINI_API_KEY in your environment.`
            : `${row.label} disconnected.`;
        }
        await removeChatGPTAuth();
        // removeChatGPTAuth only unlinks occ's own credential file. The probe
        // also reads ~/.codex/auth.json, which belongs to the Codex CLI and is
        // not ours to delete — so say why the row can come back connected
        // instead of looking like the disconnect silently failed.
        return hasCodexSearchCredentials()
          ? `${row.label} login removed — still connected through the Codex CLI's own ~/.codex/auth.json or an OpenAI key.`
          : `${row.label} disconnected.`;
      };

      void run()
        .then(message => {
          // No override written: the source falls back to following its
          // credentials, so a later login switches it on again by itself.
          resetSourceAvailability();
          setOverrideVersion(v => v + 1);
          refreshConnections();
          setNotice(message);
        })
        .catch((error: unknown) => {
          setNotice(`${row.label} disconnect failed: ${errorMessageWithCause(error)}`);
        })
        .finally(() => setBusy(undefined));
    },
    [busy, refreshConnections],
  );

  /**
   * Abort the operation in flight, if it is one that can be aborted.
   *
   * A disconnect is a local file unlink — there is no signal to fire and no
   * meaningful window in which to fire it — so Esc says that rather than
   * claiming to have cancelled something that already finished.
   */
  const cancelBusy = useCallback(() => {
    const controller = busyAbort.current;
    if (!controller) {
      setNotice('That step cannot be cancelled — it finishes locally.');
      return;
    }
    controller.abort();
    busyAbort.current = undefined;
    setNotice('Cancelling…');
  }, []);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor(c => Math.min(c + 1, sourceRows.length - 1));
      return;
    }
    if (key.escape) {
      // Esc cancels before it closes: an OAuth flow parked on a callback
      // listener the user has walked away from has no other way out, and
      // closing the panel would leave it running unobserved.
      if (busy) {
        cancelBusy();
        return;
      }
      onClose('Search sources panel dismissed');
      return;
    }
    const row = sourceRows[cursor];
    if (!row) return;
    if (input === 'r' || input === 'R') {
      recheck();
      return;
    }
    if (input === 'd' || input === 'D') {
      disconnect(row);
      return;
    }
    if (input === 's' || input === 'S') {
      pin(row);
      return;
    }
    if (input === ' ') {
      toggleSource(row);
      return;
    }
    if (key.return) {
      if (row.canLogin && row.connection === 'disconnected' && row.available) {
        startLogin(row);
      } else {
        toggleSource(row);
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1} height={contentHeight}>
      <Text bold>Web search sources</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Every ticked source runs in parallel and the results are merged. Sources you have accounts for are on by
          default.
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {sourceRows.map((row, index) => {
          const isCursor = index === cursor;
          const badge = statusBadge(row);
          return (
            <Box key={row.id} flexDirection="column">
              <Box flexDirection="row">
                <Text color={row.enabled && row.available ? 'success' : undefined}>
                  {isCursor ? '›' : ' '} {checkbox(row)}{' '}
                </Text>
                <Text
                  bold={row.enabled}
                  dimColor={!row.available}
                  backgroundColor={isCursor ? 'suggestion' : undefined}
                  color={isCursor ? 'inverseText' : undefined}
                >
                  {row.label}
                </Text>
                {row.isCurrentProvider ? <Text dimColor> (current provider)</Text> : null}
                <Text> </Text>
                <Text color={badge.color} dimColor={badge.dim}>
                  {badge.text}
                </Text>
              </Box>
              {isCursor ? (
                <Box marginLeft={6}>
                  {/* The pin offer rides the hint line rather than the badge: a
                      user only discovers this if it is mentioned where they are
                      already looking, and the badge is where "pinned" is said
                      once it has happened. */}
                  <Text dimColor>
                    {row.hint}
                    {pinOffer(row)}
                  </Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>

      {/* Two numbered steps, in that order, because the order is enforced:
          /codex/device redirects a signed-out browser into the OAuth sign-in
          and only shows the code field afterwards, so a user who reads this as
          "go here and type the code" spends their first attempt typing into a
          login page. Kept to two lines — the panel has a fixed height and a
          third would push the footer off a short terminal. */}
      {deviceCode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>1. {deviceCodeSteps(deviceCode)[0]} (opened for you)</Text>
          <Text>
            2. {deviceCodeSteps(deviceCode)[1]}
            <Text dimColor> · Esc cancels</Text>
          </Text>
        </Box>
      ) : notice ? (
        <Box marginTop={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {busy?.kind === 'login'
            ? `${'↑↓'} navigate · Esc cancel login`
            : busy?.kind === 'pin'
              ? `${'↑↓'} navigate · pinning…`
              : busy
                ? `${'↑↓'} navigate · disconnecting…`
                : `${'↑↓'} navigate · Space toggle · Enter toggle/log in · S pin now · D unpin (stops auto)/disconnect · R re-check · Esc close`}
        </Text>
      </Box>
    </Box>
  );
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <SearchSettingPanel onClose={onDone} _context={context} />;
};
