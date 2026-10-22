# 個人用iPhoneアプリ：詳細計画・設計

作成日: 2026-10-22 / 調査対象: `235f329`（master）

**状態: 設計のみ。iOSプロジェクト・以下の新API・npm scriptsは未実装。**
今回の依頼は、提示された実装プロンプトを実行するための計画ファイルの作成。
以下のチェックリストは将来の実装作業であり、実装・テスト済みを意味しない。

## 1. 到達点と対象外

既存React画面を同梱したiOSアプリをXcodeでビルドし、本人のiPhoneへ無料Apple AccountのPersonal Team署名でインストールする。ホーム画面から独立起動し、学習時にSafariを開く必要をなくす。認証時だけOSが管理する外部認証画面を利用する。

既存Google Cloudプロジェクト `vocab-trainer-490014`、Cloud Run、Firestore `vocab-database`をそのまま利用する。Web版と同じAPI・保存ドキュメントを使い、学習データのコピー、移行、所有者構造の変更を行わない。現在はメール許可リストによるアクセス制御で、ユーザー別データベースではない。

対象外: App Store/TestFlight配布、有料登録の必須化、Android、通知、オフライン学習、バックグラウンドでの継続学習処理、学習データの端末永続化。署名更新時にMacが必要な点を利用手順に明記する。

## 2. 調査した現行構成

| 根拠 | 確認内容・設計への影響 |
| --- | --- |
| [AGENTS.md](../AGENTS.md)、[README](../README.md)、[開発リファレンス](../docs/development-reference.md) | backend/frontend別npm構成。WebとiOSを同じAPIへ接続する。エミュレーターで検証する |
| [package.json](../frontend/package.json)、[Vite設定](../frontend/vite.config.ts) | React 19 / Vite 6。Capacitorは未導入。開発時は `/api` を3000番へproxy |
| [nginx](../frontend/nginx.conf.template) | 本番Webも同一originの `/api/` をbackendへproxy。ストリームbuffering無効、timeout 660秒 |
| [認証ルート](../backend/src/routes/auth.ts)、[認証設定](../backend/src/auth-config.ts) | Google code flow + state/PKCE。30日Cookieと10分OAuth transaction Cookie。callbackはfrontendのHTTPS URL |
| [API認証・CORS](../backend/src/index.ts) | Cookie検証、メール許可リスト再確認。`capacitor://localhost`は現在許可されない。認証設定の読込失敗は起動停止 |
| [認証UI](../frontend/src/auth/context.tsx) | `/api/auth/me`を直接fetch、ログインは `window.location.href`。そのままではWebView内Google認証になる |
| [API client](../frontend/src/api/client.ts) | 相対URL + `credentials: include`。401通知とHTTP/通信エラーの区別を共有 |
| [翻訳](../frontend/src/api/translation.ts)、[作文](../frontend/src/api/speaking-writing.ts)、[取り込み](../frontend/src/api/import.ts)、[語彙](../frontend/src/api/vocab.ts) | 共通JSON関数を通らないfetchがある。翻訳等はReadableStream。取り込みjob監視はCookie付きEventSource |
| [回答キュー](../frontend/src/utils/answerOutbox.ts)、[hook](../frontend/src/hooks/useAnswerOutbox.ts) | module内メモリーの直列キュー。401は現在非再試行エラーとして破棄。beforeunload警告があるがiOS強制終了を防げない |
| [Live Group B](../docs/live-group-b-quiz.md) | mixedのA snapshot/B live reconciliation、削除＋採点の原子性、review境界などを維持 |
| [main.tsx](../frontend/src/main.tsx)、[index.html](../frontend/index.html) | BrowserRouter。viewport-fit未設定。再起動時のルートとsafe areaを確認する必要がある |
| [deploy.sh](../deploy.sh) | backend/frontend双方をCloud Runにデプロイする。iPhoneへはインストールしない |

本番の認証設定・学習データは今回未読・未検証。`.env`や証明書の内容は表示していない。

### 2.1 Macの実測と前提

