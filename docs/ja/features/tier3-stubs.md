<!-- lang-switcher -->
[English](/docs/en/features/tier3-stubs) · [中文](/docs/zh/features/tier3-stubs) · **日本語**

# Tier 3 — 純粋な Stub / N/A に分類される低優先度 Feature の概要

> 本文書は Tier 3 のすべての feature をまとめたものです。これらは、純粋な Stub（すべての関数が空の値を返す）、
> Anthropic の内部インフラストラクチャ（N/A）、または参照数がきわめて少ない補助機能のいずれかです。

## 概要

| Feature | 参照数 | 状態 | 分類 | 概要 |
|---------|------|------|------|---------|
| CHICAGO_MCP | 16 | 実装済み | ツール | Computer Use 制御（build でデフォルト有効） |
| MONITOR_TOOL | 13 | 実装済み | ツール | shell 出力を継続的に監視するバックグラウンド監視ツール（build でデフォルト有効） |
| BG_SESSIONS | 11 | 部分実装 | セッション管理 | バックグラウンドセッションの登録/クリーンアップは実装済み、タスクの要約は stub（dev でデフォルト有効） |
| SHOT_STATS | 10 | 実装済み | 統計 | API 呼び出し統計パネル（build でデフォルト有効） |
| EXTRACT_MEMORIES | 7 | 実装済み | メモリ | 自動メモリ抽出（build でデフォルト有効、GrowthBook でゲート） |
| TEMPLATES | 6 | 部分実装 | プロジェクト管理 | プロジェクト/プロンプトのテンプレートシステム（dev でデフォルト有効） |
| LODESTONE | 6 | 実装済み | ディープリンク | URL プロトコルハンドラー（build でデフォルト有効） |

## 単一参照の Feature（40+）

以下の feature はいずれも参照箇所が 1 つだけで、その大半は内部用マーカーまたは実験的機能です。

UNATTENDED_RETRY, ULTRATHINK, TORCH, SLOW_OPERATION_LOGGING, SKILL_IMPROVEMENT,
SELF_HOSTED_RUNNER, RUN_SKILL_GENERATOR, PERFETTO_TRACING, NATIVE_CLIENT_ATTESTATION,
KAIROS_DREAM（kairos.md を参照）, IS_LIBC_MUSL, IS_LIBC_GLIBC, DUMP_SYSTEM_PROMPT,
COMPACTION_REMINDERS, CCR_REMOTE_SETUP, BYOC_ENVIRONMENT_RUNNER, BUILTIN_EXPLORE_PLAN_AGENTS,
BUILDING_CLAUDE_APPS, ANTI_DISTILLATION_CC, AGENT_TRIGGERS, ABLATION_BASELINE

## 優先度の説明

これらの feature が Tier 3 に分類される理由は次のとおりです。

1. **実装済みだが影響範囲が小さい**（CHICAGO_MCP, LODESTONE, SHOT_STATS, EXTRACT_MEMORIES, MONITOR_TOOL）：build/dev でデフォルト有効になっており、主に他の機能のインフラストラクチャとして使用される
2. **部分実装**（BG_SESSIONS, TEMPLATES）：中核となる登録処理は実装済みだが、タスクの要約など一部の機能はまだ stub
3. **補助機能**（STREAMLINED_OUTPUT, HOOK_PROMPTS）：影響範囲が小さい
4. **CCR 系**：リモートコントロールインフラストラクチャに依存しており、先に BRIDGE_MODE を完成させる必要がある

Tier 3 の特定の feature について詳しく調べるには、コードベースで `feature('FEATURE_NAME')` を検索し、具体的な使用箇所を確認してください。
