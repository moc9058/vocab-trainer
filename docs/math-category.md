# Mathematics category

Implemented 2026-10-28 from [the category plan](../plan/math-category-implementation-plan.md)
and [authoring design](../plan/math-content-authoring-design.md). Mathematics is a
separate `/math/*` route and `math_*` Firestore namespace; it is never a language,
word, grammar, or A/B group. The existing shared learner and authentication model
also applies here. The English study-language pause remains in place.

## Study workflow

1. Open **Mathematics**, select a subject, and select any depth of its curriculum.
2. Set difficulty (1–5), count (1–20), answer format and question language
   (English/Japanese/Korean). Difficulty is an application guideline.
3. Preview **assessed objectives** separately from prerequisites, foundation
   profiles and knowledge supplied in the question. Accept the displayed scope.
   A prerequisite's use is permission for this test, not a claim of mastery.
4. Generation runs in a durable background job. Each candidate must pass structural
   checks, an independent solve without the candidate answer, and comparison checks.
   Three rejected candidates stop that slot. Retry the remaining slots, cancel, or
   explicitly accept a nonempty partial test; partial success never starts silently.
5. Start the test. Text/LaTeX drafts save through the serial answer outbox; the
   page indicates unsynced work. Submit, solve on paper and self-assess, or skip.
   Hints and solution viewing before submission record assistance.
6. End a sitting to review a fixed set of attempts. Resume unanswered questions in
   a new sitting. Natural exhaustion completes the test even while grading is
   pending; review and late grades cannot reopen it. Wrong answers are not
   automatically reinserted. A new test starts with a fresh scope preview.
7. Review criterion scores and evidence, correct a grade, or report a bad question.
   Explicit invalidation excludes its score and learning evidence while retaining
   the original answer. Concept pages separate self-declared readiness from
   version-specific objective evidence.

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

`math-scope.ts` expands node → unit → assessed objective, deduplicates targets,
resolves prerequisites and foundation closures, and freezes T/P/B/G and question
plans. Strict mode excludes objectives with missing prerequisites. Provided mode
uses only declared provideable knowledge, including its conditions and use
requirements; the answer to an assessed objective cannot be supplied as a given.
Proof plans separate must-establish from may-assume, and candidates cannot assume
the proposition being proved. Unknown IDs, unreviewed concepts, unsupported proofs,
size overflows and unsupported difficulty are explicit failures.

Scope previews expire in 30 minutes. Starting requires the exact preview hash and
acceptance set and rechecks the active catalog in the creation transaction.
Catalog changes return 409. Started tests retain their original catalog and
citation snapshots. Semantic concept revisions exclude physical file locations;
catalogs retain the artifact/block/source bindings. Old catalogs and revisions
are retained; there is no bulk rewrite or historical-data garbage collection.

## Local authoring

Original PDFs remain local. Reviewed Markdown/YAML is the editable original;
Firestore catalogs are immutable published runtime versions. The deploy scripts
never scan or upload `textbook`. All paths below are relative to the backend
package's working directory when invoked with `--prefix backend`.

```bash
npm run math:manifest --prefix backend -- --root ../textbook
npm run math:validate --prefix backend -- --root ../textbook

npm run math:extract --prefix backend -- --root ../textbook \
  --subject subject-id --source-id book-id --pdf /local/source.pdf \
  --pages 1-3 --plan-only --output data/math-authoring/example

npm run math:extract --prefix backend -- --root ../textbook \
  --subject subject-id --source-id book-id --pdf /local/source.pdf \
  --pages 1-3 --adapter local --semantic-policy local-only \
  --local-endpoint http://127.0.0.1:1234/v1/chat/completions \
  --local-model LOCAL_VISION_MODEL --output data/math-authoring/example
# Add --resume to continue a matching checkpoint.

npm run math:extract:import --prefix backend -- --root ../textbook \
  --package data/math-authoring/incoming/package.json --output data/math-authoring/review
npm run math:author-review --prefix backend -- --run data/math-authoring/review
npm run math:author-accept --prefix backend -- --run data/math-authoring/review \
  --units unit-id --expected-review-hash HASH --reviewed-by AUTHOR
```

