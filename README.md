# Vocab Trainer

A vocabulary testing tool that helps users memorize vocabularies and view example sentences.

## Cloud Run Deployment

Deploy both services to Google Cloud Run using the included script.

### Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Cloud Run API enabled (`gcloud services enable run.googleapis.com`)
- Artifact Registry repositories created: `vocab-test-backend` and `vocab-test-frontend`
- Docker running locally

### Platform Notes

| Platform | Notes |
|---|---|
| **Mac (Apple Silicon)** | Docker Desktop must be running. The deploy script builds `linux/amd64` images automatically via `--platform` flag. |
| **Mac (Intel)** | Works out of the box. Docker Desktop must be running. |
| **Windows** | Run the deploy script via **WSL** or **Git Bash**. Docker Desktop must be running. |

### Deploy

https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app

```bash
./deploy.sh vocab-trainer-490014 asia-northeast1
```

REGION is optional and defaults to `us-central1`:

```bash
./deploy.sh vocab-trainer-490014                                     # uses us-central1
```

To also run Firestore data migrations during deploy:

```bash
./deploy.sh vocab-trainer-490014 asia-northeast1 --word              # word data only
./deploy.sh vocab-trainer-490014 asia-northeast1 --grammer           # grammar data only
./deploy.sh vocab-trainer-490014 asia-northeast1 --llm               # upload LLM config to Firestore
./deploy.sh vocab-trainer-490014 asia-northeast1 --word --grammer    # both migrations
./deploy.sh vocab-trainer-490014 asia-northeast1 --word --grammer --llm  # all migrations
```

### Migrate Data Only

Run the Firestore migration without a full deploy:

```bash
./migrate.sh vocab-trainer-490014              # default database "vocab-database"
./migrate.sh vocab-trainer-490014 my-db-id     # custom database ID
```

### Migrate Grammar Data Locally

```bash
cd backend && npx tsx scripts/migrate-grammar-to-firestore.ts
```

### Upload LLM Config Locally

```bash
cd backend && FIRESTORE_PROJECT=vocab-trainer-490014 npx tsx scripts/migrate-llm-config-to-firestore.ts
```

Reads Azure OpenAI keys from `.env` and writes them to Firestore `config/llm`. The backend will automatically fetch LLM config from Firestore when `.env` is not available (e.g., in deployed environments).

This will:
1. Build and push backend image to `asia-northeast1-docker.pkg.dev/vocab-trainer/vocab-test-backend/backend`
2. Deploy backend to Cloud Run
3. Run Firestore migration (only with `--word`, `--grammer`, and/or `--llm`)
4. Build and push frontend image to `asia-northeast1-docker.pkg.dev/vocab-trainer/vocab-test-frontend/frontend`
5. Deploy frontend to Cloud Run with `BACKEND_URL` pointing to the backend service

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
      "definitions": [
        {
          "partOfSpeech": "interjection",
          "text": {
            "ja": "こんにちは",
            "en": "hello",
            "ko": "안녕하세요"
          }
        }
      ],
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
- **`definitions`** — Array of meaning objects. A word may have multiple meanings when there are clear semantic distinctions (e.g., "打" as "to hit" vs. "to play"). Each meaning contains:
  - **`partOfSpeech`** — The grammatical category for this meaning. Possible values:
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
    - `set phrase` — fixed, conventionalized expression (e.g. 不客气, "by the way")
    - `phrasal verb` — verb + particle with non-compositional meaning (e.g. "give up", 放下)
    - `collocation` — commonly co-occurring word combination (e.g. 不太, "take a shower")
    - `proverb` — saying, maxim, or proverb (e.g. 三人行必有我师)
    - `greeting` — social formula phrase (e.g. 你好, おはよう)
  - **`text`** — An object keyed by ISO 639-1 language code (`ja`, `en`, `ko`, etc.), providing the definition in multiple languages.
