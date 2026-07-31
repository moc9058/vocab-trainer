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
| **Windows** | Run the deploy script via **PowerShell** (`& "C:\Program Files\Git\bin\bash.exe" -c "./deploy.sh"`), **WSL**, or **Git Bash**. Docker Desktop must be running. |

### Deploy

https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app

```bash
./deploy.sh vocab-trainer-490014 asia-northeast1
```

REGION is optional and defaults to `asia-northeast1`:

```bash
./deploy.sh vocab-trainer-490014                                     # uses asia-northeast1
```

The deploy script takes **three optional flags, and they all do the same kind of
thing**: push local config into Firestore just before the new revision rolls.

```bash
./deploy.sh vocab-trainer-490014 asia-northeast1 --llm       # OpenAI key + model names from .env  -> config/llm
./deploy.sh vocab-trainer-490014 asia-northeast1 --auth      # Google OAuth client from .env       -> config/auth
./deploy.sh vocab-trainer-490014 asia-northeast1 --prompts   # prompts + schemas from backend/DB/  -> config/{speaking_writing,translation,vocabulary,grammar,import}
./deploy.sh vocab-trainer-490014 asia-northeast1 --llm --auth --prompts   # combined
```

Windows: `.\deploy.ps1 vocab-trainer-490014 asia-northeast1 -Llm -Auth -Prompts`
(same three, as switches).

**Why these belong in the deploy script and nothing else does.** Every config
document is read once and then memoized for the life of the process
(`routes/import.ts`), or read straight at boot (`auth-config.ts`). Editing a prompt
therefore has no effect on a running instance until one is replaced — so uploading
the config and rolling a new revision are a single operation. Data migrations have
no such relationship to a release.

An unrecognised flag is now rejected instead of being taken as the project ID: with
the old parser, `./deploy.sh --promts` silently tried to deploy to a project called
`--promts`.

### Data migrations and maintenance (run directly, not via deploy)

These are one-off or destructive, so they are deliberately kept out of the release
path — a wipe behind a deploy flag is a wipe someone eventually runs by reflex.

```bash
cd backend && npx tsx scripts/migrate-example-sentences.ts [--dry-run]           # one-off: embedded examples -> example_sentences
cd backend && npx tsx scripts/migrate-grammar-examples.ts [--dry-run]            # one-off: inline Grammar.examples -> example_sentences
cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --archives       # backup/ + original/ -> archive_* collections
cd backend && npx tsx scripts/wipe-grammar-firestore.ts                          # DESTRUCTIVE
```

`scripts/migrate-to-firestore.ts` (the original word import, also reachable through
`./migrate.sh`) reads `backend/DB/word/`, which is **empty** — Firestore is the
source of truth for words and grammar, and nothing is uploaded from the local
repository any more.

The `archive_backups` / `archive_originals` collections are written by `--archives`
but are **not read by any code** in `backend/src` or `frontend/src`; they are a
cold archive of the pre-migration HSK data (~79 MB).

### Upload LLM Config Locally

```bash
cd backend && FIRESTORE_PROJECT=vocab-trainer-490014 npx tsx scripts/migrate-llm-config-to-firestore.ts
```

Reads OpenAI API and model settings from `.env` and writes them to Firestore `config/llm`. The backend will automatically fetch LLM config from Firestore when `.env` is not available (e.g., in deployed environments).

Note this uploads only the API key and the two **tier defaults**. Per-feature model
assignment lives in a separate document, `config/llm_models`, which is edited from the
in-app **LLM Models** screen (language-select page → System) and takes effect within
30 seconds without a redeploy. Keeping them apart is deliberate: this script does a full
`.set()` on `config/llm`, which would otherwise wipe the assignments on every `--llm` deploy.

### Upload Speaking/Writing + Translation Config

```bash
cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --prompts
```

Reads system prompts, output schemas, and use-case instructions from `backend/DB/speaking&writing/`, `backend/DB/translation/`, and `backend/DB/vocabulary/`, and writes them to Firestore `config/speaking_writing`, `config/translation`, and `config/vocabulary`. Required before the backend can start — these configs are loaded from Firestore at startup.

### Upload Backup + Original Archives

```bash
cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --archives
```

Uploads `backend/DB/backup/` and `backend/DB/original/` archive data to Firestore collections `archive_backups` and `archive_originals`. Large files (>1MB) are automatically chunked into 500-item subcollection documents.

### Backfill Missing Segments and Translations

```bash
cd backend && npx tsx scripts/backfill-missing-segments.ts [--language=<lang>] [--dry-run] [--chunk=<n>]
```

Generates pinyin segments and multi-language translations for example sentences that are missing them. Default chunk size is 50 (segments) / 20 (translations). Use `--dry-run` to preview without writing.

```bash
cd backend && npx tsx scripts/backfill-empty-example-translations.ts [--language=<lang>] [--dry-run] [--limit=<n>]
```

LLM-generates translations for `example_sentences` docs whose `translation` is empty or missing one or more target definition languages (e.g. a hand-typed single-language string). Use `--dry-run` to list candidates without calling the LLM or writing.

`deploy.sh` / `deploy.ps1` will:
1. Build and push backend image to `asia-northeast1-docker.pkg.dev/vocab-trainer-490014/vocab-test-backend/backend`
2. Upload config to Firestore — only with `--llm`, `--auth` and/or `--prompts`, and
   **before** the next step, so the new instance already sees it at boot
3. Deploy backend to Cloud Run
4. Build and push frontend image to `asia-northeast1-docker.pkg.dev/vocab-trainer-490014/vocab-test-frontend/frontend`
5. Deploy frontend to Cloud Run with `BACKEND_URL` pointing to the backend service

The script prints both service URLs on completion.

## Quickstart

### Prerequisites

- **Docker** and **Docker Compose**

1. **Build and start both services**
   ```bash
   docker compose up --build
   ```

