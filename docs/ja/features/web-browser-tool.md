<!-- lang-switcher -->
[English](/docs/en/features/web-browser-tool) · [中文](/docs/zh/features/web-browser-tool) · **日本語**

# WEB_BROWSER_TOOL — ブラウザツール

> Feature Flag: `FEATURE_WEB_BROWSER_TOOL=1`
> 実装状況: コアツールは実装済み、パネルは stub、接続は完了
> 参照数: 4

## 1. 機能概要

WEB_BROWSER_TOOL を使うと、モデルはブラウザインスタンスを起動し、Web ページへ移動して、ページ要素を操作できます。Bun の組み込み WebView API を使って、ヘッドレス/ヘッドフルブラウザ機能を提供します。

## 2. 実装アーキテクチャ

### 2.1 モジュールの状況

| モジュール | ファイル | 状況 |
|------|------|------|
| ブラウザパネル | `packages/builtin-tools/src/tools/WebBrowserTool/WebBrowserPanel.ts` | **Stub** — null を返す |
| ブラウザツール | `packages/builtin-tools/src/tools/WebBrowserTool/WebBrowserTool.ts` | **実装済み** |
| REPL 統合 | `src/screens/REPL.tsx` | **接続済み** — WebBrowserPanel を描画する |
| ツール登録 | `src/tools.ts` | **接続済み** — 動的に読み込む |
| WebView 検出 | `src/main.tsx` | **接続済み** — `'WebView' in Bun` で検出する |

### 2.2 想定データフロー

```
モデルが WebBrowserTool を呼び出す
         │
         ▼
Bun WebView がブラウザインスタンスを作成
         │
         ├── navigate(url) — URL へ移動
         ├── click(selector) — 要素をクリック
         ├── screenshot() — ページのスクリーンショットを取得
         └── extract(selector) — ページ内容を抽出
         │
         ▼
結果をモデルへ返す
         │
         ▼
WebBrowserPanel が REPL のサイドバーにブラウザの状態を表示
```

## 3. 実装が必要な箇所

| モジュール | 工数 | 説明 |
|------|--------|------|
| `WebBrowserTool.ts` | ✅ 実装済み | ツール schema + Bun WebView API の実行 |
| `WebBrowserPanel.tsx` | 中 | REPL サイドバーのブラウザ状態パネル（現在も stub） |

## 4. 重要な設計判断

1. **Bun WebView API**: 外部ブラウザドライバ（Puppeteer/Playwright）ではなく Bun 組み込みの WebView を使う
2. **REPL サイドパネル**: ブラウザの状態を REPL レイアウト内で独立して描画する
3. **Bun の feature 検出**: `'WebView' in Bun` でランタイムのサポートを確認する

## 5. 使用方法

```bash
FEATURE_WEB_BROWSER_TOOL=1 bun run dev
```

## 6. ファイル索引

| ファイル | 責務 |
|------|------|
| `packages/builtin-tools/src/tools/WebBrowserTool/WebBrowserPanel.ts` | パネルコンポーネント（stub） |
| `packages/builtin-tools/src/tools/WebBrowserTool/WebBrowserTool.ts` | ツール実装（実装済み） |
| `src/screens/REPL.tsx:471,5676` | パネルの描画 |
| `src/tools.ts:115-116` | ツール登録 |
