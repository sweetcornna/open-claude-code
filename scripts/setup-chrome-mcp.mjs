#!/usr/bin/env node

/**
 * Automatic Chrome native-host installation is intentionally disabled.
 *
 * open-claude-code does not own a compatible browser extension and host
 * identity. Registering either bundled Chrome host would claim an integration
 * owned by another extension, so this script must remain read-only.
 */

if (process.env.CLAUDE_CODE_SKIP_CHROME_MCP_SETUP === '1') {
  process.exit(0)
}

console.error(
  'Error: Chrome native-host setup is disabled because open-claude-code does not yet have an isolated browser extension and host identity.',
)
process.exitCode = 1
