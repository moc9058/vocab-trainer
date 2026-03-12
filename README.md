# Vocab Trainer

A vocabulary testing tool that helps users memorize vocabularies and view example sentences.

## Cloud Run Deployment

Deploy both services to Google Cloud Run using the included script.

### Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Cloud Run API enabled (`gcloud services enable run.googleapis.com`)
- Artifact Registry repositories created: `vocab-test-backend` and `vocab-test-frontend`
- Docker running locally

### Deploy

```bash
./deploy.sh vocab-trainer asia-northeast1
```

This will:
1. Build and push backend image to `asia-northeast1-docker.pkg.dev/vocab-trainer/vocab-test-backend/backend`
2. Deploy backend to Cloud Run
3. Build and push frontend image to `asia-northeast1-docker.pkg.dev/vocab-trainer/vocab-test-frontend/frontend`
4. Deploy frontend to Cloud Run with `BACKEND_URL` pointing to the backend service

The script prints both service URLs on completion.

## Quickstart

### Prerequisites

- **Docker** and **Docker Compose**

1. **Build and start both services**
   ```bash
   docker compose up --build
   ```

2. **Open the app** at http://localhost:5173. The backend API is available at http://localhost:3000.

To build images individually:
```bash
docker compose build backend     # backend image only
docker compose build frontend    # frontend image only
```

To run in the background:
```bash
docker compose up -d --build
docker compose logs -f           # follow logs
docker compose down              # stop and remove containers
```

## Vocabulary Database Format

Vocabulary files are stored as JSON under `backend/DB/`, with one file per language (e.g. `arabic.json`, `chinese.json`, `english.json`).

### JSON Structure

```json
{
  "words": [
    {
      "id": "zh-000001",
      "term": "你好",
      "transliteration": "nǐ hǎo",
      "definition": {
        "Japanese": "こんにちは",
        "English": "hello",
        "Korean": "안녕하세요"
      },
      "grammaticalCategory": "interjection",
      "examples": [
        {
          "sentence": "你好，你怎么样？",
          "translation": "こんにちは、お元気ですか？"
        }
      ],
      "topics": ["Greetings & Introductions"],
      "level": "HSK1",
      "notes": ""
    }
  ]
}
```

### Field Definitions

- **`id`** — Unique identifier per word, useful for tracking quiz progress. Pattern: `{lang}-{number}`, where `{lang}` is an [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) language code:
  | Language | Code | Example ID |
  |----------|------|------------|
  | Chinese  | `zh` | `zh-000001` |
  | English  | `en` | `en-000001` |
  | Arabic   | `ar` | `ar-000001` |
- **`term`** — The vocabulary word in the target language.
- **`transliteration`** — Optional. Romanized pronunciation, critical for non-Latin scripts (Arabic, Chinese).
- **`definition`** — An object keyed by language, allowing definitions in multiple languages (English, Japanese, Korean, etc.).
- **`grammaticalCategory`** — The grammatical category of the word. Possible values:
  - `noun` — person, place, thing, or concept (e.g. book, city)
  - `verb` — action or state (e.g. run, be)
  - `adjective` — describes a noun (e.g. big, beautiful)
  - `adverb` — describes a verb, adjective, or other adverb (e.g. quickly, very)
  - `pronoun` — replaces a noun (e.g. he, they)
  - `preposition` — shows relationship between words (e.g. in, on, at)
  - `conjunction` — connects words or clauses (e.g. and, but)
  - `interjection` — expresses emotion (e.g. hello, wow)
  - `determiner` — specifies a noun (e.g. the, this, some)
  - `particle` — grammatical function word with no direct translation (common in Chinese, Japanese, Korean)
  - `classifier` — measure word used with nouns (common in Chinese, Japanese)
  - `numeral` — number word (e.g. one, two, three)
  - `onomatopoeia` — sound-imitating word (e.g. 哗哗, 咚咚, bang)
  - `phrase` — a multi-word expression or idiom
- **`examples`** — Array of example sentences with translations (primary language is Japanese).
- **`topics`** — Topic tags for categorizing and filtering words. Possible values:
  - **Everyday Life:** `Greetings & Introductions`, `Food & Dining`, `Shopping & Money`, `Travel & Transportation`, `Weather & Seasons`, `Family & Relationships`, `Health & Body`, `Home & Housing`
  - **Academic / Professional:** `Economics & Finance`, `Politics & Government`, `Science & Technology`, `Law & Justice`, `Medicine`, `Education`, `Business & Commerce`
  - **Culture & Society:** `Arts & Entertainment`, `Sports & Fitness`, `Religion & Philosophy`, `History`, `Media & News`
  - **Language Fundamentals:** `Numbers & Time`, `Colors & Shapes`, `Verbs of Motion`, `Common Adjectives`, `Conjunctions & Prepositions`
