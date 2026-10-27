# 数学カテゴリー実装計画

作成日: 2026-10-27（日本時間）

改訂日: 2026-10-28（日本時間）。教材の物理形式を未確定とし、PDFから学習ユニットを作る方式へ改訂。

状態: **設計・未実装**。このファイルは、別の実装エージェントが作業を開始できる仕様書である。

対象リポジトリ: Vocab Trainer（React 19 / Vite 6 / Fastify 5 / TypeScript / Firestore / Cloud Run）

## 1. 最初に読むこと・今回の境界

### 1.1 ユーザーの要求

- 現在の語学カテゴリーに並べて「数学」を追加する。
- `textbook` 直下のサブフォルダーを科目とする。科目内の物理配置は未確定とし、任意深さの論理ツリーで出題範囲を選ぶ。既存/将来の物理フォルダー構造も取り込める。
- PDFからAIが核心を抽出し、定義・定理の列挙より学習に適した形式で保存して、難易度別の問題を解く。
- 高難度では複数の概念を組み合わせてよい。
- Chapter間の前提関係、範囲外の概念、暗黙の基礎知識を制御する。
- ローカル教材、DB、LLM入力の役割を明確にする。
- **現時点で教材のPart / Chapter / Sectionフォルダーや教材内容を補完しない。**

この計画の作成作業ではアプリを実装しない。後続の実装でも、テスト用の架空教材は `backend/src/test-fixtures/math/` 等に置き、実教材の `textbook/` に作らない。PDFからの抽出・ページ照合・階層提案は教材作成機能として設計するが、この計画作成中に実PDFを処理しない。詳しくは [教材作成設計](math-content-authoring-design.md) を読む。

### 1.2 設計上の結論

**PDFから「学習ユニット」を作り、内部の概念・能力を構造化する。教材の論理階層と概念の依存関係を別々に管理し、出題範囲は「評価対象」「利用可能な前提」「問題文で提供する知識」の三層に分ける。**

たとえばChapter 6を選んだ場合、Chapter 6の概念を評価対象とし、必要なChapter 1〜5の概念だけを前提として明示する。基礎積分なども、確認済みの基礎プロファイルに含まれるものだけを使う。Chapter 7の手法を黙って使う問題は採用しない。

難易度は「範囲を広げる権限」ではない。同じ範囲で、概念の組合せ、方針選択、抽象度、計算量、証明負荷を変える。

### 1.3 実装時に守る既存ルール

- [AGENTS.md](../AGENTS.md)、[README](../README.md)、[開発リファレンス](../docs/development-reference.md)を先に読む。
- 語学のA/B、mixed quiz、記事インポート、認証、既存の回答キューの意味を変更しない。
- Firestoreの既存データに一括マイグレーションを行わない。数学用の名前空間を追加する。
- 教材同期とアプリのデプロイを別操作にする。`./deploy.sh` から教材を自動アップロードしない。
- ローカル検証はemulatorを使う。`FIRESTORE_EMULATOR_HOST` を `.env` に書かない。
- 最後は実装範囲に応じた検証、ドキュメント更新、commit、`git push origin master`、デプロイを行う。ブランチがmasterでなければ既存規約に従って確認する。

## 2. 実コードを確認した結果

2026-10-27時点の確認。行番号は変わるため、以下のファイルとシンボルを起点に再確認する。

| 現状 | 実装への影響 |
| --- | --- |
| `textbook/engineering_math/` にPDFが1つある。Markdown、Part、Chapterは未配置。`textbook/` は確認時点で未追跡 | PDFやユーザー教材を勝手にcommitしない。空教材で動く導線を用意する |
| `frontend/src/App.tsx` は `/` と `/:language/*` を持つ | `/math/*` を明示的な独立ルートとして追加し、数学を `Dashboard` に渡さない |
| `LanguageSelectPage.tsx` は `/api/languages/` を取得してカードを作る | 数学カードを語学データに依存させず表示する。語学取得エラーでも数学へ入れる |
| `studyLanguageAvailability.ts` は英語の入口を一時停止している | 数学追加に伴って英語を再開しない |
| `backend/src/firestore.ts:listLanguages` は単語数付きの語学一覧を返す | `languages/math` や架空の `math.json` を作らない |
| `backend/src/index.ts` に認証フックとルート登録が集中 | `/api/math` は同じ認証を通す。内部workerの例外は完全一致のURLに限定する |
| 現在の認証は許可メールによる共有データセットへのアクセス制限 | 数学も初版は同じ単一共有学習者モデル。ユーザー別DBがあると仮定しない |
| `llm.ts:callLLM` にモデル解決、JSON schema、usage記録、タイムアウトがある | 問題生成・採点はこの層を使う。PDF/image抽出は入力型の拡張またはauthoring adapterが必要で、既存の文字列引数へPDFをそのまま渡さない |
| `llm-features.ts` が機能別モデル選択を管理 | `math/generate`、`math/validate`、`math/grade` を独立登録する |
| 記事解析にはCloud Tasks、OIDC worker、lease、reconcile、ローカルworkerがある | 同じ永続ジョブの原則を使う。ただし `ImportJob` に数学を偽装しない |
| `llm-budget.ts` は内部import workerだけ特別な時間枠を持つ | 数学worker追加時は明示的に時間枠を追加し、既存の180秒制限を見落とさない |
| `answerOutbox.ts` はモジュール単位・直列・メモリ保持のキュー | 数学の保存操作も同じ順序保証・未同期警告に接続する。localStorageに答案を保存しない |
| `api/transport.ts` がWeb Cookie / iOS Bearerを吸収 | 数学APIも `api/client.ts` 経由で呼ぶ |
| フロントにMarkdown / LaTeX描画ライブラリは現在ない | 数学専用rendererと依存を追加し、HTML・数式の安全な表示を検証する |

参照すべき具体的なファイル:

- [App](../frontend/src/App.tsx)、[入口](../frontend/src/components/LanguageSelectPage.tsx)、[語学ルート](../frontend/src/components/StudyLanguageRoute.tsx)
- [Firestore](../backend/src/firestore.ts)、[認証と登録](../backend/src/index.ts)、[モデル機能](../backend/src/llm-features.ts)、[LLM](../backend/src/llm.ts)
- [記事ジョブ](../backend/src/import-jobs.ts)、[dispatch](../backend/src/import-task-dispatch.ts)、[worker](../backend/src/routes/import-worker.ts)、[budget](../backend/src/llm-budget.ts)
- [回答キュー](../frontend/src/utils/answerOutbox.ts)、[通信](../frontend/src/api/transport.ts)、[翻訳](../frontend/src/i18n/translations.ts)

## 3. 用語と責務

| 用語 | 定義 |
| --- | --- |
| Subject（科目） | `textbook` 直下のフォルダー。例: Engineering Math |
| CurriculumNode（教材ノード） | 科目・Part・Chapter・Section等の論理表示ツリー。物理フォルダーとの対応は任意 |
| LearningUnit（学習ユニット） | 核心・知識要素・手法・例外・評価目標・出典を持つ編集単位 |
| Concept（概念） | Definition / Theorem / Lemma / Proposition / Corollary / Method / Identity / Notation等の意味単位 |
| Objective（評価目標） | 「概念を説明する」「適用する」「証明する」等、概念と能力を結び付けた評価単位 |
| Prerequisite（前提） | 特定のObjectiveに取り組むために必要な別概念の能力 |
| Foundation profile（基礎プロファイル） | 今回は既知として利用を許す基礎概念の明示的な集合 |
| Catalog release（教材公開版） | ツリー・概念revision・依存辺・基礎プロファイルを一貫した組合せで固定した版 |
| Scope snapshot（出題範囲スナップショット） | テスト開始時に確定した評価対象、利用可能知識、出典、設定の固定版 |
| Test（テスト） | 固定された問題群・範囲・採点規則を持つ学習単位 |
| Sitting（学習回） | 連続して取り組み、中断・終了するまでの範囲。テスト全体とは別 |

推奨は「1学習テーマ = 1ユニットMarkdown」。Conceptはその内部の細かい意味単位として取り出し、別ユニットからも参照できる。Objectiveは具体的な行動を表し、評価するconcept/capabilityを明示する。

## 4. 出題範囲と前提知識の仕様

### 4.1 四つの集合

サーバーで次を決定する。クライアントやLLMから受け取った許可集合をそのまま採用しない。

- `T`: 選択ノード配下のunitに属する有効な評価目標。今回の得点・進捗の対象。unitに登場するだけの知識は含めない。
- `P`: Tまたは選んだ問題設計に必要な、依存グラフから求めた前提概念・能力。
- `B`: ユーザーが使用を確認した基礎プロファイルの概念・能力。
- `G`: その問題文中で、結果や公式を明示的に与える概念・能力。

利用可能な知識 `K = assessedCapabilities(T) ∪ accepted(P) ∪ B ∪ G` とする。ただし単に概念IDが含まれるだけでは不十分で、`recognize / apply / prove` の能力も確認する。`apply` には定理を利用する権限があるが、証明を既知とみなす権限はない。

問題の必須条件:

