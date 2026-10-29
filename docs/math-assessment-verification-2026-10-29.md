# Textbook assessment verification — 2026-10-29

This record covers the implemented curriculum v2 release described in
[textbook assessment](textbook-assessment.md). The original implementation plan
was removed after its contracts were moved into code and the maintained guide.

## Automated and local checks

- Backend TypeScript build, 136 unit tests, 7 math LLM contract tests and 4 mixed-quiz
  regression tests passed.
- Ten emulator tests passed against explicit project `vocab-trainer-490014`,
  database `vocab-database`, host `127.0.0.1:8080`. Fixtures clean their own documents.
  Coverage includes v1/v2 sessions, failure/retry receipts, plan reuse, item privacy,
  assistance, skip, frozen publications, concurrent publication and fencing.
- Frontend TypeScript, 118 unit tests, production build and eight math browser
  tests passed. Browser fixtures cover legacy sessions, v2 task/objective labels,
  mobile layout, feedback/reload, draft preservation on assistance, errors and history.
- Textbook validation passed for nine Linear Algebra chapters and 63 stable objectives;
  prepare reports no source changes. The skill frontmatter validator passed.
- Docker backend/frontend images built and served the book catalog through nginx
  at localhost:5173, including the v2 publication and all nine chapters.

The existing frontend bundle-size warning remains informational. No lint command
is configured. EN/JA/KO strings are type-checked; browser flows were exercised in English.

## Live model findings

Paid evaluation uses the configured `gpt-6.1-sol` for generate, independent solve,
comparison and grade. Test evidence is isolated from ordinary shared practice.
Raw questions, solutions and stage metrics remain under ignored backend/data.

Initial API smoke exposed the JSON output-mode requirement; every prompt now
explicitly requires valid JSON. An initial broader evaluation exposed a machine
contract that admitted only immediate supporting prerequisites. The validator now
admits the curriculum's permitted transitive prerequisite closure, with a regression
test; the previously failing two cases passed after correction. Prompt instructions
also require exact ability and task-specific answer modes. A later full evaluation
found a remaining verbatim heading transcription failure; server-issued reference IDs
now resolve exact frozen headings, with unknown-ID regression coverage.
The initial run was stopped after archiving 29 isolated test documents; its evidence
was cleaned. It is not counted as the release's complete 54-case evaluation.

Physics and economics fixtures each passed live derivation and computation (4/4).
The physics source makes constant acceleration and SI units explicit without calculus;
the economics source states exogenous parameters, nonnegative feasibility and static
model assumptions. Their catalogs prepare deterministically and preserve independent IDs.

The complete 54-case run (`assessment-eval-8ad9d6ba-54d0-4bc7-8d56-c4a39992c6b9`)
covered all nine chapters, all three difficulties and all four forms. 53/54 cases
passed G/V1/V2 and reference-solution grading; one was safely rejected for literal
heading transcription. This was the specific defect replaced by server-issued
reference IDs. Three successful cases regenerated/replanned. Median successful
case time including grading was 40.9 seconds; the maximum was 126.0 seconds.
The agent inspected all 53 admitted prompts/solutions, including all 18 hard tasks;
no material mathematical error was found. This is an AI review, not independent
human review, formal verification or empirical difficulty calibration.

After reference-ID normalization, the production-backed all-chapter smoke
(`assessment-eval-37187db5-920f-4da5-a8e5-bb7d6b42f2bb`) passed 9/9 generation,
independent solve, structured comparison, grading, receipt replay and pause/resume
cases. It used isolated server-owned evidence and cleaned its sessions and evidence.
These tests run the route handlers against production Firestore and live models;
they do not assert authenticated browser interaction with the deployed endpoint.
The complete 54-case run preceded the final reference-ID and arithmetic prompt
adjustments; final prompt assets receive separate smoke/fixture checks.

Prompt assets are now archived by hash before new v2 session creation, preserving
old instructions across subsequent code updates. The currently published prompt
bundle was archived before changing assets. Emulator coverage verifies loading an
archived version and refusing a missing version. Bounded rational-expression trees
receive exact BigInt checks without evaluating generated code.

## Production release

`./deploy.sh` completed successfully for backend revision `vocab-trainer-backend-00528-vcz`
and frontend revision `vocab-trainer-frontend-00510-km4` for the main implementation.
The final prompt-archive/arithmetic follow-up is recorded after deployment below.
The backend /health returned status=ok and the frontend /math HTML shell returned 200.
Authenticated native browser inspection was unavailable: the Mac was locked and
local browser access disabled in Work settings. Local Playwright's eight flow tests
passed; no production browser verification is claimed.

`math:sync --target=production --dry-run` and publication both completed, separately
from deployment. The complete publication is
`4dce138dd5062aa5766deada83caf6c6f42e8689e7714adf54464c9a9e7dc868`, with nine
chapters and 63 objectives. All chapter content versions were unchanged. Three
existing production v1 sessions were fingerprinted before publication and compared
afterwards: book snapshots, source versions, current question payloads and hydrated answers
remained unchanged. No bulk session rewrite or configuration upload was performed.
The evaluation CLI now pins the same project/database defaults as math:sync before
initializing Firestore, instead of inheriting an unrelated active gcloud project.

Stage token counts and configured cost estimates are retained in the ignored
summary artifacts. Missing/zero pricing rates mean unavailable billing estimates;
no zero-cost or mathematical completeness claim is made.


## Final follow-up checks

The prompt archive and exact rational arithmetic follow-up (`9b299a6`) deployed
successfully to backend `vocab-trainer-backend-00529-6zw` and frontend
`vocab-trainer-frontend-00511-nzb`, each serving 100% of traffic. Health remained ok;
an unauthenticated request to /api/math/books returned 401, preserving authentication.
The earlier prompt hash `574db963975adf5741420298b4668a6d4147f74fa08e30b5912d343d061f8ef5`
remains loadable from its immutable archive after the code switched to
`4ab0941a9eb25501a932641ae12f212f06e16f9868678b0c00aa4fa7e8b8427e`.

Final physics/economics live fixtures passed 4/4; both computation cases supplied
rational expression trees and passed the exact checker. The physics calculation
produced -3 meters from signed initial conditions; economics produced equilibrium
quantity 42/5 and price 36/5 with feasibility checks. These results also passed
independent solving, V2 comparison and itemized reference-solution grading.

The final production lifecycle run
`assessment-eval-7507ad34-338b-40df-b027-1cea2983d327` passed with the final prompt
hash: generation, grading, two further generations, solution_view assistance,
Skip with an unsubmitted draft, idempotent replay, history read, pause/resume and
finish. It completed in 104.2 seconds across 10 model calls. The skipped draft was
preserved and grading totals stayed at one answer. Its test/question documents and
isolated evidence were confirmed removed; the current prompt archive exists.

All runtime code is deployed. Later changes to this record and the explicitly
invoked evaluation CLI do not alter either service's runtime image.
