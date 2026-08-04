# word_index の doc パス破壊：「/」を含む語による 500 — 分析と修正計画（2026-08-04）

外部ソース取り込みのレビューから単語を登録（smart-add）した際、例文中の記号混じりトークンが Firestore のドキュメント ID に生で埋め込まれ、パスとして不正になり 500 を返す問題の原因分析と修正計画。

**状態: 実装済み（2026-08-04）。** WS1〜WS4 をすべて適用済み。本ドキュメントは計画かつ設計記録として残す。検証結果は §7 末尾を参照。デプロイ後に一度 `sweep-orphaned-word-index.ts --all --dry-run` を実行して MISKEYED を確認すること（§7-8）。

> 実装上の注意（先に読むこと）: `backend/src/import-analysis.ts` と `frontend/src/utils/importSession.ts` は文字列リテラル中の NUL バイトのため ripgrep にバイナリ扱いされる。検索には `grep -a` か Read ツールを使うこと。行番号は 2026-08-04 時点（コミット `c5581a3` 前後）のもの。

---

## 1. 症状と再現

外部ソースのレビュー画面から 「新一代」 を Group B へ登録した際：

```
× "新一代" failed: ApiError: API error: 500 –
{"statusCode":500,"error":"Internal Server Error","message":"Value for argument
\"documentPath\" must point to a document, but was \"chinese_09988.HK/NYSE : BABA\".
Your path does not contain an even number of components."}
```

- エラーは単語キューのトースト（`frontend/src/components/Dashboard.tsx:971`）と、行の ✗ バッジ（`frontend/src/components/import/ImportSentenceCard.tsx:1029-1037`）に表示される。
- **データは失われていない**：失敗した create は単語ドラフトとして救出され（`frontend/src/hooks/useWordQueue.ts:161-182`）、セッション行は `status:"failed"` とエラーを保持する。クラッシュはあらゆる書き込みの前に起こる（§2）ので、修正後の再登録はクリーンに通る。
- **LLM 抜きの決定的再現**（クラッシュ行は共通）：
  - `POST /api/vocab/chinese/check-terms`、body `{"terms":["09988.HK/NYSE : BABA"]}` → 現状 500。
  - `GET /api/vocab/chinese/lookup?term=a/b` → 現状 500。

---

## 2. 原因分析

### 2.1 根本原因：ドキュメント ID に生の語テキストを埋め込んでいる

`word_index` のドキュメント ID は **読み書き両側とも** `${language}_${term}` である（term キー方式。数値の word id は ID ではなく**フィールド** `id` に格納される — `backend/src/firestore.ts:456-462`）。`/` は Firestore のパス区切り文字なので、`/` を含む語は「ID」を複数コンポーネントのパスに変えてしまう：`word_index/chinese_09988.HK/NYSE : BABA` は 3 コンポーネント（奇数）となり、`CollectionReference.doc()` が**同期的に** throw する。これが引用されたエラーメッセージそのものである。

### 2.2 今回のクラッシュ連鎖（`POST /api/vocab/chinese/smart-add`、語は 新一代）

1. 取り込み画面が送るのは `{term, examples:[{sentence, translation:""}], groupIds}` のみ — **`userSplits` は送っていない**（`frontend/src/hooks/useImportSession.ts:585-605`）。問題の文字列はクライアント入力ではない。
2. smart-add の LLM が例文をセグメント分割し、そのセグメントがユーザー提供の例文に引き継がれる（`backend/src/routes/vocab.ts:366-370`。パースは `:403-424` で、非空文字列チェックのみ）。モデルは銘柄注記 「09988.HK/NYSE : BABA」 を**1 セグメント**として出力した。中国語プロンプト（`backend/DB/vocabulary/smart_add_prompt_chinese.md:72`）は「句読点は独立セグメントに」とすら指示しており、単独の 「/」 セグメント 1 個でもクラッシュする。
3. `vocab.ts:470-476` がセグメントテキストのユニーク集合を集めて `lookupWordsByTerms(language, texts)` を呼ぶ → **`firestore.ts:1408`** の ``wordIndex.doc(`${language}_${t}`)`` が throw → ハンドラで捕捉されず 500。
4. クラッシュは `getNextWordId`（`vocab.ts:487`）より前 → smart-add に**部分書き込みはない**。

