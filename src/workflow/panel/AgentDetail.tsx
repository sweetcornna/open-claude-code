import React from 'react';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { AgentProgress } from '../progress/store.js';
import { agentElapsedMs, formatDuration } from './selectors.js';
import {
  agentStatusText,
  agentVisual,
  formatTokenCount,
  isRetryBackoffActive,
  isRunReaped,
  shortModelName,
} from './status.js';

/**
 * Human copy for the engine's cause-of-death classification.
 *
 * The `run-*` keys are not engine verdicts: the store stamps them on agents that were
 * still running when the run ended, so without an entry here the pane rendered the raw
 * internal identifier — and labelled a user-requested kill a failure.
 */
const FAILURE_REASON_TEXT: Record<string, string> = {
  'no-structured-output': 'finished without producing StructuredOutput',
  'runagent-threw': 'the agent run threw',
  'worktree-failed': 'git worktree creation failed',
  'prompt-too-long': 'prompt exceeded the context window',
  'api-error': 'terminal API error',
  'agent-total-timeout': 'hit the total execution budget (CLAUDE_CODE_AGENT_TOTAL_TIMEOUT_MS)',
  'agent-no-progress':
    'produced no tool result for the whole no-progress window (CLAUDE_CODE_AGENT_NO_PROGRESS_TIMEOUT_MS)',
  'run-killed': 'stopped when the workflow was killed',
  'run-failed': 'stopped when the workflow failed',
  'run-ended': 'still running when the workflow ended',
  unknown: 'unclassified failure',
};

/**
 * Failure reasons that are reported `retryable:false` for a reason other than
 * "the identical call cannot succeed".
 *
 * The watchdog limits are wall-clock verdicts: the same call might well finish
 * next time, and the reason the engine does not retry them by itself is a
 * budget decision — a retry re-runs the agent from zero with a fresh timer, so
 * an automatic chain multiplies the very wall clock the limit exists to bound.
 * Printing the deterministic line here told the user the opposite of the truth
 * and steered them away from the one fix that works: raise the env knob named
 * in the reason text (or re-run it yourself).
 */
const NON_DETERMINISTIC_FAILURE_REASONS = new Set(['agent-total-timeout', 'agent-no-progress']);

/**
 * How much of the stored output preview to render. The store already caps
 * what it retains (OUTPUT_PREVIEW_MAX); this second cap keeps a single long
 * line from pushing the key hints off a short terminal.
 */
const PREVIEW_RENDER_MAX = 240;

/** Width of the label column; the continuation row indents by the same amount. */
const LABEL_COL = 10;

/**
 * `2/3` for a bounded retry chain, plain `2` when the engine reported no limit.
 * retryCount is the attempt agent_retry announced, so it is already the number of the
 * attempt about to start — not the count of attempts finished.
 */
function retryAttemptLabel(agent: AgentProgress): string {
  const attempt = agent.retryCount ?? 1;
  return agent.retryLimit === undefined ? `${attempt}` : `${attempt}/${agent.retryLimit}`;
}

/** One `label   value` row. Labels share a fixed width so values line up. */
function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Box>
      <Box width={LABEL_COL}>
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
  // One clock read for both the duration and the backoff window, so the pane can't
  // claim the engine is still waiting on a line it already stopped counting for.
  const now = Date.now();
  const elapsed = agentElapsedMs(agent, now);
  const backingOff = isRetryBackoffActive(agent, now);
  // Reaped-with-the-run is still resultKind 'dead', but it gets the same neutral
  // treatment as the ⊘ mark and the "stopped" status word rather than a red
  // Failure block the user would read as "my kill broke something".
  const reaped = isRunReaped(agent);
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
        {/* The list row can only show a retry while the backoff is running — a two-to-eight
            second window. Everywhere else, an agent that survived three retries looked
            identical to one that sailed through, and lastFailureDetail had no reader at
            all. This is where the retry history lives once the agent is moving again. */}
        {agent.retryCount !== undefined ? (
          <Field label="retries">
            <Text>
              {agent.retryCount}
              {agent.retryLimit === undefined ? '' : `/${agent.retryLimit}`}
              {agent.lastFailureReason ? <Text color="subtle"> ({agent.lastFailureReason})</Text> : null}
            </Text>
          </Field>
        ) : null}
        {agent.retryCount !== undefined && agent.lastFailureDetail ? (
          <Box>
            <Box width={LABEL_COL} />
            <Text color="subtle" wrap="truncate-end">
              {agent.lastFailureDetail.slice(0, PREVIEW_RENDER_MAX)}
            </Text>
          </Box>
        ) : null}
        <Field label="tools">
          <Text>{agent.toolCount ?? 0} calls</Text>
        </Field>
      </Box>

      {failed ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={reaped ? 'subtle' : 'error'} bold>
            {reaped ? 'Stopped' : 'Failure'}
          </Text>
          <Text color={reaped ? 'subtle' : 'error'}>
            {FAILURE_REASON_TEXT[agent.failureReason ?? 'unknown'] ?? agent.failureReason}
          </Text>
          {agent.retryable === false && !NON_DETERMINISTIC_FAILURE_REASONS.has(agent.failureReason ?? '') ? (
            <Text color="subtle">Deterministic — re-running the identical call cannot succeed.</Text>
          ) : null}
          {NON_DETERMINISTIC_FAILURE_REASONS.has(agent.failureReason ?? '') ? (
            <Text color="subtle">Timed out — not retried automatically, since each retry restarts the clock.</Text>
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
          {/* During a backoff nothing is moving, so promising live counts is a lie —
              and the frozen numbers are exactly what made a retrying agent look hung. */}
          <Text color="subtle">
            {backingOff
              ? `Waiting to retry — attempt ${retryAttemptLabel(agent)} starts after a ${formatDuration(
                  agent.retryDelayMs ?? 0,
                )} backoff.`
              : 'Still running — token and tool counts update live.'}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
