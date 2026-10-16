# 外部ソース解析：費用を抑えた一括／複数文処理と永続ジョブ化

作成日: 2026-10-16（日本時間）
状態: **実装・ローカル検証完了（2026-10-17）。本番確認の結果は実装作業の最終報告を参照。**
基準コード: `master` / `2cfe7d3`。実装開始時に最新の AGENTS.md とコードを再確認する。

## 1. 依頼・範囲・判断

当初の依頼は「文ごとのLLM呼び出しによる費用について意見を示し、それ以外の接続中断対策を具体的に計画する」こと。その後の実装依頼により、本計画の実装と必要インフラの構築を実施。モデル割当は維持する。

**推奨:** 文は意味・表示・保存結果の単位として保持する。一回のLLM呼び出しには、短いソースなら全文、長いソースなら複数の完全な文をまとめて渡す。一文一呼び出しを必須にしない。全文を含む一括解析も許容するが、最大8,000文字の全ケースで一括処理を強制しない。

**優先:** ブラウザーが長時間の解析応答を待つ方式をやめ、受付・処理・進捗確認を分離する。同じ処理を再開操作で再発行しない。処理単位のサイズはこの仕組みと独立させる。

「短い」の数値は未確定。新たな300文字のような根拠の薄い固定上限を決めない。後述の費用・出力量・成功率の計測で決定する。ジョブ化と重複実行対策は、この判断を待たず実装可能にする。LLMモデル、プロンプトの学習方針、Group A/Bへの追加ロジックは維持する。

本計画は [既存の全文・文脈解析計画](external-source-full-text-contextual-analysis.md) の追加計画である。旧計画末尾の300文字分割・同期 `analyze-next` は現在の実装記録。本計画の完成後は初回解析の起動・再開方式を置き換える。詳細な文解説の品質改善や辞書の一括書き換えは対象外。

## 2. 調査済み事実と未確定事項

2026-10-16の本番確認（日本時間）:

| 項目 | 事実 |
| --- | --- |
| 対象ソース | 318文字。現行分割は226文字と92文字 |
| 解析要求1 | 23:03:30開始、約97秒後にバックエンド・フロントエンド中継ともHTTP 200 |
| 解析要求2 | 23:04:10開始、約116秒後に両方HTTP 200 |
| 途中の状態確認 | 23:04:06、23:04:41。要求1の保存完了より前 |
| 保存状態 | `nextChunk=1` / 全2部分、23:05:07更新、候補111件、保存JSON約41KB |
| 重複 | 同じ未完了部分のLLM処理が重なった。結果の追加はトランザクションで一度だけ |

ブラウザーに表示された `The connection was interrupted...` は、`ImportView` が `TypeError` を通信中断として表示した文言であり、切断箇所を確定する情報ではない。今回のサーバーログには対応するタイムアウト失敗がない。端末、回線、ブラウザー等のどこで応答受信が失敗したかは未確定。ブラウザー側の診断ログを追加して切り分ける。

現行の問題:

1. コンパクト化してもLLM応答を約1～2分待つHTTP要求が残る。
2. 通信失敗直後に保存状態を一度読むだけなので、その後の成功に追従しない。
3. 保存時の重複防止はあるが、LLM呼び出し前の排他制御がない。
4. 部分サイズを縮めても、共通プロンプトの反復・失敗再試行で費用が増え得る。
5. `splitImportSource` は300文字超の一文を途中分割する。タイムアウト時の再分割も同様。

## 3. 費用と一括処理についての判断材料

### 3.1 費用の考え方

費用は呼び出し回数だけでは決まらない。モデル別の入力・キャッシュ入力・出力等の単価と使用量を使う。再試行、モデルの推論、実際の出力長も含めて測る。現在の設定モデルを変えず比較する。

キャッシュ・推論・再試行を除く説明用の式:

```text
P = 共通指示・スキーマ・スタイル例の入力トークン
T = ソース本文の総入力トークン
O = 全体の解析結果の出力トークン
K = LLM呼び出し回数
C = 分割によって重複して渡す文脈の入力トークン

一括の入力 ≈ P + T
K分割の入力 ≈ K × P + T + C
出力は同じ解析内容なら概ねOだが、実際は分割方法で変わる
```

したがって、一文ずつの呼び出しは共通入力の反復が増える。一括はそれを抑え、全文の文脈も保ちやすい。一方、一括の途中失敗では全体を再生成し、出力上限・処理期限・保存サイズ制限にも当たりやすい。**成功した一回の費用と、失敗・復旧を含む記事完成までの費用を分けて比較する。**

Prompt Cachingは条件を満たした入力の費用を抑え得るが、キャッシュ命中やモデル・API互換性を保証しない。出力の再利用機構でもない。共通指示を安定させ、`cachedTokens` を計測する。キャッシュ狙いで不要な説明を水増ししない。現在の SDK・Chat Completions・選択モデルで使える仕様を実装時に確認する。

### 3.2 分割方針の位置づけ

- 短いソースは一括を第一候補とする。今回の318文字も評価対象に入れる。
- 長いソースは完全な文を複数まとめる。文ごとのLLM呼び出しを標準にしない。
- 文字数のみで決めず、実測出力トークン/ソース量、処理時間、最大出力、JSONサイズから余裕を持った条件を決める。
- 一文だけで目安を超えても途中で切らない。完全な一文として扱い、収まらない場合は説明のコンパクト化または上限エラーを表示する。自動で文中分割しない。
- 一括失敗時の複数文への再計画は文境界のみ。進行中・保存済みのバッチを再分割しない。計画versionを更新し、旧実行者を失効させる。
- 待ち時間が長いという理由だけでサイズを縮めない。ブラウザーの通信切断はジョブの失敗ではない。
- 分割条件の採否はこの計画への追加記録として残す。初期リリースで未確定なら、現行サイズ方針を互換アダプターへ隔離してジョブ化を先に検証する。300文字を新方式の恒久仕様と記載しない。

