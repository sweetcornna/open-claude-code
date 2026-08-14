import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/index.mjs'
import { readdir, readFile as readFileAsync } from 'fs/promises'
import * as path from 'path'
import { posix, win32 } from 'path'
import { z } from 'zod/v4'
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_EXTRACT_SIZE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from 'src/constants/apiLimits.js'
import { hasBinaryExtension } from 'src/constants/files.js'
import { memoryFreshnessNote } from 'src/memdir/memoryAge.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '@open-claude-code/tool-runtime/featureGate.js'
import { logEvent } from '@open-claude-code/tool-runtime/analytics.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  getFileExtensionForAnalytics,
} from '@open-claude-code/tool-runtime/analytics.js'
import {
  countTokensWithAPI,
  roughTokenCountEstimationForFileType,
} from 'src/services/tokenEstimation.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from 'src/skills/loadSkillsDir.js'
import type { ToolUseContext } from '@open-claude-code/tool-runtime/Tool.js'
import { buildTool, type ToolDef } from '@open-claude-code/tool-runtime/Tool.js'
import { getCwd } from 'src/utils/filesystem/cwd.js'
import {
  getClaudeConfigHomeDir,
  isEnvTruthy,
} from 'src/utils/config/envUtils.js'
import {
  getErrnoCode,
  isENOENT,
} from '@open-claude-code/tool-runtime/errors.js'
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTimeAsync,
  suggestPathUnderCwd,
} from 'src/utils/filesystem/file.js'
import { logFileOperation } from 'src/utils/telemetry/fileOperationAnalytics.js'
import { formatFileSize } from 'src/utils/text/format.js'
import { getFsImplementation } from 'src/utils/filesystem/fsOperations.js'
import {
  compressImageBufferWithTokenLimit,
  createImageMetadataText,
  detectImageFormatFromBuffer,
  type ImageDimensions,
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from 'src/utils/terminal/imageResizer.js'
import { lazySchema } from '@open-claude-code/tool-runtime/lazySchema.js'
import { logError } from 'src/utils/telemetry/log.js'
import { isAutoMemFile } from 'src/utils/memory/memoryFileDetection.js'
import { createUserMessage } from 'src/utils/messages.js'
import {
  mapNotebookCellsToToolResult,
  readNotebook,
} from 'src/utils/filesystem/notebook.js'
import { expandPath } from 'src/utils/filesystem/path.js'
import {
  extractPDFPages,
  getPDFPageCount,
  readPDF,
} from 'src/utils/filesystem/pdf.js'
import {
  isPDFExtension,
  isPDFSupported,
  parsePDFPageRange,
} from 'src/utils/filesystem/pdfUtils.js'
import {
  checkReadPermissionForTool,
  matchingRuleForInput,
} from 'src/utils/permissions/filesystem.js'
import type { PermissionDecision } from '@open-claude-code/tool-runtime/permissions/PermissionResult.js'
import { matchWildcardPattern } from 'src/utils/permissions/shellRuleMatching.js'
import { readFileInRange } from 'src/utils/filesystem/readFileInRange.js'
import { semanticNumber } from 'src/utils/collections/semanticNumber.js'
import { jsonStringify } from '@open-claude-code/tool-runtime/slowOperations.js'
import { BASH_TOOL_NAME } from '../BashTool/constants.js'
import { GREP_TOOL_NAME } from '../GrepTool/constants.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
  LINE_FORMAT_INSTRUCTION,
  OFFSET_INSTRUCTION_DEFAULT,
  OFFSET_INSTRUCTION_TARGETED,
  TRUNCATED_PARTIAL_VIEW_PREFIX,
} from './constants.js'
import { getDefaultFileReadingLimits } from './limits.js'
import { renderPromptTemplate } from './prompt.js'
import { setReadTruncationNotice } from './truncationNotice.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'

