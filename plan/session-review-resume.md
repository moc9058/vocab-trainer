# セッション終了後の振り返りテストを保存・再開する計画

作成日: 2026-10-19
状態: 計画のみ（未実装）

## 目的と範囲

「セッション終了」または完了画面の「セッションの振り返りテスト」から始める復習を、途中で離れても続きから受けられるようにする。
対象は、単語、文法、混合 A+B、記事 A/B、表現リコールの既存の復習画面。表現ライティングへの新しい復習機能の追加や、廃止済みの独立 Group B クイズの復活は含めない。

この文書は実装計画であり、アプリケーションの動作は変更しない。

## 現状と原因

- `frontend/src/components/QuizTaking.tsx`、`GrammarQuizTaking.tsx`、`CombinedQuizTaking.tsx`、`ExpressionRecallTaking.tsx` は、復習中かどうかと現在位置を `sessionReviewActive` / `sessionReviewIndex` の React state に保持している。開始時に位置を 0 にするため、再マウント後は途中位置を復元できない。
- `frontend/src/utils/sessionReview.ts` は復習対象一覧を localStorage に保存するが、復習の進行位置は保存しない。既存実装のこの例外を拡張せず、セッション状態は Firestore を正とする方針に揃える。
- サーバーの `reviewedQuestionCount` は「復習を完了した回答履歴の境界」であり、途中のカーソルではない。これを一問ごとに進めると sitting の区切りや Wrong の再出題条件が変わるため、流用しない。
- 現在は最後の「次へ」で `/reviewed` を answerOutbox に追加し、`finishQuizSitting` が復習完了境界と次の sitting の再出題を更新する。
- Dashboard、EmptyState、ExpressionRecallQuizView にも復習待ちセッションの表示判定があり、ここまで更新する必要がある。

参照: [README](../README.md)、[開発リファレンス](../docs/development-reference.md)、[Live Group B quiz](../docs/live-group-b-quiz.md)。

## 保存・再開の仕様

1. 復習開始時に対象と順序を固定して保存する。「次へ」で進むたびに、次に表示する問題の位置を自動保存する。
2. 例: 10 問中 4 問を終え、5 問目を表示して離れた場合、再開時も 5 問目から表示する。「次へ」を押していない問題は完了扱いにしない。
3. ホームへの移動、再読み込み、ブラウザー再起動後に同じテストを開くと、保存済みの復習が優先的に開く。別端末でも同じセッションを取得すれば再開できる。
4. 回答を表示した状態も保存し、再開時に復元する。スクロール位置や個別の例文パネルの開閉までは今回の保存対象にしない。
5. 復習中は本テストの回答、得点、習得状況を追加更新しない。復習を最後まで終えたときだけ従来の sitting 完了処理を一度実行する。
6. 自然終了した本テストは、復習待ち・復習途中でも再開導線を残す。復習完了後は本テストを再開せず「新しく開始」を表示する。
7. 保存中・保存失敗・再試行を表示する。未同期のままタブを閉じる場合の既存警告を維持する。完全オフラインでページを閉じた未送信操作の永続化は今回の対象外とし、最後にサーバー保存できた状態まで復元する。

## データと API の設計案

既存の各 quiz session 文書に任意の `reviewState` を追加する。具体的な型名は実装時に既存コードへ合わせる。

| フィールド案 | 意味 |
| --- | --- |
| `reviewId` | 復習一回を識別する ID。前回の遅延リクエストを拒否する |
| `status` | `active` / `completed`。未開始はフィールドなし |
| `fromAnsweredCount` / `toAnsweredCount` | 開始時に固定した回答履歴の範囲 |
| `cursor` | 次に表示する復習問題の相対位置（0 始まり） |
| `answerRevealed` | 現在の復習問題の回答表示状態 |
| `revision` | 古い端末・タブの上書きを防ぐ更新番号 |

- 問題の本文を重複保存せず、回答済み attempt の順序を用いて復元する。同じ単語への複数回の回答は別 attempt として扱う。単語 ID のみで復習対象を重複排除しない。
- 回答履歴の順序が全対象で保持されることを実装前に検証する。保持されない経路がある場合は安定した attempt ID の配列を固定保存する。本文の取得は従来どおり item ID で行う。
- 復習開始・進行・完了の API を各既存ルート配下に追加／拡張し、共通の遷移ロジックを利用する。全更新に `startedAt`、復習識別子、操作 ID、必要な revision を渡す。
- 開始時は未同期回答と B 除外操作の送信を待ち、サーバーで確認できた回答範囲を固定する。復習中の同じセッションへの本テスト回答は拒否し、別タブが対象を増やすことを防ぐ。
- 進行は範囲・順序・revision を検証する。通信応答が失われた同一操作の再送は成功済みとして返し、二重進行しない。古い操作はカーソルや回答表示状態を戻さない。
- 最終問題の進行と `finishQuizSitting`、`reviewState.status` の完了更新は同じトランザクションで確定する。最後の進行と既存 `/reviewed` の二重送信にしない。旧 API の互換性と active review を迂回できない条件も整理する。
- 完了後に次の sitting へ進んでも、前回の完了再送で新しい回答を復習済みにしない。次の復習には新しい `reviewId` を割り当てる。
- 既存の serial `answerOutbox` に開始・進行・完了操作を統合する。競合時は自動上書きせずサーバー状態を再取得し、404 と通信障害、409 の競合を区別する。
- `backend/src/firestore.ts` の明示的 read mapping（特に `getCombinedQuizSession`）と slim 保存処理に追加フィールドを往復させる。回答・重み更新・B 再調整で消えないことを確認する。