- **`examples`** — Array of example sentences with translations (primary language is Japanese).
- **`topics`** — Topic tags for categorizing and filtering words. Possible values:
  - **Everyday Life:** `Greetings & Introductions`, `Food & Dining`, `Shopping & Money`, `Travel & Transportation`, `Weather & Seasons`, `Family & Relationships`, `Health & Body`, `Home & Housing`
  - **Academic / Professional:** `Economics & Finance`, `Politics & Government`, `Science & Technology`, `Law & Justice`, `Medicine`, `Education`, `Business & Commerce`, `Work & Career`
  - **Culture & Society:** `Nature & Environment`, `Arts & Entertainment`, `Sports & Fitness`, `Religion & Philosophy`, `History`, `Media & News`
  - **Language Fundamentals:** `Language Fundamentals`
- **`level`** — Optional. Proficiency level tag for the word (e.g. `"HSK1"`, `"HSK2"`, …, `"HSK7~9"` for Chinese). Can be any string value.
- **`notes`** — Optional. Free-form field for irregularities, mnemonics, etc.

## Project Structure

```
vocab-trainer/
├── deploy.sh                    # Full Cloud Run deployment script
├── migrate.sh                   # Standalone Firestore data migration
├── export.sh                    # Export data from Firestore
├── docker-compose.yml           # Docker orchestration
├── backend/
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── scripts/
│   │   ├── migrate-to-firestore.ts        # JSON → Firestore word migration (backs up to DB/backup/ first)
│   │   ├── migrate-grammar-to-firestore.ts # Grammar data → Firestore (backs up to DB/backup/ first)
│   │   ├── migrate-llm-config-to-firestore.ts # Upload LLM config (.env) → Firestore
│   │   └── export-from-firestore.ts       # Export words, grammar & progress from Firestore to JSON
│   ├── src/
│   │   ├── index.ts             # Fastify server entry point
│   │   ├── types.ts             # Shared TypeScript interfaces
│   │   ├── firestore.ts         # Google Cloud Firestore persistence layer
│   │   ├── word-generator.ts    # Background word generation logic
│   │   ├── llm.ts               # Azure OpenAI LLM integration
│   │   └── routes/
│   │       ├── languages.ts     # /api/languages
│   │       ├── vocab.ts         # /api/vocab
│   │       ├── progress.ts      # /api/progress
│   │       ├── quiz.ts          # /api/quiz
│   │       ├── flagged.ts       # /api/flagged
│   │       ├── grammar.ts       # /api/grammar
│   │       ├── grammar-quiz.ts  # /api/grammar-quiz
│   │       ├── grammar-progress.ts # /api/grammar-progress
│   │       └── translation.ts  # /api/translation
│   └── DB/                      # Vocabulary and grammar JSON files
├── frontend/
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── vite.config.ts
│   ├── nginx.conf.template      # Nginx config for production serving
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── types.ts
│       ├── api/
│       │   ├── client.ts        # Generic fetch/post/put/delete utilities
│       │   ├── quiz.ts          # Quiz API wrappers
│       │   ├── vocab.ts         # Vocabulary API wrappers
│       │   ├── grammar.ts       # Grammar & grammar quiz API wrappers
│       │   ├── flagged.ts       # Flagged words API wrappers
│       │   └── translation.ts   # Translation API wrappers
│       ├── components/
│       │   ├── Dashboard.tsx     # Main layout with quiz/browse orchestration
│       │   ├── QuizTaking.tsx    # Active quiz interface
│       │   ├── WordList.tsx      # Paginated word browsing with filters
│       │   ├── RubyText.tsx      # Ruby text component for pinyin annotations
│       │   ├── LanguageSelectModal.tsx
│       │   ├── LevelSelectModal.tsx
│       │   ├── QuizFilterModal.tsx
│       │   ├── WordFormModal.tsx
│       │   ├── SmartAddWordModal.tsx  # Smart add word with LLM
│       │   ├── FlaggedReview.tsx      # Review flagged words
│       │   ├── GrammarList.tsx        # Browse grammar by chapter/subchapter
│       │   ├── GrammarFilterModal.tsx # Grammar quiz filters
│       │   ├── GrammarQuizTaking.tsx  # Grammar quiz flashcard UI
│       │   ├── GrammarFormModal.tsx   # Add/edit grammar component
│       │   ├── TranslationView.tsx  # Translation/analysis UI with history
│       │   └── EmptyState.tsx
│       └── i18n/                # Internationalization (ja, en, ko)
```

