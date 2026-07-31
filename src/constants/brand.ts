/**
 * Single source of truth for this product's identity.
 *
 * Every user-visible name, the npm package the updater targets, and the
 * repository URL come from here. Before this module those strings were spread
 * across ~40 files, which is how `ccb --resume` ended up hardcoded in six
 * different places and how the self-updater came to point at three different
 * packages at once.
 *
 * ── What must NOT be renamed ──────────────────────────────────────────────
 *
 * Some strings look like branding and are load-bearing protocol. Changing them
 * breaks things in ways that are slow to diagnose, so they are deliberately
 * absent from this file:
 *
 *   - The system prompt's "You are Claude Code, Anthropic's official CLI for
 *     Claude" preamble (src/constants/prompts.ts). Anthropic's prompt caching
 *     and behaviour tuning key off that exact text.
 *   - The `claude-code/<version>` User-Agent (src/utils/userAgent.ts, 26 call
 *     sites). Anthropic-side rate limiting and eligibility read it.
 *   - The OTel `service.name: 'claude-code'` used by existing dashboards.
 *   - `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` filenames — an ecosystem
 *     convention shared with other tools.
 *   - `CLAUDECODE=1` in child process env: the cross-tool hints protocol.
 *
 * Path and directory identity lives in `src/config/paths.ts`, not here.
 */

/** The command users type. Also the process title and socket prefix. */
export const BIN_NAME = 'occ'

/** Full product name, for prose and package metadata. */
export const PRODUCT_NAME = 'open-claude-code'

/** Display name, for banners and dialogs. */
export const DISPLAY_NAME = 'Open Claude Code'

/**
 * The npm package the self-updater installs from.
 *
 * This MUST match the `name` field in package.json. Three separate places used
 * to disagree about it — `updateCCB.ts` said `claude-code-best`, `autoUpdater`
 * read an empty `MACRO.PACKAGE_URL`, and `rollback.ts` hardcoded Anthropic's
 * `@anthropic-ai/claude-code`, meaning "rolling back" installed a different
 * product over the user's binary.
 */
export const NPM_PACKAGE_NAME = 'open-claude-code'

/** OS-level deep-link identity owned exclusively by occ. */
export const DEEP_LINK_PROTOCOL = 'occ-cli'
export const LEGACY_DEEP_LINK_PROTOCOL = 'claude-cli'
export const MACOS_DEEP_LINK_BUNDLE_ID =
  'io.github.sweetcornna.open-claude-code-url-handler'
