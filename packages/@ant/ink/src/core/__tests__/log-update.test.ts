import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Diff, emptyFrame, type Frame } from '../frame.js'
import { resetLegacyConsoleCacheForTesting } from '../legacyConsole.js'
import { LogUpdate } from '../log-update.js'
import Output from '../output.js'
import {
  CellWidth,
  cellAt,
  CharPool,
  createScreen,
  HyperlinkPool,
  type Screen,
  StylePool,
} from '../screen.js'
import { stringWidth } from '../stringWidth.js'

/**
 * Golden-diff tests for the incremental renderer.
 *
 * LogUpdate.render() emits a Patch stream that is meaningless in isolation —
 * what matters is the terminal state it produces. FakeTerminal replays the
 * patches onto a character grid using the same cursor semantics a real VT
 * has (relative moves, CR/LF, deferred wrap at the last column), so each
 * test can assert "what the user sees" instead of a patch snapshot.
 *
 * The shape of every test is the same: paint the previous frame from an
 * empty screen (the same code path the first frame takes), then apply the
 * incremental diff, then require the grid to equal a from-scratch render of
 * the next frame. Any cell the diff forgets to repaint shows up as leftover
 * content from the previous frame.
 *
 * Two grids are tracked: glyphs and SGR attributes. Attribute residue (a
 * highlight block that outlives its selection) is a distinct failure from
 * glyph residue and needs its own assertions — a cell can hold the right
 * character and the wrong background. The glyph grid is compared wholesale
 * against expectedGrid(); attributes are asserted per test, because the
 * renderer legitimately leaves untouched cells alone (skipped empty cells,
 * SpacerTails) and a whole-grid attribute compare would flag those.
 */

const WIDTH = 10
const VIEWPORT_HEIGHT = 6

// Multi-codepoint grapheme (ZWJ sequence): display width 2, char.length 5.
const ZWJ_EMOJI = '\u{1F468}\u{200D}\u{1F4BB}' // 👨‍💻
// ZWJ sequence containing VS16 (U+FE0F), so needsWidthCompensation() fires
// and writeCellWithStyleStr takes its CHA-compensated write path.
const COMPENSATED_EMOJI = '\u{1F468}\u{200D}\u{2764}\u{FE0F}\u{200D}\u{1F468}'

type Pools = {
  stylePool: StylePool
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
}

function makePools(): Pools {
  return {
    stylePool: new StylePool(),
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
  }
}

/** Build a Screen through the real Output pipeline (so wide-char cells,
 *  SpacerTail and SpacerHead placement are produced by production code). */
function buildScreen(pools: Pools, lines: string[], width = WIDTH): Screen {
  const height = lines.length
  const screen = createScreen(
    width,
    height,
    pools.stylePool,
    pools.charPool,
    pools.hyperlinkPool,
  )
  const output = new Output({
    width,
    height,
    stylePool: pools.stylePool,
    screen,
  })
  for (const [y, line] of lines.entries()) {
    output.write(0, y, line)
  }
  return output.get()
}

/** Frame shaped like createRenderer's non-alt-screen output: the cursor
 *  parks at column 0 of the row just below the last content row. */
function frameOf(screen: Screen): Frame {
  return {
    screen,
    viewport: { width: screen.width, height: VIEWPORT_HEIGHT },
    cursor: { x: 0, y: screen.height, visible: false },
  }
}

/** The grid a correct renderer must leave behind for this screen. Wide cells
 *  occupy their SpacerTail column (rendered as '' so the joined row string
 *  stays column-aligned); SpacerHead columns are blank. */
function expectedGrid(screen: Screen, height = VIEWPORT_HEIGHT): string[] {
  const rows: string[][] = Array.from({ length: height }, () =>
    new Array<string>(screen.width).fill(' '),
  )
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y)
      if (!cell || cell.width === CellWidth.SpacerTail) continue
      rows[y]![x] = cell.width === CellWidth.SpacerHead ? ' ' : cell.char
      if (cell.width === CellWidth.Wide) rows[y]![x + 1] = ''
    }
  }
  return rows.map(row => row.join(''))
}

