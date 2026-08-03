/**
 * /search-setting — pick which sources an aggregated web search uses.
 *
 * The four sources are symmetric (see
 * packages/builtin-tools/.../adapters/searchSources.ts): three provider search
 * layers plus the keyless one. A source is ticked when its credentials exist,
 * unless the user said otherwise, and settings store only those explicit
 * choices — so a fresh login shows up here already ticked, with nothing to
 * configure.
 *
 * Enter on a disconnected provider source starts that provider's OAuth flow
 * and the row flips to connected + ticked when it returns.
 *
 * Interaction copies /web-tools and EffortPanel: ↑/↓ move, space/enter act,
 * Esc closes, Ctrl+C/D exit through the shared hook.
 */

import { Box, Text, useInput } from '@anthropic/ink';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { getGeminiOAuthAccessToken, startGeminiOAuthLogin } from '../../services/api/gemini/oauthToken.js';
import {
  completeChatGPTDeviceLogin,
  getStoredChatGPTAccountId,
  hasStoredChatGPTAuth,
  requestChatGPTDeviceCode,
} from '../../services/api/openai/chatgptAuth.js';
import { hasAnthropicSearchCredentials } from '../../services/search/sourceCredentials.js';
import type { LocalJSXCommandCall, LocalJSXCommandContext } from '../../types/command.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../../utils/settings/settings.js';
import {
  isSourceAvailable,
  isSourceEnabled,
  primarySourceId,
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
  isCurrentProvider: boolean;
  canLogin: boolean;
};

const SOURCE_HINTS: Record<SearchSourceId, string> = {
  anthropic: 'Anthropic runs the search server-side and returns cited results',
  gemini: 'Google Search grounding through your Google account',
  codex: 'OpenAI Responses API web_search through your ChatGPT account',
  free: 'DuckDuckGo + Mojeek + Bing scraping — no account needed',
};

/** Only the OAuth-backed provider sources have a login flow to offer. */
const LOGIN_CAPABLE: ReadonlySet<SearchSourceId> = new Set(['gemini', 'codex']);

/**
 * Connection state for one source: whether it is usable, and (when the
 * credential carries one) which account it belongs to, so a user with several
 * logins can tell which one is feeding their searches.
 */
async function readConnection(id: SearchSourceId): Promise<{ connected: boolean; account?: string }> {
  switch (id) {
    case 'anthropic':
      return { connected: hasAnthropicSearchCredentials() };
    case 'gemini':
      return {
        connected: (await getGeminiOAuthAccessToken()) !== null || Boolean(process.env.GEMINI_API_KEY),
      };
    case 'codex': {
      const oauth = await hasStoredChatGPTAuth();
      return {
        connected: oauth || Boolean(process.env.OPENAI_API_KEY),
        ...(oauth ? { account: await getStoredChatGPTAccountId() } : {}),
      };
    }
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
    return { text: 'unavailable for this account', dim: true };
  }
  if (row.connection === 'checking') {
    return { text: 'checking…', dim: true };
  }
  if (row.connection === 'connected') {
    if (row.id === 'free') return { text: '✓ no account needed', color: 'success' };
    return { text: row.account ? `✓ connected (${row.account})` : '✓ connected', color: 'success' };
  }
  return row.canLogin
    ? { text: 'not connected → enter to log in', color: 'warning' }
    : { text: 'not connected', dim: true };
}

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
    gemini: 'checking',
    codex: 'checking',
    free: 'connected',
  });
  const [accounts, setAccounts] = useState<Partial<Record<SearchSourceId, string>>>({});
  const [overrideVersion, setOverrideVersion] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [loginInFlight, setLoginInFlight] = useState<SearchSourceId | undefined>(undefined);

  const insideModal = useIsInsideModal();
  const { rows } = useTerminalSize();
  const contentHeight = insideModal ? rows + 1 : Math.max(14, Math.min(Math.floor(rows * 0.7), 24));

  useExitOnCtrlCDWithKeybindings();

  const refreshConnections = useCallback(() => {
    let cancelled = false;
    for (const id of SEARCH_SOURCE_IDS) {
      void readConnection(id).then(({ connected, account }) => {
        if (cancelled) return;
        setConnections(prev => ({ ...prev, [id]: connected ? 'connected' : 'disconnected' }));
        if (account) setAccounts(prev => ({ ...prev, [id]: account }));
      });
    }
    return () => {
      cancelled = true;
    };
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
    isCurrentProvider: id === provider,
    canLogin: LOGIN_CAPABLE.has(id),
  }));

  const toggleSource = useCallback((row: SourceRow) => {
    if (!row.available) {
      setNotice(`${row.label} is unavailable for this account.`);
      return;
    }
    writeOverride(row.id, !row.enabled);
    setOverrideVersion(v => v + 1);
    setNotice(`${row.label} ${row.enabled ? 'disabled' : 'enabled'}.`);
  }, []);

  const startLogin = useCallback(
    (row: SourceRow) => {
      if (loginInFlight) return;
      setLoginInFlight(row.id);
      setNotice(`Starting ${row.label} login…`);

      const run = async (): Promise<void> => {
        if (row.id === 'gemini') {
          await startGeminiOAuthLogin();
          return;
        }
        const deviceCode = await requestChatGPTDeviceCode();
        setNotice(`Open ${deviceCode.verificationUrl} and enter code ${deviceCode.userCode}`);
        await completeChatGPTDeviceLogin(deviceCode);
      };

      void run()
        .then(() => {
          // A fresh login has credentials, so the source is on by default —
          // clear any stale explicit "off" so the row really is ticked.
          const settings = getSettings_DEPRECATED() as unknown as SettingsJson;
          if (settings.webSearchSources?.[row.id] === false) {
            writeOverride(row.id, true);
          }
          setOverrideVersion(v => v + 1);
          refreshConnections();
          setNotice(`${row.label} connected.`);
        })
        .catch((error: unknown) => {
          setNotice(`${row.label} login failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => setLoginInFlight(undefined));
    },
    [loginInFlight, refreshConnections],
  );

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
      onClose('Search sources panel dismissed');
      return;
    }
    const row = sourceRows[cursor];
    if (!row) return;
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
        <Text dimColor>{'↑↓'} navigate · Space toggle · Enter toggle/log in · Esc close</Text>
      </Box>
    </Box>
  );
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <SearchSettingPanel onClose={onDone} _context={context} />;
};
