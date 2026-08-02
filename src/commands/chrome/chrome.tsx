import React, { useState } from 'react';
import { type OptionWithDescription, Select } from '../../components/CustomSelect/select.js';
import { Dialog } from '@anthropic/ink';
import { Box, Text } from '@anthropic/ink';
import { BIN_NAME } from '../../constants/brand.js';
import { useAppState } from '../../state/AppState.js';
import { openBrowser } from '../../utils/network/browser.js';
import type { ChromeDetection } from '../../utils/chromeDevtools/chromeVersion.js';
import { detectChrome } from '../../utils/chromeDevtools/chromeVersion.js';
import {
  CHROME_AUTOCONNECT_MIN_MAJOR,
  CHROME_BROWSER_URL_ENV,
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
} from '../../utils/chromeDevtools/common.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';

const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';
const CHROME_DEVTOOLS_MCP_URL = 'https://github.com/ChromeDevTools/chrome-devtools-mcp';

type MenuAction = 'install-chrome' | 'toggle-default' | 'learn-more';

type Props = {
  onDone: (result?: string) => void;
  chrome: ChromeDetection;
  configEnabled: boolean | undefined;
};

function ChromeDevtoolsMenu({ onDone, chrome, configEnabled }: Props): React.ReactNode {
  const mcpClients = useAppState(s => s.mcp.clients);
  const [enabledByDefault, setEnabledByDefault] = useState(configEnabled ?? false);

  const client = mcpClients.find(c => c.name === CHROME_DEVTOOLS_MCP_SERVER_NAME);
  const isConnected = client?.type === 'connected';

  // Same three-way split doctor reports, so the two surfaces never disagree.
  const mode = chrome.browserUrl ? 'browser-url' : chrome.supportsAutoConnect ? 'auto-connect' : 'launch';

  function handleAction(action: MenuAction): void {
    switch (action) {
      case 'install-chrome':
        void openBrowser(CHROME_DOWNLOAD_URL);
        break;
      case 'learn-more':
        void openBrowser(CHROME_DEVTOOLS_MCP_URL);
        break;
      case 'toggle-default': {
        const newValue = !enabledByDefault;
        saveGlobalConfig(current => ({
          ...current,
          chromeDevtoolsDefaultEnabled: newValue,
        }));
        setEnabledByDefault(newValue);
        break;
      }
    }
  }

  const options: OptionWithDescription<MenuAction>[] = [];
  if (!chrome.version && !chrome.browserUrl) {
    options.push({ label: 'Install Google Chrome', value: 'install-chrome' });
  }
  options.push(
    { label: `Enabled by default: ${enabledByDefault ? 'Yes' : 'No'}`, value: 'toggle-default' },
    { label: 'Open the chrome-devtools-mcp docs', value: 'learn-more' },
  );

  return (
    <Dialog title="Chrome browser tools" onCancel={() => onDone()} color="chromeYellow">
      <Box flexDirection="column" gap={1}>
        <Text>
          Browser control runs through Google&apos;s chrome-devtools-mcp server. It can navigate pages, click and type,
          capture snapshots and screenshots, and read console output, network requests, performance traces, and
          Lighthouse audits.
        </Text>

        <Box flexDirection="column">
          <Text>
            Status: {isConnected ? <Text color="success">Connected</Text> : <Text color="inactive">Not connected</Text>}
          </Text>
          <Text>
            Chrome:{' '}
            {chrome.version ? (
              <Text color={chrome.supportsAutoConnect ? 'success' : 'warning'}>{chrome.version}</Text>
            ) : (
              <Text color="warning">not detected</Text>
            )}
          </Text>
          <Text>
            Connection:{' '}
            {mode === 'browser-url' ? (
              <Text color="success">{chrome.browserUrl}</Text>
            ) : mode === 'auto-connect' ? (
              <Text color="success">attach to your running Chrome (autoConnect)</Text>
            ) : (
              <Text color="warning">launch a separate browser (no logins)</Text>
            )}
          </Text>
        </Box>

        {chrome.note && <Text color="warning">{chrome.note}</Text>}

        <Select options={options} onChange={handleAction} hideIndexes />

        <Text>
          <Text dimColor>Usage: </Text>
          <Text>{BIN_NAME} --chrome</Text>
          <Text dimColor> or </Text>
          <Text>{BIN_NAME} --no-chrome</Text>
        </Text>

        <Text dimColor>
          Read-only tools (snapshots, screenshots, console, network) run unprompted. Anything that clicks, types,
          navigates, or evaluates script asks for permission first.
        </Text>

        <Text dimColor>
          autoConnect needs Chrome {CHROME_AUTOCONNECT_MIN_MAJOR}+ with remote debugging enabled via
          chrome://inspect/#remote-debugging. On WSL or a remote host, start Chrome with --remote-debugging-port=9222
          and set {CHROME_BROWSER_URL_ENV}.
        </Text>
      </Box>
    </Dialog>
  );
}

export const call = async function (onDone: (result?: string) => void): Promise<React.ReactNode> {
  const chrome = await detectChrome();
  const config = getGlobalConfig();

  return <ChromeDevtoolsMenu onDone={onDone} chrome={chrome} configEnabled={config.chromeDevtoolsDefaultEnabled} />;
};
