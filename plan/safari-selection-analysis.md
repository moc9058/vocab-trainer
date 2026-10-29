# Safari選択テキスト分析拡張・詳細実装計画

作成日: 2026-10-29。これは別エージェントに引き継ぐ実装計画であり、以下の新規ファイル・API・設定はまだ存在しない。現行ソースを確認した設計と、実機で確定する事項を区別する。

## 1. 完成させる体験と対象

Safariのページ上で中国語を選択すると近くに「分析」が表示される。押すと同じページのパネルに原文・進捗・文ごとの分析が表示され、各文を意味のまとまりに分割して、意味・役割・単語・文法構文を説明する。各候補から既存DBへ登録できる。分析そのものによる外部ソースの保存と、ユーザー操作による単語／文法の本登録は区別する。

- 初版の必須対象はmacOS Safari。iPhone/iPad Safariも同じWeb Extension資産を使って実装し、選択ハンドル・標準メニューとの共存を実機確認する。iOSを省略して完成扱いにしない。端末がない場合は未検証と明記する。
- 学習言語は `chinese` 固定。繁体字・簡体字をそのまま扱い、自動変換しない。UIは既存方針に従い日本語・英語・韓国語。説明言語の設定も既存処理に従う。
- 通常のHTTP(S)ページの本文を対象とする。入力欄、password、textarea、contenteditable、ブラウザ内部ページ、PDF、画像、canvas、権限のないiframeは初版対象外。Readerモードの可否は実機確認し、対応を約束しない。
- 原則はその場のパネル。サイトCSP等により拡張パネルを埋め込めない場合は拡張専用タブに同じ結果画面を表示する。単にWeb版を開いてコピー・貼り付けさせるだけでは完成としない。
- OCR、ページ全文の自動取得、URL先のサーバー取得、Chrome配布、App Store公開作業は今回の必須範囲外。既存iPhone画面取り込みは維持する。

## 2. 調査済みの再利用先

| 既存箇所 | 確認した契約と利用方法 |
| --- | --- |
| `backend/src/routes/import.ts` | `POST /api/import/:language/sessions` に `analyzeAsJob: true` と空の `paragraphs/items` を渡して外部ソースを作成。現在の本文上限はJS文字列長8,000、要求全体は900,000バイト。 |
| `backend/src/import-ingestions.ts` | UUID v4の `ingestionId` と要求ダイジェストで再送を識別。200再取得／201作成／409入力不一致／410削除済み。既存の保存トランザクションを利用する。 |
| `backend/src/import-analysis.ts`, `import-parts.ts`, `import-jobs.ts`, `routes/import-jobs.ts` | 既存の分割解析・durable jobを使用。拡張backgroundでLLM処理を継続させない。 |
| `backend/src/import-reading-analysis.ts`, `import-meaning-units.ts`, `import-explanation-config.ts` | 読解・意味単位の生成と検証。初期compact解析にはcomprehensionがない。詳細解説を別途要求しないと意味単位は得られない。 |
| `frontend/src/api/import.ts` | 作成、ジョブ開始／取得／再開、詳細解説APIの既存契約。詳細は `POST /api/import/:language/sessions/:sessionId/sentences/:sentenceIndex/explanation`。 |
| `frontend/src/hooks/useImportAnalysisJob.ts` | 進捗・再接続・ジョブの再開処理を再利用する。ただし拡張では認証付きfetch/pollingに差し替える。 |
| `frontend/src/components/import/ImportMeaningUnits.tsx`, `ImportComprehension.tsx`, `ImportSentenceCard.tsx` | 解説UIと候補への導線を再利用する。意味単位を跨ぐ構文も表示可能。 |
| `frontend/src/utils/importMeaningUnitDetails.ts`, `importMeaningUnits.ts` | 検証済みのUTF-16範囲から単語／構文を対応付ける。文字列一致だけで関連付けない。 |
| `frontend/src/hooks/useImportSession.ts` | `registerItem(id, target)` はA/B別の登録、既存候補・重複・途中失敗の回復を扱う。 |
| `frontend/src/hooks/useWordQueue.ts`, `useGrammarQueue.ts`, `useImportGroups.ts`, `useImportLibraryStatus.ts` | smart-add、membership、例文、保存状態の処理を共有する。DBへ直接書く拡張専用実装を増やさない。 |
| `frontend/src/components/import/ImportDestinationRail.tsx` | A/B登録先選択を共通化する。 |
| `frontend/src/auth/context.tsx`, `api/transport.ts`, `backend/src/routes/auth.ts`, `mobile-auth.ts`, `index.ts` | WebはHttpOnly/SameSite=Lax Cookie、nativeはBearer。現状のBearerはmobile用であり、拡張用トークンがそのまま通るわけではない。 |