### 2.3 なぜ取り込み経路だけが踏むのか

手動フローはすべて `userSplits` を `trimmed.match(/[\p{Script=Han}a-zA-Z]+/gu)` で導出する（`WordFormModal.tsx:129-131`、`SmartAddWordModal.tsx:354-357`、`WordList.tsx:213`、`GrammarFormModal.tsx:311`、`GrammarList.tsx:415`）— 数字・`.`・`/`・`:`・空白はバックエンドに届く前に剥がされる。取り込み経路は trim のみで、サーバー側 LLM セグメント分割が無濾過で走る。

### 2.4 影響範囲（同じ生埋め込み。すべて「/」を含む語で throw する）

- `firestore.ts:1392` `lookupWordByTerm` — smart-add の重複チェック（`vocab.ts:260`）と `GET /:language/lookup`（`vocab.ts:163-182`）。
- `firestore.ts:456 / 528 / 560 / 562 / 646` — `addWord` / `updateWord` / `deleteWord`。つまり **「/」を含む語は CRUD 全体で扱えない**（"and/or"、"24/7" は登録すら不可能）。
- `vocab.ts:1093-1101` check-terms — 取り込み画面から 「/」入りの行 term で到達し得る（文中テキスト選択追加 `ImportSentenceCard.tsx:136-137`；`mergeWordItems` のスパン `importSession.ts:233-245` は 「HK/NYSE : BABA」 を生成し得る）。`useImportLibraryStatus.ts:128` は 500 を握りつぶして**無限リトライ**する。
- `vocab.ts:749 / 786 / 872`（PUT の再セグメント）— `:872` は `addExampleSentence(:800)` / `updateExampleSentence(:770)` の**後**、`updateWord(:927)` の**前**に走る → throw すると単語から参照されない example ドキュメントが残る（dangling）。
- `grammar.ts:106` `resolveExamplesToIds`（書き込み前 — クリーンに失敗）、`firestore.ts:1300` `updateSegmentWordLinks`、`import.ts:131` の解析時存在チェック（`:146` で捕捉され SSE の error イベントになる）、`grammar-quiz.ts:321 / 431`（`:431` が最悪：`:415` で example コミット後に addWord。ただしこのエンドポイントは UI から未使用）。
- スクリプト：`backfill-segment-word-ids.ts:53`、`backfill-missing-segments.ts:72`、`fix-word-index-entry.ts:50`、`migrate-example-sentences.ts:150`、`migrate-to-firestore.ts:244`、`seed-download.ts:264`。
- **二次的な罠**：コンポーネント数が偶数になる語（`"A/B/C"`）は throw **しない** — ネストしたサブコレクションへ黙って書き込まれ、`where("language","==",…)` の走査から不可視になる（クラッシュより悪い）。
- **CLAUDE.md:190 は事実誤認**：「`word_index` は `{language}_{wordId}`」と書かれているが、それが正しいのは `progress` / `flagged_words` のみ（§6 で修正）。

### 2.5 検証済みの設計制約（修正方式を決めるもの）

- **doc ID から term を逆算するコードはどこにも無い** — 読み手は全員フィールドの `term` を使う（`wordEntryIsLive` `firestore.ts:1384-1389`；sweep / smoke / unify 各スクリプトはフィールドクエリ＋ `doc.id` の素通し；`seed-load.ts:93` は保存済み ID をそのままラウンドトリップ）。→ エンコーディングに**デコード経路は不要**。
- **「/」を含む語は現 DB に存在し得ない**（あらゆる書き込み経路がコミット前に throw していた）→ 「現在格納可能な語に対して恒等」なエンコーディングは**移行ゼロ**で導入できる。唯一の但し書き：`%` を含む語（例 "100%"）は現在格納**可能**であり、リマップ対象になる — WS1.4 の sweep 拡張で監査・修復する（0 件想定）。
- `lookupWordsByTerms` の呼び出し元はすべて map / set セマンティクス — スキップされた語は単に「該当なし」となり、レスポンス形状は変わらない。`check-terms` はヒットのみから `{existing}` を組む（`vocab.ts:1098-1099`）。

