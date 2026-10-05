# Repository Working Instructions

These instructions apply to the whole repository. Keep shared guidance here;
`CLAUDE.md` points to this file so agents use the same project conventions.

## Project and references

Vocab Trainer is a React 19 / Vite 6 frontend and Fastify 5 / TypeScript backend,
with Firestore storage and Google Cloud Run deployment. The containers use Node 24.
There is no root npm package: install dependencies and run scripts separately in
`backend` and `frontend`.

Read the relevant reference before changing its feature:

- [README.md](README.md): setup, deployment, API and storage overview.
- [Development reference](docs/development-reference.md): detailed architecture,
  queues, auth, imports, storage invariants and maintenance commands.
- [Live Group B quiz](docs/live-group-b-quiz.md): current A+B scope, weights,
  legacy session migration and route tests.
- [Draft JSON format](docs/draft-json-format.md): word/grammar upload contract.
- [Word/grammar CRUD](docs/word-grammar-crud.md) and
  [Group A/B audit](docs/group-ab-crud-audit.md): dated verification reports.
  Their observations are historical; check later fixes and current implementation.

## Local development and data

- Firestore is the source of truth for words and grammar. `backend/DB/word/` is not
  a current data mirror; the old JSON import is not a routine deployment step.
- Use `./local.sh` or `./local.ps1` for the emulator workflow described in README.
  `npm run dev:local` in `backend` targets the emulator. Bare `npm run dev` can
  target production; do not substitute it for emulator development.
- `seed:download` reads production; `seed:load` replaces emulator data. LLM calls
  can still use real APIs when credentials are configured.
- Never persist `FIRESTORE_EMULATOR_HOST` in `.env`: deployment/config upload
  scripts use that file too. Local entrypoints supply the emulator setting.
- Keep secrets, local data snapshots, credentials and build output out of commits.
  Do not print credentials while inspecting configuration.

## Group A/B and quiz invariants

- Group A is the main library, including Group B items. Group B adds contextual
  membership tied to material the user has read or watched; it is not a separate
  copy of an item and is not a synonym for the mastery/progress bucket.
- A missing group `category` means A. Group documents own membership arrays.
  A word belongs to at most one A word group; grammar may belong to several A
  groups. B membership can overlap. Preserve add-before-remove ordering when
  moving items between A groups, so orphan cleanup does not strip their B membership.
- The standalone Group B quiz is removed. Do not restore its button, API registration
  or `groupB` variant. The Group B **article** quiz (`importB`) remains supported.
- Mixed quizzes keep a fixed selected A pool in `mixedScope.wordA` / `grammarA` and
  reconcile all live B groups server-side on start, in-progress resume and weight
  updates. B takes priority for overlapping IDs. Never trust client subgroup filters
  or subgroup weights to define B's scope.
- B subgroup weights are uniformly 1. Category A:B, per-category word:grammar and
  A subgroup weights remain configurable. Zero-weight buckets exclude newly admitted
  questions; existing pending questions follow the tail-preservation behavior.
- Preserve answered attempts, scores, review boundaries and pending retries during
  reconciliation. Remove pending deleted/out-of-scope items; keep a B removal as A
  only when it belongs to the selected A snapshot. Recalculate totals and do not
  reopen completed sessions when B grows.
- Existing in-progress cloud sessions migrate lazily. New session fields must be
  included in the explicit `getCombinedQuizSession` read mapping, not just saved.
  Do not add a bulk production rewrite for this migration.

## Implementation conventions

- Keep backend/frontend API types compatible. Backend ESM imports use `.js` suffixes.
  Route modules are Fastify plugins registered in `backend/src/index.ts`.
- Quiz word payloads hydrate by item ID, never by session position. Reordering and
  live B reconciliation make positional caches unsafe. Grammar hydrates by ID too.
- Mirror grading/retry changes in the server and `frontend/src/utils/quizLocal.ts`.
  Answer and membership writes use the serial `answerOutbox`; preserve their order
  and the local refile behavior when changing mixed quizzes.
- Keep quiz components keyed by variant and refetch mixed sessions when resuming.
  Distinguish a missing session (404) from transport/server errors.
- Session data lives in Firestore; localStorage is for display preferences. Preserve
  the existing warning for unsynced answers rather than silently changing persistence.
- Update UI translations in `frontend/src/i18n/translations.ts` for English, Japanese
  and Korean. Keep study-language names and ISO language codes distinct; see the
  development reference's language-code convention.
- Preserve document/index consistency, group membership cleanup and shared example
  references in CRUD changes. Auth configuration read failures must not disable auth.

## Verification

From the repository root, after dependencies are installed:

```bash
npm run build --prefix backend
npm test --prefix backend
npm run test:mixed --prefix backend
(cd frontend && npx tsc --noEmit)
npm test --prefix frontend
npm run build --prefix frontend
```

Run checks appropriate to the change. For mixed quiz changes, include `test:mixed`:
it uses Fastify injection and Node module mocks without cloud access. Node 24
supports its `--experimental-test-module-mocks` flag. Frontend `build` alone does
not type-check. There is no configured lint command.

For documentation-only changes, verify commands, paths, links and consistency with
source, plus `git diff --check`; application tests need not be rerun. For full-stack
runtime changes, use the local emulator/Docker smoke test when that tooling is
available, and report any verification that could not be performed.

## Delivery and deployment

- Honor the user's current commit/push/deploy scope; these are separate actions.
  A requested push does not imply permission to deploy. Check the branch and working
  tree, preserve unrelated edits, and do not force-push to resolve remote changes.
- The existing production command is
  `./deploy.sh vocab-trainer-490014 asia-northeast1`; Windows uses
  `.\deploy.ps1 vocab-trainer-490014 asia-northeast1`. Both services deploy to Cloud Run.
- Config upload flags (`--llm`, `--auth`, `--prompts`; corresponding PowerShell
  switches) are only for requested config changes. Data maintenance scripts remain
  separate from deployment. The live B quiz change needs no config upload or bulk migration.
- Deployment requires working Docker, gcloud and Google Cloud authentication. If
  the current environment lacks them, complete local checks and state that deployment
  remains pending; do not claim that cloud data was verified or updated.
- Keep README, feature docs and the development reference consistent with behavior.
  Preserve dated audit findings as history rather than rewriting them as current facts.