- **`level`** — Optional. Proficiency level tag for the word (e.g. `"HSK1"`, `"HSK2"`, …, `"HSK7~9"` for Chinese). Can be any string value.
- **`notes`** — Optional. Free-form field for irregularities, mnemonics, etc.

## Project Structure

```
vocab-trainer/
├── docker-compose.yml           # Docker orchestration
├── backend/
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── src/
│   │   ├── index.ts             # Fastify server entry point
│   │   ├── types.ts             # Shared TypeScript interfaces
│   │   ├── storage.ts           # File-based persistence layer
│   │   └── routes/
│   │       ├── languages.ts     # /api/languages
│   │       ├── vocab.ts         # /api/vocab
│   │       ├── progress.ts      # /api/progress
│   │       └── quiz.ts          # /api/quiz
│   ├── DB/                      # Vocabulary JSON files
│   └── data/
│       ├── progress/            # Per-language progress files
│       └── quiz-history.json    # Quiz session history
├── frontend/
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── types.ts
│       ├── api/
│       │   ├── client.ts        # Generic fetch/post utilities
│       │   ├── quiz.ts          # Quiz API wrappers
│       │   └── vocab.ts         # Vocabulary API wrappers
│       ├── components/
│       │   ├── Dashboard.tsx     # Main layout
│       │   ├── Sidebar.tsx       # Session list
│       │   ├── SessionDetail.tsx # Session details view
│       │   ├── QuizTaking.tsx    # Active quiz interface
│       │   ├── LanguageSelectModal.tsx
│       │   ├── QuizFilterModal.tsx
│       │   └── EmptyState.tsx
│       └── i18n/                # Internationalization (en, zh)
```

## Tech Stack

| Layer    | Technology                                            |
| -------- | ----------------------------------------------------- |
| Backend  | Fastify 5, TypeScript, @fastify/cors, @fastify/sensible |
| Frontend | React 19, Vite 6, Tailwind CSS 4                     |
| Deploy   | Docker (Node 24 Alpine), `serve` for static frontend  |

## Backend API Reference

### Languages

#### `GET /api/languages/` — List available languages

**Response:**
```json
[
  {
    "filename": "chinese.json",
    "language": "Chinese",
    "topics": ["Greetings & Introductions"],
    "wordCount": 4
  }
]
```

---

### Vocabulary

#### `GET /api/vocab/:language` — List words (with filtering and pagination)

| Query Param | Type   | Default | Description                                    |
| ----------- | ------ | ------- | ---------------------------------------------- |
| `search`    | string | —       | Matches term, transliteration, or definition   |
| `topic`     | string | —       | Filter by topic                                |
| `category`  | string | —       | Filter by grammaticalCategory                  |
| `level`     | string | —       | Filter by level                                |
| `page`      | number | 1       | Page number (min 1)                            |
| `limit`     | number | 50      | Items per page (max 100)                       |

**Response:** `PaginatedResult<Word>`
```json
{
  "items": [ /* Word objects */ ],
  "total": 4,
  "page": 1,
  "limit": 50,
  "totalPages": 1
}
```

#### `GET /api/vocab/:language/filters` — Get available filter options

**Response:**
```json
{
  "topics": ["Greetings & Introductions"],
  "categories": ["interjection", "noun", "verb"],
  "levels": ["HSK1", "HSK2"]
}
```

#### `GET /api/vocab/:language/:wordId` — Get single word

