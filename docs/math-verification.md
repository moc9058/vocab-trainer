# Mathematics implementation verification

Date: 2026-10-28 (Japan time).

## Local checks

- Backend build and CLI TypeScript checks passed.
- Existing backend unit suite: 117 passed; mixed API suite: 4 passed;
  import API suite: 9 passed, including Node 24 container runs.
- Mathematics pure/compiler/authoring suite: 17 passed on the host, including
  local rendering and a loopback-only mocked vision endpoint using an original PDF.
  The Node 24 build container runs the same logic suite, skipping only its optional
  local Poppler integration when Poppler is absent.
- Isolated `demo-vocab-math` emulator suite: 13 passed, including repeated approval
  of unchanged content, atomic catalog changes/rollback, stale dispatches,
  late-worker cancellation, persisted budgets and idempotent answers/grades.
- Frontend TypeScript, production build and 121 unit tests passed.
- Mathematics browser suite: 4 passed. Existing language availability and session
  review browser regressions: 18 passed.
- Docker Compose smoke passed: built frontend assets, catalog and Linear Algebra
  scope API, and refusal of cookie/unauthenticated internal worker calls. The local
  emulator has no auth config; production auth remains separately tested.
- iOS production asset build and Capacitor sync passed. No iPhone installation or
  physical-device interaction was performed.

## Material boundary

Verification reads `textbook/Linear Algebra/1. Vector Spaces.md`, without editing
any textbook original. The verification catalog contains one learning unit, three
concepts and one objective about the subspace criterion. It records the actual
Markdown heading hierarchy. No PDF page, book edition, Part or missing chapter is
invented. `textbook/Engineering Math/` remains outside the changes.

The synthetic PDF fixture is independently authored and used only to check local
adapter preparation/checkpoint behavior. Actual textbook PDF OCR and real local
OCR model quality were not tested. All nine Linear Algebra chapters are not being
claimed as extracted, approved or published.

## Cloud preparation and execution

The independent mathematics Cloud Tasks queue, OIDC service account and one-minute
reconciliation scheduler were configured in `vocab-trainer-490014`, region
`asia-northeast1`. The eight additive composite indexes reached READY. Field
exemptions were added without replacing existing index definitions. No vocabulary,
grammar, A/B or production auth configuration was rewritten.

Code push, Cloud Run release, the small catalog publication and real-model cloud
verification are distinct operations. Their final results are recorded below once
execution completes. Cloud verification tests are labelled and excluded from valid
learning evidence; they do not establish learner mastery.

The first cloud generation attempt exposed an API schema compatibility error:
Zod emitted `oneOf` for a discriminated union. The generator now uses the
equivalent mutually exclusive status branches under supported `anyOf`; a real
model schema probe accepted that form. Regression tests cover this serialization.
Grade excerpts are grounded to unique exact answer substrings by the server;
unverifiable evidence stays in `needs_review`, outside confirmed score/evidence.

Real-model generation also exposed ambiguity in the context pack’s knowledge
roles. The pack now sends the server-assigned role for every allowed concept and
requires copying it. The strict role/scope/citation gates remain in place. A direct
real-model generation, independent solve and comparison passed with this context.
New jobs freeze prompt version `math-2`; obsolete generation jobs fail explicitly
and the UI offers a new scope preview rather than retrying an unsupported version.

Final scope regressions also cover target-aware OR branch selection without
retaining an unchosen baseline closure, concept-revision-bound foundation consent,
and subject-scoped loading of foreign prerequisites and foundations. Grading uses
the immutable knowledge policy and returns only server-resolved feedback citations.
