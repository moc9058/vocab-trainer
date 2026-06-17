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

Full-stack vocabulary quiz app supporting four study languages (`en`/`ja`/`ko`/`zh`; HSK levels apply only to Chinese): **Fastify 5 backend** + **React 19 / Vite 6 frontend**.

### Backend (`backend/src/`)
- **Routes** (each is a `FastifyPluginAsync` registered under `/api`):
  - `routes/vocab.ts` — smart-add always asks LLM for all four codes (`en`/`ja`/`ko`/`zh`) — `ALL_DEFINITION_LANGUAGES` is hardcoded; request body languages are anchors only. Chinese levels normalized at storage time by `CHINESE_LEVEL_NORMALIZE`.
  - `routes/quiz.ts` — uses `randomSample` (NOT weighted; weighted lives only in `grammar-quiz.ts:weightedSample`). 2-step hydration: `POST /start` returns lightweight `{wordId, term}` only; client pages `GET /questions/:language?offset&limit` (`BATCH_SIZE=50` in `QuizTaking.tsx`) for `definitions`/`examples`/`hanjaReadings`. Wrong answers call `insertRetryQuestion` server-side, which splices the missed word back into `session.questions` and reshuffles the tail — `score.total` grows accordingly; the frontend re-renders from the mutated session.
  - `routes/grammar-quiz.ts` — also exposes `check-missing-words` and `add-missing-words`
  - `routes/translation.ts` / `routes/speaking-writing.ts` — SSE streaming via POST endpoint
  - `routes/translation.ts` — `language` prop = **target** language (active study language); user selects source. Two-step: decompose (MINI, source-lang prompt) → translate (FULL, target-lang prompt). Output uses `passages[].{ sentenceIds[], translation }` — LLM may group consecutive sentences. `buildTranslateSystemPrompt` appends source/target + approach guidance to the Firestore prompt without needing a migration.
- **Database**: `firestore.ts` — `updateWord` per-sentence-merges old example `segments` onto incoming `examples` when sentence text is unchanged, so `WordFormModal` (which doesn't carry segments through form state) doesn't wipe LLM-generated pinyin on save. `getCanonicalSegmentPinyin(word)` returns `undefined` for polyphonic words so callers keep the LLM-generated contextual value.
- **LLM**: `llm.ts` — `callLLM*` functions use the MINI OpenAI model; `callLLMFull*` use the FULL OpenAI model. Config from `.env` (local) or Firestore `config/llm` (deployed).
- **Types**: `types.ts` — `Word` carries optional `hanjaReadings?: HanjaReading[]` (`{ simplifiedChar, traditionalChar, hunEum[] }` per character)
- **Type mirroring**: `backend/src/types.ts` and `frontend/src/types.ts` share translation interfaces (`TranslationResult`, `TranslationPassage`, `TranslationEntry`) — update both files together.

### Data Storage
- **Firestore** (database ID: `vocab-database`). Key composite keys: `progress`/`word_index` use `{language}_{wordId}`, `example_sentence_index` uses `{language}_{sha256(sentence).slice(0,16)}`.
- `example_sentences` — normalized; words store `exampleIds` and `appearsInIds` arrays referencing this collection
- `config` subcollections: `config/llm`, `config/token_costs`, `config/speaking_writing`, `config/translation`, `config/vocabulary`
  - `config/translation` fields: `decomposeSchema`, `decomposePrompts`, `translateSchema`, `translatePrompts` — local source in `backend/DB/translation/`; push with `migrate-db-config-to-firestore.ts --prompts`
- **Local files**: `backend/DB/` (grammer, speaking&writing, translation, vocabulary, backup, old, original). Word JSON is no longer mirrored locally — Firestore is the source of truth; `old/` and `original/` hold pre-migration HSK archives.

### Language Code Convention
All language codes use ISO 639-1: `ja`, `en`, `ko`, `zh`. The export script normalizes legacy keys (e.g., `"Japanese"` → `"ja"`, `"kr"` → `"ko"`) on export.

### Frontend (`frontend/src/`)
- **Settings**: `settings/context.tsx` — persisted to `localStorage("appSettings")`.
  - `defaultAddWordLanguage` — backend full-name format (`"english"`, `"chinese"`) — **different from** `defaultDefinitionLanguage` (ISO code)
  - `showKoreanHanja` — only shown in Settings when active language is Chinese
- **API layer**: `api/client.ts` — non-ok responses include body text in thrown error
- **i18n in sub-components**: Module-level React components (outside `TranslationView`) must explicitly call `const { t } = useI18n()` — they don't inherit it from parent scope.
- **Key components**:
  - `SmartAddWordModal.tsx` — **two independent language fields**: outer "word language" (backend full-name) vs. per-row "definition language" (ISO code). Queue mode (`onQueue` prop): Submit enqueues immediately and resets form.
  - `WordFormModal.tsx` — does not carry `segments` through form state (preserved server-side by `firestore.ts:updateWord`)
  - `hooks/useWordQueue.ts` — processes one-at-a-time so segment linking always sees the latest word DB
  - `Dashboard.tsx` — URL sub-paths: `/browse`, `/quiz`, `/flagged`, `/grammar`, `/grammar-quiz`, `/translation`, `/speaking-writing`