2. **Open the app** at http://localhost:5173. A language selection page appears — click **Chinese** or **English** to enter the corresponding language dashboard. You can also navigate directly to a language via URL (e.g. http://localhost:5173/chinese). The backend API is available at http://localhost:3000.

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
          "translation": {
            "en": "Hello, how are you?",
            "ja": "こんにちは、お元気ですか？",
            "ko": "안녕, 어떻게 지내?",
            "zh": "你好，你怎么样？"
          },
          "segments": [
            { "text": "你好", "transliteration": "nǐ hǎo", "id": "zh-000001" },
            { "text": "，" },
            { "text": "你", "transliteration": "nǐ" },
            { "text": "怎么样", "transliteration": "zěn me yàng" },
            { "text": "？" }
          ]
        }
      ],
      "topics": ["Greetings & Introductions"],
      "level": "HSK1-4",
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
- **`examples`** — Array of example sentences with translations.
  - **`sentence`** — The example sentence in the target language.
  - **`translation`** — Either a plain string (legacy single-language) or a `Record<string, string>` keyed by ISO 639-1 code for multi-language translations (e.g., `{ "en": "Hello", "ja": "こんにちは" }`). Smart-add always writes the multi-language form covering all four supported codes.
  - **`segments`** — Optional, Chinese-specific. An array of word-level tokens with `{ text, transliteration?, id? }` where `transliteration` holds tone-marked pinyin and `id` links the segment to an existing vocab word in `word_index` when one exists. For linked segments (where `id` is set), `transliteration` is sourced from the linked word's canonical pinyin when the word is monophonic (all definitions share one pronunciation); polyphonic words (e.g. 得: de/děi/dé) keep the LLM-generated contextual pinyin so the reading matches the sentence. Punctuation tokens are emitted as bare `{ text }` with no transliteration. Generated by smart-add and preserved across `PUT /api/vocab/:language/:wordId` updates whenever the sentence text is unchanged.
- **`topics`** — Topic tags for categorizing and filtering words. Possible values:
  - **Everyday Life:** `Greetings & Introductions`, `Food & Dining`, `Shopping & Money`, `Travel & Transportation`, `Weather & Seasons`, `Family & Relationships`, `Health & Body`, `Home & Housing`
  - **Academic / Professional:** `Economics & Finance`, `Politics & Government`, `Science & Technology`, `Law & Justice`, `Medicine`, `Education`, `Business & Commerce`, `Work & Career`
  - **Culture & Society:** `Nature & Environment`, `Arts & Entertainment`, `Sports & Fitness`, `Religion & Philosophy`, `History`, `Media & News`
  - **Language Fundamentals:** `Language Fundamentals`
- **`level`** — Optional. Proficiency level tag for the word. Chinese uses five **merged HSK buckets** rather than the granular HSK 1–9 syllabus:
  - `"HSK1-4"` — words at HSK1, HSK2, HSK3, or HSK4 (and any `*-extended` variants)
  - `"HSK5"` — words at HSK5 (and `HSK5-extended`)
  - `"HSK6"` — words at HSK6 (and `HSK6-extended`)
  - `"HSK7-9"` — words at HSK7, HSK8, or HSK9 (and `HSK7-9-extended`)
  - `"Advanced"` — words beyond the HSK syllabus

  The smart-add LLM is instructed to emit only these five labels, and any granular `HSK1`/`HSK2`/.../`HSK9` value that slips through is normalized at write time by `CHINESE_LEVEL_NORMALIZE` in `backend/src/routes/vocab.ts`. Run `npx tsx scripts/unify-chinese-levels.ts` to backfill any pre-existing granular labels in `words` and `word_index`. Other languages (e.g. Japanese JLPT) use their own level strings.
- **`notes`** — Optional. Free-form field for irregularities, mnemonics, etc.
- **`hanjaReadings`** — Optional. Chinese-specific. Array of per-character Korean hanja data, generated by `backfill-hanja-readings.ts`. Each entry: `{ simplifiedChar: string, traditionalChar: string, hunEum: string[] }` where `simplifiedChar` is the original simplified Chinese character, `traditionalChar` is the traditional (번체) Korean hanja form, and `hunEum` lists all valid Korean 훈음 readings (e.g. `["사랑 애"]` or `["다닐 행", "항렬 항", "줄 행"]` for multi-reading characters). Characters with no established Korean hanja reading are omitted. An empty array `[]` means the word was processed but no characters have Korean hanja equivalents.

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
│   │   ├── migrate-to-firestore.ts        # Historical: JSON → Firestore word migration; DB/word/ is now empty
│   │   ├── migrate-llm-config-to-firestore.ts # Upload LLM config (.env) → Firestore
│   │   ├── migrate-db-config-to-firestore.ts  # Upload speaking/writing, translation config & archives → Firestore
│   │   ├── unify-chinese-levels.ts        # One-off: rewrite granular HSK1/2/.../9 labels to merged buckets
│   │   ├── migrate-example-sentences.ts   # One-off: extract embedded examples into example_sentences collection
│   │   ├── backfill-segment-word-ids.ts   # One-off: assign segment.id from word_index; update appearsInIds
│   │   ├── backfill-word-appears-in.ts    # One-off: recompute appearsInIds (exampleIds ∪ segment refs)
│   │   ├── cleanup-dangling-example-refs.ts # One-off: remove stale exampleIds/appearsInIds entries
│   │   ├── smoke-test-invariant.ts        # Smoke test for word↔example invariant helpers (concurrency included)
│   │   ├── validate-invariant-all.ts      # Read-only deep validator: invariant + dangling refs + orphans
│   │   ├── backfill-hanja-readings.ts     # One-off: generate Korean hanja (simplifiedChar/traditionalChar/hunEum) via LLM MINI
│   │   ├── backfill-empty-example-translations.ts # One-off: LLM-fill example sentences with empty/partial translations
│   │   └── export-from-firestore.ts       # Export words, grammar & progress from Firestore to JSON
│   ├── src/
│   │   ├── index.ts             # Fastify server entry point
│   │   ├── types.ts             # Shared TypeScript interfaces
│   │   ├── firestore.ts         # Google Cloud Firestore persistence layer
│   │   ├── llm.ts               # OpenAI LLM integration
│   │   ├── exampleTranslations.ts # Shared missing-translation LLM fallback (vocab/grammar routes + backfill script)
│   │   ├── quiz-utils.ts        # Shared quiz ordering helpers (shuffle, weightedInterleave, weightedMerge, insertRetryQuestion)
│   │   └── routes/
│   │       ├── languages.ts     # /api/languages
│   │       ├── vocab.ts         # /api/vocab
│   │       ├── progress.ts      # /api/progress
│   │       ├── quiz.ts          # /api/quiz
│   │       ├── flagged.ts       # /api/flagged
│   │       ├── grammar.ts       # /api/grammar
│   │       ├── grammar-quiz.ts  # /api/grammar-quiz
│   │       ├── grammar-progress.ts # /api/grammar-progress
│   │       ├── combined-quiz.ts # /api/combined-quiz
│   │       ├── translation.ts  # /api/translation
│   │       └── speaking-writing.ts # /api/speaking-writing
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
│       │   ├── grammar.ts       # Grammar, grammar settings & grammar quiz API wrappers
│       │   ├── combined-quiz.ts # Combined word+grammar quiz API wrappers
│       │   ├── flagged.ts       # Flagged words API wrappers
│       │   ├── translation.ts   # Translation API wrappers
│       │   └── speaking-writing.ts # Speaking & writing correction API wrappers
│       ├── hooks/
│       │   └── useWordQueue.ts  # Sequential word-addition queue (enqueue, pendingTerms, queueLength, processingTerm, refreshSignal)
│       ├── components/
│       │   ├── Dashboard.tsx     # Main layout with quiz/browse orchestration + queue status pill & toasts
│       │   ├── SettingsModal.tsx  # Settings: language order, UI langs, definition/example langs
│       │   ├── QuizTaking.tsx    # Active quiz interface
│       │   ├── WordList.tsx      # Paginated word browsing with filters (refreshSignal + onQueue props)
│       │   ├── RubyText.tsx      # Ruby text component for pinyin annotations
│       │   ├── LanguageSelectModal.tsx
│       │   ├── LevelSelectModal.tsx
│       │   ├── QuizFilterModal.tsx
│       │   ├── WordFormModal.tsx
│       │   ├── SmartAddWordModal.tsx  # Smart add word with LLM; queue mode via onQueue prop
│       │   ├── FlaggedReview.tsx      # Review flagged words
│       │   ├── GrammarList.tsx        # Browse grammar items with groups & search
│       │   ├── GrammarFilterModal.tsx # Grammar quiz filters
│       │   ├── GrammarQuizTaking.tsx  # Grammar quiz flashcard UI
│       │   ├── GrammarFormModal.tsx   # Add/edit grammar item
│       │   ├── StudyQuizModal.tsx     # Unified quiz setup (word / grammar / combined tabs)
│       │   ├── CombinedQuizFilterModal.tsx # Combined quiz setup (domain + group weights)
│       │   ├── CombinedQuizTaking.tsx # Combined quiz UI (renders per-question by kind)
│       │   ├── TranslationView.tsx  # Translation/analysis UI with history
│       │   ├── SpeakingWritingView.tsx # Speaking & writing correction UI
│       │   └── EmptyState.tsx
│       ├── settings/            # App settings (language order, defaults)
│       │   ├── types.ts         # AppSettings interface
│       │   ├── defaults.ts      # ALL_KNOWN_LANGUAGES, LANG_LABEL_MAP, DEFAULT_SETTINGS
│       │   └── context.tsx      # SettingsProvider + useSettings() hook (localStorage)
│       └── i18n/                # Internationalization (ja, en, ko)
```

## Tech Stack

| Layer    | Technology                                            |
| -------- | ----------------------------------------------------- |
| Backend  | Fastify 5, TypeScript, Google Cloud Firestore, @fastify/cors, @fastify/sensible |
| Frontend | React 19, Vite 6, Tailwind CSS 4, @dnd-kit (drag-and-drop) |
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
| `flaggedOnly` | string | —     | When `"true"`, return only flagged words (same as `GET /api/flagged/:language` but paginated) |

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
  "levels": ["HSK1-4", "HSK5"]
}
```

