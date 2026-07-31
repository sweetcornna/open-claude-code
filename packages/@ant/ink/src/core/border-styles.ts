import type { Boxes, BoxStyle } from 'cli-boxes'

/**
 * Border vocabulary shared by the style layer and the border renderer.
 *
 * Lives in its own leaf module because `Styles` (styles.ts) needs the border
 * types while render-border.ts needs `Styles` back — keeping the vocabulary
 * here means neither has to import the other. render-border.ts re-exports the
 * two types so its existing import path (and the package barrel's
 * `BorderTextOptions`) keeps working.
 */

export type BorderTextOptions = {
  content: string // Pre-rendered string with ANSI color codes
  position: 'top' | 'bottom'
  align: 'start' | 'end' | 'center'
  offset?: number // Only used with 'start' or 'end' alignment. Number of characters from the edge.
}

export const CUSTOM_BORDER_STYLES = {
  dashed: {
    top: '╌',
    left: '╎',
    right: '╎',
    bottom: '╌',
    // there aren't any line-drawing characters for dashes unfortunately
    topLeft: ' ',
    topRight: ' ',
    bottomLeft: ' ',
    bottomRight: ' ',
  },
} as const

export type BorderStyle =
  | keyof Boxes
  | keyof typeof CUSTOM_BORDER_STYLES
  | BoxStyle
