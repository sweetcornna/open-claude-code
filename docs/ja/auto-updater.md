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

対話セッションは起動から **1 分後**に最初のバックグラウンドバージョン確認を行い、その後はセッションが終わるまで**30 分ごとに定期的に**確認します。最初の確認を早めているのは、リリース直後に始まったセッションが 1 周期まるごと待たされないようにするためです。ただしゼロにはしません。起動はプロセスが最も忙しい瞬間であり、そこでの `npm view` はユーザーが実際に待っている処理と競合します。新しいバージョンを検出したら**その場でインストールします**。プロセス間の更新ロックを取得したうえで detached な `install -g` を spawn し、セッション自体はそれを待ちません。REPL の下部には控えめな通知（`✓ Update vX.Y.Z installing · restart to apply`）を表示します。失敗時はデバッグログだけに記録してセッションを中断しません。

**かつてなぜ即時インストールができなかったのか。** occ の成果物は内容ハッシュで命名された約 600 個の chunk に分割されており（これが `--version` の RSS を 966MB から 35MB へ下げている理由です。CLAUDE.md の「ビルドを単一ファイルへ『最適化』し直さないこと」を参照）、セッションはその生存期間を通じて chunk を遅延 `import()` し続けます。一方 `npm|bun install -g` はパッケージディレクトリ全体を**置き換え**、隣接するリリース間では**およそ半数の chunk のファイル名が変わります**（実測 2.21.0 → 2.22.0：595 個中 299 個が消滅）。したがってその場でのインストールは、実行中セッションの残りのコードの半分をディスクから消すことに等しく、以降の遅延 import はすべて `ERR_MODULE_NOT_FOUND` を投げていました。症状はクラッシュではなく**ハング**です。REPL が応答しなくなり、Ctrl+C すら終了パスに到達しません。そのためインストールは「最後の対話セッションが終了するまで」延期されていましたが、ユーザーから見ればそれは自動更新が動いていないのと同じでした。30 分セッションに座っていて、新版はすでに公開済みなのに何も起きない、という状態です。

**現在、セッションはインストーラが置き換えるディレクトリからコードを読みません。** 起動時にエントリスクリプトが `dist/` の全ファイルを `<設定ディレクトリ>/runtime/<バージョン>-<フィンガープリント>/dist` へ**ハードリンク**し、そこから本来のエントリを `import()` します（`src/services/autoUpdate/runtimeFarm.ts`）。ハードリンクであることが要点です。inode は同一なのでパッケージディレクトリが健在なあいだ追加のディスクを消費せず、inode の寿命は「それを指すリンクが残っているか」で決まるため、`install -g` がパッケージツリーを削除したあとも farm 側の複製は存在し続け、読み取れます。プロセスは起動後に自分のモジュール解決ルートを差し替えられない（chunk は import 元のモジュールからの相対で解決される）ので、この処理は最初の chunk を触る前に、エントリスクリプトの中で、同一プロセス内で完了させる必要があります。

ウォームパスのコストは **stat 2 回**です。フィンガープリント用に `dist/cli.js`（サイズと mtime）を 1 回、farm のエントリの存在確認に 1 回。ディレクトリ走査もハッシュ計算もありません。コールドパス（あるビルドの初回起動）は約 600 ファイルのハードリンクが 1 周分加わり、実測で `--version` が 0.04 秒から 0.17 秒になります。これはバージョンごとに一度だけです。

**farm を作れない場合は従来の動作に縮退します。** 設定ディレクトリが別ボリュームにある場合（EXDEV。Windows では npm のグローバル prefix が別ドライブにあることは珍しくありません）はコピーへフォールバックし、それも失敗すればインストールツリーからそのまま実行します。つまり本改修前とまったく同じ挙動で、失うのは保護だけです。`OCC_DISABLE_RUNTIME_FARM=1` で明示的に無効化できます。

