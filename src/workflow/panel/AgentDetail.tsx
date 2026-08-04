import React from 'react';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { AgentProgress } from '../progress/store.js';
import { agentElapsedMs, formatDuration } from './selectors.js';
import { agentStatusText, agentVisual, formatTokenCount, shortModelName } from './status.js';

/** Human copy for the engine's cause-of-death classification. */
const FAILURE_REASON_TEXT: Record<string, string> = {
  'no-structured-output': 'finished without producing StructuredOutput',
  'runagent-threw': 'the agent run threw',
  'worktree-failed': 'git worktree creation failed',
  'prompt-too-long': 'prompt exceeded the context window',
  'api-error': 'terminal API error',
  unknown: 'unclassified failure',
};

/**
 * How much of the stored output preview to render. The store already caps
 * what it retains (OUTPUT_PREVIEW_MAX); this second cap keeps a single long
 * line from pushing the key hints off a short terminal.
 */
const PREVIEW_RENDER_MAX = 240;

/** One `label   value` row. Labels share a fixed width so values line up. */
function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Box>
      <Box width={10}>
        <Text color="subtle">{label}</Text>
      </Box>
      {children}
    </Box>
  );
}

/**
 * Detail view for one selected agent — the third focus level of the
 * /workflows panel, reached with Enter/→ from the agent list.
 *
 * The list can only afford a mark, a label, and two numbers. Everything that
 * explains *why* an agent is in its current state — the failure reason and
 * detail, whether a retry could even help, what it returned — only exists
 * here. Before this view a dead agent was an unexplained ✗ and the only way
 * to find the cause was to read the run journal by hand.
 */
export function AgentDetail({ agent }: { agent: AgentProgress }): React.ReactNode {
  // Shared 1s clock so a running agent's duration ticks in place.
  const [clockRef] = useAnimationFrame(1000);
  const visual = agentVisual(agent);
  const elapsed = agentElapsedMs(agent, Date.now());
  const failed = agent.resultKind === 'dead';

  return (
    <Box ref={clockRef} flexDirection="column">
      <Box>
        <Text color={visual.color as keyof Theme}>{visual.mark}</Text>
        <Text bold> {agent.label ?? `agent-${agent.id}`}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Field label="status">
          <Text color={visual.color as keyof Theme}>{agentStatusText(agent)}</Text>
        </Field>
        <Field label="phase">
          <Text>{agent.phase ?? '(none)'}</Text>
        </Field>
        <Field label="model">
          <Text>{agent.model ? shortModelName(agent.model) : '(pending)'}</Text>
        </Field>
        <Field label="elapsed">
          <Text>{elapsed === null ? '(not recorded)' : formatDuration(elapsed)}</Text>
        </Field>
        <Field label="context">
          <Text>{formatTokenCount(agent.tokenCount)} tok</Text>
        </Field>
        {agent.outputTokens !== undefined ? (
          <Field label="output">
            <Text>{formatTokenCount(agent.outputTokens)} tok</Text>
          </Field>
        ) : null}
        <Field label="tools">
          <Text>{agent.toolCount ?? 0} calls</Text>
        </Field>
      </Box>

      {failed ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="error" bold>
            Failure
          </Text>
          <Text color="error">{FAILURE_REASON_TEXT[agent.failureReason ?? 'unknown'] ?? agent.failureReason}</Text>
          {agent.retryable === false ? (
            <Text color="subtle">Deterministic — re-running the identical call cannot succeed.</Text>
          ) : null}
          {agent.failureDetail ? <Text color="subtle">{agent.failureDetail.slice(0, PREVIEW_RENDER_MAX)}</Text> : null}
        </Box>
      ) : null}

      {agent.resultKind === 'skipped' ? (
        <Box marginTop={1}>
          <Text color="subtle">Skipped — this agent was not run, so it produced no result.</Text>
        </Box>
      ) : null}

      {agent.outputPreview ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>
            Result <Text color="subtle">({agent.outputShape === 'object' ? 'object' : 'text'})</Text>
          </Text>
          <Text color="subtle">{agent.outputPreview.slice(0, PREVIEW_RENDER_MAX)}</Text>
        </Box>
      ) : null}

      {agent.status === 'running' ? (
        <Box marginTop={1}>
          <Text color="subtle">Still running — token and tool counts update live.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
