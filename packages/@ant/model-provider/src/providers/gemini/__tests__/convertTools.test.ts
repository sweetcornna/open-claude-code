import { describe, expect, test } from 'bun:test'
import {
  anthropicToolChoiceToGemini,
  anthropicToolsToGemini,
} from '../convertTools.js'

describe('anthropicToolsToGemini', () => {
  test('converts basic tool to parametersJsonSchema', () => {
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

    expect(anthropicToolsToGemini(tools as any)).toEqual([
      {
        functionDeclarations: [
          {
            name: 'bash',
            description: 'Run a bash command',
            parametersJsonSchema: {
              type: 'object',
              properties: { command: { type: 'string' } },
              propertyOrdering: ['command'],
              required: ['command'],
            },
          },
        ],
      },
    ])
  })

  test('sanitizes unsupported JSON Schema fields for Gemini', () => {
    const tools = [
      {
        type: 'custom',
        name: 'complex',
        description: 'Complex schema',
        input_schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          propertyNames: { pattern: '^[a-z]+$' },
          properties: {
            mode: { const: 'strict' },
            retries: {
              type: 'integer',
              exclusiveMinimum: 0,
            },
            metadata: {
              type: 'object',
              additionalProperties: {
                type: 'string',
                propertyNames: { pattern: '^[a-z]+$' },
              },
            },
          },
          required: ['mode'],
        },
      },
    ]

    expect(anthropicToolsToGemini(tools as any)).toEqual([
      {
        functionDeclarations: [
          {
            name: 'complex',
            description: 'Complex schema',
            parametersJsonSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: {
                  type: 'string',
                  enum: ['strict'],
                },
                retries: {
                  type: 'integer',
                  minimum: 0,
                },
                metadata: {
                  type: 'object',
                  additionalProperties: {
                    type: 'string',
                  },
                },
              },
              propertyOrdering: ['mode', 'retries', 'metadata'],
              required: ['mode'],
            },
          },
        ],
      },
    ])
  })

  test('returns empty array when no tools are provided', () => {
    expect(anthropicToolsToGemini([])).toEqual([])
  })
})

/**
 * Gemini's contract is narrower than Anthropic's in two ways that a union-typed
 * tool schema trips at once:
 *
 *  1. `FunctionDeclaration.parametersJsonSchema` — "The schema must describe an
 *     object where the properties are the parameters to the function."
 *  2. "Unable to submit request because `edit` functionDeclaration
 *     `parameters.edits` schema specified other fields alongside any_of. When
 *     using any_of, it must be the only field set."
 *
 * Either one rejects the whole request, not the one tool. The Workflow tool's
 * zod schema is a top-level `z.union([...])` with a described union inside it,
 * so it hits both; MCP servers publish schemas we do not author and hit them too.
 */
