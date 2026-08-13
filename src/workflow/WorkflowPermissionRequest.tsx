import React, { useCallback, useMemo } from 'react';
import { Box, Text, useTheme } from '@anthropic/ink';
import { getTheme, type Theme } from 'src/utils/terminal/theme.js';
import { env } from 'src/utils/config/env.js';
import { shouldShowAlwaysAllowOptions } from 'src/utils/permissions/permissionsLoader.js';
import { logUnaryEvent } from 'src/utils/telemetry/unaryLogging.js';
import { PermissionDialog } from 'src/components/permissions/PermissionDialog.js';
import { PermissionPrompt, type PermissionPromptOption } from 'src/components/permissions/PermissionPrompt.js';
import type { PermissionRequestProps } from 'src/components/permissions/PermissionRequest.js';
import { PermissionRuleExplanation } from 'src/components/permissions/PermissionRuleExplanation.js';
import { workflowInputSchema, type WorkflowInput, type WorkflowRunInput } from '@open-claude-code/workflow-engine';

type OptionValue = 'yes' | 'yes-dont-ask-again' | 'no';

const PREVIEW_MAX = 500;

function boundedPreview(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length <= PREVIEW_MAX ? text : `${text.slice(0, PREVIEW_MAX)}…`;
}

function workflowPermissionDetails(input: WorkflowInput): {
  action: string;
  source?: string;
  script?: string;
  args?: string;
  allowRuleContent?: string;
} {
  if (input.operation === 'status' || input.operation === 'query') {
    return { action: `Inspect workflow run: ${input.runId}` };
  }
  if (input.operation === 'cancel') {
    return {
      action:
        input.agentId === undefined
          ? `Cancel workflow run: ${input.runId}`
          : `Cancel agent ${input.agentId} in workflow run: ${input.runId}`,
    };
  }

  const runInput = input as WorkflowRunInput;
  const source = runInput.script
    ? 'Inline workflow script'
    : runInput.scriptPath
      ? `Script path: ${runInput.scriptPath}`
      : runInput.name
        ? `Named workflow: ${runInput.name}`
        : 'Workflow source unavailable';
  return {
    action: runInput.resumeFromRunId ? `Resume workflow run: ${runInput.resumeFromRunId}` : 'Execute workflow',
    source,
    ...(runInput.script ? { script: boundedPreview(runInput.script) } : {}),
    ...(runInput.args !== undefined ? { args: boundedPreview(runInput.args) } : {}),
    ...(runInput.name && !runInput.script && !runInput.scriptPath ? { allowRuleContent: runInput.name } : {}),
  };
}

/**
 * Permission request UI for the WorkflowTool. Asks the user to confirm
 * executing a workflow script.
 * Follows the MonitorPermissionRequest / FallbackPermissionRequest pattern.
 */
export function WorkflowPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const parsedInput = workflowInputSchema.safeParse(toolUseConfirm.input);
  const details = parsedInput.success ? workflowPermissionDetails(parsedInput.data) : { action: 'Execute workflow' };

  const showAlwaysAllowOptions = useMemo(() => shouldShowAlwaysAllowOptions(), []);

  const options: PermissionPromptOption<OptionValue>[] = useMemo(() => {
    const opts: PermissionPromptOption<OptionValue>[] = [
      {
        label: 'Yes',
        value: 'yes',
        feedbackConfig: { type: 'accept' as const },
      },
    ];
    if (showAlwaysAllowOptions && details.allowRuleContent) {
      opts.push({
        label: (
          <Text>
            Yes, and don{'\u2019'}t ask again for workflow <Text bold>{details.allowRuleContent}</Text>
          </Text>
        ),
        value: 'yes-dont-ask-again',
      });
    }
    opts.push({
      label: 'No',
      value: 'no',
      feedbackConfig: { type: 'reject' as const },
    });
    return opts;
  }, [showAlwaysAllowOptions, details.allowRuleContent]);

  const handleSelect = useCallback(
    (value: OptionValue, feedback?: string) => {
      switch (value) {
        case 'yes':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id ?? '',
              platform: env.platform,
            },
          });
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback);
          onDone();
          break;
        case 'yes-dont-ask-again':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id ?? '',
              platform: env.platform,
            },
          });
          if (!details.allowRuleContent) break;
          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [
                {
                  toolName: toolUseConfirm.tool.name,
                  ruleContent: details.allowRuleContent,
                },
              ],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ]);
          onDone();
          break;
        case 'no':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'reject',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id ?? '',
              platform: env.platform,
            },
          });
          toolUseConfirm.onReject(feedback);
          onReject();
          onDone();
          break;
      }
    },
    [toolUseConfirm, onDone, onReject, details.allowRuleContent],
  );

  const handleCancel = useCallback(() => {
    logUnaryEvent({
      completion_type: 'tool_use_single',
      event: 'reject',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id ?? '',
        platform: env.platform,
      },
    });
    toolUseConfirm.onReject();
    onReject();
    onDone();
  }, [toolUseConfirm, onDone, onReject]);

  return (
    <PermissionDialog title="Workflow" workerBadge={workerBadge}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={theme.permission as keyof Theme}>
            {details.action}
          </Text>
          {details.source && <Text dimColor>{details.source}</Text>}
          {details.script && <Text dimColor>{details.script}</Text>}
          {details.args && <Text dimColor>Arguments: {details.args}</Text>}
        </Box>
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="command" />
        <PermissionPrompt<OptionValue> options={options} onSelect={handleSelect} onCancel={handleCancel} />
      </Box>
    </PermissionDialog>
  );
}