/** Which SGR codes occupy the same slot, so a later one replaces an
 *  earlier one and the matching "off" code clears it. */
const SGR_SLOTS = new Map<number, string>()
const SGR_OFF = new Set([22, 23, 24, 27, 29, 39, 49, 55])
for (const [slot, codes] of [
  ['weight', [1, 2, 22]],
  ['italic', [3, 23]],
  ['underline', [4, 24]],
  ['inverse', [7, 27]],
  ['strike', [9, 29]],
  ['overline', [53, 55]],
] as const) {
  for (const code of codes) SGR_SLOTS.set(code, slot)
}
for (let code = 30; code <= 39; code++) SGR_SLOTS.set(code, 'fg')
for (let code = 90; code <= 97; code++) SGR_SLOTS.set(code, 'fg')
for (let code = 40; code <= 49; code++) SGR_SLOTS.set(code, 'bg')
for (let code = 100; code <= 107; code++) SGR_SLOTS.set(code, 'bg')

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC-introduced SGR sequences is the whole point
const SGR_PATTERN = /\[([0-9;]*)m/g

/**
 * Minimal SGR interpreter: enough to tell "this cell has a background" from
 * "this cell is clean". Slot-based rather than a raw code set, so 41 then
 * 49 cancels out the way a terminal cancels it, and key() is stable
 * regardless of the order the codes arrived in.
 */
class SgrState {
  private readonly slots = new Map<string, string>()

  apply(ansi: string): void {
    SGR_PATTERN.lastIndex = 0
    let match = SGR_PATTERN.exec(ansi)
    while (match !== null) {
      this.applyParams(match[1] ?? '')
      match = SGR_PATTERN.exec(ansi)
    }
  }

  private applyParams(body: string): void {
    const params =
      body === '' ? [0] : body.split(';').map(n => (n === '' ? 0 : Number(n)))
    for (let i = 0; i < params.length; i++) {
      const code = params[i]!
      if (code === 0) {
        this.slots.clear()
        continue
      }
      // 38/48 carry their color inline (;5;n or ;2;r;g;b) — swallow the
      // extra params so they aren't read back as standalone codes.
      if (code === 38 || code === 48) {
        const slot = code === 38 ? 'fg' : 'bg'
        const mode = params[i + 1]
        const extra = mode === 5 ? 2 : mode === 2 ? 4 : 0
        this.slots.set(slot, params.slice(i, i + extra + 1).join(';'))
        i += extra
        continue
      }
      const slot = SGR_SLOTS.get(code)
      if (slot === undefined) continue
      if (SGR_OFF.has(code)) this.slots.delete(slot)
      else this.slots.set(slot, String(code))
    }
  }

  clear(): void {
    this.slots.clear()
  }

  /** Stable description of the active attributes; '' means clean. */
  key(): string {
    return [...this.slots]
      .map(([slot, code]) => `${slot}:${code}`)
      .sort()
      .join(',')
  }
}

/** The attribute key a cell's styleId corresponds to, for expectations. */
function styleKeyOf(stylePool: StylePool, styleId: number): string {
  const state = new SgrState()
  for (const code of stylePool.get(styleId)) state.apply(code.code)
  return state.key()
}

/**
 * Minimal VT model: enough of one to replay a Diff faithfully.
 *
 * Deferred wrap is modelled the way real terminals do it — writing the last
 * column leaves the cursor there with a wrap pending, and any cursor motion
 * (including CR) cancels it. log-update's VirtualScreen tracks the same
 * state as `cursor.x === viewportWidth`; if it ever emitted a bare cursor
 * move while a wrap is pending, the two models would drift here.
 *
 * Also modelled: a wide glyph is one cell spanning two columns (overwriting
 * either half erases both), and each written cell records the SGR state
 * that was active at write time.
 *
 * NOT modelled — do not write tests that depend on these:
 *   - bottom-of-viewport clamping and scrolling. Rows are grown on demand
 *     and never scroll off, so nothing here says anything about scrollback
 *     or about log-update's cursorRestoreScroll accounting. Anything in
 *     that area needs a different harness.
 *   - DECSTBM scroll regions (CSI r / S / T), erase-with-current-bg
 *     semantics for CSI 2K, and alt-screen switching.
 */
class FakeTerminal {
  private readonly grid: string[][]
  private readonly styleGrid: string[][]
  private readonly sgr = new SgrState()
  private row = 0
  private col = 0
  private pendingWrap = false

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.grid = Array.from({ length: height }, () =>
      new Array<string>(width).fill(' '),
    )
    this.styleGrid = Array.from({ length: height }, () =>
      new Array<string>(width).fill(''),
    )
  }

  apply(diff: Diff): void {
    for (const patch of diff) {
      switch (patch.type) {
        case 'stdout':
          this.print(patch.content)
          break
        case 'carriageReturn':
          this.col = 0
          this.pendingWrap = false
          break
        case 'cursorMove':
          this.move(patch.x, patch.y)
          break
        case 'cursorTo':
          this.col = Math.min(this.width - 1, Math.max(0, patch.col - 1))
          this.pendingWrap = false
          break
        case 'clear':
          this.eraseLines(patch.count)
          break
        case 'clearTerminal':
          this.clearAll()
          break
        case 'styleStr':
          this.sgr.apply(patch.str)
          break
        default:
          // hyperlink / cursorHide / cursorShow change no cell state.
          break
      }
    }
  }

  lines(): string[] {
    return this.grid.map(row => row.join(''))
  }

  /** Attribute key per column for one row; '' means the cell is clean. */
  styleRow(y: number): string[] {
    return [...(this.styleGrid[y] ?? [])]
  }

  styleAt(x: number, y: number): string {
    return this.styleGrid[y]?.[x] ?? ''
  }

  private print(content: string): void {
    // Patches carry one grapheme at a time (plus the '\n' of a row advance).
    const parts = content.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) this.lineFeed()
      const text = parts[i]!
      if (text.length > 0) this.putGrapheme(text)
    }
  }

  private putGrapheme(grapheme: string): void {
    const cellWidth = Math.max(1, stringWidth(grapheme))
    if (this.pendingWrap) {
      this.col = 0
      this.row += 1
      this.pendingWrap = false
    }
    // A wide glyph that doesn't fit is pushed to the next row by the terminal.
    if (this.col + cellWidth > this.width) {
      this.col = 0
      this.row += 1
    }
    const row = this.rowAt(this.row)
    const styles = this.styleRowAt(this.row)
    // A wide glyph is one cell spanning two columns: overwriting either half
    // erases the whole thing. This is why the renderer may skip a SpacerTail
    // whose head it just repainted or cleared.
    if (this.col > 0 && row[this.col] === '') {
      row[this.col - 1] = ' '
      styles[this.col - 1] = ''
    }
    if (row[this.col + 1] === '') {
      row[this.col + 1] = ' '
      styles[this.col + 1] = ''
    }
    const key = this.sgr.key()
    row[this.col] = grapheme
    styles[this.col] = key
    if (cellWidth === 2) {
      row[this.col + 1] = ''
      styles[this.col + 1] = key
    }
    this.col += cellWidth
    if (this.col >= this.width) {
      this.col = this.width - 1
      this.pendingWrap = true
    }
  }

  private lineFeed(): void {
    this.row += 1
    this.pendingWrap = false
  }

  private move(dx: number, dy: number): void {
    this.pendingWrap = false
    this.col = Math.min(this.width - 1, Math.max(0, this.col + dx))
    this.row = Math.max(0, this.row + dy)
  }

  private eraseLines(count: number): void {
    for (let i = 0; i < count; i++) {
      this.rowAt(this.row).fill(' ')
      this.styleRowAt(this.row).fill('')
      if (i < count - 1) this.row = Math.max(0, this.row - 1)
    }
    this.col = 0
    this.pendingWrap = false
  }

  private clearAll(): void {
    for (const row of this.grid) row.fill(' ')
    for (const row of this.styleGrid) row.fill('')
    this.sgr.clear()
    this.row = 0
    this.col = 0
    this.pendingWrap = false
  }

  private rowAt(y: number): string[] {
    while (this.grid.length <= y) {
      this.grid.push(new Array<string>(this.width).fill(' '))
    }
    return this.grid[y]!
  }

  private styleRowAt(y: number): string[] {
    while (this.styleGrid.length <= y) {
      this.styleGrid.push(new Array<string>(this.width).fill(''))
    }
    return this.styleGrid[y]!
  }
}

