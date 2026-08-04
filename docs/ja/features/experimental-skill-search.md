<!-- lang-switcher -->
[English](/docs/en/features/experimental-skill-search) · [中文](/docs/zh/features/experimental-skill-search) · **日本語**

# EXPERIMENTAL_SKILL_SEARCH — skill のセマンティック検索

> Feature Flag: `FEATURE_EXPERIMENTAL_SKILL_SEARCH=1`
> 実装状況: すべて stub（8 ファイル）、接続は完了
> 参照数: 21

## 1. 機能概要

EXPERIMENTAL_SKILL_SEARCH は、現在のタスクに基づいて利用可能な skill をセマンティック検索する DiscoverSkills ツールを提供します。ユーザーが手作業で探さなくても、モデルがタスクの実行時に関連する skill（ローカルとリモートの両方）を自動的に検出して推薦できるようにすることが目的です。

## 2. 実装アーキテクチャ

### 2.1 モジュールの状況

| モジュール | ファイル | 状況 | 説明 |
|------|------|------|------|
| DiscoverSkillsTool | `src/tools/DiscoverSkillsTool/prompt.ts` | **Stub** | ツール名が空 |
| prefetch | `src/services/skillSearch/prefetch.ts` | **Stub** | 3 関数がすべて no-op |
| リモート読み込み | `src/services/skillSearch/remoteSkillLoader.ts` | **Stub** | 空の結果を返す |
| リモート状態 | `src/services/skillSearch/remoteSkillState.ts` | **Stub** | null/undefined を返す |
| シグナル | `src/services/skillSearch/signals.ts` | **Stub** | `DiscoverySignal = any` |
| telemetry | `src/services/skillSearch/telemetry.ts` | **Stub** | no-op のログ |
| ローカル検索 | `src/services/skillSearch/localSearch.ts` | **Stub** | no-op のキャッシュ |
| feature チェック | `src/services/skillSearch/featureCheck.ts` | **Stub** | `isSkillSearchEnabled => false` |
| SkillTool 統合 | `src/tools/SkillTool/SkillTool.ts` | **接続済み** | すべてのリモート skill モジュールを動的に読み込む |
| prompt 統合 | `src/constants/prompts.ts` | **接続済み** | DiscoverSkills schema を注入する |

### 2.2 想定データフロー

```
モデルがユーザーのタスクを処理
      │
      ▼
DiscoverSkills ツールを起動 [実装が必要]
      │
      ├── ローカル検索: インストール済み skill のメタデータを索引化
      │   └── localSearch.ts → skill 名/説明/キーワードを照合
      │
      └── リモート検索: skill marketplace/registry を照会
          └── remoteSkillLoader.ts → fetch + 解析
      │
      ▼
結果の並べ替えとフィルタ
      │
      ▼
推薦 skill の一覧を返す
      │
      ▼
モデルが SkillTool で推薦された skill を呼び出す
```

### 2.3 prefetch の仕組み

`prefetch.ts` は、ユーザーが入力を送信する前にメッセージ内容を解析し、関連する skill の検索を先に始める想定です。

- `startSkillDiscoveryPrefetch()` — prefetch を開始する
- `collectSkillDiscoveryPrefetch()` — prefetch の結果を収集する
- `getTurnZeroSkillDiscovery()` — turn 0 の skill 検出結果を取得する

## 3. 実装が必要な箇所

| 優先度 | モジュール | 工数 | 説明 |
|--------|------|--------|------|
| 1 | `DiscoverSkillsTool` | 大 | セマンティック検索ツールの schema + 実行 |
| 2 | `skillSearch/prefetch.ts` | 中 | ユーザー入力の解析と prefetch ロジック |
| 3 | `skillSearch/remoteSkillLoader.ts` | 大 | リモート marketplace/registry からの取得 |
| 4 | `skillSearch/remoteSkillState.ts` | 小 | 検出済み skill の状態管理 |
| 5 | `skillSearch/localSearch.ts` | 中 | ローカル索引の構築/検索 |
| 6 | `skillSearch/featureCheck.ts` | 小 | GrowthBook/設定ゲート |
| 7 | `skillSearch/signals.ts` | 小 | `DiscoverySignal` の型定義 |

## 4. 重要な設計判断

1. **prefetch による最適化**: ユーザーの送信前に検索を始め、最初の応答のレイテンシを減らす
2. **ローカル+リモートの二重検索**: ローカル索引による高速照合 + リモート marketplace の詳細検索
3. **SkillTool との統合**: 検出した skill は SkillTool で呼び出すため、新しい呼び出し機構は不要
4. **MCP_SKILLS とは独立**: MCP_SKILLS は MCP サーバーから検出し、EXPERIMENTAL_SKILL_SEARCH は skill marketplace から検出する

## 5. 使用方法

```bash
# feature を有効化（実装を完了するまで実際には利用不可）
FEATURE_EXPERIMENTAL_SKILL_SEARCH=1 bun run dev
```

## 6. ファイル索引

| ファイル | 責務 |
|------|------|
| `src/tools/DiscoverSkillsTool/prompt.ts` | ツール schema（stub） |
| `src/services/skillSearch/prefetch.ts` | prefetch ロジック（stub） |
| `src/services/skillSearch/remoteSkillLoader.ts` | リモート読み込み（stub） |
| `src/services/skillSearch/remoteSkillState.ts` | リモート状態（stub） |
| `src/services/skillSearch/signals.ts` | シグナル型（stub） |
| `src/services/skillSearch/telemetry.ts` | telemetry（stub） |
| `src/services/skillSearch/localSearch.ts` | ローカル検索（stub） |
| `src/services/skillSearch/featureCheck.ts` | feature チェック（stub） |
| `src/tools/SkillTool/SkillTool.ts` | SkillTool の統合箇所 |
| `src/constants/prompts.ts:95,335,778` | prompt の拡張 |