## 4. 実装前に読む資料・変更候補

既存資料:

- [AGENTS.md](../AGENTS.md)、[README](../README.md)
- [開発リファレンス](../docs/development-reference.md)、[Cloud Runコスト制御](../docs/cloud-run-cost-controls.md)
- [全文・文脈解析計画](external-source-full-text-contextual-analysis.md)

主な既存ファイル:

| ファイル | 関連箇所 |
| --- | --- |
| `backend/src/routes/import.ts` | セッション作成、同期解析、説明生成、編集保存、削除 |
| `backend/src/import-parts.ts` | 分割・追加保存・再分割 |
| `backend/src/import-analysis.ts` | 正規化、原文整合性、出現と文法範囲 |
| `backend/src/import-analysis-config.ts` | コンパクトスキーマ・指示 |
| `backend/src/firestore.ts` | セッション取得・保存・トランザクション、usage集計 |
| `backend/src/llm.ts` / `llm-budget.ts` | SDK、モデル解決、使用量、期限と切断時中断 |
| `backend/src/index.ts` / `auth-config.ts` | ルート登録・Cookie認証 |
| `backend/src/types.ts` / `frontend/src/types.ts` | API互換型 |
| `frontend/src/components/ImportView.tsx` | 起動、通信エラー後の復旧、画面遷移 |
| `frontend/src/hooks/useImportSession.ts` | 保存排他、編集、登録キュー |
| `frontend/src/components/import/ImportReview.tsx` / `ImportSessionList.tsx` | 状態・操作表示 |
| `frontend/src/components/import/ImportFullTextReader.tsx` | 未解析本文・文解説 |
| `frontend/src/api/import.ts` / `client.ts` | 受付・状態取得・構造化エラー |
| `frontend/src/i18n/translations.ts` | 英・日・韓の文言 |
| `deploy.sh` / `deploy.ps1` / `docker-compose.yml` | worker、queue設定、ローカル実行 |

新設候補: `backend/src/import-jobs.ts`（純粋遷移）、`import-job-store.ts`（Firestore）、`import-task-dispatch.ts`（queueアダプター）、`routes/import-worker.ts`（内部worker）、`frontend/src/hooks/useImportAnalysisJob.ts`。肥大化した既存ファイルへ全処理を詰め込まない。ファイル名は実装開始時に最新構成へ合わせる。

## 5. 推奨構成

```text
ブラウザー → 受付API → Firestoreへjobと送信予定を同時保存 → 202
                                  ↓
                     Cloud Tasks → 認証済みworker
                                  ↓
                      LLM → 検証 → 結果保存・反映
                                  ↓
                       次バッチの送信予定を保存

ブラウザー → 短い状態取得GET → queued/running/completed/failed
Cloud Scheduler → 送信予定・期限切れjobの復旧処理（LLMを直接呼ばない）
```

Cloud Runは現在リクエストベースのCPU割当である。APIが202を返した後に `void analyze()`、`setTimeout()`、プロセス内配列だけで継続する設計にしない。workerはCloud Tasksから来るHTTP要求の中で処理完了まで待つ。ブラウザーを閉じてもworkerの要求は維持される。

推奨はCloud Tasks + Firestore。現行Chat Completionsとモデル選択を保てる。OpenAI Responsesのbackground modeは代案として存在するが、API移行・モデル対応・保存期間等の検証が増えるので今回の必須依存にしない。OpenAI Batch APIの採用やモデル変更も別の判断とする。

## 6. 永続データと整合性

### 6.1 保存場所（新規提案）

`import_analysis_jobs/{jobId}`:

```ts
type ImportAnalysisJob = {
  version: 2;
  sessionId: string;
  language: string;
  sourceHash: string; // 保存された原文のhash。正規化して原文を変更しない
  generation: number; // 旧実行者を無効化する世代
  planVersion: number;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  nextBatch: number;
  totalBatches: number;
  completedSentences: number;
  revision: number; // 進捗表示用。編集保存用revisionとは区別
  createdAt: string;
  updatedAt: string;
  error?: { code: string; retryable: boolean; occurredAt: string };
  // 解決したmodel、prompt/schema/style例のversion/hashを保存し、再試行で固定
};
```

- `batches/{batchId}`: 原文のstart/end、文範囲、状態、試行数、leaseToken/期限、結果参照、反映済みrevision。
- `attempts/{attemptId}`: 開始・終了・所要時間、model、usage、usage不明フラグ、エラー種別。結果の適用とLLM試行を区別する。
- `dispatches/{dispatchId}`: queueへ送る予定。job作成・バッチ完了と同じFirestoreトランザクション内で作成する。
- `results/{batchId}`: 検証済み結果。候補への反映前に永続化しておけば、反映失敗だけでLLMを再実行せずに済む。各docのサイズ上限を検証する。

原文・大きい解析結果・履歴をroot jobの一文書へ詰め込まない。結果の一時保存とセッションの既存900,000 byte予算は別々に守る。8,000文字でも候補が多ければ現行セッションのサイズ制限に当たる点は残る。上限時は `IMPORT_STORAGE_LIMIT` と未処理範囲を返す。上限を上げるだけの対処や、既存itemを削って保存する対処はしない。

