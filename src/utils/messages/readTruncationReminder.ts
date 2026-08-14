/**
 * Re-deriving the "you only saw page 1" banner for a Read that the token cap
 * truncated, when the live-session banner is no longer in the transcript.
 *
 * Why this is needed at all: the live banner rides a `read_truncation_notice`
 * ATTACHMENT (see toolExecution.ts), and `isLoggableMessage` drops every
 * attachment from the persisted transcript for non-ant users. The durable half
 * of the signal — `toolUseResult.file.truncatedByTokenCap` — does survive,
 * because tool results are written pre-strip. So after `--resume` the model
 * sees a partial first page of a large file with nothing marking it as
 * partial, and can answer confidently from content that stops a third of the
 * way down. Upstream fixes this in its API normalization pass; this is the
 * same fix.
 *
 * Reconstructed, not replayed: the original banner text (exact token counts,
 * caps, suggested offset/limit) is render-time-only and was never persisted.
 * Only `filePath`/`numLines`/`totalLines` come back, so the reconstruction is
 * deliberately shorter than the live banner and says the same thing.
 */
import { TRUNCATED_PARTIAL_VIEW_PREFIX } from '@open-claude-code/builtin-tools/tools/FileReadTool/constants.js'
import type { Message } from '../../types/message.js'

type TruncatedFile = {
  filePath: string
  numLines?: number
  totalLines?: number
}

function truncatedFileOf(message: Message): TruncatedFile | undefined {
  const file = (
    message as {
      toolUseResult?: { file?: Record<string, unknown> }
    }
  ).toolUseResult?.file
  if (!file || file.truncatedByTokenCap !== true) return undefined
  if (typeof file.filePath !== 'string') return undefined
  return {
    filePath: file.filePath,
    numLines: typeof file.numLines === 'number' ? file.numLines : undefined,
    totalLines:
      typeof file.totalLines === 'number' ? file.totalLines : undefined,
  }
}

/** Does any text block in this message already carry a truncation banner? */
function carriesTruncationBanner(message: Message): boolean {
  const content = message.message?.content
  if (typeof content === 'string') {
    return content.includes(TRUNCATED_PARTIAL_VIEW_PREFIX)
  }
  if (!Array.isArray(content)) return false
  return content.some(
    block =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string' &&
      (block as { text: string }).text.includes(TRUNCATED_PARTIAL_VIEW_PREFIX),
  )
}

function bannerFor(file: TruncatedFile): string {
  return file.numLines !== undefined &&
    file.totalLines !== undefined &&
    file.numLines < file.totalLines
    ? `${TRUNCATED_PARTIAL_VIEW_PREFIX}${file.filePath}: showing ${file.numLines} of ${file.totalLines} lines. Read it again with offset/limit to page through. Do NOT answer from this page alone if the answer may be further in the file.]`
    : `${TRUNCATED_PARTIAL_VIEW_PREFIX}${file.filePath}: this view is incomplete and the file cannot be paginated by line. Do NOT answer from this view alone if the answer may be elsewhere in the file.]`
}

/**
 * Message uuid → banner, for every truncated Read in `messages` whose banner
 * is missing.
 *
 * Three ways a banner can already be present, all of which must suppress the
 * reconstruction — the model must not be told twice, and this pass runs on
 * every request:
 *
 *  1. a live `read_truncation_notice` attachment for the same tool_use_id,
 *  2. the reconstruction from an earlier pass, which lands as a text block on
 *     the tool_result message itself and is therefore visible here,
 *  3. a banner spliced into the tool_result content by any other path.
 *
 * (2) is what makes this idempotent: normalization output flows back through
 * normalization on the next request.
 */
export function collectMissingReadTruncationBanners(
  messages: readonly Message[],
): Map<string, string> {
  const banners = new Map<string, string>()

  // Cheap pre-pass: the overwhelmingly common case is a transcript with no
  // truncated reads at all, and then there is nothing to scan for.
  let hasTruncatedRead = false
  for (const message of messages) {
    if (truncatedFileOf(message) !== undefined) {
      hasTruncatedRead = true
      break
    }
  }
  if (!hasTruncatedRead) return banners

  const notifiedToolUseIds = new Set<string>()
  for (const message of messages) {
    if (
      message.type === 'attachment' &&
      message.attachment?.type === 'read_truncation_notice' &&
      message.attachment.toolUseID !== undefined
    ) {
      notifiedToolUseIds.add(message.attachment.toolUseID)
    }
  }

  for (const message of messages) {
    const file = truncatedFileOf(message)
    if (file === undefined) continue
    if (carriesTruncationBanner(message)) continue

    const content = message.message?.content
    const toolResult = Array.isArray(content)
      ? content.find(
          block =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        )
      : undefined
    // No tool_result block means nothing anchors the banner to a Read; the
    // durable flag alone is not enough to know what the model is looking at.
    if (!toolResult) continue
    const toolUseId = (toolResult as { tool_use_id?: unknown }).tool_use_id
    if (typeof toolUseId !== 'string') continue
    if (notifiedToolUseIds.has(toolUseId)) continue

    banners.set(message.uuid, bannerFor(file))
  }

  return banners
}
