# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```bash
cd backend && npm run dev               # Dev server with watch (tsx watch src/index.ts)
cd backend && npm run build             # TypeScript compile to dist/
cd backend && npm start                 # Run compiled output (node dist/index.js)
cd backend && npm run restructure       # Split chinese.json into per-HSK-level files + word_index
cd backend && npm run generate-extended # Generate extended vocab via Azure OpenAI
cd backend && npm run migrate           # One-time migration from JSON files to Firestore
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

### No test or lint commands are configured.

## Architecture

Full-stack vocabulary quiz app for Chinese (HSK levels): **Fastify 5 backend** + **React 19 / Vite 6 frontend**.

### Backend (`backend/src/`)
- **Entry**: `index.ts` — Fastify server with pino logging (stdout + file), CORS, route registration
- **Routes** (each is a `FastifyPluginAsync` registered under `/api`):
  - `routes/languages.ts` — lists available languages from Firestore
  - `routes/vocab.ts` — CRUD for vocabulary words (filtering, pagination, word lookup by term via word_index)
  - `routes/quiz.ts` — quiz sessions with weighted random sampling (unseen=5, accuracy penalty, staleness bonus)
  - `routes/progress.ts` — per-word progress tracking (timesSeen, correctRate, streak)
- **Database**: `firestore.ts` — Google Cloud Firestore abstraction layer (collections: languages, words, progress, word_index, id_maps, quiz_sessions)
- **Storage**: `storage.ts` — legacy file-based JSON persistence (atomic writes via temp file → rename)
- **Types**: `types.ts` — shared interfaces (Word, VocabFile, QuizSession, WordProgress, etc.)
- Route handlers use Fastify generics for type-safe Params/Querystring/Body and JSON schema validation
- Errors via `@fastify/sensible`: `reply.notFound()`, `reply.badRequest()`, `reply.conflict()`

### Backend Scripts (`backend/scripts/`)
- `restructure-db.ts` — splits `chinese.json` into per-HSK-level files (`HSK1.json`–`HSK7-9.json`), creates empty extended files, builds `word_index.json`
- `generate-extended.ts` — uses Azure OpenAI to generate additional vocabulary from existing example sentences; requires `AZURE_OPENAI_*` env vars
- `migrate-to-firestore.ts` — one-time migration from file-based JSON to Firestore; requires Google Cloud credentials

### Data Storage
- **Primary**: Google Cloud Firestore (database ID: `vocab-database`)
  - `languages` — language metadata (word count, topics, levels)
  - `words` — all vocabulary words partitioned by language field
  - `progress` — per-word progress (composite key: `{language}_{wordId}`)
  - `word_index` — fast term lookup (composite key: `{language}_{term}`)
  - `id_maps` — next ID counters per language
  - `quiz_sessions` — one active session per language
- **Local files** (legacy/scripts):
  - Vocabulary: `backend/DB/HSK{1-6}.json`, `backend/DB/HSK7-9.json` — per-level vocab files
  - Extended vocab: `backend/DB/HSK{1-6}-extended.json`, `backend/DB/HSK7-9-extended.json`
  - Word index: `backend/DB/word_index.json` — term → {id, level, pinyin}
  - Progress: `backend/data/progress/{language}.json`
  - Logs: `backend/logs/app-{timestamp}.log`

### Key API Endpoints
- `GET /api/languages` — list languages
- `GET /api/vocab/:language` — list words (query: search, topic, category, level, page, limit)
- `GET /api/vocab/:language/filters` — available filter options (topics, categories, levels)
- `GET /api/vocab/:language/lookup?term=X` — word lookup via word_index
- `POST /api/vocab/:language` — add word (auto-generates ID like `zh-000001`)
- `PUT /api/vocab/:language/:wordId` — update word
- `DELETE /api/vocab/:language/:wordId` — delete word
- `POST /api/quiz/start` — start quiz session (body: language, questionCount, topics, categories, levels, questionType)
- `POST /api/quiz/answer` — submit answer (body: sessionId, wordId, correct)
- `GET /api/quiz/session/language/:language` — get current session
- `GET /api/progress/:language` — all progress for language
- `DELETE /api/progress/:language` — reset progress

### Frontend (`frontend/src/`)
- **Entry**: `main.tsx` → `App.tsx` → `Dashboard.tsx`
- **State**: React hooks + Context API (i18n only via `i18n/context.tsx`)
- **API layer**: `api/client.ts` (generic fetchJson/postJson), `api/quiz.ts`, `api/vocab.ts`
- **Components**:
  - `Dashboard.tsx` — main layout with header, modals, quiz/word list orchestration
  - `LanguageSelectModal.tsx` — language picker modal
  - `QuizFilterModal.tsx` — multi-select filters (topic, category, level) before starting quiz
  - `QuizTaking.tsx` — quiz UI with question display, answer input, progress bar
  - `WordList.tsx` — paginated word browsing with filters, progress badges, expandable details
  - `EmptyState.tsx` — welcome state when no quiz/browse active
- **i18n**: `i18n/translations.ts` — English and Chinese, keyed by `TranslationKey` type
- **Styling**: Tailwind CSS 4 utility classes only
- **Proxy**: Vite proxies `/api` requests to `localhost:3000` in dev
- **Production**: Nginx serves static assets, proxies `/api/` to backend (configured via `nginx.conf.template`)

### TypeScript Config
- Backend: ES2024, NodeNext modules, strict mode
- Frontend: ES2024, ESNext modules, bundler resolution

### Key Dependencies
- Backend: fastify, @fastify/cors, @fastify/sensible, @google-cloud/firestore, openai (Azure), dotenv
- Frontend: react, react-dom, vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite
