> Historical record: the mathematics implementation and textbook formats described below were removed on 2026-10-28. See [current status](math-category.md).

# Mathematics v2 verification — 2026-10-28

This records v2 separately from the historical [v1 verification](math-verification.md).
The implemented workflow and maintenance commands are in [the mathematics guide](math-category.md).

## Implemented scope

- Strict v2 range/difficulty/optional-count creation, automatic reviewed chapter
  prerequisites, immutable scope and v1 test continuation.
- One-question finite/continuous generation, explicit next/finish, persistent
  per-question plans, worker epoch fencing, bounded parent records and history pages.
- Checkbox hierarchy with partial selection; no title search, knowledge-policy
  selector or preview consent step. UI question language freezes at creation.
- JSON schemas, authoring/review/accept, local-only OCR drafts and nine converted
  Linear Algebra chapters. The 229 learning items compile to 458 conservative
  recognize/apply objectives. Defaults support difficulty 1–2; proof and harder
  objectives require explicit reviewed support rather than inferred coverage.
- JSON-only staging, read-back and CAS activation on both deployment scripts;
  explicit backup/checkpoint/alias migration separate from deployment.

## Local verification

Node 24.22.1 was used for the final backend checks. No production seed download
was used. Tests mock LLM inference unless explicitly labelled cloud/model checks.

| Check | Result |
| --- | --- |
| Backend build | Passed, including schema packaging |
| Backend existing tests | 117 passed |
| Mixed quiz route tests | 4 passed |
| Import route tests | 9 passed |
| Mathematics pure/contract/compiler tests | 37 passed |
| Mathematics emulator tests | 20 passed |
| Frontend TypeScript | Passed |
| Frontend tests | 123 passed |
| Frontend build | Passed |
| Mathematics browser tests | 10 passed |
| Docker build and local HTTP smoke | Passed: frontend assets, nine-chapter catalog, v2 preview, worker cookie refusal |
| Git whitespace check | Passed |

Emulator tests cover receipt-before-CAS replay, v1 continuations, 21 continuous
questions, finite completion/invalidation replacement, async grading, explicit
finish fencing, fixed review boundaries, two-device next races and retry budgets.
A synthetic 10,000-attempt history retains bounded parent/view responses. Source
and maintenance CLI tests cover backup corruption, resume after deletion, alias
substitution rejection, worker deletion barriers, staging/CAS and release replay.

Actual JSON scopes verify chapter 5 assesses only chapter 5 and uses chapter 1–4
prerequisites; all eligible leaves yield all 458 objectives. Single-leaf selection
does not automatically authorize same-chapter siblings. Nine-chapter exact source
round-trip hashes and math-token comparisons are in [conversion reports](math-v2-conversion/).

The 360px EN/JA/KO browser checks and inspected screenshots include long chapter
names, chapter 9's deeper hierarchy, indeterminate parents, keyboard selection,
real unit content and KaTeX. No page overflow or font fetch errors were observed.
These are browser checks; no new iOS device installation was performed.

## Release and migration

The initial read-only production inventory found one raw Markdown source (6,716
bytes, two immutable references) and no unresolved source references. The old
active catalog was `2e1e2c20ee379a476e9f3ab3a3df9ce367f4d9f9378e4276c3bf74e3dcade63f`.

The initial `git push origin master` and `./deploy.sh` completed successfully from release
commit `9fefee9`. Cloud Run revisions:

- Backend: `vocab-trainer-backend-00514-j8c` (100% traffic).
- Frontend: `vocab-trainer-frontend-00496-8ss` (100% traffic).
- Active JSON catalog: `91c3c4183c3e3a85bbd5383a6dff7506a5553283a362cf6dc1fcb1dbf1480e43`.

The compatible v1/v2 reader health check passed before CAS activation. Existing
math/import queue configuration was checked and retained; no config upload flags
were used. The authenticated production UI showed all nine chapters/229 items,
new controls and no title search/policy selector at 360px without page overflow.

The one historical source was backed up with restrictive permissions and verified
against its original hash/SHA-256, copied to chunked JSON and aliased. After the
new backend was deployed and worker jobs drained, the raw document was removed
with an explicit maintenance invocation. A final inventory found **zero raw
Markdown source documents and zero unresolved references**. The old catalog,
resolved source and three historical test view/scope snapshots had identical
hashes before and after removal. Cloud checks were read-only for those historical
tests; continuation/grading mutations were exercised in isolated emulator tests.

Local backups, checkpoints and release reports remain under ignored
`backend/data/math-json-migration/` and `backend/data/math-release-*.json`. Keep
these available for recovery; never roll back to an MD-only reader after deletion.
Engineering Math materials are outside the allowlist and were unchanged.

## Remaining verification boundaries

PowerShell deployment was updated in parallel with Bash, but no PowerShell runtime
is installed here for executing the Windows script. Actual local OCR/model quality
and iOS device installation were not performed. AI grading and independent model
checks do not establish general mathematical correctness or complete equivalence.

The completed v2 implementation plan was removed at the user's request; the
maintained contract is the feature guide plus the authoritative JSON schemas.

## Real-model grading follow-up

The first cloud verification test generated, independently solved and validated a
question and exposed its fixed citations correctly. Its grading job failed with
`MATH_INVALID_GRADE`; the rejected raw response was not persisted, so the precise
failed invariant cannot be established. A controlled diagnostic response was valid.

The grader now receives a schema tied to the immutable rubric: exact criterion IDs,
maxima, count and AI grade source. The prompt explicitly requires their preservation
and an arithmetic total. Strict aggregate/evidence validation remains unchanged;
invalid grades are not normalized into accepted scores. Three new regression tests
cover the serialized schema and invalid metadata/awards/duplicates/arithmetic.
The new contract passed a controlled real-model diagnostic. The follow-up was
pushed and deployed from `f9c933c` with the same catalog hash. Final revisions:

- Backend: `vocab-trainer-backend-00515-tmd` (100% traffic).
- Frontend: `vocab-trainer-frontend-00497-lp5` (100% traffic).

The failed verification attempt was retried through the application route and
Cloud Tasks/OIDC worker. It was graded successfully by `gpt-6.1-sol` at 100/100;
its test stayed completed. The retry receipt replay succeeded, and the same grade
job retained two calls / 10,641 tokens across the initial failure and retry.
One verification evidence record was present and marked invalid for learning
aggregation; no valid learning evidence was contributed. The final source check
found ten JSON artifacts and zero raw Markdown artifacts.

The real-model verification used one generated question plus two diagnostic grading
calls. Time-window usage for this workflow was seven calls, 25,133 prompt tokens
and 6,776 completion tokens. The model has no configured nonzero cost rate in the
existing metrics configuration, so a dollar estimate is unavailable; no pricing or
config was invented or uploaded. These few calls verify the pipeline/retry contract,
not general mathematical quality. Local detailed reports remain under ignored
`backend/data/math-cloud-verification/` and `backend/data/math-json-migration/`.
