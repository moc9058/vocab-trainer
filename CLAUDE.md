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
```

### No test or lint commands are configured.

## Architecture

Full-stack vocabulary quiz app for Chinese (HSK levels): **Fastify 5 backend** + **React 19 / Vite 6 frontend**.

### Backend (`backend/src/`)
- **Entry**: `index.ts` — Fastify server with pino logging (stdout + file), CORS, route registration
- **Routes** (each is a `FastifyPluginAsync` registered under `/api`):
  - `routes/languages.ts` — lists available languages from Firestore
  - `routes/vocab.ts` — CRUD for vocabulary words + smart-add with LLM (filtering, pagination, word lookup)
  - `routes/quiz.ts` — word quiz sessions with weighted random sampling
  - `routes/progress.ts` — per-word progress tracking (timesSeen, correctRate, streak)
  - `routes/flagged.ts` — flagged words for review
  - `routes/grammar.ts` — CRUD for grammar items, chapters, subchapters
  - `routes/grammar-quiz.ts` — grammar quiz with self-grading, two modes (existing examples / LLM-generated)
  - `routes/grammar-progress.ts` — per-component grammar progress
  - `routes/translation.ts` — translation/analysis with parallel LLM calls, history persistence
- **Database**: `firestore.ts` — Google Cloud Firestore abstraction layer
- **LLM**: `llm.ts` — Azure OpenAI integration (callLLM/callLLMFull with JSON mode, validateWord, segmentBatch); `callLLM` uses MINI deployment, `callLLMFull` uses FULL deployment (for translation); config loaded from `.env` (local) or Firestore `config/llm` (deployed)
- **Types**: `types.ts` — shared interfaces (Word, VocabFile, QuizSession, WordProgress, TranslationEntry, etc.)
- Route handlers use Fastify generics for type-safe Params/Querystring/Body and JSON schema validation
- Errors via `@fastify/sensible`: `reply.notFound()`, `reply.badRequest()`, `reply.conflict()`

### Backend Scripts (`backend/scripts/`)
- `migrate-to-firestore.ts` — word migration from JSON files in `DB/word/` to Firestore; backs up current Firestore words to `DB/backup/{language}_{YYYYMMDD}.json` first
- `export-from-firestore.ts` — export words, grammar, and progress from Firestore back to JSON files in `DB/` (inverse of migrate); normalizes legacy language keys to ISO 639-1
- `migrate-grammar-to-firestore.ts` — grammar migration from `backend/DB/grammer/` JSON to Firestore; backs up current Firestore grammar to `DB/backup/{language}/` first
- `migrate-llm-config-to-firestore.ts` — uploads Azure OpenAI config from `.env` to Firestore `config/llm` document

### Data Storage
- **Primary**: Google Cloud Firestore (database ID: `vocab-database`)
  - `languages` — language metadata (word count, topics, levels)
  - `words` — all vocabulary words partitioned by language field
  - `progress` — per-word progress (composite key: `{language}_{wordId}`)
  - `word_index` — fast term lookup (composite key: `{language}_{term}`)
  - `id_maps` — next ID counters per language
  - `quiz_sessions` — one active word quiz session per language
  - `flagged_words` — flagged words for review
  - `grammar_chapters` — grammar chapter metadata per language
  - `grammar_items` — flattened grammar components (denormalized chapter/subchapter info)
  - `grammar_progress` — per-component grammar progress
  - `grammar_quiz_sessions` — one grammar quiz session per language
  - `translation_history` — translation/analysis entries with structured LLM results
  - `config` — app configuration (e.g., `config/llm` stores Azure OpenAI keys)
- **Local files** (for migration/export):
  - Vocabulary: `backend/DB/word/{language}.json` — one file per language (e.g. `chinese.json`)
  - Grammar: `backend/DB/grammer/chinese/*.json` — per-chapter grammar files
  - Progress: `backend/data/progress/{language}.json`
  - Backups: `backend/DB/backup/` — date-stamped word backups + grammar backups per language
  - Logs: `backend/logs/app-{timestamp}.log`

### Language Code Convention
All language codes use ISO 639-1: `ja` (Japanese), `en` (English), `ko` (Korean), `zh` (Chinese). This applies to:
- Word definition keys: `{ "ja": "...", "en": "...", "ko": "..." }`
- Grammar data `Record<string, string>` fields (chapterTitle, subchapter title, term, description)
- UI language selection and display language options
- The export script normalizes legacy keys (e.g., `"Japanese"` → `"ja"`, `"kr"` → `"ko"`) on export

### Key API Endpoints
- `GET /api/languages` — list languages
- `GET /api/vocab/:language` — list words (query: search, topic, category, level, page, limit)
- `GET /api/vocab/:language/filters` — available filter options (topics, categories, levels)
- `GET /api/vocab/:language/lookup?term=X` — word lookup via word_index
- `POST /api/vocab/:language/smart-add` — smart add word with LLM filling missing fields, auto-flag
- `PUT /api/vocab/:language/:wordId` — update word
- `DELETE /api/vocab/:language/:wordId` — delete word
- `POST /api/quiz/start` — start word quiz session
- `POST /api/quiz/answer` — submit answer (body: sessionId, wordId, correct)
- `GET /api/quiz/session/language/:language` — get current word quiz session
- `GET /api/progress/:language` — all progress for language
- `DELETE /api/progress/:language` — reset progress
- `GET /api/grammar/:language/chapters` — list grammar chapters
- `GET /api/grammar/:language/subchapters` — list subchapters (query: chapters)
- `GET /api/grammar/:language/items` — list grammar items (query: chapter, subchapter, level, search)
- `POST /api/grammar/:language/items` — add grammar item
- `PUT /api/grammar/:language/items/:componentId` — update grammar item
- `DELETE /api/grammar/:language/items/:componentId` — delete grammar item
- `POST /api/grammar-quiz/start` — start grammar quiz (body: language, chapters, subchapters, displayLanguage, quizMode)
- `POST /api/grammar-quiz/answer` — submit self-graded answer (body: language, componentId, correct)
- `GET /api/grammar-quiz/session/language/:language` — get current grammar quiz session
- `GET /api/grammar-progress/:language` — all grammar progress
- `DELETE /api/grammar-progress/:language` — reset grammar progress
- `POST /api/translation/translate` — parallel LLM translation/analysis (uses FULL model)
- `GET /api/translation/history` — paginated translation history
- `DELETE /api/translation/history` — clear all translation history
- `DELETE /api/translation/history/:id` — delete single translation entry

### Frontend (`frontend/src/`)
- **Entry**: `main.tsx` → `App.tsx` → `Dashboard.tsx`
- **State**: React hooks + Context API (i18n only via `i18n/context.tsx`)
- **API layer**: `api/client.ts` (generic fetchJson/postJson), `api/quiz.ts`, `api/vocab.ts`, `api/grammar.ts`, `api/translation.ts`
- **Components**:
  - `Dashboard.tsx` — main layout with header, modals, quiz/word list/grammar orchestration
  - `LanguageSelectModal.tsx` — language picker modal
  - `QuizFilterModal.tsx` — multi-select filters (topic, category, level) before starting word quiz
  - `QuizTaking.tsx` — word quiz UI with question display, answer input, progress bar
  - `WordList.tsx` — paginated word browsing with filters, progress badges, expandable details
  - `SmartAddWordModal.tsx` — add word with LLM filling missing fields
  - `GrammarList.tsx` — browse grammar by chapter/subchapter with inline edit/delete
  - `GrammarFilterModal.tsx` — grammar quiz filters (chapter, subchapter, display language, quiz mode)
  - `GrammarQuizTaking.tsx` — grammar quiz flashcard UI (display sentence → show answer → self-grade)
  - `GrammarFormModal.tsx` — add/edit grammar component with chapter/subchapter/topic/description/terms/examples
  - `FlaggedReview.tsx` — review flagged words
  - `TranslationView.tsx` — translation/analysis UI with language selection, structured results, and history navigation
  - `EmptyState.tsx` — home screen with vocabulary, translation, speaking & writing (placeholder), and grammar sections
- **i18n**: `i18n/translations.ts` — English, Japanese, and Korean, keyed by `TranslationKey` type
- **Styling**: Tailwind CSS 4 utility classes only
- **Proxy**: Vite proxies `/api` requests to `localhost:3000` in dev
- **Production**: Nginx serves static assets, proxies `/api/` to backend (configured via `nginx.conf.template`)

### TypeScript Config
- Backend: ES2024, NodeNext modules, strict mode
- Frontend: ES2024, ESNext modules, bundler resolution

### Key Dependencies
- Backend: fastify, @fastify/cors, @fastify/sensible, @google-cloud/firestore, openai (Azure), dotenv
- Frontend: react, react-dom, vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite
