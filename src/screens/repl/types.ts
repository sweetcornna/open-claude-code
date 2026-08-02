import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import type {
  Message as MessageType,
  HookResultMessage,
} from '../../types/message.js'
import type { FileHistorySnapshot } from '../../utils/filesystem/fileHistory.js'
import type { ContentReplacementRecord } from '../../utils/tools/toolResultStorage.js'
import type { AgentColorName } from '@open-claude-code/builtin-tools/tools/AgentTool/agentColorManager.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { RemoteSessionConfig } from '../../remote/RemoteSessionManager.js'
import type { SSHSession } from '../../ssh/createSSHSession.js'
import type { ThinkingConfig } from '../../utils/model/thinking.js'

export type Props = {
  commands: Command[]
  debug: boolean
  initialTools: Tool[]
  // Initial messages to populate the REPL with
  initialMessages?: MessageType[]
  // Deferred hook messages promise — REPL renders immediately and injects
  // hook messages when they resolve. Awaited before the first API call.
  pendingHookMessages?: Promise<HookResultMessage[]>
  initialFileHistorySnapshots?: FileHistorySnapshot[]
  // Content-replacement records from a resumed session's transcript — used to
  // reconstruct contentReplacementState so the same results are re-replaced
  initialContentReplacements?: ContentReplacementRecord[]
  // Initial agent context for session resume (name/color set via /rename or /color)
  initialAgentName?: string
  initialAgentColor?: AgentColorName
  mcpClients?: MCPServerConnection[]
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  autoConnectIdeFlag?: boolean
  strictMcpConfig?: boolean
  systemPrompt?: string
  appendSystemPrompt?: string
  // Optional callback invoked before query execution
  // Called after user message is added to conversation but before API call
  // Return false to prevent query execution
  onBeforeQuery?: (
    input: string,
    newMessages: MessageType[],
  ) => Promise<boolean>
  // Optional callback when a turn completes (model finishes responding)
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>
  // When true, disables REPL input (hides prompt and prevents message selector)
  disabled?: boolean
  // Optional agent definition to use for the main thread
  mainThreadAgentDefinition?: AgentDefinition
  // When true, disables all slash commands
  disableSlashCommands?: boolean
  // Task list id: when set, enables tasks mode that watches a task list and auto-processes tasks.
  taskListId?: string
  // Remote session config for --remote mode (uses CCR as execution engine)
  remoteSessionConfig?: RemoteSessionConfig
  // SSH session for `claude ssh` mode (local REPL, remote tools over ssh)
  sshSession?: SSHSession
  // Thinking configuration to use when thinking is enabled
  thinkingConfig: ThinkingConfig
}

export type Screen = 'prompt' | 'transcript'
