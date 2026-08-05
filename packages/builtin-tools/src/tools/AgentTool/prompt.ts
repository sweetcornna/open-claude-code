/**
 * Agent tool prompt text.
 *
 * PURE LEAF — must not import from `src/`, and may only import other tools'
 * `constants.ts`. The GrowthBook read (agent-list delivery), the auth read
 * (subscription tier), the teammate/embedded-tools/fork checks and the agent
 * list formatting all live outside this file now; AgentTool.tsx computes them
 * and passes the results as params.
 *
 * Per-agent content is still fully dynamic — it arrives as `agentLines`.
 * Nothing here may be cached at module scope: the agent list changes when MCP
 * servers connect, plugins reload, or the permission mode changes.
 *
 * The output feeds the API prompt cache; see the characterization snapshots in
 * tools/__tests__/promptCharacterization.runner.ts.
 */
import { FILE_READ_TOOL_NAME } from '../FileReadTool/constants.js'
import { GLOB_TOOL_NAME } from '../GlobTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'

export interface AgentPromptParams {
  /**
   * Pre-formatted `- type: whenToUse (Tools: ...)` lines, already filtered by
   * MCP requirements, deny rules and `allowedAgentTypes`. Null when the list
   * is delivered as an agent_listing_delta attachment instead — see
   * agentListing.ts for why.
   */
  agentLines: string[] | null
  /**
   * Coordinator mode gets the slim prompt: the coordinator system prompt
   * already covers usage notes, examples, and when-not-to-use guidance.
   */
  isCoordinator: boolean
  /**
   * Fork subagent feature: inserts the "When to fork" section (fork semantics,
   * directive-style prompts) and swaps in fork-aware examples.
   */
  forkEnabled: boolean
  /**
   * Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
   * dedicated Glob/Grep tools, so point at find via Bash instead.
   */
  embeddedSearchTools: boolean
  /**
   * The "launch multiple agents concurrently" note. Only rendered for the
   * inline list — when listing via attachment the note lives in the attachment
   * message, conditioned on subscription there.
   */
  includeConcurrencyNote: boolean
  /**
   * Drops the "use proactively" and "run agents in parallel" usage notes.
   * GPT-family models read them as standing orders and fan out subagents the
   * user never asked for.
   */
  suppressProactiveGuidance: boolean
  /** run_in_background is offered when background tasks are on and this is not an in-process teammate. */
  backgroundAgentsAvailable: boolean
  /** USER_TYPE === 'ant' — gets the remote CCR isolation note. */
  antUser: boolean
  /** In-process teammates only support synchronous subagents. */
  inProcessTeammate: boolean
  /** Teammates cannot spawn other teammates. */
  teammate: boolean
}

export function renderAgentPrompt(p: AgentPromptParams): string {
  const forkEnabled = p.forkEnabled

  const whenToForkSection = forkEnabled
    ? `

## When to fork

When you need to delegate work that benefits from full conversation context (e.g., continuing a multi-file refactor where the child needs the same system prompt and history), use \`fork: true\`. For most tasks, prefer specialized agent types (Explore, Plan, general-purpose).

**Don't peek.** The tool result includes an \`output_file\` path — do not Read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it.

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results. If the user asks a follow-up before the notification lands, tell them the fork is still running.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope. Don't re-explain background.
`
    : ''

  const writingThePromptSection = `

## Writing the prompt

${forkEnabled ? 'When spawning an agent without `fork: true`, it starts with zero context. ' : ''}Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why, what you've already learned or ruled out, and enough context for the agent to make judgment calls.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

${forkEnabled ? 'For non-fork agents, terse' : 'Terse'} command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
`

  const agentListSection =
    p.agentLines === null
      ? `Available agent types are listed in <system-reminder> messages in the conversation.`
      : `Available agent types and the tools they have access to:
${p.agentLines.join('\n')}`

  // Shared core prompt used by both coordinator and non-coordinator modes
  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.${forkEnabled ? ` Set \`fork: true\` to fork from the parent conversation context, inheriting full history and model.` : ''}`

  if (p.isCoordinator) {
    return shared
  }

  const embedded = p.embeddedSearchTools
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // The "class Foo" example is about content search. Non-embedded stays Glob
  // (original intent: find-the-file-containing). Embedded gets grep because
  // find -name doesn't look at file contents.
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use ${contentSearchHint} instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`

  const concurrencyNote = p.includeConcurrencyNote
    ? `
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses`
    : ''

  const proactiveGuidance = p.suppressProactiveGuidance
    ? ''
    : `
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.`

  // Non-coordinator gets the full prompt with all sections
  return `${shared}
${whenNotToUseSection}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do${concurrencyNote}
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.${
    p.backgroundAgentsAvailable
      ? `
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.`
      : ''
  }
- To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved. ${forkEnabled ? 'Each non-fork Agent invocation starts without context — provide a complete task description.' : 'Each Agent invocation starts fresh — provide a complete task description.'}
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkEnabled ? '' : ", since it is not aware of the user's intent"}${proactiveGuidance}
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.${
    p.antUser
      ? `\n- You can set \`isolation: "remote"\` to run the agent in a remote CCR environment. This is always a background task; you'll be notified when it completes. Use for long-running tasks that need a fresh sandbox.`
      : ''
  }${
    p.inProcessTeammate
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : p.teammate
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${whenToForkSection}${writingThePromptSection}`
}
