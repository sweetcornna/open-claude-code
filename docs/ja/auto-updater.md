<!-- lang-switcher -->
[English](/docs/en/auto-updater) · [中文](/docs/zh/auto-updater) · **日本語**

# 自動更新

## 現在の方針

Open Claude Code は npm パッケージ `@sweetcornna/open-claude-code` として公開されます（スコープなしの `open-claude-code` は第三者のプレースホルダーパッケージに使用されています）。現在サポートしている更新方法は次のとおりです。

```bash
occ update
```

このコマンドが確認および更新するのは Open Claude Code 自体だけです。Anthropic 公式の Claude Code をインストール、アンインストール、または上書きすることはありません。

公式 CLI と occ は共存できます。

| 製品 | コマンド | npm パッケージ | ユーザー設定 |
|---|---|---|---|
| Open Claude Code | `occ` / `occ-bun` | `@sweetcornna/open-claude-code` | `~/.occ/`、`~/.occ.json` |
| Anthropic Claude Code | `claude` | `@anthropic-ai/claude-code` | `~/.claude/`、`~/.claude.json` |

## インストールと手動更新

npm でインストールまたは更新します。

```bash
npm install -g @sweetcornna/open-claude-code
occ update
```

Bun でインストールまたは更新します。

```bash
bun install -g @sweetcornna/open-claude-code
occ-bun update
```

自動検出を使わず、対応するパッケージマネージャーのコマンドを直接実行することもできます。

```bash
npm install -g @sweetcornna/open-claude-code@latest
# または
bun install -g @sweetcornna/open-claude-code@latest
```

## `occ update` の実行フロー

実装は `src/cli/updateOcc.ts` にあり、処理は次の順序で進みます。

1. 現在のバージョンを読み取る。
2. npm registry で `@sweetcornna/open-claude-code@latest` を照会する。
3. 現在のバージョンがすでに最新なら、そのまま終了する。
4. 現在のインストール先が Bun のグローバルインストールディレクトリかどうかを検出する。
5. Bun のグローバルインストールでは `bun install -g @sweetcornna/open-claude-code@latest` を使用し、それ以外では `npm install -g @sweetcornna/open-claude-code@latest` を使用する。
6. 更新に失敗した場合は、同等の手動復旧コマンドを表示する。

パッケージ名は `src/constants/brand.ts` の `NPM_PACKAGE_NAME` を参照し、更新処理内で同じ文字列を重複して管理しません。

## 公式ネイティブインストーラーからの分離

このリポジトリには、コード調査と将来の独立した配布基盤の構築に備えて、上流から復元したネイティブインストーラー実装の一部が残っています。この実装が参照するのは Anthropic 公式バイナリの配布チャネルであり、Open Claude Code の配布チャネルではありません。したがって、**現在 occ がサポートするインストール方法には含まれません**。

2 つの製品が互いに干渉しないように、次の制約を設けています。

- ルートコマンドにはネイティブインストール用の `occ install [target]` エントリポイントを登録しない。
- occ の更新エントリポイントは Anthropic 公式バイナリをダウンロードしない。
- occ は `@anthropic-ai/claude-code` をアンインストールしない。
- occ は `claude` コマンドを削除または置換しない。
- occ は `~/.claude` を自身の書き込み可能なインストールディレクトリとして扱わない。

occ のインストールを目的として `src/utils/nativeInstaller/` 配下の内部関数を手動で呼び出さないでください。これらの関数は安定した公開インターフェースではありません。

## バックグラウンドでのサイレント自動更新

対話セッションは起動から約 5 分後にバックグラウンドで一度だけバージョンを確認します（セッションごとに最大 1 回）。新しいバージョンを検出すると、グローバルインストールをサイレントに実行します。成功時は REPL の下部に控えめな通知（`✓ Updated to vX.Y.Z · Restart to apply`）を表示し、失敗時はデバッグログだけに記録してセッションを中断しません。実装は React に依存しないサービスモジュール `src/services/autoUpdate/backgroundOccUpdate.ts` です。`src/cli/program/rootAction.tsx` が対話パス（`--print` による早期 return の後）で動的に import し、スケジュールします。UI 通知は `src/services/autoUpdate/updateNotifier.ts` のレジストリを通じて REPL の通知キューに渡されます（`setEnvHookNotifier` と同じパターン）。

次のいずれかに該当する場合はまったく実行しません。

