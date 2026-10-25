# コントロールセンターから画像・選択文章を読み解く：差分実装計画

作成日: 2026-10-25（日本時間）

状態: **計画のみ。以下の変更・実機検証は未実施**

調査基準: `5454002` と作業ツリーの既存コード。実装開始時に必ず再確認する。

## 1. 目的と引き継ぎの前提

既存の「画像を読み解く」「選択した文章を読み解く」を、他アプリで読んでいる内容から少ない操作で使えるようにする。取得した中国語の文章・構文を解析し、意味、単語、文法を確認して既存DBへ登録する。小红书・财新を主要な実機検証対象にするが、特定アプリの内部APIや画面構造には依存しない。

リポジトリの既存機能と「コントロールセンター」という指定から、対象を**既存の個人用iPhoneアプリ**とする。Android、macOS、Webブラウザー拡張の新規開発は今回に含めない。「ページ」は起動時に表示されている画面を意味し、画面外の全文、未展開コメント、スクロール全体の自動収集は対象外。

この文書は[前回の実装計画](ios-screen-reading-import-design.md)の差分である。前回計画の「新規」と記されたファイルを再作成しない。[現在の使い方](../docs/screen-reading-import.md)、[開発リファレンス](../docs/development-reference.md)、[iOS検証記録](../docs/ios-verification.md)、[iOS導入手順](../docs/ios-personal-app.md)を先に読み、実装済み基盤を再利用する。

計画作成開始時に以下の未コミット変更があった。別作業として保全し、差分を上書き・巻き戻し・無断コミットしない。後日の実装時には状態を取り直す。

- `frontend/ios/App/App.xcodeproj/project.pbxproj`
- `frontend/ios/App/App/Localizable.xcstrings`

## 2. 要件と実現性を区別する

### 2.1 成功させたい操作

| ID | 要求する体験 | 完了条件 |
| --- | --- | --- |
| IMG-1 | 対象画面でコントロールセンターの「画像を読み解く」を押す | ファイル・写真を選ばず、その画面の静止画を受信する |
| IMG-2 | 繁体字・簡体字を含む画面から文章を認識する | 端末内OCR→対象範囲の選択・原文修正→解析UIへ進める |
| TXT-1 | 他アプリで文章を選択し「選択した文章を読み解く」を押す | 渡された選択文章を確認・解析できる。取得できない場合は明示する |
| TXT-2 | アプリに依存せず使える入口を持つ | 選択範囲の共有、明示コピー後の読み取り、画像経路を同じ解析UIへ接続する |
| DB-1 | 解析した単語・文法をDBへ追加する | 既存A/B登録を使い、実際の所属・失敗・再試行を表示する |
| SAFE-1 | 作業中・未同期・通信断から安全に続ける | 元の学習状態を壊さず、同一送信の再試行でソースを増殖させない |

### 2.2 公開仕様から分かる制約

