import type { Tools } from '../../Tool.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import {
  tokenizeAndStem,
  computeWeightedTf,
  computeIdf,
  cosineSimilarity,
} from '../skillSearch/localSearch.js'
import { isDeferredTool } from '@open-claude-code/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
import { zodToJsonSchema } from '../../utils/text/zodToJsonSchema.js'

export interface ToolIndexEntry {
  name: string
  normalizedName: string
  description: string
  searchHint: string | undefined
  isMcp: boolean
  isDeferred: boolean
  inputSchema: object | undefined
  tokens: string[]
  tfVector: Map<string, number>
}

export interface SearchExtraToolsResult {
  name: string
  description: string
  searchHint: string | undefined
  score: number
  isMcp: boolean
  isDeferred: boolean
  inputSchema: object | undefined
}

const TOOL_FIELD_WEIGHT = {
  name: 3.0,
  searchHint: 2.5,
  description: 1.0,
} as const

const SEARCH_EXTRA_TOOLS_DISPLAY_MIN_SCORE = Number(
  process.env.SEARCH_EXTRA_TOOLS_DISPLAY_MIN_SCORE ?? '0.10',
)

const CJK_MIN_BIGRAM_MATCHES = 2

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/

let nextToolDefinitionId = 1
const toolDefinitionIds = new WeakMap<object, number>()

function getDefinitionIdentity(value: unknown): string {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  ) {
    return JSON.stringify(value) ?? String(value)
  }

  let id = toolDefinitionIds.get(value)
  if (id === undefined) {
    id = nextToolDefinitionId++
    toolDefinitionIds.set(value, id)
  }
  return `#${id}`
}

function getOwnPropertyIdentity(tool: object, property: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(tool, property)
  if (!descriptor) return ''
  if ('value' in descriptor) return getDefinitionIdentity(descriptor.value)
  return `get:${getDefinitionIdentity(descriptor.get)}`
}

/**
 * Cache key for the live deferred-tool definitions.
 *
 * tools/list_changed may replace a tool with the same name but a different
 * prompt, search hint, or schema. Object/function/schema identities catch that
 * normal immutable replacement path without eagerly rendering every prompt or
 * rebuilding the index on every search. The scalar fields also catch the few
 * definitions that are updated in place.
 */
export function getToolDefinitionsCacheKey(tools: Tools): string {
  return tools
    .filter(isDeferredTool)
    .map(tool =>
      JSON.stringify([
        tool.name,
        getDefinitionIdentity(tool),
        tool.searchHint,
        tool.isMcp === true,
        tool.alwaysLoad === true,
        getOwnPropertyIdentity(tool, 'prompt'),
        getOwnPropertyIdentity(tool, 'inputJSONSchema'),
        getOwnPropertyIdentity(tool, 'inputSchema'),
      ]),
    )
    .sort()
    .join('\n')
}

function isCjk(ch: string): boolean {
  return CJK_RANGE.test(ch)
}

export function parseToolName(name: string): {
  parts: string[]
  full: string
  isMcp: boolean
} {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return {
    parts,
    full: parts.join(' '),
    isMcp: false,
  }
}

/**
 * JSON Schema for a tool's parameters, or undefined if it declares none.
 *
 * Deferred tools are NOT in the API tools array (claude.ts filters them out),
 * so this is the ONLY channel through which the model ever learns their
 * parameters — SearchExtraTools renders it into the tool_result text.
 *
 * Only MCP tools carry `inputJSONSchema`; built-in deferred tools declare a
 * zod `inputSchema`. Reading just the former left every built-in's schema
 * undefined, so the model had to guess parameter names from the tool name
 * while ExecuteExtraTool validated against the real zod schema (and
 * `strictObject` rejects unknown keys too). That is the source of the
 * reproducible failures — DiscoverSkills missing `description` / passing
 * `query`, Monitor passing `task_id`: not model error, an interface that
 * never handed over the contract.
 */
export function getToolInputJSONSchema(tool: {
  inputJSONSchema?: object
  inputSchema?: unknown
}): object | undefined {
  // The whole body is guarded, not just the conversion. Built-in tools expose
  // `inputSchema` as a lazy getter (`get inputSchema() { return inputSchema() }`
  // over lazySchema), and this is the first path that forces every deferred
  // tool's getter during indexing — so the property READ can throw too, not
  // only zodToJsonSchema. Leaving the reads outside the try meant one bad tool
  // took down discovery for every tool in the batch, which is the opposite of
  // what this function promises.
  try {
    if (tool.inputJSONSchema) {
      return tool.inputJSONSchema
    }
    if (!tool.inputSchema) {
      return undefined
    }
    return zodToJsonSchema(tool.inputSchema as never)
  } catch {
    // Never let one unrepresentable schema break discovery — the tool stays
    // findable, just without parameter detail.
    return undefined
  }
}