先に読む資料: [README](../README.md)、[開発リファレンス](../docs/development-reference.md)、[画面取り込み](../docs/screen-reading-import.md)、[修正・読解支援](../docs/source-revisions.md)、[iOSアプリ](../docs/ios-personal-app.md)。認証はallowlistによる単一共有データセットであり、ユーザー別DBを新設する案件ではない。

## 3. アーキテクチャ

```text
閲覧サイトのcontent script
  ├─ 選択検出、分析ボタン、選択文字列の固定
  └─ runtime message → background（タブ/フレームと要求を照合）
                             ├─ 認証・許可済みAPIだけの通信
                             └─ extension originの結果UI
                                    ├─ 既存React読解UI
                                    ├─ 既存登録キュー
                                    └─ Firestore上のimport session / analysis job
```

結果UIは拡張に同梱したHTML/JS/CSSを使用し、Web版の本番ページを第三者ページのiframeへ入れない。ページ上はextension originのiframeを候補とし、macOSは右側パネル、iOSは全画面に近いシートにする。表示用ホストはShadow DOMでスタイルを分離するが、Shadow DOM自体を秘密保持の境界とはみなさない。iframe内からruntime APIを利用できるか、CSP、`web_accessible_resources`、Safariでの送信元情報を最初の試作で確認する。

最初に「選択→パネル→background→固定API origin」の縦切り試作を行う。埋め込み不可サイトでは専用タブへ退避できる設計にしておく。Chrome `sidePanel` API、永続background、`identity.launchWebAuthFlow` のSafari対応を前提にしない。

### ビルド構成（新設案）

- `extensions/safari/`: manifest、content/background、options、message契約、単体テスト、lockfileを持つ独立npmパッケージ。root npm packageは作らない。
- `frontend/src/extension/`: パネルReact entry、API transport adapter、拡張用ルートとproviderの組み立て。既存フック／UIをimportし、別Vite設定で拡張の出力ディレクトリへbuildする。
- `frontend/vite.extension.config.ts`: 相対asset URL、ローカルbundle、extension CSP対応。通常Web/iOS buildには影響させない。
- `extensions/safari/apple/`: XcodeのmacOSホスト＋Safari Web Extension target。iOSは既存 `frontend/ios/App/App.xcodeproj` にtarget追加する案を先に検証し、Personal Teamや既存Capacitor同期を壊す場合は専用ホストに分離する。共有Web資産は同一build出力を参照する。
- `docs/safari-extension.md`: 対応環境、build、署名、インストール、有効化、サイト許可、接続解除、制限、実機検証結果。

生成物・証明書・provisioning profile・トークン・DerivedDataはcommitしない。App GroupsやKeychain共有を既存iOSアプリの必須条件に追加しない。

## 4. 選択・分析ボタンの仕様

1. 権限を付与されたHTTP(S)ページにcontent scriptを注入。`selectionchange` とpointer/keyboard操作の終了をdebounceし、選択が確定してから表示する。タッチドラッグ中は位置を追い回さない。
2. `Selection.toString()` とRangeの矩形を取得。空白だけ、禁止要素、パネル自身の選択は除外。非中国語判定は必須にせず、中国語想定という案内に留める。
3. 選択末尾付近へ「分析」ボタン。viewport、スクロール、拡大率、`visualViewport`、画面回転、複数行、縦書きで画面外に出ないよう補正。Escape／選択解除で閉じる。キーボードでも操作可能にする。
4. ボタン押下時は選択文字列を先にスナップショット化する。フォーカス移動で選択が消えても入力を失わない。範囲の先頭末尾を切り落とさず、解析範囲と表示範囲を一致させる。
5. 8,000 UTF-16 code unitsを超えた場合は切り捨てず、範囲を短くする案内を表示。結合文字／サロゲートペア／絵文字と改行を含む境界をテストする。
6. 選択しただけでは通信しない。初回は「選択部分を分析サービスへ送信し外部ソースに保存する」説明を出す。通常は「分析」の押下を送信意思とし、毎回余計な確認は求めない。
7. 別の選択は新しい分析要求。進行中／未保存登録のあるパネルを上書きしない。元のセッションへ戻る導線を設ける。

