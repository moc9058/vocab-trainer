# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```bash
cd backend && npm run dev               # Dev server with watch (tsx watch src/index.ts)
cd backend && npm run build             # TypeScript compile to dist/
cd backend && npm start                 # Run compiled output (node dist/index.js)
cd backend && npm run migrate           # One-time word migration from JSON files to Firestore
cd backend && npm run export            # Export Firestore data back to local JSON files
cd backend && npx tsx scripts/wipe-grammar-firestore.ts   # Destructive: wipe all grammar collections in Firestore
cd backend && npx tsx scripts/migrate-llm-config-to-firestore.ts
cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --prompts
cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --archives
cd backend && npx tsx scripts/smoke-test-invariant.ts
cd backend && npx tsx scripts/validate-invariant-all.ts [--language=<lang>]
cd backend && npx tsx scripts/backfill-word-languages.ts [--dry-run] [--language=<code>] [--limit=<n>]
cd backend && npx tsx scripts/backfill-missing-segments.ts [--language=<lang>] [--dry-run] [--chunk=<n>]
cd backend && npx tsx scripts/backfill-segment-word-ids.ts [--language=<lang>] [--dry-run]
cd backend && npx tsx scripts/backfill-segment-transliterations.ts [--language=<lang>] [--dry-run]
cd backend && npx tsx scripts/backfill-word-appears-in.ts [--language=<lang>] [--dry-run]
cd backend && npx tsx scripts/backfill-hanja-readings.ts [--language=<name>] [--dry-run] [--limit=<n>] [--force]
cd backend && npx tsx scripts/backfill-definition-pinyins.ts [--language=<name>] [--dry-run] [--limit=<n>]
cd backend && npx tsx scripts/backfill-empty-example-translations.ts [--language=<lang>] [--dry-run] [--limit=<n>]   # LLM-fill example_sentences docs with empty OR partially-missing translations (needsMoreTranslations)
cd backend && npx tsx scripts/cleanup-dangling-example-refs.ts [--language=<lang>] [--dry-run]
cd backend && npx tsx scripts/find-non-word-segments.ts [--language=<lang>] [--limit=<n>] [--fix]
cd backend && npx tsx scripts/unify-chinese-levels.ts
cd backend && npx tsx scripts/migrate-example-sentences.ts [--dry-run]
cd backend && npx tsx scripts/migrate-grammar-examples.ts [--dry-run] [--language=<lang>]
cd backend && npx tsx scripts/fix-word-index-entry.ts
cd backend && npx tsx scripts/sweep-orphaned-word-index.ts [--language=<lang> | --all] [--dry-run]   # bulk delete/repair orphaned & mislinked word_index entries
```

### Frontend
```bash
cd frontend && npm run dev     # Vite dev server (port 5173, proxies /api to :3000)
cd frontend && npm run build   # Production build
cd frontend && npx tsc --noEmit  # Type-check (npm run build is vite-only, no tsc)
```

### Docker
```bash
docker compose up --build      # Run full stack (backend :3000, frontend :5173)
```

### Deploy
```bash
./deploy.sh PROJECT_ID REGION            # Deploy only
./deploy.sh PROJECT_ID REGION --word     # Deploy + word migration
./deploy.sh PROJECT_ID REGION --wipe-grammar  # Deploy + wipe grammar collections (destructive)
./deploy.sh PROJECT_ID REGION --llm      # Deploy + upload LLM config to Firestore
./deploy.sh PROJECT_ID REGION --prompts  # Deploy + upload speaking/writing & translation config
./deploy.sh PROJECT_ID REGION --archives # Deploy + upload backup & original archives
./deploy.sh PROJECT_ID REGION --example-sentences  # Deploy + migrate embedded examples
./deploy.sh PROJECT_ID REGION --grammar-examples   # Deploy + normalize inline Grammar.examples to example_sentences
```

### No test or lint commands are configured.

## Architecture

Full-stack vocabulary quiz app supporting four study languages (`en`/`ja`/`ko`/`zh`; HSK levels apply only to Chinese): **Fastify 5 backend** + **React 19 / Vite 6 frontend**.

### Backend (`backend/src/`)
- **Routes** (each is a `FastifyPluginAsync` registered under `/api`):
  - `routes/vocab.ts` — smart-add always asks LLM for all four codes (`en`/`ja`/`ko`/`zh`) — `ALL_DEFINITION_LANGUAGES` is hardcoded (lives in `exampleTranslations.ts` with `LANGUAGE_TO_ISO`); request body languages are anchors only. Empty example translations (chip adds send `""`) are normalized to `null` before the LLM call, and any example doc still empty after the merge is LLM-filled via `exampleTranslations.ts:generateMissingExampleTranslations` — shared by vocab POST/PUT and grammar's `resolveExamplesToIds`. Chinese levels normalized at storage time by `CHINESE_LEVEL_NORMALIZE`. Word-group ordering is persisted through `PUT /api/vocab/:language/groups/order`, whose `groupIds` body must contain every group for that language exactly once. **Word drafts**: `word_drafts` Firestore collection + CRUD under `/api/vocab/:language/drafts` (bulk POST assigns `id`/`createdAt` server-side; NO LLM at upload) — mirrors `grammar_drafts`. `WordList`'s "Upload JSON" button ingests `word-drafts` files (format: `docs/draft-json-format.md`). Draft examples may carry `segments: string[]` (chip segmentation — plain segment texts, NOT the `Example.segments` object shape); the review prefill re-inserts spaces at those boundaries (`spaceSentenceBySplits`) so the Chinese chip workflow picks them up and `buildPayload` re-emits them as smart-add `userSplits`. Review flow: drafts panel in `WordList` → `SmartAddWordModal` opens with `initialItem`/`initialGroups` prefill; the review modal deliberately omits `onQueue` so the direct smart-add path runs and `onSave` (the delete-draft signal) fires only on success. Draft `groups` are NAMES: existing ones are preselected in the modal's group chips; missing ones are created + joined on the direct save path.
  - `routes/quiz.ts` — `POST /start` accepts `groupWeights?: Record<string,number>` and `flaggedOnly?: boolean`. When `groupIds` are provided, questions are ordered by `weightedInterleave` (proportional to per-group weights, default 1) instead of `randomSample`; `randomSample` is still used for ungrouped sessions. Resume re-applies weights via `reweightUnanswered` (not a plain shuffle). 2-step hydration: `POST /start` returns lightweight `{wordId, term}` only; client pages `GET /questions/:language?offset&limit` (`BATCH_SIZE=50` in `QuizTaking.tsx`) for `definitions`/`examples`/`hanjaReadings`. Wrong answers call `insertRetryQuestion` server-side, which splices the missed word back into `session.questions` and reshuffles the tail — `score.total` grows accordingly; the frontend re-renders from the mutated session.
  - `routes/grammar.ts` — `Grammar` has `statement` + `descriptions: Meaning[]` (mirrors `Word.definitions`). Examples are normalized into the shared `example_sentences` collection via `exampleIds[]` (mirrors `Word.exampleIds`); inline `Grammar.examples` is a transitional fallback for unmigrated docs. POST/smart-add/PUT resolve incoming `examples` to existing or new `example_sentences` docs via the sha256 dedup index (so a sentence shared with a vocab word gets one doc) and `addGrammar`/`updateGrammar` keep `ExampleSentence.appearsInGrammarIds` in lockstep using a Firestore batch. PUT delete-cascades dropped examples through `isExampleReferencedByAny` (cross-domain check covering both `Word.appearsInIds` and other `Grammar.exampleIds`). User-curated `grammar_groups` collection mirrors `word_groups` — per-language, owns membership via `grammarIds[]`. CRUD lives under `/api/grammar/:language/groups`. `POST /:language/smart-add` LLM-enriches `descriptions[].text` to all four ISO codes (mirrors vocab smart-add); `GrammarFormModal` create path uses smart-add, edit (PUT) stays manual. `GET/PUT /api/grammar/settings` persist `GrammarSettings { defaultDefinitionLanguage }` in Firestore doc `config/grammar_settings` — seeds the first description row in `GrammarFormModal` (module-level `cachedDefaultDescLang` avoids the fetch race on repeat opens). Grammar example translations pass through as-is (`string | Record<string,string>`): `hydrateGrammarItems` and grammar-quiz's `prepareQuestion` no longer coerce multi-lang objects to a single string; the UI renders them via `displayGrammarDefEntries`. Config in Firestore `config/grammar` (local source `backend/DB/grammer/config/`, pushed by `migrate-db-config-to-firestore.ts --prompts`). **Grammar drafts**: `grammar_drafts` Firestore collection + CRUD under `/api/grammar/:language/drafts` (bulk POST assigns `id`/`createdAt` server-side; NO LLM at upload). Drafts hold raw inline `examples` — never normalized to `example_sentences` until promoted. Sources: the local OCR tool (`~/workspace/textbook_content_extractor/server/`, separate repo, NOT deployed) posts directly, and `GrammarList`'s "Upload JSON" button ingests `grammar-drafts` files (format spec: `docs/draft-json-format.md`, which also pre-defines the future `word-drafts` format). Review flow: drafts panel in `GrammarList` → `GrammarFormModal` opens in create mode via its `initialItem` prop (prefill-only; `isEdit` stays keyed to `editItem`) → smart-add on save, then the draft doc is deleted (the review modal deliberately omits `onGrammarQueue` — queue-mode submits never fire `onSave`, which is the delete signal).
  - `routes/grammar-quiz.ts` — `/start` accepts `groupIds` to scope the pool (no chapters/subchapters/displayLanguage/quizMode); `prepareQuestion` hydrates examples from `item.exampleIds` via `getExampleSentencesByIds` (falls back to inline `item.examples` for unmigrated docs), and falls back to LLM generation only when neither is present. Also exposes `check-missing-words` and `add-missing-words` (currently unused by the UI after the quiz simplification).
  - `routes/combined-quiz.ts` — merged word+grammar quiz at `/api/combined-quiz`. Two-level weighted ordering: each domain is ordered internally by group weights (`weightedInterleave`; grammar groups gain weights here — the standalone grammar quiz has none), then the two streams are merged by `domainWeights: {word, grammar}` via `weightedMerge` (order-preserving draw; a weight of 0 skips that domain). Questions are a `kind`-discriminated union (`CombinedQuizWordQuestion | CombinedQuizGrammarQuestion`); `/answer` takes `{kind, refId}` and dispatches to word vs grammar progress + retry re-queue. Word questions use the same 2-step hydration as `routes/quiz.ts` (`GET /questions/:language?offset&limit`); grammar questions are stored inline (built with `prepareQuestion` imported from `grammar-quiz.ts`, capped at `PREPARE_CONCURRENCY=5`). Sessions live in `combined_quiz_sessions` keyed by language; resume (`GET /session/language/:language`) reweights the unanswered tail per-domain then re-merges. Shared ordering helpers (`shuffle`/`weightedInterleave`/`weightedMerge`/`insertRetryQuestion`) live in `src/quiz-utils.ts`, also used by `routes/quiz.ts`.
  - `routes/expressions.ts` — CRUD + group management for `Expression` items at `/api/expressions/:language`. No LLM; fully user-curated. Mirrors grammar pattern (`expression_items`/`expression_groups` collections).
  - `routes/expression-quiz.ts` — Expression quiz **embedded as a subsession** inside `SpeakingWritingSession` (`SpeakingWritingSession.expressionQuiz?: ExpressionQuizSubsession`). Uses the same S&W correction LLM config; appends phrase/context to the base system prompt. Routes: `POST /start`, `POST /answer`, `POST /grade`, `GET /session/language/:language`.
  - `routes/translation.ts` / `routes/speaking-writing.ts` — SSE streaming via POST endpoint
  - `routes/translation.ts` — `language` prop = **target** language (active study language); user selects source. Two-step: decompose (MINI, source-lang prompt) → translate (FULL, target-lang prompt). Output uses `passages[].{ sentenceIds[], translation }` — LLM may group consecutive sentences. `buildTranslateSystemPrompt` appends source/target + approach guidance + optional user `context` (situation/register hint, persisted on `TranslationEntry.context`) to the Firestore prompt without needing a migration — context must stay LAST so the static prefix keeps hitting OpenAI prompt caching. The decompose schema omits sentence/chunk/component IDs; `ensureDecompositionIds` assigns them positionally server-side (tolerates old ID-carrying outputs). `/translate-stream` accepts an optional `decomposition` body field — the client (`TranslationView`) replays the previous `decompose-result` on regenerate for unchanged text+source so step 1 is skipped. `TranslationView`'s loading phase live-renders passages from the partial stream via `extractStreamingPassages` (passages are the first key in the translate response).
- **Database**: `firestore.ts` — `updateWord` per-sentence-merges old example `segments` onto incoming `examples` when sentence text is unchanged, so `WordFormModal` (which doesn't carry segments through form state) doesn't wipe LLM-generated pinyin on save. `getCanonicalSegmentPinyin(word)` returns `undefined` for polyphonic words so callers keep the LLM-generated contextual value. `getNextWordId` and `getNextExampleId` use Firestore transactions (not get-then-increment) to prevent duplicate IDs under the `CONCURRENCY=4` parallel smart-add queue — duplicate IDs cause one word to clobber another's doc and leave a ghost `word_index` entry. `checkTerms` validates `word_index` entries via `wordEntryIsLive` to filter out orphaned/mislinked entries before reporting a word as "existing".
- **LLM**: `llm.ts` — `callLLM*` functions use the MINI OpenAI model; `callLLMFull*` use the FULL OpenAI model. Config from `.env` (local) or Firestore `config/llm` (deployed).
- **Types**: `types.ts` — `Word` carries optional `hanjaReadings?: HanjaReading[]` (`{ simplifiedChar, traditionalChar, hunEum[] }` per character)
- **Type mirroring**: `backend/src/types.ts` and `frontend/src/types.ts` share translation interfaces (`TranslationResult`, `TranslationPassage`, `TranslationEntry`), grammar/example shapes (`Grammar`, `GrammarExample`, `ExampleSentence`, `GrammarSettings`), expression shapes (`Expression`, `ExpressionGroup`, `ExpressionQuizSubsession`), AND combined-quiz shapes (`CombinedQuizQuestion`, `CombinedQuizSession`, `CombinedDomainWeights`) — update both files together.
- **`userSplits` contract**: Chinese examples in both `WordFormModal` and `GrammarFormModal` strip `[\s　]+` from the sentence on save and attach `userSplits: string[]` (the segment texts). Backend routes (`vocab.ts`, `grammar.ts:resolveExamplesToIds`) feed `userSplits` to `fillSegmentPinyin` + `lookupWordsByTerms` to produce `example_sentences.segments` with word IDs. `GrammarExample.userSplits` is input-only — never persisted.

### Data Storage
- **Firestore** (database ID: `vocab-database`). Key composite keys: `progress`/`word_index` use `{language}_{wordId}`, `example_sentence_index` uses `{language}_{sha256(sentence).slice(0,16)}`.
- `example_sentences` — normalized; words store `exampleIds` and `appearsInIds` arrays referencing this collection. **Grammar items also reference this collection** via `grammar_items.exampleIds[]`; the reverse link is `ExampleSentence.appearsInGrammarIds[]`. A sentence shared by a word and a grammar item resolves to ONE doc via the sha256 dedup index. Orphan deletion (in `deleteWord`, `deleteGrammarItem`, and the vocab/grammar PUT routes) MUST use `isExampleReferencedByAny` so vocab deletes don't clobber grammar-owned examples (and vice versa). `validate-invariant-all.ts` enforces the bidirectional invariant `ES.appearsInGrammarIds == { gId | grammar(gId).exampleIds ∋ ES.id }`.
- `config` subcollections: `config/llm`, `config/token_costs`, `config/speaking_writing`, `config/translation`, `config/vocabulary`, `config/grammar`, `config/grammar_settings`
  - `config/translation` fields: `decomposeSchema`, `decomposePrompts`, `translateSchema`, `translatePrompts` — local source in `backend/DB/translation/`; push with `migrate-db-config-to-firestore.ts --prompts`
- `expression_items`, `expression_groups` — per-language, mirror the grammar collection structure. `ExpressionQuizSubsession` is NOT a separate collection; it is stored as `SpeakingWritingSession.expressionQuiz?` in `speaking_writing_sessions`.
- `word_groups` — per-language groups own membership through `wordIds[]` and may carry numeric `order`. `getWordGroups` sorts by `order`, with creation time as the legacy fallback. The first reorder operation backfills a complete zero-based order for all groups; new groups append to an ordered list.
- **Local files**: `backend/DB/` (grammer, speaking&writing, translation, vocabulary, backup, old, original). Word JSON is no longer mirrored locally — Firestore is the source of truth; `old/` and `original/` hold pre-migration HSK archives.

### Language Code Convention
All language codes use ISO 639-1: `ja`, `en`, `ko`, `zh`. The export script normalizes legacy keys (e.g., `"Japanese"` → `"ja"`, `"kr"` → `"ko"`) on export.

### Frontend (`frontend/src/`)
- **Settings**: `settings/context.tsx` — persisted to `localStorage("appSettings")`.
  - `defaultAddWordLanguage` — backend full-name format (`"english"`, `"chinese"`) — **different from** `defaultDefinitionLanguage` (ISO code)
  - `showKoreanHanja` — only shown in Settings when active language is Chinese
  - `displayGrammarDefinitionLanguages` — filters grammar description/example-translation languages via the `displayGrammarDefEntries` helper (grammar's own default definition language is server-side: `config/grammar_settings`, not localStorage)
- **API layer**: `api/client.ts` — non-ok responses include body text in thrown error
- **i18n in sub-components**: Module-level React components (outside `TranslationView`) must explicitly call `const { t } = useI18n()` — they don't inherit it from parent scope.
- **Key components**:
  - `SmartAddWordModal.tsx` — **two independent language fields**: outer "word language" (backend full-name) vs. per-row "definition language" (ISO code). Queue mode (`onQueue` prop): Submit enqueues immediately and resets form.
  - `WordFormModal.tsx` — does not carry `segments` through form state (preserved server-side by `firestore.ts:updateWord`)
  - `GroupPickerModal.tsx` — shared word/grammar group picker and manager. In word-group management mode (`itemIds.length === 0`), rows use `@dnd-kit` drag handles and persist reordering immediately through `reorderGroups`; grammar groups are not reorderable. `onDone` synchronizes parent group state but does not imply closing the modal—add flows call `onClose` themselves.
  - `ExampleSentenceEditor.tsx` — shared example-sentence editor used by `WordFormModal` AND `GrammarFormModal`. Owns the Chinese segment-chip "+" workflow — direct mode calls `smartAddWord`; queue mode (`onQueue`) enqueues into the shared word queue. The chip rendering + space-splitting + `userSplits` payload are all gated by literal `language === "chinese"` (backend full-name, NOT ISO `"zh"`). Pass the active language string straight through — any sentinel (e.g. `"open"`) silently disables the workflow. **Chip status invariant** (shared with `SmartAddWordModal.tsx`): 3 states — green ✓ = `existingTerms ∪ succeededTerms ∪ addedTerms`, amber ⋯ = `pendingTerms`/`busySegments`/`checkingTerms`, blue + otherwise. Green MUST come from the queue's `succeededTerms` (passed down beside `pendingTerms`), NOT the wholesale-replaced `checkTerms` poll — that poll only detects pre-existing words and is too racy under `CONCURRENCY=4` to signal completion.
  - `constants/levels.ts` — `LEVEL_OPTIONS` (HSK/JLPT buckets). Used by `SmartAddWordModal` and `GrammarFormModal`. Backend keeps its own copy in `routes/vocab.ts` (LLM-output normalization concern).
  - `hooks/useWordQueue.ts` — runs `CONCURRENCY=4` items in parallel (NOT one-at-a-time). Supports two item types: `create` (via `enqueue`) and `update` (via `enqueueUpdate(term, language, wordId, updates, groupsToAdd, groupsToRemove)`). Exposes `pendingTerms` (queued+processing) and `succeededTerms` (cumulative, monotonic set of finished adds) — the authoritative signals segment chips use for status. Also bumps `refreshSignal`.
  - `Dashboard.tsx` — URL sub-paths: `/browse`, `/quiz`, `/flagged`, `/grammar`, `/grammar-quiz`, `/combined-quiz`, `/translation`, `/speaking-writing`. Home page sections rendered by `EmptyState.tsx` are driven by `sectionOrder` in `settings/defaults.ts`; add/remove a section key there and add/remove the matching render branch in `EmptyState`.
  - `StudyQuizModal.tsx` — three tabs: word (`QuizFilterModal`), grammar (`GrammarFilterModal`), combined (`CombinedQuizFilterModal`). The combined setup modal has word/grammar domain-weight inputs plus per-group weights on BOTH sides; setting a domain weight to 0 excludes that domain. The home "Combined Quiz" button (hidden for English, which has no grammar) opens the combined tab; `CombinedQuizTaking.tsx` renders per-question by `kind` and reuses the word quiz's paged hydration + the grammar quiz's item-detail cache.