1. 採点rubricに結び付く評価目標が1つ以上あり、すべてTに属する。
2. 標準解答の各実質的な手順に使用概念・能力の参照があり、すべてKに属する。
3. PやBを使っただけで、その概念の習得点を加算しない。
4. Gは問題文に実際に提示され、適用条件が明記されている。
5. 許可外の概念を要求する、条件不足、解が未定義、誤った解答の候補は出題しない。
6. 問題作成後に都合よくKを広げない。変更が必要なら新しいプレビューと確認を行う。

証明問題では「証明すべき命題そのもの」を既知の定理として使うことを禁止する。Tにその概念が含まれることは、結論を仮定してよいという意味ではない。各question planに `mustEstablish / mayAssume` を持たせ、証明の循環・解答の丸ごと提示を検証する。

この参照チェックは「LLMが隠れた概念を申告し忘れていない」ことまでは証明できない。そのため後述の独立検証と範囲外報告も必須とする。

### 4.2 フォルダーツリーと依存グラフを分ける理由

ツリーは「教材の場所・選択UI」であり、学習順序の真理ではない。Chapter 6だからChapter 1〜5全部が前提、あるいはChapter番号が小さいから既知、という推測はしない。

依存は基本的に概念・能力単位で定義する。Chapter単位の一括指定は著者の入力補助としてのみ受け付け、公開時に安定した概念IDへ展開し、展開結果と元の指定をプレビューに表示する。新しい教材の追加で前提が自動拡大する場合も、新releaseとして確認する。

例（実際のEngineering Mathの章構成を表すものではない）:

```text
教材ツリー: 科目 → Chapter X → 「線形方程式の解法」

評価目標: 線形方程式の解法を適用する
  ├─ 必須: 微分の積の公式を適用する
  └─ どちらか: 基本積分を適用する OR 問題文で指定した原始関数を利用する

定理の証明を問う目標
  └─ 証明に必要なLemma（applyだけの目標とは別の前提集合）
```

### 4.3 依存関係の型

- `allOf`: 全て必要な前提。
- `anyOf`: 代替の前提集合。各alternativeの中はAND、alternatives間はOR。
- `recommended`: 理解を助ける推奨知識。利用を自動許可しない。
- `related`: 関連概念。検索・説明用。利用を自動許可しない。
- 依存の入口はObjective。前提側は `conceptId + capability` とする。
- `apply` と `prove` の依存を分け、定理を使うたびに全証明の依存まで要求しない。
- 再帰展開する `allOf / anyOf` は概念・能力の組を頂点とするDAGとして検証する。循環、未解決ID、能力未定義は公開不可。
- `related / recommended` は循環してよいが、許可集合のclosureには入れない。
- 代替の選択は「未確認前提が少ない → 追加能力が少ない → 設定された優先度 → ID順」で決定し、選んだ枝をsnapshotに固定する。
- ORの探索数には上限を設ける。上限超過は `DEPENDENCY_TOO_COMPLEX` として著者に分割を求め、前提を切り捨てない。

### 4.4 提供する三つの出題方針

| UIの選択肢 | 前提の扱い | 初期値 |
| --- | --- | --- |
| 選択範囲と基礎のみ | PがTまたは承認済みBで満たされる目標だけ採用。範囲外前提が必要な目標は不適格として表示 | 選択可能 |
| 必要な前提を許可 | 必要な範囲外前提を一覧表示し、ユーザー確認後に利用可。得点対象はTだけ | **推奨デフォルト** |
| 補助情報つき | 事前に許した `provideable` な知識をGとして問題文に渡す。未知の高度な解法を勝手に導入しない | 選択可能 |

「必要な前提を許可」でも、未学習の前提を既習に書き換えない。`known / needs-review / unknown` は自己申告・履歴の表示情報、`acceptedForThisTest` は今回の利用許可として別に持つ。unknownが残る場合は「前提を練習する」「今回は利用を許す」「この目標を外す」を提示する。難易度や履歴から自動で許可しない。

「前提を練習する」は不足前提をT候補とする別のscope previewへのリンクであり、元のテストへ混入させない。初版では既習による自動skipをしない。

Gとして定理の結果を渡す場合、証明のためだけの依存は展開不要だが、記法・定義域・条件を理解し適用するための依存は必要である。`provideable` の宣言に `requiredToUseWhenGiven` を持たせ、この集合をclosureに含める。対象objectiveの答えそのものをGにしていないことも確認する。Bの前提closureがprofile外に出る場合も一覧に含め、同意範囲外を隠れて許可しない。

範囲の確認画面でTとP/Bを区別して表示し、まとめて確認できるようにする。設定済みの同じ基礎profile/revisionへの同意は再利用できるが、profileや依存集合が拡大したら差分を再表示する。

### 4.5 基礎プロファイル

「工学数学の基礎」という曖昧なプロンプトだけでは制御しない。次のような**候補**を著者が登録・確認できるようにする。

- 実数の四則演算、分数・指数・対数の基本法則。
- 関数・等号・変数・微分記号等の記法。
- 基本的な三角関数・双曲線関数と、その微分・積分。
- 必要に応じて置換積分、部分積分。ただし「基本だから常に許可」とはしない。

例として `∫ sin x dx = -cos x + C` と `∫ cosh x dx = sinh x + C` を別々に参照可能なIdentityとして定義する。定義域、定数、適用条件をMarkdownに含める。「初等解析全部」を1つの未定義IDに押し込まない。

基礎profileも版管理する。標準候補を用意する場合はライセンス上問題ない独自記述で作り、fixtureと実教材を混ぜない。初期実装でユーザーの `textbook/` にこれらを書き込まない。公開済みprofileがなければ選択欄を空状態とし、隠れたデフォルトを適用しない。

### 4.6 範囲計算の手順

```text
resolveScope(request, activeCatalog):
  validate subject, selectedNodeIds, exclusions, difficulty, mode
  load immutable catalog version
  expand selected nodes to descendant units and assessed objectives; deduplicate IDs
  T := selected, published, assessable objectives
  resolve capability-specific + objective-specific prerequisites and deterministic OR branches
  B := explicitly accepted profile versions and their validated closures
  classify missing requirements into:
      permitted prerequisites / eligible givens / blocking requirements
  filter incompatible objectives; show exclusions and reasons
  plan per-question targets and difficulty without introducing outside IDs
  compute canonical content hash of scope + versions + acceptance requirements
  persist preview; return human-readable summary and hash

createTest(previewId, expectedHash, acceptance, operationId):
  revalidate preview expiry and active catalog pointer in transaction
  require exact hash and acceptance for all displayed outside requirements
  freeze scope, plan and configuration; create test + generation job + receipt
```

プレビュー作成後に教材が更新された場合は `409 CATALOG_CHANGED`。意図を保存したまま再計算し、変更点を確認する。開始済みテストは古い公開版のまま継続し、ライブで新概念を追加しない。

## 5. 難易度・問題構成

### 5.1 5段階と別軸

以下はアプリ内の設計上の目安であり、教育学的に校正された共通尺度だと表示しない。

| レベル | 主な課題 | 評価対象概念数の目安 | ヒント |
| --- | --- | --- | --- |
| 1 基礎 | 定義の確認、例・非例、直接代入、条件の確認 | 1 | 必要なら手順を示す |
| 2 標準 | 定理・公式の直接適用、短い計算 | 1〜2 | 任意 |
| 3 応用 | 手法の選択、数段階の組合せ、表現の変換 | 2〜3 | 少なめ |
| 4 発展 | 複数概念の統合、条件分岐、短い証明・反例 | 2〜4 | 原則なし |
| 5 挑戦 | 構成・証明・一般化・非自明な統合 | 1〜5 | 原則なし |

概念数は上限目安。単一の深い概念でもLevel 5を作ってよい。`reasoningDepth / algebraLoad / abstraction / proofDemand / integrationCount` をそれぞれ記録し、長い計算だけで高難度にしない。

`requestedDifficulty` と検証後の `estimatedDifficulty` を分ける。差が大きい候補は再生成または不採用とし、勝手に難易度を下げて成功扱いにしない。

### 5.2 出題形式

初版で対応する形式:

- 概念説明・定理の適用条件の説明。
- 短答（数値、式、選択肢）。
- 手順つき計算。
- 証明の穴埋め・短い証明・反例。

答案はテキストとLaTeX。紙に解いて自己採点する導線も用意する。手書き画像の読取、図形描画の自動採点、任意コード実行、CAS一般同値判定は後続フェーズとする。

### 5.3 出題のバランス

- 問題数は初期値5、許容1〜20。選択概念数と問題数を混同しない。
- 初版のplannerは、選択されたObjectiveのカバレッジを優先し、同じ主目標の連続・同型問題の重複を避ける。
- カバレッジ不可能な場合は、開始前に「今回対象になる目標」と「今回出題されない目標」を表示する。全範囲の網羅を約束しない。
- 複合問題の主目標・副目標はいずれもTに含める。前提P/Bは別欄に置く。
- 全概念の組合せを列挙しない。共通の依存や教材の関連タグを使い、接続性がある少数の候補だけを組み合わせる。
- 問題数・seed・選択順を保存し、再読込で別問題に変えない。LLM自体の完全な再現性は保証せず、採用済み問題本文を保存する。
- 履歴に基づく復習配分は初版では任意の「苦手優先」に限定する。選択範囲外への適応的拡大は行わない。

