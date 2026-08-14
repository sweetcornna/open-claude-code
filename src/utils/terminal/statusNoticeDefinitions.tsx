// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '@anthropic/ink';
import * as React from 'react';
import { getLargeMemoryFiles, MAX_MEMORY_CHARACTER_COUNT, type MemoryFileInfo } from '../session/claudemd.js';
import figures from 'figures';
import { getCwd } from '../filesystem/cwd.js';
import { relative } from 'path';
import { formatNumber } from '../text/format.js';
import type { getGlobalConfig } from '../config/config.js';
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  isClaudeAISubscriber,
} from '../auth/auth.js';
import type { AgentDefinitionsResult } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { getAgentDescriptionsTotalTokens, AGENT_DESCRIPTIONS_THRESHOLD } from './statusNoticeHelpers.js';
import { getContextWindowNotice } from './contextWindowNotice.js';
import { formatContextTokens } from '../model/tierSettings.js';
import { modelSupports1M } from '../session/context.js';
import { isSupportedJetBrainsTerminal, toIDEDisplayName, getTerminalIdeType } from './ide.js';
import { isJetBrainsPluginInstalledCachedSync } from './jetbrains.js';

// Types
export type StatusNoticeType = 'warning' | 'info';

export type StatusNoticeContext = {
  config: ReturnType<typeof getGlobalConfig>;
  agentDefinitions?: AgentDefinitionsResult;
  memoryFiles: MemoryFileInfo[];
};

export type StatusNoticeDefinition = {
  id: string;
  type: StatusNoticeType;
  isActive: (context: StatusNoticeContext) => boolean;
  render: (context: StatusNoticeContext) => React.ReactNode;
};

// Individual notice definitions
const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: ctx => getLargeMemoryFiles(ctx.memoryFiles).length > 0,
  render: ctx => {
    const largeMemoryFiles = getLargeMemoryFiles(ctx.memoryFiles);
    return (
      <>
        {largeMemoryFiles.map(file => {
          const displayPath = file.path.startsWith(getCwd()) ? relative(getCwd(), file.path) : file.path;

          return (
            <Box key={file.path} flexDirection="row">
              <Text color="warning">{figures.warning}</Text>
              <Text color="warning">
                Large <Text bold>{displayPath}</Text> will impact performance ({formatNumber(file.content.length)} chars
                &gt; {formatNumber(MAX_MEMORY_CHARACTER_COUNT)})<Text dimColor> · /memory to edit</Text>
              </Text>
            </Box>
          );
        })}
      </>
    );
  },
};

const claudeAiSubscriberExternalTokenNotice: StatusNoticeDefinition = {
  id: 'claude-ai-external-token',
  type: 'warning',
  isActive: () => {
    const authTokenInfo = getAuthTokenSource();
    return (
      isClaudeAISubscriber() &&
      (authTokenInfo.source === 'ANTHROPIC_AUTH_TOKEN' || authTokenInfo.source === 'apiKeyHelper')
    );
  },
  render: () => {
    const authTokenInfo = getAuthTokenSource();
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Auth conflict: Using {authTokenInfo.source} instead of Claude account subscription token. Either unset{' '}
          {authTokenInfo.source}, or run `/logout`.
        </Text>
      </Box>
    );
  },
};

const apiKeyConflictNotice: StatusNoticeDefinition = {
  id: 'api-key-conflict',
  type: 'warning',
  isActive: () => {
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    });
    return (
      !!getApiKeyFromConfigOrMacOSKeychain() &&
      (apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper')
    );
  },
  render: () => {
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    });
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Auth conflict: Using {apiKeySource} instead of Anthropic Console key. Either unset {apiKeySource}, or run
          `/logout`.
        </Text>
      </Box>
    );
  },
};

const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  isActive: () => {
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    });
    const authTokenInfo = getAuthTokenSource();
    return (
      apiKeySource !== 'none' &&
      authTokenInfo.source !== 'none' &&
      !(apiKeySource === 'apiKeyHelper' && authTokenInfo.source === 'apiKeyHelper')
    );
  },
  render: () => {
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    });
    const authTokenInfo = getAuthTokenSource();
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color="warning">{figures.warning}</Text>
          <Text color="warning">
            Auth conflict: Both a token ({authTokenInfo.source}) and an API key ({apiKeySource}) are set. This may lead
            to unexpected behavior.
          </Text>
        </Box>
        <Box flexDirection="column" marginLeft={3}>
          <Text color="warning">
            · Trying to use {authTokenInfo.source === 'claude.ai' ? 'claude.ai' : authTokenInfo.source}?{' '}
            {apiKeySource === 'ANTHROPIC_API_KEY'
              ? 'Unset the ANTHROPIC_API_KEY environment variable, or /logout then say "No" to the API key approval before login.'
              : apiKeySource === 'apiKeyHelper'
                ? 'Unset the apiKeyHelper setting.'
                : '/logout'}
          </Text>
          <Text color="warning">
            · Trying to use {apiKeySource}?{' '}
            {authTokenInfo.source === 'claude.ai'
              ? '/logout to sign out of claude.ai.'
              : `Unset the ${authTokenInfo.source} environment variable.`}
          </Text>
        </Box>
      </Box>
    );
  },
};

