/**
 * Error log sink implementation
 *
 * This module contains the heavy implementation for error logging and should be
 * initialized during app startup. It handles file-based error logging to disk.
 *
 * Usage: Call initializeErrorLogSink() during app startup to attach the sink.
 *
 * DESIGN: This module is separate from log.ts to avoid import cycles.
 * log.ts has NO heavy dependencies - events are queued until this sink is attached.
 */

import axios from 'axios'
import { dirname, join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { createBufferedWriter } from '../filesystem/bufferedWriter.js'
import { CACHE_PATHS } from '../filesystem/cachePaths.js'
import { registerCleanup } from '../process/cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from '../filesystem/fsOperations.js'
import { errorMessage, getErrnoCode } from '../runtime/errors.js'
import { attachErrorLogSink, dateToFilename } from './log.js'
import { jsonStringify } from './slowOperations.js'
import { captureException } from './sentry.js'

const DATE = dateToFilename(new Date())

/**
 * Gets the path to the errors log file.
 */
export function getErrorsPath(): string {
  return join(CACHE_PATHS.errors(), DATE + '.jsonl')
}

/**
 * Gets the path to MCP logs for a server.
 */
export function getMCPLogsPath(serverName: string): string {
  return join(CACHE_PATHS.mcpLogs(serverName), DATE + '.jsonl')
}

type JsonlWriter = {
  write: (obj: object) => void
  flush: () => void
  dispose: () => void
}

function createJsonlWriter(options: {
  writeFn: (content: string) => void
  onError?: (error: unknown) => void
  flushIntervalMs?: number
  maxBufferSize?: number
}): JsonlWriter {
  const writer = createBufferedWriter(options)
  return {
    write(obj: object): void {
      writer.write(jsonStringify(obj) + '\n')
    },
    flush: writer.flush,
    dispose: writer.dispose,
  }
}

// Buffered writers for JSONL log files, keyed by path
const logWriters = new Map<string, JsonlWriter>()

function isSensitiveLogFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    normalized.includes('auth') ||
    normalized.includes('cookie') ||
    normalized.includes('credential') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('apikey') ||
    normalized.endsWith('key')
  )
}

function sanitizeUrlForLogging(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '[INVALID URL]'
  }
}

function sanitizeLogText(value: string): string {
  const withoutUrlCredentials = value.replace(
    /\b(?:https?|wss?):\/\/[^\s"'<>}\]]+/gi,
    url => sanitizeUrlForLogging(url),
  )

  const withoutJsonCredentials = withoutUrlCredentials.replace(
    /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*"|[^,{}[\]"\s]+)/g,
    (match, rawKey: string, separator: string) => {
      try {
        const key = JSON.parse(rawKey) as unknown
        return typeof key === 'string' && isSensitiveLogFieldName(key)
          ? `${rawKey}${separator}"[REDACTED]"`
          : match
      } catch {
        return match
      }
    },
  )

  return withoutJsonCredentials.replace(
    /(\b[A-Za-z0-9_-]*(?:auth|cookie|credential|secret|token|api[-_]?key)[A-Za-z0-9_-]*\b\s*=\s*)([^,\s}\]]+)/gi,
    '$1[REDACTED]',
  )
}

/**
 * Flush all buffered log writers. Used for testing.
 * @internal
 */
export function _flushLogWritersForTesting(): void {
  for (const writer of logWriters.values()) {
    writer.flush()
  }
}

/**
 * Clear all buffered log writers. Used for testing.
 * @internal
 */
export function _clearLogWritersForTesting(): void {
  for (const writer of logWriters.values()) {
    writer.dispose()
  }
  logWriters.clear()
}

/** @internal */
export function _sanitizeLogTextForTesting(value: string): string {
  return sanitizeLogText(value)
}

/** @internal */
export function _writeLogRecordForTesting(path: string, message: object): void {
  const writer = getLogWriter(path)
  writer.write(message)
  writer.flush()
}

