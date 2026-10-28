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
| Mathematics pure/contract/compiler tests | 34 passed |
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

Release, post-deploy model verification and final migration results are recorded
below after execution. Local backups, release reports and learning data are ignored
by Git. Engineering Math materials are outside the allowlist and were unchanged.

## Remaining verification boundaries

PowerShell deployment was updated in parallel with Bash, but no PowerShell runtime
is installed here for executing the Windows script. Actual local OCR/model quality
and iOS device installation were not performed. AI grading and independent model
checks do not establish general mathematical correctness or complete equivalence.

The completed v2 implementation plan was removed at the user's request; the
maintained contract is the feature guide plus the authoritative JSON schemas.