`ImportSession`にはoptionalな `analysisJobRef: { version: 2; jobId; generation }` と `analysisRevision` を追加する。全文・items・登録記録は引き続きセッションが正本。旧 `analysisProgress` のversion 1を新しい形に見せかけない。追加フィールドは明示的なread mappingとsummaryにも必要な範囲で反映する。

### 6.2 状態遷移

1. 新規作成: `queued`。jobと最初のdispatch予定を永続化した時点で受付成功。
2. workerがlease取得: `running`。LLM呼び出し前に試行記録を作る。
3. 成功: 検証済み結果を保存し、候補・paragraphs・チェックポイントを一度だけ反映。続きがあれば次dispatch予定、なければ `completed`。
4. 一時障害: 限定回数だけbackoffして再試行。上限なら `failed` として止める。
5. pause要求: 実行中の一回は結果を保存し、次バッチを開始せず `paused`。一括処理なら一回の結果は保存される。
6. 再開: `paused` またはretryableな `failed` の未完了部分を `queued` にする。`running` に対する再開は現在のjobを返すだけ。
7. 削除: 同じtransactionでjobを `cancelled` にし世代を無効化。遅いworkerの結果でセッションを復活させない。

### 6.3 排他・重複・クラッシュ

- 記事ごとのactive jobを一つに制限。受付のidempotency keyを保存し、同じ受付の再送は同じjobへ収束させる。別ブラウザーの別keyでも既存active jobを返す。
- `jobId + generation + planVersion + batchId + dispatchSequence` から安定したtask名を作る。同じdispatch送信の再試行で新task名を作らない。
- Cloud Tasksの名前による重複防止だけに依存しない。重複配信を想定し、Firestoreでlease取得後だけLLMを開始する。
- lease期限はworkerの最大LLM期限と保存余裕より長く設定する。heartbeatとfencing tokenを使う。期限切れでも前試行の処理上限＋猶予が経つまで新しいLLM呼び出しを始めない。
- 有効leaseの重複配信は、重複workerから503で再配信を促す。完了済みなら200で終了する。無条件に200にして唯一の復旧要求を消さない。
- 古いleaseToken、世代、sourceHash、バッチ計画の結果は適用不可。最新セッションを読み、既存編集・items・登録・destinationsを保って新規解析部分だけ追加する。
- 結果保存後のクラッシュは保存結果から反映を再開する。原子的な反映receiptで二重追加を防ぐ。トランザクションの中ではLLM・queue呼び出しをしない。
- queue送信前後のクラッシュはdispatch予定から復旧する。Cloud Schedulerが未送信予定、lease期限切れ、長時間queuedを少量ずつ再照合する。GETの副作用だけに頼らない。
- 外部LLMが応答した直後、結果保存前にプロセスが落ちる場合など、追加課金を完全にゼロにする保証はできない。結果反映の冪等性と、LLM費用のexactly-onceを混同しない。
- 自動LLM試行は一バッチ最大3回を初期案とする。SDKの隠れた再試行はworkerでは無効化して二重のretryループを避ける。通常の他機能のSDK設定は変えない。
- 一時的なqueue再配信と課金を伴うLLM試行を別カウンターで管理。永続的な入力・認証・保存上限・出力検証エラーを無限に再試行しない。

## 7. API契約（新規提案）

既存のCookie認証を使う公開API:

| API | 契約 |
| --- | --- |
| `POST /api/import/:language/sessions/:sessionId/analysis-job` | idempotencyKey必須。最新保存状態を確認し、job受付。202でjob summary。activeなら同じjob。全文の解析結果を待たない |
| `GET /api/import/:language/sessions/:sessionId/analysis-job` | 状態・進捗・revision・構造化エラーのみ。本文・全itemsを毎回返さない。`Cache-Control: no-store` |
| `POST .../analysis-job/resume` | paused/failedから再開。running/queuedなら新LLMを開始しない |
| `POST .../analysis-job/pause` | 次の呼び出しを止める意図を保存。画面離脱とは別操作 |
| 既存 `GET .../sessions/:sessionId` | job進捗revisionが進んだときや再接続時に本文・候補の正本を取得 |
| 既存 `PUT .../sessions/:sessionId` | job参照の改変禁止。解析revisionの古い全体上書きは409で拒否。登録操作も同じ保護対象 |

job作成の受付応答が失われても、keyを変えず再送またはGETし、重複jobを作らない。受付時には言語、存在、本文サイズ、編集保存revisionをチェックする。作成/再開要求はLLMを呼ばず短時間で返る。queueが一時的に使えなくてもdispatch予定が保存できたなら202 + queuedとし、送信障害を状態に表示する。job/dispatch自体が保存できなければ503を返す。

worker専用API案:

- `POST /internal/import-analysis/run`（payloadはjobId、世代、batchId、dispatch IDのみ）
- `POST /internal/import-analysis/reconcile`（Scheduler用、少量の復旧処理のみ）

内部APIはOIDC署名、issuer、audience、有効期限、許可service accountのemail等を検証してから実行する。`X-CloudTasks-*` ヘッダーだけで認証しない。現在のバックエンドはCloud Run自体が公開なので、`roles/run.invoker` の付与だけでは内部routeを保護できない。Cookie認証の例外はこの二つのパスとmethodだけにし、専用認証が必須。`/internal/` 全体を無認証にしない。認証設定が不足すればworker機能をfail closedにする。