describe('anthropicToolsToGemini object normalization', () => {
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

  function parametersOf(tools: unknown[], index = 0): any {
    return (tools as any)[0].functionDeclarations[index].parametersJsonSchema
  }

  /** Every schema object in the payload, at any depth. */
  function everySchemaObject(node: unknown): Record<string, unknown>[] {
    if (Array.isArray(node)) return node.flatMap(everySchemaObject)
    if (!node || typeof node !== 'object') return []
    const self = node as Record<string, unknown>
    return [self, ...Object.values(self).flatMap(everySchemaObject)]
  }

  test('gives a top-level union schema an object type', () => {
    const params = parametersOf(
      anthropicToolsToGemini([
        {
          type: 'custom',
          name: 'Workflow',
          description: 'run a workflow',
          input_schema: unionSchema,
        },
      ] as any),
    )

    expect(params.type).toBe('object')
    expect(params.anyOf).toBeUndefined()
  })

  test('keeps every branch property, with per-branch variants intact', () => {
    const params = parametersOf(
      anthropicToolsToGemini([
        { type: 'custom', name: 'Workflow', input_schema: unionSchema },
      ] as any),
    )

    expect(Object.keys(params.properties).sort()).toEqual([
      'operation',
      'runId',
      'script',
    ])
    // The discriminator keeps every branch's accepted values, so the model can
    // still tell run from status from cancel. `const` is already rewritten to
    // `enum` by the Gemini sanitizer.
    expect(params.properties.operation.anyOf).toEqual([
      { enum: ['run'], type: 'string' },
      { enum: ['status', 'query'], type: 'string' },
      { enum: ['cancel'], type: 'string' },
    ])
    expect(params.propertyOrdering).toEqual(Object.keys(params.properties))
  })

  test('requires only what every branch requires', () => {
    const params = parametersOf(
      anthropicToolsToGemini([
        { type: 'custom', name: 'Workflow', input_schema: unionSchema },
      ] as any),
    )

    // The run branch requires nothing, so nothing may be required once merged.
    expect(params.required).toBeUndefined()
  })

  test('intersects required across branches that share one', () => {
    const params = parametersOf(
      anthropicToolsToGemini([
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
      ] as any),
    )

    expect(params.type).toBe('object')
    expect(params.required).toEqual(['kind'])
  })

  test('folds a described nested union into an object', () => {
    // zod emits `{ description, anyOf: [...] }` for `z.union([...]).describe()`
    // — the exact shape Gemini names in the any_of error.
    const params = parametersOf(
      anthropicToolsToGemini([
        {
          type: 'custom',
          name: 'resume',
          input_schema: {
            type: 'object',
            properties: {
              policy: {
                description: 'How much to replay',
                oneOf: [
                  {
                    type: 'object',
                    properties: { scope: { const: 'checkpoint' } },
                    required: ['scope'],
                  },
                  {
                    type: 'object',
                    properties: {
                      scope: { const: 'range' },
                      from: { type: 'integer' },
                    },
                    required: ['scope', 'from'],
                  },
                ],
              },
            },
          },
        },
      ] as any),
    )

    expect(params.properties.policy).toEqual({
      description: 'How much to replay',
      type: 'object',
      properties: {
        scope: {
          anyOf: [
            { enum: ['checkpoint'], type: 'string' },
            { enum: ['range'], type: 'string' },
          ],
        },
        from: { type: 'integer' },
      },
      propertyOrdering: ['scope', 'from'],
      required: ['scope'],
    })
  })

  test('carries prose into branches when a union cannot fold', () => {
    const params = parametersOf(
      anthropicToolsToGemini([
        {
          type: 'custom',
          name: 'scalar_union',
          input_schema: {
            type: 'object',
            properties: {
              id: {
                description: 'Numeric or string id',
                anyOf: [{ type: 'string' }, { type: 'integer' }],
              },
            },
          },
        },
      ] as any),
    )

    expect(params.properties.id).toEqual({
      anyOf: [
        { type: 'string', description: 'Numeric or string id' },
        { type: 'integer', description: 'Numeric or string id' },
      ],
    })
  })

  test('leaves a nested union that already stands alone untouched', () => {
    const params = parametersOf(
      anthropicToolsToGemini([
        {
          type: 'custom',
          name: 'bare_union_prop',
          input_schema: {
            type: 'object',
            properties: {
              id: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
            },
          },
        },
      ] as any),
    )

    expect(params.properties.id).toEqual({
      anyOf: [{ type: 'string' }, { type: 'integer' }],
    })
  })

  test('adds the missing type to a schema that only lists properties', () => {
    const params = parametersOf(
      anthropicToolsToGemini([
        {
          type: 'custom',
          name: 'mcp__srv__handwritten',
          input_schema: { properties: { path: { type: 'string' } } },
        },
      ] as any),
    )

    expect(params).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      propertyOrdering: ['path'],
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
      anthropicToolsToGemini([
        { type: 'custom', name: 'Bash', input_schema },
      ] as any),
    )

    expect(params).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { command: { type: 'string' } },
      propertyOrdering: ['command'],
      required: ['command'],
    })
  })

  test('declares a non-object schema parameterless instead of failing', () => {
    const params = parametersOf(
      anthropicToolsToGemini([
        {
          type: 'custom',
          name: 'mcp__srv__scalar',
          input_schema: { type: 'string', description: 'a bare string' },
        },
      ] as any),
    )

    expect(params).toEqual({
      type: 'object',
      properties: {},
      description: 'a bare string',
    })
  })

  test('never mutates the caller-owned input schema', () => {
    // zodToJsonSchema() caches by schema identity and hands the SAME object to
    // the Anthropic lane's input_schema. Mutating it here would silently
    // rewrite what the first-party lane sends.
    const input_schema = Object.freeze({
      anyOf: [
        Object.freeze({
          type: 'object',
          properties: Object.freeze({ a: { type: 'string' } }),
        }),
      ],
    })

    expect(() =>
      anthropicToolsToGemini([
        { type: 'custom', name: 'frozen', input_schema },
      ] as any),
    ).not.toThrow()
    expect(input_schema).toEqual({
      anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
    })
    expect((input_schema as { type?: unknown }).type).toBeUndefined()
  })

  test('no declaration reaches the wire in a shape Gemini rejects', () => {
    const tools = anthropicToolsToGemini([
      { type: 'custom', name: 'Workflow', input_schema: unionSchema },
      { type: 'custom', name: 'Bash', input_schema: { type: 'object' } },
      { type: 'custom', name: 'mcp__srv__bare' },
      {
        type: 'custom',
        name: 'mcp__srv__scalar',
        input_schema: { type: 'string' },
      },
    ] as any)

    const declarations = (tools as any)[0].functionDeclarations
    expect(declarations).toHaveLength(4)
    for (const declaration of declarations) {
      expect(declaration.parametersJsonSchema.type).toBe('object')
    }
    for (const schema of everySchemaObject(tools)) {
      if ('anyOf' in schema) {
        expect(Object.keys(schema)).toEqual(['anyOf'])
      }
    }
  })
})

describe('anthropicToolChoiceToGemini', () => {
  test('maps auto', () => {
    expect(anthropicToolChoiceToGemini({ type: 'auto' })).toEqual({
      mode: 'AUTO',
    })
  })

  test('maps any', () => {
    expect(anthropicToolChoiceToGemini({ type: 'any' })).toEqual({
      mode: 'ANY',
    })
  })

  test('maps explicit tool choice', () => {
    expect(anthropicToolChoiceToGemini({ type: 'tool', name: 'bash' })).toEqual(
      {
        mode: 'ANY',
        allowedFunctionNames: ['bash'],
      },
    )
  })
})
