# 数学モード v2 実装計画

作成日: 2026-10-28。状態: **設計のみ・未実装**。

このファイルを実装エージェントへの依頼書とする。既存の
[数学カテゴリ計画](math-category-implementation-plan.md) と
[教材作成設計](math-content-authoring-design.md) に対し、以下の変更事項は本書を優先する。
数学以外の単語・文法・A/Bテストの挙動は変更しない。

## 1. 成果物と決定事項

1. 試験範囲を選ぶUIを、整列したチェックボックス付き階層リストに変更する。
2. 科目の階層と依存関係をGit管理のJSONで定義し、デプロイ時に検証・公開する。アプリからの編集機能は作らない。
3. 教材の正本を章単位のJSONにする。JSON Schema・完全な例・作成指示を `prompt/` に置く。
4. 線形代数の既存9章を意味・数式・順序を維持してJSON化し、章依存を `1 → 2 → … → 9` とする。
5. Search Titleとユーザーが選ぶknowledge policyを削除する。
6. 開始画面の必須操作は範囲・難易度だけ。問題数は任意で、空欄なら明示終了まで逐次生成する。

「タイトルのキーワードは任意」は、要素の `title` と `keywords` の両方が省略可能、という設計にする。
章・節には表示用の必須タイトルを持たせる。無題要素は種別と番号で表示する。
「JSONだけ保存」は、教材のファイル形式と保存元をJSONに統一する意味とする。
JSONの本文文字列ではMarkdown/LaTeXを引き続き利用できる。生の `.md` ファイルをDBに保存しない。
問題・解説・回答のMarkdown文字列まで削除する意味ではない。

## 2. 現状確認と変更箇所

| 領域 | 確認した現状 | 主な変更先 |
| --- | --- | --- |
| 開始画面 | 範囲、難易度、1–20問、policy、言語、形式、foundation、preview同意 | `frontend/src/math/MathTestSetup.tsx` |
| 範囲ツリー | ＋/−・閲覧ボタンに共通の大きなボタンスタイル。検索はローカルstate/filter | `CurriculumTree.tsx`, `math.css` |
| 許可知識 | strict/prerequisites/providedをリクエストで選択 | `backend/src/math-scope.ts`, `math-graph.ts`, `math-schema.ts` |
| 教材 | Markdown/YAMLをcompile。通常deployは教材を公開しない | `math-content.ts`, `math-authoring.ts`, `scripts/math-cli.ts`, `deploy.sh`, `deploy.ps1` |
| 生教材保存 | `publishCatalog` が `math_source_revisions/{hash}` に `{ markdown }` を書く | `backend/src/math-store.ts` |
| 問題生成 | 全問分の `scope.plans` と単一generation job。採点はordinalからplanを参照 | `math-jobs.ts`, `math-generation.ts` |
| 完了判定 | `completeIfExhausted` が生成済み問題の消化でcompletedにする | `math-operations.ts` |
| 保存サイズ | test/sittingに問題ID・回答IDの配列、viewに全履歴 | `math-types.ts`, `math-store.ts`, `routes/math.ts` |
| 線形代数 | 9つの追跡済み `.md`。章内のDefinitions/Theorems/Examples、見出し深度、色付きHTML等が不均一 | `textbook/Linear Algebra/` |

`docs/math-verification.md` が報告する公開教材は小さな検証用部分集合であり、9章すべてではない。
本計画作成時には本番DBを調査していない。実際の旧教材件数は移行時に調査する。
未追跡の `textbook/Engineering Math/` とそのPDFは既存のユーザー資料であり、今回の変換・コミット・削除対象に含めない。

## 3. ファイル構成とJSON契約

### 3.1 配置

```text
prompt/
  math-subject.schema.json          # 科目・ツリー・依存グラフのJSON Schema
  math-chapter.schema.json          # 教材JSON Schema
  math-chapter.example.json         # 独立した短い完全適合例
  math-textbook-json-authoring.md   # JSON作成・変換・検証の指示
textbook/
  catalog.json                     # 公開対象科目を明示するallowlist
  Linear Algebra/
    subject.json
    1. Vector Spaces.json
    2. Finite-Dimensional Vector Spaces.json
    3. Linear Maps.json
    4. Polynomials.json
    5. Eigenvalues and Eigenvectors.json
    6. Inner Product Spaces.json
    7. Operators on Inner Product Spaces.json
    8. Operators on Complex Vector Spaces.json
    9. Multilinear Algebra and Determinants.json
```

