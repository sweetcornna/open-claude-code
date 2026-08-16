<!-- lang-switcher -->
[English](/docs/en/features/remote-control-self-hosting) · [中文](/docs/zh/features/remote-control-self-hosting) · **日本語**

# Remote Control とセルフホスト RCS

occ にはネイティブ Remote Control bridge が含まれます。これは**現在実行中の REPL セッション**をブラウザーと同期します。リモート側には同じ会話とリアルタイムのツール出力が表示され、リモートメッセージは同じキューへ入り、権限の判断と割り込みも現在のターンへ作用します。

```
┌──────────────────┐   WebSocket / SSE + HTTP   ┌───────────────────────┐
│ 現在の occ REPL   │ ◄────────────────────────► │ Remote Control Server │
│ メッセージと制御   │                            │ Web UI + イベントバス   │
└──────────────────┘                            └───────────────────────┘
```

これは `occ --acp` とは異なります。ACP はエディターや別の ACP クライアント向けに agent を起動するプロトコル入口です。Remote Control は現在のターミナル会話を別の ACP セッションへ置き換えません。

## 既定の接続先

環境変数を何も設定しない場合、occ は本プロジェクトが運用する公開 RCS **`https://rc.cornna.xyz`**（RCS 0.2.0、アカウント制、登録開放）へ接続します。`/remote-control` はそのまま利用でき、初回は登録 / ログインダイアログが開きます。

自分の環境へ向けるには `OCC_REMOTE_CONTROL_URL` を設定します。優先順位は `OCC_REMOTE_CONTROL_URL` > `CLAUDE_BRIDGE_BASE_URL`（旧キー名、引き続きサポート）> 組み込みの既定値です。いずれも `settings.json` の `env` ブロックに書けば永続化できます。

### 公開サーバーを使う前に

公開サーバーは**ホスティングの選択肢**であり、エンドツーエンド暗号化された経路ではありません。

- セッションの通信はサーバーを経由し、**サーバー側に保存されます**。セッションごとに直近およそ 5,000 件のイベントが保持されます。メッセージ本文、ツール出力、ファイルの抜粋はすべてそこを通ります。
- サーバーが保存する資格情報はダイジェストだけです（パスワードは Argon2id ハッシュ、各種 token は HMAC ダイジェスト）。ただし上の点は変わりません。**内容そのものはサーバー側で読める状態です**。
- 機密リポジトリ、顧客データ、明確なコンプライアンス要件がある場合は、以下の手順でセルフホストするか、Remote Control を使わないでください。
- 公開サーバーは可用性やデータ保持を保証しません。メールによる復旧手段もありません。

## 現在のセッションを制御する

起動時に有効化できます。

```bash
occ --remote-control
# 任意のセッション名
occ --remote-control "my session"
# --rc はエイリアス
```

会話の途中から有効化することもできます。

```text
/remote-control
/remote-control my-session
```

アカウント制の RCS 0.2.0（公開サーバーでもセルフホストでも同じ）で認証が必要な場合、`/remote-control` は**現在の REPL 内**にログイン/登録ダイアログを開きます。登録はサーバー側で許可されている場合にだけ表示されます。フローを直接指定することもできます。

```text
/remote-control login
/remote-control register
```

ログインに成功すると、occ は正規化したサーバー URL、ユーザー名、**ローテーションされる refresh token** だけを OS Keychain に保存します。OS Keychain が利用できない場合は、暗号化された Local Vault を使用します。パスワードと短時間有効な access token は保存しません。資格情報は RCS の base URL ごとに分離されます。

REPL を離れずにアカウントと接続を確認できます。

```text
/remote-control status
/remote-control logout
```

`status` は接続状態とログイン中のアカウントを表示します。`logout` は Remote Control を切断し、サーバーへログインの失効を要求して、ローカルの refresh 資格情報を削除します。

ターミナルには現在の session の Web URL が表示されます。そのページから次の操作ができます。

