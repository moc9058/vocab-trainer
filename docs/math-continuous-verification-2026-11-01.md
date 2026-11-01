# Multi-textbook continuous study verification (2026-11-01)

Implemented multi-book chapter scopes, equal book turns, question-owned frozen
source context, in-test scope edits, durable reveal-first study and optional AI
grading in the menu. Removed fixed-count creation and batch generation. Old fixed
sessions migrate on access, preserving answers/current questions and all completed
history while dropping unstarted future questions. Original parents are archived.
No textbook publication, configuration upload or bulk production migration is needed.

## Local verification

- Backend build and frontend TypeScript checking passed.
- Backend unit tests: 137 passed; math model tests: 7 passed; mixed regressions: 4 passed.
- Frontend unit tests: 118 passed; production build passed (existing bundle-size warning).
- Firestore emulator: 15 integration tests passed. Isolated fixtures exercise repeated
  chapter/objective IDs across books, balanced book turns, scope/version pins,
  old-question grading after removing its book, empty/duplicate/incompatible scope
  rejection, idempotent reveal, generation/grading retry, stale tabs, expired-worker
  fencing, lazy migration, completed-history preservation and bounded paginated storage.
- Playwright math browser tests: 9 passed. Covers multi-book selection, one primary
  action, durable solution on reload, optional draft/grading, scope changes, ambiguous
  response recovery, version conflicts, saved pause/resume, generation retries,
  chapter-preview safety, mobile overflow and missing-session handling.
- Docker Compose rebuilt backend/frontend against the local Firestore emulator.
  Backend health, frontend `/math` and proxied `/api/math/books` returned HTTP 200.
- `git diff --check` passed.

The browser cases use API mocks; integration cases use mocked models and isolated
emulator fixtures. They validate behavior, not mathematical correctness. Live-model
approval is not a substitute for independent mathematical review.

## Live smoke and release

`backend/scripts/smoke-math-continuous.ts --target=production|emulator` explicitly
runs paid live-model checks through Fastify injection against current source routes.
It creates only its own session and isolated evidence namespace, generates two
questions with a chapter-scope edit between them, checks reveal replay, pause/resume,
zero graded submissions and finish, then removes its session/evidence. It does not
exercise deployed HTTP authentication or publish textbook data. Use via `npx tsx`
from `backend` with explicit target and database settings as in the assessment guide.

Production-backed live smoke passed: two independently checked questions, two
reveals, zero submitted answers, scope revision 1, pause/resume and finish.
The production catalog contained one book, so live checks changed chapters within
that book; multi-book distribution is covered by emulator/browser fixtures.
The script verified removal of its session and isolated evidence after completion.
Publication: `1ac8c79db45a1d20fa76242d7418f2401b4a3e700df6f5deb9a8d6d6ae3d021a`.

Implementation commit `288ab4a` was pushed to `origin/master`. `./deploy.sh`
completed without configuration-upload flags. Backend revision
`vocab-trainer-backend-00537-qrz` and frontend revision
`vocab-trainer-frontend-00519-89p` serve 100% of traffic.
Post-deploy HTTPS checks returned health 200, `/math` 200 and unauthenticated
`/api/math/books` 401. The deployed frontend asset contains the new reveal and
scope controls. Authenticated production browser interaction was not exercised;
local browser checks and production-backed injected-route smoke are separate checks.
No textbook data was published by this release.