---

## 3. 修正 WS1 — doc-ID 層のクラッシュ防止（本命修正）

### WS1.1 純粋モジュール `backend/src/word-index-id.ts`（新規）

`node:crypto` のみを import する純粋モジュールとする。`firestore.ts` の中には**置かない**（あちらはロード時に Firestore クライアントを構築する `firestore.ts:43-50` — ユニットテストとスクリプトが引き込んではならない）。スクリプトが純粋 src モジュールを import する前例：`scripts/audit-word-example-fit.ts` の `../src/import-analysis.js`。

```ts
import { createHash } from "crypto";

const MAX_DOC_ID_BYTES = 1500;

/** バルク検索ガード（WS2.1）：文字も数字も含まない term は語彙たり得ない。
 *  単発検索（lookupWordByTerm）には適用しない。 */
export function isLookupableTerm(term: string): boolean {
  return /[\p{L}\p{N}]/u.test(term);
}

/** word_index/{language}_{term} の doc ID。
 *  - "%" も "/" も含まない term（＝この関数導入前に格納可能だった全 term）には恒等 → 移行ゼロ。
 *  - "%" / "/" を含む term はパーセントエンコード："%" を先に（エスケープ文字自身を先に潰す）、次に "/"。
 *  - 1500 UTF-8 バイト超、または予約形 __…__ に一致する ID は
 *    `${language}_%23${sha256(term).hex.slice(0,32)}` へフォールバック。
 *  呼び出し側は常に RAW の term を渡すこと（エンコード済み値を渡してはならない）。 */
export function wordIndexDocId(language: string, term: string): string {
  const suffix = /[%/]/.test(term)
    ? term.replace(/%/g, "%25").replace(/\//g, "%2F")
    : term;
  const id = `${language}_${suffix}`;
  if (Buffer.byteLength(id, "utf8") > MAX_DOC_ID_BYTES || /^__.*__$/.test(id)) {
    return `${language}_%23${createHash("sha256").update(term).digest("hex").slice(0, 32)}`;
  }
  return id;
}
```

doc コメントに以下の 2 論証を必ず書くこと：

- **単射性**：出力は互いに素な 3 クラスに分かれる。(1) 恒等出力は `%` を一切含まない（`%` を含む term はエンコード側に回る）。(2) エンコード出力の `%` は必ず `25` か `2F` が後続する — エスケープ文字を先に潰す標準パーセントエンコーディングは単射。(3) ハッシュフォールバック出力は `${language}_` 直後に `%23` マーカーを持ち、これは恒等出力（`%` なし）にもエンコード出力（`%` の後続は `25`/`2F` のみ）にも現れ得ない。フォールバック内の衝突は sha256 の 128 ビット接頭辞衝突に限られる。**置換順序（`%` → `/`）が正しさを担う**：逆順だと挿入したばかりのエスケープが破壊される。
- **移行ゼロ**：既存の doc ID はすべて Firestore に受理されたものなので `/` を含まず、1500 バイト以下で、`__…__` に一致しない。そのうち `%` も含まない term に対して本関数は厳密に恒等。合成 ID は必ず `_` を含むので `.` / `..` にはなり得ない。

### WS1.2 `firestore.ts` の全 7 箇所に適用

`{ wordIndexDocId }` を import し、生埋め込みを置換する：