## Tech Stack

| Layer    | Technology                                            |
| -------- | ----------------------------------------------------- |
| Backend  | Fastify 5, TypeScript, Google Cloud Firestore, @fastify/cors, @fastify/sensible |
| Frontend | React 19, Vite 6, Tailwind CSS 4                     |
| Deploy   | Docker (Node 24 Alpine), Nginx Alpine for static frontend |

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
| `search`    | string | —       | Matches term, transliteration, or definitions  |
| `topic`     | string | —       | Filter by topic                                |
| `category`  | string | —       | Filter by grammaticalCategory                  |
| `level`     | string | —       | Filter by level                                |
| `page`      | number | 1       | Page number (min 1)                            |
| `limit`     | number | 50      | Items per page (max 100)                       |
| `flaggedOnly` | string | —     | When `"true"`, return only flagged words       |

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

#### `PUT /api/vocab/:language/:wordId` — Update word

**Body:** Partial word fields to update.

**Response:** Updated `Word`.

#### `DELETE /api/vocab/:language/:wordId` — Delete word

**Response:** `204 No Content`

#### `POST /api/vocab/:language/file` — Create new language file

**Response:** `201` with the new `VocabFile` (empty `words` array).

#### `DELETE /api/vocab/:language/file` — Delete language file

**Response:** `204 No Content`

#### `GET /api/vocab/:language/lookup?term=X` — Look up word by term

Looks up a word by its term using the word_index for fast retrieval.

**Response:** `Word` object, or `404` if not found.

#### `POST /api/vocab/:language/smart-add` — Smart add word with LLM

Adds a word using the LLM to fill in missing fields. The word is auto-flagged for review. For Chinese, the LLM also generates word segments with pinyin for each example sentence, and any unknown words discovered in segments are auto-generated and returned.

**Body:**
```json
{
  "term": "努力",
  "transliteration": "",
  "definitions": [],
  "topics": [],
  "examples": []
}
```

Only `term` is required. All other fields are optional and will be filled by the LLM if omitted or empty.

**Response:** `201` with the created `Word`, plus an optional `generatedWords` array of auto-discovered words from example segments.

#### `GET /api/vocab/:language/transliteration-map` — Get transliteration map

Returns a mapping of terms to their transliteration (e.g., pinyin for Chinese). Triggers background word generation if configured.

**Response:**
```json
{
  "你好": "nǐ hǎo",
  "谢谢": "xiè xiè"
}
```

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

One quiz session is stored per language. Starting a new quiz overwrites the previous session. Wrong answers are re-queued and appear again until answered correctly.

#### `POST /api/quiz/start` — Start a new quiz session

Overwrites any existing session for the given language.

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

All fields except `language` are optional (`questionCount` defaults to all matching words).

Words are selected using **weighted random sampling**:
- Unseen words get weight **5**
- Lower accuracy → higher weight: `1 + (1 - correctRate) * 4`
- Staleness bonus: `daysSinceReview * 0.5` (capped at 7 days)

The response returns a lightweight session — questions contain only `wordId` and `term`. Full question details (definitions, transliteration, examples) are fetched separately via the batch endpoint below.

**Response:** `201` with `QuizSession` (lightweight questions).

#### `GET /api/quiz/questions/:language` — Fetch hydrated questions in batches

Returns full question details (definition, transliteration, examples) for a slice of the quiz session's questions.

| Query Param | Type   | Default | Description              |
| ----------- | ------ | ------- | ------------------------ |
| `offset`    | number | 0       | Index to start from      |
| `limit`     | number | 50      | Number of questions      |

