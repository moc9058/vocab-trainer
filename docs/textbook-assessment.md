# Textbook assessment

Implemented contract, 2026-10-29. This guide replaces the implementation plan.
The `/math` route remains compatible; book.subjectTitle identifies the subject.

## Sources, authoring and validation

New sources belong in `textbook/<book>/md/`. Linear Algebra now uses lowercase
`md/`; its nine chapter IDs, 63 objective IDs and chapter content versions are
preserved. Engineering Math originals are outside this change.

Manifest books declare `curriculumFile` and a versioned `subjectProfile` with
subject `mathematics`, `physics` or `economics` and explicit source constraints.
The schema is defined by `Curriculum`/`CurriculumObjective` in
`backend/src/math-types.ts`. Operational statements, success criteria and authoring
instructions are English; exact source headings retain their language. Problem
and feedback language follows book.language, independently of the EN/JA/KO UI.

The JSON catalog is authoritative. Each objective has a stable ID, source chapter
and exact section references, ability, supportedTaskKinds, observable criteria,
prerequisite IDs, external background, constraints, common errors and active/retired
status. Same-meaning changes preserve IDs; semantic changes allocate new IDs and
explicit supersedes links. Retired objectives remain available to past references.

The repository [textbook-curriculum skill](../.agents/skills/textbook-curriculum/SKILL.md)
runs as part of an agent handling textbook additions/edits, without a separate
curriculum request. It is not a background watcher and makes no automatic paid API
calls. Preparation and validation are local:

```bash
npm run textbook:prepare --prefix backend
npm run textbook:validate --prefix backend -- --write
npm run textbook:validate --prefix backend
```

Prepare reports changed source hashes and existing objective IDs. Author or refresh
objectives against the actual source before using --write; that option computes
catalog revisions and regenerates README reading views, but does not repair stale
source hashes or invent goals. Validation rejects duplicate IDs, missing chapters,
phantom headings, stale hashes, prerequisite cycles and later-chapter prerequisites.
Unknown required external background must be resolved during authoring.

## Publication and runtime freezing

Use the explicit-target `math:sync` commands in [the math guide](math-category.md).
Dry-run reads and reports only, without writes or LLM calls. Sync validates all local
books before writes and creates immutable content-addressed documents:

- `math_chapter_versions/{versionId}`: chapter Markdown, at most 250KB.
- `math_curriculum_versions/{revision}`: catalog metadata and source hashes.
- `math_curriculum_versions/{revision}/objectives/{id}`: objectives, at most 64KB each.
- `math_publications/{publicationId}`: complete frozen book/catalog/profile references,
  with an 800KB publication limit.
- `math_prompt_versions/{promptVersion}`: immutable English prompt/policy/anchor assets,
  archived before creating a v2 session so later code updates preserve its instructions.
- `math_books/{bookId}`: current publication pointer and display metadata.

Every existing immutable document must match exactly. After all referenced writes
succeed, publication is marked complete; a transaction compares the previous book
revision before switching its pointer. A failed or concurrent publication leaves the
previous pointer usable. Retry verifies partial documents. V2 publication refuses
retained chapters lacking a corresponding manifest/catalog entry; missing entries
are never silently deleted. Legacy publication retains omitted chapters.

New tests freeze publicationId, curriculumRevision, difficultyPolicyVersion,
promptVersion and modelSelections. Creation validates the complete publication and
source hashes. Generation, grading, resume and history use that frozen book rather
than the current pointer. Missing/inconsistent catalog or source versions return
409; there is no generic-knowledge fallback. Prompt assets are shipped in dist with
a content hash and archived immutably in Firestore on v2 creation. Runtime loads the
version fixed by the test, including its difficulty rules, anchors and subject guidance.
Missing/corrupt archived assets fail explicitly rather than switching instructions. No old publication or session garbage collection runs.

Deployment and publication are distinct. `./deploy.sh` ships code and prompt assets;
it does not publish textbooks. No --prompts config upload or bulk session migration
is required. To roll back a publication, use a transaction that checks the current
book revision and points to the book snapshot in a previous complete publication;
never alter a session's frozen references or immutable documents.

## Planning and assessment

V2 requests send assessmentVersion=2, selected chapters, difficulty and optional
taskKinds. Defaults are prove 40 / determine 25 / compute 20 / derive 15, normalized
to each objective's supported tasks. Ability (concept/application/reasoning/modeling),
task kind and responseFormat=written are separate. Proofs, justified determinations,
exact objects (including symbolic expressions/matrices/sets) and derived expressions
are supported; explanation or definition recall alone is prohibited.

The server balances chapter exposure and samples unseen/review/practice slots with
weights 50/30/20. Empty slots normalize over available slots. Recent objectives are
avoided when alternatives exist. Partial/incorrect reviews wait for three intervening
questions or another session; one-objective scopes may offer distinct ordinary
practice. If all objectives in a multi-objective scope are still in the review
interval, selection returns 422; expand the scope or start a new test. The selected objective, task, seed and any infeasible replacement are saved
before generation under the session and its plans subcollection. Retries reuse plans.
An infeasible candidate may be replaced once while preserving the user's settings;
exhausted candidates return 422 MATH_NO_FEASIBLE_OBJECTIVE.