Without `math.catalog.yaml`, validate reports `W_NO_CATALOG_METADATA` and an empty
catalog; manifest prints proposals without creating files. Existing Markdown notes
are not silently interpreted as approved learning units. Register a subject with
`subject.yaml`, `curriculum.yaml`, source metadata, unit references and profile
references. See `math-content.ts` for the strict schema and
`scripts/tests/math-fixtures.ts` for a small, source-backed example.

Authoring packages contain `schemaVersion`, `subject`, `units` (Markdown and
provenance), `sources` (metadata and flat source outlines), `coverage`, and
`unresolved`. YAML aliases, duplicate keys, unknown fields, symlinks, escaping
paths and normalized path collisions are rejected. Blocks use explicit heading
anchors; headings inside fenced code are ignored. Conditions, proof support,
source hierarchy, formula validation and content/provenance-bound review receipts
are checked. Partial units expose only ready objectives; blocked concepts cannot
enter a question context. Content edits invalidate their review receipts.

Review/accept creates a staged tree, compiles it, checks every expected old hash,
then uses a recoverable journal to install the selected units, provenance,
receipts, curriculum and source metadata. A changed original stops acceptance.
Replaying the same journal is safe. Review receipts are a local authoring audit,
not a cryptographic trust boundary against the local author.

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

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIRESTORE_DATABASE_ID='(default)' \
  npm run math:sync --prefix backend -- --root data/math-verification --dry-run
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIRESTORE_DATABASE_ID='(default)' \
  npm run math:sync --prefix backend -- --root data/math-verification --publish

npm run math:sync --prefix backend -- --root data/math-verification --production \
  --project vocab-trainer-490014 --database vocab-database --dry-run
npm run math:sync --prefix backend -- --root data/math-verification --production \
  --project vocab-trainer-490014 --database vocab-database --publish \
  --manifest-hash HASH --expected-active-catalog-id none
# Use the returned previous catalog ID instead of "none" when one exists.
# Rollback uses --rollback CATALOG_ID --expected-active-catalog-id CURRENT_ID
# with the same explicit project/database/production flags.
```

Publication writes bounded content-addressed documents and chunks, reads them back,
and exchanges the active pointer in a short CAS transaction only after staging is
complete. A failed staging write cannot replace the active catalog. No PDF bytes,
page images, raw OCR or absolute local paths go into Firestore. The CLI refuses
mixed emulator/production settings. Staging older than seven days and expired
previews are cleaned up in bounded passes; operation receipts and historical
learning data are retained.

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

Math tests read a small portion of `textbook/Linear Algebra/1. Vector Spaces.md`
without altering it. Compiler, external package review/accept, scope, independent
quality gates, DTO secrecy, idempotent attempts, drafts, grading, invalidation,
review, catalog changes/rollback, cancellation, lease recovery and persistent
budgets are exercised. Browser tests cover failure-independent entry, scope
consent, mobile math rendering and serial draft/submission. The original synthetic
PDF under `src/test-fixtures/math` tests only local adapter plumbing.

For a reproducible small verification catalog (not automatic textbook import):

```bash
(cd backend && npx tsx scripts/math-verify-fixture.ts)
# Creates backend/data/math-verification, which is ignored by Git.
# With the compose stack running and local boot config present:
(cd backend && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/math-smoke.ts)
```

The verification catalog includes three concepts and one objective about the
subspace criterion. It does not represent all nine chapters as imported or
reviewed. Real LLM checks, Cloud Run deployment checks and device checks are
reported separately in the [implementation verification record](math-verification.md).

Cloud verification is an explicit operation via `scripts/math-cloud-smoke.ts`
with `--production --project vocab-trainer-490014 --database vocab-database
--catalog-id HASH`. It creates one labelled verification test through the same
application routes in a local injection harness, dispatches real Cloud Tasks to
the deployed OIDC worker, waits for real-model generation/grading, and checks the
public HTTP auth boundary. This is distinct from an authenticated browser test.
Verification attempts are excluded from global learning evidence. Reports are
written under the ignored `backend/data/math-cloud-verification/` directory.