**Response:**
```json
{
  "questions": [
    {
      "wordId": "zh-000001",
      "term": "你好",
      "definitions": [{ "partOfSpeech": "interjection", "text": { "en": "hello", "ja": "こんにちは" } }],
      "transliteration": "nǐ hǎo",
      "examples": [{ "sentence": "你好，你怎么样？", "translation": "Hello, how are you?" }]
    }
  ],
  "total": 150
}
```

#### `POST /api/quiz/answer` — Submit an answer

**Body:**
```json
{
  "sessionId": "chinese",
  "wordId": "zh-000001",
  "correct": true
}
```

If `correct` is `false`, the word is re-appended to the end of the question queue and will appear again. This repeats until the user answers correctly.

**Response:** `{ session, wordProgress }` — updated session state and word progress.

When all questions are answered the session status changes to `"completed"`.

#### `GET /api/quiz/session/language/:language` — Get current session for a language

Returns the in-progress or completed quiz session for the given language, or `404` if none exists.

**Response:** `QuizSession` object.

---

### Flagged Words

Flagged words are marked for review (e.g., words added via smart-add are auto-flagged).

#### `GET /api/flagged/:language` — List flagged words

Returns all flagged words with full word data.

**Response:**
```json
{
  "words": [ /* Word objects */ ],
  "count": 5
}
```

#### `GET /api/flagged/:language/count` — Get flagged word count

**Response:**
```json
{
  "count": 5
}
```

#### `POST /api/flagged/:language/:wordId` — Flag a word

Marks a word for review.

**Response:** `201`

#### `DELETE /api/flagged/:language/:wordId` — Unflag a word

Removes the flagged status from a word.

**Response:** `204 No Content`

---

### Grammar

#### `GET /api/grammar/:language/chapters` — List grammar chapters

**Response:**
```json
[
  {
    "chapterNumber": 1,
    "subchapters": [
      { "subchapterId": "1-1", "subchapterTitle": { "ja": "...", "en": "..." } }
    ]
  }
]
```

#### `GET /api/grammar/:language/subchapters` — List subchapters

| Query Param | Type   | Default | Description                                    |
| ----------- | ------ | ------- | ---------------------------------------------- |
| `chapters`  | string | —       | Comma-separated chapter numbers to filter by   |

**Response:** Array of `{ chapterNumber, subchapterId, subchapterTitle }`.

#### `GET /api/grammar/:language/items` — List grammar items (with filtering and pagination)

| Query Param  | Type   | Default | Description                                    |
| ------------ | ------ | ------- | ---------------------------------------------- |
| `chapter`    | string | —       | Filter by chapter number                       |
| `subchapter` | string | —       | Filter by subchapter ID                        |
| `level`      | string | —       | Filter by level                                |
| `search`     | string | —       | Search term, description, words, or examples   |
| `page`       | number | 1       | Page number (min 1)                            |
| `limit`      | number | 50      | Items per page (max 100)                       |

**Response:** `PaginatedResult<GrammarItemDoc>`

#### `GET /api/grammar/:language/items/:componentId` — Get single grammar item

**Response:** `GrammarItemDoc` object, or `404` if not found.

#### `POST /api/grammar/:language/items` — Add grammar item

**Body:** Grammar item fields (`chapterNumber`, `subchapterId`, `subchapterTitle`, `term` required; `description`, `examples`, `words` optional).

**Response:** `201` with the created `GrammarItemDoc`.

#### `PUT /api/grammar/:language/items/:componentId` — Update grammar item

**Body:** Partial grammar item fields to update.

**Response:** Updated `GrammarItemDoc`.

#### `DELETE /api/grammar/:language/items/:componentId` — Delete grammar item

**Response:** `204 No Content`

---

### Grammar Quiz

