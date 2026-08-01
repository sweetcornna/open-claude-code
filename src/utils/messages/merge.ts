/**
 * Merging of adjacent messages and of content blocks, including the smoosh that
 * folds <system-reminder> siblings into the preceding tool_result.
 */
import type {
  ContentBlock,
  ContentBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import last from 'lodash-es/last.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isToolReferenceBlock } from '../searchExtraTools.js'

/**
 * Final pass: smoosh any `<system-reminder>`-prefixed text siblings into the
 * last tool_result of the same user message. Catches siblings from:
 * - PreToolUse hook additionalContext (Gap F: attachment between assistant and
 *   tool_result → standalone push → mergeUserMessages → hoist → sibling)
 * - relocateToolReferenceSiblings output (Gap E)
 * - any attachment-origin text that escaped merge-time smoosh
 *
 * Non-system-reminder text (real user input, TOOL_REFERENCE_TURN_BOUNDARY,
 * context-collapse `<collapsed>` summaries) stays untouched — a Human: boundary
 * before actual user input is semantically correct. A/B (sai-20260310-161901,
 * Arm B) confirms: real user input left as sibling + 2 SR-text teachers
 * removed → 0%.
 *
 * Idempotent. Pure function of shape.
 */
export function smooshSystemReminderSiblings(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return messages.map(msg => {
    if (msg.type !== 'user') return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const hasToolResult = content.some(b => b.type === 'tool_result')
    if (!hasToolResult) return msg

    const srText: TextBlockParam[] = []
    const kept: ContentBlockParam[] = []
    for (const b of content) {
      if (b.type === 'text' && b.text.startsWith('<system-reminder>')) {
        srText.push(b)
      } else {
        kept.push(b)
      }
    }
    if (srText.length === 0) return msg

    // Smoosh into the LAST tool_result (positionally adjacent in rendered prompt)
    const lastTrIdx = kept.findLastIndex(b => b.type === 'tool_result')
    const lastTr = kept[lastTrIdx] as ToolResultBlockParam
    const smooshed = smooshIntoToolResult(lastTr, srText)
    if (smooshed === null) return msg // tool_ref constraint — leave alone

    const newContent = [
      ...kept.slice(0, lastTrIdx),
      smooshed,
      ...kept.slice(lastTrIdx + 1),
    ]
    return {
      ...msg,
      message: { ...msg.message, content: newContent },
    }
  })
}

export function mergeUserMessagesAndToolResults(
  a: UserMessage,
  b: UserMessage,
): UserMessage {
  const lastContent = normalizeUserTextContent(
    a.message.content as string | ContentBlockParam[],
  )
  const currentContent = normalizeUserTextContent(
    b.message.content as string | ContentBlockParam[],
  )
  return {
    ...a,
    message: {
      ...a.message,
      content: hoistToolResults(
        mergeUserContentBlocks(lastContent, currentContent),
      ),
    },
  }
}

export function mergeAssistantMessages(
  a: AssistantMessage,
  b: AssistantMessage,
): AssistantMessage {
  return {
    ...a,
    message: {
      ...a.message,
      content: [
        ...(Array.isArray(a.message.content) ? a.message.content : []),
        ...(Array.isArray(b.message.content) ? b.message.content : []),
      ] as ContentBlockParam[] | ContentBlock[],
    },
  }
}

function isToolResultMessage(msg: Message): boolean {
  if (msg.type !== 'user') {
    return false
  }
  const content = msg.message?.content
  if (!content || typeof content === 'string') return false
  return (content as Array<{ type: string }>).some(
    block => block.type === 'tool_result',
  )
}

export function mergeUserMessages(a: UserMessage, b: UserMessage): UserMessage {
  const lastContent = normalizeUserTextContent(
    a.message.content as string | ContentBlockParam[],
  )
  const currentContent = normalizeUserTextContent(
    b.message.content as string | ContentBlockParam[],
  )
  return {
    ...a,
    // Preserve the non-meta message's uuid so [id:] tags (derived from uuid)
    // stay stable across API calls (meta messages like system context get fresh uuids each call)
    uuid: a.isMeta ? b.uuid : a.uuid,
    message: {
      ...a.message,
      content: hoistToolResults(joinTextAtSeam(lastContent, currentContent)),
    },
  }
}

/**
 * In thecontent[] list on a UserMessage, tool_result blocks much come first
 * to avoid "tool result must follow tool use" API errors.
 */
function hoistToolResults(content: ContentBlockParam[]): ContentBlockParam[] {
  const toolResults: ContentBlockParam[] = []
  const otherBlocks: ContentBlockParam[] = []

  for (const block of content) {
    if (block.type === 'tool_result') {
      toolResults.push(block)
    } else {
      otherBlocks.push(block)
    }
  }

  return [...toolResults, ...otherBlocks]
}

function normalizeUserTextContent(
  a: string | ContentBlockParam[],
): ContentBlockParam[] {
  if (typeof a === 'string') {
    return [{ type: 'text', text: a }]
  }
  return a
}

/**
 * Concatenate two content block arrays, appending `\n` to a's last text block
 * when the seam is text-text. The API concatenates adjacent text blocks in a
 * user message without a separator, so two queued prompts `"2 + 2"` +
 * `"3 + 3"` would otherwise reach the model as `"2 + 23 + 3"`.
 *
 * Blocks stay separate; the `\n` goes on a's side so no block's startsWith
 * changes — smooshSystemReminderSiblings classifies via
 * `startsWith('<system-reminder>')`, and prepending to b would break that
 * when b is an SR-wrapped attachment.
 */
function joinTextAtSeam(
  a: ContentBlockParam[],
  b: ContentBlockParam[],
): ContentBlockParam[] {
  const lastA = a.at(-1)
  const firstB = b[0]
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    return [...a.slice(0, -1), { ...lastA, text: lastA.text + '\n' }, ...b]
  }
  return [...a, ...b]
}

