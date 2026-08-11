/**
 * Every OpenAI-compatible endpoint requires a function's `parameters` to be a
 * top-level `type: "object"` JSON Schema. Anthropic's `input_schema` does not,
 * so a tool whose zod schema is a top-level union (Workflow) — or an MCP tool
 * whose `inputJSONSchema` we do not author — used to take down every request on
 * the session. Measured against OpenCode Go (`opencode.ai/zen/go/v1`, kimi-k3):
 *
 *   API Error [OpenAI]: Error from provider (Console Go): Upstream request
 *   failed: [invalid_request_error] Invalid schema for function 'Workflow':
 *   schema must be a JSON Schema of 'type: "object"', got 'type: null'.
 *
 * This builds the exact tools payload occ puts on the wire — both lanes send
 * tools — and asserts the shape the endpoint validates.
 */
import { describe, expect, test } from 'bun:test'
import { anthropicToolsToOpenAI } from '@ant/model-provider'
import { workflowInputSchema } from '@open-claude-code/workflow-engine/tool/schema.js'
import { zodToJsonSchema } from '../../../../utils/text/zodToJsonSchema.js'
import { buildOpenAIRequestBody } from '../requestBody.js'
import { buildResponsesRequest } from '../responsesAdapter.js'

/** What toolToAPISchema() produces for the Workflow tool, verbatim. */
const workflowInputJsonSchema = zodToJsonSchema(workflowInputSchema)

/**
 * An MCP server may publish any JSON Schema it likes; a bare union is legal and
 * occ never gets to rewrite it at the source.
 */
const mcpUnionTool = {
  type: 'custom',
  name: 'mcp__example__operate',
  description: 'synthetic MCP tool with a bare union schema',
  input_schema: {
    anyOf: [
      {
        type: 'object',
        properties: { mode: { const: 'read' }, path: { type: 'string' } },
        required: ['mode', 'path'],
      },
      {
        type: 'object',
        properties: { mode: { const: 'write' }, body: { type: 'string' } },
        required: ['mode', 'body'],
      },
    ],
  },
}

const anthropicTools = [
  {
    type: 'custom',
    name: 'Workflow',
    description: 'Launch and control workflow runs',
    input_schema: workflowInputJsonSchema,
  },
  {
    type: 'custom',
    name: 'Bash',
    description: 'Run a command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  mcpUnionTool,
] as unknown as Parameters<typeof anthropicToolsToOpenAI>[0]

function topLevelType(parameters: unknown): unknown {
  return (parameters as { type?: unknown } | undefined)?.type
}

/** Chat lane shape: { type: 'function', function: { parameters } }. */
function chatToolParameters(tool: unknown): unknown {
  return (tool as { function?: { parameters?: unknown } }).function?.parameters
}

describe('OpenAI-wire tool schemas', () => {
  test('the Workflow zod schema really is a bare top-level union', () => {
    // The precondition this whole fix exists for. If this ever stops holding,
    // the normalization below is a no-op for Workflow and the guard is stale.
    expect(workflowInputJsonSchema.type).toBeUndefined()
    expect(Array.isArray(workflowInputJsonSchema.anyOf)).toBe(true)
  })

  test('chat lane: every tool goes out as type object', () => {
    const openaiTools = anthropicToolsToOpenAI(anthropicTools)
    const body = buildOpenAIRequestBody({
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: openaiTools,
      toolChoice: undefined,
      enableThinking: false,
      maxTokens: 1024,
      baseURL: 'https://opencode.ai/zen/go/v1',
    })

    expect(body.tools).toHaveLength(3)
    for (const tool of body.tools ?? []) {
      expect(topLevelType(chatToolParameters(tool))).toBe('object')
    }
  })

  test('responses lane: every tool goes out as type object', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi' }],
      tools: anthropicToolsToOpenAI(anthropicTools),
      toolChoice: undefined,
    })

    expect(request.tools).toHaveLength(3)
    for (const tool of request.tools ?? []) {
      expect(topLevelType(tool.parameters)).toBe('object')
    }
  })

  test('Workflow still exposes the run/status/cancel contract', () => {
    const [workflow] = anthropicToolsToOpenAI(anthropicTools)
    const parameters = chatToolParameters(workflow) as {
      properties: Record<string, { anyOf?: { enum?: unknown[] }[] }>
      anyOf: unknown[]
    }

    // Fields from each branch survive the flattening.
    expect(Object.keys(parameters.properties)).toEqual(
      expect.arrayContaining(['operation', 'script', 'runId', 'agentId']),
    )
    // The discriminator still names every operation the tool accepts.
    const operations = (parameters.properties.operation?.anyOf ?? []).flatMap(
      variant => variant.enum ?? [],
    )
    expect(operations).toEqual(['run', 'status', 'query', 'cancel'])
    // And the exact per-branch contract is still on the wire.
    expect(parameters.anyOf).toHaveLength(3)
  })
})
