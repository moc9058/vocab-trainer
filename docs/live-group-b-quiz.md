# Live Group B in the mixed quiz

See [AGENTS.md](../AGENTS.md) for repository working instructions,
[README.md](../README.md#combined-quiz) for the API reference, and
[development-reference.md](development-reference.md) for surrounding architecture.

Group A is the main word/grammar library, including Group B items. Group B is an
additional, contextual grouping. The standalone Group B quiz has been removed;
old `/group-b-quiz` bookmarks redirect to `/mixed-quiz`. Article quizzes are unchanged.

The mixed quiz always reads **all** current category-B word and grammar groups on
start, resume and weight updates. The client cannot restrict B by subgroup, explicit
item IDs, flags or per-subgroup weights. All B subgroups have raw weight 1; the
category A:B and within-category word:grammar ratios remain configurable. Setting a
bucket's weight to 0 continues to exclude new questions from that bucket. Already
pending questions retain the existing behavior of remaining in the tail.

`combined_quiz_sessions/{language}__mixed` now stores `mixedScope.version = 1` and
`wordA` / `grammarA` membership snapshots. These keep the chosen A pool fixed,
including its overlap with B. On resume the server combines that snapshot with
live B membership and checks that the referenced word/grammar documents still exist.

- Newly eligible B items are appended once, then the pending tail is reordered
  with the saved ratios. New B groups are included automatically.
- Answered attempts, scores, review boundaries and pending wrong-answer retries
  are preserved. An already answered item is not added again merely because it
  appears in another B group.
- A pending item removed from B moves to its selected A bucket if it belongs to the
  A snapshot; otherwise it leaves the pending pool. **Exception:** an explicit
  removal from the mixed quiz retains it in `retainedWordA` / `retainedGrammarA`
  for this session, including an unselected A home. Deleted documents leave the
  pending pool. Answered history remains available for review.
- Duplicate A/B membership gets B priority. Totals are recalculated after changes.
- Completed sessions remain historical; they are not reopened by subsequent B additions.

Existing **in-progress** cloud sessions migrate lazily on their first resume after
deployment. Their stored A group selection and original question IDs reconstruct
an A snapshot, and all current B groups replace their old B selection. Existing
`mixWeights` preserve the user's category/domain ratios; older sessions without
those inputs infer ratios from their effective weights. An A/B category with no
recoverable old weight uses a default of 1. No bulk database rewrite or destructive
migration script is needed.

The home-page resume button fetches the session again when opening the quiz, so
it cannot reuse the pool fetched earlier when the home page first loaded.

## Explicit removal, progress and random ordering

The removal control is available before and after reveal in the bottom action bar
on phone/tablet widths, including landscape. Marking it does not write immediately.
Grading sends `startedAt`, a UUID `operationId`, and `removeFromGroupB` with the
answer through the serial outbox. Ending a sitting with a marked, ungraded card
uses `POST /api/mixed-quiz/remove-from-b` with the same identifiers and no grade.

`commitMixedQuizOperation` commits group `arrayRemove` writes, the session, domain
progress, and an operation receipt in one Firestore transaction. Receipts live in
`combined_quiz_sessions/{sessionKey}/operations/{operationId}`. Replaying an operation
cannot grade twice; reusing its ID for different input, or targeting a replaced
session, returns 409. Resume, review-boundary and weight writes also use a session
transaction, so they cannot overwrite a concurrently committed mixed answer.

- Removal + Wrong: defer one retry until a mid-quiz review completes, at its A
  home's weight, even when that home was not selected initially. Unknown/unassigned A homes use the virtual
  `__ungroupedA` bucket, weight 1; no real group is created. A group without a saved
  subgroup weight defaults to 1.
- Removal + Correct: remove all pending copies for this item in this session.
  Answered history remains. A later new session applies normal selection/weights.
- Removal without grading: retain the pending card as A and do not record a grade.
- `wordA` / `grammarA` stay fixed. Optional `retainedWordA` / `retainedGrammarA`
  record the explicit continuation; `wordB` / `grammarB` record live B membership
  for display. `wordAHomes` / `grammarAHomes` let local removal use the authoritative
  A home before the metadata fetch finishes. Old sessions acquire these optional
  fields lazily, without a bulk rewrite.
- The next appearance of a removed item offers only ordinary grading after reveal;
  there is no “Removed from Group B” receipt on the card. Pending/failed writes remain
  visible in the sync badge, with the existing unsynced-answer navigation warning.

A/B progress shows **remaining / total unique items in this session**, separately
for words and grammar. A includes B; B is the currently B-associated subset. Retries
count once, and zero-weight items never admitted to the quiz are excluded. Group
details may overlap (especially grammar) and are not summed to obtain unique totals.

Wrong answers rejoin the ordinary weighted draw only in the next sitting after
End session and review, with no extra wrong-answer boost
or recency rule. Sampling remains exclusive with B priority, and items within a
bucket are uniform. Correct removes the pending slot; Wrong removes it for the
rest of the current sitting. Finishing a mid-quiz review releases at most one retry.
Natural exhaustion completes the test even with Wrong answers; reviewing a completed
test does not reopen it.
Already-correct weighting still applies when configured; Wrong leaves that bucket.
Existing zero-weight pending items survive in a randomized tail. The same item cannot be drawn twice within a sitting. Reordering without grading pins the visible card.
Weight edits wait until the outbox has no pending or unacknowledged failed writes.

## Implementation map

| Responsibility | Source |
| --- | --- |
| Fixed A snapshot, explicit A continuations, live B reconciliation and legacy migration | `backend/src/mixed-quiz-scope.ts` |
| Start/resume/weight-update integration | `backend/src/routes/combined-quiz.ts` |
| Persisted session fields | `backend/src/types.ts`, `backend/src/firestore.ts`, `frontend/src/types.ts` |
| Setup, compact B display and mid-session weights | `frontend/src/components/CombinedQuizFilterModal.tsx`, `CombinedQuizTaking.tsx` |
| Fresh resume fetch and retired-route redirect | `frontend/src/components/Dashboard.tsx` |
| Equal B subgroup inputs in the client fold | `frontend/src/utils/quizGroupScope.ts` |
| Scope regression tests | `backend/src/mixed-quiz-scope.test.ts` |
| Atomic removal/grade and sampling | `backend/src/mixed-operations.ts`, `frontend/src/utils/mixedOperations.ts`, `firestore.ts:commitMixedQuizOperation` |
| API lifecycle regression | `backend/scripts/tests/mixed-quiz-routes.test.ts` |

## Local verification

```bash
cd backend
npm run build
npm test
npm run test:mixed
cd ../frontend
npx tsc --noEmit
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`test:mixed` uses Node's module mocking and Fastify injection with an in-memory
store, plus an atomic Firestore adapter for transaction callbacks. It exercises start → answer → B changes → resume → weight changes → legacy
migration → removals and the completed-session boundary, without cloud access.
The browser suite mounts the production React components with local mocked APIs;
it covers mobile controls, registration retries, lost responses and A/B double clicks.
It makes no cloud or LLM calls. Chromium requires its normal OS libraries.

`test:mixed` requires a Node version supporting `--experimental-test-module-mocks` (the
repository's Node 24 runtime is suitable).

## Deployment from the home PC

Pull `origin/master` on that PC, then use the existing deployment command:

```bash
./deploy.sh vocab-trainer-490014 asia-northeast1
```

For Windows PowerShell:

```powershell
.\deploy.ps1 vocab-trainer-490014 asia-northeast1
```

No config-upload flag or separate database migration is required. This change was
prepared locally; production deployment must be performed from the home PC.
