import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import {
  FileReadTool,
  MaxFileReadTokenExceededError,
} from '@open-claude-code/builtin-tools/tools/FileReadTool/FileReadTool.js'
import { FileTooLargeError } from '../readFileInRange.js'
import { countCharInString } from '../text/stringUtils.js'
import { getFsImplementation } from '../fsOperations.js'
import { parse, relative } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { getDefaultFileReadingLimits } from '@open-claude-code/builtin-tools/tools/FileReadTool/limits.js'
import {
  getFileModificationTimeAsync,
  isFileWithinReadSizeLimit,
} from '../file.js'
import { isPDFExtension } from '../pdfUtils.js'
import { getPDFPageCount } from '../pdf.js'
import { PDF_AT_MENTION_INLINE_THRESHOLD } from '../../constants/apiLimits.js'
import { matchingRuleForInput } from '../permissions/filesystem.js'
import { MAX_LINES_TO_READ } from '@open-claude-code/builtin-tools/tools/FileReadTool/prompt.js'
import type {
  AlreadyReadFileAttachment,
  CompactFileReferenceAttachment,
  FileAttachment,
  PDFReferenceAttachment,
} from './types.js'

/**
 * Generates a file attachment by reading a file with proper validation and truncation.
 * This is the core file reading logic shared between @-mentioned files and post-compact restoration.
 *
 * @param filename The absolute path to the file to read
 * @param toolUseContext The tool use context for calling FileReadTool
 * @param options Optional configuration for file reading
 * @returns A new_file attachment or null if the file couldn't be read
 */
/**
 * Check if a PDF file should be represented as a lightweight reference
 * instead of being inlined. Returns a PDFReferenceAttachment for large PDFs
 * (more than PDF_AT_MENTION_INLINE_THRESHOLD pages), or null otherwise.
 */
export async function tryGetPDFReference(
  filename: string,
): Promise<PDFReferenceAttachment | null> {
  const ext = parse(filename).ext.toLowerCase()
  if (!isPDFExtension(ext)) {
    return null
  }
  try {
    const [stats, pageCount] = await Promise.all([
      getFsImplementation().stat(filename),
      getPDFPageCount(filename),
    ])
    // Use page count if available, otherwise fall back to size heuristic (~100KB per page)
    const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024))
    if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      logEvent('tengu_pdf_reference_attachment', {
        pageCount: effectivePageCount,
        fileSize: stats.size,
        hadPdfinfo: pageCount !== null,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      return {
        type: 'pdf_reference',
        filename,
        pageCount: effectivePageCount,
        fileSize: stats.size,
        displayPath: relative(getCwd(), filename),
      }
    }
  } catch {
    // If we can't stat the file, return null to proceed with normal reading
  }
  return null
}

export async function generateFileAttachment(
  filename: string,
  toolUseContext: ToolUseContext,
  successEventName: string,
  errorEventName: string,
  mode: 'compact' | 'at-mention',
  options?: {
    offset?: number
    limit?: number
  },
): Promise<
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  | null
> {
  const { offset, limit } = options ?? {}

  // Check if file has a deny rule configured
  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(filename, appState.toolPermissionContext)) {
    return null
  }

  // Check file size before attempting to read (skip for PDFs — they have their own size/page handling below)
  if (
    mode === 'at-mention' &&
    !isFileWithinReadSizeLimit(
      filename,
      getDefaultFileReadingLimits().maxSizeBytes,
    )
  ) {
    const ext = parse(filename).ext.toLowerCase()
    if (!isPDFExtension(ext)) {
      try {
        const stats = await getFsImplementation().stat(filename)
        logEvent('tengu_attachment_file_too_large', {
          size_bytes: stats.size,
          mode,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        return null
      } catch {
        // If we can't stat the file, proceed with normal reading (will fail later if file doesn't exist)
      }
    }
  }

  // For large PDFs on @ mention, return a lightweight reference instead of inlining
  if (mode === 'at-mention') {
    const pdfRef = await tryGetPDFReference(filename)
    if (pdfRef) {
      return pdfRef
    }
  }

  // Check if file is already in context with latest version
  const existingFileState = toolUseContext.readFileState.get(filename)
  if (existingFileState && mode === 'at-mention') {
    try {
      // Check if the file has been modified since we last read it
      const mtimeMs = await getFileModificationTimeAsync(filename)

      // Handle timestamp format inconsistency:
      // - FileReadTool stores Date.now() (current time when read)
      // - FileEdit/WriteTools store mtimeMs (file modification time)
      //
      // If timestamp > mtimeMs, it was stored by FileReadTool using Date.now()
      // In this case, we should not use the optimization since we can't reliably
      // compare modification times. Only use optimization when timestamp <= mtimeMs,
      // indicating it was stored by FileEdit/WriteTool with actual mtimeMs.

      if (
        existingFileState.timestamp <= mtimeMs &&
        mtimeMs === existingFileState.timestamp
      ) {
        // File hasn't been modified, return already_read_file attachment
        // This tells the system the file is already in context and doesn't need to be sent to API
        logEvent(successEventName, {})
        return {
          type: 'already_read_file',
          filename,
          displayPath: relative(getCwd(), filename),
          content: {
            type: 'text',
            file: {
              filePath: filename,
              content: existingFileState.content,
              numLines: countCharInString(existingFileState.content, '\n') + 1,
              startLine: offset ?? 1,
              totalLines:
                countCharInString(existingFileState.content, '\n') + 1,
            },
          },
        }
      }
    } catch {
      // If we can't stat the file, proceed with normal reading
    }
  }

  try {
    const fileInput = {
      file_path: filename,
      offset,
      limit,
    }

    async function readTruncatedFile(): Promise<
      | FileAttachment
      | CompactFileReferenceAttachment
      | AlreadyReadFileAttachment
      | null
    > {
      if (mode === 'compact') {
        return {
          type: 'compact_file_reference',
          filename,
          displayPath: relative(getCwd(), filename),
        }
      }

      // Check deny rules before reading truncated file
      const appState = toolUseContext.getAppState()
      if (isFileReadDenied(filename, appState.toolPermissionContext)) {
        return null
      }

      try {
        // Read only the first MAX_LINES_TO_READ lines for files that are too large
        const truncatedInput = {
          file_path: filename,
          offset: offset ?? 1,
          limit: MAX_LINES_TO_READ,
        }
        const result = await FileReadTool.call(truncatedInput, toolUseContext)
        logEvent(successEventName, {})

        return {
          type: 'file' as const,
          filename,
          content: result.data,
          truncated: true,
          displayPath: relative(getCwd(), filename),
        }
      } catch {
        logEvent(errorEventName, {})
        return null
      }
    }

    // Validate file path is valid
    const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
    if (!isValid.result) {
      return null
    }

    try {
      const result = await FileReadTool.call(fileInput, toolUseContext)
      logEvent(successEventName, {})
      return {
        type: 'file',
        filename,
        content: result.data,
        displayPath: relative(getCwd(), filename),
      }
    } catch (error) {
      if (
        error instanceof MaxFileReadTokenExceededError ||
        error instanceof FileTooLargeError
      ) {
        return await readTruncatedFile()
      }
      throw error
    }
  } catch {
    logEvent(errorEventName, {})
    return null
  }
}

export function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const denyRule = matchingRuleForInput(
    filePath,
    toolPermissionContext,
    'read',
    'deny',
  )
  return denyRule !== null
}
