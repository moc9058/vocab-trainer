# Plan: translation quality (user context) + speed

Investigation date: 2026-07-05. Status: **not yet implemented**.

## Current structure (verified)

Two-step pipeline in `backend/src/routes/translation.ts`:

1. **Decompose** (MINI model, streaming, blocking): source-language-specific prompt
   (`config/translation.decomposePrompts`, local source `backend/DB/translation/
   system_prompt_decompose_*.md`) produces the full structural tree — sentences →
   chunks → components, each component carrying `componentId` ("s1c2p3"), `surface`,
   `baseForm`, `reading`, `partOfSpeech`. Step 2 cannot start until this completes.
2. **Translate** (FULL model, streaming, parallel per target language — in practice
   always exactly one, the active study language): slim input (sentences + flat
   chunks/components), output = `passages[] + chunks[] (meaning) + components[]
   (meaning, explanation)`, merged back onto the decomposition by ID in
   `mergeTranslation`. `buildTranslateSystemPrompt` appends source/target +
   approach guidance to the Firestore base prompt **in code** — no prompt migration
   needed for appendix-style changes.

Frontend: `TranslationView.tsx` (input → loading → results phases; loading shows the
raw streaming JSON tail, last 500 chars). `api/translation.ts` parses the SSE events.
No context/situation input exists anywhere. `TranslationEntry` = { sourceLanguage,
sourceText, targetLanguages, results, createdAt }.

Latency profile: total ≈ decompose output tokens (MINI) + translate output tokens
(FULL), fully serial between steps. Both outputs are ID-heavy JSON. The user sees
nothing readable until each step's JSON fully completes. `handleRegenerateLang` /
"Regenerate" re-run the entire pipeline including decompose for identical text.

---

## Part 1 — Context / situation input (quality)