`catalog.json` は `{ "schemaVersion": 2, "subjects": ["Linear Algebra/subject.json"] }`。
登録外フォルダーは走査・公開しない。登録科目ではmanifestに列挙したJSONだけを読む。
教材の葉はchapter JSONとし、節・小節・要素はその中に入れる。Partフォルダー等の物理配置も許容するが、
表示階層はmanifestの明示的な `parentId/order` が正。ファイル名の辞書順では決めない。
本番公開時にLLMを呼んで教材変換・意味抽出・補完する仕組みは作らない。

### 3.2 科目JSON

次は2章だけの例。実教材では9章と8辺をすべて列挙する。

```json
{
  "schemaVersion": 2,
  "subjectId": "linear-algebra",
  "title": "Linear Algebra",
  "contentLanguage": "en",
  "nodes": [
    {"id": "la", "kind": "subject", "parentId": null, "order": 0, "title": "Linear Algebra"},
    {"id": "la-ch01", "kind": "chapter", "parentId": "la", "order": 1, "title": "Vector Spaces", "contentFile": "1. Vector Spaces.json"},
    {"id": "la-ch02", "kind": "chapter", "parentId": "la", "order": 2, "title": "Finite-Dimensional Vector Spaces", "contentFile": "2. Finite-Dimensional Vector Spaces.json"}
  ],
  "dependencies": {
    "semantics": "requires-all",
    "edges": [{"nodeId": "la-ch02", "requires": ["la-ch01"]}]
  },
  "foundationRefs": []
}
```

- `nodeId` が `requires` を前提とする。辺なしは依存なし。配列順・番号・兄弟関係から依存を推定しない。
- `nodes.kind` は `subject | part | chapter`。節以下のノードはchapter JSONからcompileする。
  manifest内の依存辺はpart/chapterに限定。節・要素の知識依存は後述の明示参照で表す。
- Partへの依存は配下の章全部に展開し、Partからの依存はそのPartの各章に継承する。
  展開後に自己依存・循環を検出する。階層の辺と知識依存の辺は別のDAGとして検証する。
- 独立な系列 `1–6` と `7–9` は `2→1, …, 6→5, 8→7, 9→8` のみ定義する。
  `7→6` を追加しない。今回の線形代数は `7→6` も含め、全章を連結する。
- 異なる科目への暗黙の依存を許可しない。必要なら版を固定した `foundationRefs` に
  `{subjectId, conceptId, capability, revisionId}` を列挙する。初期線形代数は空。
- missing/duplicate ID、unknown field、循環、複数root、孤立ノード、path traversal、symlink、
  Unicode正規化後のパス衝突、異科目参照、深さ/サイズ超過は公開前エラー。
- 編集・削除用の公開APIを追加しない。既存foundation同意APIは旧テスト互換用に隔離する。

### 3.3 章JSONの構造

以下はデータ形の例。実際のSchemaには再帰型・全項目・サイズ制限を定義する。
`content` は配列で順序を保持し、sectionの中にsection/item/blockを混在できる。

```json
{
  "schemaVersion": 2,
  "subjectId": "linear-algebra",
  "chapterId": "la-ch01",
  "title": "Vector Spaces",
  "source": {"kind": "local-notes", "originalFile": "1. Vector Spaces.md", "originalSha256": "<64桁の実ハッシュ>"},
  "content": [
    {"type": "block", "id": "la-ch01-context", "format": "markdown", "text": "Throughout this chapter, $F=\\mathbb R$ or $\\mathbb C$, and all subspaces use the same scalar field."},
    {
      "type": "section", "id": "la-ch01-definitions", "title": "Definitions", "label": "1", "content": [
        {
          "type": "item", "id": "la-ch01-def-subspace", "kind": "definition", "label": "1.2", "title": "Subspace", "keywords": [],
          "content": [{"type": "block", "id": "la-ch01-def-subspace-body", "format": "markdown", "text": "A subset $U$ of a vector space $V$ is a subspace if $U$ is itself a vector space with the same additive identity, addition, and scalar multiplication as on $V$."}],
          "learning": {"capabilities": ["recognize", "apply"], "requires": [], "proofCoverage": "none"}
        }
      ]
    }
  ]
}
```

契約:

- `section`: `id`, `title`, `content` 必須。`label`, `keywords` 任意。小節は再帰section。
- `item`: `id`, `kind`, `content` 必須。`title`, `keywords`, `label` は任意。
  kindは `definition | theorem | lemma | proposition | corollary | axiom | example | remark | exercise | proof`。
  proofには `provesItemId` を付ける。帰属不明の証明を勝手に結びつけない。
