import type {
  ListResourcesResult,
  ReadResourceResult,
} from '@modelcontextprotocol/client'
import type { Command } from '../commands.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import { memoizeWithLRU } from '../utils/collections/memoize.js'
import { errorMessage } from '../utils/errors.js'
import { logMCPDebug, logMCPError } from '../utils/telemetry/log.js'
import { recursivelySanitizeUnicode } from '../utils/text/sanitization.js'
import { parseFrontmatter } from '../utils/text/frontmatterParser.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

const SKILL_URI_PREFIX = 'skill://'
const MCP_FETCH_CACHE_SIZE = 20

/**
 * Discovers skills exposed as `skill://` resources by an MCP server.
 *
 * Each matching resource is read, its markdown content is parsed for
 * frontmatter, and the result is converted into a Command that the skill
 * system can index and invoke just like a local `.md` skill file.
 *
 * Memoized by server name so repeated calls within a connection lifecycle
 * return the cached result. Callers invalidate via `.cache.delete(name)`.
 */
export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.resources) {
        return []
      }

      // List all resources and filter to skill:// URIs. v2 resolves the
      // result schema from the spec method name — no schema argument.
      const result: ListResourcesResult = await client.client.request({
        method: 'resources/list',
      })

      if (!result.resources) return []

      const skillResources = result.resources.filter(r =>
        r.uri.startsWith(SKILL_URI_PREFIX),
      )

      if (skillResources.length === 0) return []

      logMCPDebug(
        client.name,
        `Found ${skillResources.length} skill resource(s)`,
      )

      const { createSkillCommand, parseSkillFrontmatterFields } =
        getMCPSkillBuilders()

      const commands: Command[] = []

      for (const resource of skillResources) {
        try {
          // Read the skill resource content
          const readResult: ReadResourceResult = await client.client.request({
            method: 'resources/read',
            params: { uri: resource.uri },
          })

          // Extract text content from the resource
          const textContent = readResult.contents
            ?.map(c => ('text' in c ? c.text : undefined))
            .filter(Boolean)
            .join('\n')

          if (!textContent) {
            logMCPDebug(
              client.name,
              `Skill resource ${resource.uri} returned no text content, skipping`,
            )
            continue
          }

          const sanitizedContent = recursivelySanitizeUnicode(textContent)

          // Parse the markdown frontmatter
          const { frontmatter, content: markdownContent } =
            parseFrontmatter(sanitizedContent)

          // Derive a skill name from the resource URI. Strip the skill://
          // prefix and use the remainder, prefixed with the MCP server name
          // so it is unique across servers.
          const rawName = resource.uri.slice(SKILL_URI_PREFIX.length)
          const skillName =
            'mcp__' + normalizeNameForMCP(client.name) + '__' + rawName

          const parsed = parseSkillFrontmatterFields(
            frontmatter,
            markdownContent,
            skillName,
          )

          commands.push(
            createSkillCommand({
              ...parsed,
              skillName,
              markdownContent,
              source: 'mcp',
              loadedFrom: 'mcp',
              baseDir: undefined,
              paths: undefined,
            }),
          )
        } catch (error) {
          logMCPError(
            client.name,
            `Failed to load skill resource ${resource.uri}: ${errorMessage(error)}`,
          )
        }
      }

      logMCPDebug(
        client.name,
        `Loaded ${commands.length} skill(s) from resources`,
      )

      return commands
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch skill resources: ${errorMessage(error)}`,
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)