- Node: `v25.8.1`。再現性のため実装時の検証はコンテナーと同じNode 24へ揃える。
- `xcode-select -p`: `/Library/Developer/CommandLineTools`。標準の `xcodebuild` / `xcrun simctl` は利用不可。
- `/Applications/Xcode.app` は存在。`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -version` は **Xcode 27.0 / 27A266a**。
- 同じ `DEVELOPER_DIR` での `xcrun simctl list runtimes` は規約未同意のメッセージを返す。ランタイム導入状況は未確認。規約同意を代行していない。
- Docker CLIとDocker.appは存在するが `docker info` はdaemon接続失敗。gcloud CLIは存在。Google Cloudログイン有効性は未確認。
- Apple Account、Personal Team、署名証明書、iPhone接続・OSバージョンは未確認。

実装者は規約同意・Appleログインが必要な時だけ本人へ具体的な画面を案内し、それ以外のコード・モックテスト・文書作成を継続する。認証コードやパスワードは取得しない。

## 3. 方式選定

| 方式 | 評価 |
| --- | --- |
| **Capacitor + ビルド済みReact同梱** | 採用候補。画面・API・回答キューを共用でき、XcodeプロジェクトとSwift bridgeを追加できる |
| SwiftUI / React Nativeへの移植 | UI全面移植とクイズ挙動の二重実装になり、今回の目的に対して変更範囲が大きい |
| WKWebViewで公開サイトを表示するだけ | Cookie共有や外部認証復帰の課題が残り、端末用調整も必要。remote URLを起動先にするだけの構成は採用しない |
| PWA | ユーザー要件から対象外 |

Capacitor 8系の安定版を第一候補とし、core/cli/ios/pluginの互換バージョンを揃えてlockfileへ固定する。公式v8資料の条件はNode 22以上、Xcode 26以上、iOS 15以上。調査MacのXcodeはバージョン条件を満たすが、本人のiPhone対応は未確認。実装開始時に安定版・プラグイン・Xcode 27との実ビルドを再確認し、未検証のnext版を無条件導入しない。

最初の技術検証で「同梱画面 → emulator API → 少量ずつ届くストリーム」を成立させ、外部認証bridgeのcallbackもモックで確認してから全面適用する。失敗時は原因と代替を記録し、有料サービスやネイティブHTTPへの全面切替を黙って行わない。

## 4. ディレクトリ・ビルド・接続先

新規予定:

```text
frontend/capacitor.config.ts
frontend/ios/App/App.xcodeproj        # SPM採用時の予定。生成結果で確定
frontend/ios/App/App/                 # Info.plist、assets、Swift bridge等
frontend/src/platform/               # 環境判定、認証、lifecycle adapter
frontend/src/api/transport.ts         # URL解決、認証ヘッダー、共通fetch
frontend/.env.ios.example             # 公開接続情報だけ
backend/src/routes/mobile-auth.ts
backend/src/mobile-auth-store.ts
backend/src/mobile-auth.test.ts       # 純粋ロジック
backend/scripts/tests/mobile-auth-*.test.ts # 注入・mock storeルート検証
frontend/src/platform/*.test.ts
frontend/src/api/*.test.ts
docs/ios-personal-app.md              # 確定したビルド・実機・更新手順
```

root npm packageは追加せず、Capacitor依存もfrontendで管理。SPMを第一候補にし、採用pluginがCocoaPods必須の場合のみworkspace構成へ変更して手順を更新する。Xcodeプロジェクト、共有scheme、依存lockは追跡し、DerivedData、ビルドされたWeb assets、個人の署名設定、xcuserdata、秘密情報は追跡しない。

| ビルド | UI | APIと認証 |
| --- | --- | --- |
| Web dev | 既存Vite | 相対 `/api`、emulator backend、既存Cookie |
| Web本番 | 既存dist/nginx | 相対 `/api`、既存Cloud Run backend、既存Cookie |
| iOS検証 | `dist-ios`同梱 | 明示したローカルAPI origin、emulator/mock認証 |
| iOS本番 | `dist-ios`同梱 | 既存frontend HTTPS originの `/api` 経由、Bearer認証 |

iOSのAPI originは既存frontendのcanonical HTTPS URLを第一候補とする。これでGoogle callbackの既存登録とnginxのストリーム設定を利用できる。backend直接URLへ変更する場合はCORS・callback・運用手順を別途検証する。

