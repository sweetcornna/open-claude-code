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
 * Three things a row can do beyond being ticked:
 *   - Enter on a disconnected provider source starts that provider's OAuth flow
 *     and the row flips to connected + ticked when it returns.
 *   - `d` disconnects a source whose credentials this panel owns, so a login can
 *     be undone without leaving the CLI.
 *   - `r` re-checks every row, which also clears the session-scoped "this source
 *     failed, stop using it" flags. Without that, a source retired before the
 *     user fixed the underlying problem stays greyed out until restart — the
 *     "I logged in and it still does not work" shape.
 *
 * Anything that touches the network is cancellable: Esc while an operation is in
 * flight aborts it rather than closing the panel. An OAuth flow parked on a
 * callback listener the user has already abandoned is otherwise unbounded.
 *
 * Interaction copies /web-tools and EffortPanel: ↑/↓ move, space/enter act,
 * Esc closes, Ctrl+C/D exit through the shared hook.
 */

import { Box, Text, useInput } from '@anthropic/ink';
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
import {
  hasAnthropicSearchCredentials,
  hasCodexSearchCredentials,
  hasDeepSeekSearchCredentials,
} from '../../services/search/sourceCredentials.js';
import type { LocalJSXCommandCall, LocalJSXCommandContext } from '../../types/command.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../../utils/settings/settings.js';
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
        connected: (await getGeminiOAuthAccessToken()) !== null || Boolean(process.env.GEMINI_API_KEY),
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
  const settings = getSettings_DEPRECATED() as unknown as SettingsJson;
  const next: SourceOverrides = { ...(settings.webSearchSources ?? {}), [id]: enabled };
  updateSettingsForSource('userSettings', {
    webSearchSources: next,
  } as unknown as SettingsJson);
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
      return `${row.label} uses this session's provider login. Press Space to switch the lane off, or /logout to sign out.`;
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
    return { text: row.account ? `✓ connected (${row.account})` : '✓ connected', color: 'success' };
  }
  if (row.detail) return { text: row.detail, dim: true };
  return row.canLogin
    ? { text: 'not connected → enter to log in', color: 'warning' }
    : { text: 'not connected', dim: true };
}

/** What an in-flight operation is, so Esc can say what it would cancel. */
type Busy = { id: SearchSourceId; kind: 'login' | 'disconnect' };

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
    canDisconnect: DISCONNECT_CAPABLE.has(id),
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
    writeOverride(row.id, !row.enabled);
    setOverrideVersion(v => v + 1);
    setNotice(`${row.label} ${row.enabled ? 'disabled' : 'enabled'}.`);
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
          const settings = getSettings_DEPRECATED() as unknown as SettingsJson;
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

  const disconnect = useCallback(
    (row: SourceRow) => {
      if (busy) return;
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
                  <Text dimColor>{row.hint}</Text>
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
            : busy
              ? `${'↑↓'} navigate · disconnecting…`
              : `${'↑↓'} navigate · Space toggle · Enter toggle/log in · D disconnect · R re-check · Esc close`}
        </Text>
      </Box>
    </Box>
  );
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <SearchSettingPanel onClose={onDone} _context={context} />;
};