export async function buildToolIndex(tools: Tools): Promise<ToolIndexEntry[]> {
  const deferredTools = tools.filter(t => isDeferredTool(t))

  const entries: ToolIndexEntry[] = []
  for (const tool of deferredTools) {
    let description = ''
    try {
      description = await tool.prompt({
        getToolPermissionContext: async () => ({
          mode: 'default' as const,
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
        }),
        tools,
        agents: [],
      })
    } catch {
      description = ''
    }

    const { parts: nameParts, full: normalizedName } = parseToolName(tool.name)
    const searchHint = tool.searchHint ?? ''
    const nameTokens = tokenizeAndStem(nameParts.join(' '))
    const hintTokens = tokenizeAndStem(searchHint)
    const descTokens = tokenizeAndStem(description)

    const allTokens = [
      ...new Set([...nameTokens, ...hintTokens, ...descTokens]),
    ]

    const tfVector = computeWeightedTf([
      { tokens: nameTokens, weight: TOOL_FIELD_WEIGHT.name },
      { tokens: hintTokens, weight: TOOL_FIELD_WEIGHT.searchHint },
      { tokens: descTokens, weight: TOOL_FIELD_WEIGHT.description },
    ])

    const inputSchema = getToolInputJSONSchema(tool)

    entries.push({
      name: tool.name,
      normalizedName,
      description,
      searchHint: tool.searchHint,
      isMcp: tool.isMcp === true,
      isDeferred: true,
      inputSchema,
      tokens: allTokens,
      tfVector,
    })
  }

  const idf = computeIdf(entries)

  for (const entry of entries) {
    for (const [term, tf] of entry.tfVector) {
      entry.tfVector.set(term, tf * (idf.get(term) ?? 0))
    }
  }

  logForDebugging(
    `[search-extra-tools] indexed ${entries.length} deferred tools from ${tools.length} total tools`,
  )
  return entries
}

export function searchTools(
  query: string,
  index: ToolIndexEntry[],
  limit = 5,
): SearchExtraToolsResult[] {
  if (index.length === 0 || !query.trim()) return []

  const queryTokens = tokenizeAndStem(query)
  if (queryTokens.length === 0) return []

  const queryTf = new Map<string, number>()
  const freq = new Map<string, number>()
  for (const t of queryTokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  let max = 1
  for (const v of freq.values()) if (v > max) max = v
  for (const [term, count] of freq) queryTf.set(term, count / max)

  const idf = computeIdf(index)
  const queryTfIdf = new Map<string, number>()
  for (const [term, tf] of queryTf) {
    queryTfIdf.set(term, tf * (idf.get(term) ?? 0))
  }

  const queryCjkTokens = queryTokens.filter(t => isCjk(t[0] ?? ''))
  const queryAsciiTokens = queryTokens.filter(t => !isCjk(t[0] ?? ''))
  const queryLower = query.toLowerCase().replace(/[-_]/g, ' ')

  const results: SearchExtraToolsResult[] = []
  for (const entry of index) {
    let score = cosineSimilarity(queryTfIdf, entry.tfVector)

    if (queryCjkTokens.length > 0 && score > 0) {
      const matchingCjk = queryCjkTokens.filter(t => entry.tfVector.has(t))
      if (matchingCjk.length < CJK_MIN_BIGRAM_MATCHES) {
        const hasAsciiMatch = queryAsciiTokens.some(t => entry.tfVector.has(t))
        if (!hasAsciiMatch) score = 0
      }
    }

    if (queryLower.includes(entry.normalizedName)) {
      score = Math.max(score, 0.75)
    }

    if (score >= SEARCH_EXTRA_TOOLS_DISPLAY_MIN_SCORE) {
      results.push({
        name: entry.name,
        description: entry.description,
        searchHint: entry.searchHint,
        score,
        isMcp: entry.isMcp,
        isDeferred: entry.isDeferred,
        inputSchema: entry.inputSchema,
      })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

let cachedIndex: ToolIndexEntry[] | null = null
let cachedToolDefinitions: string | null = null

export async function getToolIndex(tools: Tools): Promise<ToolIndexEntry[]> {
  const currentKey = getToolDefinitionsCacheKey(tools)

  if (cachedIndex && cachedToolDefinitions === currentKey) {
    return cachedIndex
  }

  cachedIndex = await buildToolIndex(tools)
  cachedToolDefinitions = currentKey
  return cachedIndex
}

export function clearToolIndexCache(): void {
  cachedIndex = null
  cachedToolDefinitions = null
  logForDebugging('[search-extra-tools] index cache cleared')
}