- 接続前から存在する会話と、その後のリアルタイム出力を表示する
- 現在の REPL へメッセージを送る
- ツール権限要求を許可または拒否する
- 実行中のターンを中断する
- 切断後に再接続して同じセッションを継続する

URL の fragment には一度だけ使える `#pair` コードが含まれます。このコードは **2 分**で失効し、一度だけ `Secure`、`HttpOnly`、`SameSite=Strict` 属性を持つ `__Host-rcs_session` cookie と交換されます。Web UI は pairing fragment を直ちにブラウザー履歴から削除します。コードが失効した場合は URL または QR コードを再生成し、未使用の pairing URL は共有しないでください。

接続中にもう一度 `/remote-control` を実行すると、現在のセッションのダイアログが開きます。URL の確認、新しい QR コードの生成、切断ができます。切断されるのは bridge だけで、ローカル REPL は終了しません。

`/config` の **Enable Remote Control for all sessions** を `true` にすると、以後の対話セッションで既定で有効になります。`default` を選ぶと明示的な上書きを削除し、プラットフォーム既定値へ戻します。

## リモート環境として実行する

トップレベルのサブコマンドは、現在のディレクトリをリモートセッションを受け付ける環境として公開します。

```bash
occ remote-control
```

`occ rc`、`occ remote`、`occ sync`、`occ bridge` は互換エイリアスです。このモードは常駐ホスト向けで、REPL 内の `/remote-control` とは別の入口です。名前、権限、タイムアウト、複数セッション、worktree のオプションは `occ remote-control --help` で確認してください。

常駐環境もアカウント認証を使用します。有効な refresh 資格情報がない場合、共有 API key を要求する代わりにターミナルでログインまたは登録を求めます。

## セルフホスト RCS を起動する

`packages/remote-control-server/` には、アカウントベースの RCS 0.2.0 Hono バックエンドと React Web UI が含まれます。リポジトリのルートから開発サーバーを起動できます。

```bash
RCS_BASE_URL="http://127.0.0.1:3000" bun run rcs
```

`bun run rcs` は Web UI をビルドしてから、watch モードでバックエンドを起動します。開発専用の既定 secret はデプロイに使用しないでください。

本番環境では、保護された環境ファイルまたは secret manager から secret を注入し、リポジトリの Dockerfile を使用します。

```bash
docker build -f packages/remote-control-server/Dockerfile -t occ-rcs .
docker run -d --name occ-rcs -p 3000:3000 \
  --env-file /secure/path/rcs.env \
  -v rcs-data:/app/data \
  --restart unless-stopped \
  occ-rcs
```

ローカルビルドを省略して、ビルド済みイメージを使うこともできます。`rcs-v*` tag を push すると `.github/workflows/release-rcs.yml` が実行され、`ghcr.io/sweetcornna/remote-control-server` に `<version>`（例: `0.2.0`）、`<major>.<minor>`（例: `0.2`）、`latest` の 3 つの tag で公開されます。上記の `docker build` を `docker pull ghcr.io/sweetcornna/remote-control-server:0.2.0` に置き換えてください。GHCR の package は既定で private のため、リポジトリ所有者が public に変更するまでは、pull の前に `docker login ghcr.io` が必要です。

保護された環境には、少なくとも次の変数が必要です。

```dotenv
RCS_BASE_URL=https://rcs.example.com
RCS_TOKEN_PEPPER=<32文字以上のランダムなsecret>
RCS_WORKER_JWT_SECRET=<別の32文字以上のランダムなsecret>
```

`NODE_ENV=production` では両方の secret が必須です。secret manager で独立した値を生成し、ログやターミナルへ出力したり、リポジトリへ commit したり、URL に入れたり、イメージへ焼き込んだりしないでください。公開登録が本当に必要な場合にだけ `RCS_ALLOW_REGISTRATION=1` を設定します。非公開サーバーでは、管理されたネットワーク上で一時的に登録を有効化して最初のアカウントを作成し、その後無効化して RCS を再起動できます。