One grammar quiz session is stored per language. Supports two modes: `existing` (quiz on existing example sentences) and `llm` (LLM-generated questions). For Chinese, quiz mode is always `llm` — the LLM generates a new Chinese sentence using the grammar term, optional related words, and reference examples as context, then translates it to the user-selected display language. Display language controls which language the prompt sentence is shown in.

#### `POST /api/grammar-quiz/start` — Start a grammar quiz session

**Body:**
```json
{
  "language": "chinese",
  "questionCount": 10,
  "chapters": [1, 2],
  "subchapters": ["1-1", "2-3"],
  "displayLanguage": "ja",
  "quizMode": "existing"
}
```

All fields except `language` are optional. `displayLanguage` defaults to `"ja"` (Japanese). `quizMode` defaults to `"existing"` (ignored for Chinese — always `"llm"`). Supported display languages: `ja` (Japanese), `en` (English), `ko` (Korean).

**Response:** `201` with `GrammarQuizSession`.

#### `POST /api/grammar-quiz/answer` — Submit a self-graded answer

**Body:**
```json
{
  "language": "chinese",
  "componentId": "grammar-001",
  "correct": true
}
```

**Response:** `{ session }` — updated session state.

#### `GET /api/grammar-quiz/session/language/:language` — Get current grammar quiz session

Returns the in-progress or completed grammar quiz session, or `404` if none exists.

**Response:** `GrammarQuizSession` object.

---

### Grammar Progress

#### `GET /api/grammar-progress/:language` — Get grammar progress for all components

**Response:**
```json
{
  "language": "chinese",
  "components": {
    "grammar-001": {
      "timesSeen": 3,
      "timesCorrect": 2,
      "correctRate": 0.67,
      "lastReviewed": "2026-03-08T12:00:00.000Z",
      "streak": 1
    }
  }
}
```

#### `DELETE /api/grammar-progress/:language` — Reset grammar progress for a language

**Response:** `204 No Content`

---

### Translation

#### `POST /api/translation/translate` — Translate and analyze text

Runs parallel LLM calls (one per target language, using the FULL model) and returns structured analysis. Results are saved to Firestore.

**Body:**
```json
{
  "sourceText": "今天天气很好",
  "targetLanguages": ["en", "ja", "ko"]
}
```

`targetLanguages` accepts ISO 639-1 codes: `en`, `ja`, `ko`, `zh`.

**Response:** `TranslationEntry` — each result contains a schema-based sentence analysis with per-component breakdown (surface form, reading, base form, part of speech, meaning, explanation). Reading values (furigana/pinyin) are only populated when the source text contains CJK characters.
```json
{
  "id": "abc123",
  "sourceText": "今天天气很好",
  "targetLanguages": ["en", "ja"],
  "results": [
    {
      "language": "en",
      "analysis": {
        "inputText": "今天天气很好",
        "sentences": [
          {
            "sentenceId": "s1",
            "text": "今天天气很好",
            "components": [
              {
                "componentId": "c1",
                "surface": "今天",
                "baseForm": "今天",
                "reading": "jīntiān",
                "partOfSpeech": "noun",
                "meaning": "today",
                "explanation": "Time noun indicating the current day"
              }
            ]
          }
        ]
      }
    }
  ],
  "createdAt": "2026-03-28T12:00:00.000Z"
}
```

#### `GET /api/translation/history` — Get translation history

| Query Param | Type   | Default | Description        |
| ----------- | ------ | ------- | ------------------ |
| `page`      | number | 1       | Page number        |
| `limit`     | number | 20      | Items per page     |

**Response:** `{ entries: TranslationEntry[], total: number }`

#### `DELETE /api/translation/history` — Clear all translation history

**Response:** `{ ok: true }`

#### `DELETE /api/translation/history/:id` — Delete single translation entry

**Response:** `{ ok: true }`, or `404` if not found.

---

## Frontend

React 19 single-page application for taking vocabulary and grammar quizzes. Built with Vite 6 and styled with Tailwind CSS 4. Supports Japanese, English, and Korean UI (default Japanese) via a custom i18n context (no external library).