| 箇所 | 関数 | 置換 |
|---|---|---|
| `:456` | `addWord`（batch set） | `wordIndex.doc(wordIndexDocId(language, word.term))` |
| `:528` | `updateWord` の改名衝突チェック read | `wordIndex.doc(wordIndexDocId(language, updates.term))` |
| `:560` | `updateWord` 旧エントリ delete | `wordIndex.doc(wordIndexDocId(language, oldTerm))` |
| `:562` | `updateWord` 新エントリ set | `wordIndex.doc(wordIndexDocId(language, newTerm))` |
| `:646` | `deleteWord`（最終 batch delete） | `wordIndex.doc(wordIndexDocId(language, term))`（term は `:581` で word ドキュメントのフィールドから取得済み） |
| `:1392` | `lookupWordByTerm` | `const docId = wordIndexDocId(language, term);` |
| `:1408` | `lookupWordsByTerms` | `chunk.map((t) => wordIndex.doc(wordIndexDocId(language, t)))` |

これらが `src/` 内の term キー構築の**全部**である（`firestore.ts:2107/:2127` はシステム生成の `componentId`、`progress` / `flagged_words` は wordId キーで対象外）。

### WS1.3 スクリプト 6 箇所に適用

各自 `import { wordIndexDocId } from "../src/word-index-id.js"`（各スクリプト固有の `_project-env` / Firestore クライアント初期化はそのまま）：

- `backend/scripts/backfill-segment-word-ids.ts:53`
- `backend/scripts/backfill-missing-segments.ts:72`
- `backend/scripts/fix-word-index-entry.ts:50`
- `backend/scripts/migrate-example-sentences.ts:150`（`:151-152` は id キーなので触らない）
- `backend/scripts/migrate-to-firestore.ts:244`（ソースディレクトリは空だが一貫性のため）
- `backend/scripts/seed-download.ts:264`

変更不要：`seed-load.ts`（保存済み ID の素通しラウンドトリップ `:93`）、`sweep-orphaned-word-index.ts`（フィールド読み — ただし WS1.4 参照）、`unify-chinese-levels.ts`、`smoke-test-invariant.ts`。

### WS1.4 `sweep-orphaned-word-index.ts` に **MISKEYED** クラスを追加

`sweepLanguage` 内で、健全なエントリ（`actualTerm === term`、`:99` 付近）についても `doc.id !== wordIndexDocId(lang, term)` を追加チェックする。該当したら MISKEYED と分類し、修復は「正しい ID に set（`{language, term, id, transliteration, level}` をフィールドから再構成）＋旧 ID を delete」。既存クラス同様 dry-run 可能にし、サマリーに `miskeyed` カウンタを追加する。これが `%` 入り term の一回限りの監査（0 件想定）であり、恒久的な修復経路でもある。

### WS1.5 ユニットテスト `backend/src/word-index-id.test.ts`

node:test + `assert/strict`、`backend/src/import-analysis.test.ts` に倣う。**src/ 直下に置くこと**（runner は `tsx --test src/*.test.ts` — `backend/package.json:13`）。ケース：

- 「従来格納可能だった term すべてに恒等」— CJK（新一代）、空白・コロン入り Latin（スラッシュ抜きの `09988.HK NYSE : BABA`）、数字、アポストロフィ、空文字列。
- 「`/` をエンコードして ID が 1 パスコンポーネントに収まる」— `wordIndexDocId("chinese", "09988.HK/NYSE : BABA") === "chinese_09988.HK%2FNYSE : BABA"`；単独 `"/"` → `"chinese_%2F"`；どの出力にも生の `/` が含まれない。
- 「`%` を `/` より先にエスケープするので別 term が同じ ID を共有しない」— `("chinese","a/b") → "chinese_a%2Fb"` と `("chinese","a%2Fb") → "chinese_a%252Fb"` の不一致を assert。
- 「1500 バイト超はハッシュフォールバック」— 600 字の CJK term（3 バイト/字）：結果が `"chinese_%23"` で始まり、決定的で、異なる過長 term 同士は異なる。
- 「予約形 `__…__` はフォールバック」— 例 `wordIndexDocId("__lang", "x__")`。
- 「フォールバックマーカー `%23` は恒等・エンコード出力に現れ得ない」— `%2`、`%`、`#` を含む term をエンコードし、`_%23` の位置に現れないことを assert。
- 「`isLookupableTerm` は文字か数字を受理し、純記号を拒否」— true: `"的"`, `"GDP"`, `"24/7"`, `"849亿元"`；false: `"/"`, `"："`, `"。"`, `"……"`, `""`, `" : "`。

