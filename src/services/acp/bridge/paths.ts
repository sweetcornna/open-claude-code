// Pure path-normalisation helper used by toolInfo / toolResults / forwarding.
import { isAbsolute, resolve } from 'node:path'

/**
 * Normalises an emitted file path against the session cwd so that
 * ToolCallLocation.path / Diff.path values are always absolute, as required
 * by the ACP v1 spec (tool-calls.mdx:304-306; all file paths MUST be absolute).
 * If no cwd is available, the original value is returned unchanged.
 */
export function toAbsolutePath(
  filePath: string | undefined,
  cwd?: string,
): string | undefined {
  if (!filePath) return undefined
  if (!cwd) return filePath
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
}
