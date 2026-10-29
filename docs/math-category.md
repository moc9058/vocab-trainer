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

Select a book and one or more chapters; a single available book is selected
automatically. New sessions use **continuous** mode: there is no question count.
Start creates and independently checks the first question. After submitting an
answer, read the feedback and example solution, then choose **Next question**.
Questions continue until explicit **Save and pause** or **End test**. No question
is generated ahead of that action. Difficulty defaults to standard and all three
types (definition, calculation, proof) are enabled; both are under Question
settings. Chapter/type assignment rotates using the cumulative question number,
so each generation request continues the plan rather than restarting it.

The current question is the focus of the test page. Previous answers are in a
separate history dialog, 20 per page. Book text opens in a scrollable accessible
dialog, with styled headings, lists and LaTeX. Mobile controls stay at the bottom
of the screen. Output follows the book's declared language, independently of UI
language. The continuous progress indicator shows answers completed, without a
planned total or completion percentage.

Existing tests without `mode` remain **fixed** mode, including their original
question count (1–10), automatic completion, resume and review behavior. Old
clients that send `count` can still create fixed tests; new clients send
`mode: "continuous"` without `count`. No bulk migration or textbook sync is needed.

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

`math_tests` stores fixed book/source revisions, lifecycle and display phase
(`ready`, `question`, `feedback`), current question ID, draft and aggregate totals.
For continuous sessions, questions and answers are individual documents under
`math_tests/{id}/questions` with sequential numeric positions; parent
`questions` / `answers` remain empty. The parent stays bounded regardless of
session length. Read responses hydrate only the current question. Completed
sessions do not reopen, and textbook updates do not change their source versions.
Fixed sessions retain their existing inline storage.

Each continuous answer saves its text before grading. A successful grade updates
the question and aggregate totals atomically, and persists the feedback phase;
refreshing or resuming does not skip that explanation. Grades are correct,
partial or incorrect. Continuous sessions never end automatically after grading.
Finishing during an unanswered question retains the input as an unsubmitted
draft answer, without grading it; summary totals count it as unanswered.

The last 20 prompt excerpts (up to 1,000 characters each) guide generation away
from recent questions. A per-session prompt hash index rejects matching question
text across the entire history (Unicode/whitespace/case normalized). A different
question on the same concept is allowed. Duplicate candidates are retried once,
then fail without discarding feedback or ending the session. Model checks cannot
guarantee semantic uniqueness.

Solutions/rubrics are omitted from current-question and paginated-history
responses until that question is graded or the test is ended. Completion exposes
solutions for unanswered questions too. Wrong answers do not automatically repeat.

Generation and grading share
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
- `GET /tests`: latest test summaries; `GET /tests/:id`: saved public test state (only the current question for continuous tests).
- `POST /tests`: `{operationId, bookId, chapterIds, mode: "continuous", kinds,
  difficulty}`. Legacy fixed requests use `count` instead (or `mode: "fixed"`).
- `POST /tests/:id/next`: `{operationId, version}`; creates the first/next
  continuous question, or advances a fixed session from feedback to its next
  existing question.
- `GET /tests/:id/questions?after=0`: `{items, nextCursor}`; 20 questions per
  page. Each item contains `question`, optional `answer` and numeric `number`.
  Pass the returned numeric cursor as `after` for the next page.
- `POST /tests/:id/generate`: `{operationId, version}`; legacy fixed tests only.
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