- `block`: `id`, `format: markdown`, `text` 必須。本文・数式・箇条書き・表を文字列のまま保持。
  要素contentにはblockと補足itemを許可し、原文のProperties・証明・注意を落とさない。
- `source`: 原文ファイル名、実SHA-256、原文にあるURL、必要な範囲のみの元見出し情報。
  書名・版・ページが不明なら省略し、推測しない。絶対パスは保存しない。
- IDは科目内一意かつ安定。タイトル・ファイル移動で変えない。章番号＋原文番号を優先し、
  番号なし要素は初回採番したIDを維持する。配列indexを永続IDにしない。
- `learning` は出題可能なitemに必須。`capabilities` と `requires` の各要素は既存
  recognize/apply/proveに対応。`requires` は `{itemId, capability}` の全条件。
  `proofCoverage` は `none | sketch | complete`。補足/資料専用itemではlearningを省略可能。
- 学習メタデータは本文と区別する。各itemに任意の `objectives` を持てるようにし、
  `{id, description, assessedCapabilities, additionalPrerequisites, assessmentBlockIds,
  difficultyRange, proofRequirement, proofSupport, readiness}` は既存Objectiveと同じ意味にする。
  全てJSON内でレビュー済みにする。objectiveを省略した場合は認識/applyの保守的な既定のみを
  決定的にcompileし、proveや高度な難易度を自動許可しない。既定のdifficultyRangeは `[1,2]`。
- 元に証明がない定理を「証明教材あり」にしない。定理を使う問題と定理を証明する問題を分離する。
- `keywords` は表示・将来利用のメタデータ。本タスクで検索機能を復活させない。
- Schemaを `prompt/` の単一の正とし、backendの検証とCIは同じファイルを読む。
  配布/build時にschemaを利用可能にする方法をbackendのbuildへ追加し、cwd依存を避ける。
  JSON duplicate keyも明示拒否する。単なる `JSON.parse` による後勝ちを許可しない。

### 3.4 runtimeへのコンパイル

新規 `backend/src/math-json-content.ts` と `math-curriculum-dependencies.ts` に純粋処理を分離する。
章/section→CurriculumNode、学習対象item→Concept/Unit、objectives→Objective、元階層→Citationに変換する。
表示用・出題用・引用用で異なる独自パーサーを作らない。1つの検証済み中間表現から生成する。
学習対象item単位の小さなUnitを基本とし、章全体を1MB近い1文書にしない。
`sourceArtifactHash` は正規化JSONのhash。本文文字列は空白まで意味を持つため勝手に正規化しない。
review receiptはJSON内容・依存定義・compiler versionのhashに紐付け、変更時に再レビューする。
既存ローカルOCRは引き続きローカル限定。authoring/export/acceptの最終成果物をJSONに変え、
既存Markdown/YAML入力は移行専用のread-only adapterに隔離する。

## 4. 出題範囲と事前依存関係

ユーザーが選ぶのは採点対象の範囲。前提知識はサーバーが定義済みグラフから導出する。
章5だけを選んだとき、採点対象は章5のみ、利用できる章の前提は章1–4。
独立系列の章8だけなら章7が前提となり、章1–6を混ぜない。

アルゴリズム:

1. 選択node IDsを現catalogで検証し、配下の学習可能item/objectiveを重複なく展開する。
2. 各targetが属する章の依存推移閉包を求める。出題対象を前提章まで拡大しない。
3. 前提章の利用可能なrecognize/apply能力と、targetの明示item依存を候補にする。
   同じ章の未選択要素は自動で全許可しない。`learning.requires` で必要な依存だけ追加する。
   item依存で他章を参照する場合、その章は章依存閉包内でなければ教材検証エラー。
4. objectiveの明示依存、foundationRefs、既存の能力検証を解決する。
   proveの権限をapplyから推定しない。証明対象自身をmayAssumeに含めない。
5. catalogId、curriculumHash、依存閉包、対象、難易度、生成規則をimmutable scope snapshotに保存する。
   項目追加・依存変更・デプロイ後も進行中のテストには元snapshotを使う。
6. LLMへはその問題に必要な知識だけ渡す。全前提章を毎回プロンプトに展開しない。
   許可集合から必要部分を選び、使った引用を検証する。サイズ超過時は黙って切らず明示エラー。

`mode/profileIds/excludedConceptIds/excludedObjectiveIds/objectiveCapabilities/answerFormats` はv2作成APIから除去。
knowledge policyのUI・新規リクエストの選択肢を削除し、**サーバー内部の知識制約・証明検証は維持する**。
v1 snapshotは読み取り/既存テスト継続用にのみ旧型で解釈し、v2の選択設定に変換しない。
foundationは科目の宣言で固定し、学習者が習得済みだと自動記録しない。

