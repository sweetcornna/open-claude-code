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
 * Four things a row can do beyond being ticked:
 *   - Enter on a disconnected provider source starts that provider's OAuth flow
 *     and the row flips to connected + ticked when it returns.
 *   - `s` PINS the credential the source is authenticating with right now into
 *     occ's own 0600 store (searchCredentialStore.ts). That is the whole point
 *     of this panel owning credentials: unpinned, every provider source reads
 *     the provider env, which `/logout` deletes and `/provider use` replaces
 *     wholesale — so switching providers used to drop web search to the keyless
 *     lane with nothing said. A pin is not touched by either.
 *   - `d` removes the pin if there is one, and otherwise disconnects a source
 *     whose login this panel owns. Two distinct undos, in that order, because
 *     they are two distinct credentials.
 *   - `r` re-checks every row, which also clears the session-scoped "this source
 *     failed, stop using it" flags and re-reads the pin store. Without that, a
 *     source retired before the user fixed the underlying problem stays greyed
 *     out until restart — the "I logged in and it still does not work" shape.
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
  completeChatGPTDeviceLogin,
  getStoredChatGPTAccountId,
  hasStoredChatGPTAuth,
  removeChatGPTAuth,
  requestChatGPTDeviceCode,
} from '../../services/api/openai/chatgptAuth.js';
import { captureSearchCredentialFromEnvironment } from '../../services/search/captureCredential.js';
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
  /** A credential for this source is stored in occ's own search-credential file. */
  pinned: boolean;
  /** This source's lane reads the pin store, so pinning it would mean something. */
  canPin: boolean;
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
        // The pin first, and without awaiting anything: it is the credential
        // the lane will actually send (usesAntigravityRoute stands down for an
        // explicit key), so a row backed by one must not be reported through a
        // Google token that request is not going to carry.
        connected:
          readPinnedSearchCredential('gemini') !== undefined ||
          (await getGeminiOAuthAccessToken()) !== null ||
          Boolean(process.env.GEMINI_API_KEY),
      };
    case 'codex': {
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
      return (
        `${row.label} uses this session's provider login — nothing pinned to remove. ` +
        `Press S to pin its credential so a /logout or provider switch keeps it, ` +
        `Space to switch the lane off, or /logout to sign out.`
      );
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
 * Only offered on a connected, pinnable, not-yet-pinned source: there is no
 * credential to copy otherwise, and an offer that answers with a refusal reads
 * as a broken key.
 */
function pinOffer(row: SourceRow): string {
  if (!row.canPin || row.pinned || row.connection !== 'connected') return '';
  return ' · S keeps this credential through /logout and provider switches';
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

  const provider = primarySourceId();
  // Same render-key trick as `enabled` below: the store is memoized, so this
  // re-reads it only after a pin/unpin bumps the version.
  const pinnedSources = new Set<SearchSourceId>(overrideVersion >= 0 ? listPinnedSearchSources() : []);

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
    setDetails({});
    setOverrideVersion(v => v + 1);
    refreshConnections();
    setNotice('Re-checking every source…');
  }, [refreshConnections]);

  const startLogin = useCallback(
    (row: SourceRow) => {
      if (busy) return;
      const controller = new AbortController();
      busyAbort.current = controller;
      setBusy({ id: row.id, kind: 'login' });
      setNotice(`Starting ${row.label} login… (Esc cancels)`);

      const run = async (): Promise<void> => {
        if (row.id === 'gemini') {
          await startGeminiOAuthLogin(controller.signal);
          return;
        }
        const deviceCode = await requestChatGPTDeviceCode();
        setNotice(`Open ${deviceCode.verificationUrl} and enter code ${deviceCode.userCode} (Esc cancels)`);
        await completeChatGPTDeviceLogin(deviceCode, controller.signal);
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
          setBusy(undefined);
        });
    },
    [busy, refreshConnections],
  );

  /**
   * Copy the credential this source is authenticating with right now into occ's
   * own store, where the account plane cannot reach it.
   *
   * The capture is refused rather than approximated when the environment holds
   * nothing pinnable — most importantly when `ANTHROPIC_API_KEY` is a mirror of
   * some other provider's secret. See captureCredential.ts.
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
      if ('error' in captured) {
        setNotice(`${row.label}: ${captured.error}`);
        return;
      }
      setBusy({ id: row.id, kind: 'pin' });
      void pinSearchCredential(family, captured.credential)
        .then(() => {
          setOverrideVersion(v => v + 1);
          refreshConnections();
          setNotice(`${row.label} pinned — kept through /logout and provider switches. D removes it.`);
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
        void unpinSearchCredential(family)
          .then(() => {
            resetSourceAvailability();
            setOverrideVersion(v => v + 1);
            refreshConnections();
            setNotice(`${row.label} credential unpinned — this source follows your provider configuration again.`);
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

      {notice ? (
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
                : `${'↑↓'} navigate · Space toggle · Enter toggle/log in · S pin credential · D unpin/disconnect · R re-check · Esc close`}
        </Text>
      </Box>
    </Box>
  );
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <SearchSettingPanel onClose={onDone} _context={context} />;
};
