# Mathematics implementation verification

Date: 2026-10-28 (Japan time).

## Local checks

- Backend build and CLI TypeScript checks passed.
- Existing backend unit suite: 117 passed; mixed API suite: 4 passed;
  import API suite: 9 passed, including Node 24 container runs.
- Mathematics pure/compiler/authoring suite: 17 passed on the host, including
  local rendering and a loopback-only mocked vision endpoint using an original PDF.
  The Node 24 build container passed 16 tests and skipped only its optional
  local Poppler integration because Poppler is absent.
- Isolated `demo-vocab-math` emulator suite: 13 passed, including repeated approval
  of unchanged content, atomic catalog changes/rollback, stale dispatches,
  late-worker cancellation, persisted budgets and idempotent answers/grades.
  All 13 also passed in the Node 24 container.
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

Code commit `c50fb8b` was pushed to `origin/master`. `./deploy.sh` completed
successfully with backend revision `vocab-trainer-backend-00512-862` and frontend
revision `vocab-trainer-frontend-00494-d5w`, both serving 100% of traffic.

The small verification catalog was published separately as
`2e1e2c20ee379a476e9f3ab3a3df9ce367f4d9f9378e4276c3bf74e3dcade63f`.
Cloud verification tests are labelled and excluded from valid learning evidence;
they do not establish learner mastery.

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

## Final cloud result

The real cloud smoke completed successfully (exit 0) on 2026-10-28:

- Verification test: `515ea7b1-a2ba-4dc7-946e-cf8eeea5e4ca`.
- Cloud Tasks delivered generation, independent solve, comparison and grading
  checkpoints to the deployed OIDC-protected Cloud Run worker. All succeeded.
- The revealed model answer was submitted as an explicitly assisted verification
  answer. AI assessment state was `graded`, score `100/100`; this checks the
  pipeline, not learner mastery or general grading accuracy.
- The test completed naturally. Create/answer response-loss replays returned the
  same receipt without duplicate attempts. Public DTOs withheld solution/rubric.
- The stored source hierarchy was available after explicit reveal. Verification
  attempts contributed no valid global learning evidence.
- Public API requests without authentication and worker requests without Google
  OIDC both returned 401; the deployed frontend served `/math` with HTTP 200.

The entry routes were exercised through a local Fastify injection harness against
production Firestore; the asynchronous workers, model calls and persistence ran
on real Google Cloud. This does **not** establish authenticated production-browser
coverage. The opened browser remained at Google login, so that screen test remains
unverified. The four automated mathematics browser tests used controlled fixtures.

The ignored local report is
`backend/data/math-cloud-verification/report.json`. Earlier schema/role failures
remain labelled verification history rather than being rewritten as successes.
The final documentation-only commit does not change the deployed application code.