// Device files that would hang the process: infinite output or blocking input.
// Checked by path only (no I/O). Safe devices like /dev/null are intentionally omitted.
const BLOCKED_DEVICE_PATHS = new Set([
  // Infinite output — never reach EOF
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // Blocks waiting for input
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // Nonsensical to read
  '/dev/stdout',
  '/dev/stderr',
  // fd aliases for stdin/stdout/stderr
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

const BLOCKED_PROC_FILES = new Set([
  'environ',
  'cmdline',
  'auxv',
  'maps',
  'mem',
  'stat',
])

function blockedSpecialFileReason(filePath: string): string | undefined {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) {
    return 'this device file would block or produce infinite output'
  }
  const normalized = filePath.replaceAll('\\', '/')
  if (!normalized.startsWith('/proc/')) return undefined
  if (
    normalized.endsWith('/fd/0') ||
    normalized.endsWith('/fd/1') ||
    normalized.endsWith('/fd/2')
  ) {
    return 'this device file would block or produce infinite output'
  }
  const segments = normalized.split('/').filter(Boolean)
  if (
    segments[0] === 'proc' &&
    segments.length === 3 &&
    (segments[1] === 'self' || /^\d+$/.test(segments[1] ?? '')) &&
    BLOCKED_PROC_FILES.has(segments[2] ?? '')
  ) {
    return 'this procfs file may expose process secrets or memory'
  }
  return undefined
}

// Narrow no-break space (U+202F) used by some macOS versions in screenshot filenames
const THIN_SPACE = String.fromCharCode(8239)

/**
 * Resolves macOS screenshot paths that may have different space characters.
 * macOS uses either regular space or thin space (U+202F) before AM/PM in screenshot
 * filenames depending on the macOS version. This function tries the alternate space
 * character if the file doesn't exist with the given path.
 *
 * @param filePath - The normalized file path to resolve
 * @returns The path to the actual file on disk (may differ in space character)
 */
/**
 * For macOS screenshot paths with AM/PM, the space before AM/PM may be a
 * regular space or a thin space depending on the macOS version.  Returns
 * the alternate path to try if the original doesn't exist, or undefined.
 */
function getAlternateScreenshotPath(filePath: string): string | undefined {
  const filename = path.basename(filePath)
  const amPmPattern = /^(.+)([ \u202F])(AM|PM)(\.png)$/
  const match = filename.match(amPmPattern)
  if (!match) return undefined

  const currentSpace = match[2]
  const alternateSpace = currentSpace === ' ' ? THIN_SPACE : ' '
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  )
}

// File read listeners - allows other services to be notified when files are read
type FileReadListener = (filePath: string, content: string) => void
const fileReadListeners: FileReadListener[] = []

export function registerFileReadListener(
  listener: FileReadListener,
): () => void {
  fileReadListeners.push(listener)
  return () => {
    const i = fileReadListeners.indexOf(listener)
    if (i >= 0) fileReadListeners.splice(i, 1)
  }
}