クライアントの接続先を設定して occ を起動し、スラッシュコマンドを実行します。

```bash
export OCC_REMOTE_CONTROL_URL="https://rcs.example.com"
occ
```

```text
/remote-control
```

`CLAUDE_BRIDGE_BASE_URL` は同じ意味の旧キー名です。引き続きサポートされ、両方を設定した場合は `OCC_REMOTE_CONTROL_URL` が優先されます。

自分のサーバーへ向けた場合も、既定の公開サーバーの場合も、claude.ai サブスクリプションとリモート GrowthBook entitlement は不要です。ただしローカル workspace trust と `allow_remote_control` 組織ポリシーは引き続き適用されます。

### Docker の永続化とヘルスチェック

RCS はアカウント、token digest、environment、session、保持対象の event を SQLite に保存します。`RCS_DATABASE_PATH` の既定値は `/app/data/rcs.sqlite` で、SQLite は WAL モードで動作します。`/app/data` を named volume または永続的な bind mount に必ずマウントしてください。マウントしない場合、コンテナを削除するとデータベースも失われます。

イメージには、30 秒ごとに `GET /health` を呼び出す Docker health check が組み込まれています。この endpoint はサーバー状態とバージョンを返します。orchestrator や外部監視でも同じ endpoint を確認できますが、ヘルスチェックは認証を含む機能監視の代わりにはなりません。

## RCS 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `RCS_VERSION` | `0.2.0` | `GET /health` が返すバージョン |
| `RCS_PORT` | `3000` | HTTP/WebSocket の待受ポート |
| `RCS_HOST` | `0.0.0.0` | 待受アドレス |
| `RCS_BASE_URL` | 自動 | ブラウザーと ingress URL が使う外部 URL。本番では公開 HTTPS origin を明示的に設定 |
| `RCS_DATABASE_PATH` | `/app/data/rcs.sqlite` | 永続 SQLite データベースのパス。WAL を有効化 |
| `RCS_TOKEN_PEPPER` | 開発環境のみ既定値あり | 永続化する opaque token digest 用の HMAC pepper。本番では必須かつ 32 文字以上 |
| `RCS_WORKER_JWT_SECRET` | 開発環境のみ既定値あり | worker JWT の署名 secret。本番では必須かつ 32 文字以上で、token pepper とは別の値 |
| `RCS_ALLOW_REGISTRATION` | `0` | `1` にすると公開アカウント登録を許可 |
| `RCS_TRUST_PROXY` | `0` | `X-Forwarded-For` を上書きする信頼済み proxy の背後でのみ `1` に設定。IP rate limit に使用 |
| `RCS_LEGACY_API_KEY_AUTH` | `0` | 0.1 の共有 API key 互換モードを明示的に有効化 |
| `RCS_API_KEYS` | 空 | 旧形式 key のカンマ区切り一覧。旧 API key 認証を有効にした場合だけ使用 |
| `RCS_MAX_ENVIRONMENTS_PER_ACCOUNT` | `50` | アカウントごとに保存できる environment の最大数 |
| `RCS_MAX_SESSIONS_PER_ACCOUNT` | `1000` | アカウントごとに保存できる session の最大数 |
| `RCS_MAX_EVENT_BYTES` | `262144` | 保存される session イベント 1 件の最大シリアライズバイト数。超過時は `413` を返す |
| `RCS_REGISTRATION_RATE_LIMIT` | `5` | 1 window 内で IP ごと、およびユーザー名ごとに許可する登録試行回数 |
| `RCS_REGISTRATION_RATE_WINDOW_SECONDS` | `3600` | 登録 rate limit の window（秒） |
| `RCS_LOGIN_RATE_LIMIT` | `10` | 1 window 内で IP ごと、およびユーザー名ごとに許可するログイン試行回数 |
| `RCS_LOGIN_RATE_WINDOW_SECONDS` | `900` | ログイン rate limit の window（秒） |
| `RCS_WEB_CORS_ORIGINS` | 空 | 追加 Web Origin のカンマ区切り一覧 |
| `RCS_POLL_TIMEOUT` | `8` | environment work poll のタイムアウト（秒） |
| `RCS_HEARTBEAT_INTERVAL` | `20` | work heartbeat 間隔（秒） |
| `RCS_JWT_EXPIRES_IN` | `900` | worker JWT の有効期間（秒）。上限は `3600` |
| `RCS_DISCONNECT_TIMEOUT` | `300` | 更新がない session を inactive にするまでの秒数 |
| `RCS_WS_IDLE_TIMEOUT` | `30` | Bun WebSocket の idle ping 間隔（秒） |
| `RCS_WS_KEEPALIVE_INTERVAL` | `20` | サーバー keep-alive データフレーム間隔（秒） |

