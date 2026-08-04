<!-- lang-switcher -->
[English](/docs/en/features/tree-sitter-bash) · [中文](/docs/zh/features/tree-sitter-bash) · **日本語**

# TREE_SITTER_BASH — Bash AST 解析

> Feature Flag: `FEATURE_TREE_SITTER_BASH=1`
> 実装状況: 完全に利用可能（純粋な TypeScript 実装、約 7000 行以上）
> 参照数: 3

## 1. 機能概要

TREE_SITTER_BASH は、Bash コマンドの安全性検証に使う完全な Bash AST パーサーを有効にします。従来の正規表現ベースの shell-quote パーサーを、完全なツリー走査による安全性アナライザーで置き換えます。重要な性質は **fail-closed** であることです。認識できない内容はすべて `too-complex` に分類され、ユーザーの承認が必要になります。

### 関連 feature

| Feature | 説明 |
|---------|------|
| `TREE_SITTER_BASH` | 権限チェック用の AST パーサーを有効化する |
| `TREE_SITTER_BASH_SHADOW` | Shadow/観測モード: パーサーを実行するが結果は破棄し、telemetry だけを記録する |

## 2. セキュリティアーキテクチャ

### 2.1 Fail-Closed 設計

コア設計は **allowlist** 方式でツリーを走査します。

- `walkArgument()` は、安全と判明しているノード型（`word`、`number`、`raw_string`、`string`、`concatenation`、`arithmetic_expansion`、`simple_expansion`）だけを処理する
- 未知のノード型 → `tooComplex()` → ユーザーの承認が必要
- パーサーの読み込み後に失敗（タイムアウト/ノード予算/panic）→ `PARSE_ABORTED` シンボルを返す（「モジュールが未読み込み」の場合と区別する）

### 2.2 解析結果

```ts
parseForSecurity(cmd) の戻り値:
  { kind: 'simple', commands: SimpleCommand[] }     // 静的解析が可能
  { kind: 'too-complex', reason, nodeType }          // ユーザーの承認が必要
  { kind: 'parse-unavailable' }                      // パーサーが未読み込み
```

### 2.3 セキュリティチェックの階層

```
parseForSecurity(cmd)
      │
      ▼
parseCommandRaw(cmd) → AST root node
      │
      ▼
事前チェック: 制御文字、Unicode 空白、バックスラッシュ+空白、
              zsh ~[ ] 構文、zsh =cmd 展開、波括弧+引用符の曖昧化
      │
      ▼
walkProgram(root) → collectCommands(root, commands, varScope)
      │
      ├── 'command'         → walkCommand()
      ├── 'pipeline'/'list' → 構造ノードとして子ノードを再帰処理
      ├── 'for_statement'   → ループ変数を VAR_PLACEHOLDER として追跡
      ├── 'if/while'        → スコープを分離した分岐
      ├── 'subshell'        → スコープを複製
      ├── 'variable_assignment' → walkVariableAssignment()
      ├── 'declaration_command' → declare/export flags を検証
      ├── 'test_command'    → test 式を走査
      └── その他            → tooComplex()
      │
      ▼
checkSemantics(commands)
  ├── EVAL_LIKE_BUILTINS（eval, source, exec, trap...）
  ├── ZSH_DANGEROUS_BUILTINS（zmodload, emulate...）
  ├── SUBSCRIPT_EVAL_FLAGS（test -v, printf -v, read -a）
  ├── argv[0] にある Shell keywords（誤解析の検出）
  ├── /proc/*/environ へのアクセス
  ├── jq system() と危険な flags
  └── wrapper の除去（time, nohup, timeout, nice, env, stdbuf）
```

## 3. 実装アーキテクチャ

### 3.1 コアモジュール

| モジュール | ファイル | 行数 | 責務 |
|------|------|------|------|
| ゲート付きエントリ | `src/utils/bash/parser.ts` | ~110 | `parseCommand()`、`parseCommandRaw()`、`ensureInitialized()` |
| Bash パーサー | `src/utils/bash/bashParser.ts` | 4437 | 純粋な TS の字句解析 + 再帰下降パーサー |
| セキュリティアナライザー | `src/utils/bash/ast.ts` | 2680 | ツリー走査による安全性解析 + `parseForSecurity()` |
| AST 解析ヘルパー | `src/utils/bash/treeSitterAnalysis.ts` | 507 | 引用符コンテキスト、複合構造、危険パターンの抽出 |
| 権限チェックのエントリ | `src/tools/BashTool/bashPermissions.ts` | — | AST 結果を権限判断へ統合する |

