/**
 * Test preload: clear env vars that the user's dev shell may have set for
 * running occ, but that tests assume are unset.
 *
 * `OCC_CONFIG_DIR` overrides `CLAUDE_CONFIG_DIR` (by design — see
 * src/config/paths.ts). ~50 test files set `CLAUDE_CONFIG_DIR` to a temp dir
 * and expect it to be used; a leftover `OCC_CONFIG_DIR` silently redirects
 * them to the user's real config dir, reading real state and writing test
 * fixtures into it.
 *
 * `OPENAI_MODEL` is the top-priority override in `resolveOpenAIModel` (it
 * wins over family aliases and `OPENAI_DEFAULT_*_MODEL`). Tests that drive
 * the OpenAI adapter or assert on a resolved model id assume it is unset.
 *
 * The Remote Control keys resolve to the public default server when unset, and
 * anyone who actually uses Remote Control has one of them exported. Leaving
 * them in place makes every bridge URL assertion read the developer's own
 * server — and puts that server's hostname into the failure output.
 */

delete process.env.OCC_CONFIG_DIR
delete process.env.OPENAI_MODEL
delete process.env.OCC_REMOTE_CONTROL_URL
delete process.env.CLAUDE_BRIDGE_BASE_URL
delete process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