## 8. 期限・実行インフラ・費用制御

初期設定案（実装時に最新の仕様と実測で確認）:

- workerのLLM総期限540秒、Cloud Tasks dispatch deadline600秒、Cloud Run timeout660秒。保存と終了応答に余裕を残す。
- `installLLMBudgets` の内部workerにだけ総期限を設定する。現在の全route180秒でworkerが先に打ち切られないよう、厳密なroute判定と試験を追加する。通常APIの180秒は維持。
- worker用SDKは総期限に整合したattempt timeoutと `maxRetries: 0`。現在の120秒設定をそのまま継承して540秒を使えると誤解しない。
- 同じ import feature assignment を使い、job開始時に解決modelを固定。途中でモデルやプロンプト設定が変わっても同一job内の試行条件を変えない。snapshotのサイズも検証。
- `callLLM` は現在stringだけを返し、内部でmodelを解決する。worker用のserver-ownedな解決済みmodel/timeout/retry設定と、awaitできるusage receiptを渡せるadapterを追加する。クライアントから任意model名を受け付けない。fallbackが実際に使われた場合はそのmodelをattemptへ記録し、費用を元modelへ誤計上しない。
- 現在の `recordUsage` は非同期呼び出しで待たれていない。workerではusageの保存完了を待ち、attempt IDでreceiptを冪等化して既存集計へ一度だけ反映する。既存の自動集計とworker独自集計で二重計上しない。他機能の集計形式は壊さない。
- 同時workerはqueue単位でまず1、LLM試行も記事ごと1。Cloud Runのconcurrency80を変える必要はない。グローバル排他を必要とするなら別queue・直呼びの経路がないことも確認する。
- 自動試行最大3回、queue backoffとlease衝突時の再配信を区別。retry設定だけを頼らずFirestoreで課金試行の上限を強制する。
- worker serviceは既存backendへの認証済み内部routeを第一案とする。別private Cloud Run service化は運用・認証・費用比較後の別案。
- Schedulerの間隔はまず1分。対象queryとpage上限を固定し、必要indexを管理する。polling、Scheduler、Firestore、Cloud Tasksにも費用があるためLLM費用と別に記録する。
- frontendとバックエンドの既存min/max instances・request-based billingは維持。常駐workerや常時CPUを前提にしない。

環境設定案: queueのproject/location/name、worker URL、OIDC audience、invoker SA、worker機能flag。秘密鍵JSONを配布せずCloud Runのサービスアカウントを利用する。既存 `.env` のconfig uploadと混同しない。productionでqueue未設定時に黙ってプロセス内処理へfallbackしない。

## 9. 編集・Group A/B・画面の動作

### 9.1 編集と登録の保護

- 初期実装では `queued/running` 中は登録・解析済み候補の編集を止め、閲覧を許可する。既存の解析中画面と同じ性質にする。
- 編集したい場合はpauseを要求し、実行中バッチの保存が終わって `paused` になってから編集する。説明として「実行中の解析が終わると一時停止します」を表示。
- pause後の再開前に `prepareAnalysis` でdebounce保存・inflight保存をdrain。登録キュー処理中、未保存エラー時は再開しない。
- polling結果でローカルのdirty editsや登録結果を丸ごと上書きしない。競合409時はローカル編集を保持し、再読み込み/再適用できるようにする。自動再試行で全体PUTを繰り返さない。
- `analysisRevision` は解析内容追加と、編集保存に影響するphase切り替え（再開/移行等）で更新する。公開PUTは最新phaseも見てactive中の編集を拒否。workerは最新保存文書へ追加し、A/Bの追加・キュー・所属・smart-add・再利用判定を変更しない。
- 詳細文解説はpaused/completed等で既存方式を使う。running中に説明生成を自動で並列起動させない。グループ変更や削除で文章を再解析しない。

### 9.2 フロントエンド

- `handleAnalyze` の長時間POST loopを、受付→job監視へ置換。
- 状態GETは通常3秒、長時間変化がなければ10秒へbackoff。visible/online復帰で即時照合。未完了GETを重ねず、古い応答はjobId/世代で破棄。
- 裏タブではpollingを抑え、画面を閉じたらpollingだけ中止する。workerをcancelしない。永続状態はlocalStorageに置かない。
- 通信失敗時は `reconnecting` という表示上の状態にする。永続jobの `failed` には変更しない。backoffして再照合し、再接続後にcompletedなら結果へ進む。
- 401は既存auth:expiredを使う。認証復帰後に同じjobを読む。404は削除済みとして扱い、通信失敗とは分ける。
- reviewへ移る前に最新session取得。job完了とsession反映は原子的にし、completedなのに候補がない状態を作らない。
- 一括実行中に実際には不明な完了率を表示しない。「解析中」「完了した文数」「処理済み部分」を事実に基づき表示。トークン到着量から百分率を推測しない。
- セッション一覧にもqueued/running/paused/failedを表示。再表示時に同じjobを監視する。
- ボタン: 「一覧に戻る」（処理は継続）、「次の処理から一時停止」、「続きを解析」、「失敗した部分を再試行」。running中は再試行を出さない。
- 英・日・韓の全翻訳を更新。画面にqueue、lease等の内部用語を出さない。

### 9.3 エラー分類・観測

`ApiError` にstatusに加えてoptionalなcode/retryable/requestIdを持たせる。他画面の既存messageを壊さない。構造化JSONを文字列比較して分岐しない。

