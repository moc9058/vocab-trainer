# 数学教材・解説用プロンプト

対象: ローカルPC上のPDFから、Vocab Trainerで使う数学教材の下書きを作成するエージェント。

| ファイル | 用途 |
| --- | --- |
| [JSON教材の作成・変換](math-textbook-json-authoring.md) | v2章/科目JSON、任意タイトル、依存、review/accept |
| [章Schema](math-chapter.schema.json) / [科目Schema](math-subject.schema.json) / [完全な章例](math-chapter.example.json) | backend/CIも同じSchemaを利用 |
| [PDF解析と学習ユニット作成](math-pdf-to-learning-units.md) | エージェントへ渡す主プロンプト。入力設定を埋めて使う |
| [ローカルOCRの選択・実行ガイド](math-ocr-local-guide.md) | Mac mini M4向け。MinerU 4.x、比較候補、LaTeX品質検査 |
| [出典付き数学解説](math-solution-with-sources.md) | 確定した問題と許可知識から、全階層・使用定理付きの解説を作る |

v2の契約は [数学モードv2計画](../plan/math-mode-v2-implementation-plan.md) とJSON Schemaを優先する。従来設計は [実装計画](../plan/math-category-implementation-plan.md) と [教材作成設計](../plan/math-content-authoring-design.md)。このフォルダーはエージェント用の作業指示であり、アプリのruntime promptを自動更新するものではない。

使用例:

```text
prompt/math-pdf-to-learning-units.md に従って、指定したPDFの指定範囲を解析してください。
PDF_PATH: <ローカルのPDF絶対パス>
SUBJECT_ID: engineering-math
PDF_PAGES: <1-basedの開始ページ-終了ページ>
OUTPUT_ROOT: <ローカルの新しい作業用ディレクトリ>
OUTPUT_LANGUAGE: ja
OCR_POLICY: local-only
SEMANTIC_POLICY: local-only
MODE: draft
```

`SEMANTIC_POLICY: local-only` は意味抽出・教材化もローカル推論する設定。ホスト型エージェントにOCR済み内容を読ませたい場合は `agent-analysis` を明示する。この場合もOCRはローカルだが、教材内容の推論まで完全ローカルとは呼ばない。`agent-analysis` を指定してもリモートOCRやPDFアップロードへの切替は許可しない。

範囲未指定なら、目次とページ対応の調査・処理計画までを行い、全冊処理を始めない。組込みCLIは `npm run math:extract --prefix backend -- --subject <id> --source-id <id> --pdf <path> --pages <range> --export-request --output <run>` でv2の依頼を出力できる。実際にOCRする場合はlocal adapter/modelを明示する。

最終成果物はschemaVersion:2の章JSON package。`math:extract:import`、`math:author-review`、`math:author-accept` で原本照合後に承認する。旧MD/YAMLは読み取り移行adapterのみで、新規acceptは不可。通常deployはallowlistの承認済みJSONだけを公開する。

線形代数9章のJSON変換・逆変換検証は [変換記録](../docs/math-v2-conversion/README.md) を参照。ローカルOCR環境のインストール、モデル取得、実PDFの抽出や品質測定を実施したことは意味しない。