English prompt assets in `backend/src/math-prompts/` provide assessment-v1 difficulty
rules, six revised anchors and subject guidance. Easy supplies a method/scaffolding;
standard requires method selection and connections; hard requires strategy, cases,
generalization or assumption analysis. Arithmetic length is a separate load. Anchors
are calibration examples, never additional source facts, and are not empirically
calibrated. Physics preserves units, conditions and approximation limits; economics
preserves model assumptions and never invents current statistics.

Generation selects server-issued source reference IDs, which resolve to exact frozen
headings; invented IDs are rejected. Each candidate passes G (generation and machine
schema/ID/reference checks), V1
(blind independent solving without candidate solution or rubric), then V2 (structured
comparison checking well-posedness, correctness, scope, objective, difficulty, task
kind and rubric). Specific English repair issues feed one regeneration. Unresolved
checks, invalid JSON and duplicate output never admit unverified questions. Optional typed rational arithmetic trees are checked exactly using bounded BigInt
fractions; invalid calculations and zero denominators are rejected without eval. V2
still verifies that the typed parameters represent the actual task; sampled values
never establish a general proof. Existing
180-second request cancellation and four-minute fenced leases remain; stage calls
are capped at 60 seconds and late regenerations are not started. The complete prompt,
including sources, goals, policy, schema, history and validation output, stays within
200KB. Nothing is silently truncated to admit a larger scope. This is model-assisted
verification, not a mathematical correctness guarantee.

Grading returns exactly one met/partial/unmet result, answer evidence and feedback
per rubric ID. The server normalizes positive weights and computes the weighted
score (1/0.5/0); all met is correct, all unmet incorrect, otherwise partial. Alternative
proofs and equivalent expressions are permitted; domains, units and approximation
tolerances must also agree. Invalid/missing/duplicate rubric IDs fail grading, never
becoming an incorrect answer. Public serializers omit rubrics, demand reasoning,
plans and internal call metrics. Example solutions remain available before submission.

## Evidence, assistance and compatibility

`math_tests/{id}/objectiveProgress/{objectiveId}` stores session practice records;
`math_learning_evidence/{bookId}/objectives/{objectiveId}` stores shared workspace
evidence. Both update transactionally with operation receipts. Generation increments
presented once; successful grading increments submitted and verdict once. Skip adds
unsubmitted evidence, never incorrect evidence. Failures and retries do not add
presentations or submissions. Only the primary objective receives credit. Shared
records are practice history, not individual mastery certification; supersedes does
not automatically transfer achievement. Selected difficulty never changes implicitly.

`POST /tests/:id/assistance` serializes solution_view with other mutations and records
viewed status. Other v2 questions use notReported; legacy data is unknown. Since the
solution is already in the response, notReported does not prove no assistance occurred.
The UI retains unsaved answer text when recording a solution view.
`GET /tests/:id/objectives` exposes this session's records.

Legacy kinds map definition→determine, calculation→compute, proof→prove when the
book has v2 publication. Mixing v2 settings and kinds is rejected. Legacy-only books
keep v1 creation; explicit v2 requests return 422. Stored v1 questions remain unchanged
and receive no invented objective mappings; their continuation prompts also prohibit
explanation-only tasks. Fixed and continuous sessions, feedback until Next, unsubmitted
drafts, paginated history, idempotent receipts and source freezing remain compatible.

## Verification and live evaluation

Run repository checks plus textbook:validate, test:math, test:math:emulator and
frontend browser `math.pw.ts`. Emulator tests require explicit project, database and
host and clean only isolated fixture documents. Browser tests cover v1 and v2 flows.

Live evaluation is explicit and uses paid real model calls:

```bash
npm run math:evaluate --prefix backend -- --target=production
npm run math:evaluate --prefix backend -- --target=production --full
npm run math:evaluate --prefix backend -- --target=production --all-chapters
npm run math:evaluate --prefix backend -- --target=production --exercise-skip
```

`math:evaluate:subjects -- --target=emulator|production` evaluates the isolated
physics/economics source fixtures without publishing those books.

The first command exercises one question. --exercise-skip adds two generated
questions to check assistance, unsubmitted draft preservation and skip receipts.
--all-chapters checks one standard task
per chapter. --full evaluates 9 chapters × 3 difficulties
× 2 questions, cycling all four task kinds, grading the reference solution and testing
pause/resume and receipts. It records stage time, input bytes, token counts, regeneration,
model, rubric grade and estimated configured token cost. Costs with missing/zero model
rates are not a reliable billing estimate. Raw questions/solutions stay in ignored
backend/data; general logs contain only case IDs and aggregate outcomes. Evidence is
isolated under a server-owned run namespace and test/evidence documents are cleaned.
Model approval and reference-solution grading do not substitute for independent human
mathematical review; report quality findings and limitations in the release record.

Release evidence is recorded in [the verification record](math-assessment-verification-2026-10-29.md).