**Response:** `Word` object (see [Vocabulary Database Format](#vocabulary-database-format)).

#### `POST /api/vocab/:language` — Add new word

**Body:** Word fields (`term` and `definition` required). `id` is auto-generated if omitted.

**Response:** `201` with the created `Word`.

#### `PUT /api/vocab/:language/:wordId` — Update word

**Body:** Partial word fields to update.

**Response:** Updated `Word`.

#### `DELETE /api/vocab/:language/:wordId` — Delete word

**Response:** `204 No Content`

#### `POST /api/vocab/:language/file` — Create new language file

**Response:** `201` with the new `VocabFile` (empty `words` array).

#### `DELETE /api/vocab/:language/file` — Delete language file

**Response:** `204 No Content`

---

### Progress

#### `GET /api/progress/:language` — Get progress for all words in a language

**Response:**
```json
{
  "language": "chinese",
  "words": {
    "zh-greet-001": {
      "timesSeen": 5,
      "timesCorrect": 4,
      "correctRate": 0.8,
      "lastReviewed": "2026-03-08T12:00:00.000Z",
      "streak": 3
    }
  }
}
```

#### `GET /api/progress/:language/:wordId` — Get progress for a single word

**Response:** `WordProgress` object (defaults to zeroes if no progress exists).

#### `DELETE /api/progress/:language` — Reset all progress for a language

**Response:** `204 No Content` (deletes the progress file).

---

### Quiz

#### `POST /api/quiz/start` — Start a new quiz session

**Body:**
```json
{
  "language": "chinese",
  "questionCount": 10,
  "topics": ["Greetings & Introductions"],
  "categories": ["noun", "verb"],
  "levels": ["HSK1"],
  "questionType": "definition"
}
```

All fields except `language` are optional (`questionCount` defaults to 10, max 100).

Words are selected using **weighted random sampling**:
- Unseen words get weight **5**
- Lower accuracy → higher weight: `1 + (1 - correctRate) * 4`
- Staleness bonus: `daysSinceReview * 0.5` (capped at 7 days)

**Response:** `201` with `QuizSession`.

#### `POST /api/quiz/answer` — Submit an answer

**Body:**
```json
{
  "sessionId": "qs-1772976596749",
  "wordId": "zh-greet-001",
  "correct": true
}
```

**Response:** `{ session, wordProgress }` — updated session state and word progress.

When all questions are answered the session status changes to `"completed"`.

#### `GET /api/quiz/session/:sessionId` — Get current session state

**Response:** `QuizSession` object.

#### `GET /api/quiz/history` — List past sessions (summaries)

| Query Param | Type   | Description        |
| ----------- | ------ | ------------------ |
| `language`  | string | Filter by language |

**Response:** Array of session summaries (without `questions`).

#### `GET /api/quiz/history/:sessionId` — Get full session details

**Response:** Full `QuizSession` (includes all questions).

#### `DELETE /api/quiz/history/:sessionId` — Delete a session

**Response:** `204 No Content`

#### `POST /api/quiz/history/import` — Import sessions

**Body:** `{ "sessions": [ /* QuizSession[] */ ] }`

**Response:** `{ "imported": 5, "total": 12 }`

#### `GET /api/quiz/history/export` — Export all history

**Response:** `{ "sessions": [ /* QuizSession[] */ ] }`

---

## Frontend

React 19 single-page application for taking vocabulary quizzes and reviewing past sessions. Built with Vite 6 and styled with Tailwind CSS 4. Supports English and Chinese UI via a custom i18n context (no external library).

### Screens / Views

| View                    | Description                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Dashboard**           | Main layout. Header with "Start Quiz" button + two-column body: Sidebar (quiz session list) + main content area. Fetches history on mount. |
| **Sidebar**             | Scrollable list of quiz sessions showing language, status badge, date, and score. Click a session to select it.    |
| **SessionDetail**       | Full detail of a selected session: metadata grid + questions table (term, expected answer, correct/incorrect/unanswered). |
| **QuizTaking**          | Active quiz interface — displays the current question and records answers. On completion, returns to the history view. |
| **LanguageSelectModal** | Modal to pick the target language when starting a new quiz. Lists languages fetched from the API.                  |
| **QuizFilterModal**     | Modal to select topic, category, and level filters before starting a quiz. Supports "Select All" / "Clear All" actions. Level column only appears when words have levels set. |
| **EmptyState**          | Placeholder shown when no quiz history exists.                                                                     |

### API Integration

- **`api/client.ts`** — Generic `fetchJson<T>()` and `postJson<T>()` utilities wrapping the Fetch API.
- **`api/quiz.ts`** — `getHistory(language?)`, `getSessionDetails(sessionId)`, `startQuiz(opts)`, and `answerQuestion(opts)`.
- **`api/vocab.ts`** — `getFilters(language)` for retrieving available topics, categories, and levels.
- **Dev proxy:** Vite proxies `/api/*` to `http://localhost:3000` so the frontend dev server can reach the backend.

### Internationalization

- Context-based (`i18n/context.tsx`): `I18nProvider` + `useI18n()` hook.
- 34 translation keys defined in `i18n/translations.ts` for English.
- Type-safe keys via the `TranslationKey` type.

### State Management

React hooks (`useState`, `useEffect`) + Context API. No external state library.

### Styling

Tailwind CSS 4 utility classes only — no custom CSS beyond the Tailwind import.

---

## Data Storage

All data is stored as JSON files on disk — no database required.

| Directory                | Contents                         |
| ------------------------ | -------------------------------- |
| `backend/DB/`            | Vocabulary files (`{lang}.json`) |
| `backend/data/progress/` | Per-language progress files      |
| `backend/data/`          | `quiz-history.json`              |

**Atomic writes:** Every file write goes through a temp file (`path.{randomHex}.tmp`) which is then renamed to the target path. This prevents corruption if the process is interrupted mid-write.

## Configuration

| Variable | Default   | Description              |
| -------- | --------- | ------------------------ |
| `PORT`   | `3000`    | Server listening port    |
| `HOST`   | `0.0.0.0` | Server listening address |

## Docker

Both Dockerfiles use **Node 24 Alpine** with multi-stage builds to keep images small.

| Service    | Port | Description                                          |
| ---------- | ---- | ---------------------------------------------------- |
| `backend`  | 3000 | Multi-stage build → `node dist/index.js` (production deps only) |
| `frontend` | 5173 | Multi-stage build → Vite static output served with `serve -s`   |

See [Quickstart](#quickstart) for usage.