初版はtop frameを保証対象とする。同一origin iframeまで対応するならframeごとの選択とtop側パネルを明示的に連携し、権限なしcross-origin iframeを迂回しない。サイト許可を拒否された場合は拡張メニューから有効化方法を案内する。自動ボタンは `activeTab` だけでは常時表示できないため、サイトごとの許可を前提にする。

## 5. 認証と通信

### 採用案: Web版で接続承認する拡張専用Bearer

Cookieをcontent scriptから取り出さず、SameSiteを弱めず、LLMキーを配布しない。既存Googleログイン後にWeb版で拡張の接続を承認し、backgroundだけが扱う期限付きopaque tokenを発行する。これは新規実装である。

提案APIは `/api/auth/extension/*`。既存hookが `/api/auth/*` を通過させるため、各ハンドラが必要な認証を必ず行う。

| API（新設） | 契約 |
| --- | --- |
| `POST /start` | backgroundが生成したPKCE S256 challengeとstateを受け取り、短命なrequest ID、ユーザー照合用コード、有効期限、承認URLを返す。IP単位rate limit、未承認要求数の上限を設ける。 |
| `GET /request/:id` | Web承認ページが要求の状態と照合コードを取得。認証済みCookie必須、トークンやverifierは返さない。 |
| `POST /approve` | 認証済みWeb Cookie、同一origin/CSRF検証、明示的な「接続する」操作を必須にする。request IDと表示コードを確認しallowlistを再検証。 |
| `POST /exchange` | request IDとverifierによる低頻度polling。未承認はpending、期限切れは失敗。承認済み要求をFirestore transactionで一度だけ消費しトークン発行。 |
| `POST /revoke` | 拡張Bearerを失効。接続管理画面から当該ユーザーの拡張接続一覧と個別失効も可能にする。 |

承認URLのreturn先は固定のアプリ内パスのみ。Googleログインが現在rootへ戻ることを考慮し、WebのsessionStorageに短命なrequest IDだけ保持して認証後に復帰する。URLに本文・token・verifierを入れない。state/コード照合と明示承認で別要求の取り違えを防ぐ。

- 接続要求TTLは10分、tokenは初版30日で失効し再接続する。サーバーにはtokenのハッシュのみ保存。期限判定は読み取り時にも行い、物理削除の遅延を認証の有効期間にしない。
- exchange応答が失われた場合は承認済み要求を復活させず、新規接続を案内する。Firestore read failureは503等で閉じ、auth OFFに切り替えない。
- `mobile-auth.ts` の既存Bearer動作を維持しつつ、共通principal解決にcredential種別を持たせる。拡張tokenはimport・語彙/文法登録・グループ参照/必要なmembership・設定参照の必要APIに限定する。管理設定更新、数学、quiz、maintenanceへの権限は与えない。実際の登録キューの通信を一覧化してmethod/path単位の許可表を作り、許可漏れと広すぎる許可をテストする。
- メールallowlistは各リクエストで再チェック。Webログアウトと拡張失効は別状態であることを表示し、「拡張接続も解除」の操作を用意する。
- tokenはbackground専用の保存領域で管理し、content scriptへ返さない。`storage.local` のcontent scriptアクセス制限が対象Safariで使えるか試作で確認。使えなければbackgroundからnative messaging経由でホストのKeychainを使う。未確認の保管方法を安全と断定しない。`storage.sync`は使用しない。
- APIは本番frontendの固定HTTPS origin（現行 `DEFAULT_API_ORIGIN` 参照）へ送る。開発用localhostは別manifest/buildに限定。APIパス・method・JSON schemaをbackgroundで許可表に照合し、汎用URL fetch proxyを作らない。
- MV3のcontent scriptから直接APIをfetchしない。background/extension pageのhost permissionでの通信を検証する。CORSを `*` や全 `safari-web-extension://` 許可へ緩めない。実機上でCORS調整が必要なら必要originだけ許可する。
- 公開対象extension HTMLは閲覧ページから直接開かれる場合もある。背景側が作った短命contextをtab ID/frame ID/session IDに結び付け、送信元extension URLも確認する。`postMessage('*')`、ページ由来任意API要求、本文を含むquery/hashは使用しない。
- ページのスクリプトがクリックを偽装してDB追加できないよう、登録はextension origin内のUIからのみ受け付ける。content scriptには選択送信と表示制御しか許可しない。

