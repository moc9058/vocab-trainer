# Live Group B in the mixed quiz

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
  A snapshot; otherwise it leaves the pending pool. Deleted documents leave the
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
```

`test:mixed` uses Node's module mocking and Fastify injection with an in-memory
store. It exercises start → answer → B changes → resume → weight changes → legacy
migration → removals and the completed-session boundary, without cloud access.
It requires a Node version supporting `--experimental-test-module-mocks` (the
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