### 5.4 不可能な指定への応答

空の章、未公開教材、前提不足、Level 5を構成できない小さな範囲等を区別して返す。対応は「目標を減らす」「前提を確認する」「難易度を変更する」「範囲を広げて再確認する」。自動でChapterを追加したり、問題数不足を隠したりしない。

## 6. 学習ユニットとPDF由来の教材作成

詳細仕様は [数学教材の形式とPDFからの作成設計](math-content-authoring-design.md) にまとめる。この節と同文書が教材作成の契約であり、以前の「1概念1Markdown推奨」「PDF抽出は対象外」という方針を置き換える。

### 6.1 推奨する編集単位

**1つの学習テーマを1学習ユニットにまとめる。** 定義・定理・Lemmaはユニット内の安定ID付き知識要素とし、以下を一緒に保存する。

- 中心の問い、核心、直感的な説明、使う場面。
- 必要な定義・定理・公式・記法、適用条件と例外。
- 解法の選択・手順・検算、最小の例、典型的な誤り。
- 能力別の前提、評価目標、適した問題類型、扱わない範囲。
- 出典、AIが補足した箇所、証明の網羅度、未解決事項。

ファイルは人が読めるまとまりにし、DBへはConcept / Objective / capability / evidenceを取り出して格納する。定理の一覧だけを出題プロンプトにする設計にはしない。

### 6.2 PDF・編集原本・公開版

PDFは出典、確認済みMarkdown/YAMLは教材の編集原本、Firestore catalogは出題に使う公開版とする。元PDFは編集しない。初版の教材作成はローカルCLI/AI作業で行い、Webから本文を二重編集しない。

AIには最初に主張・条件・式・例を出典に忠実に抽出させ、その後に核心と学習目標へ再構成させる。短縮時にも仮定・定義域・例外を失わない。原文にある内容とAIによる補足を区別し、曖昧な式や未解決参照は推測で埋めない。

外部AIからのpackage取込と、組込みのPDF/画像抽出adapterを同じcontractへ接続する。抽出結果はdraft→照合→review→acceptを経て編集原本へ取り込む。公開は第8節の別操作で行う。数学アプリへ大容量PDF uploadやクラウドPDF保管を作ることは初版の必須条件ではない。

### 6.3 階層を先に固定しない

`textbook` 直下は科目とする。科目内は `curriculum.yaml` の論理ツリーを出題範囲の正とし、node→unit→objectiveを解決する。実際のPart/Chapterフォルダーは必須にしない。PDFの目次や物理フォルダーからツリー案を作り、確認後に採用できる。

Markdownを `units/` に置く方式を推奨するが、後から章別フォルダーへ移してもよい。安定IDとmanifestが対応を管理し、pathを概念のIDにしない。今回、実教材のmetadata・フォルダー・本文を生成しない。

### 6.4 必須contract

- `math.catalog.yaml`: 科目とpath、schemaVersion。
- `subject.yaml`: 科目情報、source、profile。
- `curriculum.yaml`: 任意深さのnodeとunit参照。
- `sources.yaml`: 元PDFの版・hash・ページ対応。
- `unit-<id>.md`: `format: math-learning-unit`、blocks、knowledgeItems、knowledgeRefs、objectives、problemFamiliesを持つ学習ユニット。
- `provenance/<unit-id>.yaml`: block/claimごとの出典・補足・検証情報。
- review receipt: 承認した内容とprovenanceのhashに結び付く記録。

定義のcanonical所有者はconceptごとに1ユニット。他のユニットは参照する。objectiveはユニットに属し、`assessedCapabilities` と `additionalPrerequisites` を持つ。objective固有の前提をconcept全体に強制しない。

公開時にschema、ID/anchor、DAG、未解決参照、出典、証明範囲、review hash、サイズ、数式構文を検証する。PDF bytes・ページ画像・未確認draftは公開データに含めない。科目だけでunitが0件でも公開でき、UIは教材未登録を表示する。

## 7. Firestore設計

### 7.1 保存方法の比較と選択

| 案 | 評価 |
| --- | --- |
| PDF/教材全文を毎回LLMに渡す | 範囲・出典・版を制御しにくく、大きくなるため初版では不採用 |
| 1科目を1巨大ドキュメントに保存 | 更新とサイズ制限、部分取得の面で不採用 |
| embedding検索だけで知識を選ぶ | 前提の漏れ・範囲外混入を防ぐ保証がないため権限判定には不採用 |
| **学習ユニットから概念・目標を正規化 + 出典 + 依存グラフ + 公開版** | 採用。編集時の文脈を保ち、必要な情報だけをLLMへ送る |

embeddingは将来の検索補助として追加できる。追加しても検索候補をKでフィルターし、範囲を拡張する権限を与えない。

### 7.2 コレクション案（採用する初期構成）

```text
math_settings/main
  activeCatalogId, schemaVersion

math_catalogs/{catalogId}
  state: staging | published | retired
  manifestHash, schemaVersion, counts, createdAt, publishedAt
  subjects/{subjectId}
    title, rootNodeId, order, foundationProfileIds
  nodes/{nodeId}
    subjectId, parentId, ancestorIds[], kind, title, order, unitIds[]
  concepts/{conceptId}
    subjectId, ownerUnitId, revisionId, title, kind, capabilitySummary
  units/{unitId}
    subjectId, revisionId, title, objectiveIds[], conceptIds[]
  objectives/{objectiveId}
    unitId, assessedCapabilities[], additionalPrerequisites,
    assessmentBlockRefs[], difficultyRange, proofRequirement, proofSupport, readiness
  profiles/{profileId}
    title, revision, acceptedCapabilities[], sourceDescription
  graph_chunks/{chunkId}
    bounded normalized capability dependency records

math_concept_revisions/{revisionId}
  conceptId, schemaVersion, normalizedHash, contentLanguage,
  source, normalized sections, capabilities, related,
  sourceArtifactHash, blockRefs[], parserVersion

math_unit_revisions/{revisionId}
  unitId, sourceArtifactHash, blockIndex, overview, objectiveIds[],
  conceptIds[], problemFamilies, proofCoverage, provenanceHash

math_source_documents/{sourceRevisionId}
  sourceId, fileHash, edition, title, pageCount, pageMapHash

math_provenance_revisions/{hash}
  bounded evidence records, review metadata; larger records use chunks

math_scope_previews/{previewId}
  catalogId, request, scopeHash, requiredAcceptance,
  scope chunks references, plan, expiresAt

math_tests/{testId}
  schemaVersion, catalogId, scopeHash, config, state, revision,
  generationJobId, currentSittingId, counters, createdAt, updatedAt
  scope_chunks/{chunkId}
    target objective refs, prerequisite refs, baseline refs, acceptance records
  questions/{questionId}
    ordinal, public prompt, target refs, difficulty, contentHash, validationStatus
  solutions/{questionId}
    answer, steps, rubric, concept usage refs, validation evidence
  attempts/{attemptId}
    questionId, sittingId, submittedAnswer, assessmentState,
    feedback, gradeVersion, score, assistanceUsed, submittedAt
  drafts/{questionId}
    answerText, revision, savedAt
  operations/{operationId}
    requestHash, resultRefs, committedAt
  sittings/{sittingId}
    state, startedAt, endedAt, reviewCursor, reviewedAttemptIds

math_jobs/{jobId}
  type: generate | grade
  state, testId, questionId?, attemptId?, cursor, sequence,
  frozenConfig, lease, attempts, nextWakeAt, lastError, usageTotals
  checkpoints/{checkpointId}
    candidate, validation, output hash, accepted question ref

math_learning_states/{conceptId}
  selfDeclaredReadiness, perObjectiveEvidence, updatedAt
math_foundation_acceptances/{profileId}
  profileRevision, acceptedCapabilitiesHash, acceptedAt
math_operation_receipts/{operationId}
  operationType, requestHash, resultRefs, committedAt
math_problem_reports/{reportId}
  testId, questionId, reason, details, state, createdAt
```

`math_learning_states` は現アプリ同様の共有学習者に対する情報。複数ユーザー別の成績を実装したものとして表示しない。将来のマルチユーザー化は語学を含む横断設計として扱う。

test作成、基礎profile承認、readiness、報告等、testIdがまだないかtestに属さない変更は `math_operation_receipts` で冪等化する。test内操作はそのtestの `operations` を使う。receiptにはレスポンス全文を複製せず、固定された結果IDと最低限の再送応答を保存する。初版はreceiptを自動削除せず、期限後の重複生成を起こさない。

### 7.3 ID・版・削除

