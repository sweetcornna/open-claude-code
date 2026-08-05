import { describe, expect, test } from 'bun:test'
import { emptyFrame, type Diff, type Frame } from '../frame.js'
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
import { resetLegacyConsoleCacheForTesting } from '../legacyConsole.js'

/**
 * Randomised, multi-frame counterpart to log-update.test.ts.
 *
 * The golden tests pin known bugs with hand-authored frame pairs. This one
 * hunts for the *unknown* ones: it walks a chain of random frames through the
 * real diff engine into a terminal model and asserts, after every frame, that
 * the terminal shows exactly what the frame's Screen says it should. Any cell
 * the diff fails to repaint — the "stray characters" failure mode — shows up
 * as a mismatch with a reproducible seed.
 *
 * Why multi-frame matters: residue is usually a *carry-over* bug. Frame N
 * leaves a cell the engine believes is already correct, so frame N+1 never
 * revisits it and the stale glyph survives until a full repaint. A two-frame
 * test can't see that; the third frame is where it becomes permanent.
 *
 * Scope: frame heights are capped below the viewport so the terminal never
 * scrolls. That keeps every frame on the incremental diff path (the code under
 * test) and out of the full-reset paths, and it keeps the model honest — a
 * non-scrolling model would otherwise disagree with a scrolling terminal for
 * reasons that are not bugs.
 */

const WIDTH = 12
const VIEWPORT_HEIGHT = 8
// Cursor parks at row `screen.height`, so staying strictly below the viewport
// height is what guarantees no scroll.
const MAX_CONTENT_HEIGHT = VIEWPORT_HEIGHT - 1

const ZWJ_EMOJI = '\u{1F468}\u{200D}\u{1F4BB}' // 👨‍💻 — width 2, length 5
const VS16_EMOJI = '❤️' // ❤️ — width 2, triggers width compensation
const ALPHABET = [
  ' ',
  ' ',
  'a',
  'b',
  'c',
  'd',
  '中',
  '日',
  ZWJ_EMOJI,
  VS16_EMOJI,
]

/** mulberry32 — small, seeded, reproducible. A failing case prints its seed. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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

/** Build a Screen through the real Output pipeline, so wide-char cells,
 *  SpacerTail and SpacerHead placement come from production code. */
function buildScreen(pools: Pools, lines: string[]): Screen {
  const height = lines.length
  const screen = createScreen(
    WIDTH,
    height,
    pools.stylePool,
    pools.charPool,
    pools.hyperlinkPool,
  )
  const output = new Output({
    width: WIDTH,
    height,
    stylePool: pools.stylePool,
    screen,
  })
  for (const [y, line] of lines.entries()) {
    output.write(0, y, line)
  }
  return output.get()
}

/** Frame shaped like createRenderer's non-alt-screen output. */
function frameOf(screen: Screen): Frame {
  return {
    screen,
    viewport: { width: WIDTH, height: VIEWPORT_HEIGHT },
    cursor: { x: 0, y: screen.height, visible: false },
  }
}

/** The grid a correct renderer must leave behind. Wide cells occupy their
 *  SpacerTail column (rendered as '' so rows stay column-aligned); SpacerHead
 *  columns — a wide glyph that did not fit and was dropped — are blank. */
function expectedGrid(screen: Screen, height: number): string[] {
  const rows: string[][] = Array.from({ length: height }, () =>
    new Array<string>(WIDTH).fill(' '),
  )
  for (let y = 0; y < Math.min(screen.height, height); y++) {
    for (let x = 0; x < WIDTH; x++) {
      const cell = cellAt(screen, x, y)
      if (!cell || cell.width === CellWidth.SpacerTail) continue
      rows[y]![x] = cell.width === CellWidth.SpacerHead ? ' ' : cell.char
      if (cell.width === CellWidth.Wide && x + 1 < WIDTH) rows[y]![x + 1] = ''
    }
  }
  return rows.map(row => row.join(''))
}

/**
 * Character-only terminal model. Styles are deliberately out of scope here —
 * the golden suite already covers SGR, and residue is a *character* defect.
 * Semantics mirror the FakeTerminal in log-update.test.ts.
 */
