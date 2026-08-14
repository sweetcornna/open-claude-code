import type {
  MCPServerConnection,
  ConnectedMCPServer,
} from '../../services/mcp/types.js'

export function getMcpInstructionsSection(
  mcpClients: MCPServerConnection[] | undefined,
): string | null {
  if (!mcpClients || mcpClients.length === 0) return null

  const clientsWithInstructions = mcpClients
    .filter(
      (client): client is ConnectedMCPServer => client.type === 'connected',
    )
    .filter(client => client.instructions)

  if (clientsWithInstructions.length === 0) return null

  // Cache invariant: mcpClients is in connection-COMPLETION order — servers
  // race at startup, and a mid-session reconnect re-appends the server at the
  // end of the array (useManageMCPConnections). Identical instruction blocks
  // in a different order still change the system-prompt bytes, busting the
  // org-scoped prompt cache (and everything after it) for no semantic reason.
  // Sort by name so the rendered bytes are independent of connection timing.
  // The delta path already sorts the same way (mcpInstructionsDelta.ts).
  clientsWithInstructions.sort((a, b) => a.name.localeCompare(b.name))

  const instructionBlocks = clientsWithInstructions
    .map(client => `## ${client.name}\n${client.instructions}`)
    .join('\n\n')

  return `# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${instructionBlocks}`
}
