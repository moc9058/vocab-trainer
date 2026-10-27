# 使用定理と全階層を明示する数学解説プロンプト

用途: 問題の模範解答・解説を作成する。PDF抽出やscope拡張を行う指示ではない。入力はサーバーで確定した問題、T/P/B/G、concept revision、出典registry、採点rubricとする。

## 入力に必要な情報

- 問題文、変数・定義域・条件、対象objective。
- 利用可能なconcept/capabilityとその正確なStatement/Conditions。
- `mustEstablish / mayAssume` と与えられたG。
- citation registry: concept/revision、source occurrence、書名・版、全階層、印刷された定理/定義等の番号・名称、ページ、block ID。
- problem/scope/catalogの固定版、回答言語。

入力に存在しないTheorem名、Chapter、ページ、公式を捏造しない。必要な前提・出典が不足していれば `NEEDS_CONTEXT`、許可範囲外の知識が必須なら `IMPOSSIBLE_WITH_SCOPE` として返す。

## 解説の順序

**先に使用する知識を示し、その後に、各ステップでも根拠を示して解説する。**

1. 使用する定理・定義・Lemma・公式の一覧。
2. 解法の方針。
3. 各ステップ: 使うcitation → 適用条件の確認 → 式と説明。
4. 最終解答、定義域・定数・例外。
5. 検算・注意点。

使用知識の表示には、存在する全階層を含める。

```text
科目 / 書名・版 / Volume / Part / Chapter / Section / Subsection
→ Theoremの番号・名称（印刷ページ、PDFページ）
```

上記は形の例。ない階層を作らず、ある階層を省略しない。本文に実名・番号がない項目は「番号なしの定義」等、registryの情報に沿って表示する。

基礎profileや著者の独自解法は、そのprofile/unitと版を示す。書籍のTheoremへ偽装しない。対象T、前提P、基礎B、提示Gも区別する。

## ステップの規則

- 各実質的な変形・推論は、使ったconceptとcitation IDを紐付ける。
- 単純な整理も、許可された基礎のルールを示せるようにする。ただし同じ長いbreadcrumbを式の各行に繰り返す必要はなく、step単位でよい。
- Theoremを使う前に、その仮定が今回満たされる理由を説明する。
- 証明すべき命題そのものを既知として引用しない。
- 正しい別解を否定しないが、今回の模範解答は許可された手法で作る。
- 分母ゼロ、対数の定義域、積分定数、分岐、除外した解を確認する。

## LaTeX

- 本文中の短い式は `$...$`、導出や結果は `$$...$$`。
- 複数行は `aligned`、行列は `pmatrix/bmatrix`、場合分けは `cases` 等を使い、読みやすく分ける。
- 定理名・出典・説明は数式環境の外に置く。
- 任意のHTMLや外部macroに依存しない。参照番号はregistry由来の表示とし、未解決の `\ref` を残さない。
- 学習者向け画面はLaTeXソースのコードブロックではなく、レンダリングした数式を表示する。

## 構造化出力

runtimeでは以下の構造に従い、実際のJSON schemaを優先する。

```ts
interface SolutionDraft {
  status: 'candidate';
  usedKnowledge: {
    conceptId: string;
    revisionId: string;
    citationIds: string[];
    role: 'target' | 'prerequisite' | 'foundation' | 'given';
  }[];
  strategyMarkdown: string;
  steps: {
    id: string;
    citationIds: string[];
    uses: { conceptId: string; capability: string }[];
    applicabilityMarkdown: string;
    explanationMarkdown: string;
  }[];
  finalAnswerMarkdown: string;
  checksMarkdown: string;
}
```

フルbreadcrumbはサーバーがcitation IDから解決する。モデルが出力する説明と、registryの書誌・階層情報を混ぜて自由生成しない。`usedKnowledge` とstepsの参照の和集合が一致し、全て許可集合内であることを検証する。

解答公開前に数学的整合、条件、scope、出典参照、LaTeXを独立検証する。このプロンプト単独の出力を正解保証と扱わない。
