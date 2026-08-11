import { describe, expect, test } from 'bun:test'
import {
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
} from '../openaiConvertTools.js'

describe('anthropicToolsToOpenAI', () => {
  test('converts basic tool', () => {
    const tools = [
      {
        type: 'custom',
        name: 'bash',
        description: 'Run a bash command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ]

    const result = anthropicToolsToOpenAI(tools as any)

    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a bash command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      },
    ])
  })

  test('uses empty schema when input_schema missing', () => {
    const tools = [{ type: 'custom', name: 'noop', description: 'no-op' }]
    const result = anthropicToolsToOpenAI(tools as any)

    expect(
      (result[0] as { function: { parameters: unknown } }).function.parameters,
    ).toEqual({ type: 'object', properties: {} })
  })

  test('strips Anthropic-specific fields', () => {
    const tools = [
      {
        type: 'custom',
        name: 'bash',
        description: 'Run bash',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
        defer_loading: true,
      },
    ]
    const result = anthropicToolsToOpenAI(tools as any)

    expect((result[0] as any).cache_control).toBeUndefined()
    expect((result[0] as any).defer_loading).toBeUndefined()
  })

  test('handles empty tools array', () => {
    expect(anthropicToolsToOpenAI([])).toEqual([])
  })

  test('sanitizes const to enum in tool schema', () => {
    const tools = [
      {
        type: 'custom',
        name: 'test',
        description: 'test tool',
        input_schema: {
          type: 'object',
          properties: {
            mode: { const: 'read' },
            name: { type: 'string' },
          },
        },
      },
    ]
    const result = anthropicToolsToOpenAI(tools as any)
    const props = (result[0] as { function: { parameters: any } }).function
      .parameters as any
    expect(props.properties.mode).toEqual({ enum: ['read'] })
    expect(props.properties.mode.const).toBeUndefined()
    expect(props.properties.name).toEqual({ type: 'string' })
  })

  test('sanitizes const in deeply nested schemas', () => {
    const tools = [
      {
        type: 'custom',
        name: 'deep',
        description: 'nested const',
        input_schema: {
          type: 'object',
          properties: {
            outer: {
              type: 'object',
              properties: {
                inner: { const: 'fixed' },
              },
            },
          },
          definitions: {
            MyType: {
              type: 'object',
              properties: {
                field: { const: 42 },
              },
            },
          },
        },
      },
    ]
    const result = anthropicToolsToOpenAI(tools as any)
    const params = (result[0] as { function: { parameters: any } }).function
      .parameters as any
    expect(params.properties.outer.properties.inner).toEqual({
      enum: ['fixed'],
    })
    expect(params.definitions.MyType.properties.field).toEqual({ enum: [42] })
  })

  test('sanitizes const in anyOf/oneOf/allOf', () => {
    const tools = [
      {
        type: 'custom',
        name: 'union',
        description: 'union test',
        input_schema: {
          type: 'object',
          properties: {
            val: {
              anyOf: [{ const: 'a' }, { const: 'b' }, { type: 'string' }],
            },
          },
        },
      },
    ]
    const result = anthropicToolsToOpenAI(tools as any)
    const anyOf = (
      (result[0] as { function: { parameters: any } }).function
        .parameters as any
    ).properties.val.anyOf
    expect(anyOf[0]).toEqual({ enum: ['a'] })
    expect(anyOf[1]).toEqual({ enum: ['b'] })
    expect(anyOf[2]).toEqual({ type: 'string' })
  })
})

/**
 * Regression guard for the upstream rejection that motivated normalization:
 *
 *   [invalid_request_error] Invalid schema for function 'Workflow':
 *   schema must be a JSON Schema of 'type: "object"', got 'type: null'.
 *
 * Every strict OpenAI-compatible endpoint answers a union-typed tool schema
 * that way, and it kills the whole request, not just that tool.
 */
