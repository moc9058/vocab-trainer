# 数学教材JSONの作成・変換・レビュー

新しい教材の正本は章JSONと科目JSONです。本文内のMarkdown/LaTeX文字列は利用できます。
[章Schema](math-chapter.schema.json)、[科目Schema](math-subject.schema.json)、
[完全な章の例](math-chapter.example.json) が入力契約です。

1. `textbook/catalog.json` の `subjects` に公開する `subject.json` だけを列挙します。
   登録外フォルダー、PDF、Markdown原本は公開しません。
2. subjectの `nodes` は明示的なsubject/part/chapter階層です。chapterの `contentFile` は
   subject.jsonを基準にした相対JSONパスです。`parentId/order` を表示順に使います。
   章依存は `dependencies.edges` の `nodeId` が `requires` 全部を必要とします。
   番号や順番から依存を推測しません。Part依存は全子章へ展開して循環検証します。
3. 章は順序付きのsection/item/blockです。sectionのtitleは必須、itemのtitle/keywordsは任意。
   無題itemはkindとlabelで表示します。itemのIDはタイトル変更やファイル移動で変えません。
4. 原文の章冒頭の共通仮定、見出し、本文、式、Properties、注意、例を順序通り保持します。
   Markdown ASTで構造を読み、単純な行正規表現だけで教材を分割しません。
   元ファイルの実SHA-256と既知のURLをsourceに保存します。書名・版・ページは推測しません。
   絶対パス、PDF、画像、raw OCR、任意HTMLをJSON本文へ入れません。
5. 装飾HTMLは削除し、内側の文言・Markdown強調は残します。色や下線の注記と
   逆変換情報をローカル比較reportへ保存します。原文の数学的な校正は別作業です。
6. 出題対象itemはlearningを持ちます。requiresは明示的なitemId/capabilityの全条件です。
   他章itemへの参照は、その章が章依存の推移閉包内にある場合のみ許可します。
   補足・資料専用itemはlearningを省略します。
7. objectivesを省略するとrecognize/applyだけが難易度 `[1,2]` で決定的に作られます。
   proveや高難易度は自動許可しません。証明を評価するobjectiveは対象能力とproofSupportを
   明示し、実際の証明blockとcoverageをレビューします。proof itemにはprovesItemIdが必須です。
8. 複数科目のfoundationはsubjectId/conceptId/capability/revisionIdを固定します。
   ユーザーが習得済みであると自動記録しません。

外部packageの形は `{schemaVersion:2,subject,chapters,unresolved:[]}` です。
`npm run math:extract:import --prefix backend -- --root <教材root> --package <package.json> --output <run>`、
`math:author-review -- --run <run>` で内容を確認し、`math:author-accept -- --run <run> --units <全chapterIdのカンマ区切り> --expected-review-hash <hash> --reviewed-by <名前>`
で承認します。科目構造と章の全体を一緒に承認し、部分的に壊れたDAGを保存しません。
review receiptはsubject.reviewに保存し、教材全体・依存定義・compiler versionのhashに結び付けます。
直接編集後は再レビューが必要です。acceptは競合検知と再開用journalを使います。
Markdown/YAMLの旧package/readerは既存教材を読む移行互換adapterです。新規acceptは `E_LEGACY_AUTHORING_READ_ONLY` で拒否し、v2 JSON packageへの変換と再レビューを要求します。
OCR自体は引き続きlocal-onlyです。リモートOCRへ自動切替しません。

`npm run math:validate --prefix backend -- --root textbook` は同じSchemaを利用して
unknown field、duplicate key、参照、循環、サイズ、パス、数式、review hashを検証します。
正常な数式描画や完全一致の変換は、原文の数学的正しさの一般保証ではありません。
