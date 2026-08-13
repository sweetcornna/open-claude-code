/**
 * Characterization: pins the public surface of `src/Tool.ts`.
 *
 * The Tool contract is consumed by 130+ files in packages/builtin-tools plus
 * a dozen host modules, and almost all of those imports are `import type`.
 * A plain `bun test` therefore proves very little about the contract itself:
 * types are erased, so a re-export barrel that silently drops a type would
 * only surface as a typecheck failure somewhere far away.
 *
 * This file makes the surface itself the assertion. The expected lists are
 * generated from the file's own AST (see `readExportSurface`), so moving the
 * contract into `@open-claude-code/tool-runtime` and leaving `src/Tool.ts` as
 * a barrel is provably surface-preserving in both directions:
 *
 *   - the AST lists pin every exported *name*, type-only included;
 *   - `Object.keys` on the imported namespace pins what survives to runtime.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { ToolExecutionTimeoutError } from '@open-claude-code/tool-runtime/errors.js'
import * as ToolModule from '../Tool.js'

const TOOL_FILE = join(import.meta.dir, '..', 'Tool.ts')

type ExportSurface = { types: string[]; values: string[] }

/**
 * Collect the exported names of a TypeScript module, split by whether the
 * export is type-only. Handles both shapes this file has to survive: local
 * declarations (`export type X = ...`, `export function f()`) and re-export
 * barrels (`export type { X } from '...'`, `export { f } from '...'`).
 */
function readExportSurface(filePath: string): ExportSurface {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  )
  const types = new Set<string>()
  const values = new Set<string>()
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ??
      false)

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const bucket =
            statement.isTypeOnly || element.isTypeOnly ? types : values
          bucket.add(element.name.text)
        }
      }
      continue
    }
    if (!isExported(statement)) continue
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    ) {
      types.add(statement.name.text)
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      values.add(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) values.add(decl.name.text)
      }
    } else if (ts.isEnumDeclaration(statement)) {
      values.add(statement.name.text)
    }
  }

  return {
    types: [...types].sort(),
    values: [...values].sort(),
  }
}

describe('Tool.ts export surface', () => {
  test('exports exactly these types', () => {
    expect(readExportSurface(TOOL_FILE).types).toEqual([
      'AnyObject',
      'CompactProgressEvent',
      'Progress',
      'QueryChainTracking',
      'SessionModelSettingsOverrides',
      'SetToolJSXFn',
      'Tool',
      'ToolCallProgress',
      'ToolDef',
      'ToolInputJSONSchema',
      'ToolPermissionContext',
      'ToolPermissionRulesBySource',
      'ToolProgress',
      'ToolProgressData',
      'ToolResult',
      'ToolResultBlockParam',
      'ToolUseContext',
      'Tools',
      'ValidationResult',
    ])
  })

  test('exports exactly these runtime values', () => {
    expect(readExportSurface(TOOL_FILE).values).toEqual([
      'buildTool',
      'filterToolProgressMessages',
      'findToolByName',
      'getEmptyToolPermissionContext',
      'toolMatchesName',
    ])
  })

  test('the imported namespace matches the declared runtime values', () => {
    expect(Object.keys(ToolModule).sort()).toEqual(
      readExportSurface(TOOL_FILE).values,
    )
  })

  test('every runtime export is callable', () => {
    for (const name of Object.keys(ToolModule).sort()) {
      expect(typeof (ToolModule as Record<string, unknown>)[name]).toBe(
        'function',
      )
    }
  })
})

// Minimal definition accepted by buildTool. Only the non-defaultable members.
function makeToolDef(overrides: Record<string, unknown> = {}) {
  return {
    name: 'SurfaceTool',
    inputSchema: { type: 'object' as const } as any,
    maxResultSizeChars: 1000,
    call: async () => ({ data: 'ok' }),
    description: async () => 'surface test tool',
    prompt: async () => 'surface prompt',
    mapToolResultToToolResultBlockParam: (
      content: unknown,
      toolUseID: string,
    ) => ({
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: String(content),
    }),
    renderToolUseMessage: () => null,
    ...overrides,
  }
}

