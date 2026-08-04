# 外部ソース取り込み：単語と文の対応不一致 — 分析と解消計画（2026-08-04）

外部ソース取り込み（`POST /api/import/:language/analyze-stream`）で、文に登場しない単語がその文の配下に紐づく問題の原因分析と、四層防御による解消計画。

**状態: 実装済み（2026-08-04）。** 本ドキュメントは計画かつ設計記録として残す。本番反映には `./deploy.sh PROJECT_ID REGION --prompts`（スキーマ・プロンプトの push とリビジョン更新は一体）が必要 — §7 参照。

---

## 1. 症状と再現例

最近の中国語ソースの取り込みセッションで、次の文：

> 在2025年上半年，重庆与广州的GDP差距约为849亿元，一年间缩小约191亿元。

の配下に、この文には一切登場しない 「行政区划」「人口规模」 などの単語行が並んでいる。これらの語は**同じ記事の別の文**に登場するものであり、まとまった範囲の単語が一斉に隣の文へずれる「ブロックシフト」型の誤紐づけの徴候を示す。

被害は表示上の混乱にとどまらない：

- **誤った例文の永続化** — 誤紐づけ行から単語を登録すると、`useImportSession.ts` の `sentenceText(sentenceIndex)`（`frontend/src/hooks/useImportSession.ts:363-367`）が**誤った文**を解決し、`examples: [{ sentence: <誤った文>, … }]`（同 `:603`）として words コレクションに書き込まれる。取り込みセッションを消しても単語側に残り続ける。
- **カバレッジ保証の無音破壊** — 誤紐づけ語の接頭辞が偶然その文に存在すると、文全体が `approximate` 扱いになり、gap 行の自動生成が停止する（§2.4）。「文のすべてがカバーされる」という取り込みレビューの根本保証が、ユーザーに何も知らせずに崩れる。
- **検出・修復手段の不在** — 誤紐づけ行は通常の行と見分けがつかず（§2.3）、行を正しい文へ移動する UI もユーティリティも存在しない。merge / split / undo はいずれも `sentenceIndex` を元の値のまま引き継ぐ。

---

## 2. 原因分析

### 2.1 根本原因：単語→文の対応は「モデルが自分で数える外部キー」

解析スキーマ（`backend/DB/import/analyze_schema.json`、Firestore `config/import` にデプロイ済みの内容とバイト一致）は `words` / `grammar` を**フラットなトップレベル配列**とし、各項目に `sentenceIndex`（整数）を **required** としている。つまり単語がどの文に属するかは、**モデルが自分の出力した文リストを数え直して申告する外部キー**である。

サーバーが位置から採番するのは `sentences[].index` **だけ**である（`backend/src/routes/import.ts:106-111` — 段落を跨いでグローバルに 0 起点でカウント）。`routes/import.ts:85-90` のコメントと CLAUDE.md の「Sentence indices are assigned SERVER-side by position (schema omits them)」という記述は、この文 index のみに当てはまり、**肝心の単語→文の対応については誤り**である（`ensureDecompositionIds` との類推は、あちらでは chunk/component が文の**内側にネスト**されているからこそ成立している）。

さらに `analyze_schema.json` の `strict: true`（OpenAI structured outputs）により、モデルは**確信がなくても必ず何らかの整数を出力させられる**。省略も null も許されない。

### 2.2 プロンプト自身が矛盾している

全4言語のプロンプト（`backend/DB/import/system_prompt_analyze_{chinese,english,japanese,korean}.md`、いずれも 17-20 行目付近）：

> Sentences are numbered implicitly: … The numbering is what `sentenceIndex` below refers to — **the server assigns the indices, you only need to keep the order correct.**

一方、同じ中国語プロンプトの 66-67 行目：

> `sentenceIndex` — the index of the sentence this occurrence belongs to. Every word MUST have a valid index.

「サーバーが index を割り当てるから順序だけ守ればよい」という前段は、スキーマの required 指定および後段の「MUST have a valid index」と真っ向から矛盾し、**モデルに index を雑に扱う明示的なライセンスを与えている**。

### 2.3 検証がどこにも無く、クライアントは不一致を活用形と混同する

