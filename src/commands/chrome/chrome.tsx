import React, { useState } from 'react';
import { type OptionWithDescription, Select } from '../../components/CustomSelect/select.js';
import { Dialog } from '@anthropic/ink';
import { Box, Text } from '@anthropic/ink';
import { BIN_NAME } from '../../constants/brand.js';
import { useAppState } from '../../state/AppState.js';
import { openBrowser } from '../../utils/network/browser.js';
import type { ChromeDetection } from '../../utils/browserUse/chromeVersion.js';
import { detectChrome } from '../../utils/browserUse/chromeVersion.js';
import { BROWSER_USE_MCP_SERVER_NAME } from '../../utils/browserUse/common.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config/config.js';

const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';
const BROWSER_USE_URL = 'https://github.com/browser-use/browser-use';

type MenuAction = 'install-chrome' | 'toggle-default' | 'learn-more';

type Props = {
  onDone: (result?: string) => void;
  chrome: ChromeDetection;
  configEnabled: boolean | undefined;
};

function BrowserToolMenu({ onDone, chrome, configEnabled }: Props): React.ReactNode {
  const mcpClients = useAppState(s => s.mcp.clients);
  const [enabledByDefault, setEnabledByDefault] = useState(configEnabled ?? false);

  const client = mcpClients.find(c => c.name === BROWSER_USE_MCP_SERVER_NAME);
  const isConnected = client?.type === 'connected';

  function handleAction(action: MenuAction): void {
    switch (action) {
      case 'install-chrome':
        void openBrowser(CHROME_DOWNLOAD_URL);
        break;
      case 'learn-more':
        void openBrowser(BROWSER_USE_URL);
        break;
      case 'toggle-default': {
        const newValue = !enabledByDefault;
        saveGlobalConfig(current => ({
          ...current,
          browserToolDefaultEnabled: newValue,
        }));
        setEnabledByDefault(newValue);
        break;
      }
    }
  }

  const options: OptionWithDescription<MenuAction>[] = [];
  if (!chrome.version) {
    options.push({ label: 'Install Google Chrome', value: 'install-chrome' });
  }
  options.push(
    { label: `Enabled by default: ${enabledByDefault ? 'Yes' : 'No'}`, value: 'toggle-default' },
    { label: 'Open the browser-use docs', value: 'learn-more' },
  );

  return (
    <Dialog title="Browser tools" onCancel={() => onDone()} color="chromeYellow">
      <Box flexDirection="column" gap={1}>
        <Text>
          Browser control runs through the browser-use MCP server. It can read page state, extract content, navigate,
          click and type, and manage tabs — or hand a whole task to an autonomous browsing agent.
        </Text>

        <Box flexDirection="column">
          <Text>
            Status: {isConnected ? <Text color="success">Connected</Text> : <Text color="inactive">Not connected</Text>}
          </Text>
          <Text>
            Browser:{' '}
            {chrome.version ? <Text color="success">{chrome.version}</Text> : <Text color="warning">not detected</Text>}
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
          browser-use is a Python tool launched through uvx, and it needs Chrome or Chromium installed. Install uv from
          docs.astral.sh/uv if --chrome reports it missing.
        </Text>
      </Box>
    </Dialog>
  );
}

export const call = async function (onDone: (result?: string) => void): Promise<React.ReactNode> {
  const chrome = await detectChrome();
  const config = getGlobalConfig();

  return <BrowserToolMenu onDone={onDone} chrome={chrome} configEnabled={config.chromeDevtoolsDefaultEnabled} />;
};