| 分類 | 画面・再試行 |
| --- | --- |
| 通信中断/状態未取得 | 接続を再確認中。jobを再発行しない |
| queued/送信待ち | 受付済み。送信遅延を観測し復旧処理へ |
| LLM timeout/429/一時5xx | 有限の自動試行。その後は保存済み分を保持してfailed |
| 無効入力/モデル認証/設定不備 | 自動LLM試行を止め、管理上の原因を表示可能にする |
| 原文欠落/不正JSON/出力上限 | 失敗内容を分類。無限repair呼び出し禁止。文境界での再計画は別generation |
| 保存上限 | 既存結果保持。残りを別ソースへ取り込む案内 |
| stale revision | 編集保持。競合の解消が必要 |

ログはjobId、attemptId、requestId、phase、elapsed、HTTP status、usageが得られたかを記録する。原文・Cookie・認証ヘッダー・APIキーは出さない。frontend側はfetch/JSON decode/画面破棄によるabortを区別し、online/visibility/経過時間を記録できるようにする。TypeErrorというだけで「ネットワークが原因」と断定しない。診断送信はサイズ・頻度制限し、既存認証下のendpointへ送る。

## 10. 旧セッション・旧クライアントの移行

1. 完了済みの旧記事は再解析しない。items、読み、編集、登録、quiz poolを維持。
2. version 1の未完了記事は、ユーザーの再開時にlazy migration。保存済みprefixを厳密に確定し、未処理部分だけjobへ移す。
3. 保存済み境界が完全な文末なら、残りを新しい完全な文のbatch plannerへ渡せる。
4. 旧300文字処理が一文途中で保存済みなら、その保存済みfragmentは書き換えない。互換batchとして未処理tailを扱い、元の完全な文をcontextへ渡し、出力/追加は未処理範囲だけに限定する。これは旧データ限定の例外として記録。既存行を無断で全文再解析・置換しない。
5. 移行時に `analysisJobRef`、世代、revisionをtransactionで確定。以後旧 `analyze-next` はjob参照付き記事を409 + reload codeで拒否し、LLMを開始しない。
6. 既に走り始めた旧workerのcheckpointもtransactionでjob参照を確認し、移行後の追加を拒否する。旧revisionのinflight要求については、backend先行配信後に既存180秒期限＋猶予が経ってから移行flagを有効化し、同時LLM費用を避ける。
7. 旧全体PUTは新jobフィールドやrevisionを書き換えられない。job記事への旧client保存は409で拒否し、更新を案内。
8. 削除時はsubcollectionが自動削除されないことに注意。jobをまずcancel/tombstone化し、task無効化を確認後に限定件数のcleanupで結果・attempt・dispatchを削除する。保持期間を決め、本文重複を長期に残さない。
9. rollbackはqueueをpause→inflight停止確認→feature flagで受付停止。jobデータを読めない旧コードへ即座に戻さない。互換read/保存保護を含む中間revisionをrollback先にする。既存保存分は保持。

## 11. ステップ別作業リスト

### Phase A: 仕様・fixture・測定準備

- [ ] A1. 現行コード、型、auth hook、SDK version、モデル割当、usage集計を読み直す。
- [ ] A2. 今回の318文字、複数段落、300文字超の一文、英語の略語/小数/引用、日韓の句読点、最大8,000文字のfixtureを用意する。ユーザー原文は匿名化し、公開コミットへ無断で載せない。
- [ ] A3. 「表示/保存の文」「一回のLLM batch」「job/attempt」を別の型にする。batch plannerを差し替え可能な純粋関数にする。
- [ ] A4. 状態遷移と公開DTO、error code、idempotency契約を確定する。
- [ ] A5. LLM費用計測器を作り、モデル名・token使用量・cache・時間・出力byte・成功/欠落・試行回数を同時記録する。実LLM実行は明示的なコマンドに限定し、通常のtestではmockする。

### Phase B: 永続jobと保存保護

- [ ] B1. バックエンド/フロントエンドに互換型を追加。セッションsummaryに必要な状態のみ追加する。
- [ ] B2. job取得/作成、active job排他、resume/pause/cancel、lease、result、dispatchのFirestore関数を専用moduleへ実装する。
- [ ] B3. sourceHash・世代・lease token・反映receiptの検証を実装。外部呼び出しをtransaction外に置く。
- [ ] B4. `appendImportPart` の追加保存をjobにも再利用できる純粋helperへ整理。候補のID/文index/occurrence ID、段落連続性、既存登録の不変性を保持。
- [ ] B5. 原文整合性を検証し、期待する完全な文の単位へ結果を対応させる。batch内で文が融合/分割された場合の扱いを明示する。単なる空白正規化の全文一致だけで文対応を保証しない。
- [ ] B6. 最新revisionとphaseによるPUT保護、削除cancel、結果のサイズ制限を実装する。
- [ ] B7. 保存済みresultからの反映再開、未送信dispatchの再照合、cleanupの上限処理を実装する。

### Phase C: worker・queue・認証