type ToolResultContentItem = Extract<
  ToolResultBlockParam['content'],
  readonly unknown[]
>[number]

/**
 * Fold content blocks into a tool_result's content. Returns the updated
 * tool_result, or `null` if smoosh is impossible (tool_reference constraint).
 *
 * Valid block types inside tool_result.content per SDK: text, image,
 * search_result, document. All of these smoosh. tool_reference (beta) cannot
 * mix with other types — server ValueError — so we bail with null.
 *
 * - string/undefined content + all-text blocks → string (preserve legacy shape)
 * - array content with tool_reference → null
 * - otherwise → array, with adjacent text merged (notebook.ts idiom)
 */
function smooshIntoToolResult(
  tr: ToolResultBlockParam,
  blocks: ContentBlockParam[],
): ToolResultBlockParam | null {
  if (blocks.length === 0) return tr

  const existing = tr.content
  if (Array.isArray(existing) && existing.some(isToolReferenceBlock)) {
    return null
  }

  // API constraint: is_error tool_results must contain only text blocks.
  // Queued-command siblings can carry images (pasted screenshot) — smooshing
  // those into an error result produces a transcript that 400s on every
  // subsequent call and can't be recovered by /fork. The image isn't lost:
  // it arrives as a proper user turn anyway.
  if (tr.is_error) {
    blocks = blocks.filter(b => b.type === 'text')
    if (blocks.length === 0) return tr
  }

  const allText = blocks.every(b => b.type === 'text')

  // Preserve string shape when existing was string/undefined and all incoming
  // blocks are text — this is the common case (hook reminders into Bash/Read
  // results) and matches the legacy smoosh output shape.
  if (allText && (existing === undefined || typeof existing === 'string')) {
    const joined = [
      (typeof existing === 'string' ? existing : '').trim(),
      ...blocks.map(b => (b as TextBlockParam).text.trim()),
    ]
      .filter(Boolean)
      .join('\n\n')
    return { ...tr, content: joined }
  }

  // General case: normalize to array, concat, merge adjacent text
  const base: ToolResultContentItem[] =
    existing === undefined
      ? []
      : typeof existing === 'string'
        ? existing.trim()
          ? [{ type: 'text', text: existing.trim() }]
          : []
        : [...existing]

  const merged: ToolResultContentItem[] = []
  for (const b of [...base, ...blocks]) {
    if (b.type === 'text') {
      const t = b.text.trim()
      if (!t) continue
      const prev = merged.at(-1)
      if (prev?.type === 'text') {
        merged[merged.length - 1] = { ...prev, text: `${prev.text}\n\n${t}` } // lvalue
      } else {
        merged.push({ type: 'text', text: t })
      }
    } else {
      // image / search_result / document — pass through
      merged.push(b as ToolResultContentItem)
    }
  }

  return { ...tr, content: merged }
}

export function mergeUserContentBlocks(
  a: ContentBlockParam[],
  b: ContentBlockParam[],
): ContentBlockParam[] {
  // See https://anthropic.slack.com/archives/C06FE2FP0Q2/p1747586370117479 and
  // https://anthropic.slack.com/archives/C0AHK9P0129/p1773159663856279:
  // any sibling after tool_result renders as </function_results>\n\nHuman:<...>
  // on the wire. Repeated mid-conversation, this teaches capy to emit Human: at
  // a bare tail → 3-token empty end_turn. A/B (sai-20260310-161901) validated:
  // smoosh into tool_result.content → 92% → 0%.
  const lastBlock = last(a)
  if (lastBlock?.type !== 'tool_result') {
    return [...a, ...b]
  }

  if (!checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_chair_sermon')) {
    // Legacy (ungated) smoosh: only string-content tool_result + all-text
    // siblings → joined string. Matches pre-universal-smoosh behavior on main.
    // The precondition guarantees smooshIntoToolResult hits its string path
    // (no tool_reference bail, string output shape preserved).
    if (
      typeof lastBlock.content === 'string' &&
      b.every(x => x.type === 'text')
    ) {
      const copy = a.slice()
      copy[copy.length - 1] = smooshIntoToolResult(lastBlock, b)!
      return copy
    }
    return [...a, ...b]
  }

  // Universal smoosh (gated): fold all non-tool_result block types (text,
  // image, document, search_result) into tool_result.content. tool_result
  // blocks stay as siblings (hoisted later by hoistToolResults).
  const toSmoosh = b.filter(x => x.type !== 'tool_result')
  const toolResults = b.filter(x => x.type === 'tool_result')
  if (toSmoosh.length === 0) {
    return [...a, ...b]
  }

  const smooshed = smooshIntoToolResult(lastBlock, toSmoosh)
  if (smooshed === null) {
    // tool_reference constraint — fall back to siblings
    return [...a, ...b]
  }

  return [...a.slice(0, -1), smooshed, ...toolResults]
}
