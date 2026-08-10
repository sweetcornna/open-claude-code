type ConnectionIdentity = {
  name: string
  client: object
}

type RefreshToken = {
  connection: ConnectionIdentity
  client: object
  generation: number
}

/**
 * Prevents overlapping tools/list_changed refreshes from publishing stale tools.
 * Generations belong to the actual MCP client, while the active connection map
 * also guards against a replaced connection with the same server name.
 */
export function createToolsListChangedRefreshGuard() {
  const activeConnections = new Map<string, ConnectionIdentity>()
  const generations = new WeakMap<object, number>()

  return {
    activate(connection: ConnectionIdentity): void {
      activeConnections.set(connection.name, connection)
    },

    deactivate(connection: ConnectionIdentity): void {
      const activeConnection = activeConnections.get(connection.name)
      if (activeConnection?.client === connection.client) {
        activeConnections.delete(connection.name)
      }
    },

    async refresh<T>(
      connection: ConnectionIdentity,
      fetchValue: () => Promise<T>,
      publish: (value: T) => void,
    ): Promise<boolean> {
      const generation = (generations.get(connection.client) ?? 0) + 1
      generations.set(connection.client, generation)
      const token: RefreshToken = {
        connection,
        client: connection.client,
        generation,
      }

      const value = await fetchValue()
      const activeConnection = activeConnections.get(connection.name)
      if (
        activeConnection !== token.connection ||
        activeConnection.client !== token.client ||
        generations.get(token.client) !== token.generation
      ) {
        return false
      }

      publish(value)
      return true
    },
  }
}
