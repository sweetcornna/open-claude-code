# Changelog (English)

Release notes for open-claude-code (`occ`).

This is a translation of [`CHANGELOG.md`](CHANGELOG.md), which is the canonical
source and the only one the tooling parses. Keep the structure identical:
`## <semver> - <date>` headings, top-level `- ` entries, newest first.

## 2.29.4 - 2026-08-06

- **The one-line install command in the README installed someone else's empty package, and left you without an `occ` command.** The English and Japanese READMEs told you to run `npm i -g open-claude-code` — but that unscoped name belongs to a third-party `0.0.0` placeholder on npm with no `bin` and no files. npm prints `added 1 package` and exits successfully without creating a `bin/` directory, so "install succeeded" and "command not found" were both true at once. The correct package name is `@sweetcornna/open-claude-code`.
- If you installed from the README before, run `npm rm -g open-claude-code` to clear out the placeholder, then install again with the correct name.
- Only the READMEs had drifted; `package.json`, `scripts/install.sh` and the docs were always correct. The README was the one place the package name was not covered by a test, which is why it was the one place that drifted. It is covered now.
