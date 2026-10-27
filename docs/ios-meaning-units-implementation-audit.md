# iOS・画面取り込み・意味単位の実装整理

確認日: 2026-10-27（日本時間）。ローカルのmasterと実装履歴を照合した。
本番の学習データを変更する試験、実Googleログイン、実LLMの課金を伴う試験は行っていない。

## 計画の判定と削除

以下の3計画は初版のコードが実装され、利用手順と検証記録も別文書に存在するため、`plan/` から削除した。
設計時の未チェック項目を一律に完了扱いにはしない。コード実装の完了と、実機・意味品質・リリース受け入れの完了を区別し、残る確認は下記に保持する。
旧計画全文は削除前の[Git版](https://github.com/moc9058/vocab-trainer/tree/4dcfb77/plan)に残る。

| 削除した計画 | 実装根拠 | 現行の保守文書 |
| --- | --- | --- |
| `ios-personal-app-design.md` | `0bc0727`。Capacitor/SPM、分離したWeb/iOS出力、Release接続先検査、native OAuth/Keychain、Cookie/Bearer共通認証、transport/SSE、回答キューの401保持と復帰処理、safe area/Keyboard、XCUITest | [iOSガイド](ios-personal-app.md)、[検証記録](ios-verification.md) |
| `source-meaning-units-design.md` | `5454002`。共通詳細schema、raw正規化・保存検証、backend/frontend互換型、通常生成と凍結revision job、意味単位の表示・出現projection、旧記事への明示追加、候補保護・遅延応答破棄 | [画面から読み解く](screen-reading-import.md)、[修正仕様](source-revisions.md)、[開発リファレンス](development-reference.md) |
| `ios-screen-reading-import-design.md` | `5454002`、`16d50a7`。App Intents、端末内受信箱、Vision OCR、画像上の文章選択、訂正・明示結合、確定本文のみ送信、receipt付き作成、既存解析jobとA/B登録、起動要求・ローカル下書き・凍結した再送要求 | [取り込みガイド](screen-reading-import.md)、[Shortcuts構成](shortcuts/README.md)、[検証記録](ios-verification.md) |

## 維持する設計と実装上の具体化

- iOSはReact同梱。Web更新だけでは端末UIは変わらず、`ios:sync` と端末への再インストールが必要。Webと同じCloud Run/Firestoreを使い、学習データのコピーやmigrationは行わない。
- 元のWeb OAuth broker案は採用せず、iOS専用public client、ASWebAuthenticationSession、native PKCE/state、一回限りのtransaction交換、Keychain内の30日sessionを使用する。認証設定の読込失敗で認証を無効化しない。
- 回答は既存の直列メモリーキュー。401時に保持し、認証回復後に同じ操作を再送する。強制終了後の未送信回答の復元は保証しない。画像入力の一時保持と学習状態の永続化は別の契約。
- 意味単位は一文内の任意追加フィールド（親version 1）。原文の連結完全一致、UTF-16範囲、書記素境界、1〜24単位、meaning 500文字・role 120文字・flow 1,000文字、意味単位80,000 byte、一文詳細150,000 byte、セッション900,000 byteの制約を検証する。
- 通常解説と修正jobは `import-explanation-config.ts` の詳細schema/指示を共用。新schemaは意味単位必須、凍結済み旧jobは旧schemaで完了可能。compact初回解析とword-assistは別の契約。runtime schema方式なので今回の設定アップロードは不要。
- 意味単位の追加・更新では既存の詳細解説・候補を保護する。初回compact読解から詳細を補う通常生成は、既存の候補整合を行う実装に具体化されている。「解説のみ」の修正案採用は候補を変えない。原案との差は[修正仕様](source-revisions.md)の説明を正とする。
- 生成結果は記事ID・文index・原文・解説の編集世代で遅延応答を排除し、autosaveへ渡す。通常詳細解説は画面終了後の保存を保証するサーバーjobではない。
- 画像OCRは端末内で実行し、確認済み本文と最小の出典metadataだけを送信する。画像・未選択コメント・OCR全文をFirestoreへ保存しない。受信箱は最大10件・100MiB・24時間、画像一件20MiB・2,000万画素。期限到達時の物理削除はOS任せにせず、次の操作で清掃する。
- ソース作成の `ingestionId` と要求digestをreceiptに記録し、同一要求の再送は200、初回201、異なる要求409、削除済みソース410。receiptとソースをtransactionで作成する。保持7日、既存reconcileで一度100件まで清掃。保持期間後まで永久に重複を防ぐ契約ではない。
- 独自オーバーレイではなく、取り込んだ静止画をアプリ内で表示する方式。Shortcutsの画像・共有/コピー文章・入力なし起動を区別し、未同期回答や作業中の画面を勝手に置き換えない。Clipboardは自動で読まない。

## 未コミット変更の整理と追加修正

- `project.pbxproj` の差分はXcodeによる整形とApp/AppUITestsのDebug/Releaseの個人Team設定だった。整形は保持し、Team値をGit対象外の `frontend/ios/Personal.xcconfig` へ移した。Debug/Releaseの共通設定から任意includeし、既存の本人用署名選択をローカルに保った。共有projectに個人Team IDを含めない。
- `Localizable.xcstrings` は翻訳文の変更ではなく整形と6つのIntent文字列への `stale` 付与だった。これらはSwiftのIntentに現存するため、ほかの手動管理キーと同じ `manual` に統一して翻訳を維持した。
- `config 2.xml` は生成済みの `config.xml` とbyte単位で同一、project参照もない重複ファイルだったため削除した。正規の生成ファイルは引き続きGit対象外。
- 意味単位が不正な保存済み記事について、文全体の解説まで非表示となる不一致を修正した。原文/versionが一致する既存の解説と出現情報を表示し、不正な意味単位ブロック・projectionだけを隠す。閲覧による自動再生成は行わず、保存時の厳密な検証も緩めない。単体・ブラウザ回帰を追加した。
- READMEと利用ガイドのリンクを現行文書へ更新。2026-10-20の監査は当時の未実装判定を保持し、元計画へのリンクを当時のGit版へ変更した。

## 残る受け入れ確認

以下は実装済みコードの存在だけで完了にしない。過去の実施結果は[iOS検証記録](ios-verification.md)に日付別で保持し、本人の端末で確認した結果を同じ文書へ追記する。

- [ ] 本人のPersonal Teamでの実機インストール・再署名、Googleの実アカウント認証/callback、Keychainによる再起動後の認証復元。今回クラウドのOAuth設定状況は調査しておらず、過去の「未設定」の記録を現在の事実として扱わない。
- [ ] 小红书・财新の表示中の画面からControl Center撮影、共有画像・選択テキスト・明示コピーを各10回比較。撮影前のアプリ起動やControl Centerの写り込み、OS・署名・入力型・成功率・操作回数・待ち時間を記録する。
- [ ] cold/warm start、認証前、ロック解除、回転、写真選択キャンセル、実機IME、VoiceOver、Dynamic Type、safe area、認証切れ・通信断と未同期クイズ併用を実機で確認する。
- [ ] 投稿・独立コメント・返信・短長文・低コントラストを含む各10画面以上でOCRの誤結合と訂正の使いやすさを評価する。個人の画面画像をGitへ追加しない。
- [ ] 隔離emulatorの確認専用ソースで中国語・英語・日本語・韓国語の短長文を実LLMで評価し、原文復元・過分割・因果関係・文脈外の情報・説明言語を確認する。更新/保存/再読込/修正/採用/undoの代表操作と出力量・所要時間を測定する。構造の自動検証だけで意味品質や速度改善を保証しない。英語版のUIは現在一時停止中のため、その解除を本整理に含めない。
- [ ] 本人端末で上記を満たしたときに初版の実機受け入れ完了を記録する。Simulatorで過去に発生したAppIntents OSサービスの障害と、アプリ自身のassertion結果を区別する。

後段の対象は引き続き、独自Control Widget、正式対応OSでの別画面取得方式、複数画像の連結・重複除去、親子コメントの構造化、記事全体の見取り図、意味解析先行の二段階取り込み、Share Extension。いずれも今回の実装漏れとして追加しない。

## 今回の検証

自動試験はmockと隔離Firestore emulatorを使用した。実機・実Google・実LLMの成功とは区別する。

| 検証 | 結果 |
| --- | --- |
| Node 24.22.1 backend build / unit / import / mixed | 成功 |
| import emulator / mobile auth emulator | 成功（16件 / 1件）。合成データのみ |
| frontend型チェック / unit / Web build | 成功（unit 118件） |
| iOS production build / Capacitor sync | 成功 |
| Playwright全体 | 成功（69件、1 worker）。不正な意味単位を非表示にして既存解説を保持し、自動再生成しない回帰を含む |
| iOS Debug Simulator build-for-testing | 成功。AppとAppUITestsをコンパイル |
| iOS Release / arm64実機向けbuild | 成功。`CODE_SIGNING_ALLOWED=NO` によるコンパイルのみ |
| 個人設定の継承 / 省略 | Debug/Release、App/AppUITestsとも確認。個人Teamはローカルに保持しGit対象外 |
| native翻訳 | 21キーすべてのen/ja/ko訳が元と同一、`manual`を確認 |
| Markdown相対ファイルリンク / 差分 | 64リンク、削除計画へのローカルリンクなし、`git diff --check`成功 |

今回XCUITestの実行・iPhoneへのinstallは行っていない。過去のSimulator操作結果は[iOS検証記録](ios-verification.md)を参照。ログは `/tmp/vocab-cleanup-ios-debug.log` と `/tmp/vocab-cleanup-ios-release.log`（Git対象外）。