describe('anthropicToolsToOpenAI top-level object normalization', () => {
  const unionSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    anyOf: [
      {
        type: 'object',
        properties: {
          operation: { type: 'string', const: 'run' },
          script: { type: 'string' },
        },
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['status', 'query'] },
          runId: { type: 'string', description: 'Run id to inspect' },
        },
        required: ['operation', 'runId'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          operation: { type: 'string', const: 'cancel' },
          runId: { type: 'string', description: 'Run id to cancel' },
        },
        required: ['operation', 'runId'],
        additionalProperties: false,
      },
    ],
  }

  function parametersOf(tool: unknown): any {
    return (tool as { function: { parameters: any } }).function.parameters
  }

  test('gives a top-level union schema an object type', () => {
    const result = anthropicToolsToOpenAI([
      {
        type: 'custom',
        name: 'Workflow',
        description: 'run a workflow',
        input_schema: unionSchema,
      },
    ] as any)

    expect(parametersOf(result[0]).type).toBe('object')
  })

  test('keeps every branch reachable: merged properties plus the union', () => {
    const params = parametersOf(
      anthropicToolsToOpenAI([
        { type: 'custom', name: 'Workflow', input_schema: unionSchema },
      ] as any)[0],
    )

    // Branch-only fields survive the flattening.
    expect(Object.keys(params.properties).sort()).toEqual([
      'operation',
      'runId',
      'script',
    ])
    // The discriminator keeps every branch's accepted values, so the model can
    // still tell run from status from cancel.
    expect(params.properties.operation.anyOf).toEqual([
      { type: 'string', enum: ['run'] },
      { type: 'string', enum: ['status', 'query'] },
      { type: 'string', enum: ['cancel'] },
    ])
    // The precise per-branch contract is still on the wire.
    expect(params.anyOf).toHaveLength(3)
    expect(params.anyOf[1].required).toEqual(['operation', 'runId'])
  })

  test('requires only what every branch requires', () => {
    const params = parametersOf(
      anthropicToolsToOpenAI([
        { type: 'custom', name: 'Workflow', input_schema: unionSchema },
      ] as any)[0],
    )

    // The run branch requires nothing (omitting `operation` launches a run), so
    // nothing may be required at the merged level.
    expect(params.required).toBeUndefined()
  })

  test('intersects required across branches that share one', () => {
    const params = parametersOf(
      anthropicToolsToOpenAI([
        {
          type: 'custom',
          name: 'mcp__srv__thing',
          input_schema: {
            oneOf: [
              {
                type: 'object',
                properties: { kind: { const: 'a' }, x: { type: 'number' } },
                required: ['kind', 'x'],
              },
              {
                type: 'object',
                properties: { kind: { const: 'b' }, y: { type: 'number' } },
                required: ['kind', 'y'],
              },
            ],
          },
        },
      ] as any)[0],
    )

    expect(params.type).toBe('object')
    expect(params.required).toEqual(['kind'])
    // oneOf is preserved in place rather than rewritten to anyOf.
    expect(params.oneOf).toHaveLength(2)
  })

  test('adds the missing type to a schema that only lists properties', () => {
    const params = parametersOf(
      anthropicToolsToOpenAI([
        {
          type: 'custom',
          name: 'mcp__srv__handwritten',
          input_schema: { properties: { path: { type: 'string' } } },
        },
      ] as any)[0],
    )

    expect(params).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
    })
  })

  test('leaves a conforming object schema byte-identical', () => {
    const input_schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    }
    const params = parametersOf(
      anthropicToolsToOpenAI([
        { type: 'custom', name: 'Bash', input_schema },
      ] as any)[0],
    )

    expect(params).toEqual(input_schema)
  })

  test('does not drop properties a union schema declares itself', () => {
    const params = parametersOf(
      anthropicToolsToOpenAI([
        {
          type: 'custom',
          name: 'mcp__srv__mixed',
          input_schema: {
            properties: { shared: { type: 'string' } },
            anyOf: [
              { type: 'object', properties: { a: { type: 'number' } } },
              { type: 'object', properties: { b: { type: 'number' } } },
            ],
          },
        },
      ] as any)[0],
    )

    expect(params.type).toBe('object')
    expect(params.properties).toEqual({ shared: { type: 'string' } })
    expect(params.anyOf).toHaveLength(2)
  })

  test('never mutates the caller-owned input schema', () => {
    // zodToJsonSchema() caches by schema identity and hands the SAME object to
    // the Anthropic lane's input_schema. Mutating it here would silently
    // rewrite what the first-party lane sends.
    const input_schema = Object.freeze({
      anyOf: [
        Object.freeze({
          type: 'object',
          properties: { a: { type: 'string' } },
        }),
      ],
    })

    expect(() =>
      anthropicToolsToOpenAI([
        { type: 'custom', name: 'frozen', input_schema },
      ] as any),
    ).not.toThrow()
    expect(input_schema).toEqual({
      anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
    })
    expect((input_schema as { type?: unknown }).type).toBeUndefined()
  })

  test('no tool reaches the wire without a top-level object type', () => {
    const result = anthropicToolsToOpenAI([
      { type: 'custom', name: 'Workflow', input_schema: unionSchema },
      { type: 'custom', name: 'Bash', input_schema: { type: 'object' } },
      { type: 'custom', name: 'mcp__srv__bare' },
      {
        type: 'custom',
        name: 'mcp__srv__scalar',
        input_schema: { type: 'string' },
      },
    ] as any)

    expect(result).toHaveLength(4)
    for (const tool of result) {
      expect(parametersOf(tool).type).toBe('object')
    }
  })
})

describe('anthropicToolChoiceToOpenAI', () => {
  test('maps auto', () => {
    expect(anthropicToolChoiceToOpenAI({ type: 'auto' })).toBe('auto')
  })

  test('maps any to required', () => {
    expect(anthropicToolChoiceToOpenAI({ type: 'any' })).toBe('required')
  })

  test('maps tool to function', () => {
    const result = anthropicToolChoiceToOpenAI({ type: 'tool', name: 'bash' })
    expect(result).toEqual({ type: 'function', function: { name: 'bash' } })
  })

  test('returns undefined for undefined input', () => {
    expect(anthropicToolChoiceToOpenAI(undefined)).toBeUndefined()
  })

  test('returns undefined for unknown type', () => {
    expect(anthropicToolChoiceToOpenAI({ type: 'unknown' })).toBeUndefined()
  })
})
