import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import type { DOMElement } from '../dom-types.js'
import {
  appendChildNode,
  createNode,
  createTextNode,
  setStyle,
  setTextStyles,
} from '../dom.js'
import Output from '../output.js'
import applyStyles, { type Styles } from '../styles.js'
import renderNodeToOutput, {
  resetLayoutShifted,
  resetScrollDrainNode,
  resetScrollHint,
} from '../render-node-to-output.js'
import {
  cellAt,
  CharPool,
  createScreen,
  HyperlinkPool,
  type Screen,
  StylePool,
} from '../screen.js'
import type { Color } from '../styles.js'

/**
 * Frame-to-frame blit correctness.
 *
 * renderNodeToOutput's fast path copies a clean subtree's cells straight
 * out of the previous frame's Screen. That is only sound while "clean
 * subtree" implies "identical pixels" — these tests cover the two ways
 * that implication breaks: a change ABOVE the subtree that repaints its
 * cells (an inherited background going away), and a change BESIDE it that
 * used to paint over them (an absolute-positioned overlay moving).
 *
 * Assertions are on the produced Screen rather than on terminal bytes:
 * once a stale cell is in next.screen it is indistinguishable from
 * intended content, and every downstream stage (diff, blit, selection)
 * will faithfully preserve it.
 */

const WIDTH = 20

type Harness = {
  root: DOMElement
  stylePool: StylePool
  render: () => Screen
}

/** Minimal stand-in for ink.tsx's per-frame loop: yoga layout, then paint
 *  into a fresh Screen with the previous frame's Screen available for
 *  blitting (exactly what createRenderer passes in steady state). */
function createHarness(width = WIDTH): Harness {
  const root = createNode('ink-root')
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  let prevScreen: Screen | undefined
  let output: Output | undefined

  return {
    root,
    stylePool,
    render(): Screen {
      root.yogaNode?.setWidth(width)
      root.yogaNode?.calculateLayout(width)
      const height = Math.max(
        1,
        Math.ceil(root.yogaNode?.getComputedHeight() ?? 0),
      )
      const screen = createScreen(
        width,
        height,
        stylePool,
        charPool,
        hyperlinkPool,
      )
      if (output) {
        output.reset(width, height, screen)
      } else {
        output = new Output({ width, height, stylePool, screen })
      }
      resetLayoutShifted()
      resetScrollHint()
      resetScrollDrainNode()
      renderNodeToOutput(root, output, { prevScreen })
      prevScreen = output.get()
      return prevScreen
    },
  }
}

/** What the reconciler does for a `style` prop: store it on the node (which
 *  marks the node — and only its ancestors — dirty) and push the layout
 *  half of it into yoga. */
function restyle(node: DOMElement, style: Styles): void {
  setStyle(node, style)
  if (node.yogaNode) applyStyles(node.yogaNode, style)
}

function box(style: Styles = {}): DOMElement {
  const node = createNode('ink-box')
  restyle(node, style)
  return node
}

function text(value: string, color?: Color): DOMElement {
  const node = createNode('ink-text')
  if (color) setTextStyles(node, { color })
  appendChildNode(node, createTextNode(value) as unknown as DOMElement)
  return node
}

/** Background attribute of every column in a row, '' where there is none.
 *  Reads the style pool rather than the raw id so the expectation reads
 *  like what a user would see. */
function backgroundsOfRow(
  screen: Screen,
  stylePool: StylePool,
  y: number,
): string[] {
  const out: string[] = []
  for (let x = 0; x < screen.width; x++) {
    const cell = cellAt(screen, x, y)
    const codes = cell ? stylePool.get(cell.styleId) : []
    const bg = codes.find(c => c.endCode === '\x1b[49m')
    out.push(bg ? bg.code : '')
  }
  return out
}

function charsOfRow(screen: Screen, y: number): string {
  let line = ''
  for (let x = 0; x < screen.width; x++) {
    line += cellAt(screen, x, y)?.char ?? ' '
  }
  return line
}