**farm の回収。** インストールしたバージョンごとに 1 つ残り、パッケージディレクトリが置き換わったあとは、その farm がそれらの inode への唯一の参照になります（約 30MB）。回収処理は `src/services/autoUpdate/runtimeFarmGc.ts` にあり、対話セッション開始から 90 秒後に一度だけ実行されます。削除対象は「どの生存セッションの dist ルートも指していない」「このプロセス自身が実行中でない」「作成から 1 時間以上経過している」ディレクトリだけです。最後の条件は、別のセッションが farm を作ってから live-session のリースを登録するまでの窓を塞ぎます。生存セッションのツリーを 1 つでも特定できなかった場合はその回を丸ごとスキップします。ディスクを回収し損ねるほうが、誰かが import 中のツリーを消すよりつねに安上がりです。

**複数セッションは共存できますが、インストールするのは 1 つだけです。** 新しいバージョンを見つけたら `~/.occ/.update.lock` を取得します。別プロセスが保持していれば、すでにインストールが走っているということなので、その回は何もしません。同一セッション内で同じバージョンを二度インストールすることはなく、セッション中にさらに新しいバージョンが出れば次の回でそちらをインストールし、通知を再度表示します。

**新しいバージョンを使うには依然として再起動が必要です。** 実行中のプロセスが新しいビルドを採用することはできません。変わったのは「いつインストールされるか」だけで、終了後ではなく検出時になりました。

実装は React に依存しないサービスモジュール `src/services/autoUpdate/backgroundOccUpdate.ts` です。`src/cli/program/rootAction.tsx` が対話パス（`--print` による早期 return の後）で動的に import し、スケジュールします。UI 通知は `src/services/autoUpdate/updateNotifier.ts` のレジストリを通じて REPL の通知キューに渡されます（`setEnvHookNotifier` と同じパターン）。

次のいずれかに該当する場合はまったく実行しません。