`VITE_API_ORIGIN`、`VITE_AUTH_ORIGIN`等は公開情報のみ。`webDir: dist-ios`、iOS originは `capacitor://localhost`。releaseに `server.url` やHTTP/任意originを含めない。Viteのmode別outDirを設定し、iOSビルドがWeb用distを上書きしないようにする。

追加予定のscripts（現時点では実行不可）:

- `npm run build:ios --prefix frontend`: 型検査・接続先検査・iOS用Viteビルド。
- `npm run ios:sync --prefix frontend`: 同梱assets生成後に `cap sync ios`。単なる古いdistコピーを防ぐ。
- `npm run ios:open --prefix frontend`: `cap open ios`。
- local用は明示的な別mode/script。release artifactでローカル接続先混入を検査。

シミュレーターのlocalhostと実機のlocalhostを区別する。実機のローカル検証にはMacのLANアドレス・到達性が必要。HTTP/ATS例外やローカルネットワーク権限はDebugに限定し、ReleaseのHTTPS要件を緩めない。

## 5. 認証設計

### 5.1 方針

Webは現行Cookieを継続。iOSは **ASWebAuthenticationSessionによる外部認証 + 一回限りのコード交換 + アプリ用Bearer session** とする。Swift bridgeでOSの認証セッションを保持・完了・キャンセルし、WKWebView内でGoogleのページを開かない。通常のSafari CookieをWKWebViewへコピーする方式やSameSite変更には依存しない。

既存のWeb OAuth clientとHTTPS callbackを利用するserver broker方式を第一候補とする。Googleからcustom schemeへ直接redirectさせず、Google → 既存HTTPS callback → アプリへの一回コード、という二段階に分ける。実アカウントでのGoogle許可・callback復帰は独立した実機受け入れ項目。brokerが対応不能と判明した場合は同一Cloudプロジェクト内のiOS OAuth client + Google Sign-In SDK方式を再設計し、Bundle ID/audience/署名検証を確定する。

### 5.2 フローとAPI契約（新規予定）

1. アプリは暗号学的乱数のverifier、stateを生成。一時verifier/stateはnative側で保持し、S256 challengeのみ送信。
2. `POST /api/auth/mobile/start` にchallengeとstateを渡す。serverは固定のアプリcallbackを選択し、10分有効のtransactionを作成。応答の認証開始URLは設定済みHTTPS originに限定。
3. SwiftがASWebAuthenticationSessionで開始URLを開く。serverは外部ブラウザー用OAuth transaction Cookieを発行し、Googleへredirectする。Google用PKCEとアプリ受取用PKCEは別物として保存・検証する。
4. Googleの既存HTTPS callbackでstate、Cookie、PKCE、ID tokenのissuer/audience/expiry/verified email、許可メールを確認。mobile transactionとの対応も検証する。Web開始分は従来どおりWebへ戻す。
5. mobile開始分は60秒有効の一回コードを生成し、固定callback（例 `jp.personal.vocabtrainer://auth/callback`、最終名はBundle IDと一緒に確定）へ `code` とstateだけ渡す。Bearer/Google token/verifierはURLに載せない。
6. native側でscheme/host/path/stateを完全照合。`POST /api/auth/mobile/exchange` でcodeとverifierを送信し、serverがS256検証とcode消費をFirestore transaction内で原子的に行う。同じcodeの再利用は拒否する。
7. 応答の不透明なランダムBearer tokenをKeychainに保存。アプリ再起動時に読み、`/api/auth/me`で有効性を確認してから学習画面を表示する。
8. キャンセル・期限切れ・callback前のプロセス終了は安全にログイン画面へ戻す。中断transactionの自動復元は必須にせず新しいログインを開始する。

mobile endpointsは現状のpublic auth prefix配下になるため、各endpoint自身で入力schema、期限、認証、レート制限を実装する。任意return URLは受け付けない。start endpointの乱用制限はCloud Run複数instanceでも有効な方式を選び、メモリーだけの制限を完全な対策と扱わない。

### 5.3 保管・期限・失効