クライアント側の環境変数は次の 3 つだけです。

| 変数 | 説明 |
| --- | --- |
| `OCC_REMOTE_CONTROL_URL` | Remote Control サーバーのアドレス。未設定なら公開サーバー `https://rc.cornna.xyz` |
| `CLAUDE_BRIDGE_BASE_URL` | 同じものの旧キー名。両方設定した場合は上が優先 |
| `CLAUDE_BRIDGE_SESSION_INGRESS_URL` | WebSocket/SSE ingress URL だけを別に上書き。既定は解決済みのサーバーアドレスと同じで、通常は設定不要 |

## リバースプロキシとセキュリティ

本番環境では HTTPS を使用し、リバースプロキシで WebSocket Upgrade を転送してください。proxy の idle timeout は `RCS_WS_KEEPALIVE_INTERVAL` より長くする必要があります。pairing URL と same-origin 検査を正しく動作させるため、`RCS_BASE_URL` はブラウザーから見える HTTPS origin に設定します。

直接公開する場合は `RCS_TRUST_PROXY=0` のままにしてください。すべての通信が信頼済み proxy を通り、その proxy が外部からの転送 header を削除して実際のクライアント IP を設定する場合にだけ有効化します。それ以外では、攻撃者が IP を偽装して IP 単位の認証 rate limit を回避できます。

### 不正利用対策とプライバシー

