/**
 * Bound how much of a finished subagent's progress trail the parent keeps.
 *
 * Every message a subagent produces is wrapped in an `agent_progress` message
 * and appended to the PARENT session's `messages` array. Unlike bash/mcp ticks
 * — which REPL.tsx replaces in place — agent progress is deliberately appended,
 * because the live AgentTool UI renders the whole trail (replacing it leaves the
 * row stuck at "Initializing…"). Nothing ever removed those entries, so the
 * parent accumulated the complete content of every subagent it had ever run.
 *
 * That is unbounded in the one dimension that matters. A measured session:
 * 216 subagents, one of them alone producing 1,270 assistant messages across
 * 1,269 tool calls, 63.7 MB of subagent transcript on disk. The parent held all
 * of it as ~270k progress messages — plus the parallel normalizedMessages copy,
 * the progressMessagesByToolUseID index, and the retained render tree for every
 * row — and died on a 4 GB heap with a mark-compact that reclaimed 7 MB. It was
 * live data, not GC pressure.
 *
 * The cut is made when the agent's tool_result arrives, never while it runs:
 * - A running agent's trail is untouched, so live rendering is byte-identical.
 * - A finished agent renders through renderToolResultMessage, which takes its
 *   counts and summary from the tool result itself, not from this trail. Only
 *   transcript mode (Ctrl+R) walks the trail, and only to re-display messages
 *   that are already durably on disk in `subagents/agent-<id>.jsonl`.
 *
 * A tail is kept rather than nothing: agents shorter than the cap are entirely
 * unaffected (the common case sees no behavior change at all), and when a long
 * one is trimmed the part people go looking for — how it ended — survives.
 */
import type { Message } from '../../types/message.js'

/**
 * Progress entries retained per finished subagent. 20 covers a short agent's
 * whole trail; the pathological 1,269-call agent above drops to ~1.5% of its
 * former footprint.
 */
const DEFAULT_RETAINED_TAIL = 20

/**
 * `CLAUDE_CODE_AGENT_PROGRESS_RETAIN` overrides the cap. 0 drops finished
 * trails entirely; a very large value effectively restores the old
 * keep-everything behavior for anyone who needs it.
 */
export function retainedAgentProgressCount(): number {
  const raw = process.env.CLAUDE_CODE_AGENT_PROGRESS_RETAIN
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_RETAINED_TAIL
}

/** tool_use ids answered by this message, if it carries tool results. */
export function resolvedToolUseIDsIn(message: Message): string[] {
  if (message.type !== 'user') return []
  const content = (message as { message?: { content?: unknown } }).message
    ?.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_result'
    ) {
      const id = (block as { tool_use_id?: unknown }).tool_use_id
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

/** The tool_use id this message is an agent_progress entry for, if it is one. */
function agentProgressOwner(message: Message): string | undefined {
  if (message.type !== 'progress') return undefined
  const m = message as {
    parentToolUseID?: unknown
    data?: { type?: unknown }
  }
  if (m.data?.type !== 'agent_progress') return undefined
  return typeof m.parentToolUseID === 'string' ? m.parentToolUseID : undefined
}

/**
 * Drop all but the last `retain` agent_progress entries for each of
 * `finishedToolUseIDs`.
 *
 * Returns the SAME array reference when nothing is dropped — REPL state and the
 * memoized message rows are compared by identity, so allocating a copy on every
 * tool result would defeat the render memoization this is meant to protect.
 */
export function pruneFinishedAgentProgress(
  messages: Message[],
  finishedToolUseIDs: readonly string[],
  retain: number = retainedAgentProgressCount(),
): Message[] {
  if (finishedToolUseIDs.length === 0) return messages

  // Count in ONE pass over messages, not one pass per id. Every tool_result
  // reaches this function — Read, Bash, everything — and the overwhelming
  // majority own no trail at all, so the scan that finds nothing is the hot
  // path and must not be multiplied by the number of results in the message.
  //
  // Index 0 is excluded from the count for the same reason it is excluded from
  // dropping below, so the retained tail is exactly `retain` either way.
  const wanted = new Set(finishedToolUseIDs)
  const counts = new Map<string, number>()
  for (let i = 1; i < messages.length; i++) {
    const owner = agentProgressOwner(messages[i]!)
    if (owner !== undefined && wanted.has(owner)) {
      counts.set(owner, (counts.get(owner) ?? 0) + 1)
    }
  }

  const overBudget = new Map<string, number>()
  for (const [toolUseID, droppable] of counts) {
    if (droppable > retain) overBudget.set(toolUseID, droppable - retain)
  }
  if (overBudget.size === 0) return messages

  // Drop from the front: `toDrop` counts down as the oldest entries are skipped,
  // which leaves exactly the last `retain` for each id.
  //
  // Index 0 is never dropped. useLogMessages distinguishes a same-head shrink
  // (tombstone/rewind/snip — safe, and this) from a compaction by comparing
  // messages[0].uuid; changing the head would route this through the compaction
  // branch, which resolves the transcript parent chain differently. Progress
  // messages are not loggable (isLoggableMessage returns false for them), so
  // keeping one extra costs nothing and the transcript is untouched either way.
  const result: Message[] = [messages[0]!]
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!
    const owner = agentProgressOwner(message)
    const toDrop = owner === undefined ? undefined : overBudget.get(owner)
    if (toDrop !== undefined && toDrop > 0) {
      overBudget.set(owner!, toDrop - 1)
      continue
    }
    result.push(message)
  }
  return result
}
