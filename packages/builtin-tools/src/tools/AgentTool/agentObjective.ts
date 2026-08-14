/**
 * The one-line "what was this agent sent to do" text shown under each running
 * agent in the REPL agent list.
 *
 * That slot used to show the sub-agent's live tool activity (`Read(foo.ts)`),
 * which is low signal: it says what the agent is touching right now, never
 * what it owns. With several agents running concurrently the user's actual
 * question is "who is responsible for which piece", so the slot now carries
 * the objective instead and falls back to the activity line.
 *
 * PURE LEAF — no imports, so it can be unit-tested without mocking anything.
 *
 * Everything past the explicit `objective` field is a HEURISTIC. Prompts are
 * free-form prose; there is no reliable way to read an objective out of one.
 * It is display-only — nothing downstream reads this text — so a mediocre
 * guess is strictly better than showing a scrolling tool feed.
 */

/**
 * Character budget for the returned objective, ellipsis included.
 *
 * This is the content-level cap that keeps the value a status line rather than
 * a paragraph. Clamping to the *actual* terminal width is a separate concern
 * and lives in AgentProgressLine, which knows the tree prefix width.
 */
export const AGENT_OBJECTIVE_MAX_LENGTH = 100

/**
 * Line-leading labels that only restate environment the agent was already
 * told about, so they are skipped when scanning a prompt for its first
 * substantive line.
 *
 * Deliberately a closed list rather than a general `Label: value` rule: such a
 * rule would also swallow `Goal:` / `Task:` / `Objective:` lines, which are
 * precisely the text being looked for.
 */
const ENVIRONMENT_PREAMBLE_LABELS = new Set([
  'branch',
  'context',
  'cwd',
  'date',
  'env',
  'environment',
  'model',
  'os',
  'os version',
  'platform',
  'repo',
  'repository',
  'session',
  'shell',
  'today',
  'working directory',
])

/**
 * Heading texts that introduce the actual assignment. Hitting the first of
 * these throws away everything scanned so far and restarts from the heading.
 *
 * Delegation briefs in this repo almost always open with a line of environment
 * ("you are working in repo X"), then `# 背景`, and only name the goal under a
 * `# 任务` heading further down — so the first substantive paragraph is
 * reliably the wrong one whenever such a heading exists.
 *
 * Closed list, same reasoning as ENVIRONMENT_PREAMBLE_LABELS: a wildcard
 * "any heading resets" rule would restart on `# 背景` / `# Notes` too, which is
 * worse than not resetting at all. Matched as a prefix of the normalised
 * heading text so `# Task 1`, `## 任务 A：xxx` and `# 要做的改造` all count.
 */
const TASK_HEADING_LABELS = [
  '任务',
  '目标',
  '目的',
  '要做的',
  '要解决的问题',
  '你的任务',
  'task',
  'goal',
  'objective',
  'your task',
  'what to do',
  'assignment',
]