- Subject / node / unit / concept / objectiveの論理IDは著者が管理する安定ID。抽出時にはツールが既存IDとの対応を提案し、新規IDを発行する。`[a-z0-9][a-z0-9_-]{0,95}` 等の限定文字集合と長さをschemaで固定する。
- `revisionId` は概念ID・正規化内容・schemaVersion・parserVersionを含むSHA-256。フルhashを利用し、パス変更だけなら概念の意味revisionを変えない。
- 原文ファイルのhashと意味内容のhashは分ける。改行LF正規化の規則を明文化し、数式・記号の意味が変わる空白は安易に消さない。
- `catalogId` は公開manifest全体のhash。ツリー、unit/concept revision、objective、出典path、provenance/review hash、依存、profileを含み、フォルダー移動も新catalogになる。
- 新公開版から消えた概念は、新テストの候補から外れる。旧revisionと旧catalogは既存テストの再開・review用に残す。
- 論理IDの再利用は禁止。意味が別なら新ID。誤記修正は同IDの新revision。
- 初版では過去の教材revision・テストの自動GCを実装しない。stagingと期限切れpreviewのみreconcileで期限付き削除を行う。削除時はサブコレクションも対象にする。
- 公開済み本文・依存・問題・模範解答はimmutable。問題の修正は新question versionまたは新テストとし、過去答案を別問題に結び直さない。

### 7.4 大きさとクエリ

