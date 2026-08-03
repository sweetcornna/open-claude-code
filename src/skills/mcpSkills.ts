import type {
  ListResourcesResult,
  ReadResourceResult,
} from '@modelcontextprotocol/client'
import type { Command } from '../commands.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import { memoizeWithLRU } from '../utils/collections/memoize.js'
import { errorMessage } from '../utils/runtime/errors.js'
import { logMCPDebug, logMCPError } from '../utils/telemetry/log.js'
import { recursivelySanitizeUnicode } from '../utils/text/sanitization.js'
import { parseFrontmatter } from '../utils/text/frontmatterParser.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

const SKILL_URI_PREFIX = 'skill://'
const MCP_FETCH_CACHE_SIZE = 20
const MAX_MCP_SKILLS_PER_SERVER = 32
const MAX_MCP_SKILL_BYTES = 256 * 1024
const MAX_MCP_SKILLS_TOTAL_BYTES = 1024 * 1024
const MCP_SKILL_DISCOVERY_TIMEOUT_MS = 10_000

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

    const controller = new AbortController()
    const deadline = Date.now() + MCP_SKILL_DISCOVERY_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
      controller.abort(new Error('MCP skill discovery timed out'))
    }, MCP_SKILL_DISCOVERY_TIMEOUT_MS)
    timeoutId.unref?.()

    try {
      if (!client.capabilities?.resources) {
        return []
      }

      // List all resources and filter to skill:// URIs. v2 resolves the
      // result schema from the spec method name — no schema argument.
      const result: ListResourcesResult = await client.client.request(
        {
          method: 'resources/list',
        },
        {
          signal: controller.signal,
          timeout: MCP_SKILL_DISCOVERY_TIMEOUT_MS,
        },
      )

      if (!result.resources) return []

      const skillResources = []
      for (const resource of result.resources) {
        if (!resource.uri.startsWith(SKILL_URI_PREFIX)) continue
        skillResources.push(resource)
        if (skillResources.length >= MAX_MCP_SKILLS_PER_SERVER) break
      }

      if (skillResources.length === 0) return []

      logMCPDebug(
        client.name,
        `Found ${skillResources.length} skill resource(s)`,
      )

      const { createSkillCommand, parseSkillFrontmatterFields } =
        getMCPSkillBuilders()

      const commands: Command[] = []
      let totalBytes = 0

      for (const resource of skillResources) {
        if (controller.signal.aborted) break

        try {
          const remainingMs = deadline - Date.now()
          if (remainingMs <= 0) {
            controller.abort(new Error('MCP skill discovery timed out'))
            break
          }

          // Read the skill resource content
          const readResult: ReadResourceResult = await client.client.request(
            {
              method: 'resources/read',
              params: { uri: resource.uri },
            },
            {
              signal: controller.signal,
              timeout: remainingMs,
            },
          )

          // Extract text content from the resource
          const textParts: string[] = []
          let resourceBytes = 0
          for (const content of readResult.contents ?? []) {
            if (!('text' in content) || typeof content.text !== 'string') {
              continue
            }
            resourceBytes += Buffer.byteLength(content.text)
            if (resourceBytes <= MAX_MCP_SKILL_BYTES) {
              textParts.push(content.text)
            }
          }

          if (totalBytes + resourceBytes > MAX_MCP_SKILLS_TOTAL_BYTES) {
            logMCPError(
              client.name,
              `MCP skill resources exceed the ${MAX_MCP_SKILLS_TOTAL_BYTES}-byte cumulative limit`,
            )
            break
          }
          totalBytes += resourceBytes

          if (resourceBytes > MAX_MCP_SKILL_BYTES) {
            logMCPError(
              client.name,
              `Skill resource ${resource.uri} exceeds the ${MAX_MCP_SKILL_BYTES}-byte limit, skipping`,
            )
            continue
          }

          const textContent = textParts.join('\n')

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
            'Skill',
            'mcp',
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
          if (controller.signal.aborted) break
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
    } finally {
      clearTimeout(timeoutId)
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)
