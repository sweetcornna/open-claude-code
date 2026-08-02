import { extname } from 'path'

/**
 * Marker type for analytics metadata verified not to contain code or file paths.
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * Marker type for analytics metadata routed to privileged PII-tagged fields.
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

type LogEventMetadata = {
  [key: string]: boolean | number | undefined
}

export interface AnalyticsHost {
  logEvent(eventName: string, metadata: LogEventMetadata): void
}

let host: AnalyticsHost | null = null

export function registerAnalyticsHost(h: AnalyticsHost): void {
  host = h
}

/**
 * Log an analytics event through the host when one is registered.
 * Standalone tool-runtime consumers intentionally fall back to a no-op.
 */
export function logEvent(eventName: string, metadata: LogEventMetadata): void {
  host?.logEvent(eventName, metadata)
}

const MAX_FILE_EXTENSION_LENGTH = 10

/**
 * Extract and sanitize a file extension for analytics logging.
 */
export function getFileExtensionForAnalytics(
  filePath: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  const ext = extname(filePath).toLowerCase()
  if (!ext || ext === '.') {
    return undefined
  }

  const extension = ext.slice(1)
  if (extension.length > MAX_FILE_EXTENSION_LENGTH) {
    return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return extension as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}