## 5. UIとAPI

### 5.1 開始画面

```text
線形代数
試験範囲                           全選択  選択解除
▾ □ 線形代数
    ▾ ☑ 1. Vector Spaces
          ☑ Definitions
          □ Theorems
    ▸ □ 2. Finite-Dimensional Vector Spaces
選択: 1章・3項目   前提知識: 定義済みの範囲を自動使用

難易度       [ 1  2  3  4  5 ]
問題数（任意）[          ]  空欄なら終了するまで継続
                         [ テスト開始 ]
```

- 主画面は1列、最大幅約880px。開始ボタンだけ塗りつぶしprimary。重い左右2カードをやめる。
- ツリーは1行48px以上、chevron/checkbox/ラベル/件数の列を揃える。
  chevronの見た目は小さくてもクリック領域44px、border/backgroundは透明。
  葉の「無効な・ボタン」をやめ同幅のスペーサーにする。インデントは16px。
- 選択背景は淡いindigo、hoverとfocus-visibleは区別。共通buttonセレクターのmargin/paddingを
  ツリーの全ボタンに適用しない。CSS classでprimary/secondary/iconを分ける。
- 全選択・解除はツールバーに一組。閲覧は必要時に1つの詳細パネルへ集約し、unit数分ボタンを並べない。
- 親のチェックは配下の選択可能な葉だけを一括操作。部分選択はindeterminate。
  正規のselection stateは最下層の選択可能node IDsのみ。祖先は派生表示。
  選択可能な学習目標を持たない見出しは集計から外し、その理由を表示する。
- 既存 `role=tree` を使うなら矢印/左右/Home/End/Spaceとroving tabindexを実装する。
  実装しない場合は通常の入れ子リスト＋button/checkboxとし、不完全なARIA treeを名乗らない。
- Search Titleのinput、search state、filter処理、専用翻訳・テストを削除する。
- previewの巨大な知識一覧・承認チェック・別画面のGenerateを撤去する。
  開始押下の内部でpreview→createを行う。読取専用の簡単な範囲要約は表示可能。
- 問題数は折り畳みの詳細設定に隠さず、小さな任意入力1つ。空欄はcontinuous、整数1–20はfinite。
  0/負数/小数/21以上は入力エラー。未選択範囲・利用可能objectiveなしは開始不可。
- 言語は現在のUI言語を開始時に固定。出題形式は教材のobjectiveに適合するものをサーバーが選ぶ。
  text形式に数値・式・証明を入力できる既存動線を維持し、選択式を必須にしない。
- EN/JA/KOを同時更新。360px幅、長い章名、キーボード、読み上げ、数式横スクロールを確認する。

### 5.2 v2 API契約

既存routeを維持して `schemaVersion: 2` で厳格に分岐する。新規作成のv1入力はサポート終了を明示する。
backend/frontendのDTO、fixture、APIクライアントを同じ変更単位で揃える。

```ts
type ScopeRequestV2 = {
  schemaVersion: 2;
  subjectId: string;
  selectedNodeIds: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  questionCount?: number; // 未指定=continuous。nullはwireで使わない
  responseLanguage: 'en' | 'ja' | 'ko';
};
// POST /api/math/scope-previews -> previewId, scopeHash, catalogId,
// curriculumHash, eligibleObjectiveCount, compactSummary, expiresAt
// POST /api/math/tests -> {schemaVersion:2, previewId, scopeHash, operationId}
// POST /api/math/tests/:id/next-question -> {operationId, expectedRevision}
// POST /api/math/tests/:id/finish -> {operationId, expectedRevision}
```

previewは内部で作るが、サーバーのcatalog/hash再確認は省略しない。409でcatalogが変わったら
設定を残して範囲を再取得し、再押下を促す。無言で別範囲を開始しない。
next-questionは既存未回答問題があればそのID、生成中なら同一jobId、なければjobを作り202を返す。
GETは読み取りだけ。poll/再読込だけで新規生成を発生させない。
operation receiptはrevision比較より先に確認。v1レスポンスとv2の識別子を必須にする。
不明policy等を含むv2リクエストは400、終了後nextは409。

## 6. 継続出題と永続化

### 6.1 状態と生成タイミング

- `test.schemaVersion = 2`, `generationMode = finite | continuous`, `questionLimit: number | null`。
- test状態は既存stateを活かし、生成の状態は別の `generationState = idle | queued | running | failed`。
  2問目以降の生成待ちでtest全体を初期generatingへ戻さない。