### 3.2 Bash パーサー

ファイル: `src/utils/bash/bashParser.ts`（4437 行）

- 純粋な TypeScript 実装（ネイティブ依存なし）
- tree-sitter-bash と互換性のある AST を生成
- 主要な型: `TsNode`（type、text、startIndex、endIndex、children）
- 安全上の制限: `PARSE_TIMEOUT_MS = 50`、`MAX_NODES = 50_000` — adversarial input による OOM を防ぐ

### 3.3 セキュリティアナライザー

ファイル: `src/utils/bash/ast.ts`（2680 行）

コア関数:

| 関数 | 責務 |
|------|------|
| `parseForSecurity(cmd)` | トップレベルのエントリ。`simple/too-complex/parse-unavailable` を返す |
| `parseForSecurityFromAst(cmd, root)` | 事前解析済み AST を受け取る |
| `checkSemantics(commands)` | 解析後の意味検査 |
| `walkCommand()` | argv、envVars、redirects を抽出する |
| `walkArgument()` | allowlist に基づく引数走査 |
| `collectCommands()` | すべてのコマンドを再帰的に収集する |

### 3.4 AST 解析ヘルパー

ファイル: `src/utils/bash/treeSitterAnalysis.ts`（507 行）

| 関数 | 責務 |
|------|------|
| `extractQuoteContext()` | 一重引用符、二重引用符、ANSI-C 文字列、heredoc を識別する |
| `extractCompoundStructure()` | pipeline、subshell、command group を検出する |
| `hasActualOperatorNodes()` | 実際の `;`/`&&`/`\|\|` とエスケープされた形式を区別する |
| `extractDangerousPatterns()` | command substitution、parameter expansion、heredocs を検出する |
| `analyzeCommand()` | 1 回の走査で抽出する |

### 3.5 Shadow モード

`TREE_SITTER_BASH_SHADOW` はパーサーを実行しますが、**権限判断には一切影響させません**。

```ts
// Shadow モード: telemetry を記録してから、従来の経路を強制的に使う
astResult = { kind: 'parse-unavailable' }
astRoot = null
// 記録: available, astTooComplex, astSemanticFail, subsDiffer, ...
```

`tengu_tree_sitter_shadow` イベントを記録し、従来の `splitCommand()` との比較データを含めます。動作に影響を与えずに telemetry を収集するためのモードです。

## 4. 重要な設計判断

1. **Allowlist 走査**: 安全と判明しているノード型だけを処理し、未知の型は直ちに `tooComplex()` とする
2. **PARSE_ABORTED シンボル**: 「パーサーが未読み込み」と「パーサーが読み込み後に失敗」を区別する。後者では従来版へのフォールバックを禁止する（従来版には `EVAL_LIKE_BUILTINS` のチェックがない）
3. **変数スコープの追跡**: `VAR=value && cmd $VAR` パターン。静的値は実際の文字列へ解決し、`$()` の出力には `VAR_PLACEHOLDER` を使う
4. **PS4/IFS Allowlist**: PS4 への代入には厳格な文字 allowlist `[A-Za-z0-9 _+:.\/=\[\]-]` を使い、`${VAR}` 参照だけを許可する
5. **wrapper の除去**: argv の先頭から `time/nohup/timeout/nice/env/stdbuf` を除去する。未知の flag → fail-closed
6. **Shadow の安全性**: Shadow モードでは**常に** `astResult = { kind: 'parse-unavailable' }` を強制し、権限に一切影響させない

## 5. 使用方法

```bash
# 権限チェックに使う AST 解析を有効化
FEATURE_TREE_SITTER_BASH=1 bun run dev

# Shadow モード（telemetry のみ。動作には影響しない）
FEATURE_TREE_SITTER_BASH_SHADOW=1 bun run dev
```

## 6. ファイル索引

| ファイル | 行数 | 責務 |
|------|------|------|
| `src/utils/bash/parser.ts` | ~110 | ゲート付きエントリポイント |
| `src/utils/bash/bashParser.ts` | 4437 | 純粋な TS の bash パーサー |
| `src/utils/bash/ast.ts` | 2680 | セキュリティアナライザー（コア） |
| `src/utils/bash/treeSitterAnalysis.ts` | 507 | AST 解析ヘルパー |
| `packages/builtin-tools/src/tools/BashTool/bashPermissions.ts` | ~140 | 権限統合 + Shadow telemetry |
