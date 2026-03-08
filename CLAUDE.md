# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```bash
cd backend && npm run dev      # Dev server with watch (tsx watch src/index.ts)
cd backend && npm run build    # TypeScript compile to dist/
cd backend && npm start        # Run compiled output (node dist/index.js)
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

Full-stack vocabulary quiz app: **Fastify 5 backend** + **React 19 / Vite 6 frontend**.

### Backend (`backend/src/`)
- **Entry**: `index.ts` — Fastify server with pino logging (stdout + file), CORS, route registration
- **Routes** (each is a `FastifyPluginAsync` registered under `/api`):
  - `routes/languages.ts` — lists available vocab files from `DB/` directory
  - `routes/vocab.ts` — CRUD for vocabulary words (filtering, pagination, word ID generation)
  - `routes/quiz.ts` — quiz sessions with weighted random sampling (unseen=5, accuracy penalty, staleness bonus)
  - `routes/progress.ts` — per-word progress tracking (timesSeen, correctRate, streak)
- **Storage**: `storage.ts` — file-based JSON persistence with atomic writes (temp file → rename)
- **Types**: `types.ts` — shared interfaces (Word, VocabFile, QuizSession, etc.)
- Route handlers use Fastify generics for type-safe Params/Querystring/Body and JSON schema validation
- Errors via `@fastify/sensible`: `reply.notFound()`, `reply.badRequest()`, `reply.conflict()`

### Data Storage (no database)
- Vocabulary: `backend/DB/{language}.json` — JSON with meta + words array
- Progress: `backend/data/progress/{language}.json`
- Quiz history: `backend/data/quiz-history.json`
- Logs: `backend/logs/app-{timestamp}.log`

### Frontend (`frontend/src/`)
- **Entry**: `main.tsx` → `App.tsx` — conditional render: LanguagePicker or Dashboard
- **State**: React hooks + Context API (i18n only via `i18n/context.tsx`)
- **API layer**: `api/client.ts` (generic fetchJson/postJson), `api/quiz.ts` (quiz-specific wrappers)
- **Components**: LanguagePicker → Dashboard (Sidebar + SessionDetail/QuizTaking + EmptyState)
- **i18n**: `i18n/translations.ts` — English and Chinese, keyed by `TranslationKey` type
- **Styling**: Tailwind CSS 4 utility classes only
- **Proxy**: Vite proxies `/api` requests to `localhost:3000` in dev

### TypeScript Config
- Backend: ES2024, NodeNext modules, strict mode
- Frontend: ES2024, ESNext modules, bundler resolution
