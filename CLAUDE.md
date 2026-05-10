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
cd backend && npx tsx scripts/migrate-grammar-to-firestore.ts
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
cd backend && npx tsx scripts/cleanup-dangling-example-refs.ts [--language=<lang>] [--dry-run]
cd backend && npx tsx scripts/find-non-word-segments.ts [--language=<lang>] [--limit=<n>] [--fix]
cd backend && npx tsx scripts/unify-chinese-levels.ts
cd backend && npx tsx scripts/migrate-example-sentences.ts [--dry-run]
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
./deploy.sh PROJECT_ID REGION            # Deploy only
./deploy.sh PROJECT_ID REGION --word     # Deploy + word migration
./deploy.sh PROJECT_ID REGION --grammer  # Deploy + grammar migration
./deploy.sh PROJECT_ID REGION --llm      # Deploy + upload LLM config to Firestore
./deploy.sh PROJECT_ID REGION --prompts  # Deploy + upload speaking/writing & translation config
./deploy.sh PROJECT_ID REGION --archives # Deploy + upload backup & original archives
./deploy.sh PROJECT_ID REGION --example-sentences  # Deploy + migrate embedded examples
```

### No test or lint commands are configured.

## Architecture

Full-stack vocabulary quiz app for Chinese (HSK levels): **Fastify 5 backend** + **React 19 / Vite 6 frontend**.

### Backend (`backend/src/`)
- **Entry**: `index.ts` — Fastify server with pino logging (stdout + file), CORS, route registration
- **Routes** (each is a `FastifyPluginAsync` registered under `/api`):
  - `routes/languages.ts` — lists available languages from Firestore
  - `routes/vocab.ts` — CRUD for vocabulary words + smart-add with LLM. Smart-add always asks the LLM for definitions and example translations in all four supported codes (`en`/`ja`/`ko`/`zh`) — `ALL_DEFINITION_LANGUAGES` is hardcoded; the language values in the request body are treated as user-supplied anchors only. Chinese levels are normalized at storage time by `CHINESE_LEVEL_NORMALIZE` into the merged HSK buckets.
  - `routes/quiz.ts` — word quiz sessions with weighted random sampling; hydrated questions include `hanjaReadings`
  - `routes/progress.ts` — per-word progress tracking
  - `routes/flagged.ts` — flagged words for review
  - `routes/grammar.ts` — CRUD for grammar items, chapters, subchapters
  - `routes/grammar-quiz.ts` — grammar quiz with self-grading, two modes; also exposes `check-missing-words` and `add-missing-words`
  - `routes/grammar-progress.ts` — per-component grammar progress
  - `routes/translation.ts` — two-step translation/analysis: decomposition (MINI model) then parallel translation per target language (FULL model); SSE streaming via `POST /translate-stream`
  - `routes/speaking-writing.ts` — text correction for speaking/writing practice; SSE streaming with language-specific prompts + use-case context
  - `routes/metrics.ts` — LLM token usage tracking and cost estimation
- **Database**: `firestore.ts` — Google Cloud Firestore abstraction layer. `updateWord` per-sentence-merges old example `segments` onto the incoming `examples` whenever the sentence text is unchanged, so `WordFormModal` (which doesn't carry segments through its form state) doesn't wipe LLM-generated pinyin on every save. `getCanonicalSegmentPinyin(word)` returns `undefined` for polyphonic words so callers keep the LLM-generated contextual value.
- **LLM**: `llm.ts` — Azure OpenAI integration. `callLLM`/`callLLMWithSchema`/`streamLLMWithSchema` use MINI deployment; `callLLMFull`/`callLLMFullWithSchema`/`streamLLMFullWithSchema` use FULL deployment. Config loaded from `.env` (local) or Firestore `config/llm` (deployed). All LLM functions accept a `route` parameter and log token counts to Firestore.
- **Types**: `types.ts` — shared interfaces; `Word` carries optional `hanjaReadings?: HanjaReading[]` (`{ simplifiedChar, traditionalChar, hunEum[] }` per character)
- Errors via `@fastify/sensible`: `reply.notFound()`, `reply.badRequest()`, `reply.conflict()`

### Data Storage
- **Primary**: Google Cloud Firestore (database ID: `vocab-database`)
  - `languages` — language metadata (word count, topics, levels)
  - `words` — all vocabulary words partitioned by language field
  - `progress` — per-word progress (composite key: `{language}_{wordId}`)
  - `word_index` — fast term lookup (composite key: `{language}_{term}`)
  - `example_sentences` — normalized example sentences; words store `exampleIds` and `appearsInIds` arrays referencing this collection
  - `example_sentence_index` — dedup lookup (composite key: `{language}_{sha256(sentence).slice(0,16)}`)
  - `id_maps` — next ID counters per language
  - `word_groups` — user-defined word groups per language
  - `quiz_sessions`, `grammar_quiz_sessions` — one active session per language
  - `flagged_words`, `grammar_chapters`, `grammar_items`, `grammar_progress`
  - `translation_history`, `speaking_writing_sessions`
  - `config` — `config/llm` (Azure OpenAI keys), `config/token_costs`, `config/speaking_writing`, `config/translation`, `config/vocabulary`
  - `archive_backups`, `archive_originals` — chunked subcollections for large files
  - `token_usage`, `token_usage_daily` — LLM call logs and daily aggregates
- **Local files**: `backend/DB/word/`, `backend/DB/grammer/`, `backend/DB/speaking&writing/`, `backend/DB/translation/`, `backend/DB/vocabulary/`, `backend/DB/backup/`

### Language Code Convention
All language codes use ISO 639-1: `ja` (Japanese), `en` (English), `ko` (Korean), `zh` (Chinese). This applies to word definition keys, example sentence translation records, grammar data fields, and UI language selection. The export script normalizes legacy keys (e.g., `"Japanese"` → `"ja"`, `"kr"` → `"ko"`) on export.

### Frontend (`frontend/src/`)
- **Entry**: `main.tsx` → `App.tsx` (routes: `/` → `LanguageSelectPage`, `/:language/*` → `Dashboard`) → `Dashboard.tsx`
- **State**: React hooks + Context API (`i18n/context.tsx` for UI language, `settings/context.tsx` for app settings)
- **Settings**: `settings/context.tsx` — `SettingsProvider` + `useSettings()` hook; persisted to `localStorage("appSettings")`. Key fields:
  - `languageOrder` — drives definition/language selector/UI button ordering
  - `displayDefinitionLanguages`, `displayExampleTranslationLanguages` — client-side display filtering (LLM always generates all four languages)
  - `defaultAddWordLanguage` — backend full-name format (`"english"`, `"chinese"`) — **different from** `defaultDefinitionLanguage` (ISO code)
  - `showKoreanHanja` — toggles per-character hanja section in word cards, quiz answers, flagged review; only shown in Settings when active language is Chinese
- **API layer**: `api/client.ts` — `fetchJson`/`postJson`/`putJson`/`deleteRequest`; non-ok responses include body text in thrown error
- **Hooks**:
  - `hooks/useWordQueue.ts` — sequential word-addition queue; processes one-at-a-time so segment linking always sees the latest word DB
- **Key components**:
  - `SmartAddWordModal.tsx` — **two independent language fields**: outer "word language" (backend full-name, `:language` param) vs. per-row "definition language" (ISO code). In queue mode (`onQueue` prop provided), Submit enqueues immediately and resets the form.
  - `WordList.tsx` — paginated browse; segment chips show `✓`/`+`/`⋯` states; auto-patches unlinked segments via `sync-segment-links` on expand
  - `WordFormModal.tsx` — manual edit form; does not carry `segments` through form state (preserved server-side by `firestore.ts:updateWord`)
  - `Dashboard.tsx` — URL sub-paths per view (`/browse`, `/quiz`, `/flagged`, `/grammar`, `/grammar-quiz`, `/translation`, `/speaking-writing`); drives queue status pill and toast notifications
  - `RubyText.tsx` — ruby annotation for pinyin/furigana above characters
  - `TranslationView.tsx`, `SpeakingWritingView.tsx` — SSE streaming views with session persistence
  - `QuizFilterModal.tsx` — topics, categories, levels, word groups filter before quiz start
  - `MetricsView.tsx` — LLM token usage dashboard with cost estimates
- **i18n**: `i18n/translations.ts` — English, Japanese, Korean
- **Styling**: Tailwind CSS 4 utility classes only
- **Proxy**: Vite proxies `/api` to `localhost:3000` in dev; Nginx in production

### TypeScript Config
- Backend: ES2024, NodeNext modules, strict mode
- Frontend: ES2024, ESNext modules, bundler resolution

### Key Dependencies
- Backend: fastify, @fastify/cors, @fastify/sensible, @google-cloud/firestore, openai (Azure), dotenv
- Frontend: react, react-dom, vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite, @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities
