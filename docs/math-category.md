# Mathematics category

Implemented 2026-10-28 from [the category plan](../plan/math-category-implementation-plan.md)
and [authoring design](../plan/math-content-authoring-design.md). Mathematics is a
separate `/math/*` route and `math_*` Firestore namespace; it is never a language,
word, grammar, or A/B group. The existing shared learner and authentication model
also applies here. The English study-language pause remains in place.

The v2 contracts are the [chapter schema](../prompt/math-chapter.schema.json),
[subject schema](../prompt/math-subject.schema.json) and this guide. Release
evidence is recorded separately in [v2 verification](math-v2-verification.md).

## Study workflow

1. Open **Mathematics**, select a subject, then check a curriculum range.
   Parent checkboxes select eligible leaves; partial selection is indeterminate.
   Reference-only headings do not count as targets.
2. Choose difficulty (1–5). The optional count accepts integers 1–20. Leave it
   blank for continuous study until **Finish test**. The current UI language is
   frozen for questions. Preview and creation occur within the Start action.
3. The server derives prerequisite chapter closure and explicit item requirements;
   only selected objectives are assessed. There is no title search or selectable
   knowledge policy. Prerequisite permission does not record learner mastery.
4. A durable job generates one question, independently solves it and validates it.
   Subsequent questions require an explicit **Next question** action. A test has
   at most one unanswered question and one active generation job. Failed slots
   retain their budget and ordinal for retry.
5. Save drafts and submit, self-assess on paper, or skip through the serial outbox.
   End session pauses for fixed-boundary review; resume continues the test.
6. Finite tests finish at their valid answered question limit. Continuous tests
   require **Finish test**. Finish flushes drafts and cancels/fences generation;
   asynchronous grades and review cannot reopen a finished test.
7. Review criterion scores, correct a grade or report an invalid question.
   Invalidation retains answers but removes score/evidence; finite tests may
   replace invalid questions on the next request.

Solutions show the knowledge used **before** the explanation. Each step then
shows citations, applicability conditions and the mathematical explanation.
Citations retain the full original hierarchy, item label, edition and available
pages from a fixed snapshot. Local Markdown notes have their actual heading
hierarchy and no invented book edition or PDF page.

Markdown uses `react-markdown`, `remark-math` and KaTeX. Inline `$...$` and block
`$$...$$` are rendered with local fonts and MathML. Raw HTML, external images,
unsafe links and trusted KaTeX commands are disabled. Long equations scroll.
AI grades for general expressions/proofs are provisional; uncertain answers go
through `needs_review`. There is no arbitrary code execution, general CAS
identity check, handwriting reader or diagram grader.

## Scope and version rules

`math-graph.ts` validates concept/capability DAGs, including every OR branch.
Branches are selected by unconfirmed requirements, added capabilities, configured
priority and stable IDs, with a bounded search that fails instead of truncating.
Objective-specific prerequisites do not alter canonical concept prerequisites.
Recommended/related edges grant no permission. `apply` never grants `prove`.

`math-scope.ts` expands selected leaves to assessed objectives and derives chapter
and item prerequisites. Chapter dependencies use explicit `requires-all` edges;
Part dependencies expand to chapters. Same-chapter siblings are not automatically
allowed. Apply never grants prove, and a proof target cannot be assumed.
Unsupported scope/difficulty fails explicitly rather than silently expanding it.

V2 creation uses strict `schemaVersion: 2` requests. Preview expires in 30 minutes;
creation rechecks its exact hash and active catalog. A catalog conflict preserves
settings and requires another Start action. Started tests retain immutable scope,
source and dependency snapshots. V1 snapshots remain supported only for existing
test continuation; their policy is not converted to a v2 user setting.

`POST /api/math/tests/:id/next-question` and `/finish` use operation IDs and
expected revisions. Receipts precede CAS checks. GETs never generate questions.
V2 question plans are stored separately; histories are cursor-paginated and the
view contains the current question plus aggregates, not all past questions.

## Local authoring

Original PDFs remain local. The v2 editable source is chapter JSON, using the
single-source schemas and complete example in `prompt/`. `textbook/catalog.json`
is the publication allowlist; only each listed manifest and its explicit chapter
files are read. Unregistered folders, including Engineering Math, are untouched.

```bash
npm run math:validate --prefix backend -- --root ../textbook
(cd backend && npx tsx scripts/math-release.ts validate)
```

Subject manifests define display parent/order and explicit chapter dependencies.
Chapter JSON contains recursive sections, items, Markdown/LaTeX blocks, learning
capabilities and reviewed objectives. Untitled items use kind/label fallbacks.
Defaults admit only conservative recognize/apply difficulty 1–2 objectives. Missing
proof support never grants proof questions. Canonical JSON hashes preserve body
whitespace; compiler-version/content/dependency review receipts invalidate on edits.
Duplicate keys, unknown fields, escaping paths, symlinks, dependency cycles and
invalid math fail before publication. Schemas are copied into backend build output
for cwd-independent runtime validation.

See [JSON authoring instructions](../prompt/math-textbook-json-authoring.md) and
[the conversion reports](math-v2-conversion/) for all nine Linear Algebra chapters.
Legacy Markdown/YAML adapters exist for historical fixtures and migration. They
are not production textbook publishers. OCR remains local-only; its drafts must
pass JSON review/accept before publication.

The built-in adapter requires local Poppler (`pdfinfo`, `pdftoppm`)
and a configured loopback vision/model endpoint. `pdftotext` is optional: if it is absent, the adapter records an image-only OCR warning. It renders and OCRs explicitly
selected pages locally, then composes a review package; OCR is never sent to a
remote fallback. A missing tool/model saves the run's failure instead of inventing
content. Calls/tokens and completed pages survive restart, and a completed run
replays without more inference. The adapter does not automatically mark its OCR
output verified. External-agent packages use the same import/review path; see the
[local OCR guide](../prompt/math-ocr-local-guide.md) and
[extraction prompt](../prompt/math-pdf-to-learning-units.md). Actual local-model
OCR quality must be checked on the chosen machine and source; mocked tests do not
establish that quality.

## Publish and rollback

Normal `./deploy.sh` (or `deploy.ps1`) validates JSON before building, stages an
immutable catalog with chunk/hash/read-back checks, deploys the compatible backend,
checks `/health`, switches the active pointer with CAS, then deploys the frontend.
The same content hash is a no-op. A failed stage/backend cannot activate a catalog;
CAS conflicts fail rather than overwriting another release.

Release reports store previous/current catalog IDs in ignored
`backend/data/math-release-<release-id>.json`. After a frontend failure, explicitly roll back
using that report (this changes only the catalog pointer):

```bash
(cd backend && npx tsx scripts/math-release.ts rollback --production \
  --project vocab-trainer-490014 --database vocab-database \
  --report data/math-release-RELEASE-ID.json)
```

`math-release.ts stage` and `activate` accept the same explicit target flags and
`--report PATH`, making them independently resumable. No config upload flag is
required for textbook publishing. Historical immutable catalogs remain available.

One-time raw source migration is separate from deployment:

```bash
(cd backend && npx tsx scripts/math-migrate-json.ts --production \
  --project vocab-trainer-490014 --database vocab-database --dry-run)
```

Inventory logs counts/hashes/reference counts only. Applying requires the returned
`--manifest-hash`, `--expected-active-catalog-id`, restricted `--backup` directory
and `--checkpoint` file. `--resume` reuses verified backups/checkpoints. Historical
bodies are preserved exactly in JSON; aliases resolve old hashes without replacing
old snapshots with current chapters. Optional `--delete-legacy` additionally
requires `--compatible-backend-url`, compatible-reader health and drained leases.
Checksum/read-back/reference mismatches block deletion. Backups and checkpoints
must never be committed. Rollback after deletion requires a JSON/alias-compatible
backend; raw-MD-only code is no longer a valid rollback target.

The generic `seed:load` wipes the emulator database and therefore also removes
mathematics, but its old downloaded snapshots do not contain mathematics. Reload
math explicitly afterward. The isolated mathematics test runner never downloads
production data and refuses non-demo projects or nonlocal emulator hosts.

## Jobs, security and deployment

```bash
(cd backend && npx tsx scripts/setup-math-jobs.ts vocab-trainer-490014 asia-northeast1)
(cd backend && npx tsx scripts/setup-math-indexes.ts vocab-trainer-490014 vocab-database)
node backend/scripts/check-math-jobs.mjs vocab-trainer-490014 asia-northeast1
./deploy.sh
```

Setup adds an independent `math` queue (concurrency 1), `math-task-invoker` service
account and one-minute `math-reconcile` scheduler. It preserves existing import
settings. Index setup adds the entries in `firestore.math.indexes.json`, without
replacing/deleting other indexes. Wait for composite indexes to become READY.
Normal deploy checks existing math worker configuration if enabled and preserves
it using environment updates. Math prompts/schemas are code-managed, so no
`--prompts`, `--llm` or `--auth` upload flag is needed. Windows deployment checks the
same prerequisites. Compose and local wrappers start a separate math worker.

Worker routes are exact POST `/internal/math/run` and `/internal/math/reconcile`.
They require verified Google OIDC issuer/audience/service-account/email. Web
cookies and emulator HTTP bypasses do not run workers. Public math APIs retain
normal application auth, strict schemas and explicit error codes. Absent worker
configuration returns 503 for generation while catalog browsing remains available.

Each task processes one generation/solve/comparison or grading checkpoint, with
540-second processing budget, 600-second task deadline and 660-second lease.
Lease token, generation and sequence guard every result commit. Reconciliation
uses new dispatch sequences to recover lost enqueue acknowledgements and expired
workers; stale workers cannot publish after cancel/replacement. Calls and reserved
usage budgets persist before inference, including after retry-generation.
Checkpoints keep accepted results, and grading writes evidence once per
attempt/objective/concept. Actual model token/cost reporting uses existing usage
and configured model rates. A crash between inference and commit can still cost
an extra model call.

Every test mutation has an operation ID and request hash. Receipts are checked
before revision comparisons. Drafts, test state, review cursors and grade versions
have separate CAS controls. The outbox freezes a request at first send, passes
acknowledged revisions to later operations and retains mathematical conflicts for
explicit retry/discard. Unsent text is memory-only, with Web unload warnings and
capture-navigation blockers. LocalStorage stores no answers. Native foreground
refresh includes math test routes; a Cloud Run deploy does not update an installed
iOS bundle (`npm run ios:sync --prefix frontend` and Xcode installation are separate).

## Verification

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:mixed --prefix backend
npm run test:import --prefix backend
npm run test:math --prefix backend
npm run test:math:emulator --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run test:browser --prefix frontend -- --grep math
npm run build --prefix frontend
```

Math tests use independent legacy fixtures and validated JSON chapters. Compiler, external package review/accept, scope, independent
quality gates, DTO secrecy, idempotent attempts, drafts, grading, invalidation,
review, catalog changes/rollback, cancellation, lease recovery and persistent
budgets are exercised. Browser tests cover failure-independent entry, v2 range selection, continuous next/finish, mobile rendering, translations and serial
draft/submission. The original synthetic
PDF under `src/test-fixtures/math` tests only local adapter plumbing.

For the historical v1 fixture (emulator compatibility tests only):

```bash
(cd backend && npx tsx scripts/math-verify-fixture.ts)
# Creates backend/data/math-verification, which is ignored by Git.
# With the compose stack running and local boot config present:
(cd backend && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/math-smoke.ts)
# The current Docker smoke validates the nine-chapter v2 JSON catalog.
```

The historical fixture includes three concepts and one objective about the
subspace criterion. V2 publishes the complete nine-chapter JSON allowlist instead.
The [original verification record](math-verification.md) remains unchanged history;
new release/model/device results belong in the v2 verification record.

Cloud verification is an explicit operation via `scripts/math-cloud-smoke.ts`
with `--production --project vocab-trainer-490014 --database vocab-database
--catalog-id HASH`. It creates one labelled verification test through the same
application routes in a local injection harness, dispatches real Cloud Tasks to
the deployed OIDC worker, waits for real-model generation/grading, and checks the
public HTTP auth boundary. This is distinct from an authenticated browser test.
Verification attempts are excluded from global learning evidence. Reports are
written under the ignored `backend/data/math-cloud-verification/` directory.