Let the user describe the situation ("formal email to a client", "casual chat,
speaker is apologizing to their boss") so register, politeness level, pronouns, and
word-sense disambiguation reflect it.

### 1.1 Backend — `routes/translation.ts`

- Add optional `context?: string` (maxLength ~2000) to the body schema of BOTH
  `/translate` and `/translate-stream`.
- Extend `buildTranslateSystemPrompt(basePrompt, sourceLang, targetLang, context?)`:
  when context is present, append at the **very end** (after the existing Approach
  paragraph — see 2.5 on why order matters):

  > User-provided context/situation (describes the circumstances of the text; it is
  > NOT text to translate): "..."
  > Reflect this in register, politeness/honorific level, pronoun choice, tone, and
  > word-sense disambiguation for the passage translations, chunk meanings, and
  > component explanations.

- Do NOT pass context to the decompose step — it is structure-only, and keeping its
  prompt static preserves OpenAI automatic prompt caching.
- Persist: add `context?: string` to `TranslationEntry` in **both**
  `backend/src/types.ts` and `frontend/src/types.ts` (type-mirroring rule), thread it
  through `saveTranslationEntry` and the `done` SSE event payload.

### 1.2 Frontend

- `api/translation.ts` — `translate()` / `translateStream()` gain an optional
  `context` argument included in the POST body.
- `TranslationView.tsx` — input phase: add an optional "Context / situation"
  textarea (2 rows) under the main text area. Keep the value in state across
  translations in the session (useful when translating several messages from the
  same conversation); `lastContextRef` so per-language regenerate reuses it; include
  it in `handleRegenerateTranslation` restore.
- Results phase: when `currentEntry.context` is set, show it as small muted text
  under the source text card (history entries then self-document what was asked).
- i18n: add label + placeholder keys to `i18n/translations.ts` for all UI languages.

No Firestore config migration needed — context is a code-side appendix, same pattern
as source/target injection.

---

## Part 2 — Speed (same models)

Ordered by impact/effort. 2.1 + 2.2 are pure wins with no LLM-behavior risk;
2.3 changes prompts/schemas and needs a config push.

### 2.1 Frontend: render passages as they stream (perceived speed, frontend-only)

`passages` is the FIRST property in `output_scheme.json`, so finished passage
translations exist within the first seconds of step 2's stream — but the UI shows
raw JSON until the whole response (all component explanations) completes.

- In `TranslationView.tsx` loading phase, incrementally extract completed
  `{ sentenceIds, translation }` objects from the accumulated chunk buffer (tolerant
  scan for balanced `{...}` inside the `"passages": [...]` array — a small pure
  helper, unit-testable) and render them as real translation cards immediately.
- Replace the decompose raw-JSON tail with a friendlier progress line (e.g. count of
  `"text":` occurrences → "analyzing sentence 3…").
- The full result still replaces everything on the `result` event, as today.

This makes the *translation* visible after decompose + a few seconds, while the
long tail (explanations for every component) streams in the background.

### 2.2 Skip re-decompose on regenerate (real speedup, no LLM change)

The client already receives the full decomposition via the `decompose-result` SSE
event. Reuse it:

- `/translate-stream` accepts optional `decomposition?: string`; when present and
  `JSON.parse`-able into a `SentenceAnalysisResult`, skip step 1 entirely (emit
  `decompose-result` immediately with the provided value).
- Frontend keeps `lastDecompositionRef`; `handleRegenerateLang` and the
  "Regenerate" flow (same source text + language) pass it back.
- Guard: only reuse when `sourceText` and `sourceLanguage` are unchanged.

Regenerate latency drops to step-2 only (typically ~half or better), and MINI-model
token cost for regenerates disappears. No Firestore changes.

### 2.3 Slim decompose output (real first-token speedup, config change)

Decompose blocks everything, and ~a third of its output tokens are boilerplate IDs
(`"sentenceId": "s1"`, `"chunkId": "s1c2"`, `"componentId": "s1c2p3"`) that are 100%
positionally derivable.

- New decompose schema WITHOUT id fields (sentences: `{text, chunks}`, chunks:
  `{surface, components}`, components: `{surface, baseForm, reading, partOfSpeech}`).
- Server assigns `s{i}` / `s{i}c{j}` / `s{i}c{j}p{k}` after parsing (one small
  function, used before `buildSlimInput`). Everything downstream (slim input,
  translate step, merge, frontend) is unchanged — it never sees the difference.
- Update the four `system_prompt_decompose_*.md` files (remove ID-format sections)
  and `decompose_scheme.json`; push with
  `cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --prompts`
  (deployed: `./deploy.sh PROJECT REGION --prompts`).

Expected: ~25–35% fewer decompose output tokens → proportionally faster step 1.

**Optional sibling (higher risk, decide separately):** the same trick on the
translate output (`components[]` as positional `{meaning, explanation}` in input
order, drop `componentId`). Bigger absolute win (step 2 is the FULL model and
component entries dominate), but positional merging loses the ID-based
self-alignment check — a skipped/duplicated entry silently shifts all following
meanings. If attempted: validate `slim.components.length === input components
length`, fall back to error (→ existing per-language regenerate) on mismatch.

### 2.4 Overlap quality-of-life (optional, larger change — defer)

True parallelism (start a passage-only translation from raw text concurrently with
decompose, then a second call for chunk/component meanings) would cut wall-clock the
most, but doubles FULL-model calls, complicates passage↔sentence alignment, and
changes the SSE protocol. Not recommended now; 2.1 delivers most of the perceived
benefit for a fraction of the effort.

### 2.5 Prompt-caching hygiene (free, just don't break it)

OpenAI automatic prompt caching applies to identical prompt *prefixes* ≥1024 tokens.
The static Firestore base prompts (2–14 KB) come first in the system message, with
dynamic parts (source/target, approach, new context) appended after — keep it that
way (context strictly LAST) so decompose and translate calls keep hitting the cache
across requests. Worth re-verifying after 2.3's prompt edits.

---

## Suggested implementation order

1. Part 1 (context) — isolated, highest user-visible quality value.
2. 2.2 (decomposition reuse on regenerate) — small backend+frontend change.
3. 2.1 (streaming passage render) — frontend-only.
4. 2.3 (slim decompose schema) — needs prompt/schema edits + `--prompts` push; test
   with all four source languages before deploying.
5. Optional: 2.3's translate-output variant, only if 1–4 still feel slow.

## Verification

- `cd backend && npm run build`; `cd frontend && npx tsc --noEmit`.
- Manual: translate with/without context (e.g. same Korean sentence with "formal
  business email" vs "texting a close friend") → register should differ; context
  visible on the history card.
- Regenerate a language mid-stream → no `decompose-start`/`decompose-chunk` events
  (network tab), result arrives in roughly half the time.
- 2.3: for each source language, decompose a multi-sentence input and diff the
  server-assigned IDs / merge output against the pre-change pipeline.
- Token-usage check: `token_usage` records for `translation/decompose-stream`
  before vs after 2.3 (expect ~25–35% completion-token drop).
