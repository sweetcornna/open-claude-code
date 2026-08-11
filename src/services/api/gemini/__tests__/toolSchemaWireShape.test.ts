/**
 * Gemini's function-declaration contract is narrower than Anthropic's in two
 * ways, and a union-typed tool schema trips both at once:
 *
 *  1. `FunctionDeclaration.parametersJsonSchema` — the field this lane emits —
 *     "must describe an object where the properties are the parameters to the
 *     function" (generativelanguage v1beta discovery document).
 *  2. "Unable to submit request because `edit` functionDeclaration
 *     `parameters.edits` schema specified other fields alongside any_of. When
 *     using any_of, it must be the only field set."
 *
 * Either one rejects the whole request, every turn of the session, not just the
 * offending tool. The Workflow tool's zod schema is a top-level `z.union([...])`
 * holding a described union (`resumePolicy`), so it hits both; an MCP server may
 * publish a bare union and occ never gets to rewrite it at the source.
 *
 * This drives the real client with an injected fetch and inspects the bytes that
 * would leave the process.
 */
import { describe, expect, test } from 'bun:test'
import { anthropicToolsToGemini } from '@ant/model-provider'
import { workflowInputSchema } from '@open-claude-code/workflow-engine/tool/schema.js'
import { zodToJsonSchema } from '../../../../utils/text/zodToJsonSchema.js'
import { streamGeminiGenerateContent } from '../client.js'

/** What toolToAPISchema() produces for the Workflow tool, verbatim. */
const workflowInputJsonSchema = zodToJsonSchema(workflowInputSchema)

/**
 * An MCP server may publish any JSON Schema it likes; a bare union is legal and
 * occ never authors it.
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
] as unknown as Parameters<typeof anthropicToolsToGemini>[0]

type FunctionDeclaration = {
  name: string
  parametersJsonSchema: Record<string, unknown>
}

/** Runs one request against an injected fetch and returns the JSON body sent. */
async function capturedRequestBody(): Promise<Record<string, unknown>> {
  let sent: string | undefined
  const fetchOverride = (async (_url: unknown, init?: RequestInit) => {
    sent = init?.body as string
    return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', {
      status: 200,
    })
  }) as unknown as typeof fetch

  const stream = streamGeminiGenerateContent({
    model: 'gemini-test',
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: anthropicToolsToGemini(anthropicTools),
    },
    signal: new AbortController().signal,
    accessToken: 'test-token',
    fetchOverride,
  })
  for await (const _chunk of stream) {
    // drain
  }

  if (sent === undefined) throw new Error('no request body was sent')
  return JSON.parse(sent) as Record<string, unknown>
}

function declarationsOf(body: Record<string, unknown>): FunctionDeclaration[] {
  const tools = body.tools as { functionDeclarations?: FunctionDeclaration[] }[]
  return tools.flatMap(tool => tool.functionDeclarations ?? [])
}

/** Every schema object in the payload, at any depth. */
function everySchemaObject(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(everySchemaObject)
  if (!node || typeof node !== 'object') return []
  const self = node as Record<string, unknown>
  return [self, ...Object.values(self).flatMap(everySchemaObject)]
}

describe('Gemini-wire tool schemas', () => {
  test('the Workflow zod schema really is a bare top-level union', () => {
    // The precondition this whole fix exists for. If it ever stops holding, the
    // normalization is a no-op for Workflow and this guard is stale.
    expect(workflowInputJsonSchema.type).toBeUndefined()
    expect(Array.isArray(workflowInputJsonSchema.anyOf)).toBe(true)
  })

  test('every declaration goes out describing an object', async () => {
    const declarations = declarationsOf(await capturedRequestBody())

    expect(declarations).toHaveLength(3)
    for (const declaration of declarations) {
      expect(declaration.parametersJsonSchema.type).toBe('object')
    }
  })

  test('no schema on the wire sets a field alongside anyOf', async () => {
    const body = await capturedRequestBody()

    const unions = everySchemaObject(body.tools).filter(
      schema => 'anyOf' in schema,
    )
    // The merged discriminators are the point: a union does survive, it just
    // stands alone wherever it does.
    expect(unions.length).toBeGreaterThan(0)
    for (const schema of unions) {
      expect(Object.keys(schema)).toEqual(['anyOf'])
    }
  })

  test('Workflow still exposes the run/status/cancel contract', async () => {
    const [workflow] = declarationsOf(await capturedRequestBody())
    const parameters = workflow.parametersJsonSchema as {
      properties: Record<string, { anyOf?: { enum?: unknown[] }[] }>
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
  })

  test('the flattened wire schema is a hint; zod is still the gate', () => {
    // Merging the branches drops the cross-field half of the contract, so the
    // wire schema now admits a call the tool does not. `toolExecution.ts` runs
    // `tool.inputSchema.safeParse(input)` on every provider before execution,
    // and that is the real schema, unchanged by anything on this lane.
    expect(workflowInputSchema.safeParse({ operation: 'status' }).success).toBe(
      false,
    )
    expect(
      workflowInputSchema.safeParse({ operation: 'status', runId: 'abc123' })
        .success,
    ).toBe(true)
  })
})