## 6. 分析・保存契約

作成要求は既存APIを次の形で使う。登録先の指定は既存UI設定に合わせる。下記 `safari-selection` は新しいenum値であり、backend/frontend両方の型と `parseSourceOrigin` を更新する。

```json
{
  "text": "用户选中的中文原文。",
  "paragraphs": [],
  "items": [],
  "analyzeAsJob": true,
  "ingestionId": "<UUID v4>",
  "sourceOrigin": {
    "version": 1,
    "method": "safari-selection",
    "sourceKind": "unknown",
    "sourceLabel": "<最大100文字のページタイトル>",
    "sourceUrl": "https://example.com/article",
    "capturedAt": "<ISO 8601>",
    "textConfirmed": true
  }
}
```

- `sourceUrl`は任意。既存validatorはHTTPSのみ許可するため、HTTP閲覧元は省略し、偽のHTTPSへ変換しない。URLのuserinfo/query/fragmentは既定で削除。タイトルも任意・編集／省略可とし、本文以外の不要情報を送らない。出典はテキストとして描画し、サーバーはURLを取得しない。
- 既存sourceOriginは作成時だけ設定できる。PUTで書き換えない。session一覧・取得・保存マッピングのoptional fieldを確認し、旧セッションはそのまま読めるようにする。
- 作成成功後、既存 `POST .../analysis-job` に `idempotencyKey` と現在の `analysisRevision` を渡す。作成APIだけでジョブが開始したと扱わない。
- backgroundのメモリだけに状態を置かない。サーバーsessionを正とし、拡張側は要求ID・session ID等の再接続情報を最小限保持する。本文と凍結要求の一時保持は端末内で24時間以内、完了/破棄で削除し、履歴同期しない。保存領域のアクセス制限は認証節と同様に確認する。
- 同一操作のretryは同じingestionIdと完全に同じpayload。本文や出典を編集した場合は新しい操作にする。既存receiptは永久ではないため24時間を超える自動再送をしない。410を新規作成として黙って復活させない。
- 進捗は最初は2〜5秒のGET polling（jitter/backoff、非表示時停止）でよい。復帰時にsessionとjobを取得し直す。BearerをURLへ入れてEventSourceへ渡さない。fetch SSEを採用する場合も切断時はGETへfallbackする。
- compact解析が届いたら原文・候補を先に表示。現在見ている文について詳細解説APIを呼び、意味単位を表示する。全文の詳細解説を無制限に並列生成しない。初版は詳細生成同時実行1、既存解説は再利用する。
- 意味単位の欠落／検証失敗では文全体と候補を表示し、詳細解説を再試行できるようにする。独自LLM／正規表現で仮の意味単位を捏造しない。
- パネルを閉じてもサーバージョブは継続。閉じる操作とpauseを分ける。通信断・401・403・404・409・410・429・5xxは区別し、認証切れで登録POSTを自動再送しない。

## 7. 共有React処理とDB登録

`api/transport.ts` に明示的なtransport interfaceを導入し、通常Web/nativeのデフォルト動作を維持したままextension entryだけRPC adapterを注入する。グローバルfetchのmonkey patchはしない。既存API helperが必要とするstatus/body/header/abortを契約に含める。streamをruntime messageで丸ごと転送せず、初版jobはpollingを使う。関連フックがrouter/Auth/i18n/providerに依存する箇所を先に洗い出す。

