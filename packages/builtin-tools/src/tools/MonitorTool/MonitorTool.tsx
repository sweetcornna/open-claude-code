import React from 'react';
import { Text } from '@anthropic/ink';
import { z } from 'zod/v4';
import { TOOL_SUMMARY_MAX_LENGTH } from 'src/constants/toolLimits.js';
import type { ToolResultBlockParam, ToolUseContext, ValidationResult } from '@open-claude-code/tool-runtime/Tool.js';
import { buildTool } from '@open-claude-code/tool-runtime/Tool.js';
import { spawnShellTask } from 'src/tasks/LocalShellTask/LocalShellTask.js';
import { bashToolHasPermission } from '../BashTool/bashPermissions.js';
import type { PermissionResult } from '@open-claude-code/tool-runtime/permissions/PermissionResult.js';
import { lazySchema } from '@open-claude-code/tool-runtime/lazySchema.js';
import { truncate } from 'src/utils/text/format.js';
import { exec } from 'src/utils/Shell.js';
import { getTaskOutputPath } from 'src/utils/task/diskOutput.js';
import { logEvent } from '@open-claude-code/tool-runtime/analytics.js';

import { MONITOR_TOOL_NAME } from './constants.js';

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .optional()
      .describe(
        'The shell command to run as a long-running monitor. Should produce streaming output (e.g., tail -f, watch, polling loops). Provide either this or wait_seconds, never both.',
      ),
    wait_seconds: z
      .number()
      .int()
      .positive()
      .max(86_400)
      .optional()
      .describe(
        'Wake-up timer mode: wait this many seconds in the background, then send a task notification. Use instead of a foreground `sleep`. Provide either this or command, never both.',
      ),
    description: z
      .string()
      .optional()
      .describe(
        'Clear, concise description of what this monitor watches. Used as the label in the background tasks UI. Required in command mode; defaults to a timer label in wait_seconds mode.',
      ),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;