- **サーバー側**の検証は `inRange`（`routes/import.ts:112-121` — 整数・0 以上・文数未満）**のみ**。「`term` が指定文に verbatim に実在するか」のチェックは、サーバーにもクライアントにも一切存在しない。範囲内でありさえすれば誤った index は素通りする。
- **クライアント側** `buildImportItems`（`frontend/src/utils/importSession.ts:120-153`）は `sentenceIndex` を無検証でコピーする。`termOccurrences`（同 `:648-659` — Latin は語境界＋大小無視、CJK は素の部分文字列一致）がヒット 0 件を返した場合、**日韓の活用形分割（발표했다 → 발표하＋았다 のような正当なケース）と同一視**し、フラグを立てずに `lastOrder + 0.001` の合成順序で通常配置する（`:131-136`）。中国語には活用が無いのでヒット 0 件＝誤紐づけ確定なのに、その情報は捨てられる。
- 描画（`ImportSentenceCard.tsx:512-523`）の視覚状態は 緑＝ライブラリ既存 / 琥珀枠＝gap 行 / 灰＝その他 の3つだけで、誤紐づけ行は**正常な灰色行と完全に区別不能**。

### 2.4 `approximate` 汚染チェーン — カバレッジ保証まで壊れる

`sentenceCoverage`（`importSession.ts:688-728`）は、ヒット 0 件の単語に対して**最長接頭辞フォールバック**（`:707-717`）を実行する：接頭辞を 1 文字まで縮めながら `sentence.indexOf` で探し、見つかればその位置をカバー済みにマークし、文全体に `approximate = true` を立てる。

誤紐づけされた中国語の単語は、1 文字接頭辞（「一」「年」「约」「与」など高頻度字）が偶然その文に存在する確率が高い。すると：

1. 無関係な位置の文字が「カバー済み」と誤マークされ、
2. 文が `approximate` になり、
3. `materializeGaps`（`:558-578`）が `:565` の `if (coverage.complete || coverage.approximate) return items;` で **gap 行の生成を丸ごと拒否**し、
4. 手動の「未対応テキストを行に追加」ボタンも受動的なヒントに置き換わる（`ImportSentenceCard.tsx:289-304`）。

つまり誤紐づけ語 1 つが、その文の「すべてがカバーされる」保証を無音で無効化する。

### 2.5 失敗モード（可能性の高い順）

1. **モデルの index 数え間違い** — 数百の単語エントリそれぞれが、同じ応答の前方で生成した 20〜40 文のリストへの整数参照を要求される。長距離の簿記は注意機構が苦手とするところで、±k のずれが単語のまとまりごと隣の文に着地する。報告例のブロックシフト徴候と一致。
2. **プロンプトの矛盾文言**（§2.2）— 雑な index を明示的に許可している。
3. **段落ごとの 0 リセット誤番号付け** — グローバル連番の指示は `paragraphs` 節にしか無く、段落ごとに数え直したモデルの小さい index は必ず `inRange` を通過し、記事後半の単語が前半の文に無音で着地する。
4. **モデルの心中の文分割と emit した paragraphs のずれ** — 2 文を 1 エントリに融合（または余分に分割）すると、以降のすべての index が off-by-one で連鎖する。文分割の一致を検証するコードは無い。
5. **切り詰め出力のサイレント返却** — `llm.ts:311-312` はアイドルアボート時に途中までの蓄積文字列をそのまま返す。文リストが短く確定した場合、それより後ろを指す単語は範囲フィルタで無音破棄され、生き残った単語の index は本来より長いリストを前提に数えられている。

なお `backfillRepeatedWords`（`routes/import.ts:142-165`）は term キーのみで動作し `sentenceIndex` を読みも書きもしないため、誤紐づけの原因からは**除外**した。

---

## 3. 修正方針：四層防御

| 層 | 内容 | 効果 |
|---|---|---|
| ① 予防 | スキーマ・プロンプトを**ネスト構造**に作り替え、`sentenceIndex` をモデル契約から廃止 | 誤紐づけの主因を構造的に排除 |
| ② サーバー検証 | `normalizeAnalysis` で verbatim 実在チェック＋決定論的修復（最寄り文へ再割り当て / zh・en は不在なら drop / ja・ko は保持） | ネスト後も残りうる誤配置を吸収 |
| ③ クライアント検出・修復 | 導出ベースの不一致検出＋バッジ＋「文Nへ移動」＋一括修正バナー | **既に保存済みの破損セッションを癒す** |
| ④ カバレッジ保証 | 接頭辞フォールバックを ja/ko 限定・2 文字以上に制限 | zh/en を `approximate` 不能にし gap 生成を常に有効化 |

