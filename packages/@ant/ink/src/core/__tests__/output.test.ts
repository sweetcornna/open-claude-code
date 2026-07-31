import { describe, expect, test } from 'bun:test'
import Output from '../output.js'
import {
  cellAt,
  CharPool,
  createScreen,
  HyperlinkPool,
  StylePool,
} from '../screen.js'

function renderLine(line: string) {
  const width = 16
  const height = 1
  const stylePool = new StylePool()
  const screen = createScreen(
    width,
    height,
    stylePool,
    new CharPool(),
    new HyperlinkPool(),
  )
  const output = new Output({ width, height, stylePool, screen })
  output.write(0, 0, line)

  return { screen: output.get(), stylePool }
}

describe('Output tab expansion', () => {
  test('preserves the active style across tab cells', () => {
    const { screen, stylePool } = renderLine('\x1b[41mA\tB\x1b[0m')
    const activeStyleId = cellAt(screen, 0, 0)?.styleId

    expect(activeStyleId).toBeDefined()
    expect(activeStyleId).not.toBe(stylePool.none)
    for (let x = 1; x < 8; x++) {
      expect(cellAt(screen, x, 0)?.styleId).toBe(activeStyleId)
    }
  })

  test('preserves the active hyperlink across tab cells', () => {
    const hyperlink = 'https://example.com'
    const { screen } = renderLine(`\x1b]8;;${hyperlink}\x07A\tB\x1b]8;;\x07`)

    expect(cellAt(screen, 0, 0)?.hyperlink).toBe(hyperlink)
    for (let x = 1; x < 8; x++) {
      expect(cellAt(screen, x, 0)?.hyperlink).toBe(hyperlink)
    }
  })

  test('keeps unstyled tab cells at the empty style', () => {
    const { screen, stylePool } = renderLine('A\tB')

    for (let x = 1; x < 8; x++) {
      expect(cellAt(screen, x, 0)?.styleId).toBe(stylePool.none)
    }
  })
})