- [ ] C1. `@google-cloud/tasks` 等の必要依存を追加しlockfileを更新。SDK/APIの最新対応を確認する。
- [ ] C2. stable task名、OIDC、deadline、queue設定を持つproduction adapterと、Firestore emulator用のlocal adapterを作る。
- [ ] C3. workerを実装。lease取得→試行記録→LLM→検証済みresult保存→反映→次dispatch予定→200の順を守る。
- [ ] C4. deadline、SDK retry override、fencing、heartbeatを実装。他routeのbudget/cancel挙動を変えない。
- [ ] C5. 正確な内部path/methodだけに専用OIDC認証を実装。全APIのCookie authを維持し、偽装header・wrong audience・wrong SAを拒否する。
- [ ] C6. queue再配信とLLM有料試行の回数を分離。terminal failureは永続化後200でackし、継続可能なインフラ失敗は非2xxで再配信させる。
- [ ] C7. outbox dispatcher/reconciler、期限切れlease、queue未送信・名前重複・ack喪失の復旧を完成させる。
- [ ] C8. `deploy.sh` と `deploy.ps1` に同じ設定・事前検証を追加。queue/SA/Schedulerの初期構築スクリプトは別途明示し、通常deployのたびに権限やqueue retry設定を無断変更しない。
- [ ] C9. ローカルは専用workerプロセスで永続予定を処理。production用認証を緩めず、エミュレーター設定の明示時だけlocal adapterを使う。Cloud Tasks本体の検証は別のクラウドsmokeが必要と記録。

### Phase D: 公開APIと画面

- [ ] D1. 受付/状態取得/resume/pause APIを実装し、idempotency・state DTO・認証・サイズ検証をmock route testで確認。
- [ ] D2. `useImportAnalysisJob` を作り、短いpolling、backoff、online/visible復帰、世代による古い応答無視をまとめる。
- [ ] D3. `ImportView` の同期loopを置換。受付の応答喪失から同じjobを再取得できるようにする。
- [ ] D4. 一覧・解析画面・reviewのjob状態、pause/resume、通信再確認中の表示を実装。
- [ ] D5. dirty edits/登録キューのdrain、active中の編集禁止、409復旧を実装。登録キュー本体は変えない。
- [ ] D6. completed時だけ最新sessionを採用。解析追加後の文選択・文解説の自動生成が余計なLLMを呼ばないことを確認する。
- [ ] D7. error codeと診断request IDを英・日・韓へ対応し、通信失敗だけでjob再発行しないことを試験。

### Phase E: 一括／複数文の費用評価（ジョブ化と独立）

- [ ] E1. 同一モデル・同一compact出力で全文一括、複数文batch、一文一callを比較する。短いソースから始め、実行回数・上限を決めて費用を抑える。長文全パターンを無制限に回さない。
- [ ] E2. 入出力・cached token、reasoning情報が得られる場合の内訳、成功一回と完成までの総量、時間、原文保持、文脈語義の品質を記録。
- [ ] E3. キャッシュ冷/温と試行失敗の差を区別。usageが失敗時に取れなければ「不明」とし、課金ゼロと記録しない。
- [ ] E4. 実測から一括優先条件とbatchの出力予算を決める。token推定方法とモデル対応も決める。短文318文字を機械的に分割しない候補を検証。
- [ ] E5. 完全な文を保つplannerを実装。引用末尾、英語略語・小数、段落、空白、絵文字、非連続構文、長い一文を検証。原文の範囲を保持し `parts.join('')===source` を保証する。
- [ ] E6. 一文が処理上限を超えた場合と、batchの出力打切り時の扱いを実装。自動の文中再分割を削除。失敗した未完了batchのみ文境界で再計画する。
- [ ] E7. 採用条件を本計画と開発リファレンスへ記録。モデル変更による再評価は明示的な別作業。

### Phase F: 移行・検証・配信

- [ ] F1. 旧未完了記事のlazy migrationと旧clientの拒否を実装。旧完了記事の変更がないことを確認。
- [ ] F2. 下記のユニット・route・エミュレーター・ブラウザー試験を通す。
- [ ] F3. README、開発リファレンス、Cloud Runコスト制御、既存計画の追記を現在形に合わせる。既存の検証記録は歴史として保持。
- [ ] F4. stage環境でOIDC、queue再配信、worker再起動、Scheduler復旧、実LLMの限定smokeを行う。
- [ ] F5. masterをcommit/push。queue等の前提構築後にbackend先行でjob機能を配信し、旧要求の期限＋猶予後に移行を有効化、frontendを切替。通常の既存config uploadはしない。
- [ ] F6. productionで受付が短く返ること、閉じた画面のjobが完了すること、再開でLLMが重複しないことを小さい専用記事で確認。実LLM試行数・不明usage・queue遅延を確認し、結果を記録。

## 12. 必須の検証ケース

### ユニット・API（クラウド/実LLMなし）

- 同時受付・同時再開が同じactive jobになり、同時workerのLLM呼び出しが一つになる。
- queued/running/completedの再送、task重複、ack喪失で二重追加されない。
- lease期限切れ、古い世代、削除後の成功応答、変更されたsourceHashを拒否。
- result保存直後/反映直後/次dispatch保存直後のクラッシュから再開し、保存結果があればLLMを再実行しない。
- queue送信失敗が202後でも復旧し、全てのブラウザーを閉じても取り残されない。
- retry予算・429/5xx/timeout・permanent failure・出力不正・保存上限が正しく分類される。
- worker540秒/通常180秒の適用をfake timeで検証。SDKの120秒とmaxRetriesがworkerだけoverrideされる。
- OIDCなし、Cookieだけ、偽CloudTasks header、wrong issuer/audience/email、期限切れを拒否。認証設定のread失敗で公開化しない。
- 古い全体PUT/旧analyze-nextが新jobを壊さない。Group A/B情報・既存編集・登録receipt・文解説を保持。
- paragraph連続性、文ごとの語義、繰り返し語のoccurrence、grammar fixedElementsの範囲がbatchをまたいで崩れない。

