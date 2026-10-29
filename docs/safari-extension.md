# Safariで選択した中国語を読む

実装・検証日: 2026-10-29。Web/backendの配備と、Safari拡張の署名・インストールは別の作業です。**macOS/iPhone/iPadのSafariでの実機受入は未完了**です。以下のビルド成功は、Safariでのサイト許可・通信・Keychain動作を実証したものではありません。

## 使い方

1. 下記のXcodeプロジェクトからホストアプリとSafari拡張をインストールします。Safari設定で拡張を有効にし、読むサイトへのアクセスを許可します。
2. 拡張のツールバーで「Safari拡張を接続」を押します。既存Web版でGoogleログインし、自分の拡張に表示された接続コードと一致することを確認して接続します。拡張に戻ると約10秒以内に承認を確認します。
3. HTTP(S)ページの本文から中国語を選択し、近くに出る「分析」を押します。選択だけでは解析サービスへ送信しません。
4. 初回はパネルで、選択部分を送信して外部ソースに保存する説明を読みます。出典名・HTTPSリンクの送信有無、解説言語、A/Bの登録先を確認して「解析」を押します。初回確認後はページ上の「分析」で開始します。パネルの設定で毎回確認する動作に戻せます。出典名・リンクの送信有無も次の選択に引き継ぎます。
5. 保存済みの文を選ぶと詳細解説と意味のまとまりを取得します。単語・構文の詳細から既存のA/B登録ボタンを使います。分析だけで辞書へ登録されることはありません。Bグループを出典名から自動作成することもありません。
6. パネルを閉じても初回解析ジョブはサーバーで続きます。拡張ツールバーの保存済み一覧、またはWeb版の外部ソースから再表示できます。「専用タブで開く」は保存完了後に同じソースを別タブへ移します。閉じる操作と解析の一時停止は別です。

パネルを埋め込めない場合は、同じ選択・操作を専用拡張タブで開きます。iframeにはWeb版の本番ページを埋め込まず、拡張同梱のReact画面を使用します。Safariで拡張HTMLの埋め込みとnative messagingが成立するかは、下記の未検証項目に含まれます。

単語登録・保存中は閉じる操作を無効にし、ページを開いておく案内を出します。ページ自身の遷移・タブの強制終了によるiframe破棄は防げません。登録後の再表示では既存のlibrary照合・登録回復を使い、未確認の登録を成功扱いしません。文の詳細解説は既存のクライアント受信・保存方式であり、初回解析ジョブと同じ継続保証はありません。

## 対象と制限

| 項目 | 実装対象・検証境界 |
| --- | --- |
| macOS | 専用ホストと拡張target。プロジェクト最低macOS 14。Xcode 27.0で署名なしDebug build成功。実機Safari受入は未実施 |
| iOS / iPadOS | 同じWeb資産を使う専用ホストと拡張target。最低17。Simulator向けbuild成功。iPhone/iPad実機受入は未実施 |
| 既存iOSアプリ | Capacitorプロジェクト・署名・同期を変更しない。App Groupsや既存アプリとのKeychain共有は不要 |
| 言語 | 学習言語は`chinese`固定。繁体字・簡体字・絵文字・改行を選択文字列のまま渡す。UIは英語・日本語・韓国語 |
| 本文 | 8,000 UTF-16 code unitsまで。超過時は切り捨てず再選択を案内 |
| ページ | top frameの通常HTTP(S)本文。入力欄、password、textarea、contenteditable、PDF、canvas、画像、iframe内の選択、ブラウザ内部ページは対象外 |
| Reader / Private Browsing | 対応未確認。サイト許可とSafari側の拡張許可も必要 |

サイトCSP、縦書き、zoom/visualViewport、iOSの選択ハンドル・標準メニュー、回転、Private Browsing、復帰時の送信元情報とCORSは、実機で確認する必要があります。最低OSはビルド設定であり、動作確認済みの最低Safariバージョンを示しません。

## ビルドとインストール

Node 24、frontendの依存、Xcodeが必要です。rootのnpm packageはありません。