- 意味単位→単語/構文→詳細カード→「Aに追加」「Bに追加」の導線を既存UIで実現する。ピンイン、訳、構文内の役割、例文を既存モデルで表示する。
- 登録先Aグループと任意のBグループを見える位置に置く。sourceタイトルからBグループを黙って作らない。初回の候補は既存デフォルト設定を使い、未選択なら選択を求める。
- `useImportSession.registerItem` とword/grammar queueを再利用する。A/B別の状態、同じ候補の二重押下防止、既存entityへのmembership追加、失敗後のreconciliationを維持する。
- UIで「登録済み」にするのは実際のAPI結果とmembership確認後。DBにはA/B別コピーを作らない。既存のdocument/index/shared examples整合性処理を通す。
- 元ページ離脱でiframeが破棄され得る。登録中は専用extensionタブへ移して完了を待つ導線と警告を用意する。通常の閉じる操作はqueueをdrainしてから閉じる。強制終了後は永続セッションとlibraryを照合して回復し、未確認操作を成功扱いしない。初版から独自durable登録サービスを新設する必要はない。
- 親ページからの強制破棄を防げるとは約束しない。登録後の一覧、再表示、複数タブ、A/B連打で回復を検証する。既存Web版のqueue挙動を変える場合は共通回帰テストを追加する。
- 全UI文言を `frontend/src/i18n/translations.ts` で3言語化。拡張manifest名／権限案内もローカライズする。

## 8. 実装順序と完了ゲート

### Phase 0: 対応環境と縦切り試作

1. 作業ブランチ、未commit変更、Node 24、Xcode、Safari、署名Team、実機の有無を確認する。無関係な変更を混ぜない。
2. macOS Safariの最小extensionを作り、サイト許可→選択ボタン→extension iframeまたは専用タブ→runtime messageを実証する。
3. iOS targetも同じ資産でbuildして選択UI、保管領域、background復帰、API通信を確認する。利用可能な最小OS/Safariバージョンを記録して対応表を確定する。
4. ゲート: パネル隔離・通信・トークン保管の成立を確認してから本実装へ進む。Apple APIの対応不明点を推測で埋めない。

### Phase 1: 接続認証

新設 `backend/src/extension-auth.ts`, `routes/extension-auth.ts`、Web承認ページ、接続管理、background認証を実装。`index.ts` とprincipal解決を更新。Firestore transaction・TTL読取判定・rate limit・method/path scope・CSRFをテスト。既存Web/mobileの認証回帰を通す。

### Phase 2: 既存処理を共有可能にする

transport interfaceとextension entryを追加。単語／文法キュー、import session、i18nの依存を整理。大規模なディレクトリ移動や全frontend再設計は避ける。通常Web/iOS buildと既存テストが通ることをゲートにする。

### Phase 3: 選択からdurable分析まで

選択スナップショット、UI、ingestionId、sourceOrigin enum、job起動、polling、再表示を実装。入力上限／接続切れ／background停止／再送を検証。分析と外部ソースの保存が1回の操作に対して重複しないことを確認する。

### Phase 4: 意味単位・単語・文法・登録

詳細解説を遅延生成し、既存意味単位UIと候補カードを接続。A/B登録先とqueue、回復、Web版で同じsessionを開く導線を実装。意味単位を跨ぐ構文や同じ単語の複数出現を検証する。

### Phase 5: 配布準備と実機受入

macOS/iOS targetを署名・インストールし、Safari設定での有効化から確認。手順・制限・未確認点をdocsへ記録。Cloud Runとローカルextensionのバージョン互換性を確認する。サーバー未対応の場合は「サーバー更新が必要」と表示し、400を無限retryしない。

## 9. テスト計画

| 層 | 必須ケース |
| --- | --- |
| 選択ユニット | 空白、改行、繁簡、絵文字、複数行、8,000境界、入力欄、解除、再選択、scroll/zoom、分析ボタンで選択が消える場合 |
| message境界 | 不正sender、frame取り違え、古いcontext、任意URL/method、過大body、親ページの偽message、token非露出 |
| 認証 | 未承認、期限切れ、PKCE不一致、二重exchange、同時claim、allowlist解除、CSRF、scope外API拒否、設定read失敗、logout/revoke、既存mobile/Webログイン |
| API/永続性 | 同一ingestion replay、異なるbodyで409、削除後410、再起動、停止/再開、429 backoff、401中断、旧sourceOrigin互換、HTTPS出典制約 |
| 読解UI | compactから詳細への移行、meaningUnits欠落、range不整合、同語複数出現、跨ぎ構文、詳細生成失敗、3言語、長文scroll |
| DB登録 | 新規/既存単語と文法、Aのみ/B追加、A/B連打、二重候補、group書込途中失敗、パネル破棄後再開、別タブでの変更、shared example整合性 |
| 実機Safari | macOS/iPhone/iPadのサイト許可、有効/無効切替、標準選択メニュー、CSP制約、Private Browsing設定、ページ遷移、回転、バックグラウンドから復帰 |

