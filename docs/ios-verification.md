# iOS実装・検証記録

日付: 2026-10-22（日本時間）。学習データに対する試験はemulator / mockのみ。
Cloud Run本番の単語・文法・履歴を試験で書き換えていない。
実装・本人向け手順は [iOSガイド](ios-personal-app.md) を参照。

## 実装

- Capacitor 8.5.3 / SPMのXcode projectと共有App scheme、native UI tests。
- Web/iOSの別出力、Release API固定、古いlocal assetsのRelease混入を拒否。
- iOS専用public Google OAuth client、ASWebAuthenticationSession、PKCE/state、原子的なtransaction消費、署名検証と許可メールチェック。
- 30日mobile sessionをKeychainに保存。サーバーではtokenとtransaction IDをhashで保存。
- CookieとBearer共通の認証判定。無効BearerをCookieで代替しない。
- JSON・翻訳・作文・取り込み・語彙lookup・診断通信を共通transportへ移行。iOSのjob監視はBearer付きfetch SSE。
- 実機向けsafe area、viewport、Keyboard plugin、復帰時の認証→直列同期→quiz再取得。
- 401は回答キューを保持して停止。英日韓の同期・再認証・未確認失効表示。
- 元の計画のWeb client broker案はGoogleのplatform別client方針を再確認して変更。既存Web OAuth clientとcallbackは継続する。

## 環境

- Xcode 27.0 / 27A266a、iOS 27.0 SDKとSimulator runtime。
- Simulator: iPhone 18 Pro / iOS 27.0。
- 標準xcode-selectはCommandLineToolsのため、コマンドに `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` を付けた。
- Node 24.22.1でbackend unit/mixed/import/emulator試験を確認。通常ホストNodeは25.8.1。
- Docker Desktop起動後に、エミュレーターと本番と同じDockerfileのビルド・ローカル疎通を確認。
- SPMがMac Keychainの認証参照で待機したため、公開依存の取得は `xcodebuild -packageAuthorizationProvider netrc` を使った。
- Macのロックにより手動GUI操作はできなかった。Simulator起動と画面・キーボード操作はXCUITestで検証した。

## 結果

| 検証 | 結果 |
| --- | --- |
| backend TypeScript build | 成功（ローカル / Node 24 Docker） |
| backend unit | 113件成功。mobile認証2件とSSE CORS回帰1件を含む |
| backend `test:mixed` | 4件成功 |
| backend `test:import` | 9件成功 |
| backend `test:import:emulator` | 14件成功。実LLM呼出しなし |
| mobile Firestore emulator | 1件成功。別store instanceの並列交換で成功1件、token hash保管・失効・期限・分散回数制限 |
| sitting emulator smoke | word / grammar / recall / combined / mixed / importA / importBの7種成功 |
| frontend TypeScript / Web build / iOS build | 成功 |
| frontend unit | 13ファイル・110件成功。401保持・順序、SSE UTF-8/CRLF/複数行、API送信先境界を含む |
| Web Playwright | 51件成功。クイズ・重み・復習・再開等 |
| iOS Debug Simulator build | 成功。通常のSimulator adhoc署名で動作試験 |
| XCUITest | 3件成功。起動と復帰、単語回答と再開、キーボード入力と翻訳stream |
| Simulator→emulator→Docker Webの履歴共有 | nativeで保存した1回答を、Docker経由の同じsessionで確認。score correct=1 / total=3 |
| CORS | exact native originのpreflight成功。未許可originは許可ヘッダーなし |
| ローカルassetsのRelease拒否 | 期待どおり失敗。production sync後は成功 |
| iOS Release / iphoneos build | 成功。署名なしarm64実機向けコンパイル。インストールは本人署名待ち |
| Docker backend / frontend buildとruntime | 成功。nginx→backend→emulatorの一覧・session取得とWeb HTTP 200 |