- 開始時は1問だけ生成。回答/skip後の「次の問題」で1問だけ要求する。先読みは初期版ではしない。
  自動で無制限にCloud Tasksを積まない。1testにつき未回答1問・生成中1jobまで。
- 全問生成済みという意味のreadyではなく、初問が利用可能になった時点で開始可能。
  finiteも同じ逐次生成経路を使用し、上限到達で自然完了する。
- continuousは生成済み問題が0件になってもcompletedにしない。「テスト終了」で確定終了する。
  既存「End session」は中断・固定範囲review・再開を維持し、「テスト終了」と区別する。
  中断時は生成予約を止める。再開後も明示的なnextだけが生成を要求する。
- 終了時はoutboxをflush後、進行中jobをcancelしgeneration epochを進める。
  lease/epoch/stateをworker commitで再検証し、遅れて返った結果を追加しない。
  採点jobは継続してよい。遅延採点・review完了で終了済みtestを再開しない。
- 終了時の未送信draftは保存し、未回答は得点対象外。回答済みattemptは全て保存する。
  送信と終了が競合した場合はCASの先着を採用し、後着は再読込要求。解答を黙って破棄しない。

### 6.2 planと問題選択

`scope.plans` を無限に延長しない。scopeには対象集合と規則を固定し、
`tests/{id}/question_plans/{planId}` に各問のplanを保存する。
`questions/{id}` と採点jobは `planId` を保持。`scope.plans[ordinal - 1]` 参照をv2から排除する。
ordinalは単調増加し、transactionで予約する。job IDはtest/epoch/ordinalから決定的に作る。
生成失敗のretryは同じ予約slotを使い、別問題番号を増やさない。
対象objectiveは出題回数の少ないものから選び、同率はsnapshot seed+ordinalで決定する。
有限の教材を周回するためobjective再利用は許可し、同じ問題文の再利用は抑制する。
直近20問の内容hashと定型化した指紋を検査し、意味重複の完全排除は保証しない。
invalidated問題は有効出題数から除外し、finiteは不足分を次の要求で補充する。

### 6.3 上限のない履歴に対応する保存設計

v2で `questionIds/answeredQuestionIds/revealedQuestionIds/invalidQuestionIds` とsittingの全attempt配列を
増やし続けない。問題・attempt・draftの既存subcollectionを使い、親文書はcounter/cursorだけにする。
`nextOrdinal`, `generatedCount`, `answeredCount`, `invalidCount`, `currentQuestionId`,
`pendingGenerationJobId`, `generationEpoch` を保持。revealed/invalid等は問題文書に保存。
スコアは採点/無効化/再採点transactionで差分集計し、二重適用はreceiptで防ぐ。

- 問題・attempt一覧はcursor pagination（既定20、最大100）。test viewは現在問と集計だけ返す。
- sittingは開始/終了attempt sequenceを保持。reviewはその固定境界とページ分割の順序snapshotを保存。
  late gradeは内容を更新できるがreview対象順序は変えない。
- 重複検出はbounded windowのみ、出題配分counterはobjective別文書。全過去問を毎回読まない。
- operation receiptsの無制限配列化も避ける。既存の独立文書形式を維持する。
- 10,000問の合成履歴で親文書サイズ・1要求のread/write量・payloadが問題数に比例増加しないことを検証する。

### 6.4 失敗・予算・再開

既存generate→独立solve→validateの品質ゲート、3候補上限、OIDC、lease、永続usage計測は維持する。
予算は1問job単位＋既存の運用上限にし、無限テスト全体に有限一括生成の上限を誤適用しない。
上限/モデル障害時は現在slotをfailedにして「再試行／終了」を表示し、既存成績を残す。
retryでcalls/tokensをゼロリセットしない。運用上限を再試行で迂回させない。
全履歴をLLMへ送らず、元scope・今回plan・必要な出典・直近重複情報だけ渡す。
ページ再読込/別端末は同じcurrent question/jobを復元する。localStorageに進捗・回答を保存しない。

## 7. 線形代数の変換作業

1. 9原文のSHA-256と要素一覧を採取する。原文は作業中残し、最後の検証後に `.json` へ置換する。
2. Markdown ASTを使い、見出しの中の数式・HTML・箇条書き・条件・章冒頭の共通前提を分離する。
   正規表現だけで行単位に切らない。章1の第3階層が要素、後半章の第4階層が要素などを識別する。
