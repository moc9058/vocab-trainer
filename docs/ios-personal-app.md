# 個人用iPhoneアプリ

更新日: 2026-10-22。React画面を同梱するCapacitor 8.5.3 / Swift Package Manager構成。
Web版と同じCloud Run API・Firestore `vocab-database` を使う。単語・文法・履歴のコピーや移行は不要。
App Store、TestFlight、有料Apple Developer Programは今回の利用に必要ない。

## Xcodeで開くもの

- プロジェクト: `frontend/ios/App/App.xcodeproj`
- Scheme / app target: `App`
- Bundle ID: `jp.moc9058.vocabtrainer`
- 最低iOS: 15。利用するXcodeが本人のiPhoneのiOSバージョンをサポートすることも必要。
- core/cli/ios: 8.5.3、App plugin: 8.1.2、Keyboard plugin: 8.0.6。依存はlockfileで固定。

```bash
npm ci --prefix frontend
npm run ios:sync --prefix frontend
npm run ios:open --prefix frontend
```

`ios:sync` は型検査→iOS専用React build→native依存・assets同期を行う。
生成Web assetsはGitに含めないため、初回に必ずsyncする。
既存Webの `npm run build --prefix frontend` は `dist`、iOSは `dist-ios` を使う。
Releaseには公開サイトのURLをWebViewの起動先にする `server.url` を設定しない。

## Googleログインの初回設定（残る本人操作）