### Screens / Views

| View                    | Description                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Dashboard**           | Main layout. Header with "Start Quiz", "Browse Words", and "Home" buttons. The Home button appears when a quiz or word list is active and navigates back to the home page. |
| **QuizTaking**          | Active quiz interface — displays the current term, and after revealing the answer shows all definitions, transliteration, and example sentences with RubyText annotations. Wrong answers are re-queued until correct. Questions are lazy-loaded in batches of 50 with automatic prefetching at the halfway point. Supports resuming from where the user left off. |
| **WordList**            | Paginated word browsing with search, topic/category/level filters, progress badges, and expandable word details with pinyin displayed via RubyText. |
| **SmartAddWordModal**   | Modal to add a word with LLM auto-filling missing fields. Only `term` is required; the LLM generates transliteration, definition, examples, etc. |
| **FlaggedReview**       | Review interface for flagged words. Allows browsing and unflagging words marked for review. |
| **LanguageSelectModal** | Modal to pick the target language when starting a new quiz. Lists languages fetched from the API.                  |
| **LevelSelectModal**    | Modal to select proficiency levels (e.g., HSK1–HSK7~9) for filtering. |
| **QuizFilterModal**     | Modal to select topic, category, and level filters before starting a quiz. Supports "Select All" / "Clear All" actions. Level column only appears when words have levels set. Starting with no filters includes all words. |
| **WordFormModal**       | Modal for adding or editing a word manually with all fields. |
| **GrammarList**         | Browse grammar items organized by chapter and subchapter with search, filters, and inline edit/delete. |
| **GrammarFilterModal**  | Modal to select chapter, subchapter, display language, and quiz mode filters before starting a grammar quiz. Quiz mode selector is hidden for Chinese (always LLM). |
| **GrammarQuizTaking**   | Grammar quiz flashcard UI — displays a sentence (with grammar term shown for Chinese), reveals the answer, and allows self-grading (correct/incorrect). |
| **GrammarFormModal**    | Modal for adding or editing grammar components with chapter, subchapter, topic (required), description (optional), terms (optional, individual input per term), and examples (optional). |
| **TranslationView**    | Translation/analysis UI. Input text, select target languages (EN/JA/KO/ZH), get schema-based sentence decomposition with per-component analysis. Reading column (furigana/pinyin) shown only when source text contains CJK characters. Per-language regenerate buttons during streaming for stuck translations. History persisted to Firestore with previous/next navigation. |
| **Home Page (EmptyState)** | Home screen with four sections: Vocabulary (blue), Translation (violet), Speaking & Writing (teal, placeholder), Grammar (emerald). Checks for in-progress quiz sessions and translation history. |

### API Integration

- **`api/client.ts`** — Generic `fetchJson<T>()`, `postJson<T>()`, `putJson<T>()`, and `deleteRequest()` utilities wrapping the Fetch API.
- **`api/quiz.ts`** — `getCurrentSession(language)`, `startQuiz(opts)`, `getQuizQuestions(language, offset, limit)`, and `answerQuestion(opts)`.
- **`api/vocab.ts`** — `getWords(language, params)`, `getFilters(language)`, `getTransliterationMap(language)`, `updateWord(language, wordId, updates)`, `deleteWord(language, wordId)`, `smartAddWord(language, data)`.
- **`api/grammar.ts`** — `getGrammarChapters(language)`, `getGrammarItems(language, filters, page, limit)`, `getSubchapters(language, chapters)`, `createGrammarItem(language, item)`, `updateGrammarItem(language, componentId, updates)`, `deleteGrammarItem(language, componentId)`, `startGrammarQuiz(opts)`, `answerGrammarQuestion(opts)`, `getCurrentGrammarSession(language)`, `getGrammarProgress(language)`, `resetGrammarProgress(language)`.
- **`api/flagged.ts`** — `getFlaggedWords(language)`, `getFlaggedWordCount(language)`, `flagWord(language, wordId)`, `unflagWord(language, wordId)`.
- **`api/translation.ts`** — `translate(sourceText, targetLanguages)`, `translateStream(sourceText, targetLanguages, callbacks, signal?)`, `getTranslationHistory(page, limit)`, `deleteTranslationHistory()`, `deleteTranslationEntryById(id)`.
- **Dev proxy:** Vite proxies `/api/*` to `http://localhost:3000` so the frontend dev server can reach the backend.