- `globalConfig.autoUpdates === false`（`~/.occ.json`）
- 環境変数 `DISABLE_AUTOUPDATER` または `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
- `NODE_ENV=test/development`
- 現在実行中のコピーがグローバルインストールではない。npm のグローバルインストール（doctorDiagnostic が `npm-global` と判定）は `npm install -g` を使用し、エントリスクリプトが `~/.bun/install/global` ツリー内にある場合は `bun install -g` を使用する。ソース checkout、`npm-local`、Homebrew など、パッケージマネージャーによるその他のインストールはすべてスキップする

インストールコマンドは `occ update` の処理系（`src/cli/updateOcc.ts` のバージョン照会と `installOccGloballySilent`）を再利用し、出力はそのまま渡さずキャプチャします。また、`installGlobalPackage()` と同じ `.update.lock` のプロセス間ロックを共有します。

`src/components/AutoUpdaterWrapper.tsx` から継承したコンポーネントベースの更新ルートは依然としてマウントされておらず、`NativeAutoUpdater` にもルーティングされません。occ が独自の署名付きバイナリ配布元を構築するまでは、継承したネイティブダウンローダーや公式パッケージマネージャー向けの更新通知を再接続すべきではありません。明示的な `occ update` は引き続き手動更新のエントリポイントです。

## 開発版

ソースワークスペースでは、グローバル CLI による現在の checkout の更新ではなく、Git と依存関係のインストールによって更新します。

```bash
git pull
bun install
bun run precheck
```

配布成果物を検証する場合は、次を実行します。

```bash
bun run build:vite
node dist/cli-node.js --version
bun dist/cli-bun.js --version
```

## リリース側（メンテナー）

ユーザーに見える新しいバージョンは、メンテナーが `bun run release <version>` を実行することで作られます。このコマンドは `package.json` と `CHANGELOG.md` を同時に更新し、`v<version>` tag を作成します。tag を push すると `publish-npm.yml` が npm パッケージと GitHub Release を公開します。手順と制約の全体は [`CONTRIBUTING.md` の「リリースフロー」](../CONTRIBUTING.md#11-发布流程)を参照してください。

occ の起動時に表示する「更新情報」は、このリポジトリの `main` ブランチにある `CHANGELOG.md` から取得します（`src/utils/update/releaseNotes.ts` が raw ファイルを取得し、occ の設定ディレクトリ配下の `cache/changelog.md` にキャッシュします）。したがって、ユーザーが対応する項目を参照できるようにするには、リリースコミットを先に main へ反映する必要があります。

## トラブルシューティング

`occ update` から npm registry にアクセスできない場合は、パッケージのバージョンを直接確認できます。

```bash
npm view @sweetcornna/open-claude-code@latest version
```

グローバルインストール先への書き込み権限がない場合は、npm/Bun のユーザー単位のグローバルディレクトリ設定を修正してください。`~/.claude` の削除、公式 Claude Code のアンインストール、`claude` コマンドの上書きによって解決しないでください。

更新後、2 つのコマンドが引き続き互いに独立していることを確認できます。

```bash
occ --version
claude --version
```

公式 Claude Code をインストールしていない場合、2 番目のコマンドが存在しないのは正常です。

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `src/constants/brand.ts` | occ のコマンド名と npm パッケージ名の唯一の真源 |
| `src/cli/updateOcc.ts` | `occ update` のバージョン確認と npm/Bun 更新フロー。バックグラウンド更新が再利用する検出関数とサイレントインストール関数を export する |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | バックグラウンドでのサイレント自動更新サービス（スケジュール、ゲート、インストールのオーケストレーション） |
| `src/services/autoUpdate/updateNotifier.ts` | 更新成功通知を REPL の通知キューへ渡すレジストリ |
| `src/main.tsx` | ルートコマンド `occ update` を登録する |
| `src/components/AutoUpdaterWrapper.tsx` | マウントされていないバックグラウンド更新ルート。公式ネイティブダウンローダーへ接続してはならない |
| `src/utils/nativeInstaller/` | 継承した非公開のネイティブインストーラー実装。occ の配布チャネルではない |
| `scripts/release.ts` | `bun run release <version>`：すべてのバージョン源を更新し、リリースゲートを実行してコミットと tag を作成する |
| `src/utils/update/releaseNotes.ts` | `CHANGELOG.md` を取得して解析し、アプリ内の「更新情報」を駆動する |