- 学習データとは別に `mobileAuthTransactions` と `mobileAuthSessions`（仮名）を追加。学習データ移行は不要。機密token平文はFirestoreに保存せずSHA-256 hashで検索する。
- sessionは固定30日期限を初期案とする。自動refresh tokenは今回追加せず、期限後は再ログイン。server側にexpiresAt/revokedAtと検証済みuserを保存する。
- expirationは毎回アプリケーションで判定。Firestore TTLは後片付けにのみ使用し、削除遅延でcode/sessionが有効にならないようにする。TTL設定が必要なら明示的なインフラ作業として扱う。
- Keychainはアプリ固有・端末のみ・ロック解除時利用。iCloud同期やKeychain Sharing capabilityを必須にしない。localStorage、Preferences、URL、ログへtokenを保存しない。
- WKWebView fetch用のBearerは必要時にnative bridgeから取得し、JSではメモリーだけで扱う。XSS時の利用リスクが残るので、外部サイトのWebView遷移を禁止し、HTML表示箇所・CSP・bridge公開範囲を確認する。
- native logoutはserver session失効後にKeychain削除。通信失敗時は端末だけログアウトできるがserver失効未確認と表示し、成功を偽らない。
- CookieとBearerの共通認証関数をAPI hookと `/me` に適用。Authorizationがあれば必ず検証し、無効BearerをCookieで救済しない。メール許可リストの確認と設定読込失敗時の起動停止を維持する。
- session/一回コード/Authorization/Cookie/queryのログredactionを設定し、認証エラーでも機密レスポンスを出力しない。

## 6. API・ストリーミング

`transport.ts`でURLと認証を統一する。Webは相対URL + Cookie、iOSは固定HTTPS API origin + Authorization、`credentials: omit`。Bearerは許可API origin以外に送らず、任意絶対URLや他originへのredirectを拒否する。

CORSは既存Web originsを保持して正確な `capacitor://localhost` を追加。Authorization/Content-Typeと必要method、認証なしOPTIONS preflightをテストする。`ALLOWED_ORIGINS`が環境で上書きされるため、コード既定値変更だけで本番反映済みと判断しない。ワイルドカードや `null` origin許可は使わない。

全fetch（認証、語彙lookup、翻訳、作文、import streamを含む）を棚卸ししてtransportに統合。AbortSignalとReadableStreamを保持し、CapacitorHttpによるfetch全面patchは無効のまま開始する。完了後一括応答をストリーミング成功と扱わない。

**EventSourceには任意Authorizationヘッダーを付けられない。** import job監視はiOSでfetchベースのSSE readerへ切替え、既存hookに接続できるsubscription interfaceへ抽象化する。Web側の既存EventSource挙動は維持可能。tokenのquery string化はしない。

SSE parserは分割UTF-8、CRLF、複数data行、コメント、event/id、途中切断、EOFを扱い、購読解除とAbortを提供。再接続では保存済みjob状態を取得し、既存serverが対応する場合のみLast-Event-IDを送る。イベント再送で解析開始POSTを重複送信しない。副作用のある翻訳/作文POSTも途切れたという理由だけで自動再実行しない。

## 7. 回答同期・中断復帰

学習状態はFirestore、回答待ちは既存直列メモリーキューのまま。iOS専用の別キューやlocalStorageバックアップは追加しない。全variantの採点・復習・重み更新を同じ順序制約で扱う。

1. `appStateChange`でforeground復帰を検知。多重イベントをまとめ、認証確認 → 既存flush → キュー完了/失敗判定 → session再取得の順で処理する。
2. pending中に再取得した古いserver sessionで楽観UIを上書きしない。offline時は再取得・復帰を完了扱いにしない。401/403、404、通信失敗、409競合を区別する。
3. 現状401はキューから破棄されるため、再認証可能な401を「先頭を保持して停止」へ変更する。認証回復後だけ同じoperationを再開。403等の恒久拒否は既存失敗通知へ送る。変更はWebにも回帰テストする。
4. `startedAt` / `operationId`を再試行で作り直さない。mixedの削除＋採点＋receiptの原子性、レビューrevision、ID単位hydrateを維持する。全variantが冪等だとは仮定せず、transport層でPOSTの独自自動再送を追加しない。
5. mixed再開時は選択A snapshotとlive Bをserverで再整合。B優先、B重み1、明示削除後のA継続、Wrongの次sitting延期、完了session不再開を維持する。
6. background移行時のflushはbest effort。停止前に完了する保証はない。未送信件数・同期失敗・「同期完了まで終了しない」表示を英日韓で提供する。iOSではbeforeunloadに頼らず常時見える同期表示を使う。
7. 強制終了/OSによるWebView破棄後は未送信分を復元できない。起動時は最後のserver確定状態から再開し、この制約を明示する。端末強制終了後も未送信回答を必ず保全する要件は、今回対象外の永続キュー設計を別途必要とする。