describe('blit invalidation', () => {
  // colorize() goes through chalk, which emits nothing at level 0 (the
  // default when stdout is not a TTY) — every background would silently
  // become no-op text and the assertions would pass vacuously. chalk is a
  // singleton shared with the rest of the process, so restore it after.
  const savedChalkLevel = chalk.level

  beforeAll(() => {
    chalk.level = 3
  })

  afterAll(() => {
    chalk.level = savedChalkLevel
  })

  test('dropping a background repaints the children that inherited it', () => {
    const h = createHarness()
    // A selected row: background on the row Box, two children pushed to the
    // edges by space-between. The children inherit the background, so their
    // own cells carry it.
    const row = box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: WIDTH,
      backgroundColor: 'ansi:blue',
    })
    appendChildNode(row, text('AB'))
    appendChildNode(row, text('YZ'))
    appendChildNode(h.root, row)

    const selected = h.render()
    expect(charsOfRow(selected, 0)).toBe('AB                YZ')
    expect(
      backgroundsOfRow(selected, h.stylePool, 0).filter(Boolean),
    ).toHaveLength(WIDTH)

    // Selection moves away: the row loses its background and nothing else
    // changes. The children are still clean, and markDirty only walks up,
    // so they keep their cached layout — the blit fast path is eligible for
    // them even though the cells it would copy are the highlighted ones.
    restyle(row, {
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: WIDTH,
    })

    const deselected = h.render()
    expect(charsOfRow(deselected, 0)).toBe('AB                YZ')
    expect(backgroundsOfRow(deselected, h.stylePool, 0)).toEqual(
      new Array<string>(WIDTH).fill(''),
    )
  })

  test('moving an absolute overlay does not blit its old pixels back', () => {
    const h = createHarness()
    // Normal-flow content first (so it is not downstream of a dirty
    // sibling), then an absolute overlay parked over its middle columns —
    // the shape of every modal, pill and autocomplete in the app.
    const body = box({ width: WIDTH })
    appendChildNode(body, text('....................'))
    appendChildNode(h.root, body)

    const overlay = box({
      position: 'absolute',
      top: 0,
      left: 6,
      width: 8,
      opaque: true,
    })
    appendChildNode(overlay, text('OVERLAY!'))
    appendChildNode(h.root, overlay)

    const withOverlay = h.render()
    expect(charsOfRow(withOverlay, 0)).toBe('......OVERLAY!......')

    // The overlay moves. It is dirty, so its old rect is cleared; the body
    // is untouched, so its full-width row is eligible for the blit fast
    // path — and prevScreen's copy of that row has the overlay painted
    // into the middle of it.
    restyle(overlay, {
      position: 'absolute',
      top: 0,
      left: 0,
      width: 8,
      opaque: true,
    })

    const moved = h.render()
    expect(charsOfRow(moved, 0)).toBe('OVERLAY!............')

    // And it stays fixed. A repair that only blanked the vacated columns
    // would look right here and then blit the blanks forward forever,
    // because the body is clean again and its cached rect still matches.
    const settled = h.render()
    expect(charsOfRow(settled, 0)).toBe('OVERLAY!............')
  })

  test('an overlay moving under a different parent does not ghost', () => {
    const h = createHarness()
    // Same situation one level down: the body and the overlay no longer
    // share a parent, so the container rendering the body cannot see that
    // the overlay is vacating. output.ts's per-row rect subtraction is the
    // backstop here — it stops the old pixels from being blitted back.
    const bodyWrapper = box({ width: WIDTH })
    const body = box({ width: WIDTH })
    appendChildNode(body, text('....................'))
    appendChildNode(bodyWrapper, body)
    appendChildNode(h.root, bodyWrapper)

    // The wrapper is itself absolute and never moves, so the container
    // above it sees nothing change; only the overlay inside it does.
    // Narrower than the body's row so the blit only partially intersects
    // the clears — the case the old "row entirely inside the clear rect"
    // test always answered no to. Non-zero height because a zero-height box
    // sharing a row with a sibling is skipped outright, children and all.
    const overlayWrapper = box({
      position: 'absolute',
      top: 0,
      left: 4,
      width: 12,
      height: 1,
    })
    const overlay = box({
      position: 'absolute',
      top: 0,
      left: 2,
      width: 8,
      opaque: true,
    })
    appendChildNode(overlay, text('OVERLAY!'))
    appendChildNode(overlayWrapper, overlay)
    appendChildNode(h.root, overlayWrapper)

    expect(charsOfRow(h.render(), 0)).toBe('......OVERLAY!......')

    restyle(overlay, {
      position: 'absolute',
      top: 0,
      left: 0,
      width: 8,
      opaque: true,
    })
    const moved = charsOfRow(h.render(), 0)

    // No glyph of the old overlay may survive to the right of the new one.
    expect(moved.slice(12)).not.toContain('E')
    expect(moved.slice(12)).not.toContain('R')
    expect(moved.slice(12)).not.toContain('Y')
    // KNOWN RESIDUAL: the vacated columns come back blank rather than
    // repainted, because nothing in this frame owns them — the body's
    // container never learned the overlay was moving. Blank beats
    // duplicated text, and it matches the pre-existing behaviour for rows
    // a clear fully covered, but it is not a full repair. Closing it needs
    // the vacating rects to be known frame-wide (a registry of absolute
    // nodes) instead of per-container.
    expect(moved).toBe('....OVERLAY!    ....')
  })

  test('re-adding a background repaints children that did not have it', () => {
    const h = createHarness()
    const row = box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: WIDTH,
    })
    appendChildNode(row, text('AB'))
    appendChildNode(row, text('YZ'))
    appendChildNode(h.root, row)

    h.render()
    restyle(row, {
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: WIDTH,
      backgroundColor: 'ansi:blue',
    })
    const selected = h.render()

    expect(charsOfRow(selected, 0)).toBe('AB                YZ')
    expect(
      backgroundsOfRow(selected, h.stylePool, 0).filter(Boolean),
    ).toHaveLength(WIDTH)
  })
})
