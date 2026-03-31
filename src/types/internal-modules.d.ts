/**
 * Type declarations for internal Anthropic packages that cannot be installed
 * from public npm. All exports are typed as `any` to suppress errors while
 * still allowing IDE navigation for the actual source code.
 */

// ============================================================================
// bun:bundle — compile-time macros
// ============================================================================
declare module "bun:bundle" {
  export function feature(name: string): boolean
  export function MACRO<T>(fn: () => T): T
}

declare module "bun:ffi" {
  export function dlopen(path: string, symbols: Record<string, any>): any
}

// ============================================================================
// @ant/claude-for-chrome-mcp
// ============================================================================
declare module "@ant/claude-for-chrome-mcp" {
  export const BROWSER_TOOLS: any[]
  export class ClaudeForChromeContext { }
  export class Logger { }
  export type PermissionMode = any
  export function createClaudeForChromeMcpServer(...args: any[]): any
}

// ============================================================================
// @ant/computer-use-mcp
// ============================================================================
declare module "@ant/computer-use-mcp" {
  export const API_RESIZE_PARAMS: any
  export class ComputerExecutor { }
  export type ComputerUseSessionContext = any
  export type CuCallToolResult = any
  export type CuPermissionRequest = any
  export type CuPermissionResponse = any
  export type DEFAULT_GRANT_FLAGS = any
  export type DisplayGeometry = any
  export type FrontmostApp = any
  export type InstalledApp = any
  export type ResolvePrepareCaptureResult = any
  export type RunningApp = any
  export type ScreenshotDims = any
  export type ScreenshotResult = any
  export function bindSessionContext(...args: any[]): any
  export function buildComputerUseTools(...args: any[]): any[]
  export function createComputerUseMcpServer(...args: any[]): any
  export const targetImageSize: any
}

declare module "@ant/computer-use-mcp/sentinelApps" {
  export const sentinelApps: string[]
  export function getSentinelCategory(appName: string): string | null
}

declare module "@ant/computer-use-mcp/types" {
  export type ComputerUseConfig = any
  export type ComputerUseHostAdapter = any
  export type CoordinateMode = any
  export type CuPermissionRequest = any
  export type CuPermissionResponse = any
  export type CuSubGates = any
  export type DEFAULT_GRANT_FLAGS = any
  export type Logger = any
}

// ============================================================================
// @ant/computer-use-input
// ============================================================================
declare module "@ant/computer-use-input" {
  export class ComputerUseInput { }
  export class ComputerUseInputAPI { }
}

// ============================================================================
// @ant/computer-use-swift
// ============================================================================
declare module "@ant/computer-use-swift" {
  export class ComputerUseAPI { }
}

// ============================================================================
// @anthropic-ai/mcpb — McpbManifest was renamed
// ============================================================================
declare module "@anthropic-ai/mcpb" {
  export type McpbManifest = any
  export type McpbUserConfigurationOption = any
  // Re-export whatever is actually available
  export * from "@anthropic-ai/mcpb"
}

// ============================================================================
// color-diff-napi
// ============================================================================
declare module "color-diff-napi" {
  export function diff(a: [number, number, number], b: [number, number, number]): number
  export type ColorDiff = any
  export type ColorFile = any
  export type SyntaxTheme = any
  export function getSyntaxTheme(): SyntaxTheme
}

// ============================================================================
// Internal Anthropic native modules
// ============================================================================
declare module "audio-capture-napi" {
  const _: any
  export default _
}

declare module "image-processor-napi" {
  const _: any
  export default _
}

declare module "url-handler-napi" {
  const _: any
  export default _
}
