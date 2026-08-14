import { basename } from 'path'
import type { Message } from 'src/types/message.js'

export type ArtifactInfo = {
  toolUseId: string
  filePath: string
  basename: string
  hash?: string
  url?: string
  expiresAt?: string
  rawContent: string
  isError: boolean
}

// `file:` is here because the local backend is the default: an artifact that
// was never uploaded still has a URL, and without this branch the panel showed
// a blank URL column and neither `o` (open) nor `c` (copy) did anything for
// the backend most users are on.
//
// The alternation is scheme-first and the file: arm excludes `)"',` the same
// way, so a `file:///…/a b.html` path with a space still truncates at the
// space — matching how the tool prints it (pathToFileURL percent-encodes).
const URL_REGEX = /(?:https?|file):\/\/[^\s)"',]+\.html\b/
const ID_REGEX = /\bid:\s*([A-Za-z0-9_-]+)/
const EXPIRES_REGEX = /\bexpires:\s*([0-9T:.Z+-]+)/

export function extractArtifacts(messages: Message[]): ArtifactInfo[] {
  const results: ArtifactInfo[] = []

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      if (!('type' in block)) continue
      const b = block as unknown as Record<string, unknown>
      if (b.type !== 'tool_use') continue
      if (b.name !== 'artifact') continue

      const toolUseId = b.id as string
      const input = b.input as { file_path?: string } | undefined
      const filePath = input?.file_path ?? '<unknown>'

      const resultBlock = findToolResult(messages, toolUseId)
      if (!resultBlock) continue

      const rawContent =
        typeof resultBlock.content === 'string'
          ? resultBlock.content
          : Array.isArray(resultBlock.content)
            ? resultBlock.content
                .map(c =>
                  typeof c === 'string'
                    ? c
                    : 'text' in c
                      ? (c as { text: string }).text
                      : '',
                )
                .join('')
            : ''

      const isError = resultBlock.is_error === true
      const urlMatch = rawContent.match(URL_REGEX)
      const idMatch = rawContent.match(ID_REGEX)
      const expiresMatch = rawContent.match(EXPIRES_REGEX)

      results.push({
        toolUseId,
        filePath,
        basename: basename(filePath),
        hash: idMatch?.[1],
        url: urlMatch?.[0],
        expiresAt: expiresMatch?.[1],
        rawContent,
        isError,
      })
    }
  }

  // newest first
  return results.reverse()
}

function findToolResult(
  messages: Message[],
  toolUseId: string,
): { content: unknown; is_error?: boolean } | null {
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      if (!('type' in block)) continue
      const b = block as unknown as Record<string, unknown>
      if (b.type !== 'tool_result') continue
      if (b.tool_use_id !== toolUseId) continue
      return { content: b.content, is_error: b.is_error as boolean | undefined }
    }
  }
  return null
}
