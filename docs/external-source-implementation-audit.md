# 外部ソース機能の実装・検証記録

整理日: 2026-10-17（日本時間）

ルート `plan/` にあった全文・文脈解析と永続ジョブ化の2計画は、実装・配信済みのコードと照合して完了を確認し、削除した。設計時のチェックリストではなく、保守に必要な実装差分・測定結果・検証履歴をこの文書に残す。現在の仕様は [README](../README.md#source-reader-and-contextual-explanations) と [開発リファレンス](development-reference.md) を参照。

## 計画整理時の追加確認

- 初期表示、出現別の読み/意味、構文・要素説明、文脈付きsmart-add、既存A/B登録は実装済み。関連の単体・API・ブラウザー回帰で確認。
- 一括/複数文batch、永続job、排他・冪等性、通信再接続、pause/resume、旧記事のlazy migration、OIDC、queue/Schedulerは実装済み。旧計画の300文字同期処理は後続の永続jobに置き換わった。
- 元の計画に未チェックで残っていた8,000文字付近の確認を追加した。mock LLM + 実Firestore emulatorで14バッチ・422文を処理し、原文8,000文字の保持と162,938 byteの保存を確認。処理は当環境で約1.6秒（mockによる測定であり、実LLMの速度ではない）。
- 密な8,000文字ソースの追加結果が保存上限を超える場合、既に保存したparagraphs/items/グループ情報と未処理原文を保持し、非retryableな保存上限エラーになることを確認。
- 360px幅で8,000文字の部分解析記事を開き、全文と文章別の切替・未処理原文の表示・横はみ出しなしを確認。表示/切替だけで追加のLLM要求は発生しない。初期表示と切替は当環境のmock APIで約0.45秒。
- 既存の実LLM測定と本番配信は下記の履歴およびGit履歴に残る。整理作業で大きな実LLM解析・辞書変更・設定の再アップロードは行わない。
- PowerShellの実行確認はpwsh未導入のため未実施。全モデル/全言語の料金最適化や任意サイズの成功保証は元計画でも完成条件から除外されている。

## 整理時の回帰結果

2026-10-17にbackend build、unit87件、import/dispatch8件、mixed4件、emulator9件、frontend型チェック・unit94件・build、Playwright25件が成功。変更したドキュメントのリンク、削除した計画への参照が残らないこと、`git diff --check`も確認した。追加試験はmock LLMを使い、本番データや実LLMの課金を伴わない。

## 既存の本番配信確認

- 全文・文脈解析: `f557b48`。初回のタイムアウト対策: `2cfe7d3`。
- 永続job: `0928e9f`、キュー送信期限と旧同期API保護: `748920b`。いずれもmasterにpush・配信済み。
- 2026-10-17の本番専用9文字記事は約1.8秒で受付、約12秒後に1文・7候補の解析/保存が完了。重複受付と完了後resumeでも有料LLM試行は1回、usage記録を確認。専用記事は削除し、辞書やA/B所属への登録は行っていない。
- Cloud Tasks workerとSchedulerの復旧routeは本番でHTTP 200を確認。frontendが配信したビルドも確認済み。

以下は当時の実装記録であり、記載された途中段階の上限・方式・件数を現在の仕様と混同しない。

## 7. 実装記録（2026-10-16）

### 実装済み

- 全文を初期表示に変更。文章別との切替、選択した文の編集、モード別のスクロール位置保持に対応。
- 本文の出現ごとに位置・読み・文脈義を保持。文背景/↗で文解説、語で意味・役割・根拠・対比、構文名で関連範囲の強調と要素別解説を表示。
- 文法の固定要素だけ独立候補を省略。内容語スロットは保持し、gap補完で固定語が復活しない。非連続構文・同表記の別用法もテスト。
- 新形式には同表記先頭からの読み/意味補完を適用しない。原文surface、UTF-16範囲、出現ordinal、Latin境界と大文字小文字、記事内の原文順序を検証。
- 文単位の解説APIを追加。旧記事は保存済み意味で表示し、明示操作で解説のみ生成。キャンセル・二重送信抑止・古い応答の破棄・保存失敗と再試行に対応。
- smart-addへoptionalなsourceContextを伝達。入力語義の明示indexで他言語訳を対応させ、別義には根拠と比較例を要求。同義の言い換えを無条件追加しない。生成内容の説明言語を維持。
- A/B登録先、作成/再利用、キューの順序、per-destination状態、409/応答喪失復旧、記事クイズpoolは維持。既存Wordへの所属追加で定義を書き換えない。

### 計画から具体化した点・制約

- 説明言語は現行のimportプロンプトに合わせ日本語（`ja`）。UI自体は英語・日本語・韓国語に対応。ユーザーが意味/説明を編集した際は選択中の説明言語を記録する。
- LLMは各wordにsurfaceと出現ordinalを返す。サーバーがoccurrence IDと範囲を採番し、grammarのwordIndicesをそのIDへ結びつける。編集候補側のoccurrenceId/constructionIdで関連を辿るため、別のwordItemIdコピーは持たない。
- 1,200文字を超える記事は、詳細構文を除いたcompact schemaをコード側で生成。初回は文脈義と読みを取得し、詳しい構文は文単位で生成する。旧configも受理する。
- Firestoreセッションは単一documentの現行モデルを維持。解析JSONは850,000 bytes、保存時JSONは900,000 bytes、文単位解説は150,000 bytesを上限とする。密な約8,000文字fixtureは候補だけでも約1.82MBとなり保存上限を超えるため、分割案内が必要。文単位遅延生成でも候補本体のサイズは減らない。大記事の実LLM全体実行は行わず、合成データとAPIのサイズ拒否で検証した。サブコレクションへの記事分割保存は別途の設計対象。
- 原文変更・不正範囲・不完全JSONは保存せず、失敗を明示する。既存セッション/辞書の一括migrationは実施していない。

### 検証結果

- backend build / unit tests、`test:import`（3件）、`test:mixed`（4件）成功。
- frontend TypeScript / unit tests / Vite build成功。Viteの既存のchunkサイズ警告のみ。
- importerのPlaywrightテスト11件成功：全文初期表示、反復語、構文、旧記事保存、360px、フォーカス、エラー再試行、遅延応答破棄、保存失敗、既存A/B登録復旧。
- `./local.sh` と `docker compose up --build -d` でDocker＋Firestore emulatorの実スタックを確認。実LLMの6文解析、文解説生成、候補作成、保存・再読込、PC/スマートフォンでの画面確認に成功。
- 実LLMで、为 wèi/wéi、还 hái/huán、要の意図/近い将来、该の指示/助動詞を区別。保存セッションは約31.6KB、候補26件。文単位生成＋保存往復のsmokeは約25.8秒。
- 実LLMの新規「核验」は元文「工作人员正在核验申请材料。」に対応する1語義となり、英日韓の定義が揃った。ローカルに作成した確認用Wordは削除した。これらは本番辞書の検証・更新ではない。
- LLMの評価は小規模な中国語例に限定。日韓英の活用/位置と互換性はfixtureで確認したが、多様な長文での意味品質を網羅的に保証するものではない。実LLMの金額計算は実施していない。

### 配信手順

`git push origin master` と `./deploy.sh --prompts` を実行する。今回変更したDBファイルはimport/vocabularyのみで、他のprompt設定ファイルには差分がない。コードは旧config/旧記事を受理するが、新しい解説の生成には新schema/promptが必要。rollback時は対応するimport/vocabulary設定も戻す。配信の実際の成功/失敗はコマンド完了後の最終報告で確認する。

## 8. 読み込みタイムアウトへの対応（2026-10-16）

本番の08:19〜08:29（日本時間）に初回解析が600秒で終了し、ストリーム終端後の通信切断で原因がLoad failedに上書きされる経路を確認したため、初回解析を再設計した。

- 初回は文字数によらずcompact schema。新しい分割解析記事では文を初めて選択した際に詳しい解説を生成して保存する。語の選択・モード切替では呼ばず、旧記事は従来の明示ボタンを維持する。自動生成の失敗は表示し、明示操作で再試行する。
- 元記事を最大300文字の区間に分割し、区間ごとに解析・Firestore transactionで保存。長い文は句読点等を優先して区切り、原文・段落・サロゲートペアを保持する。
- `analysisProgress`を保存し、未完了記事の「続きから解析」で残りだけ処理。時間切れの区間はさらに分割して次の再試行に備える。
- 完了済み区間への再送・同時完了でも候補が増殖しない。既存候補、編集、登録状態、登録先を保持。保存待ちを排出してから再開し、別画面の古いcheckpointによる上書きは409で拒否。
- 通信が最後に切れても保存済みの完了を再取得して復旧。SSE終端エラーをLoad failedで上書きしない。キャッシュされた旧画面が600文字超を旧stream APIへ送る場合は再読込を案内する。
- 文書保存上限は従来どおり。密な大記事は未解析部分を別記事として読み込む案内を表示し、先に保存した内容は保持する。
- 実LLM＋Docker/emulatorで364文字を2区間（280/84文字）に分割し、約107秒/45秒で完了。271候補・13文・約91KBを保存し、再送でも増殖しないことを確認した。
- 今回はDBのprompt/schemaファイルを変更していないため、通常のコードデプロイで反映する。既存データの一括migrationは不要。

この対応の検証結果：backend build・unit 82件、import API回帰6件、mixed quiz回帰4件、frontend型チェック・unit 94件・build、Playwright 16件が成功。実Firestore emulatorでも同一区間を並行して2回commitし、候補は1件だけ、古いcheckpointでのPUTは409となることを確認した。今回の配信結果は作業の最終報告を参照。


## 15. 実装記録（2026-10-17）

この節は永続job実装時点の記録。計画から具体化した点は以下のとおり。

- `import_analysis_jobs/{sessionId}` の一つの現在レコードにchunks・snapshot・lease・dispatch sequence・`nextWakeAt`を保存し、このレコード自体をtransactional outboxとした。バッチごとの独立したdispatch文書は作らない。解析結果/試行/action keyはsubcollectionへ分離した。原文上限8,000文字の範囲でsnapshotも別途850,000 byteまで検証する。
- `analysisProgress` version 1は原文の分割と表示/保存チェックポイントとして残る。`analysisJobRef` version 2、`analysisRevision`、`analysisState`を追加し、処理方式と保存保護を区別した。新規入力は `analyzeAsJob`。旧部分解析は再開時にjobへ移し、既存chunksをそのまま保持する。
- 原文の完全な文をIntl.Segmenterで分け、複数文を600 UTF-16文字を目安にまとめる。一文が目安を超えればそのまま一バッチとし、文字位置で切らない。短文は全文一括。queue送信APIも3秒・SDK retryなしに制限し、失敗は永続予定からSchedulerが回復する。workerはsentenceTextsを渡し、原文全体だけでなく文単位の対応も検証する。旧clientのv1専用分割処理はemulator互換目的で残したが、本番でjob構成が有効なら旧clientには再読み込みを要求する。移行済み記事には使わせない。出力上限や有限試行後のtimeoutでは、明示的な再開時に未完了の複数文batchだけを文境界で小さく再計画する。保存済み範囲・一文の途中は分割しない。
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

- backend build、unit87件、import/dispatch回帰8件（既存route6件＋queue送信2件）、mixed route4件が成功。
- ジョブのemulator integration7件が成功（mock LLM、専用demo project）。同時実行、pause/編集再開、stale PUT、旧API拒否、保存結果復旧、有限retry、worker認証、失効leaseとpause、削除cleanup、文境界の明示的再計画を確認。
- frontend type-check、unit94件、build、Playwright24件が成功。通信断からの追従、受付応答喪失、画面離脱後の完了、編集drain、既存A/B追加復旧・全文読解も確認。
- Docker/Firestore emulator + 実LLMの576文字HTTP smokeで受付・保存・重複受付・完了後resumeを確認。
- Bash syntax、normal deploy preflight、差分/リンク検証が成功。
- PowerShell実行はpwsh未導入のため未実施。独立したstaging projectは作らず、local/mock検証と本番の小さい専用記事による限定smokeで確認する。

元計画のPhase A～Fは設計時の作業分解だった。実装の採否・差異・測定結果・実施した確認は本節に記録。料金の自動最適化、全モデル/全言語の実LLM benchmark、任意のサイズでの成功保証は実装済みと主張しない。

## docs/plan の追加整理（2026-10-27）

前回の計画整理はルート `plan/` の3件だけを対象とし、`docs/plan/` の2件を見落としていた。
今回、以下も現行コードと照合して実装済みと確認し、計画ファイルを削除した。
原文と2026-08-04の検証記録は[削除前のGit版](https://github.com/moc9058/vocab-trainer/tree/42eb439/docs/plan)に残る。

| 削除した計画 | 現行実装の確認 |
| --- | --- |
| `word-index-docpath-crash-fix.md` | `73730ab`。`word-index-id.ts` のエンコード・サイズ上限・hash fallback、Firestoreの全7か所と保守スクリプトへの適用、bulk検索ガード、非語彙行の除外、userSplits schema、PUTでの補助lookup失敗の扱い、MISKEYED監査を確認。現在の仕様と保守コマンドは[開発リファレンス](development-reference.md)に記載済み。 |
| `import-word-sentence-mismatch-fix.md` | `f9e4412`、`c5581a3`。文に単語・文法をネストしたschema、位置による文indexの付与、原文照合・帰属修復、反復語の補完、zh/enの不一致検出と登録防止、手動再割当て、ja/koの活用形互換、単体テストと例文監査スクリプトを確認。[開発リファレンス](development-reference.md)に現在の動作を記載済み。 |

旧計画の「現状500」「テスト基盤なし」や当時の行番号・配備指示は、修正前の分析であり現在の作業指示として扱わない。
今回promptやschemaを変更しておらず、`--prompts` のアップロード、一括再解析、本番データ修復は不要。
元計画にあった本番のMISKEYED dry-run実施有無と、実LLM・実画面の当時の未実施項目は、今回のコード照合で完了とは扱わない。
必要な保守判断時に既存の監査手順を参照する。本整理では本番の監査・書き換えや実LLM呼出しを行っていない。

今回の関連回帰はNode 24で `word-index-id.test.ts` と `import-analysis.test.ts` の37件が成功。リポジトリ内の計画ディレクトリを再検索し、残存計画ファイルがないこと、削除ファイルへのローカルMarkdownリンクがないこと、`git diff --check`を確認した。