Firestoreの1ドキュメント上限は1 MiB。全文、問題群、答案履歴を1文書に蓄積しない。[Firestore公式の上限](https://firebase.google.com/docs/firestore/quotas)

アプリ独自の初期上限（設定定数に集約し、切り捨て禁止）:

- 1概念の正規化本文: UTF-8で64 KiBまで。
- 1 source Markdown: 512 KiBまで。複数概念に分けても原文の保存先を適切に分離し、revisionに不要な全文複製をしない。
- 1 DB document: シリアライズ推定700 KiB以下。余裕を確保し、書込直前にも検査する。
- 1 scope: 評価対象Objective 200、前提・基礎の能力頂点合計1,000まで。超える場合は範囲分割を案内する。
- 1テスト: 20問まで、1答案32 KiB、1公開問題32 KiB、1解答・採点rubric128 KiBまで。
- グラフ・scope: 200 KiB以下のchunkに分け、chunk数・hashをmanifestで検証する。

編集原本は `math_source_revisions/{sourceArtifactHash}` にMD/YAMLを1回だけ保存し、unit/concept revisionからblock参照で結ぶ。元PDFの登録情報・ページ対応は別のsource document。PDF bytes・ページ画像・ローカルの絶対パスをFirestoreに保存しない。詳しい変換契約は [教材作成設計の第9節](math-content-authoring-design.md#9-dbとllm-contextへのコンパイル) を参照する。

検索に使わない本文・LaTeX・答案・rubric・大きい配列はindex除外を設定する。新規の `backend/firestore.math.indexes.json` と冪等な設定スクリプトを用意し、既存indexを削除・置換しない。必要な複合index:

- catalog内units: `subjectId, title`。node→unitIds→objectiveIdsを基本経路とし、概念に単一nodeIdを強制しない。
- jobs: `state, nextWakeAt`。
- tests: `config.subjectId, updatedAt desc`、必要なら `state, updatedAt desc`。
- reports: `state, createdAt desc`。

subcollectionの一覧はcursor pagination、初期limit50・最大100。全subjectを走査して毎回scopeを構築しない。catalogId単位の小さいmetadata/graphキャッシュを利用できるが、状態の正はDBとする。

## 8. 教材同期・公開フロー

### 8.1 将来追加するCLI

以下は**未実装コマンド**。package scriptsの追加とともに利用可能にする。

```bash
# ファイル検証のみ。クラウド認証・LLM不要
npm run math:validate --prefix backend -- --root ../textbook

# メタデータ候補を表示。既定ではファイルを書かない
npm run math:manifest --prefix backend -- --root ../textbook

# 同期対象との差分を出す。emulator接続を必須にする例
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIRESTORE_DATABASE_ID='(default)' \
  npm run math:sync --prefix backend -- --root ../textbook --dry-run

# 同一入力をstagingへ送り、検証後に公開（emulator）
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIRESTORE_DATABASE_ID='(default)' \
  npm run math:sync --prefix backend -- --root ../textbook --publish
```

`--root` はbackendのpackage実行ディレクトリ基準で解決する仕様とし、CLIは必ず解決済みrootとproject/database/emulatorを最初に表示する。秘密値は出さない。開発用projectの既定値も `demo-vocab-math` 等へ固定し、本番projectを推測しない。

本番同期は `--production --project vocab-trainer-490014 --database vocab-database` を全て要求し、dry-runのmanifest hash・expectedActiveCatalogIdを指定して公開する。設定不一致、emulator環境との混在は停止する。実装タスク中に本番の教材データを補完する権限とは解釈しない。

### 8.2 原子的な公開

1. ローカルを完全検証し、正規化manifest・revision・削除候補を計算する。
2. 現在のactiveCatalogIdを読み、差分と警告を表示する。
3. content-addressed revisionとstaging catalogを小さなbatchで保存する。再実行は同じhashを再利用する。
4. 保存した文書数・chunk hash・参照先をread-backして検証し、stagingの完成マーカーを作る。
5. 短いFirestore transactionで、expectedActiveCatalogIdと完成マーカーを確認し、catalogをpublishedにしてactive pointerを交換する。
6. 競合は409相当で停止。自動で他人の公開を上書きしない。

大規模な全件writeを1transactionに入れない。外部APIやLLMをtransaction内で呼ばない。Firestore transactionは競合により再実行され得るため、callback中に副作用を置かない。[公式のtransaction仕様](https://firebase.google.com/docs/firestore/manage-data/transactions)

途中で同期が失敗してもactive pointerは旧版のまま。既存テストにも影響しない。ロールバックは保持済みcatalogへのpointer変更で行い、過去テストの参照先を変えない。previewは再確認させる。

### 8.3 診断例

```text
E_DUPLICATE_CONCEPT_ID: 同じIDが2ファイルにある
E_UNKNOWN_PREREQUISITE: concept-A.apply -> concept-missing.apply
E_DEPENDENCY_CYCLE: A.apply -> B.apply -> A.apply
E_MISSING_NODE_ID: curriculumのノードIDが未登録
E_INVALID_CONDITION_SECTION: 定理の適用条件が未定義
W_SOURCE_PDF_NOT_PUBLISHED: PDFは抽出の入力。catalog同期ではbytesをアップロードしない
W_EMPTY_SUBJECT: 公開できるが出題対象は0件
W_REMOVED_OBJECTIVE: 新テストから外れる。過去履歴は保持
```

## 9. LLMへ渡す情報と生成・検証

### 9.1 取得の単位

LLMには「科目全体」ではなく「1問の設計に必要なcontext pack」を渡す。

- サーバーが選んだtarget objective、assessment、関連する問題類型と、そのConcept本文・Conditions。
- その問題で必要な前提のclosure。利用方法・条件は含めるが、不要な証明や長い例は除ける。
- 使用候補の基礎Identity / Notation。巨大な基礎profile全体を毎回渡さない。
- 対象目標に関するunitの誤用例・検算基準・limits。本文の全概念を無条件に渡さない。
- 必要なら問題文で与えるGと、その正確な記述。
- 許可ID一覧、禁止される範囲拡張、難易度軸、問題形式、回答言語。

送っていない概念を使いたくなった場合、モデルは `NEEDS_CONTEXT` と要求IDを返す。サーバーはK内のIDだけ追加取得できる。K外なら不採用にする。必要条件をtoken上限のため黙って切り落とさない。

### 9.2 入力contractの例

```json
{
  "schemaVersion": 1,
  "catalogId": "catalog-hash",
  "scopeHash": "scope-hash",
  "questionPlanId": "plan-q1",
  "responseLanguage": "ja",
  "targetObjectives": ["objective-linear-method-apply"],
  "difficulty": {"level": 3, "proofDemand": 0, "maxTargetConcepts": 3},
  "knowledgePolicy": {
    "allowedCapabilities": ["concept-linear-method:apply", "concept-product-rule:apply"],
    "providedCapabilities": [],
    "outsideKnowledge": "reject"
  },
  "concepts": [
    {
      "id": "concept-linear-method",
      "revisionId": "content-hash",
      "role": "target",
      "statement": "...",
      "conditions": "...",
      "sourceAnchor": "statement"
    }
  ]
}
```

このJSONは構造説明用であり、本文を省略したまま実際に生成しない。システム指示、教材、ユーザー答案を別の境界で扱い、教材中の「他の指示を無視」等はデータとして処理する。

問題言語は `en / ja / ko` から選択し、既定はUI言語。原文の数学記号は維持する。将来の `zh` 問題文対応は可能だが、UI翻訳追加と混同しない。

### 9.3 出力contract

生成レスポンスはstrictなJSON schemaで受け、サーバーで再検証する。概略:

```ts
interface GeneratedMathQuestion {
  status: 'candidate';
  promptMarkdown: string;
  answerFormat: 'numeric' | 'expression' | 'text' | 'proof' | 'choice';
  targetObjectiveIds: string[];
  prerequisitesUsed: CapabilityRef[];
  foundationUsed: CapabilityRef[];
  givens: { capability: CapabilityRef; promptBlockId: string }[];
  solution: {
    finalAnswer: string;
    steps: { id: string; text: string; uses: CapabilityRef[]; sourceRefs: SourceRef[] }[];
  };
  rubric: {
    criterionId: string; objectiveId: string; points: number;
    description: string; requiredStepIds: string[];
  }[];
  estimatedDifficulty: DifficultyProfile;
  expectedMinutes: number;
}
```

`NEEDS_CONTEXT` / `IMPOSSIBLE_WITH_SCOPE` は別のdiscriminated schemaで返す。未知のID、source anchorの捏造、点数合計の不整合、未対応LaTeX、巨大出力は不採用。

### 9.4 生成の段階

1. **サーバーplanner**: Tから主目標、副目標、形式、難易度、前提の枝を決める。
2. **generator**: 1問ずつ、問題・模範解答・rubric・使用概念を作る。
3. **構造検証**: ID集合、条件、長さ、rubric参照、LaTeX、重複を検査。
4. **独立solver**: generatorの模範解答を渡す前に、問題と許可contextから解き、必要な概念を列挙する。
5. **比較検証**: 解の整合、適用条件、定義域、特異点、解の存在・一意性、範囲逸脱、難易度を確認する。
6. **採用**: 全ゲートを通過した候補のみpublic questionとして保存する。

validatorは同じモデルでも独立呼出しにする。異なるモデルを選べる設定も用意するが、同種の誤りが両方に生じる可能性は残る。UIでは「AI検証済み」と表示し、「正しさを保証済み」と表示しない。

数値・有理数・有限選択肢は決定的チェックを追加する。任意のLLM生成コード、Python、JavaScriptをサーバーで実行しない。CASは初版の必須依存にしない。将来使う場合も式parser、定義域、資源制限、サンドボックスが必要。

### 9.5 再試行とコスト

- 1問の候補生成は最大3候補。各候補の検証も回数を固定し、LLM同士の無限修正ループを作らない。
- transport retryと候補修正の回数を別管理する。SDK側の暗黙retryを重ねず、既存workerの方法に合わせる。
- context packは初期上限20,000入力token相当、1出力は8,000token相当を目安に設定化。実際のモデル上限より必ず小さくする。token計測・出力上限の設定は既存 `callLLM` に後方互換のオプションを追加する。
- 上限に収まらない場合は問題設計を単純化するか、範囲を減らすよう返す。前提を省略して出題しない。
- ジョブ単位の呼出し数・累計token上限を永続保存し、lease再取得でも予算が復活しないようにする。
- 費用表示は既存のモデル単価設定から算出し、固定金額をコードや説明に埋め込まない。
- promptVersion / schemaVersion / model / contextHash / usage / 検証結果を保存する。API鍵、全文答案、教材本文は通常ログに出さない。

### 9.6 問題不足・問題報告

指定N問が揃うまでテストは `generating`。一部失敗した場合は `generation_failed` とし、採用済み件数・失敗理由を表示する。`retry-generation` または明示的な `accept-partial` でのみ進める。0問では部分開始不可。

範囲外・誤答・条件不足の報告ボタンを設ける。報告だけでは過去点数を自動削除しない。ユーザーが「この問題を無効にする」を確定すると、操作履歴を残して有効な得点分母から除き、進捗evidenceも無効化する。原答案は残す。再計算はversion付きで実行し、完了テストを再開しない。

## 10. 非同期ジョブ・Cloud Run

### 10.1 初版から永続化する理由

複数問の生成と検証は長くなる。HTTPレスポンス後の単なるPromiseやプロセスメモリに処理を残さない。開始APIは保存後202を返し、Cloud Tasks workerがチェックポイントごとに実行する。

Cloud Tasksでは重複実行が起こり得るため、task名の一意性だけに依存しない。DB上のleaseと冪等commitを必須にする。[Cloud Tasksの重複実行に関する公式説明](https://docs.cloud.google.com/tasks/docs/common-pitfalls)

### 10.2 状態機械

```text
job: queued → running → queued（次のcheckpoint）→ succeeded
                  ├→ retry_wait → queued
                  ├→ failed
                  └→ cancelled

test: generating → ready → in_progress → completed
           ├→ generation_failed → generating
           │                   └→ ready（明示的な部分採用）
           └→ cancelled

attempt: submitted → grading → graded
                         ├→ needs_review
                         └→ grading_failed → grading（同じattemptを再処理）
```

1 taskは1つの生成・検証段階を処理し、DBチェックポイントを保存して次をenqueueする。1回で20問分を処理しない。公開結果は全段階完了後だけ見せる。

- lease token / attemptId / generation / sequenceを比較してcommitする。
- 旧workerがlease切れ後に戻っても新しい結果を上書きできない。
- DBへのjob保存とenqueueの間の失敗はreconcilerで回復する。
- 外部LLMへの呼出しとDB commitを同時に原子化できないので、クラッシュ時の二重LLM費用は完全には排除できない。結果と得点の二重保存は排除する。
- cancel後に届く結果はcheckpointへ採用しない。保持済み問題は履歴として扱い、課金が既に発生した呼出しの返金等は約束しない。

### 10.3 既存基盤との接続

数学専用 `math-jobs.ts / math-job-store.ts / math-task-dispatch.ts` を追加する。汎用化のために記事処理全体を大幅rewriteしない。OIDCやleaseの純粋helperは、回帰テストを追加したうえで抽出できる。

新しい内部URLは `/internal/math/run` と `/internal/math/reconcile`。`index.ts` のグローバルauth除外にこのPOST完全一致だけを追加し、専用フックがOIDC audience / service account / issuer / verified emailを確認する。通常のログインCookieだけでworkerを実行させない。emulatorでもHTTP認証を無効化せず、ローカルrunnerから関数を直接呼ぶ。

環境変数は `MATH_TASK_PROJECT / MATH_TASK_REGION / MATH_TASK_QUEUE / MATH_WORKER_URL / MATH_TASK_ACCOUNT`。初期queue concurrencyは1。既存import queueを取り合わない独立queueとする。

- `backend/scripts/setup-math-jobs.ts`: Cloud Tasks queue、専用invoker account、必要なIAM、1分間隔のreconcile schedulerを作成・確認する。
- `backend/scripts/check-math-jobs.mjs`: 通常deployで整合性を検証する。
- `backend/src/math-local-worker.ts`: emulator専用、同じjob処理関数を呼ぶ。
- `docker-compose.yml` と `local.sh / local.ps1`: math-workerの起動・停止・hot reload時の扱いをimport-workerに揃える。
- worker段階の時間枠は最大540秒、task deadline600秒、lease660秒を初期値として明示。実際のLLM呼出しは全段階の残り予算を共有する。
- 再試行可能な429/5xx等は指数backoff、設定不足・schema不正・範囲違反は回数を絞った修正または失敗。

数学の基盤未設定でも語学を停止させない。数学の閲覧と空状態は動き、生成APIは `503 MATH_WORKER_UNAVAILABLE`。機能を有効化して本番公開する段階ではcheckスクリプトを必須にする。

## 11. 解答・採点・学習履歴

### 11.1 解く流れ

1. 問題と必要な条件を表示する。初期画面では模範解答、採点rubric、詳細な使用手法を送らない。
2. 答案を入力、または「紙で解いた」を選ぶ。
3. 入力答案を保存する。下書きはdebounceでFirestoreへ送り、「保存済み」「未保存」を明示する。
4. 提出するとattemptを先に永続化し、採点jobを作る。通信が切れても同じoperationIdで再試行する。
5. 結果は条件・方針・計算・結論のrubric別に表示する。必要な範囲で模範解答と出典を開く。
6. 次の問題へ進む。採点待ちでも次を解けるが、結果画面には未確定件数を表示する。

### 11.2 採点規則

- 生成時に固定したrubricを使い、答案を見て採点基準を書き換えない。
- 数値・単位・許容誤差・定義域をschemaで指定できる。文字列一致だけで数式を誤答にしない。
- 式の一般同値や自由証明は、初版ではLLMによる暫定評価と明示する。判定不能は `needs_review` として自己採点へ進める。
- 各criterionは `awardedPoints / maxPoints / feedback / evidenceRanges` を持ち、答案にない誤りを引用しない。
- 合法な別解は正解として扱う。モデル解との手順一致を要求しない。
- 学習者が許可範囲外の高度な別解を自発的に用いた場合、数学的正しさと「指定された学習目標の達成証拠」を分ける。自動で誤答にせず `outsideMethodUsed` として表示し、必要なら対象手法による解き直しを案内する。
- `correctnessScore` と `objectiveEvidence` を別に保持する。評価対象外の手法による満点答案から、対象手法を習得済みと推定しない。
- ヒント使用・解答閲覧を記録し、無支援正解と区別する。
- 自己採点・AI採点・ユーザー修正を `gradeSource` とrevision付きで区別する。修正は元の判定を履歴に残す。

### 11.3 成績と前提のready状態

各objectiveに、出題回数、無支援正解数、直近評価、難易度、採点source、不確実状態を保存する。単純な平均点を「習得確率」と呼ばない。

複合問題はcriterion単位で対象objectiveへ証拠を配分する。全conceptへ一律に正解数を加算しない。P/Bとして使った概念は参考情報に留め、習得認定をしない。教材の意味revisionが変わったら、旧証拠を保持しつつ「旧版の結果」と表示する。

`known / needs-review / unknown` の自己申告と成績の集計を分ける。成績から前提の利用許可を自動で増やさない。

### 11.4 中断・再開・review

- 数学テストはtestIdで識別し、同じ科目に複数の過去テストを保存できる。
- sitting終了は回答済み範囲を固定したreviewを作る。review cursorもFirestoreに保存する。
- 未回答が残るテストは次のsittingで再開できる。初版ではWrongの自動再投入をしない。
- 全問に提出または明示的skipが入ったらcompletedにする。採点jobの結果は後から反映できるが、テストをin_progressへ戻さない。
- 復習用の再出題は「誤答から新テスト」を明示的に作成し、元テストのscopeを初期値に新previewを作る。旧テストを開き直さない。
- 教材更新・基礎profile変更・進捗変更は開始済みテストに影響しない。
- 404（不存在）、410（明示廃止）、409（競合）、5xx/通信失敗を区別する。通信失敗を新規テスト作成へ勝手に置き換えない。

### 11.5 保存競合とoutbox

数学に `mathDraft / mathSubmit / mathSitting / mathReview / mathGradeOverride` 等の型付きoperationを追加する。既存 `answerOutbox` の直列順序と401停止・再認証再開を再利用する。数学のLLM採点自体をキュー内で待たず、永続attempt作成のackで次へ進める。

各変更は `operationId + requestHash + expectedRevision` を持つ。同じID・同じpayloadは既存結果、同じID・違うpayloadは409。DB transactionでreceipt、attempt、test revision、必要なjobを同時更新する。

前のqueued operationの結果revisionを次のoperationに反映する。enqueue時の同じrevisionを全操作に焼き付けない。別タブとの409時は数学操作を停止して再読込・競合解決を表示し、答案を失敗扱いで黙って捨てない。既存outboxは一部の非retryableをdropするため、数学用の保持・解決状態を追加し回帰確認する。

revisionの補完はそのoperationの最初の送信前だけに行い、送信開始後のpayload/hashは凍結する。応答消失後の再送でexpectedRevisionを書き換えない。409をユーザーが解決して別内容を送る場合は新しいoperationIdを発行する。receiptの有無をrevision比較より先に確認し、成功済み再送を古いrevisionとして拒否しない。

下書きは `questionId + expectedDraftRevision` でCAS。未送信tailだけをcoalesceできるが、提出は直前の下書き保存より後に置く。Webの閉じる警告とiOSの同期表示・capture navigationにも未保存状態を反映する。再読込で失われ得る未送信メモリを「保存済み」と表示しない。

## 12. API契約

全て `/api/math` 配下。既存認証を適用し、数学をlanguage引数に入れない。レスポンスのDTOはDB文書から明示的に組み立て、模範解答等の漏出を防ぐ。

| Method / path | 入力の要点 | 応答・意味 |
| --- | --- | --- |
| GET `/catalog` | なし | activeCatalogId、科目一覧、機能利用可否。未公開は200で空 |
| GET `/catalogs/:id/nodes` | subjectId、parentId、cursor | 任意深さのノード一覧、件数、教材状態 |
| GET `/catalogs/:id/units/:unitId` | なし | ユニット本文、学習目標、例外、出典、公開状態 |
| GET `/catalogs/:id/concepts/:conceptId` | なし | Concept本文・条件・依存・出典。教材閲覧用 |
| GET `/foundation-profiles` | catalogId | profileと差分・承認状態 |
| PUT `/foundation-acceptances/:profileId` | revision、hash、accepted、operationId | 版を固定した承認。既存テストは不変 |
| PUT `/learning-states/:conceptId` | readiness、expectedRevision、operationId | 自己申告のみ。得点を捏造しない |
| POST `/scope-previews` | subjectId、selectedNodeIds、excludedConceptIds、objectiveCapabilities、mode、profileIds、difficulty、questionCount、responseLanguage | previewId、scopeHash、評価対象と前提、blocking、coverage、expiresAt |
| POST `/tests` | previewId、scopeHash、acceptance、operationId | 202 testId/jobId。再送は同じ結果 |
| GET `/tests` | subjectId、state、cursor | テスト一覧・進捗 |
| GET `/tests/:id` | なし | 保存済み状態、revision、scope summary、public questions。解答は含めない |
| GET `/tests/:id/scope` | cursor | 固定された対象・前提・基礎・出典 |
| GET `/tests/:id/questions/:questionId` | なし | 問題本文と条件、答案状態。positionでなくID取得 |
| POST `/tests/:id/start` | expectedRevision、operationId | readyから最初のsitting開始 |
| POST `/tests/:id/retry-generation` | expectedRevision、operationId | 未採用slotだけを再生成 |
| POST `/tests/:id/accept-partial` | expectedRevision、acceptedQuestionIds、operationId | 採用済みの問題だけでreadyへ。件数を再計算 |
| POST `/tests/:id/cancel` | expectedRevision、operationId | 生成中止。開始済みは専用の終了操作へ誘導 |
| PUT `/tests/:id/drafts/:questionId` | text、expectedDraftRevision、operationId | 下書き保存 |
| POST `/tests/:id/attempts` | questionId、sittingId、answerTextまたはpaper、expectedRevision、operationId | 202 attemptId/jobId（AI採点）、紙の場合は自己採点待ち |
| POST `/tests/:id/skip` | questionId、reason、expectedRevision、operationId | 明示skip。得点0、復習対象として区別 |
| POST `/tests/:id/reveal` | questionId、expectedRevision、operationId | 閲覧を記録後、solution DTOを返す。提出前は支援使用扱い |
| GET `/tests/:id/attempts/:attemptId` | なし | 採点状態、確定後feedback |
| POST `/tests/:id/attempts/:attemptId/retry-grade` | expectedGradeVersion、operationId | 同じ答案を再採点。新attemptを作らない |
| PUT `/tests/:id/attempts/:attemptId/assessment` | criterionScores、reason、expectedGradeVersion、operationId | 自己採点・ユーザー修正 |
| POST `/tests/:id/end-sitting` | expectedRevision、operationId | sitting終了、review境界固定 |
| POST `/tests/:id/review` | action: start/next/finish、reviewRevision、operationId | review順序と位置を保存 |
| POST `/tests/:id/resume` | expectedRevision、operationId | 未完了testを新sittingで再開 |
| POST `/tests/:id/questions/:questionId/invalidate` | reason、expectedRevision、operationId | 得点・evidenceから除外、履歴保持 |
| GET `/jobs/:jobId` | なし | 進捗・再試行時刻・安全なエラー情報 |
| POST `/problem-reports` | testId、questionId、reason、details、operationId | 報告を保存 |

採点後のsolutionはreveal APIでも取得可能。既に許可済みの閲覧は冪等に返す。通常のGETで勝手に閲覧状態を書き換えない。

公開同期は初版ではCLIのみで、ブラウザーに汎用「任意Firestore write API」を設けない。

### 12.1 エラー形式と上限

```json
{
  "error": {
    "code": "MATH_SCOPE_BLOCKED",
    "messageKey": "mathScopeBlocked",
    "retryable": false,
    "details": {"blockingObjectiveIds": [], "missingCapabilityRefs": []}
  }
}
```

- 400: schema不正、ID形式、重複、未対応値。
- 404: 存在しないcatalog/concept/test。
- 409: revision競合、preview失効・catalog変更、operationId衝突、不正な状態遷移。
- 413: 本文・答案・scope上限。
- 422: 空の対象、前提不足、希望難易度で構成不可能。
- 429: 生成ジョブ/費用予算の上限。
- 503: worker・モデル設定が利用不可。

params/body/queryにFastify schemaを付け、`additionalProperties: false`、配列長、文字列長を制限する。LLM出力にもruntime validatorを使い、TypeScriptの型assertionだけで通さない。

## 13. フロントエンド設計

### 13.1 入口とルーティング

- `LanguageSelectPage` は役割を `StudyCategorySelectPage` に整理してよいが、既存import・system画面を保つ。
- 語学カードと同じ階層に「数学」。表示文字列は翻訳キー化する。
- `/math` は科目一覧、`/math/subjects/:subjectId` は教材ツリーと範囲設定、`/math/tests/:testId` は出題・結果・reviewとする。
- `/math/*` を `/:language/*` と独立登録する。未知の数学URLは数学のnot-foundを表示する。
- `App.tsx` のresumeEpoch対象に数学テストルートを加える。単に既存quizの正規表現を期待しない。
- 数学コンポーネントはtestId/subjectIdでkeyを設定し、別テストの答案・キャッシュを持ち越さない。

### 13.2 範囲設定画面

左: 教材ツリー、右: 出題設定、下: 範囲確認という構成を基本にし、モバイルでは縦に並べる。

- 任意深さの展開・折り畳み、親チェックで子孫選択、部分選択表示。
- ノード毎にユニット数・概念数・評価可能目標数・空状態を表示する。
- 同じ概念を複数選択経路から選んでも重複しない。
- タイトル検索でノード・概念へ移動できる。検索結果を選んでも範囲を勝手に拡張しない。
- 難易度、問題数、問題形式、出題方針、基礎profile、問題言語を選択。
- 「プレビュー」でT/P/B/G候補、出題カバレッジ、欠けた前提、予想生成量を表示する。
- 「評価対象」の見出しと「使用してよい知識」を分離し、前提一覧には依存経路を表示する。
- ノードの表示順を学習依存だと誤認させる番号や自動選択は加えない。

### 13.3 問題画面

- 問題番号、難易度、残り件数、保存状態。
- 数式表示、テキスト/LaTeX入力、プレビュー、紙で解く、ヒント、提出、skip。
- 解法を漏らしやすい「使用定理一覧」は通常は提出後に表示する。問題文として必須のGや条件は最初から見せる。
- 全体の許可知識は「出題条件」から閲覧可能だが、教材本文の閲覧・ヒント利用はassistanceとして記録できるようにする。
- 採点待ち、採点失敗、判定保留、自己採点を別の状態として表示。
- 再接続・別端末再開時にはサーバーのsaved draft / attemptを取得し、未保存入力との競合を処理する。

### 13.4 結果画面

- 確定点、未確定件数、無効問題、ヒント利用、自己採点の区別。
- Objective別の評価根拠と、誤りのあるstep。
- 使った対象概念・前提・基礎の区別、catalog revisionと教材の出典リンク。
- 問題報告、自己採点修正、復習、新テスト作成。
- 学習者に意味のないjob ID、Firestoreパス、hashは通常UIに出さない。障害詳細にrequest ID程度を置く。

### 13.5 数式・Markdown renderer

`react-markdown + remark-math + rehype-katex + katex` を候補とし、導入時にReact 19/Viteと互換性を確認してlockfileへ固定する。未導入のAPIを記憶だけで実装しない。

- raw HTMLを有効にしない。任意iframe、script、外部画像の自動読込を許可しない。
- KaTeXは `trust: false`、`maxExpand` と `maxSize` の有限上限を設定する。macro状態を問題間で共有しない。[KaTeX公式オプション](https://katex.org/docs/options)
- 問題・模範解答・教材・ユーザー答案を同じrendererで処理する。
- 長い式を横スクロール可能にし、スマートフォンでレイアウトを破壊しない。
- 数式エラーは該当式だけfallback表示し、ページ全体を落とさない。公開前検証でも検出する。
- LaTeX文字列をそのまま `dangerouslySetInnerHTML` に渡さない。
- KaTeXのCSS/fontsをローカルbundleに含め、iOSでも表示する。
- キーボード操作、フォーカス順、treeのaria属性、MathML出力を確認する。

## 14. 変更予定ファイルと責務

以下は追加予定であり、現時点で存在するという意味ではない。実装時にファイル粒度の微調整は可能だが責務の境界は維持する。

| ファイル/領域 | 責務 |
| --- | --- |
| `backend/src/math-types.ts` / `frontend/src/math/types.ts` | 同じAPI contract。DB private型とpublic DTOを分ける |
| `backend/src/math-schema.ts` | request / Markdown正規化 / LLM出力のschemaとruntime validation |
| `backend/src/math-content.ts` / `math-unit-compiler.ts` | unit MD/YAML parse、block、出典、hash、概念・目標への正規化 |
| authoring CLI・schemas・PDF/image adapter | [教材作成設計](math-content-authoring-design.md) 第10節のファイル一覧に従う |
| `backend/src/math-graph.ts` | capability依存、DAG、OR選択、循環診断 |
| `backend/src/math-scope.ts` | T/P/B/G、scope preview、snapshot hash |
| `backend/src/math-planner.ts` | difficulty、coverage、組合せ、seed、重複対策 |
| `backend/src/math-store.ts` | catalog、preview、tests、attempts、receipts、学習状態のI/O |
| `backend/src/math-generation.ts` | context pack、生成、独立検証、採用ゲート |
| `backend/src/math-grading.ts` | rubric採点、決定的チェック、自己採点修正 |
| `backend/src/math-operations.ts` | test/sitting/attemptの純粋な状態遷移 |
| `backend/src/math-jobs.ts` / `math-job-store.ts` / `math-task-dispatch.ts` | 永続ジョブ、lease、checkpoint、dispatch、reconcile |
| `backend/src/math-prompts.ts` | version付きの数学prompt/schema。初版はコード管理 |
| `backend/src/math-local-worker.ts` | emulatorのジョブ実行 |
| `backend/src/routes/math.ts` / `math-worker.ts` | public APIとOIDC内部API |
| `backend/scripts/math-validate.ts` / `math-manifest.ts` / `math-sync.ts` | 教材の検証、metadata提案、同期・公開 |
| `backend/scripts/setup-math-jobs.ts` / `check-math-jobs.mjs` | queue/scheduler/IAMの準備と検証 |
| `backend/scripts/setup-math-indexes.ts` / `backend/firestore.math.indexes.json` | 数学indexの追加管理 |
| `backend/scripts/run-math-emulator-tests.mjs` | production拒否の隔離emulatorテストrunner |
| `backend/src/index.ts` / `llm-features.ts` / `llm-budget.ts` / `llm.ts` | 認証付きルート登録、モデル機能、worker時間枠、上限オプション |
| `frontend/src/math/api.ts` | 既存clientを使う型付きAPI |
| `frontend/src/math/MathRoutes.tsx` / `MathHome.tsx` | 数学の導線と空状態 |
| `frontend/src/math/CurriculumTree.tsx` / `MathTestSetup.tsx` / `ScopePreview.tsx` | 範囲と前提の確認 |
| `frontend/src/math/MathTestTaking.tsx` / `MathReview.tsx` / `MathResults.tsx` | 出題・中断・再開・採点・結果 |
| `frontend/src/math/MathMarkdown.tsx` / `MathAnswerEditor.tsx` | 数式と答案入力 |
| `frontend/src/math/useMathJob.ts` / `mathOperations.ts` | polling・再開とローカル状態表示 |
| `frontend/src/utils/answerOutbox.ts`、関連hooks、capture navigation | 数学の直列操作と未同期警告 |
| `frontend/src/App.tsx` / 入口 / `i18n/translations.ts` | 独立カテゴリーとen/ja/ko翻訳 |
| 両package.json・lockfiles、Docker/ローカル起動スクリプト | 新依存・commands・math-worker |
| `README.md` / `docs/development-reference.md` / 新 `docs/math-category.md` | 完了した仕様と運用方法 |

Firestoreクライアントをmath-storeで新規生成するなら、既存と同じproject/database設定を使う。よりよいのは接続生成部分だけを `firestore-client.ts` に抽出し、既存exportの互換性を保つ方法。巨大な既存 `firestore.ts` に数学の全実装を追記しない。

## 15. 実装順と各段階の完了条件

### Phase 0: 契約の固定とfixture

- この計画の型、既定値、上限、APIエラーをschema化する。
- 小さな架空科目fixtureを作る。直列依存、代替依存、proofだけの依存、基礎Identity、循環、欠損ID、空科目、学習ユニットMD、外部抽出package、自作の小さいPDFを含める。
- `textbook/` を触らず、parse/graph/scopeの純粋テストを動かす。

完了条件: Chapterを推測せずT/P/B/Gを計算でき、未知の前提を拒否できる。

### Phase 1: 教材の同期と閲覧

- 学習ユニットcontract、外部AI package取込、review/accept、unit compiler、論理ツリーを実装。
- PDFページ準備と組込み抽出adapter、run checkpoint、出典・条件の照合を実装。provider未設定でも外部AI入口は利用できる。
- validate、manifest提案、dry-run、staging、atomic publishを実装。
- Firestore repository、catalog API、数学カード、科目・ツリー・概念閲覧、空状態を実装。
- 実教材を本番同期せず、emulator fixtureで確認する。

完了条件: 空でも数学カテゴリーが使え、階層があるfixtureでは任意深さの選択が動く。再公開・移動・失敗・rollbackで旧テスト参照を壊さない。

### Phase 2: 範囲確定と問題生成

- preview、前提確認、scope snapshot、planner、context pack、出力検証を実装。
- math jobs、ローカルworker、Cloud Tasks/OIDC/reconcilerを実装。
- LLMをmockして全状態遷移を確認する。明示された実LLM検証は別途少数例に限定する。

完了条件: 許可外ID・条件不足・生成失敗を出題せず、再送・重複task・切断でも同じテストが復元される。

### Phase 3: 解答、採点、再開

- Markdown/数式renderer、答案入力、下書き、attempt、採点job、rubric、自己採点を実装。
- outbox、冪等操作、競合、sitting、review、完了を実装。
- 既存語学のqueue/レビュー/認証回帰を実施する。

完了条件: 別端末で再開でき、未送信を保存済みと表示せず、点数を二重加算しない。証明の判定不能を誤答と断定しない。

### Phase 4: 品質・履歴・運用

- objective evidence、報告・無効化、履歴、苦手から新テスト、カバレッジ表示を実装。
- index、ジョブ予算、タイムアウト、監視、cleanup、en/ja/ko翻訳、iOS表示を仕上げる。
- READMEとfeature docsを実装済み挙動に合わせる。

完了条件: 下記受入テストとemulator/Docker smokeを通し、実教材なしでも安全にリリースできる。Cloud設定・デプロイ・教材公開の実施結果を分けて報告する。

### 初版の完成範囲と後続

Phase 0〜4を初版の完成範囲とする。途中段階を最終完成として扱わない。ただし段階ごとのcommit・feature capabilityで安全に統合する。

後続: WebのPDF upload/保管、全冊の自動処理を管理するWeb UI、embedding検索、CAS、手書き答案、図形、適応的出題、マルチユーザー。PDF由来の教材作成・外部package取込・ローカルreviewは初版に含む。実際の教科書全体の抽出・承認は、コード実装とは別の著者作業とする。

## 16. テスト・受入条件

### 16.1 純粋ロジックとcontract

| ケース | 期待結果 |
| --- | --- |
| Chapter 6相当だけを選び、1〜5相当に前提がある | 6のobjectiveだけT。必要な前提だけP。確認しない限り使用不可 |
| 前のChapterだが依存辺がない | 自動で既知・許可にしない |
| 基礎profileにsin積分があるがcosh積分はない | sinのみ許可。coshの利用候補は拒否または再確認 |
| 選択範囲と基礎のみで不足前提がある | 対象objectiveを不適格として理由表示。範囲を黙って拡張しない |
| 補助情報つき | Gが問題文に含まれる。与えた結果の暗記を採点しない |
| applyは可能、proveは依存不足 | apply問題は可能、prove問題は不適格 |
| OR前提に既知の代替がある | 決定規則に沿う枝だけ選び固定する |
| A→B→Aの循環、未解決ID | publish拒否。依存経路を表示 |
| level5、評価対象1概念 | 高抽象・証明で可能なら許可。不可能なら不足を返す |
| LLMが許可外concept / 捏造sourceを返す | candidate拒否、public questionに保存しない |
| LLMが隠れて範囲外手法を使うfixture | 独立validatorが検出し、不採用にする |
| 問題は正しいが模範解答が誤り | solver比較で不採用 |
| 正しい別解、許可外手法による正解 | 正しさとobjective evidenceを分離 |
| 部分点・ヒント・自己採点修正 | 根拠とgradeSourceを保存、重複集計しない |
| 本文・scope・答案のサイズ上限 | 413/対応エラー。切り詰めない |
| Markdownのコード内に見出しやfront matter風文字列 | 誤分割しない |

### 16.2 Firestore / Fastify injection / worker

- staging途中失敗、同hash再送、公開競合、active pointer交換、旧版rollback。
- フォルダー移動・概念削除・profile更新後の旧test再開。
- previewとstartの間のcatalog更新は409、開始後の更新は影響なし。
- 同じoperationの再送、異なるpayloadによるID再利用、別タブのrevision競合。
- job保存直後のenqueue失敗をreconcileで回復。
- taskの重複・順序逆転・lease切れ・古いworkerの遅延commit。
- 候補3回不採用、LLM 429/5xx、タイムアウト、モデル未設定、予算切れ。
- 生成途中キャンセル、部分採用、採点途中ブラウザー終了。
- public GETからsolution/rubric/checkpointが漏れない。
- 未認証API拒否、worker Cookie拒否、誤audience/誤accountのOIDC拒否。
- auth config読込失敗時の既存fail-closedを維持。
- scope/solution等の明示read mappingで保存した新fieldが落ちない。
- 単一巨大配列に依存せず、paginationとindexをemulatorで確認する。

### 16.3 フロント・ブラウザー

- 語学APIが失敗しても数学カードは表示。英語停止中の状態は維持。
- 空科目、任意深さツリー、部分選択、親子重複、除外、難易度変更後のpreview更新。
- en / ja / koの翻訳キーが全て揃う。loading/empty/errorを英語固定にしない。
- 数式、分数、積分、行列、cases、長い式、壊れたLaTeX、危険なHTML/URL/macro。
- 下書き保存→提出→sitting終了の順序、401、再認証、通信断、409解決。
- 採点待ちの次問遷移、紙で解く、reveal使用、skip、自己採点。
- 自然終了と早期終了、review途中再開、完了テストが再開されないこと。
- math routeをiOS foreground時にrefetchし、Web/iOS両方で未保存警告を維持。
- captureで記事読込へ移る際に、未保存数学答案を失わせない。
- 既存の語学・混合クイズ・記事・system設定が回帰しない。

### 16.4 実行コマンド

現行コマンド:

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:mixed --prefix backend
npm run test:import --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
git diff --check
```

数学用として追加するコマンド（現時点では存在しない）:

```bash
npm run test:math --prefix backend
npm run test:math:emulator --prefix backend
npm run test:browser --prefix frontend -- --grep math
```

`test:math` はNode 24 + module mocksでFastify/workerをクラウドなしで検証。純粋テストは既存の `src/*.test.ts` globへ入れるかscriptを更新し、サブディレクトリに置いて未実行にしない。`test:math:emulator` は専用 `demo-vocab-math` project、明示emulator host、`(default)` databaseを要求し、本番projectを拒否する。

隔離runnerは起動に必要な `config/vocabulary` 等の最小fixtureも用意する。数学のテストを動かすためにproductionの `seed:download` を自動実行しない。既存 `seed:load` が数学collectionを扱うかを確認し、数学fixtureのロードと汎用emulatorリセットの責務を明示する。

本格的なruntime変更なので、Dockerとemulatorが利用できるなら `./local.sh` のworkflowでsmokeする。LLMをmockした通常検証と、実LLMの品質点検を区別する。実LLMの少数テストが通っても数学的正しさを一般保証しない。

初回品質点検では、直接適用、複合、前提不足、定理条件、短い証明、別解、範囲外混入の各類型を含む固定fixtureを人が確認する。範囲違反・条件不足・誤った模範解答を含む既知の不良fixtureがゲートを通らないことをリリース必須条件とする。

## 17. デプロイ・教材登録・ロールバック

1. コード・schema・index・worker設定をemulatorで検証する。
2. 数学のqueue/indexの準備スクリプトを明示実行する。既存import設定を上書きしない。
3. デプロイスクリプトに数学のenabled時の検証と必要な設定保持を追加し、Windows版も揃える。
4. `./deploy.sh` でbackend/frontendをリリースする。数学promptは初版ではコード管理なので、数学だけを理由に `--prompts / --llm / --auth` を付けない。
5. 数学カード、空状態、認証、worker configurationを確認する。実教材なしでも語学は従来通り動く。
6. 著者がPDFの対象範囲を指定し、AI抽出→学習ユニットのreview/acceptを行う。dry-runを確認して別操作でcatalogを公開する。手書きMDからの作成も可能。
7. iOSは `npm run ios:sync --prefix frontend` とXcodeインストールが別途必要。Cloud Run deployだけでインストール済みnative bundleが更新されるとは報告しない。

コードのロールバックと教材catalogのロールバックを別々に実施できるようにする。schemaVersionに対し未対応のbackendが起動した場合、数学の利用を明示エラーにして語学のデータを壊さない。ジョブ実行時もfrozenConfigのschema/prompt versionが処理可能か確認する。

完了報告には、実装済み範囲、試験結果、commit、push、Cloud Run deploy、基盤設定、教材公開、iOS確認を個別に記載する。今回の計画作成が数学機能や教材の公開を意味するとは書かない。

## 18. 実装エージェント向け最終チェック

- [ ] 数学をlanguage / word / grammar / Group A/Bに偽装していない。
- [ ] 英語の一時停止と既存語学ルートを維持した。
- [ ] コード実装中に実教材のPart/Chapter/本文を生成していない。別途指定された抽出作業では階層を提案できるが、未確認で公開していない。
- [ ] 学習ユニットの文脈を保ち、対象目標と参照知識を混ぜていない。
- [ ] PDF出典・条件・例外・AI補足・未解決事項・review hashが追跡できる。
- [ ] ツリーと前提グラフ、評価と利用許可、自己申告と成績を分離した。
- [ ] 難易度が上がっても出題範囲を勝手に広げない。
- [ ] 基礎知識は版付きで明示し、前提不足を隠さない。
- [ ] ローカル原本→検証→staging→atomic publishが再実行可能。
- [ ] 開始済みテストは教材更新やフォルダー移動で変わらない。
- [ ] 使用概念・条件・解答を独立検証してから出題する。
- [ ] 模範解答が公開question DTOに混入していない。
- [ ] LLMに数学的正しさの保証や完全な同値判定をさせたつもりになっていない。
- [ ] ジョブ・回答・採点・自己修正は冪等で、競合を黙って上書きしない。
- [ ] 保存状態を正確に表示し、未送信答案の警告を維持した。
- [ ] 結果から対象外の前提概念を習得済みにしていない。
- [ ] 空教材、未設定worker、通信失敗でも語学を壊さない。
- [ ] en/ja/ko、Web/iOS、API型、read mapping、docsを揃えた。
- [ ] 必要な検証・push・deployを実行し、未実施項目は具体的に報告した。

この設計では「Chapterを選ぶ」という分かりやすい操作を保ちながら、実際の出題は概念・能力・前提・条件を明示した小さな単位で管理する。教材の量が増えても、どの知識を評価し、どの知識を使ってよいかを後から説明できることを優先する。