---

## 4. 予防 WS2 — 境界での入力衛生

### WS2.1 `lookupWordsByTerms` 冒頭のバルク検索ガード

`firestore.ts:1402` の関数先頭に `terms = terms.filter(isLookupableTerm);`（`./word-index-id.js` から import）。ここが単一のチョークポイントで、全呼び出し元 — smart-add のセグメントリンク、PUT、check-terms、`grammar.ts:106`、`import.ts:131`、`grammar-quiz.ts:321`、`firestore.ts:1300`、`scripts/reanalyze-import-session.ts`（`../src` から本物を import している）— が自動的に恩恵を受ける。述語が `\p{L}|\p{N}`（`\p{L}` 単独では**ない**）なのは意図的：WS1 で「/」入り語が格納可能になる以上、"24/7" のような文字なし語彙が「登録できるのに check-terms から永遠に不可視」という新しいサイレント故障を作らないため。純句読点セグメント（`/`、`：`、`。`、`……`、`%`）はすべて弾かれ、読みコストの節約はそのまま得られる。**`lookupWordByTerm`（単発）には適用しない** — 重複チェック（`vocab.ts:260`）での偽陰性は重複作成を許してしまう。

### WS2.2 プロンプトの「数字・句読点は対象外」規則をコードで強制

`backend/src/import-analysis.ts` `repairWordAttribution` のパス 1（`:231-241`）で、既存の空 term ドロップの直後に「term が `\p{L}` を 1 文字も含まない行」をドロップする（`target[i] = null`）。述語を `\p{L}` のみにするのは意図的で、フロントの `needsCoverage`（`frontend/src/utils/importSession.ts:629-631`）と鏡合わせ — ドロップした行の文字がクライアント側で可視のカバレッジギャップとして残らない（`materializeGaps` がカバーするのは `\p{L}` のみ）。文字入りスラッシュ語（`09988.HK/NYSE`）は**残す** — 正当であり WS1 後は安全。

- 新サマリーフィールド `nonLexical: number` を `AttributionRepairSummary`（`:160-172`）、`emptySummary()`、`repairChangedAnything`、`normalizeAnalysis` のマージに追加する。**既存の `dropped` / `redundant` カウンタが集計されている実際の箇所に倣うこと**（パス 1 の現行の空 term ドロップ自身はカウントを増やしていない — 実際の集計サイトを探して鏡写しにする）。`samples` にも 1 行入れる（例：`dropped "…" (no letters)`）。
- サマリーの消費者はログのみ（`import.ts:119-123`）＋ `reanalyze-import-session.ts` — SSE の `analysis-result` イベントにサマリーは載らないので、フロントエンドへの影響はゼロ。
- テスト（`backend/src/import-analysis.test.ts` に追加）：`"2025"`、`"……"`、`"/"` の行がドロップされ `nonLexical` に計上される；文中に実在する `"GDP"` と `"09988.HK/NYSE"` は残る；ネスト形 JSON 経由の `normalizeAnalysis` でもサマリーに現れる。

### WS2.3 （低優先）smart-add ボディスキーマに `userSplits` を宣言

`vocab.ts:232-241` の examples アイテムに `userSplits: { type: "array", items: { type: "string" } }` を追加。現状は examples アイテムスキーマに `additionalProperties: false` が無いおかげで**偶然**生き残っているだけで、将来スキーマを締めた瞬間にチップフローが黙って壊れる。挙動変更なし、契約の文書化。

---

## 5. CRUD 堅牢化 WS3 — 途中書き込みの防止