### ネスト構造化を採用する根拠

フラット配列への index 出力は「数百エントリにわたる index 簿記」であり、プロンプトをどれだけ強化しても信頼できない。ネスト化すれば対応付けは**位置そのもの**になり（`sentences[].index` が既に信頼できているのと同じ機構）、モデルは文を書いた直後にその文の単語を書くという**局所性**を活かせる。

新しい出力形：

```jsonc
{
  "paragraphs": [{
    "sentences": [{
      "text": "在2025年上半年，重庆与广州的GDP差距约为849亿元，…",
      "translation": "2025年上半期、重慶と広州のGDP差は…",
      "words": [
        { "term": "在", "transliteration": "zài", "meaning": "…に" },
        { "term": "上半年", "transliteration": "shàng bàn nián", "meaning": "上半期" }
      ],
      "grammar": [
        { "statement": "与+n+的+n", "description": "…", "excerpt": "重庆与广州的GDP差距" }
      ]
    }]
  }]
}
```

検討済みの懸念と、いずれも問題にならない理由：

- **ストリーミングプレビューは壊れない** — `extractStreamingSentences`（`frontend/src/api/import.ts:149-164`）は `"paragraphs"` 以降の `"text": "…"` だけを正規表現で拾う。ネストされた word（`term`/`transliteration`/`meaning`）にも grammar（`statement`/`description`/`excerpt`）にも `text` というフィールドは無いので、従来どおり文テキストだけが抽出される。スキーマのプロパティ順を `text` → `translation` → `words` → `grammar` に固定すれば（structured outputs はスキーマ順に出力する）、文テキストは単語の洪水より先にストリームされ、プレビューの応答性はむしろ向上する。
- **ワイヤ形式は不変** — サーバーの `normalizeAnalysis` がネスト形をフラット化し、従来と同じ `ImportAnalysisResult`（サーバー採番の `sentenceIndex` 付きフラット `words[]`/`grammar[]`）を返す。`analysis-result` イベント・`buildImportItems` の入力形・セッション保存形はすべて既存のまま。
- **`backfillRepeatedWords` は従来どおり動く** — 文書順（段落→文→単語）の flatten は記事順そのものであり、first-wins の継承に必要なのはそれだけ。実行順は flatten → 修復 → backfill とし、drop された偽行が継承元になれないようにする（既存の「範囲フィルタの後に実行」と同じ根拠）。
- **応答サイズはほぼ中立** — 単語ごとの `"sentenceIndex":N` が消え、文ごとの配列ラッパーが増える。切り詰め時の挙動はむしろ改善する：末尾の文が単語ごと失われる（＝欠落として見える）のであって、words 配列全体が消えたり index がずれたりしない。

---

## 4. 変更詳細（実装タスク向け）

### 4.1 バックエンド — 新規 `backend/src/import-analysis.ts`

`routes/import.ts` から純粋関数群を抽出する。テストが `firestore.js`（クライアント構築）や fastify を import せずに済むようにするため。

- **`termOccurrences(sentence, term): number[]`** — `frontend/src/utils/importSession.ts:648-659` から `LATIN_TERM`/`boundedAt` ごと**複製**（双方向の相互参照コメント付き）。共有はしない：backend/frontend は独立した npm プロジェクトで、型・ヘルパのミラーが本リポジトリの確立した慣習（`backend/src/types.ts` ↔ `frontend/src/types.ts`）。
- **`normalizeAnalysis(raw, language): ImportAnalysisResult`** — `routes/import.ts:91-122` から移設・書き換え：
  1. ネスト形をパースし、文 index を位置で採番（既存カウンタロジック）しつつ各文の `words`/`grammar` をフラット配列に flatten（その文の index を刻印）。
  2. **レガシーのフラット形フォールバック**：`parsed.words` がトップレベルに存在すれば旧経路で処理。エミュレータが旧 `config/import` スナップショットを持つ間もローカル開発が動き続ける。
  3. パイプライン：flatten → `repairWordAttribution` → `backfillRepeatedWords` → `repairGrammarAttribution` ＋ `lowercaseGrammarAbbreviations`。