/** Paint `prev` from scratch, then apply the prev→next diff. Returns the
 *  terminal grid plus the incremental diff for direct patch assertions.
 *  `buildNext` lets a test assemble the second frame itself (e.g. through
 *  Output.blit) instead of writing plain lines. */
function renderSequence(
  pools: Pools,
  prevLines: string[],
  next: string[] | ((pools: Pools) => Screen),
): { terminal: FakeTerminal; diff: Diff; prev: Screen; next: Screen } {
  const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
  const terminal = new FakeTerminal(WIDTH, VIEWPORT_HEIGHT)

  const blank = emptyFrame(
    VIEWPORT_HEIGHT,
    WIDTH,
    pools.stylePool,
    pools.charPool,
    pools.hyperlinkPool,
  )
  const prevScreen = buildScreen(pools, prevLines)
  terminal.apply(log.render(blank, frameOf(prevScreen)))

  // Each frame gets its own screen buffer (production double-buffers); the
  // diff needs both to still be intact.
  const nextScreen = Array.isArray(next)
    ? buildScreen(pools, next)
    : next(pools)
  const diff = log.render(frameOf(prevScreen), frameOf(nextScreen))
  terminal.apply(diff)

  return { terminal, diff, prev: prevScreen, next: nextScreen }
}

describe('LogUpdate golden diff', () => {
  const savedLegacy = process.env.CLAUDE_CODE_LEGACY_CONSOLE

  beforeAll(() => {
    // Legacy-console mode replaces every diff with a full repaint, which
    // would hide exactly the bugs these tests pin. Force it off.
    process.env.CLAUDE_CODE_LEGACY_CONSOLE = '0'
    resetLegacyConsoleCacheForTesting()
  })

  afterAll(() => {
    if (savedLegacy === undefined) {
      delete process.env.CLAUDE_CODE_LEGACY_CONSOLE
    } else {
      process.env.CLAUDE_CODE_LEGACY_CONSOLE = savedLegacy
    }
    resetLegacyConsoleCacheForTesting()
  })

  test('paints the first frame exactly', () => {
    const pools = makePools()
    const { terminal, next } = renderSequence(pools, ['hello'], ['hello'])
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('single-line character change repaints only that cell', () => {
    const pools = makePools()
    const { terminal, diff, next } = renderSequence(pools, ['hello'], ['heLlo'])
    expect(terminal.lines()).toEqual(expectedGrid(next))
    const written = diff.filter(p => p.type === 'stdout' && p.content !== '\n')
    expect(written).toEqual([{ type: 'stdout', content: 'L' }])
  })

  test('clears the column a wrapped wide char turns into a SpacerHead', () => {
    const pools = makePools()
    // '本' cannot start at the last column, so output.ts drops it and leaves
    // a SpacerHead placeholder there. Nothing paints that column, so the 'j'
    // from the previous frame used to survive on screen forever.
    const { terminal, next, prev } = renderSequence(
      pools,
      ['abcdefghij'],
      ['abcdefghi本'],
    )
    expect(cellAt(next, WIDTH - 1, 0)?.width).toBe(CellWidth.SpacerHead)
    expect(cellAt(prev, WIDTH - 1, 0)?.char).toBe('j')

    expect(terminal.lines()[0]).toBe('abcdefghi ')
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('resets style before clearing a SpacerHead column', () => {
    const pools = makePools()
    // The row ahead of the SpacerHead is repainted with a red background, so
    // the renderer arrives at the last column with that style still active.
    const { terminal, diff, next } = renderSequence(
      pools,
      ['abcdefghij'],
      ['\x1b[41mabcdefghi本\x1b[0m'],
    )
    const activeStyleId = cellAt(next, 0, 0)!.styleId
    expect(activeStyleId).not.toBe(pools.stylePool.none)

    // The clearing space must be preceded by a transition back to the empty
    // style, otherwise the red background bleeds into the cleared column.
    const reset = pools.stylePool.transition(
      activeStyleId,
      pools.stylePool.none,
    )
    expect(reset.length).toBeGreaterThan(0)
    const lastSpace = diff.findLastIndex(
      p => p.type === 'stdout' && p.content === ' ',
    )
    expect(lastSpace).toBeGreaterThanOrEqual(0)
    expect(
      diff
        .slice(0, lastSpace)
        .some(p => p.type === 'styleStr' && p.str === reset),
    ).toBe(true)

    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('does not spend bytes on a SpacerHead over an already blank column', () => {
    const pools = makePools()
    const { terminal, diff, next } = renderSequence(
      pools,
      ['abcdefghi'],
      ['abcdefghi本'],
    )
    expect(
      diff.filter(p => p.type === 'stdout' && p.content === ' '),
    ).toHaveLength(0)
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('draws a single-codepoint wide char at the viewport edge', () => {
    const pools = makePools()
    const { terminal, next } = renderSequence(
      pools,
      ['abcdefghij'],
      ['abcdefgh本'],
    )
    expect(terminal.lines()[0]).toBe('abcdefgh本')
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('draws a multi-codepoint grapheme at the viewport edge', () => {
    const pools = makePools()
    // Wide + SpacerTail land on the last two columns. The old length-based
    // edge test refused to draw the head, and the diff loop skips the tail,
    // so both columns kept showing 'i' and 'j'.
    const { terminal, next } = renderSequence(
      pools,
      ['abcdefghij'],
      [`abcdefgh${ZWJ_EMOJI}`],
    )
    expect(cellAt(next, WIDTH - 2, 0)?.width).toBe(CellWidth.Wide)
    expect(cellAt(next, WIDTH - 1, 0)?.width).toBe(CellWidth.SpacerTail)

    expect(terminal.lines()[0]).toBe(`abcdefgh${ZWJ_EMOJI}`)
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('draws a compensated (VS16) grapheme at the viewport edge', () => {
    const pools = makePools()
    // needsWidthCompensation() fires on the VS16, so the write goes through
    // the CHA-compensated path: pad x+1, step back, emit, re-anchor. That
    // path only became reachable at vw-2 once the edge test switched to
    // display width — before, the whole cell was skipped.
    const { terminal, diff, next } = renderSequence(
      pools,
      ['abcdefghij'],
      [`abcdefgh${COMPENSATED_EMOJI}`],
    )
    expect(cellAt(next, WIDTH - 2, 0)?.width).toBe(CellWidth.Wide)
    expect(diff.some(p => p.type === 'cursorTo')).toBe(true)

    expect(terminal.lines()[0]).toBe(`abcdefgh${COMPENSATED_EMOJI}`)
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('clears the attributes of a highlighted SpacerHead column', () => {
    const pools = makePools()
    // Whole row carries a background (a selection highlight). Next frame is
    // unstyled and ends in a SpacerHead — the glyph AND the background have
    // to go, or the user sees a one-cell highlight block hanging off the
    // right edge.
    const { terminal, prev, next } = renderSequence(
      pools,
      ['\x1b[41mabcdefghij\x1b[0m'],
      ['abcdefghi本'],
    )
    expect(
      styleKeyOf(pools.stylePool, cellAt(prev, WIDTH - 1, 0)!.styleId),
    ).toBe('bg:41')

    expect(terminal.lines()).toEqual(expectedGrid(next))
    expect(terminal.styleAt(WIDTH - 1, 0)).toBe('')
    expect(terminal.styleRow(0)).toEqual(new Array<string>(WIDTH).fill(''))
  })

  test('clears the attributes of cells a shrinking row gives up', () => {
    const pools = makePools()
    // The generic "cell was removed → write a space" path. Without its
    // style reset the vacated columns keep the old background.
    const { terminal, next } = renderSequence(
      pools,
      ['\x1b[41mabcdefghij\x1b[0m'],
      ['abc'],
    )
    expect(terminal.lines()).toEqual(expectedGrid(next))
    expect(terminal.styleRow(0)).toEqual(new Array<string>(WIDTH).fill(''))
  })

  test('keeps the attributes a frame actually asks for', () => {
    const pools = makePools()
    // Counter-test for the two above: the model must not report "clean"
    // unconditionally, or those assertions prove nothing.
    const { terminal, next } = renderSequence(
      pools,
      ['abcdefghij'],
      ['\x1b[41mabcde\x1b[0m'],
    )
    expect(terminal.lines()).toEqual(expectedGrid(next))
    const expectedStyles = Array.from({ length: WIDTH }, (_unused, x) =>
      styleKeyOf(pools.stylePool, cellAt(next, x, 0)!.styleId),
    )
    expect(expectedStyles.slice(0, 5)).toEqual(
      new Array<string>(5).fill('bg:41'),
    )
    expect(terminal.styleRow(0)).toEqual(expectedStyles)
  })

  test('diffs cells that arrived in the next frame by blit', () => {
    const pools = makePools()
    // S1's clear runs inside diffEach, so it only fires if blitted cells are
    // still diffed. blitRegion unions the copied rect into dst.damage and
    // diffEach scans the damage union, so they are — this pins that, since
    // the SpacerHead here never goes through setCellAt on the next screen.
    const { terminal, next } = renderSequence(pools, ['abcdefghij'], p => {
      const source = buildScreen(p, ['abcdefghi本'])
      const screen = createScreen(
        WIDTH,
        1,
        p.stylePool,
        p.charPool,
        p.hyperlinkPool,
      )
      const output = new Output({
        width: WIDTH,
        height: 1,
        stylePool: p.stylePool,
        screen,
      })
      output.blit(source, 0, 0, WIDTH, 1)
      const blitted = output.get()
      expect(cellAt(blitted, WIDTH - 1, 0)?.width).toBe(CellWidth.SpacerHead)
      expect(blitted.damage).toBeDefined()
      return blitted
    })

    expect(terminal.lines()[0]).toBe('abcdefghi ')
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('shrinking erases the rows that went away', () => {
    const pools = makePools()
    const { terminal, diff, next } = renderSequence(
      pools,
      ['alpha', 'bravo', 'charlie'],
      ['alpha', 'bravo'],
    )
    expect(diff.some(p => p.type === 'clear')).toBe(true)
    expect(terminal.lines()).toEqual(expectedGrid(next))
    expect(terminal.lines()[2]).toBe(' '.repeat(WIDTH))
  })

  test('growing renders the new rows', () => {
    const pools = makePools()
    const { terminal, next } = renderSequence(
      pools,
      ['alpha'],
      ['alpha', 'bravo', 'charlie'],
    )
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })

  test('clears a dropped row whose content was wide chars', () => {
    const pools = makePools()
    // Row 1 disappears and row 0 changes from all-wide to mostly narrow —
    // every column of both rows has to end up matching the new frame.
    const { terminal, next } = renderSequence(
      pools,
      ['日本語です', '本'],
      ['abcdefghi本'],
    )
    expect(terminal.lines()).toEqual(expectedGrid(next))
  })
})