```bash
npm ci --prefix frontend
npm ci --prefix extensions/safari
npm run build --prefix extensions/safari
open 'extensions/safari/apple/Vocab Safari/Vocab Safari.xcodeproj'
```

`Vocab Safari (macOS)`または`Vocab Safari (iOS)` schemeを選び、本人のTeamとBundle IDで署名してRunします。iOSは端末を接続して信頼・Developer Modeを確認します。macOSはSafari設定の拡張機能、iOS/iPadOSはSafariの拡張機能設定から有効化し、必要なサイトへのアクセスを許可してください。署名設定はローカルで保持し、証明書・profile・個人のTeam設定をコミットしないでください。

XcodeがCommand Line Toolsを指している場合のビルド例:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project 'extensions/safari/apple/Vocab Safari/Vocab Safari.xcodeproj' \
  -scheme 'Vocab Safari (macOS)' -configuration Debug \
  -derivedDataPath /tmp/vocab-safari-mac CODE_SIGNING_ALLOWED=NO build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project 'extensions/safari/apple/Vocab Safari/Vocab Safari.xcodeproj' \
  -scheme 'Vocab Safari (iOS)' -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/vocab-safari-ios CODE_SIGNING_ALLOWED=NO build
```

生成済みAppleプロジェクトは`extensions/safari/dist`を相対参照します。Web資産の変更後にbuildを実行してからXcodeでbuildします。`npm run apple --prefix extensions/safari`は新規プロジェクト生成用です。既存のカスタムKeychain handlerを上書きしないでください。

本番API originは既存frontendの固定HTTPS originです。production manifestにlocalhostや任意のAPI originを追加しません。CORSのワイルドカード化やSafari全originの一括許可も行いません。

## 認証とメッセージ境界

- `/api/auth/extension/start`がS256 challenge/state付きの10分間の接続要求を作ります。Web Cookieで`request/:id`を確認し、同一originの明示的な`approve`を行います。ログインがrootへ戻る間は、短命なrequest IDだけをsessionStorageに保持します。
- `exchange`はPKCE/stateを検証し、Firestore transactionで要求の消費と30日トークン作成を一度だけ行います。応答を失った場合は新しい接続が必要です。トークンは`ext_`で既存mobile Bearerと区別し、サーバーにはハッシュのみを保存します。
- backgroundがnative messaging経由で、拡張専用・Safari profile別のKeychain領域を使います。`storage.local`/`storage.sync`やWeb Cookieの読み出しを使いません。native handlerにtoken/messageのログ出力はありません。Keychainの実機往復とprofile分離は未検証です。
- content scriptには選択・表示制御だけを許可します。選択はsenderのtab IDとtop frameで照合します。iframeには公開context IDに加えて、content scriptから対象iframeへoriginを指定した`postMessage`で渡す別のbind secretが必要です。backgroundは送信元extension URL、tab/frame、contextを照合します。親ページ由来の汎用APIメッセージは受け付けません。ツールバーもbackgroundが作成したcontext付きタブを開きます。公開panel.htmlを直接開いただけでは権限を取得できません。
- 許可APIは`backend/src/extension-routes.json`に定義し、同じ表をbackground bundleへ組み込みます。Chinese import、単語/文法smart-add・失敗時draft回復、グループ参照/作成/所属追加、文法設定参照に限定します。所属削除はbackgroundとサーバーの双方で拒否します。quiz・数学・管理設定変更は許可しません。詳細payloadはbackgroundの形状検証と既存APIのvalidationを通します。
- メールallowlistと期限を毎回確認します。認証設定・保存領域の読取失敗は認証無効へ切り替えません。401でtokenを削除し、再接続画面を表示します。登録POSTを自動再送しません。

Web版ホームの「Safari拡張の接続管理」で自分の接続を個別解除できます。Webログアウトと拡張解除は別です。端末の「拡張の接続を解除」はサーバーを失効させてから、そのprofileの一時データと接続情報も削除します。通信断では失効成功を表示しません。

Firestoreの新規collectionは`extension_auth_requests`、`extension_auth_sessions`、`extension_auth_limits`です。IP単位15要求/分、未失効の接続要求は全体100件までに制限します。読み取り時の期限判定が正で、新規接続開始時に各collectionから最大25件の期限切れデータを削除します。接続開始がなければ失効済みメタデータの物理削除は遅延します。TTL設定や既存データの移行は不要です。

## 保存と再接続

`sourceOrigin.method = safari-selection`をbackend/frontendの両方で追加しました。既存originや旧ソースはそのまま読めます。originは作成時だけ設定し、PUTでは変更しません。HTTP出典はURLを省略し、HTTPSに変換しません。URLのuserinfo/query/fragmentは削除し、サーバーによるURL先の取得は行いません。

凍結要求・UUID ingestion ID・job key・session ID等をKeychainに最大24時間保持します。作成成功後は本文と凍結要求を削除し、session IDによる再接続へ移ります。期限切れ要求を自動再送しません。同一操作の再試行は同じ本文・出典・ingestion IDを使い、409/410を新規作成へ置き換えません。保存済みソースはFirestoreの一覧から再表示できます。

作成後に既存analysis-job APIでジョブを明示的に開始します。Reactの共通transportにextension RPC adapterを注入し、global fetchの置き換えはしません。初回解析は非表示時に停止するGET pollingとbackoffを使います。詳細解説は既存UIで必要な文だけ生成し、backgroundで同時実行を1件に制限します。候補・登録・library照合・autosaveは既存の共通処理です。

## 検証記録

2026-10-29:

- Node 24.22.2でbackendの127 unit testsとimport route tests9件を確認。backend buildと127 unit tests、frontend型検査と118 unit tests、通常Web build・既存iOS Web build・拡張build: 成功。
- 拡張のpure/message境界テスト7件: 成功。偽sender、frame/tab不一致、bind secret、token非公開、任意API拒否、凍結要求、期限、UTF-16境界、URL除去を確認。
- Playwrightの取り込み・修正・capture・拡張の46件: 成功。新規3件はDOM選択→明示クリック、パネル→既存durable job→遅延詳細解説→autosaveとWeb承認のログイン復帰・明示承認を確認。拡張部分はmock runtimeです。Safari拡張ランタイムを使ったテストではありません。
- import route tests9件、既存import emulator tests16件、新規拡張認証emulator test1件: 成功。別インスタンスからの同時approve/exchange、PKCE/state、失効、所有者チェック、期限、rate limitを確認。
- Docker Composeで既存emulatorデータを保持したままbackend/frontend/workerをbuild・起動。Node 24.18.1、healthとnginx経由API応答を確認。LLM実API呼び出しやproduction学習データの検証は行っていません。
- Xcode 27.0 (27A266a)でmacOS DebugおよびiOS Simulator Debug build成功。署名・macOSへの拡張インストール・iPhone/iPad実機へのインストールは未実施。接続済みのiPhone実機はありませんでした。

実機受入では、まず選択→iframe/専用タブ→background→固定APIとKeychain保管・復帰を確認し、それから新規/既存の単語・文法のA/B登録、CSPの厳しいページ、複数タブ、途中切断、ページ遷移、iPhone/iPadの選択メニューを確認してください。ここが当初計画のPhase 0/5に相当する未完了ゲートです。クラウド配備のみで全体の実機受入完了とは扱いません。

エミュレーター認証テストの再実行（専用`demo-vocab-safari`プロジェクトのみを使用）:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run test:extension:emulator --prefix backend
npm test --prefix extensions/safari
(cd frontend && npx playwright test safari-extension.pw.ts)
```

## 配備

通常の`./deploy.sh`でWebとbackendを配備します。`--llm`/`--auth`/`--prompts`の追加アップロードやbulk migrationは不要です。拡張の署名・インストールは上記のXcode手順で別途行います。

参考: [Apple Safari Web Extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)、[native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)。APIの実機対応は上記の未完了ゲートで確認します。
