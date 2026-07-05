# Plan: fix empty example-sentence translations from chip adds

Investigation date: 2026-07-05. Status: **not yet implemented** — plan saved for later execution.

## Problem (verified against Firestore `vocab-trainer-490014` / `vocab-database`)

Word **definitions are fine** — all 1,289 Chinese words have complete en/ja/ko definition
texts. What's missing for chip-added words is the **example sentence translation**.

16 Chinese `example_sentences` docs have a completely empty `translation` (`""`):

```
exs-zh-001021 exs-zh-001022 exs-zh-001037 exs-zh-001041 exs-zh-001048
exs-zh-001049 exs-zh-001051 exs-zh-001057 exs-zh-001058 exs-zh-001060
exs-zh-001061 exs-zh-001088 exs-zh-001361 exs-zh-001467 exs-zh-001994
```
(15 listed by the scan sample; re-run the scan before backfilling — see step 3.)

- 5 are owned by chip-added words (e.g. `exs-zh-001994` "他哥哥的爱好是打篮球。" owned by
  `zh-001351` 打篮球); the rest came from grammar saves without translations.

### Root cause

1. Pressing a segment chip before typing a translation sends
   `examples: [{ sentence, translation: "" }]`
   (`frontend/src/components/ExampleSentenceEditor.tsx:171-176`, same in
   `SmartAddWordModal.tsx:194-199`).
2. `POST /api/vocab/:language/smart-add` passes that empty string **verbatim** into the
   LLM user prompt (`backend/src/routes/vocab.ts:267-268`). The prompt says "Fields set
   to `null` are missing — generate them; fields with values are user-provided —
   preserve", so the LLM often echoes the empty translation.
3. The merge (`vocab.ts:330-349`) falls back to `llmEx?.translation`, also empty → the
   new ES doc is created with `translation: ""` permanently.
4. The **PUT** word route has an LLM fallback for this (`needsTranslation`,
   `vocab.ts:647-648, 715-716`, generation block at `vocab.ts:794-839`), but the
   **POST smart-add** route and the grammar path
   (`backend/src/routes/grammar.ts:resolveExamplesToIds`, ~line 52, translation used
   verbatim at ~line 116) have **no such fallback**.

### Latent sibling bug (not yet in data)

If the user *did* type a translation (single-language bare string) and the sentence is
new, `hasTranslation` short-circuits (`vocab.ts:334-339`) and the ES doc stores a bare
string — other languages are never generated. Same missing-fallback problem.

## Implementation steps

### 1. `backend/src/routes/vocab.ts` — smart-add POST

- When building `userInput.examples` (line ~267), normalize empty translations to
  `null` so the LLM generates them:
  `translation: (typeof translation === "string" ? translation.trim() : translation && Object.keys(translation).length) ? translation : null`.
- After the example-doc creation loop (lines ~442-501), collect
  `needsTranslation: { exampleId, sentence }[]` for any created/merged doc whose final
  translation is empty (`""`, `{}`, or null), and run the **same LLM generation block
  used by the PUT route** (`vocab.ts:794-839`). Extract that block into a shared helper
  (e.g. `generateMissingExampleTranslations(language, items, log)`) rather than
  duplicating it — PUT and POST both call it.

### 2. `backend/src/routes/grammar.ts` — `resolveExamplesToIds`

- After creating new ES docs with a user-supplied empty translation, call the same
  shared helper so grammar-owned examples also get translations. Note grammar has its
  own `ALL_DEFINITION_LANGUAGES` copy (grammar.ts:28); the helper should live in a
  shared module (e.g. `backend/src/exampleTranslations.ts` or firestore.ts-adjacent).
- Applies to grammar POST, smart-add, and PUT (all three `resolveExamplesToIds` call
  sites: grammar.ts:188, 265, 292).

### 3. Backfill script — `backend/scripts/backfill-empty-example-translations.ts`

- Flags: `[--language=<lang>] [--dry-run] [--limit=<n>]`, matching sibling scripts.
- Scan `example_sentences` where translation is empty (`""`, `{}`, or missing) —
  re-scan rather than hardcoding the 16 IDs above.
- Batch sentences through the same LLM prompt/schema as the PUT route's
  `vocab/translate-examples` call (reuse the shared helper from step 1), excluding the
  source language code from the requested keys.
- Write with `updateExampleSentence` (or direct doc update mirroring it). Log
  before/after counts. Add the command to CLAUDE.md's script list.

### 4. Optional cleanups (separate, low priority)

- Chip payload could include `userSplits` (space-split segments) for consistency with
  `WordFormModal`'s save contract — only affects segmentation when the chip add is the
  first writer of a brand-new sentence doc.
- Invariant drift found by `validate-invariant-all.ts --language=chinese`:
  `zh-000785` (以为) extra `appearsInIds` [exs-zh-001148, exs-zh-001147], `zh-001291`
  (咸) extra [exs-zh-001902]; orphan words `zh-000134` (位), `zh-000677` (高级),
  `en-000018` (ostensible). Repair with existing sweep/validate tooling
  (`/validate-and-modify-incompleteness` skill).

## Verification

- `cd backend && npm run build` (type-check).
- Re-run the empty-translation scan (script from investigation, or the new backfill
  script with `--dry-run`) → expect 0 after backfill.
- Manual: add a Chinese word via a segment chip with no translation typed → the new
  word's example sentence should have a multilang translation object.
- `npx tsx scripts/validate-invariant-all.ts --language=chinese` still clean (no new
  violations).
