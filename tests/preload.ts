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
 */

delete process.env.OCC_CONFIG_DIR
delete process.env.OPENAI_MODEL
