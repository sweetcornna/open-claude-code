import type { EventHandlerProps } from './events/event-handlers.js'
import type { LayoutNode } from './layout/node.js'
import type { Styles, TextStyles } from './styles.js'

/**
 * Shape of the Ink DOM tree.
 *
 * Split out of dom.ts so that modules which only need to *describe* a node
 * (focus.ts, node-cache.ts, squash-text-nodes.ts, render-border.ts) don't have
 * to import dom.ts's tree-mutation runtime — dom.ts imports several of them
 * back, so every one of those type imports used to close a cycle.
 *
 * dom.ts re-exports everything here, so `import type { DOMElement } from
 * './dom.js'` keeps working.
 */

type InkNode = {
  parentNode: DOMElement | undefined
  yogaNode?: LayoutNode
  style: Styles
}

export type TextName = '#text'
export type ElementNames =
  | 'ink-root'
  | 'ink-box'
  | 'ink-text'
  | 'ink-virtual-text'
  | 'ink-link'
  | 'ink-progress'
  | 'ink-raw-ansi'

export type NodeNames = ElementNames | TextName

/**
 * The focus-manager surface reachable from any node via the tree root.
 *
 * Declared structurally instead of importing `FocusManager` from focus.ts:
 * FocusManager is written entirely in terms of `DOMElement`, so importing it
 * here would make the two modules mutually dependent again. focus.ts declares
 * `class FocusManager implements FocusManagerLike`, so the compiler keeps this
 * declaration honest.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export type FocusManagerLike = {
  activeElement: DOMElement | null
  focus(node: DOMElement): void
  blur(): void
  handleNodeRemoved(node: DOMElement, root: DOMElement): void
  handleAutoFocus(node: DOMElement): void
  handleClickFocus(node: DOMElement): void
  enable(): void
  disable(): void
  focusNext(root: DOMElement): void
  focusPrevious(root: DOMElement): void
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMElement = {
  nodeName: ElementNames
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  textStyles?: TextStyles

  // Internal properties
  onComputeLayout?: () => void
  onRender?: () => void
  onImmediateRender?: () => void
  // Used to skip empty renders during React 19's effect double-invoke in test mode
  hasRenderedContent?: boolean

  // When true, this node needs re-rendering
  dirty: boolean
  // Set by the reconciler's hideInstance/unhideInstance; survives style updates.
  isHidden?: boolean
  // 协调器写入的事件处理器（捕获/冒泡分发用）。
  // 与 attributes 分离，避免 handler 引用变化触发 dirty 破坏 blit 优化。
  _eventHandlers?: Partial<EventHandlerProps> // 见 event-handlers.ts EventHandlerProps

  // Scroll state for overflow: 'scroll' boxes. scrollTop is the number of
  // rows the content is scrolled down by. scrollHeight/scrollViewportHeight
  // are computed at render time and stored for imperative access. stickyScroll
  // auto-pins scrollTop to the bottom when content grows.
  scrollTop?: number
  // Accumulated scroll delta not yet applied to scrollTop. The renderer
  // drains this at SCROLL_MAX_PER_FRAME rows/frame so fast flicks show
  // intermediate frames instead of one big jump. Direction reversal
  // naturally cancels (pure accumulator, no target tracking).
  pendingScrollDelta?: number
  // Render-time clamp bounds for virtual scroll. useVirtualScroll writes
  // the currently-mounted children's coverage span; render-node-to-output
  // clamps scrollTop to stay within it. Prevents blank screen when
  // scrollTo's direct write races past React's async re-render — instead
  // of painting spacer (blank), the renderer holds at the edge of mounted
  // content until React catches up (next commit updates these bounds and
  // the clamp releases). Undefined = no clamp (sticky-scroll, cold start).
  scrollClampMin?: number
  scrollClampMax?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  stickyScroll?: boolean
  // Set by ScrollBox.scrollToElement; render-node-to-output reads
  // el.yogaNode.getComputedTop() (FRESH — same Yoga pass as scrollHeight)
  // and sets scrollTop = top + offset, then clears this. Unlike an
  // imperative scrollTo(N) which bakes in a number that's stale by the
  // time the throttled render fires, the element ref defers the position
  // read to paint time. One-shot.
  scrollAnchor?: { el: DOMElement; offset: number }
  // Only set on ink-root. The document owns focus — any node can
  // reach it by walking parentNode, like browser getRootNode().
  focusManager?: FocusManagerLike
  // React component stack captured at createInstance time (reconciler.ts),
  // e.g. ['ToolUseLoader', 'Messages', 'REPL']. Only populated when
  // CLAUDE_CODE_DEBUG_REPAINTS is set. Used by findOwnerChainAtRow to
  // attribute scrollback-diff full-resets to the component that caused them.
  debugOwnerChain?: string[]
} & InkNode

export type TextNode = {
  nodeName: TextName
  nodeValue: string
} & InkNode

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNode<T = { nodeName: NodeNames }> = T extends {
  nodeName: infer U
}
  ? U extends '#text'
    ? TextNode
    : DOMElement
  : never

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNodeAttribute = boolean | string | number