export class MaxFileReadTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
  ) {
    super(
      `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'MaxFileReadTokenExceededError'
  }
}

// Common image extensions
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/**
 * Detects if a file path is a session-related file for analytics logging.
 * Only matches files within the Claude config directory (e.g., ~/.claude).
 * Returns the type of session file or null if not a session file.
 */
function detectSessionFileType(
  filePath: string,
): 'session_memory' | 'session_transcript' | null {
  const configDir = getClaudeConfigHomeDir()

  // Only match files within the Claude config directory
  if (!filePath.startsWith(configDir)) {
    return null
  }

  // Normalize path to use forward slashes for consistent matching across platforms
  const normalizedPath = filePath.split(win32.sep).join(posix.sep)

  // Session memory files: ~/.claude/session-memory/*.md (including summary.md)
  if (
    normalizedPath.includes('/session-memory/') &&
    normalizedPath.endsWith('.md')
  ) {
    return 'session_memory'
  }

  // Session JSONL transcript files: ~/.claude/projects/*/*.jsonl
  if (
    normalizedPath.includes('/projects/') &&
    normalizedPath.endsWith('.jsonl')
  ) {
    return 'session_transcript'
  }

  return null
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to read'),
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
    limit: semanticNumber(z.number().int().positive().optional()).describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
    pages: z
      .string()
      .optional()
      .describe(
        `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() => {
  // Define the media types supported for images
  const imageMediaTypes = z.enum([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ])

  return z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      file: z.object({
        filePath: z.string().describe('The path to the file that was read'),
        content: z.string().describe('The content of the file'),
        numLines: z
          .number()
          .describe('Number of lines in the returned content'),
        startLine: z.number().describe('The starting line number'),
        totalLines: z.number().describe('Total number of lines in the file'),
        truncatedByTokenCap: z
          .boolean()
          .optional()
          .describe(
            'True when a whole-file read was auto-paginated because it exceeded the token cap (the content is a partial first page). A programmatic signal for internal consumers; survives output reconstruction (unlike the render-time banner).',
          ),
      }),
    }),
    z.object({
      type: z.literal('image'),
      file: z.object({
        base64: z.string().describe('Base64-encoded image data'),
        type: imageMediaTypes.describe('The MIME type of the image'),
        originalSize: z.number().describe('Original file size in bytes'),
        dimensions: z
          .object({
            originalWidth: z
              .number()
              .optional()
              .describe('Original image width in pixels'),
            originalHeight: z
              .number()
              .optional()
              .describe('Original image height in pixels'),
            displayWidth: z
              .number()
              .optional()
              .describe('Displayed image width in pixels (after resizing)'),
            displayHeight: z
              .number()
              .optional()
              .describe('Displayed image height in pixels (after resizing)'),
          })
          .optional()
          .describe('Image dimension info for coordinate mapping'),
      }),
    }),
    z.object({
      type: z.literal('notebook'),
      file: z.object({
        filePath: z.string().describe('The path to the notebook file'),
        cells: z.array(z.any()).describe('Array of notebook cells'),
      }),
    }),
    z.object({
      type: z.literal('pdf'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        base64: z.string().describe('Base64-encoded PDF data'),
        originalSize: z.number().describe('Original file size in bytes'),
      }),
    }),
    z.object({
      type: z.literal('parts'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        originalSize: z.number().describe('Original file size in bytes'),
        count: z.number().describe('Number of pages extracted'),
        outputDir: z
          .string()
          .describe('Directory containing extracted page images'),
      }),
    }),
    z.object({
      type: z.literal('file_unchanged'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
      }),
    }),
  ])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  searchHint: 'read files, images, PDFs, notebooks',
  // Output is bounded by maxTokens (validateContentTokens). Results exceeding
  // 100KB are persisted to disk (reducing memory pressure in long sessions)
  // rather than kept in the message array indefinitely.
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    const limits = getDefaultFileReadingLimits()
    const maxSizeInstruction = limits.includeMaxSizeInPrompt
      ? `. Files larger than ${formatFileSize(limits.maxSizeBytes)} will return an error; use offset and limit for larger files`
      : ''
    const offsetInstruction = limits.targetedRangeNudge
      ? OFFSET_INSTRUCTION_TARGETED
      : OFFSET_INSTRUCTION_DEFAULT
    return renderPromptTemplate({
      lineFormat: pickLineFormatInstruction(),
      maxSizeInstruction,
      offsetInstruction,
      pdfSupported: isPDFSupported(),
    })
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Reading ${summary}` : 'Reading file'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.file_path
  },
  isSearchOrReadCommand() {
    return { isSearch: false, isRead: true }
  },
  getPath({ file_path }): string {
    return file_path || getCwd()
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      FileReadTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  // UI.tsx:140 — ALL types render summary chrome only: "Read N lines",
  // "Read image (42KB)". Never the content itself. The model-facing
  // serialization (below) sends content + line prefixes; UI shows none of it.
  extractSearchText() {
    return ''
  },
  renderToolUseErrorMessage,
  async validateInput({ file_path, pages }, toolUseContext: ToolUseContext) {
    // Validate pages parameter (pure string parsing, no I/O)
    if (pages !== undefined) {
      const parsed = parsePDFPageRange(pages)
      if (!parsed) {
        return {
          result: false,
          message: `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
          errorCode: 7,
        }
      }
      const rangeSize =
        parsed.lastPage === Infinity
          ? PDF_MAX_PAGES_PER_READ + 1
          : parsed.lastPage - parsed.firstPage + 1
      if (rangeSize > PDF_MAX_PAGES_PER_READ) {
        return {
          result: false,
          message: `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
          errorCode: 8,
        }
      }
    }

    // Path expansion + deny rule check (no I/O)
    const fullFilePath = expandPath(file_path)

    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
      }
    }

    const blockedReason = blockedSpecialFileReason(fullFilePath)
    if (blockedReason) {
      return {
        result: false,
        message: `Cannot read '${file_path}': ${blockedReason}.`,
        errorCode: 9,
      }
    }

    // SECURITY: UNC path check (no I/O) — defer filesystem operations
    // until after user grants permission to prevent NTLM credential leaks
    const isUncPath =
      fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')
    if (isUncPath) {
      return { result: true }
    }

    // 预检：如果路径已是一个存在的目录，及时拒绝并给出指引
    // 避免 AI 模型用 Read 工具读取目录路径时抛出原始 EISDIR 错误，
    // 模型拿到错误后不知该用 ls 列目录，可能做出错误恢复决策。
    try {
      const fileStat = await getFsImplementation().stat(fullFilePath)
      if (fileStat.isDirectory()) {
        return {
          result: false,
          message: `Cannot read '${file_path}': the specified path is an existing directory. Use Bash ls to list files in this directory, or specify a filename path to read a specific file.`,
          errorCode: 10,
        }
      }
    } catch (e) {
      if (!isENOENT(e)) throw e
      // ENOENT = 文件还不存在，放行，call() 会通过 findSimilarFile 给出友好建议
    }

    // Binary extension check (string check on extension only, no I/O).
    // PDF, images, and SVG are excluded - this tool renders them natively.
    const ext = path.extname(fullFilePath).toLowerCase()
    if (
      hasBinaryExtension(fullFilePath) &&
      !isPDFExtension(ext) &&
      !IMAGE_EXTENSIONS.has(ext.slice(1))
    ) {
      return {
        result: false,
        message: `This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.`,
        errorCode: 4,
      }
    }

    return { result: true }
  },
  async call(
    { file_path, offset = 1, limit = undefined, pages },
    context,
    _canUseTool?,
    parentMessage?,
  ) {
    const { readFileState, fileReadingLimits } = context

    const defaults = getDefaultFileReadingLimits()
    const maxSizeBytes =
      fileReadingLimits?.maxSizeBytes ?? defaults.maxSizeBytes
    const maxTokens = fileReadingLimits?.maxTokens ?? defaults.maxTokens

    // Telemetry: track when callers override default read limits.
    // Only fires on override (low volume) — event count = override frequency.
    if (fileReadingLimits !== undefined) {
      logEvent('tengu_file_read_limits_override', {
        hasMaxTokens: fileReadingLimits.maxTokens !== undefined,
        hasMaxSizeBytes: fileReadingLimits.maxSizeBytes !== undefined,
      })
    }

    const ext = path.extname(file_path).toLowerCase().slice(1)
    // Use expandPath for consistent path normalization with FileEditTool/FileWriteTool
    // (especially handles whitespace trimming and Windows path separators)
    const fullFilePath = expandPath(file_path)

    // Dedup: if we've already read this exact range and the file hasn't
    // changed on disk, return a stub instead of re-sending the full content.
    // The earlier Read tool_result is still in context — two full copies
    // waste cache_creation tokens on every subsequent turn. BQ proxy shows
    // ~18% of Read calls are same-file collisions (up to 2.64% of fleet
    // cache_creation). Only applies to text/notebook reads — images/PDFs
    // aren't cached in readFileState so won't match here.
    //
    // Ant soak: 1,734 dedup hits in 2h, no Read error regression.
    // Killswitch pattern: GB can disable if the stub message confuses
    // the model externally.
    // 3P default: killswitch off = dedup enabled. Client-side only — no
    // server support needed, safe for Bedrock/Vertex/Foundry.
    const dedupKillswitch = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_read_dedup_killswitch',
      false,
    )
    const existingState = dedupKillswitch
      ? undefined
      : readFileState.get(fullFilePath)
    // Only dedup entries that came from a prior Read (offset is always set
    // by Read). Edit/Write store offset=undefined — their readFileState
    // entry reflects post-edit mtime, so deduping against it would wrongly
    // point the model at the pre-edit Read content.
    if (
      existingState &&
      !existingState.isPartialView &&
      existingState.offset !== undefined
    ) {
      const rangeMatch =
        existingState.offset === offset && existingState.limit === limit
      if (rangeMatch) {
        try {
          const mtimeMs = await getFileModificationTimeAsync(fullFilePath)
          if (mtimeMs === existingState.timestamp) {
            const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
            logEvent('tengu_file_read_dedup', {
              ...(analyticsExt !== undefined && { ext: analyticsExt }),
            })
            return {
              data: {
                type: 'file_unchanged' as const,
                file: { filePath: file_path },
              },
            }
          }
        } catch {
          // stat failed — fall through to full read
        }
      }
    }

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          context.dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([fullFilePath], cwd)
    }

    try {
      return await callInner(
        file_path,
        fullFilePath,
        fullFilePath,
        ext,
        offset,
        limit,
        pages,
        maxSizeBytes,
        maxTokens,
        readFileState,
        context,
        parentMessage?.message.id,
      )
    } catch (error) {
      // Handle file-not-found: suggest similar files
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        // macOS screenshots may use a thin space or regular space before
        // AM/PM — try the alternate before giving up.
        const altPath = getAlternateScreenshotPath(fullFilePath)
        if (altPath) {
          try {
            return await callInner(
              file_path,
              fullFilePath,
              altPath,
              ext,
              offset,
              limit,
              pages,
              maxSizeBytes,
              maxTokens,
              readFileState,
              context,
              parentMessage?.message.id,
            )
          } catch (altError) {
            if (!isENOENT(altError)) {
              throw altError
            }
            // Alt path also missing — fall through to friendly error
          }
        }

        const similarFilename = findSimilarFile(fullFilePath)
        const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
        let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
        if (cwdSuggestion) {
          message += ` Did you mean ${cwdSuggestion}?`
        } else if (similarFilename) {
          message += ` Did you mean ${similarFilename}?`
        }
        throw new Error(message)
      }
      throw error
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    switch (data.type) {
      case 'image': {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                data: data.file.base64,
                media_type: data.file.type,
              },
            },
          ],
        }
      }
      case 'notebook':
        return mapNotebookCellsToToolResult(data.file.cells, toolUseID)
      case 'pdf':
        // Return PDF metadata only - the actual content is sent as a supplemental DocumentBlockParam
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `PDF file read: ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
        }
      case 'parts':
        // Extracted page images are read and sent as image blocks in mapToolResultToAPIMessage
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `PDF pages extracted: ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
        }
      case 'file_unchanged':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: FILE_UNCHANGED_STUB,
        }
      case 'text': {
        let content: string

        if (data.file.content) {
          content = memoryFileFreshnessPrefix(data) + formatFileLines(data.file)
        } else {
          // Determine the appropriate warning message
          content =
            data.file.totalLines === 0
              ? '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
              : `<system-reminder>Warning: the file exists but is shorter than the provided offset (${data.file.startLine}). The file has ${data.file.totalLines} lines.</system-reminder>`
        }

        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content,
        }
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function pickLineFormatInstruction(): string {
  return LINE_FORMAT_INSTRUCTION
}

/** Format file content with line numbers. */
function formatFileLines(file: { content: string; startLine: number }): string {
  return addLineNumbers(file)
}

/**
 * Side-channel from call() to mapToolResultToToolResultBlockParam: mtime
 * of auto-memory files, keyed by the `data` object identity. Avoids
 * adding a presentation-only field to the output schema (which flows
 * into SDK types) and avoids sync fs in the mapper. WeakMap auto-GCs
 * when the data object becomes unreachable after rendering.
 */
const memoryFileMtimes = new WeakMap<object, number>()

function memoryFileFreshnessPrefix(data: object): string {
  const mtimeMs = memoryFileMtimes.get(data)
  if (mtimeMs === undefined) return ''
  return memoryFreshnessNote(mtimeMs)
}

function countNewlines(text: string): number {
  let count = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    count++
  }
  return count
}

type OversizedReadPage = {
  content: string
  numLines: number
  banner: string
}

/**
 * Converge on a first page that fits under `maxTokens`, for a whole-file read
 * whose content blew the cap.
 *
 * Why iterate instead of computing once: the only token signal available here
 * is `tokenCount` for the WHOLE content, so the chars-per-token ratio is
 * measured on this specific file (CJK, minified JS and ASCII source differ by
 * several times) and the first guess is deliberately conservative (x0.85).
 * Six x0.7 shrinks bound the loop — no re-tokenization happens, so a wrong
 * guess costs nothing but a slice.
 *
 * The char-slice fallback exists for files that are one enormous line
 * (bundles, minified assets, single-line JSON): line-based paging cannot make
 * those smaller, and returning an empty page would be worse than an
 * unaligned excerpt.
 */
function paginateOversizedRead(
  content: string,
  totalLines: number,
  maxTokens: number,
  tokenCount: number,
  displayPath: string,
): OversizedReadPage {
  const lines = content.split('\n')
  // Floor at 0.5 so a pathological ratio can never let the estimator hand back
  // a slice larger than the input it is trying to shrink.
  const charsPerToken = Math.max(0.5, content.length / Math.max(1, tokenCount))
  const estimateTokens = (text: string): number => text.length / charsPerToken

  let keptLines = Math.max(
    1,
    Math.min(
      lines.length,
      Math.floor(((lines.length * maxTokens) / Math.max(1, tokenCount)) * 0.85),
    ),
  )
  let page = lines.slice(0, keptLines).join('\n')
  for (let attempt = 0; attempt < 6; attempt++) {
    if (estimateTokens(page) <= maxTokens || keptLines <= 1) break
    keptLines = Math.max(1, Math.floor(keptLines * 0.7))
    page = lines.slice(0, keptLines).join('\n')
  }

  let slicedByChars = false
  if (estimateTokens(page) > maxTokens || page.trim() === '') {
    let chars = Math.max(1, Math.floor(maxTokens * charsPerToken * 0.85))
    for (let attempt = 0; attempt < 6; attempt++) {
      page = content.slice(0, chars)
      if (estimateTokens(page) <= maxTokens) break
      chars = Math.max(1, Math.floor(chars * 0.7))
    }
    // Never end on a lone high surrogate: it would render as U+FFFD and
    // corrupt the last character the model sees.
    const lastCode = page.charCodeAt(page.length - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) page = page.slice(0, -1)
    slicedByChars = true
  }

  const numLines = slicedByChars ? countNewlines(page) + 1 : keptLines
  const banner =
    !slicedByChars && numLines < totalLines
      ? `${TRUNCATED_PARTIAL_VIEW_PREFIX}${displayPath}: showing lines 1-${numLines} of ${totalLines} total (${tokenCount} tokens, cap ${maxTokens}). Call ${FILE_READ_TOOL_NAME} with offset=${numLines + 1} limit=${numLines} for the next page, or ${GREP_TOOL_NAME} to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]`
      : `${TRUNCATED_PARTIAL_VIEW_PREFIX}${displayPath}: showing the first ${page.length} of ${content.length} characters (${tokenCount} tokens, cap ${maxTokens}); this file has very long lines and cannot be paginated by line. Use ${GREP_TOOL_NAME} to find a specific section, or ${FILE_READ_TOOL_NAME} with offset/limit to page through it. Do NOT answer from this excerpt alone if the answer may be elsewhere in the file.]`

  return { content: page, numLines, banner }
}

async function validateContentTokens(
  content: string,
  ext: string,
  maxTokens?: number,
): Promise<void> {
  const effectiveMaxTokens =
    maxTokens ?? getDefaultFileReadingLimits().maxTokens

  // Fast rejection: if raw byte count exceeds 4x the token limit,
  // no encoding can possibly fit (worst case is ~4 bytes/token).
  const byteLength = Buffer.byteLength(content)
  if (byteLength > effectiveMaxTokens * 4) {
    throw new MaxFileReadTokenExceededError(
      Math.ceil(byteLength / 4),
      effectiveMaxTokens,
    )
  }

  const tokenEstimate = roughTokenCountEstimationForFileType(content, ext)
  if (!tokenEstimate || tokenEstimate <= effectiveMaxTokens / 4) return

  const tokenCount = await countTokensWithAPI(content)
  const effectiveCount = tokenCount ?? tokenEstimate

  if (effectiveCount > effectiveMaxTokens) {
    throw new MaxFileReadTokenExceededError(effectiveCount, effectiveMaxTokens)
  }
}

type ImageResult = {
  type: 'image'
  file: {
    base64: string
    type: Base64ImageSource['media_type']
    originalSize: number
    dimensions?: ImageDimensions
  }
}

function createImageResponse(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
  dimensions?: ImageDimensions,
): ImageResult {
  return {
    type: 'image',
    file: {
      base64: buffer.toString('base64'),
      type: `image/${mediaType}` as Base64ImageSource['media_type'],
      originalSize,
      dimensions,
    },
  }
}

/**
 * Inner implementation of call, separated to allow ENOENT handling in the outer call.
 */
async function callInner(
  file_path: string,
  fullFilePath: string,
  resolvedFilePath: string,
  ext: string,
  offset: number,
  limit: number | undefined,
  pages: string | undefined,
  maxSizeBytes: number,
  maxTokens: number,
  readFileState: ToolUseContext['readFileState'],
  context: ToolUseContext,
  messageId: string | undefined,
): Promise<{
  data: Output
  newMessages?: ReturnType<typeof createUserMessage>[]
}> {
  // --- Notebook ---
  if (ext === 'ipynb') {
    const cells = await readNotebook(resolvedFilePath)
    const cellsJson = jsonStringify(cells)

    const cellsJsonBytes = Buffer.byteLength(cellsJson)
    if (cellsJsonBytes > maxSizeBytes) {
      throw new Error(
        `Notebook content (${formatFileSize(cellsJsonBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). ` +
          `Use ${BASH_TOOL_NAME} with jq to read specific portions:\n` +
          `  cat "${file_path}" | jq '.cells[:20]' # First 20 cells\n` +
          `  cat "${file_path}" | jq '.cells[100:120]' # Cells 100-120\n` +
          `  cat "${file_path}" | jq '.cells | length' # Count total cells\n` +
          `  cat "${file_path}" | jq '.cells[] | select(.cell_type=="code") | .source' # All code sources`,
      )
    }

    await validateContentTokens(cellsJson, ext, maxTokens)

    // Get mtime via async stat (single call, no prior existence check)
    const stats = await getFsImplementation().stat(resolvedFilePath)
    readFileState.set(fullFilePath, {
      content: cellsJson,
      timestamp: Math.floor(stats.mtimeMs),
      offset,
      limit,
    })
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    const data = {
      type: 'notebook' as const,
      file: { filePath: file_path, cells },
    }

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: cellsJson,
    })

    return { data }
  }

  // --- Image (single read, no double-read) ---
  if (IMAGE_EXTENSIONS.has(ext)) {
    // Images have their own size limits (token budget + compression) —
    // don't apply the text maxSizeBytes cap.
    const data = await readImageWithTokenBudget(resolvedFilePath, maxTokens)
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: data.file.base64,
    })

    const metadataText = data.file.dimensions
      ? createImageMetadataText(data.file.dimensions)
      : null

    return {
      data,
      ...(metadataText && {
        newMessages: [
          createUserMessage({ content: metadataText, isMeta: true }),
        ],
      }),
    }
  }

  // --- PDF ---
  if (isPDFExtension(ext)) {
    if (pages) {
      const parsedRange = parsePDFPageRange(pages)
      const extractResult = await extractPDFPages(
        resolvedFilePath,
        parsedRange ?? undefined,
      )
      if (!extractResult.success) {
        throw new Error((extractResult as any).error.message)
      }
      logEvent('tengu_pdf_page_extraction', {
        success: true,
        pageCount: (extractResult as any).data.file.count,
        fileSize: extractResult.data.file.originalSize,
        hasPageRange: true,
      })
      logFileOperation({
        operation: 'read',
        tool: 'FileReadTool',
        filePath: fullFilePath,
        content: `PDF pages ${pages}`,
      })
      const entries = await readdir(extractResult.data.file.outputDir)
      const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
      const imageBlocks = await Promise.all(
        imageFiles.map(async f => {
          const imgPath = path.join(extractResult.data.file.outputDir, f)
          const imgBuffer = await readFileAsync(imgPath)
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imgBuffer,
            imgBuffer.length,
            'jpeg',
          )
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type:
                `image/${resized.mediaType}` as Base64ImageSource['media_type'],
              data: resized.buffer.toString('base64'),
            },
          }
        }),
      )
      return {
        data: extractResult.data,
        ...(imageBlocks.length > 0 && {
          newMessages: [
            createUserMessage({ content: imageBlocks, isMeta: true }),
          ],
        }),
      }
    }

    const pageCount = await getPDFPageCount(resolvedFilePath)
    if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      throw new Error(
        `This PDF has ${pageCount} pages, which is too many to read at once. ` +
          `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
          `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      )
    }

    const fs = getFsImplementation()
    const stats = await fs.stat(resolvedFilePath)
    const shouldExtractPages =
      !isPDFSupported() || stats.size > PDF_EXTRACT_SIZE_THRESHOLD

    if (shouldExtractPages) {
      const extractResult = await extractPDFPages(resolvedFilePath)
      if (extractResult.success) {
        logEvent('tengu_pdf_page_extraction', {
          success: true,
          pageCount: extractResult.data.file.count,
          fileSize: extractResult.data.file.originalSize,
        })
      } else {
        logEvent('tengu_pdf_page_extraction', {
          success: false,
          available: (extractResult as any).error.reason !== 'unavailable',
          fileSize: stats.size,
        })
      }
    }

    if (!isPDFSupported()) {
      throw new Error(
        'Reading full PDFs is not supported with this model. Use a newer model (Sonnet 3.5 v2 or later), ' +
          `or use the pages parameter to read specific page ranges (e.g., pages: "1-5", maximum ${PDF_MAX_PAGES_PER_READ} pages per request). ` +
          'Page extraction requires poppler-utils: install with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian/Ubuntu.',
      )
    }

    const readResult = await readPDF(resolvedFilePath)
    if (!readResult.success) {
      throw new Error((readResult as any).error.message)
    }
    const pdfData = readResult.data
    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: pdfData.file.base64,
    })

    return {
      data: pdfData,
      newMessages: [
        createUserMessage({
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfData.file.base64,
              },
            },
          ],
          isMeta: true,
        }),
      ],
    }
  }

  // --- Text file (single async read via readFileInRange) ---
  const lineOffset = offset === 0 ? 0 : offset - 1
  const { content, lineCount, totalLines, totalBytes, readBytes, mtimeMs } =
    await readFileInRange(
      resolvedFilePath,
      lineOffset,
      limit,
      limit === undefined ? maxSizeBytes : undefined,
      context.abortController.signal,
    )

  // A whole-file read that blows the TOKEN cap is auto-paginated rather than
  // thrown: converge on a first page that fits, hand it back, and tell the
  // model in the same turn how to request page 2. Throwing here instead makes
  // the model guess an offset/limit it has no information for, and it
  // routinely guesses wrong or gives up.
  //
  // Ranged reads (explicit offset/limit) and `pages` still throw — the model
  // chose that range, so the error is actionable, and a ~100-byte error
  // tool-result is far cheaper than a capped page. NOTE this is a different
  // axis from the #21841 revert documented in limits.ts, which is about the
  // BYTE cap on explicit-limit reads; that path is untouched.
  const isWholeFileRead =
    offset <= 1 && limit === undefined && pages === undefined
  let pageContent = content
  let pageLineCount = lineCount
  let pageLimit = limit
  let truncationBanner: string | undefined
  try {
    await validateContentTokens(content, ext, maxTokens)
  } catch (error) {
    if (!(error instanceof MaxFileReadTokenExceededError) || !isWholeFileRead) {
      throw error
    }
    const page = paginateOversizedRead(
      content,
      totalLines,
      maxTokens,
      error.tokenCount,
      fullFilePath,
    )
    pageContent = page.content
    pageLineCount = page.numLines
    pageLimit = page.numLines
    truncationBanner = page.banner
  }

  readFileState.set(fullFilePath, {
    content: pageContent,
    timestamp: Math.floor(mtimeMs),
    offset,
    limit: pageLimit,
    // The model has only seen page 1. `isPartialView` both exempts the next
    // Read of this file from the FILE_UNCHANGED_STUB dedup (which would
    // otherwise hide page 2 behind "file unchanged") and forces Edit/Write to
    // do a real Read first.
    ...(truncationBanner !== undefined && { isPartialView: true }),
  })
  context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

  // Snapshot before iterating — a listener that unsubscribes mid-callback
  // would splice the live array and skip the next listener.
  for (const listener of fileReadListeners.slice()) {
    listener(resolvedFilePath, pageContent)
  }

  const data = {
    type: 'text' as const,
    file: {
      filePath: file_path,
      content: pageContent,
      numLines: pageLineCount,
      startLine: truncationBanner !== undefined ? Math.max(1, offset) : offset,
      totalLines,
      ...(truncationBanner !== undefined && { truncatedByTokenCap: true }),
    },
  }
  if (isAutoMemFile(fullFilePath)) {
    memoryFileMtimes.set(data, mtimeMs)
  }
  if (truncationBanner !== undefined) {
    setReadTruncationNotice(data, truncationBanner)
  }

  logFileOperation({
    operation: 'read',
    tool: 'FileReadTool',
    filePath: fullFilePath,
    content: pageContent,
  })

  const sessionFileType = detectSessionFileType(fullFilePath)
  const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
  logEvent('tengu_session_file_read', {
    totalLines,
    readLines: pageLineCount,
    totalBytes,
    readBytes:
      truncationBanner !== undefined
        ? Buffer.byteLength(pageContent, 'utf8')
        : readBytes,
    offset,
    ...(limit !== undefined && { limit }),
    ...(analyticsExt !== undefined && { ext: analyticsExt }),
    ...(messageId !== undefined && {
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    is_session_memory: sessionFileType === 'session_memory',
    is_session_transcript: sessionFileType === 'session_transcript',
  })

  return { data }
}

/**
 * Reads an image file and applies token-based compression if needed.
 * Reads the file ONCE, then applies standard resize. If the result exceeds
 * the token limit, applies aggressive compression from the same buffer.
 *
 * @param filePath - Path to the image file
 * @param maxTokens - Maximum token budget for the image
 * @returns Image data with appropriate compression applied
 */
export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number = getDefaultFileReadingLimits().maxTokens,
  maxBytes?: number,
): Promise<ImageResult> {
  // Read file ONCE — capped to maxBytes to avoid OOM on huge files
  const imageBuffer = await getFsImplementation().readFileBytes(
    filePath,
    maxBytes,
  )
  const originalSize = imageBuffer.length

  if (originalSize === 0) {
    throw new Error(`Image file is empty: ${filePath}`)
  }

  const detectedMediaType = detectImageFormatFromBuffer(imageBuffer)
  const detectedFormat = detectedMediaType.split('/')[1] || 'png'

  // Try standard resize
  let result: ImageResult
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      originalSize,
      detectedFormat,
    )
    result = createImageResponse(
      resized.buffer,
      resized.mediaType,
      originalSize,
      resized.dimensions,
    )
  } catch (e) {
    if (e instanceof ImageResizeError) throw e
    logError(e)
    result = createImageResponse(imageBuffer, detectedFormat, originalSize)
  }

  // Check if it fits in token budget
  const estimatedTokens = Math.ceil(result.file.base64.length * 0.125)
  if (estimatedTokens > maxTokens) {
    // Aggressive compression from the SAME buffer (no re-read)
    try {
      const compressed = await compressImageBufferWithTokenLimit(
        imageBuffer,
        maxTokens,
        detectedMediaType,
      )
      return {
        type: 'image',
        file: {
          base64: compressed.base64,
          type: compressed.mediaType,
          originalSize,
        },
      }
    } catch (e) {
      logError(e)
      // Fallback: heavily compressed version from the SAME buffer
      try {
        const sharpModule = await import('sharp')
        const sharp =
          (
            sharpModule as unknown as {
              default?: typeof sharpModule
            } & typeof sharpModule
          ).default || sharpModule

        const fallbackBuffer = await (sharp as any)(imageBuffer)
          .resize(400, 400, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 20 })
          .toBuffer()

        return createImageResponse(fallbackBuffer, 'jpeg', originalSize)
      } catch (error) {
        logError(error)
        return createImageResponse(imageBuffer, detectedFormat, originalSize)
      }
    }
  }

  return result
}