- **`repairWordAttribution(words, sentences, language)`** — 決定論的修復。単語ごとに：
  1. 自文への `termOccurrences` が非空 → keep。
  2. でなければ `|index − 申告index|` 昇順（同点は小さい index）で全文を走査し、最初に verbatim ヒットした文へ**再割り当て**。ただし移動先に同 term の行が既にあれば **drop**（カバレッジは列挙済み term の全出現をマークするので冗長行）。
  3. どこにも無い場合：**zh・en → drop**（`materializeGaps` がその文字列を gap 行として必ず拾うので、情報は失われない）。**ja・ko → never drop**：活用形は verbatim 不一致が正常（발표하＋았다）で、語幹すら綴りが変わりうる（크/컸다）。自文に 2 文字以上の接頭辞ヒットがあれば keep、なければ接頭辞ベースで最寄り文を探し、それも無ければそのまま keep。
  - 修復サマリ（再割り当て・drop の件数と内訳）を返し、route が `request.log.info` する。
  - `VERBATIM_LANGUAGES = new Set(["chinese", "english"])`（バックエンドのフルネーム言語キー）。
- **`repairGrammarAttribution(grammar, sentences)`** — 新設 `excerpt` フィールド（§4.3）で同じ最寄り文ロジック。excerpt がどこにも実在しない行は excerpt をクリアして **keep**（grammar はカバレッジに関与せず、弱いシグナルで教材を捨てる方が害が大きい）。
- **`backfillRepeatedWords`・`lowercaseGrammarAbbreviations`**（＋幅正規化ヘルパ）を verbatim 移設。

### 4.2 `backend/src/routes/import.ts`

- 移設した関数を `../import-analysis.js` から import。
- `:243` の呼び出しを `normalizeAnalysis(stripMarkdownFences(raw), language)` に変更し、修復サマリをログ。
- `:85-90` の誤解を招くコメント（「schema omits them」）を修正 — ネスト化後は全 index について実際に真になる。

### 4.3 `backend/DB/import/analyze_schema.json`

- トップレベル `required: ["paragraphs"]`。`words`/`grammar` のトップレベル配列を削除。
- 文オブジェクト：`required: ["text","translation","words","grammar"]`、プロパティ定義順も**この順**（文テキストが単語群より先にストリームされることを保証）。
- word 項目：`term` / `transliteration` / `meaning`（**`sentenceIndex` 削除**）。
- grammar 項目：`statement` / `description` / **`excerpt`（新設）** — パターンを実際に実現している文中の verbatim スパン。文法の帰属を単語と同じ述語で検証可能にする。スキーマ＋プロンプトの push とリビジョンロールは一体の操作なので、後回しにすると deploy とプロンプトキャッシュ無効化が二度発生する — 今回同時に入れる。

### 4.4 プロンプト ×4（`system_prompt_analyze_{chinese,english,japanese,korean}.md`）

- §1（paragraphs）：文分割ルールは維持。「the server assigns the indices…」の段落を**削除**（index を参照するものが無くなる）。
- §2（words）：単語は**各文オブジェクトの内側**に列挙する形へ書き換え。フィールド一覧から `sentenceIndex` を削除。ハードルールを 1 行追加：「`words` エントリは**自分の文の `text` に verbatim に登場**しなければならない — 登場しない文の下に単語を置いてはならない」（ja/ko は既存の表層形・活用の但し書きを維持）。的の反復例（现行 84-86 行目）をネスト形に書き直す。**first-occurrence-only の空欄契約は不変**（ネストでも記事順は保存される）。
- §3（grammar）：同様にネスト化し、`excerpt` を文書化（「この文の中でパターンの使用を示す最短の verbatim 部分文字列」）。
- **静的プレフィックス制約の維持**：追加テキストはすべて静的本文に置き、動的な既存文法 statement の尾部（`buildAnalyzeSystemPrompt`、`routes/import.ts:74-83`）は従来どおり最後に付加。

### 4.5 型（`backend/src/types.ts` ＋ `frontend/src/types.ts` — 両方同時更新）

- `ImportExtractedGrammar` に `excerpt?: string` 追加。
- `ImportGrammarItem` に `excerpt?: string` 追加（オプショナル → 旧セッションでは単に不在）。
- **`ImportItemBase` に新フィールドは追加しない。** クライアントの不一致状態は**導出**（毎レンダーの `termOccurrences`）であり永続化しない — `status`/`target`/`error` が導出サマリである既存流儀と同じ。永続フラグは term 編集や文割り当て変更の瞬間に陳腐化するし、導出なら旧セッション互換が自動的に成立する。

