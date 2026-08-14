/**
 * Rendering helpers shared by every system-prompt section.
 *
 * The bullet shape (` - ` at depth 0, `  - ` at depth 1) is load-bearing: the
 * whole prompt is one flat markdown document and the two-space nesting is what
 * separates a sub-item from a new top-level rule.
 */

export function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap(item =>
    Array.isArray(item)
      ? item.map(subitem => `  - ${subitem}`)
      : [` - ${item}`],
  )
}

/**
 * Render `# <title>` followed by bulleted items, dropping nulls.
 *
 * Returns null when nothing survives filtering — a heading with no body is
 * pure noise in the prompt, and every caller previously hand-rolled this
 * check (three of them had drifted into returning `''` instead).
 */
export function bulletSection(
  title: string,
  items: Array<string | string[] | null>,
): string | null {
  const present = items.filter(
    (item): item is string | string[] => item !== null,
  )
  if (present.length === 0) return null
  return [`# ${title}`, ...prependBullets(present)].join('\n')
}