### Internationalization

- Context-based (`i18n/context.tsx`): `I18nProvider` + `useI18n()` hook.
- Translation keys defined in `i18n/translations.ts` for Japanese, English, and Korean. Default UI language is Japanese.
- Type-safe keys via the `TranslationKey` type. Available UI languages exported as `uiLanguages` array (`ja`, `en`, `ko`).

### State Management

React hooks (`useState`, `useEffect`) + Context API. No external state library.

### Styling

Tailwind CSS 4 utility classes only — no custom CSS beyond the Tailwind import.

---

## Data Storage

Production data is stored in **Google Cloud Firestore** (database: `vocab-database`).

| Firestore Collection | Contents                                              |
| -------------------- | ----------------------------------------------------- |
| `languages`          | Language metadata (word count, topics)                 |
| `words`              | Vocabulary words (one document per word)               |
| `id_maps`            | Term → word ID mappings and next ID counter            |
| `progress`           | Per-word progress (times seen, correct rate)            |
| `word_index`         | Fast term → {id, level, transliteration} lookup (composite key: `{language}_{term}`) |
| `quiz_sessions`      | One word quiz session per language (keyed by language name)  |
| `flagged_words`      | Flagged words for review                              |
| `grammar_chapters`   | Grammar chapter metadata (per language)               |
| `grammar_items`      | Flattened grammar components (denormalized chapter/subchapter) |
| `grammar_progress`   | Per-component grammar progress                        |
| `grammar_quiz_sessions` | One grammar quiz session per language              |
| `translation_history`  | Translation/analysis entries with structured LLM results |
| `config`               | App configuration (e.g., `config/llm` stores Azure OpenAI keys) |

Local JSON files under `backend/DB/` serve as the source for the initial Firestore migration (run with `./migrate.sh` or `./deploy.sh ... --migrate`).

## Configuration

| Variable              | Default          | Description                        |
| --------------------- | ---------------- | ---------------------------------- |
| `PORT`                | `3000`           | Server listening port              |
| `HOST`                | `0.0.0.0`       | Server listening address           |
| `FIRESTORE_DATABASE_ID` | `vocab-database` | Firestore database ID            |
| `AZURE_OPENAI_ENDPOINT` | —               | Azure OpenAI endpoint (falls back to Firestore `config/llm`) |
| `AZURE_OPENAI_API_KEY`  | —               | Azure OpenAI API key (falls back to Firestore `config/llm`) |
| `AZURE_OPENAI_DEPLOYMENT_MINI` | —        | Azure OpenAI MINI deployment name for fast tasks (falls back to Firestore `config/llm`) |
| `AZURE_OPENAI_DEPLOYMENT_FULL` | —        | Azure OpenAI FULL deployment name for translation/analysis (falls back to Firestore `config/llm`) |
| `AZURE_OPENAI_API_VERSION` | —            | Azure OpenAI API version (falls back to Firestore `config/llm`) |
| `FIRESTORE_PROJECT`    | —                | Google Cloud project ID (required for Firestore in deployed environments) |

## Docker

Both Dockerfiles use **Node 24 Alpine** with multi-stage builds to keep images small.

| Service    | Port | Description                                          |
| ---------- | ---- | ---------------------------------------------------- |
| `backend`  | 3000 | Multi-stage build → `node dist/index.js` (production deps only) |
| `frontend` | 5173 | Multi-stage build → Nginx Alpine serves static assets, proxies `/api/` to backend |

See [Quickstart](#quickstart) for usage.
