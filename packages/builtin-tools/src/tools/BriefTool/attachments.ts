/**
 * Shared attachment validation + resolution for SendUserMessage.
 */

import { stat } from 'fs/promises'

import type { ValidationResult } from '@open-claude-code/tool-runtime/Tool.js'

import { getCwd } from 'src/utils/cwd.js'
import { getErrnoCode } from '@open-claude-code/tool-runtime/errors.js'
import { IMAGE_EXTENSION_REGEX } from 'src/utils/imagePaste.js'
import { expandPath } from 'src/utils/path.js'

export type ResolvedAttachment = {
  path: string
  size: number
  isImage: boolean
}

export async function validateAttachmentPaths(
  rawPaths: string[],
): Promise<ValidationResult> {
  const cwd = getCwd()
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    try {
      const stats = await stat(fullPath)
      if (!stats.isFile()) {
        return {
          result: false,
          message: `Attachment "${rawPath}" is not a regular file.`,
          errorCode: 1,
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return {
          result: false,
          message: `Attachment "${rawPath}" does not exist. Current working directory: ${cwd}.`,
          errorCode: 1,
        }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          result: false,
          message: `Attachment "${rawPath}" is not accessible (permission denied).`,
          errorCode: 1,
        }
      }
      throw e
    }
  }
  return { result: true }
}

export async function resolveAttachments(
  rawPaths: string[],
  _ctx: { signal?: AbortSignal } = {},
): Promise<ResolvedAttachment[]> {
  // Stat serially (local, fast) to keep ordering deterministic.
  const stated: ResolvedAttachment[] = []
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    // Single stat — we need size, so this is the operation, not a guard.
    // validateInput ran before us, but the file could have moved since
    // (TOCTOU); if it did, let the error propagate so the model sees it.
    const stats = await stat(fullPath)
    stated.push({
      path: fullPath,
      size: stats.size,
      isImage: IMAGE_EXTENSION_REGEX.test(fullPath),
    })
  }
  return stated
}