Simulatorのストリーム試験で、既存のraw SSEがFastifyのCORSヘッダーを引き継がず `Load failed` になる問題を発見した。
`backend/src/sse.ts`で共通ヘッダーをraw responseへコピーし、明示的にhijackする修正を加えた。
修正後に翻訳の逐次処理と結果表示を確認。実Google・実LLMを使った成功を意味しない。

直前のSimulator UI test結果は `/tmp/vocab-ios-final-smoke.xcresult`。
結果bundleはローカル検証出力でありGitへは含めない。

### 再実行

[iOSガイド](ios-personal-app.md)の合成サーバーを起動し、local syncした上で:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -packageAuthorizationProvider netrc \
  -project frontend/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath /tmp/vocab-trainer-ios-derived test
```

UI testsは `--vocab-local-smoke` を渡す。native側はlocal mode / localhost:3000資産を確認し、
production資産ならリクエスト開始前に停止する。試験後は `npm run ios:sync --prefix frontend` で本番用へ戻す。

## 配備と本人確認待ち

- 実機へのインストール、Personal Team署名、Googleの実アカウント認証とcallback、保存tokenでの実機再起動、実機IME・画面ロック・回転は未確認。
- iOS OAuth client IDは未設定。既存Google Cloudプロジェクトで本人に作成・公開IDの提示を依頼済み。設定前のmobile認証は503で停止する。
- Appleログイン・規約同意・iPhone接続・Developer Mode・実機でのRunは本人操作。
- オフライン永続化や強制終了後の未送信復元は対象外。既存のメモリーキュー制約を画面と文書に明記。
- commit / push / Cloud Run配備 / iPhoneへのinstallはそれぞれ独立した結果として最終報告する。

## 画面からの取り込み・意味単位の追加検証（2026-10-24）

実装の利用手順は[画面から読み解くガイド](screen-reading-import.md)を参照。
以下の学習データはすべて合成fixture・隔離emulatorで確認し、本番の辞書・記事・履歴は書き換えていない。

| 検証 | 結果 |
| --- | --- |
| backend build / unit | 成功、117件 |
| import route / dispatch | 成功、9件 |
| mixed quiz | 成功、4件 |
| import Firestore emulator | 成功、16件。新規取り込みの並列作成、同一要求の再送、編集後の再送、削除後410、origin検証を含む |
| mobile auth emulator | 成功、1件 |
| frontend TypeScript / unit | 成功、113件 |
| Web build / iOS sync | 成功 |
| Playwright | 成功、54件。360pxのコメント選択・OCR訂正・明示結合、意味単位から単語／跨る構文の選択、候補保持、compact解説の自動生成と再利用を含む |
| Docker Node 24 / nginx / emulator | 両imageのbuild成功。隔離した `demo-vocab-ios-smoke` でHTML、言語一覧、取り込みの201/200再送/削除を確認 |
| iOS Simulator build-for-testing | 成功。App Intents metadataの抽出を含む |
| 新規XCUITest | 合成画像の受信、Vision OCR、画像上の文章選択、原文確認、ソース作成、mock解析、意味単位表示、backgroundからの復帰を確認 |

追加したXCUITestは `testCaptureOCRAndTextConfirmation`。DEBUGかつlocal assets確認済みの
`--vocab-local-smoke --vocab-capture-smoke` でのみ合成画像を受信箱へ入れる。
専用サーバーはimportもmock化し、同じ隔離emulatorのジョブを処理する。実LLMを使った意味品質の確認ではない。

Simulatorの試験途中で、システムプロセス `AppIntentsLiveEntityService` の
`XPCPeerRequirement.hasEntitlement` / `__XPC_API_MISUSE__` によるクラッシュが発生した。
アプリ内のOCR→解析→表示の追加テストは通ったが、その時の全体suiteはシステム障害を含む失敗として記録した。
また、試験の再実行時に残った合成クイズが開始確認を要求したため、既存試験を「Start New」にも対応させた。
これらを本人の端末でのIntent実行成功や無料署名の確認として扱わない。

実機のControl Center撮影、小红书・财新の実画面と共有入力、Personal Teamでの新Intent実行、
ロック・回転・写真選択の実機挙動、実LLMの説明品質は未確認。
画面取得には手動スクリーンショット→画像選択の代替経路を残している。

最終確認では、production assetsへ戻したうえで、署名なしのiOS Release / arm64実機向けbuildも成功した。
最後の4件のXCUITestでは操作上のassertion失敗はなかったが、最初の試験中のシステムサービス停止1件により
suite全体は失敗判定となった。結果bundleは `/tmp/vocab-capture-verified.xcresult`。
DEBUGの試験入力マーカー以外の端末データは清掃対象にせず、試験専用Dockerコンテナーを終了した。


## Control Center受信導線の更新（2026-10-25）

対象: 入力元を区別する互換App Intent、入力なし／URLのみの起動要求、
原文・出典・登録先の端末内下書き、確認画面から直接解析、再送要求の凍結、
受信時の作業保護。学習データの試験は既存の隔離emulatorとmockを使用。
本番データの移行・書き換えは行っていない。

| 検証 | 結果 |
| --- | --- |
| Node 24 backend build / unit / import / mixed | 成功。unit 117、import 9、mixed 4件 |
| import emulator | 16件成功。実LLMなし |
| frontend TypeScript / unit / Web build / local iOS sync | 成功。unit 117件 |
| Playwright全体 | 61件成功（1 worker）。直接解析・作成応答喪失時の同一要求再送・下書き・範囲切替・容量失敗後の再試行・URLのみの抑止を含む |
| Docker frontend→backend→隔離Firestore | Web / auth / source一覧でHTTP 200。`demo-vocab-ios-smoke`の合成データのみ |
| iOS Debug Simulator build | 成功。Xcode 27 / iOS 27 Simulator |
| XCUITest: 画像→OCR→原文確認→直接解析→意味単位 | 合成画像で操作・保存を確認。全体suiteでは下記OSサービス障害を検出 |
| XCUITest: 入力なし→貼り付け→終了→下書き再表示 | 個別再実行で成功 |
| 繁体字・簡体字OCR | 合成画像の認識結果は `虽然很忙，但我还是来了。` / `这个办法确实不错。` / `臺灣的經濟與发展。`。混在表記が保持された。最後の行は低confidence表示あり |
| 本人のiPhoneの接続 | iPhone 16 Plus / iOS 26.6.2 / Developer Mode有効を確認 |
| 小红书・财新→Control Center撮影／選択範囲取得 | 未確認。共有／コピー／撮影の実入力比較、撮影タイミング、各10回の確認は本人の端末で必要 |

最初の全体XCUITestは、`AppIntentsLiveEntityService`のクラッシュを検出して失敗した。
個別再実行でも最初のテストに同じOSプロセス障害が報告された。
画像のOCR・解析処理そのものと、貼り付け下書きの終了・復元は動作したが、
これを全体suite成功として扱わない。繁体字UI検証ではHTMLの押下状態付きボタンが
XCUITest上でSwitchとして扱われ、Button限定のselectorが失敗したため、
accessibility labelの照合へ修正した。修正後の最終OCR再実行では繁体字照合・解析・意味単位・復帰のアプリassertionは通り、テストコマンドはOSサービスクラッシュ1件だけで失敗した。

Webとnativeの同時ビルド中には開発サーバーの再読み込みを伴う試験失敗も発生した。
Viteはnative生成物・dist-ios・test-resultsをwatch対象から除外した。
最終Web suiteは1 workerで全61件が通過した。試験ログとxcresultは`/tmp/vocab-reading-*`にあり、Gitには含めない。

ショートカットの設定は[構成手順](shortcuts/README.md)を参照。
「画像を読み解く」は撮影アクションの出力をImageへ指定する。
「選択した文章を読み解く」は受信入力を優先し、届かない場合のClipboard取得は明示操作にする。
任意アプリの選択範囲の自動取得を保証しない。画像・本文の確認前に解析／辞書登録しない。