実装後の標準確認（存在するnpm scripts）:

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:import --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
git diff --check
```

さらに `npm run test:import:emulator --prefix backend` を既存READMEに従って隔離emulatorで実施。auth変更にはmobile authの既存テストを含める。ブラウザ回帰は `npm run test:browser --prefix frontend` を既存Playwright設定の起動条件に従って実行する。拡張packageには新規 `typecheck/test/build` scriptsを用意し、確定したXcode schemeで `xcodebuild` を行う。上記に未作成script名を混ぜて実行しない。

`./local.sh` のemulator/Docker smokeを行う。初回seed downloadは本番readを伴うので、単体・統合テストは可能な限りfixture/mockを用いる。LLM fixtureによるUIテストと実LLMによる少量の品質確認を分ける。mixed quiz関連の処理を変更した場合は `npm run test:mixed --prefix backend` も必須。

Playwright WebKitはSafari拡張の署名・permission・iOS実動作の代用にはならない。実機での未検証をbuild成功で置き換えない。

## 10. 受入チェックリスト

- [ ] サイト許可後、中国語の選択付近に分析ボタンが出る。選択だけでは送信されない。
- [ ] 押下した選択範囲のみ解析し、同じページのパネルで結果を読める。非対応埋め込みでは専用タブへ引き継げる。
- [ ] 各文の意味単位・意味・役割・単語・文法が表示され、原文の対応箇所が正しい。
- [ ] 未登録／既存の単語・文法を正しいA/Bグループへ登録でき、Web版の一覧にも反映される。
- [ ] 長文超過、未ログイン、権限不足、通信断、再接続、二重押下で入力喪失や無言の重複登録を起こさない。
- [ ] ページ／background終了後も保存済み分析を再表示でき、未完了登録を確認・回復できる。
- [ ] 閲覧ページへtokenが渡らず、拡張から任意の管理APIを呼べない。
- [ ] macOSとiOSのbuild/インストール手順が再現可能で、実機確認した環境と未確認環境が明記されている。
- [ ] 通常Web/iOS取り込み・登録・認証の回帰が通る。

## 11. デプロイと引き継ぎ時の報告

実装担当はAGENTS.mdに従い、現在branchと差分を確認し、意図した変更をcommit、`git push origin master`、`./deploy.sh` を実施する。master以外なら勝手に切り替えず使用branchを確認する。本計画のためにデータ移行や既存セッションの一括再解析を行う必要はない。認証token/requestの新規collectionは実装時に作成し、不要データのcleanup方針も追加する。

既存runtime詳細解説schemaとプロンプトを再利用するため、原則 `--prompts` / `--auth` / `--llm` は不要。実際に設定変更が必要になった場合だけ理由を説明し、通常deployと区別する。`deploy.sh` はSafari拡張を端末にインストールしない。Xcodeでの署名・インストール、有効化、サイト許可を別の成果として報告する。

完了報告にはcommit/push/Cloud Run結果、extension build/端末インストール結果、実機OS/Safari、実行したテスト、未検証点を分けて記載する。Apple署名や実機がない場合は、その作業が保留であることを明示し、クラウドdeployだけで全機能完成としない。

## 12. Safari関連の一次資料

2026-10-29確認。対応OS/APIはPhase 0で使用Xcodeと実機に対して再確認する。

- [Apple: Safari web extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions): Safari Web ExtensionはAppleプラットフォームのapp extensionとしてパッケージ化する。Xcodeでの試験・配布とWeb部分の実装を分けて考える。
- [Apple: Managing Safari web extension permissions](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions): サイトへのアクセスはmanifest設定だけでなくユーザー許可が必要。自動選択UIの利用条件として説明する。
- [MDN: Content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts): content scriptはページ操作、backgroundは拡張API処理を担当しmessageで連携する。MV3のcontent script通信とextension page通信は同じ権限条件ではない。Safari固有挙動は実機検証する。