## 8. iPhone操作・ライフサイクル

- viewportに `viewport-fit=cover`、header/footer/modalに `env(safe-area-inset-*)`。二重余白を避けてノッチとHome indicatorを確認。
- `100dvh`と適切なfallback、スクロール領域のmin-height、固定footerを確認。日本語IME、予測変換、ソフトキーボード表示中も入力・保存・回答ボタンに到達できるようにする。
- Keyboard pluginは必要な箇所だけ使用し、native resizeとCSS補正を重ねない。小型画面、横向き、文字サイズ拡大、長文モーダル、ドラッグ操作を確認。
- 外部リンクはOSブラウザーへ。認証は専用ASWebAuthenticationSessionへ。アプリ内部ルートを外部URLから任意指定させない。
- BrowserRouterは初期動作を確認して継続を第一候補とする。local originのhistory fallbackで問題が出る場合はiOSだけHashRouterにし、Web URLを変更しない。
- cold start・通常復帰・認証callbackを分離。callback二重通知は一回だけ処理。lifecycle listenerは解除し、React StrictModeで二重flush/二重購読しない。
- ストリームは中断を検知し途中状態を表示。既存永続jobは状態再取得で監視再開し、background実行保証を表示しない。

## 9. 実装順序と完了条件

| 段階 | 実施内容 | 完了条件 |
| --- | --- | --- |
| P0 環境・基準 | branch/差分、参照資料再確認、Node 24、Xcode、Docker、mock fixture準備 | 秘密情報を出さずツール状況を記録。既存テスト基準を取得 |
| P1 最小iOS | Capacitor/SPM追加、同梱React、local API、CORS、ストリームprobe | simulator buildとローカル疎通、逐次chunk到着。実行不能なら原因を記録してコード検証継続 |
| P2 認証 | broker、transaction/session store、Keychain、OS認証bridge、Web互換 | mockで成功・拒否・期限・replay・復帰を検証。実Googleは別記 |
| P3 全通信 | transport、直接fetch棚卸し、SSE adapter | 全API種別が認証付きで動作。Web Cookie回帰なし |
| P4 同期とUI | 401停止再開、lifecycle、safe area、keyboard、3言語 | mock/emulatorで直列性・review・mixed再開維持 |
| P5 検証・手順 | 全自動チェック、可能なsimulator試験、実機手順文書 | 成功/失敗/未実施を証拠付きで分離 |
| P6 配備 | commit、push、Cloud Run deploy、本人の署名と実機Run | push/deploy/端末installの結果を別々に報告 |

本人操作でP1/P2が止まっても、認証ロジック、transport、モックテスト、文書作成は進める。実装を開始した回は計画提示だけで終了せず、実施可能な作業を完了する。

## 10. 検証計画と受け入れ基準

