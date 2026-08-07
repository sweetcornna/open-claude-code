# Changelog (English)

Release notes for open-claude-code (`occ`).

This is a translation of [`CHANGELOG.md`](CHANGELOG.md), which is the canonical
source and the only one the tooling parses. Keep the structure identical:
`## <semver> - <date>` headings, top-level `- ` entries, newest first.

## 2.31.1 - 2026-08-07

- **Fixed `CLAUDE_CODE_DISABLE_THINKING` never working for DeepSeek users.** DeepSeek treats an *absent* `thinking` field as enabled, and turning thinking off was exactly the case where occ omitted the field — so the model kept thinking after you disabled it. The off state is now sent explicitly. Applies to DeepSeek's Anthropic endpoint.
- **DeepSeek now defaults `temperature` to `0`** when none is set (previously the endpoint's implicit `1.0`). DeepSeek's own parameter guide specifies `0.0` for code and math, which is occ's entire workload. Sent only when thinking is off; `DEEPSEEK_TEMPERATURE` still opts out.
- Internal: the test-mock hygiene ratchet is now at zero (241 → 0). Along the way this fixed a batch of test stubs whose shapes did not match the real signatures, several of which made a mocked module return wrong results to later test files in the same process. No runtime behaviour change.

## 2.31.0 - 2026-08-07

Per-tier thinking effort and context window; DeepSeek moves to a better-suited API and gains free web search; two long-reported UI problems fixed.

- **⚠️ Behaviour change: GPT models now think harder by default.** `gpt-5.6-sol` used to default to low and other GPT models to medium; all of them are now xhigh, which **noticeably increases reasoning-token spend**. Third-party providers that previously sent no effort at all (GLM, Qwen, Kimi, local models) now default to xhigh too. To go back to the old cost, use `/model-settings <tier> effort medium` or set `CLAUDE_CODE_EFFORT_LEVEL`. Effort is only ever sent to models known to accept it.
- **⚠️ Behaviour change: Claude Opus and Fable now default to the 1M context window.** Requests above 200k are billed at Anthropic's 1M rate. Sonnet and Haiku are unaffected and stay at 200k.
- **New `/model-settings`** sets thinking effort and context window separately for haiku / sonnet / opus / fable. Both were single global values before, which could not express "think hard on the heavy tier, stay cheap on the light one". Defaults follow the provider: DeepSeek gets max effort and 1M, GPT gets xhigh and 272k, Claude gets high (with 1M for Opus and Fable), everything else gets xhigh and 200k. Environment variables still take precedence.
- **DeepSeek users now have web search, and it is free.** occ now talks to DeepSeek's Anthropic-compatible API — the only one of its protocols that runs search server-side. Until now WebSearch on DeepSeek quietly fell back to keyless page scraping. Thinking blocks are also native now, so nothing is lost in format conversion. **No configuration change is needed**; it activates on detecting a DeepSeek endpoint, and `CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` turns it off.
- **Fixed: escape sequences left in the terminal after Ctrl+C.** Text like `^[]11;rgb:...` and `^[[?62;22;52c` was the terminal answering occ's colour query after occ had already stopped reading. Shutdown now stops those background queries before closing input.
- **Fixed: a phantom subagent in the status line that `x` would not dismiss.** A subagent that finished at the same moment it was moved to the background skipped its cleanup and stayed "running" forever.
- Fixed: terminal control characters could leak into piped or redirected output. Only real terminals are queried now.

## 2.30.0 - 2026-08-06

A batch of real Windows failures, plus a rendering problem that affected every platform.

- **Every error opened a WSL window on Windows, and every hook failed.** One cause behind both: occ was treating `C:\Windows\System32\bash.exe` as a shell, and that is the WSL launcher. The Bash tool and the hook runner share that lookup, which is why the two symptoms arrived together. It now skips past it to find a real Git Bash.
- **Every Bash tool command reported "command not found" on Windows.** The PATH occ wrote into the shell environment was the literal five characters `$PATH`, because it ran a POSIX-only command through cmd.exe.
- **Automatic updates had never once worked on Windows, and failed silently.** `occ update`, `occ rollback` and LSP language servers could not launch npm-installed programs — on Windows those are `.cmd` wrappers that need a different launch path. The background updater also discarded its own failures, so there was no sign anything was wrong.
- **`occ bg kill` always refused to run on Windows**, reporting that it could not verify the process. The same underlying problem made Computer Use crash on its first call there.
- Fixed terminal display corruption: background colour bleeding sideways, text clipped on the left, and large blank gaps between lines. Three separate causes, two of which also affected macOS and Linux. If you have seen this, it should be gone.
- **A background agent's timer stayed at 0s** while the token counter beside it climbed. It was measuring duration with a clock that can step backwards, which Windows does routinely after resuming from sleep.
- **Hook failures now tell you which hook failed and why.** Previously you got a single line — "UserPromptSubmit hook error" — even when the hook itself had printed a full explanation.
- MCP server authentication failures no longer say just `fetch failed`; you get the actual reason (connection refused, DNS failure, certificate problem, proxy error).
- The waiting animation now fades to amber when a response is merely slow, and turns red only when nothing has come back at all. Both used to look like failure.
- Also fixed on Windows: shell completion never installed, ChatGPT credentials were written into the current project instead of your home directory, worktree directory links silently did nothing, plugin install and uninstall failed at random while antivirus held files open, and MCP server processes accumulated instead of exiting.
- Fixed SSH and Computer Use, which were broken on **every** platform — including "paste image from clipboard" on macOS.

## 2.29.4 - 2026-08-06

- **The one-line install command in the README installed someone else's empty package, and left you without an `occ` command.** The English and Japanese READMEs told you to run `npm i -g open-claude-code` — but that unscoped name belongs to a third-party `0.0.0` placeholder on npm with no `bin` and no files. npm prints `added 1 package` and exits successfully without creating a `bin/` directory, so "install succeeded" and "command not found" were both true at once. The correct package name is `@sweetcornna/open-claude-code`.
- If you installed from the README before, run `npm rm -g open-claude-code` to clear out the placeholder, then install again with the correct name.
- Only the READMEs had drifted; `package.json`, `scripts/install.sh` and the docs were always correct. The README was the one place the package name was not covered by a test, which is why it was the one place that drifted. It is covered now.