export type MonitorInput = z.infer<InputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z.string(),
    outputFile: z.string(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;
export type MonitorOutput = z.infer<OutputSchema>;

/** Wait mode is selected purely by the presence of `wait_seconds`. */
function isWaitMode(input: Partial<MonitorInput>): boolean {
  return input?.wait_seconds !== undefined;
}

/**
 * The shell command actually executed. Wait mode synthesizes a plain `sleep`
 * so both modes share one exec/spawnShellTask path (and one notification path).
 */
function resolveCommand(input: Partial<MonitorInput>): string {
  return isWaitMode(input) ? `sleep ${input.wait_seconds}` : (input.command ?? '');
}

function resolveDescription(input: Partial<MonitorInput>): string {
  const explicit = input?.description?.trim();
  if (explicit) {
    return explicit;
  }
  return isWaitMode(input) ? `Wake-up timer: ${input.wait_seconds}s` : resolveCommand(input);
}

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint: 'start long-running background monitor for streaming events, or wait pause idle timer for a duration',
  maxResultSizeChars: 10_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },

  async description() {
    return 'Start a long-running background monitor or wake-up timer';
  },
  async prompt() {
    return `Use Monitor to start a long-running background process that streams output (watching logs, polling APIs, tailing files, etc.), or to set a wake-up timer. Work runs in the background and you receive a task notification when it finishes. Use the Read tool with the output file path to check output at any time.

Monitor has two mutually exclusive modes — pass exactly one of \`command\` or \`wait_seconds\`.

Command mode (\`command\`) — watch something:
- Use it for commands that produce ongoing streaming output: \`tail -f\`, log watchers, file watchers, API polling loops, \`watch\` commands
- Do NOT use it for one-shot commands that finish quickly — use Bash for those
- Do NOT use it for commands that need interactive input — they will hang
- The description should clearly explain what is being monitored
- You'll get a task notification when the process exits (stream ends, script fails, or killed)

Wait mode (\`wait_seconds\`) — wait for a fixed duration:
- To wait a fixed amount of time, use \`wait_seconds\`. NEVER run a foreground \`Bash(sleep ...)\` — that blocks you and holds a shell process for the whole duration.
- The timer runs in the background: you end your turn immediately and a task notification wakes you when it elapses.
- To wait for a *condition* rather than a fixed duration, use command mode with an until-loop so you wake as soon as it is true, e.g. \`until curl -sf http://localhost:3000/health; do sleep 2; done\`.

Examples:
- Watching a log file: command="tail -f /var/log/app.log", description="Watch app log for errors"
- Polling an API: command="while true; do curl -s http://localhost:3000/health; sleep 5; done", description="Poll health endpoint every 5s"
- Watching for file changes: command="inotifywait -m -r ./src", description="Watch src directory for file changes"
- Waiting 5 minutes: wait_seconds=300, description="Re-check the deploy in 5 minutes"
- Waiting until a port is up: command="until nc -z localhost 8080; do sleep 2; done", description="Wait for the dev server to accept connections"`;
  },

  isConcurrencySafe() {
    return true;
  },

  isReadOnly() {
    // Monitor executes shell commands which may have side effects
    return false;
  },

  toAutoClassifierInput(input: MonitorInput) {
    return `Monitor: ${resolveCommand(input)}`;
  },

  async checkPermissions(input: MonitorInput, context: ToolUseContext): Promise<PermissionResult> {
    // Wait mode is a pure timer — the synthesized `sleep N` has no side
    // effects and no user-supplied shell text, so it needs no bash permission.
    if (isWaitMode(input)) {
      return { behavior: 'allow', updatedInput: input };
    }
    // Reuse bash permission checking for the underlying command
    return bashToolHasPermission({ command: input.command ?? '' }, context);
  },

  userFacingName() {
    return MONITOR_TOOL_NAME;
  },

  getActivityDescription(input: MonitorInput) {
    if (isWaitMode(input)) {
      return `Waiting ${input.wait_seconds}s`;
    }
    if (!input?.description) {
      return 'Starting monitor';
    }
    return `Monitoring: ${truncate(input.description, TOOL_SUMMARY_MAX_LENGTH)}`;
  },

  async validateInput(input: MonitorInput): Promise<ValidationResult> {
    const hasCommand = input.command !== undefined;
    const hasWait = input.wait_seconds !== undefined;

    if (hasCommand && hasWait) {
      return {
        result: false,
        message: 'Monitor accepts either command or wait_seconds, not both.',
        errorCode: 3,
      };
    }
    if (!hasCommand && !hasWait) {
      return {
        result: false,
        message: 'Monitor requires either command (to watch something) or wait_seconds (to set a wake-up timer).',
        errorCode: 4,
      };
    }
    // Wait mode: zod already enforced a positive integer within bounds, and
    // the description is optional (it defaults to a timer label).
    if (hasWait) {
      return { result: true };
    }
    if (!input.command || input.command.trim() === '') {
      return {
        result: false,
        message: 'Monitor command cannot be empty.',
        errorCode: 1,
      };
    }
    if (!input.description || input.description.trim() === '') {
      return {
        result: false,
        message: 'Monitor description cannot be empty.',
        errorCode: 2,
      };
    }
    return { result: true };
  },

  async call(input: MonitorInput, context: ToolUseContext) {
    const command = resolveCommand(input);
    const description = resolveDescription(input);
    const { abortController, setAppState, toolUseId, agentId } = context;

    logEvent('tengu_monitor_tool_used', {});

    // Create the shell command via exec
    const shellCommand = await exec(command, abortController.signal, 'bash');

    // Spawn as a background task with kind: 'monitor'
    const handle = await spawnShellTask(
      {
        command,
        description,
        shellCommand,
        toolUseId: toolUseId,
        agentId,
        kind: 'monitor',
      },
      {
        abortController,
        getAppState: context.getAppState,
        setAppState,
      },
    );

    const outputFile = getTaskOutputPath(handle.taskId);

    return {
      data: {
        taskId: handle.taskId,
        outputFile,
      },
    };
  },

  renderToolUseMessage(input: MonitorInput, { verbose }) {
    const desc = truncate(resolveDescription(input), 80);
    return `Monitor: ${desc}`;
  },

  mapToolResultToToolResultBlockParam(content: MonitorOutput, toolUseId: string): ToolResultBlockParam {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result',
      content: `Monitor started (task ${content.taskId}). Output file: ${content.outputFile}`,
    };
  },

  renderToolResultMessage(output: MonitorOutput) {
    return (
      <Text>
        Monitor started (task {output.taskId}). Output: {output.outputFile}
      </Text>
    );
  },
});