## 実装手順

### 1. 保存モデルとサーバー遷移

- `backend/src/types.ts` と `frontend/src/types.ts` に互換性のある型を追加する。
- `backend/src/routes/quiz.ts`、`grammar-quiz.ts`、`combined-quiz.ts`、`expression-recall-quiz.ts` と Firestore の既存トランザクション処理に組み込む。
- 復習途中では `reviewedQuestionCount` と retry を変更せず、完了時だけ既存の処理を使う。必要なローカル遷移は `quizSitting.ts`、`quizLocal.ts`、mixed operations と整合させる。

### 2. API クライアント・画面

- `frontend/src/api/` の対象 API と `utils/answerOutbox.ts` を更新し、復習状態管理を共通 hook / utility にまとめる。
- 四つの Taking コンポーネントを保存済み状態で初期化し、復習の「次へ」と回答表示を保存処理につなぐ。連打・キーボード入力で同じ問題を二重に進めない。
- Dashboard、EmptyState、ExpressionRecallQuizView の復習再開判定をサーバー状態に統一し、「復習を続ける」と進捗を表示する。mixed は再開時の再取得とライブ B 再調整を維持する。
- 復習対象が削除されていたら「削除済み」と表示して次へ進める。本文の通信失敗は削除とみなさず再試行可能にする。
- `frontend/src/i18n/translations.ts` の日本語・英語・韓国語に再開・保存・競合関連の文言を追加する。

### 3. 既存データとの互換性

- 新しいフィールドがないセッションは従来のサーバー側境界から復習対象を求め、初回開始時に状態を作る。一括本番書き換えはしない。
- 旧実装で復習途中だった位置は保存されていないため復元できない。その一回は既存の未復習範囲の先頭から始める。
- 境界がない古いセッションは従来の「既存回答は復習済み」の扱いを維持し、過去の全回答を復活させない。
- localStorage の旧一覧や空配列をクラウドへ無条件移行しない。サーバー状態がある場合は必ず優先し、旧データ参照を取り除いてから該当キーだけを整理する。
- 新規テストで `startedAt` が変わったら前の復習を引き継がない。言語・種類・combined variant の混同を防ぐ。

### 4. 検証と文書更新

| 検証 | 期待結果 |
| --- | --- |
| 10 問中 4 問終了後に画面移動・再読み込み・再起動 | 5 問目から再開し、回答表示状態も一致 |
| 別端末・localStorage なし | 同じ保存済み復習を取得できる |
| 最終「次へ」の連打・応答喪失・再送 | 完了境界と retry は一度だけ更新 |
| 途中保存の応答喪失、古いタブの更新 | 二重進行・巻き戻りなし。競合時は再取得 |
| 新規テスト作成後に旧操作が到着 | 新しいテストを変更しない |
| 回答・B 除外の送信中に復習開始 | 確定済み回答から正しい対象を固定 |
| mixed 再開時の B 増減・重み変更 | 復習対象と進捗を保持し、通常の範囲調整も維持 |
| 復習中の削除／本文取得失敗 | 削除は次へ進める。障害は再試行できる |
| 途中終了したテストの復習完了 | 同じ sitting では Wrong が再出題されず、次の sitting で最大一枠だけ復帰 |
| 自然終了したテストの復習 | 完了済み本テストを再開しない |
| 旧形式・破損した旧ローカルデータ | 過去回答の復活や復習導線の消失がない |
| 全対象種類・言語・variant | 保存状態が互いに混ざらない |

共通遷移の単体テスト、モックストアの API テスト、`frontend/tests/browser/quiz.pw.ts` のブラウザーテストを追加する。Firestore emulator では保存後の再取得と競合を検証する。

実装後の必須チェック:

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:mixed --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
npm run test:browser --prefix frontend
git diff --check
```

README、開発リファレンス、Live Group B の説明を更新し、利用可能ならローカル emulator / Docker で全経路を smoke test する。実装の配信には通常の `./deploy.sh` を使い、設定アップロードや本番データの一括移行は不要とする。

今回の計画文書については参照パス・現在のコードとの整合性と `git diff --check` を確認する。実装・アプリケーションテストは次の作業とする。