3. Definitions/Theorems/Examplesと元の小節・順序を維持する。元にないPartや小節を捏造しない。
4. 冒頭の括弧が名称の場合だけ、括弧内をtitleに抽出する。HTML spanの内側も対象。
   例 `(Generalized eigenvector)` → `title: "Generalized eigenvector"`。
   数式の括弧、仮定 `(V is ...)`、文中の括弧をタイトルにしない。
5. 名称を本文から移す場合は、逆変換用の元heading/label/title表記情報をローカル比較reportに記録する。
   その他の数学的文言・数式・仮定を校正しない。疑わしい箇所は別reportに記録し、本文は維持する。
6. span/u等の装飾HTMLは安全な表示表現に変換する。色・下線に意味がありそうな箇所は注記を保持し、
   意味を落とさずに確認する。任意のraw HTMLレンダリングを有効にしない。
7. 原文→要素IDの全対応表を作成し、全見出し・段落・数式が「移動/維持/装飾変換」のいずれかに対応することを検証。
   JSONから再構成した本文と原文を限定的な正規化で比較する。数式token列・数式数・条件文は完全一致を要求する。
8. proof/apply依存と学習目標をレビューする。難易度を支えられない要素を無理にreadyにしない。
   無題定理も欠落させず、表示は「定理 2.1」等にする。
9. 9JSON、subject.json、変換検証reportをコミットする。教材MDはGit履歴に残し、公開対象ツリーから削除。
   既存test fixtureが原文pathを読む箇所をJSONへ更新し、旧形式テストには小さな独立fixtureを使う。

## 8. 公開と旧Markdown保存の除去

### 8.1 新保存形式

`math_source_revisions/{jsonHash}` を `{format: "textbook-json", schemaVersion: 2, contentHash, chunks}` とし、
章JSONを既存chunk machineryで保存する。各chunkは上限内とし、全hashをread-back検証する。
runtimeのunits/concepts/objectives/nodesはそのJSONだけから導出する。
`.md/.yaml/PDF/画像/raw OCR/絶対パス` を公開しない。JSON中の本文Markdown文字列は許可する。
実際に使うコレクション・read mapping・DTO・index exemptionを全て更新する。

### 8.2 本番移行（通常公開とは別の一度きりの保守作業）

新規 `backend/scripts/math-migrate-json.ts` を設け、必須project/database、productionフラグ、
dry-run、manifest hash、expected active catalog、resume checkpointを実装する。
現在は移行スクリプトもこれらのフラグも未実装であり、そのまま実行できるコマンドとは扱わない。

1. read-only inventory: `math_source_revisions` の `{markdown}` 文書、参照catalog/revision/test/jobを列挙。
   path名が `.md` かだけで判定しない。原文全体をログに出さず、件数/hash/参照数を報告する。
2. 旧source本文のバックアップをアクセス制限された運用保管先へ取得し、checksumを検証する。
   backup/個人学習データ/認証情報をGitに入れない。
3. 旧sourceごとに内容を欠落なく構造化JSONへ変換し、v2 sourceを保存。
   active9章のJSONと、歴史的snapshotのJSONは別物。旧版を最新版に差し替えない。
   旧検証教材も変換対象。識別不能なraw本文は移行JSONのblockに忠実に保持する。
4. `math_source_aliases/{oldHash}` に `{jsonHash, originalSha256, migrationVersion}` を追加する。
   v1 catalog/attemptのimmutable IDや意味revisionを変更せず、source loaderがalias解決する。
   aliasは生MDを含めない。旧hashでの引用・採点・再開を新readerで検証する。
5. 新コードと旧snapshot互換readerを全サービスにデプロイし、旧workerのleaseが終了するまで待つ。
   実行中jobは安全なcheckpointで引継ぐか明示失敗へ移し、二重commitを防ぐ。
6. hash一致・全参照の解決・旧テストの引用復元が揃った文書だけ `{markdown}` 保存を削除する。
   旧catalog/test/attempt/成績を削除して「MDがなくなった」としない。
   不一致・未解決があれば該当削除を止め、移行未完了として報告する。
7. dry-run差分と削除後の再inventoryで生MD件数0、JSON read-back、過去テスト回帰を確認する。
   中断後resume、既移行alias、削除済みsourceに対する再実行はno-opで安全に完了する。

削除後のロールバック先はv2 JSON/alias readerを持つ互換版のみ。
古いMD専用コードへ無条件に戻せない。緊急時のbackup復元は明示的な障害復旧作業として扱う。

### 8.3 deployの変更

`./deploy.sh` / `deploy.ps1` の両方で同じ手順にする。

