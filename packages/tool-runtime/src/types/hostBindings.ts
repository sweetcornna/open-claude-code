/**
 * Late-bound host types: the extension point for the handful of types that
 * the Tool contract threads through but must not copy.
 *
 * WHY THIS EXISTS. Most of the wave C2 burn-down worked by re-declaring the
 * host type structurally in `./hostContracts.js`. That is the right move when
 * the type is small and closed. It is the wrong move for these five, and the
 * measurement that settled it is worth recording so nobody redoes the
 * experiment:
 *
 *   AppState               28 distinct fields are read off `getAppState()`
 *                          across src/ and builtin-tools, out of ~52
 *                          declared — and 62 of the 65 `setAppState` call
 *                          sites are `prev => ({ ...prev, x })`. Because the
 *                          updater is `(prev: AppState) => AppState`, the
 *                          type sits in an invariant position: a copy that
 *                          omitted even one field would reject every one of
 *                          those spreads. A faithful copy means duplicating
 *                          ~52 fields plus a closure of ~30 further host
 *                          types (SettingsJson, TaskState, ModelSetting, …).
 *
 *   Command                ~19 members reached through
 *                          `options.commands`, across a three-arm union
 *                          (Prompt | Local | LocalJSX).
 *
 *   AgentDefinition        ~21 of ~28 members reached, three-arm union whose
 *                          arms have *different* `getSystemPrompt`
 *                          signatures — one of which takes a
 *                          `Pick<ToolUseContext, 'options'>`, making it
 *                          mutually recursive with this package.
 *
 *   AgentDefinitionsResult holds `AgentDefinition[]`, so it follows.
 *
 *   MCPServerConnection    narrow in members touched, but `config` is
 *                          `ScopedMcpServerConfig`, a zod-inferred type.
 *
 * Copying any of these would trade one honest import edge for a large silent
 * duplicate that drifts. So instead of copying them, this package declares
 * that they exist and lets the host say what they are.
 *
 * HOW IT WORKS. `HostTypeBindings` is an empty interface. The host augments it
 * (see `src/types/toolRuntimeBindings.ts`) via `declare module`, which is
 * TypeScript's standard mechanism for exactly this: a leaf declares the slot,
 * the composition root fills it. The import direction is host → package, which
 * is the direction we want, so tool-runtime keeps zero outgoing edges.
 *
 * Each alias below resolves to the host's real type once the augmentation is
 * in the program, giving *exact* type identity — not an approximation. That is
 * why these five have no entry in the contract test: there is no copy, so
 * there is nothing to drift and nothing to assert.
 *
 * These types are mutually recursive with `../Tool.js` — `src/types/command.ts`
 * and `src/state/AppStateStore.ts` both import `ToolUseContext` back out of it,
 * and `BuiltInAgentDefinition.getSystemPrompt` takes a
 * `Pick<ToolUseContext, 'options'>` — and the binding carries those cycles
 * fine, because an interface member is resolved as lazily as a direct type
 * reference.
 *
 * ONE TRAP, since it cost an hour: in the host's `declare module` block, write
 * the bound types as inline `import('...').X` types. A bare identifier there
 * resolves against *this module's* scope, not the augmenting file's, so
 * `AppState: AppState` silently binds the slot to this file's own `AppState`
 * alias. That is circular, and TypeScript does not always report it as such —
 * it degraded ~20 callback parameters across builtin-tools to implicit `any`
 * instead.
 */

/**
 * Host-supplied type slots. Augment, do not edit.
 *
 * The interface is intentionally empty here and gains its members from
 * `src/types/toolRuntimeBindings.ts`:
 *
 * ```ts
 * declare module '@open-claude-code/tool-runtime/types/hostBindings.js' {
 *   interface HostTypeBindings {
 *     AppState: import('src/state/AppStateStore.js').AppState
 *   }
 * }
 * ```
 *
 * The aliases below are plain indexed accesses, with no conditional-type
 * fallback for the unbound case. A fallback does work (it was tried), but it
 * buys nothing: this package has no standalone tsconfig, so it is only ever
 * compiled as part of the repo's single `tsc` run, where the augmentation is
 * always present. Without a fallback, a dropped augmentation fails as one
 * legible `Property 'AppState' does not exist on type 'HostTypeBindings'`
 * rather than as a cascade of downstream mismatches against a placeholder.
 */
// biome-ignore lint/suspicious/noEmptyInterface: this interface is an augmentation target; members come from the host.
export interface HostTypeBindings {}

/** @see HostTypeBindings */
export type AppState = HostTypeBindings['AppState']

/** @see HostTypeBindings */
export type Command = HostTypeBindings['Command']

/** @see HostTypeBindings */
export type MCPServerConnection = HostTypeBindings['MCPServerConnection']

/** @see HostTypeBindings */
export type AgentDefinition = HostTypeBindings['AgentDefinition']

/** @see HostTypeBindings */
export type AgentDefinitionsResult = HostTypeBindings['AgentDefinitionsResult']
