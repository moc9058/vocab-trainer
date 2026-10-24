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