### 4.6 `frontend/src/utils/importSession.ts`

- **`sentenceCoverage(sentence, words, language)`** — 第3引数を追加。接頭辞フォールバック（`:707-717`）は `language === "japanese" | "korean"` かつ**接頭辞長 ≥ 2** のときだけ実行。zh/en はヒット 0 件の単語が何もマークせず、`approximate` を立てることが**構造的に不可能**になる → 報告ケースでも gap 生成と手動ボタンが復活し、カバレッジ保証が回復する。
- **`materializeGaps(items, sentenceIndex, sentenceText, language)`** — language パススルー。
- **`buildImportItems(analysis, existing, existingGrammar, language)`** — `materializeGaps` ループ（`:170-172`）へ language を渡し、grammar 行へ `excerpt` をコピー（`:154-167`）。
- 新規純粋関数：
  - **`wordMismatch(sentenceText, term, language): boolean`** — zh/en：verbatim ヒット 0 件。ja/ko：verbatim 0 件**かつ** 2 文字以上の接頭辞ヒットも無し。行レンダラ・バナー件数・一括修復が共有する単一の述語。
  - **`countMismatchedWords(items, sentences, language): number`**。
  - **`reattachMismatchedWords(items, sentences, language): ImportItem[]`** — ライブな不一致 word 行ごとに：バックエンド `repairWordAttribution` と**一字一句同じ規則**の最寄り文探索で verbatim ヒットした文へ**移動**（`sentenceIndex` 書き換え＋`order` = 最初のヒットオフセット）。移動先に同 term のライブ行があれば**トゥームストーン**（`status: "skipped"` — セッションは完全な記録を保つ既存流儀）。どこにも合わなければフラグ付きで残置（手動対応用）。最後に **移動元の文のみ** `materializeGaps` を再実行（移動で失われたカバレッジの補填。全面再実行はユーザーが意図的に消した gap 行を復活させてしまう — これがロード時に gap を再実行しない既存判断を守る理由）。

### 4.7 フロントエンド コンポーネント

- **`ImportSentenceCard.tsx`**（`WordRow` は language を props 経由で既に保持）：`wordMismatch` 真のとき**第4の視覚状態** — ローズ枠＋「文に不一致」バッジ（緑＝既存 / 琥珀＝gap / 灰＝通常 と区別）。一意な最寄り候補が存在すれば「文Nへ移動」ミニボタン（その行 id にスコープした `reattachMismatchedWords` を `onSetItems` 経由で適用）。**zh/en の不一致行は A/B 登録ボタンを無効化**（誤例文の永続化を止める — §1 の被害経路の遮断）。ja/ko は確定できないため登録可のまま。`sentenceCoverage`/`materializeGaps` 呼び出し（`:185`, `:296`）へ language を渡す。
- **`ImportReview.tsx`**：不一致件数 > 0 のとき文リスト上部にバナー「N件の単語が文と一致しません — 自動修正」→ `reattachMismatchedWords` を immediate flush で適用。**明示アクションのみ、ロード時自動修復はしない** — autosave が undo 無しの一括書き換えを無確認で永続化してしまうため。新規解析はサーバー側で修復済みなので、このバナーは実質レガシーセッション専用。`gapsBySentence` メモ（`:60`）へ language を渡す。
- **`ImportView.tsx`**：`buildImportItems` 呼び出し（`:148`）へ language を渡す。

---

## 5. 既存セッションの互換と修復

- **データ移行は不要。** 保存済み `ImportSession.items` の構造は不変（`excerpt` はオプショナル追加のみ）。不一致検出は導出なので、破損セッションを開いた瞬間にバナーとローズ行が現れ、明示ボタン一発で修復 → 既存の autosave（PUT）が修正済み items を永続化する。
- **登録済みの誤紐づけ語**には既に誤った例文が書かれている。本計画のコード変更の対象外だが、是正経路を記しておく：対象は列挙可能（`existingWordId` を持つ不一致行）。単語編集 UI での手直し、または `backend/scripts/` の流儀に沿ったワンオフスクリプトで対応する。既存の `validate-invariant-all.ts` は参照整合性のみを検査し、例文テキストの正しさは扱わない。
- **旧 config × 新コードの窓**：`normalizeAnalysis` のレガシーフラット形フォールバック（§4.1）が吸収する（ローカルエミュレータの旧 `config` スナップショット含む）。

---

