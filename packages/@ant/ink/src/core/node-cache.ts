import type { DOMElement } from './dom-types.js'
import type { Rectangle } from './layout/geometry.js'
import type { Color } from './styles.js'

/**
 * Cached layout bounds for each rendered node (used for blit + clearing).
 * `top` is the yoga-local getComputedTop() — stored so ScrollBox viewport
 * culling can skip yoga reads for clean children whose position hasn't
 * shifted (O(dirty) instead of O(mounted) first-pass).
 *
 * `bg` is the EFFECTIVE background the node was painted with (its own, or
 * the one it inherited). Layout equality alone does not mean the node's
 * cells are still valid: markDirty only walks up, so removing a Box's
 * backgroundColor leaves every descendant clean while invalidating all of
 * their pixels. Comparing the recorded background against the current one
 * is what stops the blit fast path from copying the old highlight back.
 */
export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  top?: number
  bg?: Color
}

export const nodeCache = new WeakMap<DOMElement, CachedLayout>()

/** Rects of removed children that need clearing on next render */
export const pendingClears = new WeakMap<DOMElement, Rectangle[]>()

/**
 * Set when a pendingClear is added for an absolute-positioned node.
 * Signals renderer to disable blit for the next frame: the removed node
 * may have painted over non-siblings (e.g. an overlay over a ScrollBox
 * earlier in tree order), so their blits from prevScreen would restore
 * the overlay's pixels. Normal-flow removals are already handled by
 * hasRemovedChild at the parent level; only absolute positioning paints
 * cross-subtree. Reset at the start of each render.
 */
let absoluteNodeRemoved = false

export function addPendingClear(
  parent: DOMElement,
  rect: Rectangle,
  isAbsolute: boolean,
): void {
  const existing = pendingClears.get(parent)
  if (existing) {
    existing.push(rect)
  } else {
    pendingClears.set(parent, [rect])
  }
  if (isAbsolute) {
    absoluteNodeRemoved = true
  }
}

export function consumeAbsoluteRemovedFlag(): boolean {
  const had = absoluteNodeRemoved
  absoluteNodeRemoved = false
  return had
}
