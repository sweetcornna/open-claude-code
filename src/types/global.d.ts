/**
 * Global declarations for compile-time macros and internal-only identifiers
 * that are eliminated via Bun's MACRO/bundle feature system.
 */

// ============================================================================
// MACRO — Bun compile-time macro function (from bun:bundle)
// Expands the function body at build time and removes the call in production.
// Also supports property access like MACRO.VERSION (compile-time constants).
declare namespace MACRO {
  export const VERSION: string
  export const BUILD_TIME: string
  export const FEEDBACK_CHANNEL: string
  export const ISSUES_EXPLAINER: string
  export const NATIVE_PACKAGE_URL: string
  export const PACKAGE_URL: string
  export const VERSION_CHANGELOG: string
}
declare function MACRO<T>(fn: () => T): T

// ============================================================================
// Internal Anthropic-only identifiers (dead-code eliminated in open-source)
// These are referenced inside `MACRO(() => ...)` or `false && ...` blocks.

// Model resolution (internal)
declare function resolveAntModel(model: string): any
declare function getAntModels(): any[]
declare function getAntModelOverrideConfig(): {
  defaultSystemPromptSuffix?: string
  [key: string]: unknown
} | null

// Companion/buddy observer (internal)
declare function fireCompanionObserver(
  messages: unknown[],
  callback: (reaction: unknown) => void,
): void

// Metrics (internal)
declare const apiMetricsRef: React.RefObject<any[]> | null
declare function computeTtftText(metrics: any[]): string

// Gate/feature system (internal)
declare const Gates: Record<string, any>
declare function GateOverridesWarning(): JSX.Element | null
declare function ExperimentEnrollmentNotice(): JSX.Element | null

// Hook timing threshold (re-exported from services/tools/toolExecution.ts)
declare const HOOK_TIMING_DISPLAY_THRESHOLD_MS: number

// Ultraplan (internal)
declare function UltraplanChoiceDialog(): JSX.Element | null
declare function UltraplanLaunchDialog(): JSX.Element | null
declare function launchUltraplan(...args: unknown[]): void

// T — Generic type parameter leaked from React compiler output
// (react/compiler-runtime emits compiled JSX that loses generic type params)
declare type T = any

// Tungsten (internal)
declare function TungstenPill(): JSX.Element | null
