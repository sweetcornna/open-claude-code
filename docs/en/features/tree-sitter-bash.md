<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/tree-sitter-bash) · [日本語](/docs/ja/features/tree-sitter-bash)

# TREE_SITTER_BASH — Bash AST Parsing

> Feature Flag: `FEATURE_TREE_SITTER_BASH=1`
> Implementation status: Fully functional (pure TypeScript implementation, ~7000+ lines)
> Reference count: 3

## 1. Feature overview

TREE_SITTER_BASH enables a complete Bash AST parser for validating the safety of Bash commands. It replaces the previous regular-expression-based shell-quote parser with a security analyzer that traverses the complete tree. Its critical property is **fail-closed** behavior: any unrecognized content is classified as `too-complex` and requires user approval.

### Related features

| Feature | Description |
|---------|------|
| `TREE_SITTER_BASH` | Activates the AST parser for permission checks |
| `TREE_SITTER_BASH_SHADOW` | Shadow/observation mode: runs the parser but discards its results and records only telemetry |

## 2. Security architecture

### 2.1 Fail-closed design

The core design uses an **allowlist** traversal strategy:

- `walkArgument()` handles only node types known to be safe (`word`, `number`, `raw_string`, `string`, `concatenation`, `arithmetic_expansion`, `simple_expansion`)
- Any unknown node type → `tooComplex()` → requires user approval
- A parser that loaded but failed (timeout/node budget/panic) → returns the `PARSE_ABORTED` symbol (distinct from “module not loaded”)

### 2.2 Parse results

```ts
parseForSecurity(cmd) returns:
  { kind: 'simple', commands: SimpleCommand[] }     // Can be analyzed statically
  { kind: 'too-complex', reason, nodeType }          // Requires user approval
  { kind: 'parse-unavailable' }                      // Parser not loaded
```

### 2.3 Security-check layers

```
parseForSecurity(cmd)
      │
      ▼
parseCommandRaw(cmd) → AST root node
      │
      ▼
Prechecks: control characters, Unicode whitespace, backslash + whitespace,
           zsh ~[ ] syntax, zsh =cmd expansion, brace + quote ambiguity
      │
      ▼
walkProgram(root) → collectCommands(root, commands, varScope)
      │
      ├── 'command'         → walkCommand()
      ├── 'pipeline'/'list' → structural; recurse into child nodes
      ├── 'for_statement'   → track loop variables as VAR_PLACEHOLDER
      ├── 'if/while'        → branches with isolated scopes
      ├── 'subshell'        → copy the scope
      ├── 'variable_assignment' → walkVariableAssignment()
      ├── 'declaration_command' → validate declare/export flags
      ├── 'test_command'    → walk test expressions
      └── other             → tooComplex()
      │
      ▼
checkSemantics(commands)
  ├── EVAL_LIKE_BUILTINS (eval, source, exec, trap...)
  ├── ZSH_DANGEROUS_BUILTINS (zmodload, emulate...)
  ├── SUBSCRIPT_EVAL_FLAGS (test -v, printf -v, read -a)
  ├── Shell keywords as argv[0] (misparse detection)
  ├── /proc/*/environ access
  ├── jq system() and dangerous flags
  └── Wrapper stripping (time, nohup, timeout, nice, env, stdbuf)
```

## 3. Implementation architecture

### 3.1 Core modules

| Module | File | Lines | Responsibility |
|------|------|------|------|
| Gated entry point | `src/utils/bash/parser.ts` | ~110 | `parseCommand()`, `parseCommandRaw()`, `ensureInitialized()` |
| Bash parser | `src/utils/bash/bashParser.ts` | 4437 | Pure-TS lexer and recursive-descent parser |
| Security analyzer | `src/utils/bash/ast.ts` | 2680 | Tree-traversal security analysis and `parseForSecurity()` |
| AST analysis helpers | `src/utils/bash/treeSitterAnalysis.ts` | 507 | Quote context, compound structures, and dangerous-pattern extraction |
| Permission-check entry point | `src/tools/BashTool/bashPermissions.ts` | — | Integrates AST results into permission decisions |