describe('Tool contract behavior', () => {
  test('buildTool fills in the documented defaults', () => {
    const tool = ToolModule.buildTool(makeToolDef())
    expect(tool.isEnabled()).toBe(true)
    expect(tool.isConcurrencySafe({})).toBe(false)
    expect(tool.isReadOnly({})).toBe(false)
    expect(tool.isDestructive({})).toBe(false)
    expect(tool.toAutoClassifierInput({})).toBe('')
    expect(tool.userFacingName(undefined)).toBe('SurfaceTool')
  })

  test('buildTool defaults checkPermissions to allow with the input echoed', async () => {
    const tool = ToolModule.buildTool(makeToolDef())
    const input = { path: '/tmp/x' }
    await expect(tool.checkPermissions(input, {} as any)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
    })
  })

  test('buildTool does not clobber explicitly provided members', () => {
    const tool = ToolModule.buildTool(
      makeToolDef({ isEnabled: () => false, isReadOnly: () => true }),
    )
    expect(tool.isEnabled()).toBe(false)
    expect(tool.isReadOnly({})).toBe(true)
    expect(tool.name).toBe('SurfaceTool')
    expect(tool.maxResultSizeChars).toBe(1000)
  })

  test('buildTool wraps only definitions that opt into an execution timeout', async () => {
    const parent = new AbortController()
    const tool = ToolModule.buildTool(
      makeToolDef({
        getExecutionTimeoutMs: () => 5,
        call: async (
          _input: unknown,
          context: { abortController: AbortController },
        ) =>
          new Promise<never>((_, reject) => {
            context.abortController.signal.addEventListener(
              'abort',
              () => reject(context.abortController.signal.reason),
              { once: true },
            )
          }),
      }),
    )

    const pending = (tool.call as any)(
      {},
      { abortController: parent },
      async () => ({ behavior: 'allow' }),
      {},
    )

    await expect(pending).rejects.toBeInstanceOf(ToolExecutionTimeoutError)
    expect(parent.signal.aborted).toBe(false)
  })

  test('toolMatchesName matches the primary name and any alias', () => {
    expect(ToolModule.toolMatchesName({ name: 'Bash' }, 'Bash')).toBe(true)
    expect(
      ToolModule.toolMatchesName({ name: 'Bash', aliases: ['Shell'] }, 'Shell'),
    ).toBe(true)
    expect(ToolModule.toolMatchesName({ name: 'Bash' }, 'Shell')).toBe(false)
  })

  test('findToolByName resolves aliases and returns the first match', () => {
    const tools = [
      ToolModule.buildTool(
        makeToolDef({ name: 'Read', aliases: ['FileRead'] }),
      ),
      ToolModule.buildTool(makeToolDef({ name: 'Edit' })),
      ToolModule.buildTool(makeToolDef({ name: 'Edit' })),
    ]
    expect(ToolModule.findToolByName(tools as any, 'FileRead')?.name).toBe(
      'Read',
    )
    expect(ToolModule.findToolByName(tools as any, 'Edit')).toBe(
      tools[1] as any,
    )
    expect(ToolModule.findToolByName(tools as any, 'Nope')).toBeUndefined()
  })

  test('getEmptyToolPermissionContext returns a permissive empty context', () => {
    const ctx = ToolModule.getEmptyToolPermissionContext()
    expect(ctx.mode).toBe('default')
    expect(ctx.additionalWorkingDirectories.size).toBe(0)
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('filterToolProgressMessages drops hook progress only', () => {
    const messages = [
      { data: { type: 'hook_progress' } },
      { data: { type: 'bash_progress' } },
      { data: {} },
    ] as any[]
    expect(ToolModule.filterToolProgressMessages(messages)).toHaveLength(2)
  })
})