1. ローカルのJSON/schema/依存/レビュー/数式を検証。失敗したらbuild・公開前に停止。
2. content-addressed catalogをstagingに公開し、件数/hash/read-backを検証。まだactiveにしない。
3. v1/v2両readerを持つbackendをdeploy。通常のインフラcheckを維持。
4. backend healthとcatalog互換性を確認してactive pointerをCASで切替。
5. frontendをdeployして公開範囲・初問・再開をsmoke。

同じhashならno-op。別deployのCAS競合なら失敗を返す。stage/activateを独立再開可能にする。
frontend失敗時は対応する前catalogへCAS rollbackできるようrelease reportに前後IDを記録する。
旧MD削除を通常deployに隠して入れない。初回移行の保守コマンドでのみ実施する。
config uploadの `--prompts/--llm/--auth` を教材公開に転用しない。
通常deployが教材公開も行うという変更をREADMEと開発referenceに明記する。

## 9. エージェント別作業と並列実装手順

実装を開始する統括エージェントは、本節に従ってサブエージェントを使う。
計画作成段階では実装エージェントを起動しない。並列数上限を守り、独立したbranch/worktreeを使う。
各担当はコミットだけ作り、masterへの統合・push・deploy・本番DB操作は統括だけが行う。
同じ共有ファイルを別担当が同時編集しない。

### 9.1 作業パッケージ

| ID / 担当 | 所有ファイル・成果物 | 先行条件 | 完了条件 |
| --- | --- | --- | --- |
| P0 統括: 契約固定 | schema草案、v2 DTO、API fixture、依存解決例、state表。`math-types.ts`, `math-schema.ts`, frontend `types.ts/api.ts` の共通境界 | なし | 型と契約テストが一致。後続にcommit hashを共有 |
| P1 教材基盤 | `prompt/`新schema/例/指示、`math-json-content.ts`, `math-curriculum-dependencies.ts`、compiler/authoring/CLI、純粋テスト | P0 | JSON→runtime、循環検証、内容hash、review経路 |
| P2a 教材変換 | 線形代数1–3章JSON＋章別検証report | P0のchapter schema固定 | 数式/内容比較合格、対象MD置換 |
| P2b 教材変換 | 線形代数4–6章JSON＋章別検証report | 同上 | 同上 |
| P2c 教材変換 | 線形代数7–9章JSON＋章別検証report | 同上 | 同上 |
| P3 scope | `math-scope.ts`, `math-graph.ts`、新規scope純粋テスト | P0、P1の関数契約 | 事前依存閉包、旧scope互換、policy除去 |
| P4 runtime | `math-operations.ts`, `math-jobs.ts`, `math-generation.ts`, `math-store.ts`, `routes/math.ts`、runtime emulator tests | P0 | 逐次生成、pagination、終了競合、v1継続。P3はfixtureで先行可 |
| P5 UI | `MathTestSetup.tsx`, `CurriculumTree.tsx`, `MathTestTaking.tsx`, `MathRoutes.tsx`, `math.css`, translations、frontend tests | P0 | 新UI、検索撤去、finite/continuous、outbox動線 |
| P6 公開/移行 | JSON migrationスクリプト、deploy両OS、保存移行emulator tests | P1+P4 | dry-run/replay、stage/CAS、MD削除後引用検証 |
| P7 統合 | subject/catalog JSON、cross-chapter参照統合、全fixture、README/docs/prompt README、E2E、release | P1–P6 | 受入条件・全検証・push・deploy・移行結果報告 |

P1とP4が必要とする `math-store.ts` はP4所有。P1は保存adapterのinterfaceだけを提案する。
P3/P5が必要とする共通型、route、API変更はP0/P4所有者へパッチ依頼し、勝手に同時編集しない。
P6の保存変更はP4完了後に所有権を移す。`subject.json/catalog.json` はP7だけが最終編集する。
chapter担当は事前に割り当てたID prefixを使い、他章参照候補をreportで引き渡す。

### 9.2 進行順（統括＋作業3枠を想定）

1. P0で共通契約を確定する。薄いfixtureを先に置き、後続が実データ完成を待たなくてよい状態にする。
2. **P1・P4・P5を並列**に開始。P1完了枠でP3を実施。
3. 空き枠にP2a/P2b/P2cを投入する。3枠空いた時点では3教材担当を同時実行できる。
4. P1/P4完了後、空き枠でP6。教材変換およびUI調整とは並列可能。
5. P7で段階的に統合。共有型→compiler/scope→runtime→UI→教材→deploy/migrationの順に解決する。
6. 統合後はDB操作・リリースを直列実行する。各担当が独立に本番deployしない。