開発・自動テストはemulator/mockだけ。認証fixtureはダミーの許可メールと鍵。`.env`の本番キーを使わずLLMはmock。local.shは初回production seed読取を行い得るため挙動を確認し、既存の安全なsnapshotまたは合成fixtureを使う。`seed:load`はemulatorのみを対象にする。`FIRESTORE_EMULATOR_HOST`を`.env`へ永続化しない。

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:mixed --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
```

新しいmobile-auth route testsは専用scriptを追加し実行する（`backend/src/*.test.ts`だけではscripts配下を実行できない）。import監視を変更した場合は `npm run test:import --prefix backend` と関連frontend hookテストも実行する。Docker利用可能なら既存構成のemulator smokeを実施する。

| 分類 | 必須ケースと合格条件 |
| --- | --- |
| 認証server | state/challenge不正、code期限・再利用・並列交換、別instanceで交換、メール不許可、失効Bearer、設定読込失敗を拒否。WebログインとCookie logout継続 |
| 認証端末 | 外部画面→アプリ復帰、キャンセル、二重callback、不正scheme/path/state、起動し直し、30日期限を時刻mock、Keychain削除 |
| CORS/機密 | preflight正常、未許可origin拒否、tokenの外部送出なし、ログ/生成bundleにサーバー秘密情報なし、releaseにHTTP例外なし |
| ストリーム | 全文完了前に複数chunk表示、UTF-8境界、401、切断・abort、SSE再購読後にイベント重複で状態破壊しない |
| 回答 | 連打・遅延・ネットワーク断・401→再認証で順序維持。同一operation再送。エラーが履歴やreview境界を消さない |
| mixed | live B増減、削除＋Correct/Wrong、A snapshot外削除、重み0、自然完了、review再開、404と通信失敗の区別 |
| 共有 | emulatorへWebで保存したitemをiOSで表示。iOSで回答後Webで同一sessionを確認。競合は既存revision規則で検出 |
| 操作 | safe area、IME、長文スクロール、modal、横向き、ホーム→復帰、画面ロック→復帰、冷起動 |
| 制約 | 強制終了後はserver確定分のみ。未送信保全を保証しない旨が画面・文書にある |

Xcode操作が可能になった後のコマンド例（project/scheme/runtimeは生成・列挙結果で確定）:

```bash
cd frontend
npm run ios:sync
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -list -project ios/App/App.xcodeproj
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices available
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project ios/App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/vocab-trainer-ios-derived CODE_SIGNING_ALLOWED=NO build
```

生成.appを選択したsimulatorに `simctl install`、Bundle IDで `simctl launch` して上表を確認。simulator build成功は実機署名/Googleログイン成功を意味しない。各結果に実行日・commit・Xcode/iOS・接続先種別・コマンド結果を記録し、認証値や端末識別子は公開しない。

## 11. 本人向け手順の完成形

この節を実装後に確定値・実際の画面で検証し、`docs/ios-personal-app.md`へ移す。READMEと開発リファレンスからリンクする。現在はプロジェクトが存在しないため、以下のiOS用npm scriptsはまだ使えない。

### 11.1 初回準備とインストール

1. Macで `/Applications/Xcode.app` を開き、本人が規約を確認して同意、要求される追加コンポーネントを導入する。Xcode Settings → Locations → Command Line ToolsでXcodeを選択。Settings → Componentsで必要なiOS Simulatorを導入する（表示名は版で確認）。
2. Xcode Settings → Accounts（版によってApple Accounts）→ Apple Accountを追加。パスワード・2FAはAppleの画面に直接入力する。
3. `npm ci --prefix frontend`、実装済みの `npm run ios:sync --prefix frontend`、`npm run ios:open --prefix frontend`。予定のプロジェクトは `frontend/ios/App/App.xcodeproj`。CocoaPods採用なら `.xcworkspace`を開く。
4. XcodeのApp target → Signing & Capabilities → Automatically manage signingを有効にし、自分のPersonal Teamを選択する。固有Bundle Identifierを確定し、callback schemeの設定と一致させる。不要な有料capabilityは追加しない。
5. iPhoneをMacへ接続して双方の「信頼」に応答する。iPhoneの設定 → プライバシーとセキュリティ → デベロッパモードを有効化し、要求される再起動・確認を本人が行う。
6. Xcodeで接続したiPhoneを実行先に選びRun。端末が開発者の信頼を求めた場合は設定 → 一般 → VPNとデバイス管理で本人の開発者項目を確認する。
7. ホーム画面から起動しGoogleログイン。許可されたGoogleアカウントを本人が選ぶ。学習データ変更を伴う受け入れはローカル検証ビルドで行う。本番接続では最初は認証・一覧・既存履歴の読取までとし、自動で回答やCRUDを実行しない。

### 11.2 無料署名の更新

Personal Teamのprovisioning profileは発行から7日で期限を迎える。期限後はMacに接続し、同じApple Account/Team/Bundle IDでXcodeを開いて再ビルド・Runし、署名を更新して再インストールする。有料登録やApp Store提出は不要。

不要にアプリを削除しない。同じIDで上書きすることを基本とするが、Keychainやログインの維持は環境によるため再ログイン手順も用意する。学習履歴はFirestoreのため再インストール用にコピーしない。未送信キューは再インストールで保全できないので、実施前に同期完了を確認する。

### 11.3 Web側を変更した場合

Web UIはアプリ内に同梱されるためCloud Run更新だけではiPhoneのUIは更新されない。変更を取得 → frontend依存インストール → チェック → `ios:sync`（新しいiOS assets生成を含む）→ Xcodeで同じTeam/Bundle IDへRunする。native/plugin変更時もsyncして依存更新を反映する。

backend変更はCloud Runへ別途deployする。端末に旧UIが残る期間があるので既存APIとの後方互換を維持する。アプリ内にbuild version/commit識別情報を用意すると確認しやすい。OTA更新やremote UI配信は今回追加しない。

## 12. commit・push・deployと切り戻し

AGENTS.mdに従い、変更前後にbranchと作業treeを確認。master以外ならpush先を本人に尋ね、無関係な変更を含めない。意図したファイルだけcommitし、`git push origin master`の完了を確認してから `./deploy.sh` を実行する。push失敗とdeploy失敗を分けて記録する。

今回の文書作成にも同じ配送規約を適用する。ただしDocker daemon不通などの前提不足時はdeploy未実施と記録する。計画作成の完了はiOS実装完了ではない。

将来の実装配備ではbackendの追加互換APIを先に公開し、Web回帰を確認してから端末版をインストールする。通常はconfig upload flagsなし。認証origin等の設定変更が必要な場合は値の種類と差分を特定し、ユーザーが依頼した範囲だけ変更する。`--auth`で既存config全体を不用意に上書きせず、ローカル設定が完全かを確認する。学習データのbulk migrationは行わない。

切り戻しは既存Web APIを維持したCloud Run revisionへの復帰と、前のcommitからのiOS再ビルドを別々に行う。mobile認証に問題がある場合はmobile sessionを失効・入口を停止できる設計にする。追加auth metadataを理由に学習データを削除しない。旧backendへ戻すとmobile認証が使えなくなる場合は端末側に再試行可能なエラーを出す。

## 13. 最終報告チェックリスト（将来の実装担当用）

- [ ] 採用方式と変更ファイル、実装できた機能を説明
- [ ] 各テスト・iOS build・simulator操作の成功/失敗/未実施を区別
- [ ] Xcodeで開く実在するproject/workspaceとschemeを記載
- [ ] 初回実機install・7日後の再署名・Web更新後の端末更新を文書化
- [ ] Apple規約同意・ログイン・端末接続等、残る本人操作を具体的に列挙
- [ ] Google実アカウント認証・実機復帰・キーボード等、未確認項目を明記
- [ ] 本番学習データをテストで変更していないことを確認
- [ ] commit hash / push / Cloud Run deploy / iPhone installを別々に報告

## 14. 公式資料（2026-10-22参照）

- [Capacitor環境要件](https://capacitorjs.com/docs/getting-started/environment-setup): 採用versionのNode/Xcode条件とSPM。
- [Capacitor 8移行要件](https://capacitorjs.com/docs/updating/8-0): iOS deployment target等。
- [Capacitor App](https://capacitorjs.com/docs/apis/app): lifecycle・custom scheme。
- [Capacitor HTTP](https://capacitorjs.com/docs/apis/http): fetch patchは既定無効。今回のstream維持方針の確認用。
- [Google native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies): 埋め込みuser-agentを避ける要件。
- [Apple ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession): OS管理の認証セッション。
- [Apple Personal Team](https://developer.apple.com/help/account/basics/about-your-developer-account): 無料実機テスト、7日provisioning期限、再ビルド・再インストール。

外部仕様は実装時に再確認する。上記を参照した設計判断と、リポジトリの実装事実・実機確認結果は区別する。
