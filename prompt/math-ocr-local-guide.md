# ローカル数学PDF OCRガイド — Mac mini M4

確認日: 2026-10-28。実行プロンプトは [math-pdf-to-learning-units.md](math-pdf-to-learning-units.md)。ここでは公式資料で確認した対応と、実機で評価すべき内容を分ける。実機ベンチマーク済みではない。

## 1. 推奨する選び方

**第一候補はMinerU 4.x Standard。数式が難しいページはAdvancedと比較し、実際の誤りが少ない方を採用する。** 「Miner 4.X」はここではMinerU 4.xとして扱う。Advancedは独立した巨大モデル名ではなく、Standardと同じモデル/runtimeで計算量を増やすtierである。Apple Siliconの経路はsmall modelsがTorch/MPS、VLMがllama.cpp。公式にはmacOSへの直接導入と16GB以上のunified memoryが推奨されている。[MinerU公式: tiers/runtimes](https://opendatalab.github.io/MinerU/usage/tiers/)

基本型M4 Mac miniは16GB unified memoryの構成を想定するが、実行前に実機のメモリと空き容量を確認する。OSや他アプリと共有するため、モデルの公称容量だけで同時実行数を決めない。[Apple仕様](https://support.apple.com/en-us/121555)

| 候補 | 使用方針 |
| --- | --- |
| MinerU Standard | 通常の抽出候補。本文・式・図表・読み順を同時に確認する |
| MinerU Advanced | 同じ難ページで比較。改善した場合だけ、そのページ/類型へ適用する |
| Docling + formula enrichment | 比較・不一致調査の候補。通常OCRだけでなく数式変換を明示的に有効化する |
| MinerU Basic / CPU経路 | メモリ不足時の段階的代替。品質が同等だと推定せず、再検証する |
| native text / Flash | 目次・本文の探索用。数式がLaTeXになったか確認せず最終成果物にしない |

Doclingには数式のLaTeX変換とMPS指定がある。ただしM4のこのPDFでMinerUより正確・高速だという比較結果はない。[Docling pipeline options](https://docling-project.github.io/docling/reference/pipeline_options/)、[CLI](https://docling-project.github.io/docling/reference/cli/)

新しいモデルを追加する場合も、Apple Siliconの実行経路、メモリ、数式、読み順、出典座標を同じ小さい評価セットで比較する。公開benchmarkの総合点だけで採用しない。

## 2. 実行前の確認

- macOS/arm64、搭載メモリ、空きdisk、Python/uv、現在のOCR version、利用可能なruntimeを確認する。
- venvはプロジェクトの実行環境と分離する。Mac上でMPS/Metalを使う経路を選び、Linux/CUDA向けコマンドをコピーしない。
- 既存OCR環境が使えるなら再利用する。バージョンや依存を無断で一括upgradeしない。
- 元PDFはread-only。出力先は新しいrun directory。PDF hash、ページ数、暗号化・スキャン/テキスト層の状態を記録する。
- OCR、再構成、比較モデルを同時に常駐させず、初期は1プロセス・小さいpage batchで順に実行する。
- OCRのremote、LLM-aided外部endpoint、自動外部fallbackを有効にしない。loopback addressでも外部へ転送するproxyでないか設定を確認する。
- モデル重みの取得通信と、教材送信を区別する。重みを準備後、ローカル推論で処理する。

MinerUのLLM-aided処理は別のendpoint設定を持つ。使わないものは無効のままにし、ローカルOCRに外部の補助処理が混入しないよう確認する。[公式設定](https://opendatalab.github.io/MinerU/usage/quick_usage/)

## 3. MinerU 4.xの実行例

以下はリポジトリルートで使う例。実際の入力値を設定し、導入済みversionのhelpでオプションを確認する。今回このコマンドを実行したという意味ではない。

```bash
# 新規環境が必要な場合のみ。backend/data はこのリポジトリのgit無視領域
MATH_OCR_VENV='backend/data/math-ocr-tools/.venv'
uv venv --python 3.12 "$MATH_OCR_VENV"
uv pip install --python "$MATH_OCR_VENV/bin/python" 'mineru>=4.0,<5'

"$MATH_OCR_VENV/bin/mineru" version --json
"$MATH_OCR_VENV/bin/mineru-kit" parse --help
"$MATH_OCR_VENV/bin/mineru-kit" models show
```

Python 3.12と4.x用のbase installは公式quick startに基づく。インストール後は実際に解決したpackage versionとモデルrevisionをrunに保存する。将来のminor versionでCLIやモデルが変わり得るため、既存runではその版を固定する。[公式quick start](https://opendatalab.github.io/MinerU/quick_start/)

```bash
# 次の入力値は実際のPDF・小範囲・未使用run名へ置き換える
MATH_PDF='/absolute/path/to/book.pdf'
MATH_PAGES='20-22'
MATH_RUN='backend/data/math-authoring/replace-with-new-run-id'
mkdir -p "$MATH_RUN"

# 準備されていない場合のモデル取得。取得先とdiskを確認して実行
"$MATH_OCR_VENV/bin/mineru-kit" models download --tier standard
"$MATH_OCR_VENV/bin/mineru-kit" models verify

# ページ番号は1-based、両端を含む。範囲を必ず指定
"$MATH_OCR_VENV/bin/mineru-kit" parse "$MATH_PDF" \
  --pages "$MATH_PAGES" --tier standard --format zip -o "$MATH_RUN/standard.zip"

# 同じページを比較するときのみ。Standardの結果を上書きしない
"$MATH_OCR_VENV/bin/mineru-kit" parse "$MATH_PDF" \
  --pages "$MATH_PAGES" --tier advanced --format zip -o "$MATH_RUN/advanced.zip"
```

ページ範囲は1-basedで、`mineru-kit parse` は省略すると全PDFページが対象になる。`models show` と実際のparse成功は別である。`show` のみでモデル準備・推論が成功したと報告しない。[公式usage](https://opendatalab.github.io/MinerU/usage/quick_usage/)

ZIP出力はMarkdownだけでなく、構造化JSONと画像を保持するために使う。現在の出力のschema/versionを見て読み込み、古いMinerUの `pdf_info` 等を決め打ちしない。現在の中間JSONの `page_idx` は0-basedなので、アプリのSourceSpanへ変換するときだけ1を加える。部分抽出の先頭を元PDFの1ページ目と誤認しない。[公式output format](https://opendatalab.github.io/MinerU/reference/output_files/)

モデル未対応・メモリ不足・推論失敗時は、自己的な重複jobを止め、小さい範囲/対応するCPU経路を試す。全ユーザーアプリの強制終了、OSメモリ保護の解除、remoteへの切替は行わない。

## 4. Doclingの比較例

MinerUとは別のvenvを使い、`docling convert --help` で現在のCLIを確認する。例:

```bash
# Docling環境を導入済みの場合。MATH_PDF / MATH_RUN は上記の実際の値
docling convert "$MATH_PDF" --page-range 20-22 \
  --to md --to json --enrich-formula --device mps --page-batch-size 1 \
  --no-enable-remote-services --output "$MATH_RUN/docling"
```

CLIで数式enrichmentは既定offで、上記はそれを有効化する。MPS未対応の演算/環境なら、記録したうえで対応CPU設定を検討する。CLI構文は実行時のhelpを優先し、`convert-remote` は使用しない。[Docling CLI](https://docling-project.github.io/docling/reference/cli/)

## 5. M4での小規模比較

最初の1〜3ページで動作とメモリを確認する。その後、本文、定理ボックス、行列、分数/積分、複数行式、2段組、ページまたぎ、劣化スキャンを含む8〜12ページ程度を選ぶ。該当類型がないPDFでは無理に追加しない。

同じページを使い、最低限次を `ocr-benchmark.md` に記録する。

| 指標 | 記録内容 |
| --- | --- |
| 再現条件 | OS、memory、tool/model revision、tier、実際のbackend、pages |
| 資源 | 処理秒数、peak RSS、メモリ圧迫/新規swap、失敗・再試行 |
| 数式 | 原ページと照合した数、欠落、意味が変わる誤り、画像fallback件数 |
| 数学条件 | 仮定、定義域、例外、定理番号の欠落/誤認 |
| 構造 | 読み順、Part/Chapter/Section階層、ページ・座標の対応 |
| 編集負担 | 要修正箇所、修正に要した時間、未解決箇所 |

優先順位は **意味を変える誤りが少ない → 構造・出典が追える → 実機で安定する → 時間/修正量**。サンプルの重要な式・条件に未解決の誤りがあれば公開不可。サンプル合格を全冊の正しさの保証にしない。

Advancedが改善しないページまで繰り返さない。2モデルが一致しても原ページ確認を省略しない。不一致は多数決で解消せず、ページ画像・式cropと突き合わせる。

## 6. Markdown/LaTeXの検査

- インラインは `$...$`、独立式は空行付きの `$$...$$`。式を画像リンクだけで済ませない。
- 長い導出は `aligned` 等で改行し、等号位置を合わせる。数式の途中に引用breadcrumbの文字列を混ぜない。
- 分数・添字・指数・積分上下限・総和範囲・行列の行列数・場合分け・絶対値・微分の次数を原ページと照合する。
- 本文中の金額等とmath delimiterを区別する。壊れた `$` を正規表現だけで雑に補修しない。
- 原本MDのbackslashは単一。JSONでは正しいserializerでescapeする。YAMLでLaTeXを持つ場合はliteral blockまたはsingle-quoted scalarを使い、`\t` 等を制御文字にしない。
- `\input`、`\include`、外部画像、任意HTML、未知macroを実行しない。対応するKaTeX構文へ変換する場合は意味保持と差分を記録する。
- 数式番号・Theorem番号を別metadataに保存し、レンダラーの自動採番と混同しない。
- Markdownに数式画像しかないものは `FORMULA_IMAGE_ONLY`、読めない文字は `FORMULA_UNREADABLE`。LaTeX化未完了を成功扱いにしない。
- 原PDFの画像と、生成MDを数式rendererで表示した結果を両方確認する。生成renderだけの確認は不十分。

OCRツールを入れただけ・MDファイルができただけ・LaTeXが構文上通っただけでは教材完成としない。
