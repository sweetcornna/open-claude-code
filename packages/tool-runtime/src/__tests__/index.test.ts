import { expect, test } from 'bun:test'
import { TOOL_RUNTIME_PACKAGE as packageImport } from '@open-claude-code/tool-runtime'
import { TOOL_RUNTIME_PACKAGE as relativeImport } from '../index'

test('exports the package identifier through package and relative imports', () => {
  expect(packageImport).toBe('@open-claude-code/tool-runtime')
  expect(relativeImport).toBe('@open-claude-code/tool-runtime')
})