### 3.2 Bash parser

File: `src/utils/bash/bashParser.ts` (4437 lines)

- Pure TypeScript implementation (no native dependencies)
- Produces an AST compatible with tree-sitter-bash
- Key type: `TsNode` (type, text, startIndex, endIndex, children)
- Safety limits: `PARSE_TIMEOUT_MS = 50`, `MAX_NODES = 50_000` — prevent adversarial input from causing OOM

### 3.3 Security analyzer

File: `src/utils/bash/ast.ts` (2680 lines)

Core functions:

| Function | Responsibility |
|------|------|
| `parseForSecurity(cmd)` | Top-level entry point; returns `simple/too-complex/parse-unavailable` |
| `parseForSecurityFromAst(cmd, root)` | Accepts a preparsed AST |
| `checkSemantics(commands)` | Post-parse semantic checks |
| `walkCommand()` | Extracts argv, envVars, and redirects |
| `walkArgument()` | Allowlist-based argument traversal |
| `collectCommands()` | Recursively collects every command |

### 3.4 AST analysis helpers

File: `src/utils/bash/treeSitterAnalysis.ts` (507 lines)

| Function | Responsibility |
|------|------|
| `extractQuoteContext()` | Identifies single quotes, double quotes, ANSI-C strings, and heredocs |
| `extractCompoundStructure()` | Detects pipelines, subshells, and command groups |
| `hasActualOperatorNodes()` | Distinguishes real `;`/`&&`/`\|\|` operators from escaped forms |
| `extractDangerousPatterns()` | Detects command substitution, parameter expansion, and heredocs |
| `analyzeCommand()` | Extracts data in one traversal |

### 3.5 Shadow mode

`TREE_SITTER_BASH_SHADOW` runs the parser but **never affects permission decisions**:

```ts
// Shadow mode: record telemetry, then force the legacy path
astResult = { kind: 'parse-unavailable' }
astRoot = null
// Record: available, astTooComplex, astSemanticFail, subsDiffer, ...
```

It records a `tengu_tree_sitter_shadow` event containing comparison data against the legacy `splitCommand()`. This mode collects telemetry without changing behavior.

## 4. Key design decisions

1. **Allowlist traversal**: Handle only node types known to be safe; unknown types go directly to `tooComplex()`
2. **PARSE_ABORTED symbol**: Distinguish “parser not loaded” from “parser loaded but failed.” The latter prevents fallback to the legacy path, which lacks `EVAL_LIKE_BUILTINS` checks
3. **Variable-scope tracking**: Handle the `VAR=value && cmd $VAR` pattern. Static values resolve to their actual strings; `$()` output uses `VAR_PLACEHOLDER`
4. **PS4/IFS allowlist**: PS4 assignments use the strict character allowlist `[A-Za-z0-9 _+:.\/=\[\]-]` and permit only `${VAR}` references
5. **Wrapper stripping**: Strip `time/nohup/timeout/nice/env/stdbuf` from the front of argv; unknown flags → fail closed
6. **Shadow safety**: Shadow mode **always** forces `astResult = { kind: 'parse-unavailable' }` and never affects permissions

## 5. Usage

```bash
# Activate AST parsing for permission checks
FEATURE_TREE_SITTER_BASH=1 bun run dev

# Shadow mode (telemetry only; does not affect behavior)
FEATURE_TREE_SITTER_BASH_SHADOW=1 bun run dev
```

## 6. File index

| File | Lines | Responsibility |
|------|------|------|
| `src/utils/bash/parser.ts` | ~110 | Gated entry point |
| `src/utils/bash/bashParser.ts` | 4437 | Pure-TS Bash parser |
| `src/utils/bash/ast.ts` | 2680 | Security analyzer (core) |
| `src/utils/bash/treeSitterAnalysis.ts` | 507 | AST analysis helpers |
| `packages/builtin-tools/src/tools/BashTool/bashPermissions.ts` | ~140 | Permission integration and Shadow telemetry |
