# Textbook assessment verification — 2026-10-29

This record covers the implemented curriculum v2 release described in
[textbook assessment](textbook-assessment.md). The original implementation plan
was removed after its contracts were moved into code and the maintained guide.

## Automated and local checks

- Backend TypeScript build, 135 unit tests, 7 math LLM contract tests and 4 mixed-quiz
  regression tests passed.
- Nine emulator tests passed against explicit project `vocab-trainer-490014`,
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

The complete release evaluation and production publication/smoke outcomes are appended
below after their commands finish. Model verification does not provide formal proof
or empirical difficulty calibration. Reference-solution grading tests internal consistency;
independent inspection of admitted questions remains necessary.
