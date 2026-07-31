import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type { Command } from '../commands.js';
import { AGENT_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/AgentTool/constants.js';
import { occConfigPath } from '../config/paths.js';

const statusline = {
  type: 'prompt',
  description: "Set up Open Claude Code's status line UI",
  contentLength: 0, // Dynamic content
  aliases: [],
  name: 'statusline',
  progressMessage: 'setting up statusLine',
  allowedTools: [AGENT_TOOL_NAME, 'Read(~/**)', `Edit(${occConfigPath('settings.json')})`],
  source: 'builtin',
  disableNonInteractive: true,
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const prompt = args.trim() || 'Configure my statusLine from my shell PS1 configuration';
    return [
      {
        type: 'text',
        text: `Create an ${AGENT_TOOL_NAME} with subagent_type "statusline-setup" and the prompt "${prompt}"`,
      },
    ];
  },
} satisfies Command;

export default statusline;