各担当の最終報告は変更ファイル、契約変更、実行したtest、未検証、依存先commitを必須とする。
担当の「完了」だけを信用せず、統括は新しいmaster候補上で統合検証する。

## 10. 検証と受入条件

### 10.1 必須ケース

| 分野 | 必須検証 |
| --- | --- |
| schema | 無題/keywordsなし、小節再帰、proof参照、duplicate key、壊れた数式、unknown field、path traversal、上限超過 |
| 教材 | 9章対応、全内容/数式保存、括弧title、HTML装飾の移行、原文URL、偽ページ/偽証明なし |
| グラフ | 1–9連鎖、独立系列、Part継承、循環、存在しない章、同章item依存、cross-subject拒否 |
| scope | 章5target＋1–4前提、独立章8＋7前提、兄弟混入なし、証明対象を仮定しない、catalog固定 |
| UI | 初期表示は範囲/難易度/任意数だけ、Search Title/policyなし、親部分選択、深い階層、360px、EN/JA/KO |
| 逐次生成 | 空欄で21問目以降も継続、finite N問完了、1問待ち、再試行、skip/invalid、非同期採点 |
| 競合 | next二重click/別端末/応答喪失、enqueue応答喪失、lease期限切れ、終了とworker commit競合、終了とanswer競合 |
| 保存 | 再読込/別端末、outbox未同期警告、v1テスト継続、10,000問でbounded document/read、固定review範囲 |
| 移行 | 旧MDあり/なし、旧引用参照、参照不明停止、削除再実行、checkpoint再開、backup hash不一致停止 |
| deploy | 同hash no-op、stage失敗/CAS競合、backend失敗、frontend失敗からの回復、両OS同等 |
| セキュリティ | 認証/OIDCを維持、公開DTOでsolution/rubric非漏洩、raw HTML無効、他科目・他範囲偽造拒否 |

### 10.2 実行する既存コマンド

Node 24を使用。以下は現時点で存在するscript。新規変換/移行CLIは実装後にusageを確定する。

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:mixed --prefix backend
npm run test:import --prefix backend
npm run test:math --prefix backend
npm run test:math:emulator --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run test:browser --prefix frontend -- --grep math
npm run build --prefix frontend
git diff --check
```

`test:math` が拾う `scripts/tests/math-*.test.ts` に新規純粋/契約テストを配置する。
既存 `scripts/tests/emulator/math.test.ts` とrunnerに保存/移行/競合ケースを追加する。
`frontend/tests/browser/math.pw.ts` の旧scope同意テストを新しい開始動線へ変更する。
Docker/emulatorの `./local.sh` で実データ9章の読み込み・初問・追加問・終了・再開・旧引用をsmokeする。
LLMは通常テストでmockし、実モデル検証は別に少数問で行い、回数/費用/未検証範囲を記録する。
クラウド検証は既存のpurpose=verificationを使い、学習成績へ混ぜない。

### 10.3 最終受入チェックリスト

- [ ] 6つの依頼が実画面とデータで確認できる。
- [ ] 線形代数全9章のJSONがあり、本文保持reportと8本の依存辺が確認できる。
- [ ] 教材JSON・schema・prompt・compilerの契約が一致し、デプロイでJSONだけ公開される。
- [ ] アプリから科目構造/依存を変更する入口がない。
- [ ] continuousで自然完了せず、明示終了後は新問が追加されない。
- [ ] 旧テストの回答/成績/引用/再開が保たれ、本番inventoryで生教材MD保存0件を確認した。
- [ ] README、`docs/math-category.md`、`docs/development-reference.md`、`prompt/README.md` と関連promptを更新した。
- [ ] `docs/math-verification.md` の過去結果は履歴として残し、新しい検証結果は別節/別ファイルに記録した。
- [ ] 無関係なEngineering Math資料・既存編集・語学データを変更していない。
- [ ] 統括がbranch/statusを確認し、意図した変更だけcommit、`git push origin master`、`./deploy.sh`を実行した。
- [ ] commit/push/deploy/教材公開/旧MD削除/クラウド検証を別々の結果として報告した。未実行を完了と呼ばない。

## 11. 今回の計画ファイル作成の範囲

このファイルを追加する作業では、アプリ実装、線形代数のJSON変換、本番DBの調査・削除は行わない。
リポジトリの既定の配送手順によるcommit/push/deployは、現行コードと本計画の配送であり、
本書に記載したv2機能・教材移行が完了したことを意味しない。