const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return totalTokens > AGENT_DESCRIPTIONS_THRESHOLD;
  },
  render: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return (
      <Box flexDirection="row">
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Large cumulative agent descriptions will impact performance (~
          {formatNumber(totalTokens)} tokens &gt; {formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)})
          <Text dimColor> · /agents to manage</Text>
        </Text>
      </Box>
    );
  },
};

/**
 * The configured context window is not the one this session will get.
 *
 * `modelSettings.<tier>.contextTokens` is occ's own knob and it accepts numbers
 * the endpoint will not serve. The clamp that fixes the accounting is silent by
 * construction, and a window that quietly drops from 372k to 200k is
 * indistinguishable from occ ignoring the setting — so it is said out loud,
 * once, at startup, with the two ways out.
 */
const contextWindowCappedNotice: StatusNoticeDefinition = {
  id: 'context-window-capped',
  type: 'warning',
  isActive: () => getContextWindowNotice()?.kind === 'capped',
  render: () => {
    const notice = getContextWindowNotice();
    if (notice?.kind !== 'capped') return null;
    // Anything strictly between 200k and 1M is unreachable on every Anthropic
    // model, so the 1M advice is only useful where 1M is actually available.
    const remedy = modelSupports1M(notice.model)
      ? `use ${formatContextTokens(1_000_000)} for the 1M opt-in, or lower it to ${formatContextTokens(notice.window)}`
      : `lower it to ${formatContextTokens(notice.window)}`;
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Context window capped to {formatContextTokens(notice.window)} — {notice.model} cannot serve the{' '}
          {formatContextTokens(notice.configured)} configured for it. To change it, {remedy}
          <Text dimColor> · /model-settings</Text>
        </Text>
      </Box>
    );
  },
};

/**
 * occ has no idea how big this model's window is and is guessing.
 *
 * Only fires when nothing has answered the question: an env override or a
 * per-tier setting both win outright and silence this. The number occ picked is
 * stated rather than hidden, because the failure it precedes — auto-compact
 * never firing before a hard prompt-too-long — reads as a model bug otherwise.
 */
const assumedContextWindowNotice: StatusNoticeDefinition = {
  id: 'assumed-context-window',
  type: 'warning',
  isActive: () => getContextWindowNotice()?.kind === 'assumed',
  render: () => {
    const notice = getContextWindowNotice();
    if (notice?.kind !== 'assumed') return null;
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          occ does not recognize <Text bold>{notice.model}</Text>, so it assumes a {formatContextTokens(200_000)}{' '}
          context window. If the real one differs, set CLAUDE_CODE_MAX_CONTEXT_TOKENS
          <Text dimColor> · /model-settings</Text>
        </Text>
      </Box>
    );
  },
};

const jetbrainsPluginNotice: StatusNoticeDefinition = {
  id: 'jetbrains-plugin-install',
  type: 'info',
  isActive: context => {
    // Only show if running in JetBrains built-in terminal
    if (!isSupportedJetBrainsTerminal()) {
      return false;
    }
    // Don't show if auto-install is disabled
    const shouldAutoInstall = context.config.autoInstallIdeExtension ?? true;
    if (!shouldAutoInstall) {
      return false;
    }
    // Check if plugin is already installed (cached to avoid repeated filesystem checks)
    const ideType = getTerminalIdeType();
    return ideType !== null && !isJetBrainsPluginInstalledCachedSync(ideType);
  },
  render: () => {
    const ideType = getTerminalIdeType();
    const ideName = toIDEDisplayName(ideType);
    return (
      <Box flexDirection="row" gap={1} marginLeft={1}>
        <Text color="ide">{figures.arrowUp}</Text>
        <Text>
          Install the <Text color="ide">{ideName}</Text> plugin from the JetBrains Marketplace:{' '}
          <Text bold>https://docs.claude.com/s/claude-code-jetbrains</Text>
        </Text>
      </Box>
    );
  },
};

// All notice definitions
export const statusNoticeDefinitions: StatusNoticeDefinition[] = [
  largeMemoryFilesNotice,
  largeAgentDescriptionsNotice,
  contextWindowCappedNotice,
  assumedContextWindowNotice,
  claudeAiSubscriberExternalTokenNotice,
  apiKeyConflictNotice,
  bothAuthMethodsNotice,
  jetbrainsPluginNotice,
];

// Helper functions for external use
export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  return statusNoticeDefinitions.filter(notice => notice.isActive(context));
}