- `globalConfig.autoUpdates === false`（`~/.occ.json`）
- 環境変数 `DISABLE_AUTOUPDATER` または `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
- `NODE_ENV=test/development`
- 現在実行中のコピーがグローバルインストールではない。npm のグローバルインストール（doctorDiagnostic が `npm-global` と判定）は `npm install -g` を使用し、エントリスクリプトが `~/.bun/install/global` ツリー内にある場合は `bun install -g` を使用する。ソース checkout、`npm-local`、Homebrew など、パッケージマネージャーによるその他のインストールはすべてスキップする

バージョン照会は `occ update` の処理系（`src/cli/updateOcc.ts` の `getLatestOccVersion` と `latestPackageSpec`）を再利用しており、2 つの経路がパッケージ指定でずれることはありません。プロセス間ロック `.update.lock` は、新しいバージョンを確認した**あとで**のみ取得します。毎回取得していると、インストールするものが何もない確認のたびに 5 分のロックが残り、本当にインストールしたいセッションを飢えさせます。子プロセスは我々より長く生きるため、成功時このロックは**意図的に解放しません**。5 分の失効ウィンドウがそのままインストールウィンドウとして機能します。解放するのは spawn 自体が失敗したときだけです。

**スキップには 2 種類あります。** このプロセス内では二度と変わらない条件（`NODE_ENV`、インストール形態）はループ自体を終了させます。一方、ユーザーがセッション途中で戻せる条件（`autoUpdates` 設定、上記の 2 つの環境変数）では周期実行を続けます。以前はすべてのスキップが最終的な扱いだったため、`/config` で自動更新を再度有効にしても次回起動まで効きませんでした。そのため可逆な条件はインストール形態の判定より前に置いています。判定は `npm config get prefix` を spawn しうるので、ループを生かし続けるには各回が十分に安価である必要があります。

**終了時に中断できます。** タイマーは `unref()` 済みでプロセスを保持しませんが、spawn した子プロセスは保持します。`npm view`（上限 10 秒）は `gracefulShutdown` に登録したセッション中断シグナルに紐付いており、Ctrl+C で実行中の子プロセスを取り消してイベントループを自然に排出できます。これがないと 5 秒の failsafe を待ってから強制終了していました。インストーラにこの処理は不要です。detached かつ `unref()` 済みで、そもそもイベントループを保持しません。

**ツリーが下から置き換えられた場合のフォールバック。** 通常セッションは farm 上で動作するため、この経路には到達しないはずです。残してあるのは farm の作成が失敗しうるからで（別ボリューム、ディスク枯渇、`OCC_DISABLE_RUNTIME_FARM=1`）、インストールツリーに戻ったセッションは、別のターミナルでの手動 `occ update` や直接の `npm install -g` で依然として置き換えられます。`gracefulShutdown` の `uncaughtException` / `unhandledRejection` ハンドラはこの特定の失敗を識別し（エラーコード `ERR_MODULE_NOT_FOUND`、Bun では `ResolveMessage`、**かつ**パスが `<distRoot>/chunks` 配下）、1 行の説明を表示してクリーンに終了します。Ctrl+C も効かないハングした UI を残しません。chunk のパスを必須にしているのは、プラグインや MCP server の通常の解決失敗でセッションを落とさないためです。ソースチェックアウトには `dist/chunks` が存在しないので、開発中に発火することはありません。

継承したコンポーネントベースの更新ルート（`AutoUpdaterWrapper` / `AutoUpdater` / `PackageManagerAutoUpdater` / `NativeAutoUpdater`）は、本節で述べたサービス化に伴い削除しました。すでにどこからもレンダリングされていませんでした。occ が独自の署名付きバイナリ配布元を構築するまでは、継承したネイティブダウンローダーや公式パッケージマネージャー向けの更新通知を再接続すべきではありません。明示的な `occ update` は引き続き手動更新のエントリポイントです。

## プラグインのバックグラウンド自動更新

インストール済みのプラグイン marketplace も同じ定期スケジュールに乗りますが、開始時刻は occ 本体の自動更新と**ずらして**あります。対話セッションの起動から 3 分後に最初の確認を行い、その後は同じく 30 分ごとに 1 周します。ずらしているのは、2 つの系統が同時にネットワークへアクセスするのを避けるためです。両者は同じ間隔で動くため、このずれはセッションの間ずっと保たれます。

1 周ごとの動作は次のとおりです。

1. インストール済みの marketplace を走査し、git / github 種別のソースだけを処理する。ローカルパス種別の marketplace ではネットワーク操作を一切行わない。
2. 各ソースに対して `git pull` を実行する。
3. `git pull` によってリポジトリが**実際に移動した場合にのみ**、対応するプラグインキャッシュを再度マテリアライズする。HEAD が変化しなかったソースでは書き込みは一切発生しない。
4. プラグインが更新された場合は REPL の下部に通知を表示し、新しいバージョンを現在のセッションで有効にするには `/reload-plugins` の実行が必要であることを伝える（occ 本体の更新通知とは異なり、プロセスの再起動は不要）。

無効化スイッチは occ 本体の自動更新と共通です。`~/.occ.json` の `"autoUpdates": false`、環境変数 `DISABLE_AUTOUPDATER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` のいずれかが有効なら、両方の系統とも実行されません。

プロセス間ロックは `<plugins>/.plugin-update.lock` です（プラグインのルートディレクトリは既定で `~/.occ/plugins`、`OCC_PLUGIN_CACHE_DIR` で上書き可能）。occ 本体の自動更新が使う `~/.occ/.update.lock` とは独立した別のロックであり、2 つの系統が互いをブロックすることはありません。

実装は `src/services/autoUpdate/backgroundPluginUpdate.ts` で、通知は `src/services/autoUpdate/pluginUpdateNotifier.ts` のレジストリを通じて REPL の通知キューに渡されます。

## 確認間隔とインスタンス間のスロットリング

2 つの系統の周期は同一の環境変数で制御します。

| 設定項目 | 場所 | 既定値 | 説明 |
|---|---|---|---|
| `OCC_UPDATE_CHECK_INTERVAL_MS` | 環境変数 | `1800000`（30 分） | occ 本体の自動更新とプラグイン更新の定期確認間隔を上書きする（2 つの系統で同じ値を共有）。下限は `60000`（1 分）。不正な値は既定値にフォールバックする |
| `lastBackgroundUpdateCheckAt` | `~/.occ.json` | — | occ 本体の前回のバックグラウンド確認のタイムスタンプ。内部フィールド |
| `lastBackgroundPluginUpdateCheckAt` | `~/.occ.json` | — | プラグインの前回のバックグラウンド確認のタイムスタンプ。内部フィールド |

2 つのタイムスタンプは内部状態であり、手動で編集する必要はなく、推奨もしません。これらが解決するのは**セッションをまたぐ場合と、複数インスタンスを同時に開いている場合**の重複確認です。occ は複数のウィンドウで同時に開かれることが多く、各インスタンスがそれぞれ 5 分間隔で確認すると、npm registry や git リモートへのリクエスト量がインスタンス数に比例して増えてしまいます。そこで各周回の確認前に対応するタイムスタンプを読み、前回の確認から 1 間隔が経過していない場合（別のインスタンスが直前に確認したことを意味します）、そのインスタンスはその周回をスキップし、リクエストを発行しません。

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

ユーザーに見える新しいバージョンは、メンテナーが `bun run release <version>` を実行することで作られます。このコマンドは `package.json` と `CHANGELOG.md` を同時に更新し、`v<version>` tag を作成します。tag を push すると `publish-npm.yml` が npm パッケージと GitHub Release を公開します。手順と制約の全体は [`CONTRIBUTING.md` の「リリースフロー」](../../CONTRIBUTING.md#11-发布流程)を参照してください。

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
| `src/cli/updateOcc.ts` | `occ update` のバージョン確認と npm/Bun 更新フロー。バックグラウンド更新が再利用する検出関数、パッケージ指定、サイレントインストール関数を export する |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | occ 本体のバックグラウンドサイレント自動更新サービス（定期スケジュール、ゲート、バージョン比較とキューイング） |
| `src/services/autoUpdate/occInstaller.ts` | `install -g` を detached で spawn する。セッションはそれを待たない |
| `src/services/autoUpdate/runtimeFarm.ts` | 起動時に `<設定ディレクトリ>/runtime/<バージョン>-<フィンガープリント>/` のハードリンク複製へ入る。パッケージディレクトリが置き換わっても実行中セッションを壊さない |
| `src/services/autoUpdate/runtimeFarmGc.ts` | 生存セッションが使っていない farm を回収する。廃止された `pending-updates/` ディレクトリも掃除する |
| `src/services/autoUpdate/liveSessions.ts` | `~/.occ/live-sessions/<pid>` のライブセッション登録簿（ハートビート 5 分、TTL 30 分）。farm の回収は誰がどのツリーを使用中かをここから判定する |
| `src/services/autoUpdate/updateNotifier.ts` | 更新通知を REPL の通知キューへ渡すレジストリ |
| `src/services/autoUpdate/backgroundPluginUpdate.ts` | プラグイン marketplace のバックグラウンド定期更新サービス（`git pull` とキャッシュの再マテリアライズ） |
| `src/services/autoUpdate/pluginUpdateNotifier.ts` | プラグイン更新通知を REPL の通知キューへ渡すレジストリ |
| `src/main.tsx` | ルートコマンド `occ update` を登録する |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | バックグラウンド自動更新ループ。公式ネイティブダウンローダーや公式パッケージ名へ接続してはならない |
| `src/utils/nativeInstaller/` | 継承した非公開のネイティブインストーラー実装。occ の配布チャネルではない |
| `scripts/release.ts` | `bun run release <version>`：すべてのバージョン源を更新し、リリースゲートを実行してコミットと tag を作成する |
| `src/utils/update/releaseNotes.ts` | `CHANGELOG.md` を取得して解析し、アプリ内の「更新情報」を駆動する |
