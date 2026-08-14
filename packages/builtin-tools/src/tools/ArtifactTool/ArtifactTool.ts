import { stat, readFile } from 'fs/promises'
import { z } from 'zod/v4'
import type { ToolResultBlockParam } from '@open-claude-code/tool-runtime/Tool.js'
import { buildTool } from '@open-claude-code/tool-runtime/Tool.js'
import { lazySchema } from '@open-claude-code/tool-runtime/lazySchema.js'
import {
  ARTIFACT_TOOL_NAME,
  describeArtifactTool,
  getArtifactToolPrompt,
} from './prompt.js'
import { isLocalArtifactUrl } from './localStore.js'
import { markdownToHtml } from './markdown.js'
import { getArtifactStore } from './store.js'
import { renderToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe(
        'Absolute path to a local HTML (.html/.htm) or Markdown (.md/.markdown) file. Markdown is converted to a self-contained HTML page first.',
      ),
    hash: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/, 'must match ^[A-Za-z0-9_-]{1,128}$')
      .optional()
      .describe(
        'Overwrite the artifact with this id in place, keeping its URL stable; omit for a new random id. Supported by the local and worker backends; rustypaste rejects it.',
      ),
    ttl: z
      .union([z.literal(7), z.literal(30)])
      .default(7)
      .describe(
        'Lifetime in days (7 or 30) for the worker and rustypaste backends. Ignored by the local backend, which never expires artifacts.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type ArtifactInput = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    url: z.string(),
    expiresAt: z.string(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ArtifactOutput = z.infer<OutputSchema>

export const ArtifactTool = buildTool({
  name: ARTIFACT_TOOL_NAME,
  searchHint:
    'artifact html markdown render page save local file open browser share upload publish cloud report dashboard url link',
  maxResultSizeChars: 2_000,
  shouldDefer: true,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  async description() {
    return describeArtifactTool()
  },
  async prompt() {
    return getArtifactToolPrompt()
  },

  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  requiresUserInteraction() {
    return true
  },
  userFacingName() {
    return 'Artifact'
  },

  renderToolUseMessage(input: Partial<ArtifactInput>) {
    const hashPart = input.hash ? ` (hash=${input.hash})` : ''
    return `Artifact: ${input.file_path ?? '...'}${hashPart}`
  },

  mapToolResultToToolResultBlockParam(
    content: ArtifactOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    if (content.error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        is_error: true,
        content: content.error,
      }
    }
    const expiry = content.expiresAt ? `, expires: ${content.expiresAt}` : ''
    // "uploaded" would be a lie for the local backend, and the model needs to
    // know whether it may hand this URL to someone else.
    const verb = isLocalArtifactUrl(content.url)
      ? 'Artifact saved locally'
      : 'Artifact uploaded'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${verb}: ${content.url} (id: ${content.id}${expiry})`,
    }
  },
  renderToolResultMessage,

  async call(input: ArtifactInput) {
    const { file_path, hash, ttl } = input

    let size: number
    try {
      const fileStat = await stat(file_path)
      if (!fileStat.isFile()) {
        return {
          data: {
            id: '',
            url: '',
            expiresAt: '',
            error: `Path is not a regular file: ${file_path}`,
          },
        }
      }
      size = fileStat.size
    } catch {
      return {
        data: {
          id: '',
          url: '',
          expiresAt: '',
          error: `File does not exist or is not readable: ${file_path}`,
        },
      }
    }

    if (size > 10 * 1024 * 1024) {
      return {
        data: {
          id: '',
          url: '',
          expiresAt: '',
          error: `File is ${size} bytes; the artifact size limit is 10MB.`,
        },
      }
    }

    let rawContent: string
    try {
      rawContent = await readFile(file_path, 'utf8')
    } catch {
      return {
        data: {
          id: '',
          url: '',
          expiresAt: '',
          error: `Failed to read file: ${file_path}`,
        },
      }
    }

    const lowerPath = file_path.toLowerCase()
    let html: string
    if (lowerPath.endsWith('.html') || lowerPath.endsWith('.htm')) {
      html = rawContent
    } else if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')) {
      html = markdownToHtml(rawContent, file_path)
    } else {
      return {
        data: {
          id: '',
          url: '',
          expiresAt: '',
          error: `Unsupported file extension. Accepted: .html, .htm, .md, .markdown — got: ${file_path}`,
        },
      }
    }

    try {
      const result = await getArtifactStore().upload({
        html,
        hash,
        ttlDays: ttl,
      })
      return { data: { ...result, expiresAt: result.expiresAt ?? '' } }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { data: { id: '', url: '', expiresAt: '', error: message } }
    }
  },
})