Web用OAuth clientをiOS用として流用しない。既存Google Cloudプロジェクト
`vocab-trainer-490014` の [Google Auth Platform → クライアント](https://console.cloud.google.com/auth/clients?project=vocab-trainer-490014)
で、種類 **iOS**、Bundle ID **jp.moc9058.vocabtrainer** のクライアントを作成する。
App Store IDや有料Team登録は今回不要。既存のGoogle同意画面と許可ユーザー設定を使う。
Web用クライアントや既存callback登録を削除しない。

公開クライアントID（`…apps.googleusercontent.com`）をbackendの
`MOBILE_GOOGLE_CLIENT_ID` に設定する。シークレットは作成・配布しない。
初回設定を含めてデプロイする場合:

```bash
MOBILE_GOOGLE_CLIENT_ID='実際の公開iOSクライアントID' ./deploy.sh
```

既にbackendを配備した後に公開IDだけ設定する場合（データやWeb OAuth configを変更しない）:

```bash
gcloud run services update vocab-trainer-backend \
  --project=vocab-trainer-490014 --region=asia-northeast1 \
  --update-env-vars='MOBILE_GOOGLE_CLIENT_ID=実際の公開iOSクライアントID'
```

通常deployでこの変数を省略すると、既存Cloud Run値を保持する。`--auth`などの設定一括アップロードは不要。
`ALLOWED_ORIGINS`を独自指定している環境では、その既存一覧へ正確な `capacitor://localhost` を追加する。
コードの既定一覧には追加済み。ワイルドカードや `null` originは使わない。

アプリはASWebAuthenticationSessionを開く。Googleへ渡すredirectはiOS client IDを反転したschemeの
`com.googleusercontent.apps.…:/oauthredirect`。OS認証セッションがこのcallbackを捕捉する。
任意deep linkからログインを成立させる入口は設けていない。
PKCE verifierとstateをnativeメモリーに保持し、callbackのscheme/path/stateと重複queryを確認する。
backendはPKCE transactionを原子的に消費し、Google codeの交換・ID token署名/audience/期限・許可メールを検証する。
失敗や中断時は新しいログインからやり直す。WebViewでGoogleログイン画面を開かない。

アプリ専用30日sessionはKeychain（端末のみ、ロック解除時）に保存する。
30日後は再ログイン。Cookieの共有やlocalStorageに依存しない。
サーバー秘密鍵・Google client secret・OpenAIキー・サービスアカウントをアプリへ入れない。

## iPhoneへの初回インストール

1. Xcodeを開き、本人が必要な規約を確認して同意、追加コンポーネントをインストールする。
2. Xcode → Settings → Accounts / Apple Accounts でApple Accountへログインする。
   パスワード・2FAはAppleの画面に直接入力する。チャットへ送らない。
3. 上のsync/openコマンドでプロジェクトを開く。
4. App target → Signing & Capabilities → Automatically manage signingを有効化し、本人の **Personal Team** を選択する。
   有料capabilityを追加しない。個人のTeam設定は下記のローカル設定へ保存し、project.pbxprojへコミットしない。
5. iPhoneをMacへ接続し、双方の「信頼」を本人が承認する。
6. iPhoneの「設定 → プライバシーとセキュリティ → デベロッパモード」を有効化し、再起動と確認を行う。
7. Xcodeの実行先にiPhoneを選んでRunする。必要に応じて端末の「設定 → 一般 → VPNとデバイス管理」で開発者を信頼する。
8. ホーム画面のVocab Trainerを起動し、Google認証画面で許可済みの本人アカウントを選択する。
   最初の本番確認は認証・一覧・既存履歴の読取までにする。自動テストで本番に回答を書かない。

Bundle IDを変更する必要がある場合は、Capacitor設定、Xcode target、Google iOS clientの登録を揃える。
同じIDなら署名更新時にも既存アプリへ上書きできる。

## 個人の署名設定をローカルに保持する

`frontend/ios/Personal.xcconfig.example` を `frontend/ios/Personal.xcconfig` へコピーし、
`DEVELOPMENT_TEAM = 自分のTeam ID` を設定する。Personal.xcconfigはGitの対象外。
既にファイルがあれば上書きせず、その設定を使う。Team IDはXcodeのApple Account / Team情報で確認する。

Debugの `debug.xcconfig` とReleaseの `release.xcconfig` がこのファイルを任意で読み込み、
AppとAppUITestsの両targetに継承する。ファイルがないcheckoutでもSimulatorのコンパイルは可能。
XcodeのTeam選択が `project.pbxproj` に `DEVELOPMENT_TEAM` を書いた場合は、値をPersonal.xcconfigへ移し、
そのTeam行だけを共有projectから除く。ほかのproject変更を一括で元へ戻さない。
署名証明書・provisioning profile・Appleログイン情報をリポジトリへ追加しない。

## 署名エラーの復旧と検査付き更新

`SBMainWorkspace / Security`、`invalid code signature`、`inadequate entitlements`
という表示だけでは原因を断定できない。署名破損、profile期限切れ、端末未登録、権限不整合、
開発者の未信頼を区別する。アプリのJavaScriptが実行される前の拒否なので、画面内の処理では修復できない。

MacにXcode・Python 3・Nodeを用意し、本人のApple AccountとPersonal.xcconfigを設定したうえで、
iPhoneを接続してロックを解除する。次のコマンドはproduction用assetsを同期し、
自動署名を更新してビルドし、署名・証明書期限・profile期限・権限・対象UDIDを検査してから上書きインストールする。
続けて起動も試し、インストール成功と起動失敗を区別して報告する。既存アプリを削除しない。

```bash
# UDIDはXcodeのDevices and Simulatorsなどで確認する
npm run ios:install --prefix frontend -- --device YOUR_IPHONE_UDID

# 既存bundleの検査だけを行う（再ビルドやインストールなし）
npm run ios:install --prefix frontend -- --device YOUR_IPHONE_UDID --check-only /absolute/path/App.app
```

期限切れのprofileを再び選ぶ場合はXcodeのAccountsで本人のサインイン状態を確認し、
AppのAutomatically manage signingと同じPersonal Teamを確認してRunする。
証明書や全profileの一括削除は行わない。
署名検査を通っても端末側の開発者信頼はMacから代行できない。
Securityエラーが続く場合は、iPhoneの「設定 → 一般 → VPNとデバイス管理」で
本人の開発者を選び信頼する。インターネットへ接続し、デベロッパモードも確認する。
[Appleの開発者信頼手順](https://help.apple.com/xcode/mac/current/en.lproj/dev96a12fb84.html)。
MacへのUSB接続の「信頼」と、アプリの開発者を信頼する操作は別である。

検査コードの回帰テスト:

```bash
python3 -B -m unittest discover -s frontend/scripts -p test_install_ios.py
```

## 無料署名の期限後

Personal Teamのprovisioning profileは発行から7日で期限になる。
MacへiPhoneを接続し、同じApple Account / Personal Team / Bundle IDでXcodeのRunを再実行して再署名・再インストールする。
アプリを削除する必要は通常ない。再ログインを求められた場合はGoogle認証を行う。
学習履歴はFirestoreにあり、再インストール用のデータ移行は不要。
未送信回答は再インストール前に同期を完了させる。
[Apple Personal Teamの説明](https://developer.apple.com/help/account/basics/about-your-developer-account)。

## 今後Webを変更したとき

```bash
git pull --ff-only
npm ci --prefix frontend
npm run ios:sync --prefix frontend
npm run ios:open --prefix frontend
```

Xcodeで同じ端末へRunする。iOSのUIは同梱されているためCloud Runの更新だけでは変わらない。
native/pluginの変更でもsyncする。backendの変更は `./deploy.sh` で別途Cloud Runへ配備する。
端末に旧UIが残る期間のAPI互換を維持する。OTA更新は導入していない。
Release buildは、local用assetsの混入をXcodeのbuild phaseで拒否する。

## 安全なローカル検証

Node 24を使う。root npm packageはない。
次のサーバーはローカルemulator以外を拒否し、独立project `demo-vocab-ios-smoke` / `(default)` に合成3単語を用意する。
LLMへの通信はmockで置換され、実Googleログインも行わない。本番seedをダウンロードしない。

```bash
docker compose up -d firestore
# Terminal A
cd backend
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run ios:smoke
```

```bash
# Terminal B: repository root
VITE_API_ORIGIN=http://localhost:3000 npm run ios:sync:local --prefix frontend
```

XcodeのDebugでSimulatorを選んでRun。App schemeのTestはこの合成サーバーとlocal assetsを前提とする。
本番接続用assetsでUIテストを実行しない。実機のlocalhostはMacではないので、必要な場合はMacのLANアドレスを指定する。
HTTP/ATS例外・LAN用途説明はDebug専用Info-Debug.plistに限定し、ReleaseはHTTPSのみ。
SimulatorのKeychainを使う操作試験は通常のSimulator向けadhoc署名buildで行う。
`CODE_SIGNING_ALLOWED=NO`はコンパイル確認用で、Keychain動作の証明にはしない。

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run test:mobile:emulator --prefix backend
```

Firestoreの認証metadataは学習データと別collectionに保存する。
`mobile_auth_transactions.cleanupAt`、`mobile_auth_sessions.cleanupAt`、`mobile_auth_limits.expiresAt` を
Firestore TTL対象にすると期限切れmetadataを自動清掃できる。期限判定はサーバーで毎回行い、TTL削除の遅延に依存しない。
TTL未設定でも認証は期限で失効するがmetadataが残る。設定は既存プロジェクトで行い、学習collectionにはTTLを設定しない。

## 中断・同期の制約

復帰時は認証確認→既存直列回答キューの送信→成功時に現在ルートのsession再取得を行う。
401は先頭回答を保持して再認証待ちにする。再試行でoperation IDを変更せず、mixedの採点・B削除の原子性を維持する。
サーバー拒否や競合を通信エラーと混同しない。nativeの同期警告はログイン画面やホームでも表示する。

未送信回答は既存どおりメモリー内であり、強制終了やOSによるWebView破棄で失われ得る。
同期完了までアプリを開いておく。バックグラウンド継続やオフライン永続化の保証はない。
ログアウト時に未送信分があると破棄の確認を出す。サーバー失効の通信に失敗した場合は端末ログアウトのみであることを表示する。

## 検証記録

実装時の結果と本人確認待ちは [iOS検証記録](ios-verification.md) を参照。

## 画面・選択テキストからの取り込み（2026-10-24）

画像選択、Shortcutsの `Read an image` / `Read selected text`、端末内OCRと文章選択を追加した。
[画面から読み解くガイド](screen-reading-import.md)に設定手順、対応OS、データ保持と実機確認事項をまとめている。
App IntentsはiOS 16以降。Control Centerの推奨入口はiOS 18以降。アプリ全体の最低iOS 15は維持する。
Share/Widget Extension、App Groups、共有Keychainは追加していない。

一時受信箱は入力受け渡しのための端末内ファイルで、既存の学習sessionや回答をローカル永続化するものではない。
画像・未確定OCR・再送要求は最長24時間利用でき、期限後の次回操作で削除する。ログアウト時にも破棄を確認する。
保存済みの外部ソース・辞書項目は従来どおりFirestoreを正とする。