**方針：`PUT /:language/:wordId` の 3 つのエンリッチメント検索（`vocab.ts:748-754` / `:784-791` / `:871-873`）を try/catch で包み、失敗時はログして空のマッチマップで続行する（セグメントは word id リンクなしで格納される）。並べ替えはしない。**

根拠（ドキュメントとコードコメントに残すこと）：

1. `:872` を書き込み群の前に移すことは構造的に不可能 — `needsResegment` は書き込みループの**中で**発見され、その入力は例文ごとの書き込み判断に依存する。
2. このルートは隣の LLM 呼び出しでまったく同じ「途中で 500 にせず劣化させる」哲学を既に成文化している（`vocab.ts:832-836` のコメント、`:847` / `:861` の catch）。
3. リンク欠落はまさに `POST /:language/sync-segment-links`（`vocab.ts:1004`、実体は `firestore.ts:updateSegmentWordLinks`）と `scripts/backfill-segment-word-ids.ts` が修復するために存在する故障モードである。
4. WS1 後に残る throw クラスは一過性の Firestore エラーのみで、そこで途中中断することはリンク欠落より厳密に悪い。

書き込み**前**にクリーンに失敗する箇所はガードしない（smart-add `:476`、`grammar.ts:106`、`firestore.ts:1300` — 失敗即 4xx/5xx で副作用なし）。

**`grammar-quiz.ts` add-missing-words（`:329-441`）は明示的にスコープ外**：WS1 がこのエンドポイント唯一の決定的 throw（`:415` の example コミット後の addWord）を除去し、UI からの呼び出しは存在しない。書き込み順の再設計はしない — この判断を記録として残す。

---

## 6. ドキュメント WS4

- **CLAUDE.md:190 の修正**（事実誤認）：`progress` / `flagged_words` が `{language}_{wordId}`；**`word_index` は `{language}_{term}`** で、数値 id は**フィールド** `id` に格納。term 成分は `wordIndexDocId()`（`backend/src/word-index-id.ts`）を通る — 通常の term には恒等、`%` / `/` はパーセントエンコード、1500 バイト超・`__…__` 形はハッシュフォールバック — ため、任意のユーザー/LLM テキストが不正なドキュメントパスを生むことはない。`example_sentence_index` の `{language}_{sha256(sentence).slice(0,16)}` はそのまま。
- CLAUDE.md の `sweep-orphaned-word-index.ts` の行（`:39` 付近）：MISKEYED クラスを追記。
- CLAUDE.md の smart-add / import 該当箇所：WS2.1（バルク検索の文字数字ガード）、WS2.2（`nonLexical` ドロップ）、WS3（PUT のリンク劣化）を各 1 行で追記。
- 実装完了後、本ドキュメント冒頭の状態行を 「実装済み（日付）」 に更新する（隣の計画書の慣例に倣う）。

---

## 7. 検証手順