## 6. テスト計画（テスト基盤の初導入）

本リポジトリにはテスト基盤が存在しない（テストランナー依存なし、テストファイルのコミット履歴なし）。今回の対象は純粋関数中心でテストに最適なため、最小構成で導入する：

- **バックエンド：`node:test` ＋ tsx（新規依存ゼロ** — tsx は既に devDependency）。`backend/package.json` に `"test": "tsx --test src/import-analysis.test.ts"` を追加。新規 `backend/src/import-analysis.test.ts`：
  - ネスト形の flatten と段落跨ぎのグローバル採番
  - レガシーフラット形フォールバック
  - `repairWordAttribution`：最寄り再割り当て（同点タイブレーク含む）／移動先重複 drop／zh・en の不在 drop／ja・ko の never-drop と接頭辞 keep
  - 修復 → `backfillRepeatedWords` の実行順序（drop された行が継承元にならない）
  - `repairGrammarAttribution` の excerpt 再割り当てとクリア
  - **報告事例の再現フィクスチャ**：「行政区划」「人口规模」を GDP 文に誤紐づけした入力が、正しい文へ移動（または drop）されること
- **フロントエンド：vitest（devDependency 1 つ追加** — Vite プロジェクトの標準）。`frontend/package.json` に `"test": "vitest run"`。新規 `frontend/src/utils/importSession.test.ts`：
  - `sentenceCoverage` の言語規則（zh が `approximate` 不能／ja の接頭辞 ≥2／1 文字接頭辞が汚染しない）
  - `wordMismatch` の言語別判定
  - `reattachMismatchedWords` の move / tombstone / 残置と、移動元限定の gap 再生成
  - 破損フィクスチャでの `buildImportItems` エンドツーエンド
- 実装時に CLAUDE.md の「No test or lint commands are configured」行を更新する。

---

## 7. ロールアウト手順と検証

1. **ユニットテスト**：`cd backend && npm test`、`cd frontend && npm test`、`cd frontend && npx tsc --noEmit`。
2. **ローカル E2E**：`docker compose up -d firestore` → `./local.sh dev`（空なら自動シード）→ **新プロンプト・スキーマをエミュレータへ push**：
   ```bash
   cd backend && FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/migrate-db-config-to-firestore.ts --prompts
   ```
   （インライン環境変数で。`.env` には決して書かない）→ **バックエンド dev プロセスを再起動**（`config/import` はプロセス寿命でメモ化される — `routes/import.ts:171-180`）。
3. **報告の中国語記事を取り込み**：全単語行の term が自分の文に verbatim 実在すること／GDP 文に「行政区划」「人口规模」が無いこと／全 zh 文のカバレッジが ✓ か、動作する「行に追加」ボタン（受動ヒントではなく）を示すこと／1 語登録して Browse で正しい例文が付いていること。
4. **レガシーセッション経路**：旧 config のまま 1 回取り込む、またはエミュレータ REST API でセッション doc に誤紐づけを細工 → 再オープン → バナーが正しい件数で出る → 一括修正 → 決定論的な移動・トゥームストーン・移動元の gap 再生成 → autosave 永続化 → 登録で正しい例文。
5. **ja / ko の取り込み**：活用形行がフラグも drop もされないこと、`approximate` ガードが従来どおり機能すること。
6. **本番**：`./deploy.sh PROJECT_ID REGION --prompts`（config push とリビジョンロールは設計上一体）→ 実際の破損セッションを開き、バナー → 一括修正 → GDP 文をスポットチェック。

実装内の推奨順序：バックエンドモジュール＋テスト → スキーマ・プロンプト → フロントエンド → ローカル E2E → デプロイ。フロントエンド層は単独でも出荷可能（それだけで保存済みセッションは癒える）。

---

## 8. 対象外・今後の課題

- **grammar 行のカバレッジ除外は継続** — `statement` はパターン記法であり位置照合できないという前提は不変（`excerpt` は帰属検証にのみ使い、カバレッジには関与させない）。
- **ja / ko の形態素対応マッチング** — 接頭辞 2 文字ヒューリスティックより精密な活用形照合は将来課題。
- **CLAUDE.md の更新**（実装時）：`routes/import.ts` の解説にある「Sentence indices are assigned SERVER-side by position (schema omits them…)」の誤り訂正、`backfillRepeatedWords`「unit-tested」記述の実態化、「No test or lint commands」行の更新。