- 各アカウントは environment、session、event、資格情報を独立して所有します。アカウント API と Web UI の読み書きは所有者の範囲に限定されます。
- パスワードは Argon2id hash として保存されます。opaque な access、refresh、browser、pairing、environment、work token は、`RCS_TOKEN_PEPPER` を使った HMAC-SHA-256 digest だけが保存され、平文では保存されません。production では起動時に `RCS_TOKEN_PEPPER` と `RCS_WORKER_JWT_SECRET` がそれぞれ 32 文字以上であること、**かつ互いに異なる値であること**を検証し、満たさない場合は起動を拒否します。
- session ごとに最新 **5,000 event** だけを保持します。セッション通信はサーバーへ保存され、end-to-end encryption ではないため、データベースのバックアップも機密会話データとして保護してください。
- 登録とログインは、それぞれ IP と正規化済みユーザー名の両方で rate limit されます。アカウント単位の environment/session quota が tenant の増加を制限します。上記の変数でデプロイ規模に合わせて調整できます。
- refresh token は使用のたびにローテーションされます。使用済み refresh token の再送は、そのアカウントの全アクティブ資格情報を失効させます（`token_reused`）。盗まれた token がセッションを延命し続けることはできません。WebSocket 接続は**フレームごと、および keepalive ごと**に、資格情報そのもの（access token / browser cookie / worker JWT / environment 資格情報）とアカウント・session の状態を再検証します。token の失効や期限切れ、アカウント無効化、worker epoch のローテーションでは close code `4002`、reason `token_revoked` / `token_expired` / `account_revoked` / `session_revoked` で接続を閉じます。
- 失効は**能動的**です。ログアウト、refresh の再送、`disable-user`、パスワード変更、epoch ローテーションは、次のフレームを待たずにライブ接続を走査して該当するものを閉じるため、アイドル状態の socket もミリ秒単位で追い出されます。token の自然な期限切れはイベントを発生させないので、フレームごとと keepalive の検証が受け持ちます。
- クライアントはこの `4002` を待ちません。occ は access token の期限が切れる数分前に更新し、session-ingress 接続を滑らかに張り替えます（送信予定のメッセージを一時保持し、新しい socket へ流し込みます）。そのため長時間のセッションが 15 分ごとに強制切断されることはなくなりました。サーバー側のフレームごとの検証は変更していません。それがセキュリティ境界であり、クライアントがそれを更新の合図として使うのをやめただけです。本当の失効（ログアウト、アカウント無効化）では従来どおり接続が閉じられます。
- SSE ストリーム（Web UI の `/web/sessions/:id/events`、worker の `/worker/events/stream`、ACP channel-group の `/events`）も WebSocket と同じ検証を行います。イベント配信のたびと 15 秒ごとの keepalive で検証し、失効時は reason を含む `event: closed` を送ってからストリームを終了します。失効イベントによる能動的なクローズも同様に働きます。
- worker JWT は session の `worker_epoch` にバインドされ、サーバーは bridge 登録のたびにこれをローテーションします。ローテーション前に発行された token は、bridge の `/work/{ack,heartbeat}` 経路も含めて拒否されます。ACP channel-group のイベントバスはアカウント単位で分離され、他 tenant と同じ group 名でもイベントを共有しません。
- `disable-user` は 1 つのトランザクションで、そのアカウントの全 auth token を失効させ、environment を `deregistered` にし、work item の資格情報 digest を消去します。手元に残った environment 資格情報や work 資格情報でも、アカウント無効化後は poll・ack・heartbeat を続けられません。
- 保存される session イベントは `RCS_MAX_EVENT_BYTES` で上限がかかり、超過時はデータベースを無制限に増やす代わりに `413` を返します。資格情報と session の応答には `Cache-Control: no-store` が付き、サーバーログにメッセージ内容は含まれません。
- ブラウザー認証では、`Secure`、`HttpOnly`、`SameSite=Strict` の `__Host-rcs_session` cookie だけを使用します。pairing 資格情報は一度限りで短時間有効、URL fragment 内だけで運ばれ、アプリケーションの mount 前に削除されます。ブラウザーの ACP relay WebSocket は同じ HttpOnly cookie で認証されます。WebSocket の upgrade は same-origin policy と CORS preflight の対象外なので、**cookie で認証する upgrade にはさらに、リクエスト origin・`RCS_BASE_URL`・`RCS_WEB_CORS_ORIGINS` のいずれかに一致する `Origin` を要求します**（Bearer/JWT の upgrade は影響を受けません）。`NODE_ENV=production` では、`http://localhost:<port>` と `http://127.0.0.1:<port>` は `RCS_BASE_URL` 自身でない限り credentialed CORS を受け取りません。
- RCS はメールアドレスを収集せず、**メールによるリカバリはありません**。パスワードの復旧には管理者による `reset-password` が必要です。

### アカウント管理

本番イメージには管理 CLI が含まれています。RCS と同じコンテナおよびデータベースに対して実行します。

```bash
docker exec occ-rcs bun run dist/admin.js list-users
docker exec occ-rcs bun run dist/admin.js disable-user <username>
docker exec -it occ-rcs bun run dist/admin.js reset-password <username>
```

`reset-password` は TTY 上でマスクされた新しいパスワードを読み取り、確認入力を求めます。パスワードをコマンドライン引数で渡したり、shell history に残る方法で入力したりしないでください。パスワードは 12～128 文字です。`disable-user` はそのアカウントの有効な token を失効させます。メールまたはセルフサービスによる復旧経路はありません。