### ブラウザー・エミュレーター

- 受付202後に画面を閉じ、再表示すると同じjobの進捗/完了結果が出る。
- 解析中のブラウザー通信を約35秒で切り、workerは約100秒で完了させる。再接続後に成功へ追従し、LLMは一回。
- offline/online、裏タブ復帰、ログイン切れ、最終GETの失敗、受付応答だけの喪失、二窓再開を確認。
- pause中に編集し保存後resume。解析済み意味・登録状態が保持される。未保存エラーならresumeしない。
- queue dispatch前のプロセス停止、worker停止、reconciler再起動、lease失効をFirestore emulatorの実transactionで確認。
- 新規短文全文一括・長文複数文batch・旧partial記事・旧完了記事の表示を確認。

実装後の基本コマンド（repository root）:

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:import --prefix backend
npm run test:mixed --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
npm run test:browser --prefix frontend
bash -n deploy.sh
git diff --check
```

新規job route/emulator testが既存globに入ることを確認し、入らなければpackage scriptとこの一覧を更新する。PowerShellは利用可能な環境で実行し、未実施なら報告する。ドキュメント作成だけの今回の作業ではアプリケーションテスト・実LLM計測を実施しない。

## 13. 完成条件・制約

- ブラウザーの長時間接続を必要とせず、画面を閉じても受け付けた解析が完了または有限回の失敗状態に収束する。
- 接続断は表示上の再接続となり、同じ記事のLLM処理を増やさない。
- queued/runningのjobに再開を押しても同じjobを返す。
- 完了した部分・編集・登録結果・グループ所属が保持される。
- LLM試行と結果反映の回数を別々に確認でき、未知の課金を0と表示しない。
- 一括/複数文を切り替えてもjob API・UI・登録処理を変更する必要がない。
- 新しい分割方式を採用する場合、文を途中で切らず、共通入力の反復と失敗再試行の費用を比較した根拠が残る。
- 保存容量の抜本的な分散化、詳細文解説APIの全面ジョブ化、辞書再解析、料金上限の絶対保証は今回の完成条件に含めない。

## 14. 公式資料（2026-10-16確認）

- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing): モデル別の入力・キャッシュ・出力価格。今回、モデル変更や固定額の見積りはしない。
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching): 入力再利用条件と出力生成の区別。選択モデル/APIでの利用条件は実装時に再確認。
- [OpenAI Background mode](https://developers.openai.com/api/docs/guides/background): 非同期生成とpollingの代案。現行Chat Completionsへそのままフラグを追加する機能ではない。
- [Cloud Run: Executing asynchronous tasks](https://docs.cloud.google.com/run/docs/triggering/using-tasks): Cloud TasksによるHTTP worker実行とOIDC等の構成。
- [Cloud Tasks: Create HTTP target tasks](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks): task作成、deadline、認証設定。
- [Cloud Tasks: Issues and limitations](https://docs.cloud.google.com/tasks/docs/common-pitfalls): 重複実行を想定したhandler設計が必要。

ここに記載したqueue構成・期限・retry回数・データモデルは本アプリ向けの提案であり、公式資料が定めた必須値ではない。


## 15. 実装記録（2026-10-17）

この節が現在の実装。上の提案との差異は以下のとおり。

- `import_analysis_jobs/{sessionId}` の一つの現在レコードにchunks・snapshot・lease・dispatch sequence・`nextWakeAt`を保存し、このレコード自体をtransactional outboxとした。バッチごとの独立したdispatch文書は作らない。解析結果/試行/action keyはsubcollectionへ分離した。原文上限8,000文字の範囲でsnapshotも別途850,000 byteまで検証する。
- `analysisProgress` version 1は原文の分割と表示/保存チェックポイントとして残る。`analysisJobRef` version 2、`analysisRevision`、`analysisState`を追加し、処理方式と保存保護を区別した。新規入力は `analyzeAsJob`。旧部分解析は再開時にjobへ移し、既存chunksをそのまま保持する。
- 原文の完全な文をIntl.Segmenterで分け、複数文を600 UTF-16文字を目安にまとめる。一文が目安を超えればそのまま一バッチとし、文字位置で切らない。短文は全文一括。workerはsentenceTextsを渡し、原文全体だけでなく文単位の対応も検証する。旧clientのv1専用分割処理は互換目的で残したが、移行済み記事には使わせない。出力上限や有限試行後のtimeoutでは、明示的な再開時に未完了の複数文batchだけを文境界で小さく再計画する。保存済み範囲・一文の途中は分割しない。
- Cloud Tasks + 同じbackendのOIDC保護route + 毎分Schedulerを実装・構築した。queue concurrency 1、LLM 540秒/dispatch 600秒/Cloud Run 660秒。署名・audience・issuer・許可SA・email_verifiedを検証し、Cookieのみ/偽queue headerでは起動できない。ローカルHTTPの無認証workerは作らず、別のemulator専用プロセスが同じ関数を実行する。
- active jobへの同時再開は同じjobを返す。lease/fencing、有限retry、durable result、attempt単位のusage receipt、送信予定の再照合、期限切れleaseの復旧、削除tombstone、七日後のpayload cleanupを実装。既存のusage log/daily aggregateへ一度だけ反映。結果保存前の外部応答喪失による課金の再発は保証できない。
- 編集/登録はactive中に露出させず、pause後に再開できる。再開前に既存save/登録queueをdrain。旧PUTの新規解析への上書きをrevision+checkpoint+phaseで拒否。辞書へのA/B登録処理自体は変更していない。
- ブラウザーは短いGETを3秒からbackoffして監視し、通信断はreconnecting表示で再照合。画面離脱はpollingだけ停止。受付応答喪失も同じjobを読む。診断は原文・認証情報を含めず、client一分間隔、server一分20件/instanceまでに制限する。
- one-time setupとnormal deploy preflightを追加。通常deployはworker環境をupdate-env-varsで維持し、旧要求向けに210秒の移行drainを設定。コード/プロンプト互換移行だけで、辞書/記事のbulk rewriteはしない。

### 15.1 限定した実LLM測定

既存のimportモデル割当を変更せず、合成した中国語ソースで計測。測定結果はモデル・文体・出力の変動を含むサンプルであり、費用/処理時間の保証ではない。金額には換算していない。

| 入力と処理 | LLM回数 | 入力tokens | 出力tokens | 所要時間 | 原文保持 |
| --- | ---: | ---: | ---: | ---: | --- |
| 288文字・全文一括（測定1） | 1 | 1,731 | 7,440 | 112.9秒 | 成功 |
| 同じ288文字・全文一括（測定2） | 1 | 1,731 | 7,232 | 106.5秒 | 成功 |
| 同じ288文字・144文字ずつの複数文batch | 2 | 3,464 | 7,869 | 合計125.4秒 | 両方成功 |
| 576文字・永続jobで全文一括 | 1 | 1,899 | 14,405 | 約216秒（polling観測） | 24文・404候補を保存 |

一括より分割時の入力反復が大きいことと、576文字でも540秒期限内で完了することを確認したため、600文字を初期のまとめ方の目安に採用した。これはtoken推定器によるモデルごとの自動最適化ではなく、現在のモデルでの保守的な運用初期値。8,000文字や極端に長い一文での成功・価格は保証しない。モデル変更時は同じbenchmarkを再実行する。上限エラーで自動の文中分割を行わない。

全文二回でprovider報告cached inputは0/1,728、二分割は各1,545だった。キャッシュの有無で入力費用は変わるが、出力は毎回生成される。生のprovider usageにはcache_write_tokensも含まれ、benchmark/result receiptに残る。既存cost画面のモデル別価格設定は今回変更していないため、請求書との完全一致を主張しない。

576文字jobの受付は約49ms。処理中に同じ受付keyを再送しても同じjobとなり、完了後resumeでも再解析されなかった。ローカル専用記事は確認後削除し、辞書/Group A/Bへの登録は行っていない。smoke helperのDELETEで空JSON Content-Typeを送る不具合を修正した（アプリのDELETE経路は影響なし）。

### 15.2 再実行コマンド

```bash
# queue/SA/Schedulerを明示的に初期構築または更新
npx --prefix backend tsx backend/scripts/setup-import-jobs.ts vocab-trainer-490014 asia-northeast1
# normal deployの前提だけ確認
node backend/scripts/check-import-jobs.mjs vocab-trainer-490014 asia-northeast1
# mock LLM + 専用demo projectのemulator transaction試験
npm run test:import:emulator --prefix backend
# 実LLMを使う小さい専用記事でHTTP smoke（完了後に専用記事を削除）
npx --prefix backend tsx backend/scripts/smoke-import-jobs.ts http://localhost:5173
# 明示的に本番smoke: gcloudでサインイン中の許可ユーザーで専用記事だけ作成・削除
npx --prefix backend tsx backend/scripts/smoke-import-jobs.ts https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app --allow-production
# 実LLM benchmark: emulatorを明示し、最大呼び出し回数も指定（以下は最大5）
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIRESTORE_PROJECT=vocab-trainer-490014 FIRESTORE_DATABASE_ID=vocab-database npx --prefix backend tsx backend/scripts/benchmark-import-analysis.ts /tmp/source.txt /tmp/report.json 300 5
```

PowerShellでは環境変数を `$env:NAME=...` で設定する。実LLMコマンドは通常testに含めない。追加のクラウドリソースの費用はLLM費用とは別。Cloud Tasks/Schedulerの実接続は本番の専用記事で確認し、結果は実装作業の最終報告に記載する。


### 15.3 ローカル検証結果

- backend build、unit87件、既存import route6件、mixed route4件が成功。
- ジョブのemulator integration7件が成功（mock LLM、専用demo project）。同時実行、pause/編集再開、stale PUT、旧API拒否、保存結果復旧、有限retry、worker認証、失効leaseとpause、削除cleanup、文境界の明示的再計画を確認。
- frontend type-check、unit94件、build、Playwright24件が成功。通信断からの追従、受付応答喪失、画面離脱後の完了、編集drain、既存A/B追加復旧・全文読解も確認。
- Docker/Firestore emulator + 実LLMの576文字HTTP smokeで受付・保存・重複受付・完了後resumeを確認。
- Bash syntax、normal deploy preflight、差分/リンク検証が成功。
- PowerShell実行はpwsh未導入のため未実施。独立したstaging projectは作らず、local/mock検証と本番の小さい専用記事による限定smokeで確認する。

上のPhase A～Fチェックリストは当初の詳細設計記録として残す。実装の採否・差異・測定結果・実施した確認の正本は本節。料金の自動最適化、全モデル/全言語の実LLM benchmark、任意のサイズでの成功保証は実装済みと主張しない。
