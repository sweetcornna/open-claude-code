/**
 * Constants for the official Anthropic plugins marketplace.
 *
 * The official marketplace is hosted on GitHub and provides first-party
 * plugins developed by Anthropic. This file defines the constants needed
 * to install and identify this marketplace.
 */

import type { MarketplaceSource } from './schemas.js'

/**
 * Source configuration for the official Anthropic plugins marketplace.
 * Used when auto-installing the marketplace on startup.
 */
export const OFFICIAL_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: 'anthropics/claude-plugins-official',
} as const satisfies MarketplaceSource

/**
 * Display name for the official marketplace.
 * This is the name under which the marketplace will be registered
 * in the known_marketplaces.json file.
 */
export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official'

/**
 * Source configuration for the default plugin marketplace — the official
 * Claude Code repository, which doubles as a marketplace via its
 * `.claude-plugin/marketplace.json` (the documented
 * `/plugin marketplace add anthropics/claude-code` source).
 *
 * Declared implicitly (as a constant, never written to settings) for users
 * with no marketplace configuration of their own; see
 * getDeclaredMarketplaces() in marketplaceManager.ts.
 */
export const DEFAULT_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: 'anthropics/claude-code',
} as const satisfies MarketplaceSource

/**
 * Name under which the default marketplace registers.
 *
 * MUST match the `name` field of the repo's .claude-plugin/marketplace.json:
 * addMarketplaceSource registers materialized entries under the manifest
 * name, and the reconciler diff needs the declared key to line up with the
 * known_marketplaces.json key — a mismatch would re-clone on every startup.
 */
export const DEFAULT_MARKETPLACE_NAME = 'claude-code-plugins'
