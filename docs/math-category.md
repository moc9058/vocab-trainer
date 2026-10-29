# Mathematics: textbook-based tests

Implemented on 2026-10-29 after the reset below. The previous runtime and old
verification reports are not reused.

## Textbooks and publication

`textbook/manifest.json` assigns stable subject, book and chapter IDs, titles,
languages and relative MD paths. Current Linear Algebra contains nine English
chapters. Engineering Math has only an original PDF and is not published.
Filenames supply numeric chapter order and chapter titles; headings inside each
file remain content headings. Rename a file by updating its manifest path while
preserving its chapter ID. Add another book as a separate manifest entry.

Run `npm run math:sync --prefix backend -- --target=production --dry-run`, then
omit `--dry-run` to publish using Google ADC. For local development use
`--target=emulator` with `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`. The project
and database default to `vocab-trainer-490014` / `vocab-database`; override with
`FIRESTORE_PROJECT` / `FIRESTORE_DATABASE_ID`. The script does not load `.env` or
persist emulator settings. Production refuses an emulator environment; emulator
mode requires one.

`math_books` contains the published catalog. `math_chapter_versions` holds
immutable, content-addressed chapter revisions. Changed sources are written
before an atomic book publication; a failed/concurrent publication leaves the
old book usable. Unreferenced revisions may remain after a failed publication.
Unchanged chapters are skipped. Missing manifest entries retain already published
chapters; missing files for listed entries fail before any writes. No destructive
sync or PDF/image ingestion is provided. Maximum MD size is 250KB per chapter.
Deployment never publishes textbook data or uploads math configuration.

## Tests and model calls

Select a book and one or more chapters. Defaults are five questions, standard
difficulty and all three types: definition, calculation and proof. Counts range
from 1–10; difficulty is easy, standard or hard. The server balances the ordered
question plan across selected chapters/types where possible. If fewer questions
than chapters are requested, not every selected chapter receives a question.
All output follows the book's declared language, independently of UI language.

The server supplies complete selected chapter text and earlier chapters from the
same publication as prerequisite context. Unselected prerequisites cannot be the
sole subject of a question. Source payloads are limited to approximately 200KB;
oversized requests fail with an explicit scope-reduction message, without
silently truncating textbook text. No vector index, OCR or background math queue
is required in this version.

The `math/generate`, `math/validate`, and `math/grade` model features use the
existing full-tier default unless changed in LLM Models. Usage accounting and
request cancellation share existing infrastructure. Generation includes example
solutions, rubrics and exact chapter-heading citations. A separate model call
checks mathematical validity. Invalid output is regenerated once; failed
validation never starts a partial test. This is AI verification, not a formal
proof or a guarantee of correctness.

## Persistence, retries and review

`math_tests` stores fixed book/source revisions, questions, written answers,
three-way grading (correct/partial/incorrect), saved draft and lifecycle state.
Solutions/rubrics are omitted from API responses until that question is graded
or the test is ended. All questions become available for review after completion,
including unanswered ones. Wrong answers do not automatically repeat.

Create a saved test first, then generate questions. Generation and grading share
the existing 180-second request budget. Processing is synchronous; there is no
background worker. Interrupted work can be retried after its four-minute lease
expires. A fencing token prevents expired work from committing. Errors retain
saved progress and never turn a failed grading request into an incorrect answer.
Operation IDs have durable per-test receipts; request fingerprints reject ID
reuse with different content. Mutations also check the saved version to reject
conflicting tabs. Reload the saved state after a version conflict.

Input is saved on submission or explicit **Save and pause**, not on each
keystroke. Submit saves the answer before grading; a failed grade can be retried
with the same operation ID, including after reload. Unsaved input or processing
warns on page unload and the in-test library link. Do not rely on localStorage
for session persistence. History shows the latest 50 tests. Sessions follow the
application's existing shared authenticated workspace model.

## HTTP interface

All routes use existing authentication under `/api/math`:

- `GET /books`: published book/chapter metadata.
- `GET /chapters/:id`: immutable chapter revision and MD body (`id` is version ID).
- `GET /tests`: latest test summaries; `GET /tests/:id`: saved public test state.
- `POST /tests`: `{operationId, bookId, chapterIds, count, kinds, difficulty}`.
- `POST /tests/:id/generate`: `{operationId, version}`.
- `POST /tests/:id/answer`: `{operationId, version, questionId, text}`.
- `POST /tests/:id/state`: `{operationId, version, action, draft?}`; action is
  `pause`, `resume`, or `finish`.

IDs are 1–100 ASCII letters/digits/underscores/hyphens. Answer/draft inputs are
limited to 5,000 characters and 20KB. Missing tests are 404, invalid inputs 400,
conflicts/busy state 409, oversized scope 413 and failed model work 503. Clients
must preserve operation IDs when retrying the same request. Stored revisions
remain valid after subsequent publications; completed tests cannot reopen.

## Verification

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:math --prefix backend
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIRESTORE_PROJECT=vocab-trainer-490014 npm run test:math:emulator --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run test:browser --prefix frontend -- math.pw.ts
npm run build --prefix frontend
```

Math model tests use module mocks; integration tests use isolated test documents
in the emulator and remove those documents afterward. Browser tests mock API
responses. Live-model mathematical quality needs separate manual review.

---

## Historical reset record

# Mathematics category reset

Reset on 2026-10-28 so textbook storage, the data read by the LLM during tests,
and the test design can be rebuilt from scratch.

The Mathematics card, `/math/*` route, category navigation and English/Japanese/
Korean placeholder remain. The page makes no math API requests and shows that
mathematics tests are unavailable during redesign. Old subject/test links show
that same placeholder.

Removed: textbook JSON/catalogs; all files in the root `prompt/` directory;
chapter/subject schemas; authoring and OCR tools; prerequisite/scope contracts;
LLM generation/validation/grading; test histories, drafts and learning evidence
implementation; math APIs/workers, fixtures, indexes and publication scripts.
Untracked original PDFs are retained. Other study categories and their prompts
under `backend/DB/` are unaffected.

Production cleanup targets only the `math_*` Firestore namespace (including nested
source chunks and snapshots), math LLM feature assignments, and the dedicated
`math` Cloud Tasks queue / `math-reconcile` scheduler. No textbook objects were
found in Cloud Storage: the project has no storage buckets. Deployment and data
deletion are separate operations; redeploying cannot republish the deleted data.

The [original verification](math-verification.md) and
[v2 verification](math-v2-verification.md) records remain historical. Their
commands, links and contracts describe the removed implementation and must not
be used as current operating instructions. No replacement JSON or LLM input
format is defined yet.