#### `GET /api/vocab/:language/:wordId` — Get single word by ID

**Response:** `Word` object (see [Vocabulary Database Format](#vocabulary-database-format)), or `404` if not found. The returned `examples` array is hydrated from `example_sentences` and includes both examples the word owns (`exampleIds`) and examples it appears in as a segment (`appearsInIds`).

#### `PUT /api/vocab/:language/:wordId` — Update word

**Body:** Partial word fields to update.

**Response:** Updated `Word`.

For Chinese examples, `examples[].segments` are preserved from the previously stored version of the word whenever the example sentence text is unchanged. Clients (such as `WordFormModal`, which doesn't carry segments through its form state) therefore do not need to round-trip segments — only sentences whose text actually changed will lose their pinyin segments and need to be re-segmented separately. When the request explicitly includes segments (e.g. from the segment editor), any segment missing an `id` is automatically looked up in `word_index` and linked to the matching word if one exists.

Example sentences (brand-new or existing/dedup-matched) that have no stored translation and receive no user-provided translation trigger an LLM call (MINI model) to generate multi-language translations before the word document is updated. Existing example sentences that are dedup-matched also have their translations upgraded: if the incoming multi-language translation contains language keys absent from the stored translation, the two objects are merged (existing non-empty values take priority).

#### `DELETE /api/vocab/:language/:wordId` — Delete word

**Response:** `204 No Content`

#### `POST /api/vocab/:language/:wordId/unlink-segment` — Unlink a word from an example sentence

Transactionally removes the bidirectional link between a word and one example sentence. Clears the `segment.id` for the word in that sentence and removes the sentence from the word's `appearsInIds`. If the word no longer owns any examples (empty `exampleIds`) it is deleted entirely.

**Body:**
```json
{ "sentence": "今天天气很好。" }
```

**Response:** `200` with `{ deleted: boolean }` — `true` if the word was removed, `false` if only the segment link was cleared.

#### `POST /api/vocab/:language/sync-segment-links` — Sync segment word-ID links

For each example sentence ID in the request body, looks up all segment texts in `word_index`, writes any missing `seg.id` fields, sets `seg.transliteration` to the word's canonical pinyin for monophonic newly-linked segments (polyphonic words like 得 are skipped so the LLM-generated contextual pinyin is preserved), and updates `appearsInIds` back-references. Called automatically by `WordList` when expanding a word reveals segments that exist in the DB but have no `id` set.

**Body:**
```json
{ "exampleIds": ["ex_001", "ex_002"] }
```

**Response:** `200` with `{ ok: true }`

#### `GET /api/vocab/:language/groups` — List word groups

Returns all word groups for the language, sorted by creation time.

#### `POST /api/vocab/:language/groups` — Create word group

**Body:** `{ "name": "My Group" }`  
**Response:** `201` with the new `WordGroup`.

#### `PUT /api/vocab/:language/groups/:groupId` — Rename word group

**Body:** `{ "name": "New Name" }`  
**Response:** updated `WordGroup`.

#### `DELETE /api/vocab/:language/groups/:groupId` — Delete word group

**Response:** `204 No Content`

#### `POST /api/vocab/:language/groups/:groupId/words` — Add or remove group members

**Body:** `{ "wordIds": ["1", "2"], "action": "add" | "remove" }`  
**Response:** updated `WordGroup`.

Adding to a **category-A** group is a **move**: a word belongs to at most one Group A
group (they are the lesson structure, not overlapping tags), so the server strips the
words from every other category-A group of the language. Category B is untouched — a
Group B set is the not-yet-memorized subset drawn on top of A, and several may hold the
same word. Grammar groups have no such rule.

#### `POST /api/vocab/:language/file` — Create new language file

**Response:** `201` with the new `VocabFile` (empty `words` array).

#### `DELETE /api/vocab/:language/file` — Delete language file

**Response:** `204 No Content`

#### `GET /api/vocab/:language/lookup?term=X` — Look up word by term

Looks up a word by its term using the word_index for fast retrieval.

**Response:** `Word` object, or `404` if not found.

#### `POST /api/vocab/:language/smart-add` — Smart add word with LLM

Adds a word using the LLM to fill in missing fields. The word is auto-flagged for review. For Chinese, the LLM also generates word-level pinyin segments for each example sentence (linked to existing vocab entries via `segments[].id` when the segment text matches a known word).

**Body:**
```json
{
  "term": "努力",
  "transliteration": "",
  "definitions": [
    { "partOfSpeech": "verb", "text": { "en": "to work hard" } }
  ],
  "topics": [],
  "examples": [],
  "level": "",
  "notes": ""
}
```

Only `term` is required. All other fields are optional and will be filled or supplemented by the LLM if omitted or empty. Any `definitions[].text` entries the user provides are treated as **anchor senses** — kept verbatim and used to disambiguate which lexical entry the user means — but the LLM **always** generates definitions and example translations in all four supported ISO 639-1 codes (`en`, `ja`, `ko`, `zh`), regardless of which subset the client requests. Client-side display filtering happens via the `displayDefinitionLanguages` / `displayExampleTranslationLanguages` settings. For Chinese the response `level` is constrained to one of `HSK1-4`, `HSK5`, `HSK6`, `HSK7-9`, `Advanced`.

**Response:** `201` with the created `Word`.

#### `POST /api/vocab/:language/check-terms` — Check which terms exist

Looks up multiple terms at once against `word_index`. Used by the grammar quiz / pinyin segment flows to discover which segment texts already correspond to vocabulary entries before offering to add the missing ones.

**Body:**
```json
{ "terms": ["你好", "怎么样", "今天"] }
```

**Response:**
```json
{ "existing": { "你好": "zh-000001" } }
```

(Missing terms simply do not appear in the `existing` map.)

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
  "levels": ["HSK1-4"],
  "groupIds": ["chinese_1234abcd"],
  "questionType": "definition"
}
```

All fields except `language` are optional (`questionCount` defaults to all matching words).

Words are selected uniformly at random without replacement. Every remaining
word has an equal chance of appearing next.

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

If `correct` is `false`, the word is re-queued and all remaining questions,
including retries, are uniformly shuffled. This repeats until the user answers
correctly.

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

#### `GET /api/grammar/settings` — Get grammar-wide settings

**Response:** `GrammarSettings` — `{ defaultDefinitionLanguage: string }` (defaults to `{ "defaultDefinitionLanguage": "en" }` when unset). Stored in Firestore doc `config/grammar_settings`; used to seed the description language of new grammar items.

#### `PUT /api/grammar/settings` — Update grammar-wide settings

**Body:** `{ "defaultDefinitionLanguage": "ko" }`

**Response:** The saved `GrammarSettings`.

#### `GET /api/grammar/:language/items` — List grammar items (with filtering and pagination)

| Query Param  | Type   | Default | Description                                    |
| ------------ | ------ | ------- | ---------------------------------------------- |
| `level`      | string | —       | Filter by level                                |
| `search`     | string | —       | Search statement, descriptions, or words       |
| `groupId`    | string | —       | Filter by grammar group membership             |
| `page`       | number | 1       | Page number (min 1)                            |
| `limit`      | number | 50      | Items per page (max 100)                       |

**Response:** `PaginatedResult<Grammar>` — examples are hydrated from the shared `example_sentences` collection via `exampleIds`; translations may be a plain string or a multi-language `Record<string, string>`.

#### `GET /api/grammar/:language/items/:grammarId` — Get single grammar item

**Response:** `Grammar` object, or `404` if not found.

#### `POST /api/grammar/:language/items` — Add grammar item

**Body:** `id`, `statement`, `descriptions` required; `examples`, `words`, `level`, `tags` optional. Incoming `examples` are resolved to `example_sentences` docs (deduplicated with vocab examples by sentence hash).

**Response:** `201` with the created `Grammar` (including `exampleIds`).

#### `POST /api/grammar/:language/smart-add` — Add grammar item with LLM enrichment

Same body as `POST /items`; the LLM fills `descriptions[].text` for all four definition languages (`en`/`ja`/`ko`/`zh`), keeping user-provided texts.

**Response:** `201` with the created `Grammar`.

#### `PUT /api/grammar/:language/items/:grammarId` — Update grammar item

**Body:** Partial grammar item fields to update. If `examples` is sent, they are re-resolved to `example_sentences` docs; dropped examples are orphan-deleted only when no other word or grammar item references them.

**Response:** Updated `Grammar`.

#### `DELETE /api/grammar/:language/items/:grammarId` — Delete grammar item

**Response:** `{ deleted: true }`, or `404` if not found.

#### Grammar groups

- `GET /api/grammar/:language/groups` — list groups
- `POST /api/grammar/:language/groups` — create group (`{ name }`)
- `PUT /api/grammar/:language/groups/:groupId` — rename group (`{ name }`)
- `DELETE /api/grammar/:language/groups/:groupId` — delete group
- `POST /api/grammar/:language/groups/:groupId/grammar` — add/remove members (`{ grammarIds, action: "add" | "remove" }`)

---

### Grammar Quiz

One grammar quiz session is stored per language. Each question shows an example-sentence translation; the user recalls the grammar pattern and self-grades. Questions prefer the item's own `example_sentences` docs (via `exampleIds`), falling back to inline examples for unmigrated items, and to LLM generation only when neither exists.

#### `POST /api/grammar-quiz/start` — Start a grammar quiz session

**Body:**
```json
{
  "language": "chinese",
  "questionCount": 10,
  "groupIds": ["group-abc"]
}
```

All fields except `language` are optional (`questionCount` defaults to all matching grammar items). `groupIds` scopes the question pool to the given grammar groups.

Every item of the selected groups is asked — `groupWeights` (and `correctWeight`) only decide the ORDER of the questions, never which items make the cut. A group weighted `0` is the one exception: it is excluded entirely.

**Response:** `201` with `GrammarQuizSession`. Question `exampleTranslation` may be a plain string or a multi-language `Record<string, string>`.

#### `POST /api/grammar-quiz/answer` — Submit a self-graded answer

**Body:**
```json
{
  "language": "chinese",
  "grammarId": "grammar-001",
  "correct": true
}
```

**Response:** `{ session }` — updated session state.

#### `GET /api/grammar-quiz/session/language/:language` — Get current grammar quiz session

Returns the in-progress or completed grammar quiz session, or `404` if none exists.

**Response:** `GrammarQuizSession` object.

---

### Combined Quiz

Merged word + grammar quiz; one session per language, stored in `combined_quiz_sessions`. Each domain is ordered internally by its group weights, then the two streams are merged by `domainWeights` (proportional draw; a weight of 0 excludes that domain).

#### `POST /api/combined-quiz/start` — Start a combined quiz session

**Body:**
```json
{
  "language": "chinese",
  "domainWeights": { "word": 3, "grammar": 1 },
  "word": { "groupIds": ["g1"], "groupWeights": { "g1": 2 }, "flaggedOnly": false },
  "grammar": { "groupIds": ["gg1"], "groupWeights": { "gg1": 1 } }
}
```

All fields except `language` are optional. The `word` filter additionally accepts `topics`, `categories`, and `levels` (same semantics as `POST /api/quiz/start`).

**Response:** `201` with `CombinedQuizSession`. Questions are a `kind`-discriminated union: word questions are lightweight `{ kind: "word", wordId, term }` (hydrate via `GET /questions/:language`); grammar questions are stored inline.

#### `GET /api/combined-quiz/questions/:language` — Fetch hydrated questions in batches

Same paged hydration as the word quiz (`offset`/`limit` query params); grammar questions pass through unchanged.

#### `POST /api/combined-quiz/answer` — Submit an answer

**Body:** `{ "language": "...", "kind": "word" | "grammar", "refId": "<wordId | grammarId>", "correct": true, "flagWordIds": [] }` — dispatches to word vs grammar progress; wrong answers re-queue the question into the session tail.

**Response:** `{ session }` — updated session state.

#### `GET /api/combined-quiz/session/language/:language` — Get current combined quiz session

Returns the in-progress or completed session (unanswered tail reweighted per-domain and re-merged), or `404` if none exists.

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

Runs the two-step pipeline: a structural decomposition (MINI model, source-language-specific prompt) followed by parallel translation per target language (FULL model). Results are saved to Firestore.

**Body:**
```json
{
  "sourceLanguage": "zh",
  "sourceText": "今天天气很好",
  "targetLanguages": ["en", "ja", "ko"],
  "context": "casual chat between close friends"
}
```

`sourceLanguage` and entries in `targetLanguages` accept ISO 639-1 codes: `en`, `ja`, `ko`, `zh`. `context` (optional, max 2000 chars) describes the situation/register of the text — it biases word-sense, tone, politeness/honorific level, and pronoun choices in the translation step, and is saved on the resulting `TranslationEntry.context`.

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

#### `POST /api/translation/translate-stream` — SSE streaming translate

Same body as `/translate`, plus an optional `decomposition` field: the decomposition JSON string from a previous `decompose-result` event. When it is present and valid for the same text, step 1 is skipped entirely — no `decompose-start`/`decompose-chunk` events are emitted and `decompose-result` echoes the provided value immediately (used by the frontend to make regeneration fast). Returns an SSE stream so the frontend can render the decomposition and per-language translations as they arrive. Events:

- `decompose-start` — `{}`
- `decompose-chunk` — `{ chunk: string }` — raw JSON token from the decomposition LLM call
- `decompose-result` — `{ decomposition: string }` — full parsed decomposition payload
- `start` — `{ language: string }` — emitted once per target language before its translate call begins
- `chunk` — `{ language: string, chunk: string }` — raw JSON token from a per-language translate call
- `result` — `{ language: string, result: TranslationResult }` — final merged result for one language (also emitted on per-language failure with `result.error`)
- `done` — `TranslationEntry` — full saved entry (id may be a `pending-*` placeholder; the entry is persisted in the background)
- `error` — `{ message: string }` — fatal pipeline error

The stream sends `:keep-alive` comments every 15 seconds to defeat proxy idle timeouts.

#### `GET /api/translation/history` — Get translation history

| Query Param | Type   | Default | Description                          |
| ----------- | ------ | ------- | ------------------------------------ |
| `page`      | number | 1       | Page number                          |
| `limit`     | number | 20      | Items per page                       |
| `language`  | string | —       | Filter by target language (optional) |

**Response:** `{ entries: TranslationEntry[], total: number }`

#### `DELETE /api/translation/history` — Clear translation history (optional `?language=` filter)

**Response:** `{ ok: true }`

#### `DELETE /api/translation/history/:id` — Delete single translation entry

**Response:** `{ ok: true }`, or `404` if not found.

---

### Speaking & Writing

LLM-powered text correction for speaking and writing practice. One session per language, with a history of corrections within each session. Uses language-specific system prompts and use-case instructions from Firestore `config/speaking_writing` (migrated from `backend/DB/speaking&writing/`) and the FULL OpenAI model.

#### `POST /api/speaking-writing/correct` — Submit text for correction

**Body:**
```json
{
  "language": "en",
  "mode": "speaking",
  "useCase": "professional",
  "inputText": "I goed to the store yesterday and buyed some foods."
}
```

`language` accepts ISO 639-1 codes: `en`, `ja`, `ko`, `zh`. `mode` is `"speaking"` or `"writing"`. `useCase` depends on mode:
- Speaking: `professional`, `casual`, `presentation`, `interview`
- Writing: `academic`, `social`, `email`, `creative`

The system prompt is assembled from a base prompt (per language) + a use-case context block (per mode/useCase/language) appended at the end.

**Response:** `SpeakingWritingSession` — the session with the new correction appended. Corrections are structured per-sentence:
```json
{
  "sessionId": "en",
  "language": "en",
  "mode": "speaking",
  "useCase": "professional",
  "startedAt": "2026-03-29T12:00:00.000Z",
  "status": "in-progress",
  "corrections": [
    {
      "inputText": "I goed to the store yesterday and buyed some foods.",
      "result": {
        "sentences": [
          {
            "original": "I goed to the store yesterday and buyed some foods.",
            "corrected": "I went to the store yesterday and bought some food.",
            "corrections": [
              {
                "original": "goed",
                "corrected": "went",
                "explanation": "\"Go\" is an irregular verb. The past tense is \"went\", not \"goed\".",
                "severity": "error"
              }
            ]
          }
        ],
        "overallFeedback": "Good sentence structure. Focus on irregular verb forms."
      },
      "createdAt": "2026-03-29T12:00:00.000Z"
    }
  ],
  "currentIndex": 0
}
```

#### `POST /api/speaking-writing/correct-stream` — SSE streaming correction

Same body as `/correct`. Returns an SSE stream with events:
- `start` — `{}` — emitted once before streaming begins
- `chunk` — `{ chunk: string }` — raw JSON token from LLM
- `done` — `SpeakingWritingSession` — final session with parsed result appended
- `error` — `{ message: string }` — emitted on pipeline failure

#### `GET /api/speaking-writing/session/:language` — Get current session

Returns the speaking/writing session for the given language, or `null` (200) if none exists.

**Response:** `SpeakingWritingSession` object or `null`.

#### `DELETE /api/speaking-writing/session/:language` — Delete session

**Response:** `{ ok: true }`, or `404` if not found.

---

## Frontend

React 19 single-page application for taking vocabulary and grammar quizzes. Built with Vite 6 and styled with Tailwind CSS 4. Supports Japanese, English, and Korean UI (default English) via a custom i18n context (no external library). App-wide settings — language display order, active UI languages, displayed definition/example translation languages, smart-add defaults (`defaultAddWordLanguage`, `defaultDefinitionLanguage`), speaking/writing defaults (`defaultCorrectionMode`, `defaultSpeakingUseCase`, `defaultWritingUseCase`), translation defaults (`defaultTranslationSourceLanguage`, `defaultTranslationTargetLanguages`), and `showKoreanHanja` (Chinese-only toggle for the 🀄 Korean hanja section) — are managed via a SettingsContext persisted to localStorage.

### Screens / Views

| View                    | Description                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Dashboard**           | Main layout at `/:language/*`. Each view has its own URL sub-path (`/browse`, `/quiz`, `/flagged`, `/grammar`, `/grammar-quiz`, `/translation`, `/speaking-writing`) so page refresh stays on the current view. Header shows "Back" button on sub-paths (returns to `/:language`) and "← Languages" on the language home. Quiz and grammar-quiz sub-paths auto-recover the active session on mount and redirect home if none exists. Includes settings gear, dynamic UI language toggle. |
| **SettingsModal**       | Settings modal with sections for (1) drag-and-drop language display order reordering via @dnd-kit, (2) active UI language checkboxes, (3) displayed definition / example translation language checkboxes (display-only — generation always covers all four), (4) smart-add defaults (`defaultAddWordLanguage`, `defaultDefinitionLanguage`), (5) speaking/writing defaults (`defaultCorrectionMode`, `defaultSpeakingUseCase`, `defaultWritingUseCase`), (6) translation defaults (`defaultTranslationSourceLanguage`, `defaultTranslationTargetLanguages`), and (7) a `showKoreanHanja` checkbox — visible only when the active language is Chinese — that toggles the 🀄 Korean hanja section in word cards, quiz answers, and flagged-review answers. Persisted to localStorage. |
| **QuizTaking**          | Active quiz interface — displays the current term, and after revealing the answer shows all definitions, transliteration, and example sentences with RubyText annotations. When `showKoreanHanja` is enabled and the word has `hanjaReadings`, a 🀄 Korean Hanja section is shown above the definitions. Wrong answers are re-queued until correct. Questions are lazy-loaded in batches of 50 with automatic prefetching at the halfway point. Supports resuming from where the user left off. |
| **WordList**            | Paginated word browsing with search, topic/category/level/group filters, progress badges, and expandable word details with pinyin displayed via RubyText. Accepts `refreshSignal` (silently re-fetches on change — also re-runs `refreshExistingTerms` on the expanded word so queued segment chips flip to ✓), `onQueue` (enables queue mode in its embedded SmartAddWordModal; segment chip "+" clicks also route through this queue, serializing them instead of firing concurrent HTTP requests), and `pendingTerms` (Set from `useWordQueue`; chips whose term is in-flight show amber "⋯" and are disabled). Expanded details show the first 3 definitions and first 3 examples by default; a "show more / show less" toggle appears when there are additional entries. Segment buttons show amber "⋯" while the activation check is in-flight or the term is queued, green "✓" when already in the DB, and blue "+" when addable; the flag checkbox below each addable segment is hidden while the activation check is running or the term is queued; on expand, any segments found in `word_index` without a `seg.id` are patched locally and persisted via `sync-segment-links`. When clicking a segment "+" button fails (e.g. LLM error), a red error toast appears bottom-right for 3 seconds with the actual backend error message. When `onJumpToWord` fires from an embedded `SmartAddWordModal`, the list filters/expands to the target word and opens it in `WordFormModal` edit mode (passing `onQueue`/`pendingTerms`/`refreshSignal` through). |
| **SmartAddWordModal**   | Modal to add a word with LLM auto-filling missing fields. Only `term` is required; the LLM generates transliteration, definitions, examples (with translations), and — for Chinese — pinyin segments per example. The LLM **always** generates definitions and example translations in all four supported languages regardless of settings; the settings only control which subset is **displayed** (`displayDefinitionLanguages`, `displayExampleTranslationLanguages`) and which language each form field is **pre-filled** with (`defaultAddWordLanguage` for the outer Language radio, `defaultDefinitionLanguage` for the first definition row). Note that the modal exposes two independent language fields — the outer "word language" (sent as the `:language` route parameter, backend full-name format) and per-row "definition language" (ISO code, used as the key in `definitions[].text`) — easy to confuse. Duplicate detection: shows "⚠ Already in DB" if the term is already in Firestore; shows "⏳ Already queued" (amber) and disables the submit button if the term is in `pendingTerms` (queued but not yet written). For Chinese, uses inline debounced `checkTerms` + `smartAddWord` to show WorldList-style `rounded-full` pill buttons with an amber flag checkbox below each addable segment on space-split example sentences; when `onQueue` is provided, segment chip additions route through the queue (amber "⋯" queued state, `checkTerms` re-runs on `refreshSignal`). When the `onQueue` prop is provided the modal enters **queue mode**: clicking Save enqueues the word instantly (no blocking LLM wait), flashes "✓ Queued", then resets the form so the user can add the next term immediately. Also accepts optional `pendingTerms?: Set<string>` and `refreshSignal?: number` to enable the queued-duplicate detection and chip re-checks. |
| **FlaggedReview**       | Review interface for flagged words. Allows browsing and unflagging words marked for review. When `showKoreanHanja` is enabled and the word has `hanjaReadings`, a 🀄 Korean Hanja section is shown above the definitions in the revealed answer. |
| **LanguageSelectModal** | Modal to pick the target language when starting a new quiz. Lists languages fetched from the API.                  |
| **LevelSelectModal**    | Modal to select proficiency levels (e.g., HSK1-4–HSK7-9) for filtering. (No longer used in the quiz start flow — levels are now inside QuizFilterModal.) |
| **QuizFilterModal**     | Multi-panel filter modal shown before starting a word quiz. Covers topics, categories, levels, and word groups (all panels separated by AND dividers). Levels and groups were previously in separate modals and are now consolidated here. Supports "Select All" / "Clear All" per panel. |
| **GroupPickerModal**    | Modal for managing word group membership. Lets users create, rename, and delete groups, and toggle which groups a set of words belongs to. Used from WordList's "Manage Groups" button and per-word "Add to Group" action. |
| **WordFormModal**       | Modal for adding or editing a word manually with all fields. For Chinese, uses inline debounced `checkTerms` + `smartAddWord` to show WorldList-style `rounded-full` pill buttons with an amber flag checkbox below each addable segment on space-split example sentences. Accepts optional `onQueue?`, `pendingTerms?`, and `refreshSignal?` props — when `onQueue` is provided, segment chip additions route through the queue (amber "⋯" queued state driven by `pendingTerms`) instead of calling `smartAddWord` directly; `checkTerms` re-runs on `refreshSignal` so chips flip to ✓ after the word commits. |
| **GrammarList**         | Browse grammar items with search, level/group filters, and inline edit/delete. Example translations render per-language (filtered by the grammar definition-language display setting) when stored as multi-language objects. |
| **GrammarFilterModal**  | Modal to select grammar groups and question count before starting a grammar quiz. |
| **GrammarQuizTaking**   | Grammar quiz flashcard UI — displays an example-sentence translation (multi-language translations filtered by the grammar definition-language display setting), reveals the answer, and allows self-grading (correct/incorrect). |
| **GrammarFormModal**    | Modal for adding or editing grammar items with statement (required), descriptions, related words, and examples. New description rows default to the server-persisted grammar default definition language (`GET /api/grammar/settings`, cached across mounts). |
| **StudyQuizModal**      | Unified quiz setup modal with word / grammar / combined tabs. The combined tab (`CombinedQuizFilterModal`) has word-vs-grammar domain-weight inputs plus per-group weights on both sides; a domain weight of 0 excludes that domain. |
| **CombinedQuizTaking**  | Combined quiz UI — renders each question by `kind`, reusing the word quiz's paged hydration and the grammar quiz's item-detail cache. |
| **TranslationView**    | Translation/analysis UI. Input text plus an optional context/situation field (register, politeness, word-sense hints), select the source language (target = active study language), get schema-based sentence decomposition with per-component analysis. Passage translations render live while the response streams; regenerating unchanged text replays the cached decomposition so step 1 is skipped. Reading column (furigana/pinyin) shown only when source text contains CJK characters. Per-language regenerate buttons during streaming for stuck translations. History persisted to Firestore (including the context used) with previous/next navigation. |
| **SpeakingWritingView** | Text correction UI. Select correction language (EN/JA/KO/ZH), choose speaking or writing mode with use-case context (professional/casual/presentation/interview or academic/social/email/creative), submit text for SSE streaming LLM correction. Displays per-sentence corrections with severity badges (error/improvement/style), and overall feedback. Previous/next navigation between corrections within a session. Sessions persisted to Firestore for resume. |
| **Home Page (EmptyState)** | Home screen sections driven by `sectionOrder` in `settings/defaults.ts` (Vocabulary, Translation, Speaking & Writing, Grammar, Word & Grammar combined quiz). Checks for in-progress word/grammar/combined quiz sessions, translation history, and speaking/writing sessions; the combined quiz buttons are hidden for languages without grammar (English). |

### API Integration

- **`api/client.ts`** — Generic `fetchJson<T>()`, `postJson<T>()`, `putJson<T>()`, and `deleteRequest()` utilities wrapping the Fetch API. On non-ok responses, the response body is read and included in the thrown error so callers receive the backend's actual message (e.g. "Failed to generate word data") rather than a generic HTTP status string.
- **`api/quiz.ts`** — `getCurrentSession(language)`, `startQuiz(opts)`, `getQuizQuestions(language, offset, limit)`, and `answerQuestion(opts)`.
- **`api/vocab.ts`** — `getWords(language, filters?, page?, limit?)`, `getFilters(language)`, `updateWord(language, wordId, updates)`, `deleteWord(language, wordId)`, `checkTerms(language, terms[])`, `smartAddWord(language, data)` (the LLM always generates definitions and example translations in all four supported codes — the client passes only `term`, optional anchor `definitions`, optional `transliteration`/`topics`/`examples`/`level`).
- **`api/grammar.ts`** — `getGrammarItems(language, filters, page, limit)`, `createGrammarItem(language, item)`, `smartAddGrammarItem(language, item)`, `updateGrammarItem(language, grammarId, updates)`, `deleteGrammarItem(language, grammarId)`, `getGrammarSettings()` / `updateGrammarSettings(defaultDefinitionLanguage)`, group CRUD (`getGrammarGroups`, `createGrammarGroup`, `renameGrammarGroup`, `deleteGrammarGroup`, `modifyGrammarGroupMembers`), `startGrammarQuiz(opts)`, `answerGrammarQuestion(opts)`, `getCurrentGrammarSession(language)`, `getGrammarProgress(language)`, `resetGrammarProgress(language)`.
- **`api/combined-quiz.ts`** — `startCombinedQuiz(opts)`, `getCombinedQuizQuestions(language, offset, limit)`, `answerCombinedQuestion(opts)`, `getCurrentCombinedSession(language)`.
- **`api/flagged.ts`** — `getFlaggedWords(language)`, `getFlaggedWordCount(language)`, `flagWord(language, wordId)`, `unflagWord(language, wordId)`.
- **`api/translation.ts`** — `translate(sourceLanguage, sourceText, targetLanguages, context?)`, `translateStream(sourceLanguage, sourceText, targetLanguages, callbacks, signal?, options?)` (options: `context` situation hint, `decomposition` replay to skip step 1), `getTranslationHistory(page, limit)`, `deleteTranslationHistory()`, `deleteTranslationEntryById(id)`.
- **`api/speaking-writing.ts`** — `submitCorrection(language, mode, useCase, inputText)`, `submitCorrectionStream(language, mode, useCase, inputText, callbacks, signal?)`, `getSpeakingWritingSession(language)`, `deleteSpeakingWritingSession(language)`.
- **Dev proxy:** Vite proxies `/api/*` to `http://localhost:3000` so the frontend dev server can reach the backend.

### Internationalization

- Context-based (`i18n/context.tsx`): `I18nProvider` + `useI18n()` hook.
- Translation keys defined in `i18n/translations.ts` for Japanese, English, and Korean. Default UI language is English.
- Type-safe keys via the `TranslationKey` type. Supported UI languages exported as `uiLanguages` array (`en`, `ja`, `ko`). Which languages appear in the header is controlled by `settings.activeUiLanguages`.

### State Management

React hooks (`useState`, `useEffect`) + Context API (`I18nProvider` for UI language, `SettingsProvider` for app settings). No external state library. Settings are persisted to `localStorage("appSettings")`.

### Styling

Tailwind CSS 4 utility classes only — no custom CSS beyond the Tailwind import.

---

## Data Storage

Production data is stored in **Google Cloud Firestore** (database: `vocab-database`).

| Firestore Collection | Contents                                              |
| -------------------- | ----------------------------------------------------- |
| `languages`          | Language metadata (word count, topics)                 |
| `words`              | Vocabulary words (one document per word)               |
| `example_sentences`  | Normalized example sentences shared across words (id, sentence, translation, segments, language, ownerWordId); words reference these via `exampleIds` and `appearsInIds` arrays |
| `example_sentence_index` | Dedup lookup by sentence text (composite key: `{language}_{sha256(sentence).slice(0,16)}` → exampleId) |
| `id_maps`            | Term → word ID mappings and next ID counter            |
| `progress`           | Per-word progress (times seen, correct rate)            |
| `word_index`         | Fast term → {id, level, transliteration} lookup (composite key: `{language}_{term}`) |
| `word_groups`        | User-defined word groups per language (id, language, name, wordIds[], createdAt); used to scope quiz and word list |
| `quiz_sessions`      | One word quiz session per language (keyed by language name)  |
| `flagged_words`      | Flagged words for review                              |
| `grammar_chapters`   | Grammar chapter metadata (per language)               |
| `grammar_items`      | Grammar items (statement + multi-language descriptions, `exampleIds` into `example_sentences`) |
| `grammar_progress`   | Per-component grammar progress                        |
| `grammar_quiz_sessions` | One grammar quiz session per language              |
| `combined_quiz_sessions` | One combined word+grammar quiz session per language (word questions stored slim; re-hydrated via the paged questions endpoint) |
| `translation_history`  | Translation/analysis entries with structured LLM results (including the optional user context) |
| `speaking_writing_sessions` | One speaking/writing correction session per language |
| `expression_recall_sessions` | One expression **recall** (flashcard) quiz session per language. The LLM-graded expression *writing* quiz is not here — it is a subfield of `speaking_writing_sessions`. |
| `config`               | App configuration (`config/llm` for the OpenAI API key and tier-default models, `config/llm_models` for the model catalog and per-feature assignments, `config/speaking_writing` for prompts/schemas/use-cases, `config/translation` for prompts/schemas, `config/vocabulary` for smart-add and segmentation prompts/schemas, `config/grammar` for grammar smart-add prompts/schemas, `config/grammar_settings` for the grammar default definition language) |
| `token_usage`          | Individual LLM call logs with token counts                |
| `token_usage_daily`    | Daily aggregates by model                                 |
| `archive_backups`      | Cold archive of pre-migration backup word/grammar data — **never read by the app** (chunked subcollections for large files) |
| `archive_originals`    | Cold archive of the original HSK files by date folder — **never read by the app** (chunked subcollections for large files) |

**Firestore is the source of truth for words and grammar**; nothing is uploaded
from the local repository any more, and `backend/DB/word/` is empty. What remains
under `backend/DB/` is config the app does read — prompts and schemas
(`speaking&writing/`, `translation/`, `vocabulary/`, `grammer/`, `import/`), pushed
with `./deploy.sh … --prompts` — plus the `backup/` and `original/` archives, which
only the standalone `migrate-db-config-to-firestore.ts --archives` touches.

## Configuration

| Variable              | Default          | Description                        |
| --------------------- | ---------------- | ---------------------------------- |
| `PORT`                | `3000`           | Server listening port              |
| `HOST`                | `0.0.0.0`       | Server listening address           |
| `FIRESTORE_DATABASE_ID` | `vocab-database` | Firestore database ID            |
| `OPENAI_API_KEY`       | —                | OpenAI API key (falls back to Firestore `config/llm`) |
| `OPENAI_MODEL_MINI`    | —                | Default model for fast tasks such as smart-add and segmentation (falls back to Firestore `config/llm`; overridden by `config/llm_models` if set there) |
| `OPENAI_MODEL_FULL`    | —                | Default model for translation/analysis and speaking/writing (falls back to Firestore `config/llm`; overridden by `config/llm_models` if set there) |
| `FIRESTORE_PROJECT`    | —                | Google Cloud project ID (required for Firestore in deployed environments) |
| `GOOGLE_CLIENT_ID`     | —                | OAuth 2.0 client ID (falls back to Firestore `config/auth`) |
| `GOOGLE_CLIENT_SECRET` | —                | OAuth 2.0 client secret (falls back to Firestore `config/auth`) |
| `OAUTH_REDIRECT_URI`   | —                | Must match a registered redirect URI exactly; cannot be inferred from the request |
| `SESSION_SECRET`       | —                | HMAC key for the session cookie; must be identical across instances |
| `ALLOWED_EMAILS`       | —                | Comma-separated sign-in allowlist |
| `ALLOWED_ORIGINS`      | (see `index.ts`) | Comma-separated CORS origin allowlist |

## Authentication (Google OAuth)

The app is gated behind Google sign-in, restricted to an email allowlist. There is no
per-user data — everyone who is allowed in shares one dataset — so the allowlist is the
whole access-control model.

**Auth is off until `config/auth` exists in Firestore.** A missing document means "never
configured" and the app serves as it always did; a *failed read* is treated as unknown and
the backend refuses to start rather than silently exposing the API.

### One-time setup

1. Create an OAuth 2.0 Client ID (**Web application**) in the
   [Credentials console](https://console.cloud.google.com/apis/credentials?project=vocab-trainer-490014)
   for project `vocab-trainer-490014`, with these **Authorized redirect URIs**:

   ```
   https://vocab-trainer-frontend-olncevthqa-an.a.run.app/api/auth/callback
   https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app/api/auth/callback
   http://localhost:5173/api/auth/callback
   ```

   Leave **Authorized JavaScript origins** empty — this is the server-side authorization-code
   flow. The URIs point at the *frontend* service because nginx reverse-proxies `/api/`, which
   keeps the session cookie first-party to the SPA origin.

2. Supply the client ID and secret. The migration script resolves them in this order —
   **flags → `.env`/environment → interactive prompt**, so no hand-editing is required:

   ```bash
   # Prompts for both, then saves them to .env so it never asks again
   cd backend && npx tsx scripts/migrate-auth-config-to-firestore.ts

   # Or pass them non-interactively
   cd backend && npx tsx scripts/migrate-auth-config-to-firestore.ts \
     --client-id=...apps.googleusercontent.com --client-secret=GOCSPX-...
   ```

   With no terminal attached (CI, piped stdin) it exits 1 with instructions rather than hanging.
   `OAUTH_REDIRECT_URI`, `SESSION_SECRET` and `ALLOWED_EMAILS` are optional — the script defaults
   them and generates a session secret on first run, preserving it afterwards.

3. Deploy with the `--auth` flag, which uploads the config **and** rolls a new revision
   (config is read at boot, so a Firestore write alone does not activate it):

   ```bash
   ./deploy.sh vocab-trainer-490014 asia-northeast1 --auth
   ```

   Run from an interactive terminal, this prompts for the credentials the first time.

To add or remove a user, change `ALLOWED_EMAILS` and re-run the same command. The allowlist is
re-checked on every request, so removing an address revokes that person's live session.

## Docker

Both Dockerfiles use **Node 24 Alpine** with multi-stage builds to keep images small.

| Service    | Port | Description                                          |
| ---------- | ---- | ---------------------------------------------------- |
| `backend`  | 3000 | Multi-stage build → `node dist/index.js` (production deps only) |
| `frontend` | 5173 | Multi-stage build → Nginx Alpine serves static assets, proxies `/api/` to backend |

See [Quickstart](#quickstart) for usage.