function getLogWriter(path: string): JsonlWriter {
  let writer = logWriters.get(path)
  if (!writer) {
    const dir = dirname(path)
    writer = createJsonlWriter({
      // sync IO: called from sync context
      writeFn: (content: string) => {
        try {
          // Happy-path: directory already exists
          getFsImplementation().appendFileSync(path, content)
        } catch (error) {
          if (getErrnoCode(error) !== 'ENOENT') {
            throw error
          }
          getFsImplementation().mkdirSync(dir)
          getFsImplementation().appendFileSync(path, content)
        }
      },
      onError: error => {
        logForDebugging(
          `Failed to write error log: ${sanitizeLogText(errorMessage(error))}`,
          { level: 'error' },
        )
      },
      flushIntervalMs: 1000,
      maxBufferSize: 50,
    })
    logWriters.set(path, writer)
    registerCleanup(async () => writer?.dispose())
  }
  return writer
}

function appendToLog(path: string, message: object): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  const messageWithTimestamp = {
    timestamp: new Date().toISOString(),
    ...message,
    cwd: getFsImplementation().cwd(),
    userType: process.env.USER_TYPE,
    sessionId: getSessionId(),
    version: MACRO.VERSION,
  }

  getLogWriter(path).write(messageWithTimestamp)
}

function extractServerMessage(data: unknown): string | undefined {
  if (typeof data === 'string') {
    return data
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (typeof obj.message === 'string') {
      return obj.message
    }
    if (
      typeof obj.error === 'object' &&
      obj.error &&
      'message' in obj.error &&
      typeof (obj.error as Record<string, unknown>).message === 'string'
    ) {
      return (obj.error as Record<string, unknown>).message as string
    }
  }
  return undefined
}

/**
 * Implementation for logError - writes error to debug log and file.
 */
function logErrorImpl(error: Error): void {
  const errorStr = sanitizeLogText(error.stack || error.message)

  // Enrich axios errors with request URL, status, and server message for debugging
  let context = ''
  if (axios.isAxiosError(error) && error.config?.url) {
    const parts = [`url=${sanitizeUrlForLogging(error.config.url)}`]
    if (error.response?.status !== undefined) {
      parts.push(`status=${error.response.status}`)
    }
    const serverMessage = extractServerMessage(error.response?.data)
    if (serverMessage) {
      parts.push(`body=${sanitizeLogText(serverMessage)}`)
    }
    context = `[${parts.join(',')}] `
  }

  const persistedError = sanitizeLogText(`${context}${errorStr}`)
  logForDebugging(`${error.name}: ${persistedError}`, { level: 'error' })

  appendToLog(getErrorsPath(), {
    error: persistedError,
  })

  // Also report to Sentry (no-op if not initialized)
  captureException(error)
}

/**
 * Implementation for logMCPError - writes MCP error to debug log and file.
 */
function logMCPErrorImpl(serverName: string, error: unknown): void {
  const errorStr = sanitizeLogText(
    error instanceof Error ? error.stack || error.message : String(error),
  )
  // Not themed, to avoid having to pipe theme all the way down
  logForDebugging(`MCP server "${serverName}" ${errorStr}`, { level: 'error' })

  const logFile = getMCPLogsPath(serverName)

  const errorInfo = {
    error: errorStr,
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    cwd: getFsImplementation().cwd(),
  }

  getLogWriter(logFile).write(errorInfo)
}

/**
 * Implementation for logMCPDebug - writes MCP debug message to log file.
 */
function logMCPDebugImpl(serverName: string, message: string): void {
  const sanitizedMessage = sanitizeLogText(message)
  logForDebugging(`MCP server "${serverName}": ${sanitizedMessage}`)

  const logFile = getMCPLogsPath(serverName)

  const debugInfo = {
    debug: sanitizedMessage,
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    cwd: getFsImplementation().cwd(),
  }

  getLogWriter(logFile).write(debugInfo)
}

/**
 * Initialize the error log sink.
 *
 * Call this during app startup to attach the error logging backend.
 * Any errors logged before this is called will be queued and drained.
 *
 * Should be called BEFORE initializeAnalyticsSink() in the startup sequence.
 *
 * Idempotent: safe to call multiple times (subsequent calls are no-ops).
 */
export function initializeErrorLogSink(): void {
  attachErrorLogSink({
    logError: logErrorImpl,
    logMCPError: logMCPErrorImpl,
    logMCPDebug: logMCPDebugImpl,
    getErrorsPath,
    getMCPLogsPath,
  })

  logForDebugging('Error log sink initialized')
}
