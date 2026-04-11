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
cd backend && npx tsx scripts/migrate-grammar-to-firestore.ts  # Grammar migration to Firestore
cd backend && npx tsx scripts/migrate-llm-config-to-firestore.ts  # Upload LLM config (.env) to Firestore
cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --prompts   # Upload speaking/writing + translation config to Firestore
cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --archives  # Upload backup + original archives to Firestore
cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts             # Upload both prompts + archives
cd backend && npx tsx scripts/backfill-word-languages.ts [--dry-run] [--language=<code>] [--limit=<n>]  # One-off: re-run LLM on existing words to fill missing en/ja/ko/zh definition + example translations
cd backend && npx tsx scripts/unify-chinese-levels.ts  # One-off: rewrite granular HSK1/2/.../9 labels in `words` and `word_index` to the merged HSK1-4 / HSK5 / HSK6 / HSK7-9 / Advanced buckets
cd backend && npx tsx scripts/migrate-example-sentences.ts [--dry-run]  # One-off: extract embedded examples from words into example_sentences collection with dedup + bidirectional linking
```

### Frontend
```bash
cd frontend && npm run dev     # Vite dev server (port 5173, proxies /api to :3000)
cd frontend && npm run build   # Production build
```

### Docker
```bash
docker compose up --build      # Run full stack (backend :3000, frontend :5173)
```

### Deploy
```bash
./deploy.sh PROJECT_ID REGION                    # Deploy only
./deploy.sh PROJECT_ID REGION --word             # Deploy + word migration
./deploy.sh PROJECT_ID REGION --grammer          # Deploy + grammar migration
./deploy.sh PROJECT_ID REGION --llm              # Deploy + upload LLM config to Firestore
./deploy.sh PROJECT_ID REGION --word --grammer   # Deploy + both migrations
./deploy.sh PROJECT_ID REGION --word --grammer --llm  # Deploy + all migrations
./deploy.sh PROJECT_ID REGION --prompts              # Deploy + upload speaking/writing & translation config
./deploy.sh PROJECT_ID REGION --archives             # Deploy + upload backup & original archives
./deploy.sh PROJECT_ID REGION --example-sentences    # Deploy + migrate embedded examples to example_sentences collection
```

### No test or lint commands are configured.

## Architecture

Full-stack vocabulary quiz app for Chinese (HSK levels): **Fastify 5 backend** + **React 19 / Vite 6 frontend**.

### Backend (`backend/src/`)
- **Entry**: `index.ts` — Fastify server with pino logging (stdout + file), CORS, route registration
- **Routes** (each is a `FastifyPluginAsync` registered under `/api`):
  - `routes/languages.ts` — lists available languages from Firestore
  - `routes/vocab.ts` — CRUD for vocabulary words + smart-add with LLM (filtering, pagination, word lookup, language create/delete, batch term-existence check via `check-terms`); config (schemas, prompts) loaded from Firestore `config/vocabulary`. Smart-add always asks the LLM for definitions and example translations in all four supported codes (`en`/`ja`/`ko`/`zh`) — `ALL_DEFINITION_LANGUAGES` is hardcoded; the language values in the request body are treated as user-supplied anchors only. Chinese levels are constrained at prompt time by `LEVEL_OPTIONS["chinese"]` (HSK1-4 / HSK5 / HSK6 / HSK7-9 / Advanced) and normalized again at storage time by `CHINESE_LEVEL_NORMALIZE` so granular HSK1/2/.../9 labels are bucketed automatically
  - `routes/quiz.ts` — word quiz sessions with weighted random sampling
  - `routes/progress.ts` — per-word progress tracking (timesSeen, correctRate, streak)
  - `routes/flagged.ts` — flagged words for review
  - `routes/grammar.ts` — CRUD for grammar items, chapters, subchapters
  - `routes/grammar-quiz.ts` — grammar quiz with self-grading, two modes (existing examples / LLM-generated); also exposes `check-missing-words` (filter a term list against `word_index`) and `add-missing-words` (LLM-enrich each term with definitions/topics/notes and write it as a new word, used to backfill the vocab DB from grammar quiz segments)
  - `routes/grammar-progress.ts` — per-component grammar progress
  - `routes/translation.ts` — two-step translation/analysis: decomposition (MINI model, structural parsing into sentences/chunks/components) then parallel translation per target language (FULL model, meanings/explanations); only `en`/`ja`/`ko`/`zh` supported; exposes both a non-streaming `POST /translate` and an SSE-streaming `POST /translate-stream` (events: `decompose-start`, `decompose-chunk`, `decompose-result`, `start`, `chunk`, `result`, `done`, `error`); translate input is a flat representation (sourceText + flat chunks/components arrays) built by `buildSlimInput`; history persistence; config (schemas, prompts) loaded from Firestore `config/translation`
  - `routes/speaking-writing.ts` — text correction for speaking/writing practice; SSE streaming LLM call with language-specific system prompts + use-case context (professional/casual/presentation/interview for speaking; academic/social/email/creative for writing), per-sentence corrections, session persistence; config (schemas, prompts, use cases) loaded from Firestore `config/speaking_writing`
  - `routes/metrics.ts` — LLM token usage tracking and cost estimation; paginated usage logs, daily aggregates, cost-per-token configuration per model
- **Database**: `firestore.ts` — Google Cloud Firestore abstraction layer. `updateWord` per-sentence-merges old example `segments` onto the incoming `examples` whenever the sentence text is unchanged, so `WordFormModal` (which doesn't carry segments through its form state) doesn't wipe LLM-generated pinyin on every save
- **LLM**: `llm.ts` — Azure OpenAI integration (callLLM/callLLMFull with JSON mode, callLLMWithSchema/callLLMFullWithSchema with JSON schema enforcement, streamLLMWithSchema/streamLLMFullWithSchema for streaming with schema, validateWord, segmentBatch); `callLLM`/`callLLMWithSchema`/`streamLLMWithSchema` use MINI deployment, `callLLMFull`/`callLLMFullWithSchema`/`streamLLMFullWithSchema` use FULL deployment; config loaded from `.env` (local) or Firestore `config/llm` (deployed); `validateWord` accepts any word with at least one definition language (not limited to ja/en/ko); all LLM functions accept a `route` parameter for token usage tracking and automatically log token counts to Firestore; `segmentBatch` accepts optional config (prompt + schema) from Firestore
- **Types**: `types.ts` — shared interfaces (Word, VocabFile, QuizSession, WordProgress, TranslationEntry, SpeakingWritingSession, etc.)
- Route handlers use Fastify generics for type-safe Params/Querystring/Body and JSON schema validation
- Errors via `@fastify/sensible`: `reply.notFound()`, `reply.badRequest()`, `reply.conflict()`

### Backend Scripts (`backend/scripts/`)
- `migrate-to-firestore.ts` — word migration from JSON files in `DB/word/` to Firestore; backs up current Firestore words to `DB/backup/{language}_{YYYYMMDD}.json` first
- `export-from-firestore.ts` — export words, grammar, and progress from Firestore back to JSON files in `DB/` (inverse of migrate); normalizes legacy language keys to ISO 639-1
- `migrate-grammar-to-firestore.ts` — grammar migration from `backend/DB/grammer/` JSON to Firestore; backs up current Firestore grammar to `DB/backup/{language}/` first
- `migrate-llm-config-to-firestore.ts` — uploads Azure OpenAI config from `.env` to Firestore `config/llm` document
- `migrate-db-config-to-firestore.ts` — uploads speaking/writing + translation + vocabulary config (`--prompts`) and backup/original archives (`--archives`) to Firestore
- `unify-chinese-levels.ts` — one-time backfill that scans `words` and `word_index` and rewrites granular HSK1/2/.../9 (and `*-extended`) labels into the merged `HSK1-4` / `HSK5` / `HSK6` / `HSK7-9` / `Advanced` buckets used by the rest of the app

### Data Storage
- **Primary**: Google Cloud Firestore (database ID: `vocab-database`)
  - `languages` — language metadata (word count, topics, levels)
  - `words` — all vocabulary words partitioned by language field
  - `progress` — per-word progress (composite key: `{language}_{wordId}`)
  - `word_index` — fast term lookup (composite key: `{language}_{term}`)
  - `example_sentences` — normalized example sentences (id, sentence, translation, segments, language, ownerWordId); words store `exampleIds` and `appearsInIds` arrays referencing this collection
  - `example_sentence_index` — dedup lookup by sentence text (composite key: `{language}_{sha256(sentence).slice(0,16)}` → exampleId)
  - `id_maps` — next ID counters per language
  - `quiz_sessions` — one active word quiz session per language
  - `flagged_words` — flagged words for review
  - `grammar_chapters` — grammar chapter metadata per language
  - `grammar_items` — flattened grammar components (denormalized chapter/subchapter info)
  - `grammar_progress` — per-component grammar progress
  - `grammar_quiz_sessions` — one grammar quiz session per language
  - `translation_history` — translation/analysis entries with structured LLM results
  - `speaking_writing_sessions` — one speaking/writing correction session per language (keyed by language code)
  - `config` — app configuration (e.g., `config/llm` stores Azure OpenAI keys, `config/token_costs` stores cost-per-token rates, `config/speaking_writing` stores prompts/schemas/use-cases, `config/translation` stores prompts/schemas, `config/vocabulary` stores prompts/schemas for smart-add and segmentation)
  - `archive_backups` — backup word data and grammar backups (chunked subcollections for large files)
  - `archive_originals` — original HSK files by date folder (chunked subcollections for large files)
  - `token_usage` — individual LLM call logs with token counts per call
  - `token_usage_daily` — daily aggregates by model (doc ID: `{model}_{YYYY-MM-DD}`)
- **Local files** (for migration/export):
  - Vocabulary: `backend/DB/word/{language}.json` — one file per language (e.g. `chinese.json`)
  - Grammar: `backend/DB/grammer/chinese/*.json` — per-chapter grammar files
  - Speaking & Writing: `backend/DB/speaking&writing/` — system prompts per language + output schema (source files for Firestore migration)
  - Translation: `backend/DB/translation/` — system prompts + schemas (source files for Firestore migration)
  - Vocabulary: `backend/DB/vocabulary/` — system prompts (with `{{PLACEHOLDER}}` syntax) + JSON schemas for all vocab LLM operations (source files for Firestore migration)
  - Progress: `backend/data/progress/{language}.json`
  - Backups: `backend/DB/backup/` — date-stamped word backups + grammar backups per language
  - Logs: `backend/logs/app-{timestamp}.log`

### Language Code Convention
All language codes use ISO 639-1: `ja` (Japanese), `en` (English), `ko` (Korean), `zh` (Chinese). This applies to:
- Word definition keys: `{ "ja": "...", "en": "...", "ko": "..." }` (configurable via settings — not limited to these three)
- Example sentence translations: `string` (legacy single-language) or `Record<string, string>` (multi-language, e.g. `{ "ja": "...", "ko": "..." }`)
- Grammar data `Record<string, string>` fields (chapterTitle, subchapter title, term, description)
- UI language selection and display language options (order and visibility controlled by settings)
- The export script normalizes legacy keys (e.g., `"Japanese"` → `"ja"`, `"kr"` → `"ko"`) on export

### Key API Endpoints
- `GET /api/languages` — list languages
- `GET /api/vocab/:language` — list words (query: search, topic, category, level, page, limit)
- `GET /api/vocab/:language/filters` — available filter options (topics, categories, levels)
- `GET /api/vocab/:language/lookup?term=X` — word lookup via word_index
- `POST /api/vocab/:language/smart-add` — smart add word with LLM filling missing fields, auto-flag; for Chinese, also generates word segments with pinyin on examples; the LLM always generates definitions and example translations in all four supported languages (en/ja/ko/zh) — display filtering happens client-side via the user's settings
- `POST /api/vocab/:language/check-terms` — given `{ terms: string[] }`, returns `{ existing: Record<term, wordId> }` for terms already in `word_index`
- `POST /api/vocab/:language/file` — create a new (empty) language
- `DELETE /api/vocab/:language/file` — delete an entire language
- `PUT /api/vocab/:language/:wordId` — update word; for Chinese, `examples[].segments` are merged from the previous saved version when the sentence text is unchanged so callers (e.g. `WordFormModal`) don't need to round-trip segments
- `DELETE /api/vocab/:language/:wordId` — delete word
- `POST /api/quiz/start` — start word quiz session (returns lightweight questions; full data is fetched on demand)
- `GET /api/quiz/questions/:language?offset=&limit=` — batch-hydrate full question details (definitions, transliteration, examples) for a slice of the current quiz session
- `POST /api/quiz/answer` — submit answer (body: sessionId, wordId, correct)
- `GET /api/quiz/session/language/:language` — get current word quiz session
- `GET /api/progress/:language` — all progress for language
- `DELETE /api/progress/:language` — reset progress
- `GET /api/flagged/:language` — list flagged words (full word data)
- `GET /api/flagged/:language/count` — count of flagged words
- `POST /api/flagged/:language/:wordId` — flag a word for review
- `DELETE /api/flagged/:language/:wordId` — unflag a word
- `GET /api/grammar/:language/chapters` — list grammar chapters
- `GET /api/grammar/:language/subchapters` — list subchapters (query: chapters)
- `GET /api/grammar/:language/items` — list grammar items (query: chapter, subchapter, level, search)
- `POST /api/grammar/:language/items` — add grammar item
- `PUT /api/grammar/:language/items/:componentId` — update grammar item
- `DELETE /api/grammar/:language/items/:componentId` — delete grammar item
- `POST /api/grammar-quiz/start` — start grammar quiz (body: language, chapters, subchapters, displayLanguage, quizMode)
- `POST /api/grammar-quiz/answer` — submit self-graded answer (body: language, componentId, correct)
- `GET /api/grammar-quiz/session/language/:language` — get current grammar quiz session
- `POST /api/grammar-quiz/check-missing-words` — given `{ language, terms[] }`, returns `{ missing: string[] }` of terms not yet in the word DB
- `POST /api/grammar-quiz/add-missing-words` — batch-create vocab entries (LLM-enriched definitions/topics/notes) for terms surfaced by the grammar quiz; body: `{ language, words: [{ term, pinyin, sentence, translation }] }`
- `GET /api/grammar-progress/:language` — all grammar progress
- `DELETE /api/grammar-progress/:language` — reset grammar progress
- `POST /api/translation/translate` — two-step LLM translation/analysis (decompose with MINI model, translate with FULL model); body `{ sourceLanguage, sourceText, targetLanguages }`
- `POST /api/translation/translate-stream` — SSE streaming version of `/translate`; same body. Events: `decompose-start`, `decompose-chunk`, `decompose-result`, then per-language `start`/`chunk`/`result`, then `done` (full saved entry) or `error`
- `GET /api/translation/history` — paginated translation history
- `DELETE /api/translation/history` — clear all translation history
- `DELETE /api/translation/history/:id` — delete single translation entry
- `POST /api/speaking-writing/correct` — submit text for LLM correction (body: language, mode, useCase, inputText; uses FULL model)
- `POST /api/speaking-writing/correct-stream` — SSE streaming version of correction (same body; streams chunk events then done with full session)
- `GET /api/speaking-writing/session/:language` — get current speaking/writing session (returns null if none, not 404)
- `DELETE /api/speaking-writing/session/:language` — delete speaking/writing session
- `GET /api/metrics/usage` — paginated raw token usage logs (query: model, route, from, to, page, limit)
- `GET /api/metrics/summary` — aggregated usage summary with cost estimates (query: from, to)
- `GET /api/metrics/costs` — get cost-per-token configuration
- `PUT /api/metrics/costs` — update cost-per-token rates (body: { models: Record<string, TokenCostRate> })
- `DELETE /api/metrics/usage` — clear all usage logs and daily summaries

### Frontend (`frontend/src/`)
- **Entry**: `main.tsx` → `App.tsx` → `Dashboard.tsx`
- **State**: React hooks + Context API (`i18n/context.tsx` for UI language, `settings/context.tsx` for app settings)
- **Settings**: `settings/context.tsx` — `SettingsProvider` + `useSettings()` hook; persisted to `localStorage("appSettings")`. The full `AppSettings` shape lives in `settings/types.ts`; defaults in `settings/defaults.ts`. Fields, grouped by purpose:
  - **Display preferences** (affect what the user sees, never what the LLM produces):
    - `languageOrder` — ordered list of language codes; drives definition ordering, language selector ordering, UI language button ordering
    - `activeUiLanguages` — subset of supported UI languages shown in the header toggle
    - `displayDefinitionLanguages` — which definition entries are rendered in word displays
    - `displayExampleTranslationLanguages` — which example translations are rendered
  - **Smart-add defaults** (pre-fill the Smart Add Word modal; do **not** affect what the LLM generates — generation always covers all four codes):
    - `defaultAddWordLanguage` — pre-selected outer Language radio (backend full-name format, e.g. `"english"`, `"chinese"`, or any custom string)
    - `defaultDefinitionLanguage` — pre-selected language for the first definition row (ISO code from `languageOrder` or a free-form custom name)
  - **Speaking/writing defaults**:
    - `defaultCorrectionMode` — `"speaking" | "writing"`
    - `defaultSpeakingUseCase` — e.g. `"professional"`
    - `defaultWritingUseCase` — e.g. `"academic"`
  - **Translation defaults**:
    - `defaultTranslationSourceLanguage` — ISO code
    - `defaultTranslationTargetLanguages` — array of ISO codes
  - Centralized helpers: `sortByLanguageOrder()`, `sortedEntries()`, `displayDefEntries()` (filters by display definition languages), and `displayExEntries()` (filters by display example translation languages)
- **Settings defaults**: `settings/defaults.ts` — `ALL_KNOWN_LANGUAGES` (en/ja/ko/zh with labels), `LANG_LABEL_MAP`, `DEFAULT_SETTINGS`
- **API layer**: `api/client.ts` (generic fetchJson/postJson), `api/quiz.ts`, `api/vocab.ts`, `api/grammar.ts`, `api/translation.ts`, `api/speaking-writing.ts`
- **Components**:
  - `Dashboard.tsx` — main layout with header (settings gear button, dynamic UI language buttons ordered by settings), modals, quiz/word list/grammar orchestration
  - `SettingsModal.tsx` — settings modal with drag-and-drop language reordering (@dnd-kit) plus controls for every `AppSettings` field: active UI languages, display definition / example translation languages, smart-add defaults (`defaultAddWordLanguage`, `defaultDefinitionLanguage`), speaking/writing defaults (`defaultCorrectionMode`, `defaultSpeakingUseCase`, `defaultWritingUseCase`), and translation defaults (`defaultTranslationSourceLanguage`, `defaultTranslationTargetLanguages`)
  - `LanguageSelectModal.tsx` — language picker modal
  - `LevelSelectModal.tsx` — proficiency level picker (Chinese HSK buckets, Japanese JLPT)
  - `QuizFilterModal.tsx` — multi-select filters (topic, category, level) before starting word quiz
  - `QuizTaking.tsx` — word quiz UI with question display, answer input, progress bar
  - `WordList.tsx` — paginated word browsing with filters, progress badges, expandable details
  - `WordFormModal.tsx` — manual add/edit word form (no LLM); does not carry `examples[].segments` through its form state, which is why `firestore.ts:updateWord` preserves segments by sentence
  - `RubyText.tsx` — ruby annotation component used to render Chinese pinyin (and Japanese furigana) above their base characters in word displays and quiz views
  - `SmartAddWordModal.tsx` — add word with LLM filling missing fields. **Two language fields**: an outer "word language" (backend full-name format: `"english"`, `"chinese"`, or custom — pre-filled from `defaultAddWordLanguage`) sent as the `:language` route parameter, and a per-definition-row "definition language" (ISO code or custom — first row pre-filled from `defaultDefinitionLanguage`) used as the key in `definitions[].text`. These are independent — easy to confuse. The LLM always generates definitions and example translations in all four supported languages regardless of either setting; display filtering is client-side via `displayDefinitionLanguages` / `displayExampleTranslationLanguages`
  - `GrammarList.tsx` — browse grammar by chapter/subchapter with inline edit/delete
  - `GrammarFilterModal.tsx` — grammar quiz filters (chapter, subchapter, display language, quiz mode); display language options follow settings order
  - `GrammarQuizTaking.tsx` — grammar quiz flashcard UI (display sentence → show answer → self-grade)
  - `GrammarFormModal.tsx` — add/edit grammar component with chapter/subchapter/topic/description/terms/examples; input language selector follows settings order
  - `FlaggedReview.tsx` — review flagged words
  - `TranslationView.tsx` — translation/analysis UI with language selection ordered by settings, schema-based sentence decomposition results, per-language regenerate buttons during streaming, reading column conditional on CJK input, and history navigation
  - `SpeakingWritingView.tsx` — text correction UI with language selection (ordered by settings), speaking/writing mode toggle, use-case selector (professional/casual/presentation/interview or academic/social/email/creative), SSE streaming with live JSON preview, per-sentence corrections with severity-coded feedback (error/improvement/style), previous/next navigation between corrections, session persistence
  - `MetricsView.tsx` — LLM token usage dashboard with summary (per-model breakdown, daily table, cost estimates), paginated usage logs, and cost-per-token configuration editor
  - `EmptyState.tsx` — home screen with vocabulary, translation, speaking & writing, grammar, and system sections
- **i18n**: `i18n/translations.ts` — English, Japanese, and Korean, keyed by `TranslationKey` type
- **Styling**: Tailwind CSS 4 utility classes only
- **Proxy**: Vite proxies `/api` requests to `localhost:3000` in dev
- **Production**: Nginx serves static assets, proxies `/api/` to backend (configured via `nginx.conf.template`)

### TypeScript Config
- Backend: ES2024, NodeNext modules, strict mode
- Frontend: ES2024, ESNext modules, bundler resolution

### Key Dependencies
- Backend: fastify, @fastify/cors, @fastify/sensible, @google-cloud/firestore, openai (Azure), dotenv
- Frontend: react, react-dom, vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite, @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities
