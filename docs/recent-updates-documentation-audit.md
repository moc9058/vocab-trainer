# 最近の更新の文書化確認

確認日: 2026-10-20（日本時間）

## 対象と方法

2026-10-05〜19の33コミット（`770a309`〜`235f329`）について、gitの変更履歴・文書差分と現在の実装を照合した。確認対象はローカルの `master`、実装修正を含まない文書監査。クラウドの配信状態・保存データ・実LLMの品質を検証した結果ではない。

再確認用の履歴コマンド:

```bash
git log --reverse --date=short --format='%h %ad %s' 770a309^..235f329
git log --name-only --format='%h %s' 770a309^..235f329 -- '*.md'
```

## 更新ごとの文書化状況

| 更新・代表コミット | 現在の主な文書 | 実装との照合結果 |
| --- | --- | --- |
| live Group B、原子的な除外・採点、登録復旧（`770a309`、`052baac`） | [live B仕様](live-group-b-quiz.md)、[開発リファレンス](development-reference.md)、[README](../README.md) | 固定A範囲、live B優先、遅延移行、除外後のA継続、登録再試行が記載済み。`mixed-quiz-scope.ts`、`mixed-operations.ts`、combined routesと照合。古いprefetch説明と配信案内は今回補正。 |
| Cloud Run費用制御、sitting境界、同一sitting内の誤答再出題抑止（`ad1d658`、`380e59a`） | [費用制御](cloud-run-cost-controls.md)、README、開発リファレンス | deployスクリプト、`quiz-sitting.ts`、word/grammar/combinedの採点経路と照合。READMEのword回答APIに残っていた即時再出題の説明を訂正。 |
| A/B追加後24時間のNEW表示（`96ca941`） | READMEのhydrate API、開発リファレンス | `routes/quiz.ts` と `firestore.ts` の `groupAddedAt` 読み出し、クイズ表示と一致。 |
| 全文リーダー、固定要素・可変枠、詳細表示順、登録操作、中国語拼音（`f557b48`〜`302e63b`の関連更新） | 開発リファレンスのWhole-source reader／Budgets、README | `ImportFullTextReader.tsx`、`importReadingAnalysis.ts`、backendの読解正規化と照合。詳細仕様は記載済み。READMEにも全文モードの登録、境界表示、構文内の拼音表示を追記。通常解説後の候補補正も明示。 |
| compact解析、永続ジョブ、分割・再開・復旧、ストリーミング進捗（`2cfe7d3`、`0928e9f`、`748920b`、`1d622e3`） | README、開発リファレンス、費用制御、[実装・検証記録](external-source-implementation-audit.md) | `import-jobs.ts`、`import-job-store.ts`、`import-progress.ts`、`useImportAnalysisJob.ts`と照合。保存済み原文量と生成文字数の区別、540秒期限、進捗の集約、画面終了後の継続が記載済み。10月17日の検証記録は当時の記録として保持。 |
| 文法・解説の範囲修正、変換、mini読み支援と構文同期（`c48e5df`、`d8f67c7`） | [修正機能仕様](source-revisions.md)、開発リファレンス、README | revision routes/store、`import-revisions.ts`、word links、`llm-features.ts`と照合。比較・採用・undo・競合、mini機能名、`x`化、旧記事補正、辞書・所属の保持が記載済み。READMEの目次から仕様へ直接リンクを追加。 |
| レビュー進捗保存、旧mixed回答順保持、レビューのシャッフル（`dc66f36`、`4e18532`、`33a15af`） | READMEのQuiz sessions and review、開発リファレンス、live B仕様 | `quiz-review.ts`、Firestoreの明示read mapping、`sessionReview.ts`、combined routesと照合。固定回答範囲・保存順・cursor・競合・最後の確認済み位置への復帰は記載済み。READMEにレビューAPIの要求・応答・対象prefixを追記。 |
| 意味のまとまり解説（`235f329`） | [当時の設計・実装計画](https://github.com/moc9058/vocab-trainer/blob/235f329/plan/source-meaning-units-design.md) | 計画に「設計のみ・未実装」と明記され、チェックリストは未完了。現行の読解型・表示には追加フィールド／専用表示がなく、実装済みとして扱わない。READMEと修正機能仕様から未実装と分かるリンクを追加。 |

## 今回修正した不一致・不足

- READMEのword回答APIが「Wrongで即再キュー、正解まで反復」と説明していた。現在は同じsittingで再出題せず、途中レビュー完了後の次sittingで再び対象となる。自然終了したテストは再開しない。
- 保存可能なレビューAPIが開発リファレンスだけに記載されていた。READMEにも `start` / `next`、操作ID、revision、保存範囲、シャッフル順と対象クイズを追加した。
- READMEの通常一文解説が「候補を変えない」と読めた。APIの結果返却とブラウザー側の候補整合・autosaveを区別し、`candidatesManaged` の有無による違いをREADMEと修正機能仕様に記載した。「解説のみ」の修正案採用が候補を増減させない契約は維持する。
- 開発リファレンスに廃止済みの単独Group B画面と「ID集合はセッション中不変」という説明が残っていた。現行のクイズ種別と、mount時のprefetch対象・mixed再開時のlive ID取得を区別した。未取得カードには通信が必要な点も明記した。
- READMEの画面一覧にも旧50件ページ取得と英語のcombined非表示が残っていたため、IDによる先読みと現在の表示条件に更新した。開発リファレンスの文法即時retry、旧stream APIを主経路とする説明、autosaveが返す版情報の説明も補正した。
- READMEの全文リーダー概要と文書目次が新しい登録操作・境界表示・修正機能を十分案内していなかったため補足した。解説の自動要求と明示生成も区別した。
- live B仕様末尾の「自宅PCから配信が必要」という旧作業状態を、環境要件と通常の配信手順に改めた。git履歴だけから現在の配信完了を推定しない。

## 確認範囲と残る制約

主要更新は文書化されており、上記の古い説明と導線不足を今回補正した。過去のテスト件数・実LLM確認結果は各日付の記録であり、今回の再実行結果ではない。

今回の検証は、変更したMarkdownの相対ファイルリンク・アンカー、記載したAPI・スクリプト・npmコマンドの実在、実装との整合、`git diff --check`。文書のみの変更のためアプリケーションテストは再実行しない。本番の保存データ確認、一括再解析、設定アップロードは行わない。

変更文書5件の相対リンク／アンカー37件、主要npmスクリプト10件、関連ソース・スクリプトのパス11件の確認が成功した。配信環境の確認ではDockerのWSL連携が利用できず、`docker info` が失敗したため、この環境からのデプロイは保留。

## 後日の実装（2026-10-27追記）

上表の意味のまとまり解説の未実装判定は2026-10-20時点の記録。2026-10-24に初版が実装され、2026-10-27の[実装整理](ios-meaning-units-implementation-audit.md)でコードと照合した。実装済みの計画は削除し、上表のリンクは当時のGit版へ向けた。元の監査結果・検証件数は変更していない。