1. `cd backend && npm test` — 新規 `word-index-id.test.ts` ＋ 拡張 `import-analysis.test.ts` ＋ 既存スイートすべて green。
2. `docker compose up -d firestore` → `cd backend && npm run seed:load` → `.\local.ps1 dev`（または `npm run dev:local` ＋ frontend `npm run dev`）。
3. **LLM 抜きの決定的 before/after チェック**：`POST /api/vocab/chinese/check-terms` に `{"terms":["09988.HK/NYSE : BABA","的"]}` — 修正前 500 / 修正後 200 で `existing` は実在ヒットのみ。`GET /api/vocab/chinese/lookup?term=a/b` — 修正後は 404（500 ではない）。
4. **PUT の途中書き込み経路**：シード済み中国語 wordId に、セグメント `[{"text":"09988.HK/NYSE"},{"text":"上市"}]` を持つ例文で PUT → 200。スラッシュセグメントはリンクなしで格納され、dangling な example ドキュメントが残らない（word の `exampleIds` が作成物をすべて参照している）。
5. **smart-add ラウンドトリップ**（エミュレータに LLM 設定が必要：`migrate-llm-config-to-firestore.ts` がエミュレータ env を尊重するか確認の上 `FIRESTORE_EMULATOR_HOST=localhost:8080` で実行。不可ならこのステップはスキップ）：例文 「阿里巴巴（09988.HK/NYSE : BABA）发布了新一代产品。」 で 新一代 を smart-add → 201、word と `word_index/chinese_新一代` が作成される。
6. **「/」入り語の格納**：english で `and/or` を smart-add → 201；check-terms が発見する；改名と削除まで通す（エンコード経路の `updateWord` / `deleteWord` を行使）。
7. `npx tsx scripts/validate-invariant-all.ts` と `npx tsx scripts/smoke-test-invariant.ts` をエミュレータに対して — green。
8. デプロイ後に一度：`npx tsx scripts/sweep-orphaned-word-index.ts --all --dry-run` → MISKEYED は 0 件想定（`%` 入り term の監査）。>0 なら `--dry-run` を外して再実行。
9. 取り込み画面：BABA の行を含む記事を解析。ネットワークタブで check-terms の無限リトライが**消えている**こと、文中選択で追加した `HK/NYSE` チップがスピンし続けずに解決（✓ または追加可能）することを確認。

### 実装時の検証結果（2026-08-04）

- `cd backend && npm test` → **33/33 pass**（新規 `word-index-id.test.ts` 7 件、`import-analysis.test.ts` に 3 件追加）。`npx tsc --noEmit` はバックエンド・フロントエンドともエラーなし（フロントの vitest 型エラーは本変更前から存在する dev 依存未インストールによるもの）。
- エミュレータ（`docker compose up -d firestore` ＋ `migrate-db-config-to-firestore.ts --prompts` を `FIRESTORE_EMULATOR_HOST` 付きで実行）に対して：
  - `POST /api/vocab/chinese/check-terms` に報告された文字列そのもの（`"09988.HK/NYSE : BABA"` ほか `"and/or"`, `"a/b/c"`, `"/"`, `"100%"`）→ **HTTP 200 / `{"existing":{}}`**（修正前は 500）。
  - `addWord("and/or")` → `word_index/english_and%2For` に格納され、`lookupWordByTerm` / `lookupWordsByTerms` の双方が発見。改名（`updateWord`）で旧キーが消えて新キーに移り、`deleteWord` で消える — エンコード経路の CRUD が一巡。
  - 偶数コンポーネントになる `"a/b/c"` も `english_a%2Fb%2Fc` に収まり、サブコレクションに漏れない。
  - バルク検索が `"/"`, `"。"` を読み取り前にスキップすることを確認。
- **未実施**（LLM 設定が必要なため）：§7-5 の smart-add ラウンドトリップと §7-9 の取り込み画面での目視確認。デプロイ後に実アプリで確認すること。

---

## 8. スコープ外（記録のみ。修正しない）

- smart-add は `ALLOWED_LANGUAGES` ゲートなしに任意の `:language` を自動作成する（`vocab.ts:251-253`。`POST /:language/file` にはゲートがある）— 既存の別問題。
- `grammar-quiz.ts` add-missing-words の書き込み順（UI 未使用。§5 で descope 済み）。
- 失敗した 新一代 の登録試行はドラフトとして救出されている可能性がある — ドラフトパネルからのクリーンアップはユーザー操作。
- フロントエンドの変更は不要：`useImportLibraryStatus.ts:128` の無限リトライは 500 が餌であり、check-terms が 200 を返せば止まる。キュートーストとドラフト救出も修正後は自然に解消する。

---

## 実装順序

WS1.1＋WS1.5（純粋ヘルパー＋テスト）→ WS1.2 / 1.3 / 1.4（適用）→ WS2.1 / 2.2（＋テスト）→ WS3 → WS2.3 → WS4 → §7 検証。WS1 単独で報告された 500 は解消する。各 WS は独立して出荷可能。