/** ATX heading: `# Title` … `###### Title`. */
const ATX_HEADING = /^#{1,6}(?:\s|$)/
/** Thematic break or setext underline: `---`, `===`, `***`, `___`. */
const THEMATIC_BREAK = /^([-=*_])\1{2,}$/
/** A line that is nothing but a tag, e.g. `<task>` or `</task>`. */
const TAG_ONLY = /^<[^>]*>$/
/** Fenced code block delimiter. */
const CODE_FENCE = /^(?:```|~~~)/
/** Leading `Label:` (optionally bolded), captured for the label lookup. */
const LEADING_LABEL = /^(?:\*\*)?([A-Za-z][A-Za-z ]{0,20}?)(?:\*\*)?\s*:/
/** Leading list bullet or ordinal, plus blockquote markers. */
const LEADING_MARKERS = /^(?:>\s*)*(?:[-*+]|\d+[.)])\s+/
/** Bold/underline emphasis markers, which would render literally. */
const EMPHASIS_MARKERS = /\*\*|__/g
/** Sentence terminators, ASCII and CJK. */
const SENTENCE_TERMINATORS = /[.!?。！？]/
const ASCII_TERMINATORS = /[.!?]/

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateToBudget(text: string): string {
  const chars = [...text]
  if (chars.length <= AGENT_OBJECTIVE_MAX_LENGTH) {
    return text
  }
  const kept = chars
    .slice(0, AGENT_OBJECTIVE_MAX_LENGTH - 1)
    .join('')
    .trimEnd()
  return `${kept}…`
}

function isStructuralLine(line: string): boolean {
  return (
    line === '' ||
    ATX_HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    TAG_ONLY.test(line)
  )
}

function isEnvironmentPreamble(line: string): boolean {
  const label = LEADING_LABEL.exec(line)?.[1]
  return label !== undefined
    ? ENVIRONMENT_PREAMBLE_LABELS.has(label.trim().toLowerCase())
    : false
}

/**
 * Whether a line is an ATX heading that opens the assignment. Numbering and
 * trailing text are tolerated (`# Task 1`, `## 任务 A：xxx`) because the labels
 * are matched as prefixes; setext headings are not recognised.
 */
function isTaskHeading(line: string): boolean {
  if (!ATX_HEADING.test(line)) {
    return false
  }
  const text = line
    .replace(/^#{1,6}\s*/, '')
    .replace(EMPHASIS_MARKERS, '')
    .trim()
    .toLowerCase()
  return TASK_HEADING_LABELS.some(label => text.startsWith(label))
}

/**
 * First sentence of an already-collapsed single line.
 *
 * An ASCII terminator only ends the sentence when followed by whitespace or
 * end of input, so `src/foo.ts`, `v2.4` and `e.g.` do not cut it short. CJK
 * terminators need no such guard.
 */
function firstSentence(text: string): string {
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!
    if (!SENTENCE_TERMINATORS.test(char)) {
      continue
    }
    const next = chars[i + 1]
    const ends =
      next === undefined || !ASCII_TERMINATORS.test(char) || /\s/.test(next)
    if (ends) {
      return chars.slice(0, i + 1).join('')
    }
  }
  return text
}

/**
 * Best-effort objective from a free-form prompt: skip structural and
 * environment-restating lines, take the first paragraph that has substance,
 * fold it to a single line, and keep its first sentence.
 *
 * The first task heading (see TASK_HEADING_LABELS) discards everything scanned
 * before it and restarts. That has to keep working after a paragraph has
 * already been collected — the heading usually sits several sections down —
 * so the scan cannot stop at the first complete paragraph; it stops either at
 * the first task heading's paragraph, or at end of input.
 *
 * Only the *first* task heading resets. Briefs that split the work across
 * `# 任务 A` / `# 任务 B` state the overall goal under the first one.
 */
function extractFromPrompt(prompt: string): string | null {
  let paragraph: string[] = []
  let paragraphComplete = false
  let taskHeadingSeen = false
  let inFence = false

  for (const rawLine of prompt.split('\n')) {
    const line = rawLine.trim()

    // Fence tracking runs even after the paragraph is complete, so a `# 任务`
    // line quoted inside a code block cannot trigger the reset.
    if (inFence) {
      if (CODE_FENCE.test(line)) {
        inFence = false
      }
      continue
    }
    if (CODE_FENCE.test(line)) {
      inFence = true
      if (paragraph.length > 0) {
        paragraphComplete = true
      }
      continue
    }

    if (!taskHeadingSeen && isTaskHeading(line)) {
      taskHeadingSeen = true
      paragraph = []
      paragraphComplete = false
      continue
    }

    if (paragraphComplete) {
      // Nothing further can improve on a paragraph taken from under the task
      // heading; otherwise keep scanning in case one shows up later.
      if (taskHeadingSeen) {
        break
      }
      continue
    }

    if (isStructuralLine(line) || isEnvironmentPreamble(line)) {
      if (paragraph.length > 0) {
        paragraphComplete = true
      }
      continue
    }

    if (LEADING_MARKERS.test(line)) {
      // A bullet is a unit on its own. Folding a whole list into one line
      // yields "改 A 改 B 改 C"; take just the first item instead.
      if (paragraph.length === 0) {
        paragraph.push(line.replace(LEADING_MARKERS, ''))
      }
      paragraphComplete = true
      continue
    }

    paragraph.push(line)
  }

  if (paragraph.length === 0) {
    return null
  }
  const folded = collapseWhitespace(
    paragraph.join(' ').replace(EMPHASIS_MARKERS, ''),
  )
  return folded === '' ? null : firstSentence(folded)
}

/**
 * Resolves what the agent list should show for a sub-agent, in priority order:
 * the caller's explicit `objective`, a heuristic read of `prompt`, then
 * `description`. Null when the input carries none of them, which leaves the
 * caller to fall back to the live activity line.
 */
export function deriveAgentObjective(input: {
  objective?: string
  prompt?: string
  description?: string
}): string | null {
  const explicit = collapseWhitespace(input.objective ?? '')
  if (explicit !== '') {
    return truncateToBudget(explicit)
  }

  const fromPrompt = input.prompt ? extractFromPrompt(input.prompt) : null
  if (fromPrompt !== null && fromPrompt !== '') {
    return truncateToBudget(fromPrompt)
  }

  const description = collapseWhitespace(input.description ?? '')
  if (description !== '') {
    return truncateToBudget(description)
  }

  return null
}