Appleの「Receive What’s On Screen」は**対応アプリが提供する画面上の項目**を受け取る機能である。任意アプリの現在の選択範囲が届くとは記載されていない。したがって「文字を選択しただけで、全アプリからその範囲だけを取得できる」という保証はしない。[Apple: 画面上の項目の受信](https://support.apple.com/en-euro/guide/shortcuts/apd350ce757a/ios)

コントロールセンターには任意のショートカットを割り当てられるが、それ自体に入力データの提供保証はない。ショートカットに初期入力がない場合の分岐も設計する。[Apple: Control Center](https://support.apple.com/en-euro/guide/shortcuts/apd06a9201d4/ios)、[Apple: 入力の制限と入力なし時の動作](https://support.apple.com/en-euro/guide/shortcuts/apd8195f96d6/ios)

**設計上の結論:** 画像はOSの「スクリーンショットを撮る」→既存受信Intentを主経路にする。文章は入力が届く経路を優先し、届かない場合は「選択→コピー→コントロールセンター」または選択範囲の共有へ案内する。コピーは追加操作であり、TXT-1の完全達成として報告しない。

この制限は計画作成の障害ではない。実装者はM0で対象端末・アプリの挙動を測定し、保証できる操作を確定する。TXT-1が主要アプリで成立しなければ「共有／コピー対応済み、選択だけでの取得は未対応」と明記して利用者に要件差分を提示する。黙ってコピー方式へ要件を置き換えない。

### 2.3 OS別の方針

- 既存アプリ全体の最低OSを不用意に引き上げない。現行資料ではiOS 15、App IntentsはiOS 16以降、今回のコントロールセンター導線はiOS 18以降が基準。Capacitor/SPMを含む実際のビルド可能範囲はM0で再確認する。
- `CaptureIntents.swift`にはiOS 26の`supportedModes`、iOS 27の`allowedExecutionTargets`のavailability分岐が既にある。使用SDKの定義と実行プロセスを確認して維持する。[Apple: App Intentの実行モード](https://developer.apple.com/documentation/appintents/configuring-the-runtime-behavior-of-your-app-intents)
- **iOS 27以降のScreenCaptureKitも存在する。** 公式サンプルはシステムの共有選択UIによる全画面取得を示している。ただし許可操作・対象画面へ戻る操作・取得時点の問題が残るため、本計画の主経路にはしない。前回文書のBeta表記を現在の配布状態の断定に使わず、採用時にSDKと実機を再確認する。[Apple: iOS画面取得サンプル](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)
- 独自Control WidgetやShare Extensionは必須にしない。追加しても任意アプリの選択テキストを読み取る権限が生まれるわけではない。既存のShortcutsコントロールとアプリ本体のIntentで先に成立させる。
- 解析・登録UIはVocab Trainer内に表示する。他アプリへの任意オーバーレイやコントロールセンター内の登録画面は要件に含めない。[Apple: Snippetの制限](https://developer.apple.com/documentation/appintents/displaying-static-and-interactive-snippets)

## 3. 現状の実装と不足

| 層・ファイル | 既存の動作 | 今回の差分 |
| --- | --- | --- |
| `frontend/ios/App/App/CaptureIntents.swift` | `ReadScreenImageIntent`は必須`IntentFile`、`ReadSelectedTextIntent`は必須`String`を受信してアプリを開く | 自動取得そのものは行わない。ショートカット完成品と入力なし導線を追加する |
| `CaptureInbox.swift`（同ディレクトリー） | 保護されたローカル受信箱、24時間期限、画像・テキスト・再送要求を保持 | 必要なら入力なし起動要求と下書き保存を後方互換で追加する |
| `NativeCapture.swift`（同ディレクトリー） | 写真選択、Vision OCR、`zh-Hans`/`zh-Hant`/`en-US`、画像向き補正、行結合 | OCRの言語非対応・失敗表示と境界検証を強化する |
| `frontend/src/platform/capture.ts` | Capacitor bridge、入力モデル、24時間内の再試行 | native変更と型を一致させる |
| `frontend/src/hooks/useCaptureInbox.ts` | 受信イベント・復帰・初回ロードで一覧取得 | イベント取りこぼし、連続受信、古い非同期結果を検証する |
| `frontend/src/components/capture/CaptureLaunchNotice.tsx` | ホームで自動遷移、他画面では通知、回答未同期なら抑止 | 安全に切り替えられる画面と未保存画面を明確化する |
| `CaptureWorkspace.tsx`（同ディレクトリー） | OCR範囲選択・原文編集。「画像を選ぶ」が常時表示 | 受信済みなら解析を主導線にし、汎用的な入力・エラー画面にする |
| 同上 | 出典初期値が`小红书`。capture切替時に出典・`newKey`等の全状態を初期化していない | 出典は空を既定にし、入力間の編集状態混入を防止する |
| `frontend/src/components/ImportView.tsx` | capture確認→通常入力画面→解析、同じ要求をローカル保存して再送 | 本文の二重入力画面を減らし、保存・解析処理を共通化する |
| `frontend/src/hooks/useImportSession.ts`とimportコンポーネント | 文・意味単位・単語・構文表示、既存A/B登録・所属回復 | 解析・登録エンジンを複製せず接続する |
| `backend/src/import-ingestions.ts`、`routes/import.ts`、`firestore.ts` | `sourceOrigin`検証、`ingestionId`によるtransactionとreceipt | 原則そのまま。新しい取得methodが必要な場合だけ両側型・validationを追加 |

現行Intentを単体でコントロールセンターへ置いても、必須画像／文章が自動的に埋まるわけではない。ここをアプリのOCR不足と混同しない。

## 4. 完成後の操作フロー

### 4.1 「画像を読み解く」

```text
対象アプリで読みたい部分を表示
  → コントロールセンターのショートカット
  → コントロールセンターを閉じる（対応OSで確認した手順）
  → OSがスクリーンショットを取得
  → ReadScreenImageIntentに画像を直接渡す
  → Vocab Trainerの受信画面 → 端末内OCR
  → 文章／構文の範囲を選択・原文を修正
  → 登録先と解説言語を確認して「解析する」
  → 文の意味・意味のまとまり・単語／文法 → A/B登録
```

1. **撮影より前にVocab Trainerを開かない。** 現行Intentは前面化するため、スクリーンショット取得はIntent呼び出しの前に完了させる。
2. 「画像」引数は撮影アクションの出力変数に固定する。「毎回尋ねる」「ファイルを選択」「写真から選択」を主フローに入れない。
3. コントロールセンターを閉じるアクションの名称・利用可否と、描画が落ち着くまでの待機値をOS別に実測する。存在未確認のアクションや固定待機だけで全端末対応としない。
4. 取得直後は画像プレビュー・取得時刻・OCR進捗を示す。写真選択ボタンは「別の入力方法」に移す。誤った画面なら登録前に中止できる。
5. コントロールセンター、起動バナー、黒画面が写った場合は再取得方法を案内する。OCRゼロ件を成功扱いしない。自動判定の精度を前提にせずプレビュー確認を残す。
6. 撮影失敗を「最新の写真を取得」で代替しない。古い画面が混入するため禁止する。

### 4.2 「選択した文章を読み解く」

入口ごとに取得方法を説明し、解析部分は共通にする。

| 優先 | 経路 | 動作 |
| --- | --- | --- |
| 1 | 選択→コントロールセンター、OSが本文を提供 | 受信テキストを確認画面へ。選択範囲と一致するかM0で検証する |
| 2 | 選択→共有→読み解くショートカット | `Shortcut Input`を既存テキストIntentへ渡す |
| 3 | 選択→コピー→コントロールセンター | 「コピーした文章を使う」を明示してClipboard取得→確認画面へ |
| 4 | 入力なし／URLのみ／コピーできない | 入力案内を開き、共有・貼り付け・画像経路を選べるようにする |

主ショートカットは「画面上の内容を受け取る」を試すが、**空入力時の自動Get Clipboardは使わない**。空ならメニューで「コピーした文章を使う」「入力方法を開く」「キャンセル」を選ぶ。コピー操作を前提とする短縮版を用意する場合は、その前提が名前／設定画面で分かるようにし、本文の確認を省かない。

- 選択とコピーは別操作。選択だけではクリップボードを更新できたと判断しない。
- Clipboardの文字列が新しい選択範囲と一致する証拠は得られないため、コピー時刻の推測や「最新選択」という表示をしない。
- OSから届いた項目がページ全体の文章なら、選択文章を取得したと偽らず、範囲を編集してもらう。
- Rich Textは本文文字列へ変換する。URL型を無条件に「URLの内容を取得」「記事を取得」へ渡さない。
- URLだけの入力は本文としてLLMへ送らず、出典URLの候補と入力案内を表示する。本文とURLが混在する共有文は編集可能にし、自動で本文を切り捨てない。
- ログイン済み記事のcookie、HTML、アプリ内部DBを取得する処理は追加しない。
- 入力時点で自動解析や辞書登録はしない。入力が届けば直ちに確認・解析UIを開き、利用者の「解析する」で送信する。

### 4.3 解析・登録UI

- 画像: プレビュー→候補範囲→原文編集→解析。テキスト: 原文編集→解析。受信済みテキストに写真選択を主操作として出さない。
- `CaptureWorkspace`内に既存の登録先選択UIを再利用し、`ImportView`の通常入力画面を再度通らなくてよい構成にする。内部の作成・再送ロジックは一つにする。
- 出典名は空を既定とし、任意入力または小红书／财新の補助候補を用意する。アプリ名を自動検出できたことにはしない。
- 初期のコンパクト解析後は既存読解画面を開く。短い一文ならその文の解説を開き、複数文なら文一覧から選べる。詳細解説は既存の必要時取得・保存に従う。
- 単語には原文中の該当箇所・読み・文脈上の意味、構文には該当範囲と役割を示し、既存のA/Bボタンを使う。意味のまとまりをまたぐ構文の表示を維持する。
- 解析完了と辞書登録完了を区別する。登録は選んだ項目のみ。成功チェックは実DB所属に基づく。
- 英語・日本語・韓国語のReact翻訳とnative文字列を追加する。エラーコードを利用者へそのまま出さない。

## 5. ショートカットの提供物と互換性

実装の成果物にはSwiftだけでなく、利用者が実際に設定できる2本のショートカットを含める。

### 5.1 画像ショートカットの仕様

```text
（実機で確認した）コントロールセンターを閉じる
  → 必要最小限の待機（M0の結果に基づく）
  → スクリーンショットを撮る
  → 取得失敗／空なら停止・案内
  → Vocab Trainer「画像を読み解く」
       Image = 撮影した画像
       入力元 = screenshot-shortcut（追加する任意パラメータ）
```

OSが提供するアクションの名称・引数・接続変数をスクリーンショット付きで記録する。閉じる操作を利用できないOSでは背面タップ／アクションボタン経路を案内し、コントロールセンター方式が使えたとは記録しない。

### 5.2 テキストショートカットの仕様

```text
共有入力／対応する画面上の入力を受信
  → 非空テキスト（URLのみでない）なら本文として渡す
  → 入力なし／URLのみなら選択メニュー
       「コピーした文章を使う」→ Clipboardを一度取得 → テキストIntentへ
       「入力方法を開く」→ 入力なし専用Intentへ
       「キャンセル」→ 終了
  → Vocab Trainerで本文確認・解析・登録
```

型判定は入力項目の種類を優先する。複数入力が来たら黙って最初だけ採用せず、選択または明示結合の確認をする。空・長さ超過・URLのみの詳細判定はアプリ側にも置く。

### 5.3 配布と既存設定

- 追加予定の`docs/shortcuts/README.md`へアクション順序、OS差、名前、変数、権限確認、更新手順を記録する。生成・署名・共有できる環境なら実行確認済みの`.shortcut`を添付する。未検証のplistや架空のiCloud URLを配布物としない。
- コントロールセンターに2つの「ショートカット」コントロールを置き、それぞれ完成品を割り当てる。OSが許さない自動インストール・自動配置を約束しない。
- 既存Intentの識別子と必須入力名を保つ。画像の入力元パラメータ追加時は既定を`shared-image`、文章は`shared-text`とし、古いショートカットを壊さない。
- アプリ更新でユーザー作成ショートカットも自動更新されたとは扱わない。旧版の診断方法（ファイル選択が出る、Textを毎回尋ねる等）と設定変更手順を用意する。

## 6. 実装設計

### 6.1 Native受信

1. 現行の画像・文章受信Intentは維持する。画像は`shared-image`／`screenshot-shortcut`、文章は`shared-text`／`paste`という入力元の限定値を任意パラメータとして渡せるようにする。任意文字列をそのまま信用せず、入口ごとに許可値を検証する。
2. 入力なしで確認UIを開く`OpenReadingInputIntent`（仮名、新規）を追加する。必須`String`を安易にoptionalへ変更してShortcutsの旧設定を壊さない。URLのみの共有を引き継ぐ場合は、この新規Intentに任意の出典URLを渡し、HTTPS・長さ・資格情報なしを検証して起動要求に保持する。URLを本文として扱わない。
3. 入力なしIntentは空テキストのcaptureを作らない。`CaptureInbox`内に本文と別の、期限付き起動要求を原子的に保存する。例: `{ id, mode: "text", receivedAt }`。通知だけに頼らず、コールド起動後に読み出せるようにする。取り出し・確認済み化・ログアウト削除のbridgeを用意する。
4. 起動要求の取り扱いはcapture一覧と分離する。既存の画像／テキスト`inputKind`に架空の空本文を混ぜず、通常の解析要求にも載せない。
5. 空、空白、8,000 UTF-16単位超過、画像の容量・画素超過はアプリ／Intent双方で検証する。日本語の「文字数」とUTF-16の差はemoji境界テストで確認し、途中で切らずに編集を促す。
6. ロック中は既存のprotected-dataチェックで止める。アンロック後の再操作を案内する。読み込み失敗で壊れた受信レコードを残さない。
7. Clipboardの取得はショートカットの明示操作を基本にする。アプリ内は通常のtextarea貼り付けを必ず提供し、必要なら`UIPasteControl`を公開APIに沿って統合する。バックグラウンド・起動時・復帰時の自動読み取りは追加しない。[Apple: UIPasteControl](https://developer.apple.com/documentation/uikit/uipastecontrol)

### 6.2 受信モデルと出典

既存`ImportSourceOrigin.version = 1`を継続し、以下のmethodを使う。

| 入口 | 保存値 | 備考 |
| --- | --- | --- |
| 撮影を組み込んだショートカット | `screenshot-shortcut` | 既存backendで受理可能 |
| 共有された画像／旧画像Intent | `shared-image` | 旧設定の既定値 |
| 写真を選ぶ代替入口 | `image-picker` | 主導線にはしない |
| 共有／画面入力で届いた文章 | `shared-text` | 選択範囲の一致を保証する値ではない |
| 明示コピー・貼り付け | `paste` | 選択そのものとは区別 |

`sourceLabel`は利用者が確認した文字列、`sourceUrl`は任意のHTTPS出典情報、`sourceKind`はpost/comment/article/unknownを継続する。`capturedAt`は現状ではアプリ受信時刻なので、厳密なOS撮影時刻と表記しない。送信確認後にのみ`textConfirmed: true`を付ける。

新たに`onscreen-text`等を増やす必要はない。増やす判断をする場合は`frontend/src/types.ts`、`backend/src/types.ts`、`backend/src/import-ingestions.ts`、APIテスト、旧クライアントのread/write互換を同時に変更する。originは作成後に通常PUTで上書きできない既存契約を守る。

### 6.3 起動とReact状態

状態遷移は以下を基準にする。解析・辞書登録の状態は既存モデルを使う。

```text
input-required → received → recognizing（画像のみ）→ confirming
  → creating-source → analyzing → review → registering / registered
各段階 → recoverable-error → 同じ操作を再試行
ローカル入力 → discarded / expired
```

- nativeイベントに加え、認証確立後・初回マウント・foreground復帰時に受信箱と起動要求を読み直す。初回通知がReact起動前に発生しても回復できるようにする。
- 連続受信ではcapture IDを識別子にし、表示中の入力を新着で上書きしない。新着一覧／通知から切り替える。非同期結果は世代番号またはIDで照合し、古いOCRやlist応答を適用しない。
- ホームなど安全な画面では直接開く。クイズ、回答outbox待ち、単語／文法登録処理中、未保存の入力・記事編集では通知を表示し、同期／保存後に開く。単にルート名だけで「編集なし」と判定しない。
- capture ID変更時は本文だけでなく`label`、`sourceKind`、`url`、`selected`、`newKey`、エラー、解析状態を初期化する。再試行要求がある場合は本文・出典・登録先をその要求から復元する。
- `acknowledged`は「確認画面を開いた」の意味に保ち、解析済み・登録済み・削除済みと混同しない。
- 未送信編集はcapture単位のローカル下書きとして保存する案を採用する。既存JSONにoptionalな`draft`を追加し、旧データを読めるようにする。選択block IDs、編集本文、出典、登録先を保存する。24時間期限・100MiB総量・logout削除を同じく適用し、`operations`の凍結済み要求は変更しない。
- 入力なし画面の編集内容も、最初の実テキスト確定時にtext captureへ移す。OSが終了しても続けられる範囲と、短いdebounce中に保存前終了した場合の限界をテスト・文書化する。

### 6.4 OCRと繁体字／簡体字

- Visionの`.accurate`と対応言語一覧を利用する既存方式を継続する。`zh-Hans`と`zh-Hant`を両方指定できたか記録し、中国語非対応時に黙って英語OCRだけで成功扱いしない。[Apple: VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)
- OCRのためにクラウド画像APIやApple Intelligence対応機種を必須にしない。
- 入力原文を勝手に簡体字へ統一しない。繁体字・簡体字が混在する文章、句読点、改行、数字、Latin文字、emojiを保持する。辞書の語形重複判定は既存ルールを使い、今回の取得改善に繁簡同一語のDB統合を混ぜない。
- `language = chinese`は学習言語、`zh`は定義等のISOコード、`zh-Hans`/`zh-Hant`はOCR言語指定。互換でない箇所に代入しない。
- 向き補正後の画像とOCR座標を一致させる。右上／左下座標変換、縦横画面、拡大時の選択を検証する。
- 現行の「行間・左端・幅が近い行を結合」は文章・構文の解析そのものではない。OCRブロックは候補であり、既存解析が文・構文を分解するという役割を保つ。
- 別コメントや段組みを自動で一つの発話にしない。行の読み順・間隔を使った保守的な結合と利用者の複数選択を維持する。短い最終行など結合不足は編集で回復できるようにする。
- 小さな文字・低コントラスト・縦書き・複雑な段組みは測定対象にする。未検証なら保証範囲に入れず、修正可能な原文と選択一覧を残す。

### 6.5 共通解析とDB登録

- `ImportView.handleAnalyze`からcapture作成部分を共通関数／hookへ抽出し、確認UIから直接呼べるようにする。通常外部ソース入力の動作を変えない。
- 作成は現行`POST /api/import/:language/sessions`、`analyzeAsJob: true`、空の`paragraphs/items`、新規UUID v4の`ingestionId`で行う。初回送信前に完全なrequestをローカルの`operations`へ保存する順序を維持する。
- 応答が失われた場合は同じID・同じrequestを再送する。新規201／再送200、同じIDで内容変更409、削除済み410を区別する。24時間を過ぎたローカル操作を自動再送しない。receiptは7日保持なので永続的な重複保証とは扱わない。
- 二重タップは作成処理中のロックで抑止する。別々のIntent実行は別captureとして扱い、同一本文という理由だけで黙って既存ソースへ吸収しない。
- 送信後に原文を修正する場合は「別のソースを作る」で新しいoperationとingestion IDを作る。既存の登録結果やソース本文を上書きしない。
- 初回解析は既存のdurable jobと認証付き監視で継続する。詳細解説は既存の保存方式であり、バックグラウンドでも必ず保存されると案内しない。
- 単語・文法登録は`useImportSession.registerItem`等の既存キューへ渡す。新規専用登録API、画面側からの直接Firestore書き込み、A/B別コピーを作らない。
- 単語はA最大1所属、文法はA複数可、Bは重複可。B追加で既存Aを移動しない。A移動のadd-before-remove、共有例文参照、index整合、A/Bごとの失敗・再試行を維持する。
- クイズのscope・採点・retryロジックは変更不要。Bへ登録した項目が既存のlive B reconciliationで反映されることを回帰確認し、standalone B quizを復活させない。

### 6.6 エラーと回復

| 状態 | 表示・回復 | 禁止する挙動 |
| --- | --- | --- |
| 入力なし | 共有／コピー／画像の案内 | 必須引数待ちだけで終了する |
| URLのみ | 本文を取得できていない旨と再入力 | 有料記事・コメント本文の自動取得 |
| OCRゼロ／中国語非対応 | 別の範囲、文字をコピー、再撮影 | 空ソースを作成する |
| 低confidence | 原文修正を促す | 誤認識を自動登録する |
| 8,000超過 | 分割・編集を案内 | 無断切り捨て |
| 受信箱満杯 | 一覧と不要入力の削除 | 未処理入力を無断削除 |
| 期限切れ | 新規取得を案内、保存済みソースは通常一覧へ | 新しいIDで自動再送 |
| 401／認証待ち | 入力を保持してログイン後に再開 | 認証なしで送信 |
| offline／5xx | 端末内確認は可能、同じ要求で再試行 | 成功表示・要求IDの再発行 |
| 409／410 | 内容変更／ソース削除を区別し、新規作成は明示操作 | 無限再試行 |
| 登録の部分失敗 | 項目と登録先ごとの再試行 | 成功したA/Bも未登録扱いにする |

画像・未確認原文・下書きは既存の端末内保存に限定し、バックアップ除外とファイル保護を継承する。ログには本文・画像・Clipboard・tokenを出さない。原文中の命令は解析対象データとして扱い、LLMへツール実行や任意URL取得を許可しない。確認済み本文と出典だけを既存APIへ送る。

## 7. 実装順序と作業単位

### M0: 実機で入口を確定する（他のnative変更より先）

1. 本人のiPhoneの機種・OS、Xcode/SDK、署名方式、現行Intentの実行可否を記録する。
2. 画像ショートカットを手作業で構成する。小红书・财新・Safariで各10回撮影し、対象画面／Control Center／バナー混入／失敗を数える。冷起動と既存起動を含める。
3. 選択だけ→Control Center、選択共有、コピー→Control Centerを、同じ文章で比較する。空・URL・選択範囲・全文・古いClipboardを区別して記録する。
4. 既存Intentから確認UIが開くことを確認する。Personal Teamで失敗する場合は署名／実行ターゲットを調べ、Simulator成功で代用しない。
5. 画面取得が安定しない場合は、OSで使える閉じる操作・タイミングを修正して再検証する。それでも失敗ならIMG-1を未達として報告し、背面タップ等の代替経路を併記する。

成果物: `docs/ios-verification.md`への日付付き追記、2本の手順、OS×アプリ×入力型の結果表。個人の記事画像をリポジトリへコミットしない。

**終了条件:** 主経路と制限が実測で決まっていること。実機が使えない場合は共通UI・型・テストなど独立作業を進めてよいが、入口の実現性確認は未完のまま残す。

### M1: ショートカットとnative契約

- 既存Intentへ互換性を保った入力元指定を追加する。
- 入力なし専用Intentと起動要求の永続化・bridgeを追加する。
- 空・長さ・画像制限・URLのみの分類を実装し、エラーを識別可能にする。
- 旧Intent、既存capture JSON、旧ショートカットが動作することを確認する。
- 配布用手順と設定診断画面を用意する。

### M2: 受信UI・下書き・起動処理

- 汎用出典、画像／テキスト別の主導線、入力なし案内、本文確認、登録先選択を実装する。
- capture切替時の全状態リセット、下書き保存・復元、新着の扱いを追加する。
- 通知・コールド起動・ログイン復帰・未同期キューを統合する。
- Playwrightで360px表示と状態遷移を検証する。

### M3: 解析接続・OCR品質・登録

- 確認UIから同じ既存解析処理を呼び、入力画面の重複を除く。
- 繁簡OCR・選択範囲・文分解・意味単位表示を確認し、必要なOCRの結合修正だけ行う。
- 作成通信断・二重タップ・再試行・A/B登録失敗を回帰確認する。
- `sourceOrigin`の既存契約で足りる限りbackend schemaやLLM promptを変更しない。

### M4: 実機E2E、文書、配備

- M0の操作を完成UIから繰り返し、原文確認→文の分解→単語・文法各1件のA/B登録をemulator／試験用データで確認する。
- EN/JA/KOの案内を確認し、`docs/screen-reading-import.md`と開発リファレンスを実装に合わせて更新する。古い検証結果は日付付き履歴として残す。
- 通常Webとnative同梱画面の両方を確認する。Webを変更しただけではiPhoneが更新されないことをリリース説明に記載する。
- master確認→対象差分コミット→push→通常deploy→production向けios sync→Xcode実機更新をそれぞれ記録する。配備の制約は第10節に従う。

## 8. ファイル別の変更予定

以下は予定であり、この文書作成時には実装しない。native新規ファイルを分割する場合はXcode targetへの登録も行う。

| 対象 | 変更内容 |
| --- | --- |
| `frontend/ios/App/App/CaptureIntents.swift` | 互換性のあるmethod指定、入力なしIntent、入力検証 |
| `frontend/ios/App/App/CaptureInbox.swift` | 起動要求・optional下書き、期限・容量・削除の適用 |
| `frontend/ios/App/App/NativeCapture.swift` | 起動要求／下書きbridge、OCR非対応・失敗の分類 |
| `frontend/ios/App/App/Localizable.xcstrings` | Intent説明・パラメータ・入力／エラー案内のEN/JA/KO |
| `frontend/ios/App/App.xcodeproj/project.pbxproj` | ファイル分割やテストtarget変更時のみ。既存未コミット編集と照合 |
| `frontend/src/platform/capture.ts` | native契約、下書き型、起動要求型 |
| `frontend/src/hooks/useCaptureInbox.ts` | 冷起動・復帰・競合対策 |
| `frontend/src/components/capture/CaptureLaunchNotice.tsx` | 安全な画面遷移、入力なし起動の通知 |
| `frontend/src/components/capture/CaptureWorkspace.tsx` | 主導線、出典初期値、原文確認・下書き・状態リセット |
| `frontend/src/components/capture/CaptureImage.tsx` | OCRプレビューと選択のアクセシビリティ。必要な場合のみ |
| `frontend/src/components/ImportView.tsx` | 解析入口の共通化、二重入力画面の解消 |
| `frontend/src/hooks/useImportSession.ts` | 共通処理抽出で必要な接続だけ。登録規則は維持 |
| `frontend/src/i18n/translations.ts` | EN/JA/KOの全表示・説明・エラー |
| `frontend/src/types.ts`、`backend/src/types.ts`、`backend/src/import-ingestions.ts` | method追加等が必要な場合のみ、両側互換変更 |
| `frontend/tests/browser/capture.pw.ts`、`harness.tsx`（同ディレクトリー） | テキスト／入力なし／切替／失敗／再試行ケース |
| `frontend/ios/App/AppUITests/NativeSmokeTests.swift` | 合成画像と文字入力・復帰・native連携 |
| `docs/shortcuts/README.md`（新規予定） | 実行確認済みショートカットの構成と設定手順 |
| `docs/screen-reading-import.md`、`docs/ios-verification.md`、`docs/development-reference.md`、`README.md` | 現行操作・検証結果・対応範囲を更新 |

## 9. テストと受け入れ基準

### 9.1 自動テスト

| 分野 | 必須ケース |
| --- | --- |
| 入力分類 | 空白、URLのみ、本文＋URL、Rich Text、複数項目、emoji、8,000境界、超過 |
| native互換 | 旧JSONでdraftなし、旧Intentの既定値、ロック、容量上限、期限切れ、atomic write失敗 |
| 下書き | capture別復元、出典／選択／登録先、logout削除、凍結requestを変更しない |
| 起動 | 冷起動、既存起動、ログイン後、React listener前受信、連続2件、未同期outbox |
| OCR | 繁体・簡体・混在、横長、回転、低confidence、ゼロ件、対応中国語なし、段落と別コメント |
| UI | 写真選択なしで受信画像を表示、テキストから解析、出典が小红书固定でない、capture間で値が漏れない |
| ソース作成 | 二重タップ、通信断、同じID再送、409／410、期限切れ、修正して別ソース |
| 登録 | 単語／文法、A/B、既存語、A保持、B部分失敗、実所属の再取得 |
| 読解 | 繁体原文保持、UTF-16範囲とemoji、複数文、跨る構文、意味単位追加で登録済み候補を保持 |
| 回帰 | 通常Web外部ソース、旧画像選択、旧共有テキスト、記事A/B quiz、mixedの既存suite |

Swiftの純粋な入力分類・保存モデルは必要ならtest targetで検証する。UI連携は既存XCUITestに追加する。mockの`NativeCapture`が成功しただけでOSの画面取得・選択文字取得を検証済みにしない。

実装完了時の基本チェック（Node 24を使用）:

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:import --prefix backend
npm run test:mixed --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
npm run build:ios --prefix frontend
npm run test:browser --prefix frontend -- capture.pw.ts import.pw.ts
git diff --check
```

Firestore transactionやAPIを変更した場合は`npm run test:import:emulator --prefix backend`も実施する。full-stackのスモークは`./local.sh`系のemulator手順を使用し、裸のbackend `npm run dev`で本番に接続しない。LLMはmockで状態を検証し、実LLM品質は別に記録する。

nativeはlocal sync・合成サーバーを用意してから[iOS検証記録のxcodebuild手順](../docs/ios-verification.md)を使う。実機名・SDKは実行時の利用可能なものに置き換える。local syncの資産をReleaseへ混入させず、配布前にproduction syncする。

### 9.2 実機検証表

| 対象 | 入力・操作 | 合格条件 |
| --- | --- | --- |
| 小红书 | 投稿本文、コメント、画像内文章、選択できない箇所 | 画像主経路で取得→範囲確認→解析→登録できる |
| 财新 | 表示中の記事の簡体字本文 | 選択入力の実態を記録し、対応経路で解析→登録できる |
| 繁体字の画面 | 自作の繁体字記事／メモ、繁簡混在 | 原文が繁体字のまま保持され、意味と候補が対応する |
| Safari、メモ等 | 小红书・财新以外の2アプリ以上 | 特定アプリ名／内部URLに依存せず同じUIで処理できる |
| 各対象 | 選択だけ／共有／コピーを個別実行 | 入力が空、選択範囲、全文、URLのどれかを識別して説明できる |
| Clipboardに別文を事前保存 | 別の文章を選択しただけで起動 | 古い文を自動で解析・登録しない |
| ロック／認証期限／通信断 | 途中から再開 | 不正送信せず、保持した入力／同じ要求から回復する |
| 起動状態 | 未起動、ホーム、他画面編集中、クイズ回答未同期 | 開ける状態なら直接表示、それ以外は作業を保護して通知 |

最終受け入れではIMG-1/2、TXT-1/2、DB-1、SAFE-1を個別に合格／条件付き／未達で記録する。主要アプリの画像経路は各10回の確認で誤った画面0件を目標とし、1件でもあれば再現条件を調査する。所要時間も測り、撮影→確認画面と解析時間を分けて報告する。実機なし、実LLMなし、特定OS未試験はそのまま未確認と記載する。

## 10. 配備・ロールバック・完了定義

1. この依頼は計画作成であり、機能実装・Shortcuts設定変更・iPhone更新は後日の担当エージェントが行う。
2. 後日の実装ではリポジトリ指示に従い、ブランチ・作業ツリーを確認して対象差分だけcommitし、`git push origin master`、`./deploy.sh`を実行する。master以外なら勝手に切り替えない。
3. 今回想定する差分では通常deployでよく、`--llm`／`--auth`／`--prompts`、本番データのbulk migrationは不要。実装で設定変更が必要になった場合は別途変更内容を明確にする。
4. Cloud Runの更新とnative更新は別工程。`npm run ios:sync --prefix frontend`後にXcodeから同じ署名・Bundle IDで更新し、IntentがShortcutsに見えることを実機で確認する。
5. ショートカットの導入・更新、Control Centerへの割り当て完了まで確認して初めて入口を利用可能とする。cloud deployだけでIMG-1/TXT-1完了としない。
6. ロールバックは旧Shortcutsへ戻せること、旧nativeから既存backend契約が利用できることを重視する。既存Intentは削除しない。保存済みのソース・単語・文法を消さず、新しいoptionalローカル項目は旧読込を阻害しない設計にする。
7. Docker/gcloud/認証、署名、実機が使えない場合は実施できたチェックと未完工程を分けて報告する。未検証の本番データやOSの動作を成功と記載しない。

完了報告には、2経路の実際の操作、対応OS・アプリ別の制限、コミット、push、Cloud Run配備、iPhone更新、Shortcuts設定、テスト結果を記載する。特に「選択しただけで届くか」「コピーを要するか」を曖昧にしない。

## 11. 今回採用しない案と再検討条件

- **ScreenCaptureKit全画面取得:** Shortcuts撮影が対象端末で成立せず、利用者がシステム許可・画面へ戻る操作を含む別フローを求める場合に再検討する。iOS 27対応、背景実行、1枚確定後の停止、キャンセル、署名を検証する。サンプルのマイク・カメラ・写真保存をそのまま移植しない。
- **ReplayKitの継続録画／Broadcast Extension:** 1回の読解に対して設定・録画管理が増えるため今回の必須方式にしない。
- **独自Control Widget／Share Extension:** 標準Shortcutsで配布・入力が成立しない具体的な理由が判明した場合にのみ評価する。必要ならApp Groups・無料署名・プロセス間受渡しを別計画にする。
- **画面全体の自動解析・自動DB追加:** 誤取得と不要項目登録を避けるため、範囲／原文確認と項目登録の操作を残す。
- **アプリ別スクレイピング／URL全文抽出:** 汎用性と既存の入力契約から外れるため含めない。

## 12. 次のエージェントの開始チェックリスト

- [ ] `AGENTS.md`と本計画、現行ドキュメントを読む。
- [ ] `git status`／ブランチ／最新コミットを確認し、既存のiOS編集を保全する。
- [ ] 計画時点から追加された実装と実機検証を確認し、重複作業を除く。
- [ ] M0で画像取得と選択テキストの入力実態を確定する。
- [ ] M1→M2→M3を実装し、旧Intent・旧capture・既存DB登録との互換を保つ。
- [ ] M4の実機・emulator・回帰テストと資料を完成させる。
- [ ] 未達要件を明示した上で、push／cloud配備／native更新／Shortcuts設定を別々に報告する。