### バックアップ、リストア、secret のローテーション

SQLite データとデプロイ環境は一緒にバックアップします。

1. RCS を正常に停止し、WAL を checkpoint して、バックアップ中の書き込みを防ぎます。
2. `rcs.sqlite` と、残っている `-wal`/`-shm` sidecar を含む永続 `/app/data` volume 全体をバックアップします。
3. 保護された環境ファイルまたは secret-manager のエントリーを、厳しい権限を維持したまま別にバックアップします。バックアップを commit しないでください。
4. リストア時は RCS を停止し、data volume と対応する secret を戻し、所有者と権限を確認してから RCS を起動します。その後 `GET /health` とアカウントログインを確認します。

`RCS_TOKEN_PEPPER` を変更すると、既存のすべての opaque-token digest を検証できなくなります。アカウントと Argon2id password hash は残りますが、CLI の refresh/access 資格情報、ブラウザー cookie、pairing code、environment/work 資格情報は再発行が必要です。ユーザーは再ログインし、bridge は再接続または再登録する必要があります。`RCS_WORKER_JWT_SECRET` だけを変更した場合は有効な worker JWT が直ちに無効になり、実行中の worker は新しい JWT を取得して再接続する必要があります。どちらのローテーションもメンテナンス作業として計画し、以前の secret はロールバック方針に必要な期間だけ保持してください。

### RCS 0.1 から移行する

RCS 0.2 は既定でアカウントを使用し、`CLAUDE_BRIDGE_OAUTH_TOKEN` は通常のクライアント資格情報ではなくなりました。`CLAUDE_BRIDGE_BASE_URL`（または `OCC_REMOTE_CONTROL_URL` に書き換えたもの）はアップグレード後のサーバーを指したままにして、`/remote-control` からログインまたは登録します。最初のアカウントログインに成功すると、occ は設定済みの base URL を保持したまま、ローカルの旧 `CLAUDE_BRIDGE_OAUTH_TOKEN` 設定を削除します。

移行期間に旧クライアントを一時的に併用する必要がある場合は、`RCS_LEGACY_API_KEY_AUTH=1` と `RCS_API_KEYS` の両方を明示的に設定します。旧 API key クライアントはサーバー内部の互換 tenant を共有します。この tenant には公開アカウントのログイン入口がなく、公開アカウント tenant は見えません。公開アカウント側からもこの tenant は見えません。このモードは移行専用です。共有 key tenant を公開マルチユーザーサービスとして露出せず、すべてのクライアントをアカウントログインへ移行したら `RCS_LEGACY_API_KEY_AUTH` を `0` に戻してください。

旧 tenant の session が新しいアカウントへ自動的に割り当てられることはありません。アップグレード前にデプロイをバックアップし、必要な旧履歴は独立した管理上の保存判断として扱ってください。

## 組織ポリシーと診断

`allow_remote_control` が無効な場合、起動オプション、スラッシュコマンド、トップレベルサブコマンドはいずれも接続を拒否します。

```bash
occ autonomy status --deep
```

Remote Control セクションには、接続先の種別（`default (public server)` / `self-hosted` / `official (claude.ai)`）、base URL、資格情報の有無、entitlement の確認タイミングが表示されます。現在の REPL の接続とアカウントは `/remote-control status` で確認できます。サーバーの health endpoint は `GET /health` です。CLI の `--debug-to-stderr` または `--debug-file` で bridge 登録、session ingress、再接続ログを確認できますが、ログにパスワード、refresh/access token、pairing code、サーバー secret を含めてはいけません。

## 関連実装

- 現在のセッション用 hook：`src/hooks/useReplBridge.tsx`
- bridge 転送層：`src/bridge/`
- セルフホストサーバーと Web UI：`packages/remote-control-server/`
- `/remote-control`：`src/commands/bridge/`
- トップレベル環境コマンド：`src/bridge/bridgeMain.ts`