class CharTerminal {
  private readonly grid: string[][]
  /** Per-column "this is the second half of the wide glyph to my left".
   *  Tracked explicitly rather than inferred from a '' sentinel in `grid`:
   *  when a write lands on a wide glyph the terminal destroys BOTH of its
   *  columns, and a sentinel-only model leaves the orphaned half behind and
   *  then mis-attributes it to the next glyph written next to it. */
  private readonly tail: boolean[][]
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
    this.tail = Array.from({ length: height }, () =>
      new Array<boolean>(width).fill(false),
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
          this.pendingWrap = false
          this.col = Math.min(this.width - 1, Math.max(0, this.col + patch.x))
          this.row = Math.max(0, this.row + patch.y)
          break
        case 'cursorTo':
          this.col = Math.min(this.width - 1, Math.max(0, patch.col - 1))
          this.pendingWrap = false
          break
        case 'clear':
          this.eraseLines(patch.count)
          break
        case 'clearTerminal':
          for (const row of this.grid) row.fill(' ')
          for (const row of this.tail) row.fill(false)
          this.row = 0
          this.col = 0
          this.pendingWrap = false
          break
        default:
          // styleStr / hyperlink / cursorHide / cursorShow: no cell state.
          break
      }
    }
  }

  /** Rows rendered the same way expectedGrid() renders them: a wide glyph's
   *  second column contributes '' so columns stay aligned. */
  lines(): string[] {
    return this.grid.map((row, y) =>
      row.map((ch, x) => (this.tail[y]?.[x] ? '' : ch)).join(''),
    )
  }

  private print(content: string): void {
    const parts = content.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        this.row += 1
        this.pendingWrap = false
      }
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
    if (this.col + cellWidth > this.width) {
      this.col = 0
      this.row += 1
    }
    const row = this.rowAt(this.row)
    const tail = this.tailAt(this.row)
    // A write that touches either column of a wide glyph destroys the whole
    // glyph — blank both of its columns before laying down the new one.
    for (let i = this.col; i < this.col + cellWidth && i < this.width; i++) {
      if (tail[i]) {
        row[i - 1] = ' '
        row[i] = ' '
        tail[i] = false
      } else if (tail[i + 1]) {
        row[i] = ' '
        row[i + 1] = ' '
        tail[i + 1] = false
      }
    }
    row[this.col] = grapheme
    tail[this.col] = false
    if (cellWidth === 2 && this.col + 1 < this.width) {
      row[this.col + 1] = grapheme
      tail[this.col + 1] = true
    }
    this.col += cellWidth
    if (this.col >= this.width) {
      this.col = this.width - 1
      this.pendingWrap = true
    }
  }

  private eraseLines(count: number): void {
    for (let i = 0; i < count; i++) {
      this.rowAt(this.row).fill(' ')
      this.tailAt(this.row).fill(false)
      if (i < count - 1) this.row = Math.max(0, this.row - 1)
    }
    this.col = 0
    this.pendingWrap = false
  }

  private rowAt(y: number): string[] {
    while (this.grid.length <= y) {
      this.grid.push(new Array<string>(this.width).fill(' '))
    }
    return this.grid[y]!
  }

  private tailAt(y: number): boolean[] {
    while (this.tail.length <= y) {
      this.tail.push(new Array<boolean>(this.width).fill(false))
    }
    return this.tail[y]!
  }
}

function randomLine(rand: () => number): string {
  // Overshoot the width sometimes so the wide-char-at-the-edge path (which
  // emits a SpacerHead and drops the grapheme) gets exercised.
  const len = Math.floor(rand() * (WIDTH + 3))
  let line = ''
  for (let i = 0; i < len; i++) {
    line += ALPHABET[Math.floor(rand() * ALPHABET.length)]!
  }
  return line
}

function randomFrameLines(rand: () => number): string[] {
  const height = Math.floor(rand() * (MAX_CONTENT_HEIGHT + 1))
  return Array.from({ length: height }, () => randomLine(rand))
}

/** Run one seeded chain of frames; returns a description of the first
 *  divergence, or null when every frame rendered exactly. */
function runChain(seed: number, frameCount: number): string | null {
  const rand = makeRandom(seed)
  const pools = makePools()
  const log = new LogUpdate({ isTTY: true, stylePool: pools.stylePool })
  const terminal = new CharTerminal(WIDTH, VIEWPORT_HEIGHT)

  let prevFrame = emptyFrame(
    VIEWPORT_HEIGHT,
    WIDTH,
    pools.stylePool,
    pools.charPool,
    pools.hyperlinkPool,
  )
  const history: string[][] = []

  for (let i = 0; i < frameCount; i++) {
    const lines = randomFrameLines(rand)
    history.push(lines)
    // Each frame gets its own buffer — production double-buffers, and the
    // diff needs both screens intact.
    const screen = buildScreen(pools, lines)
    const frame = frameOf(screen)
    terminal.apply(log.render(prevFrame, frame))
    prevFrame = frame

    const actual = terminal.lines().slice(0, VIEWPORT_HEIGHT)
    const expected = expectedGrid(screen, VIEWPORT_HEIGHT)
    if (actual.join('\n') !== expected.join('\n')) {
      return [
        `seed=${seed} diverged after frame ${i + 1}/${frameCount}`,
        `frames: ${JSON.stringify(history)}`,
        `expected:\n${expected.map(r => `  |${r}|`).join('\n')}`,
        `actual:\n${actual.map(r => `  |${r}|`).join('\n')}`,
      ].join('\n')
    }
  }
  return null
}

describe('LogUpdate diff fuzz', () => {
  // Legacy-console mode replaces every diff with a full repaint, which would
  // hide exactly the bugs this test hunts for. Force it off.
  process.env.CLAUDE_CODE_LEGACY_CONSOLE = '0'
  resetLegacyConsoleCacheForTesting()

  test('terminal matches the screen after every frame in a chain', () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 400; seed++) {
      const failure = runChain(seed, 5)
      if (failure) {
        failures.push(failure)
        if (failures.length >= 3) break
      }
    }
    expect(failures.join('\n\n---\n\n')).toBe('')
  })

  test('long chains stay in sync (carry-over residue)', () => {
    const failures: string[] = []
    for (let seed = 1001; seed <= 1100; seed++) {
      const failure = runChain(seed, 20)
      if (failure) {
        failures.push(failure)
        if (failures.length >= 3) break
      }
    }
    expect(failures.join('\n\n---\n\n')).toBe('')
  })
})
