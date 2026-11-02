# Retired word categories and review flags

Word definitions now contain only `text` and optional `pinyins`, across every language.
Group A/B membership, grammar descriptions, sentence linguistic analysis and quiz
session reviews are unchanged. Legacy category and flag inputs are ignored.
`/api/flagged` is removed; old frontend `/flagged` bookmarks redirect to Browse.

## Release sequence

1. Run local checks and the emulator regression below.
2. Upload only `config/vocabulary`: from `backend`, run
   `npx tsx scripts/migrate-db-config-to-firestore.ts --vocabulary-only`.
3. Deploy the new backend/frontend with `./deploy.sh` from the repository root.
4. Run the production cleanup dry-run, then apply; keep its local backup.
5. Run dry-run again: all `changed` counts should be zero.

The config change removes word part-of-speech generation. It is backward compatible
with the previous backend. No auth, LLM model, grammar or article prompt upload is needed.
Old clients cannot recreate retired fields after deployment.

## Maintenance commands

From `backend` (production requires Google Application Default Credentials):

```bash
# Explicit emulator target; use an isolated emulator for regression fixtures.
FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx scripts/remove-retired-word-data.ts --target=emulator --dry-run
FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx scripts/remove-retired-word-data.ts --target=emulator --apply

# Production: FIRESTORE_EMULATOR_HOST must be unset, never saved in .env.
npx tsx scripts/remove-retired-word-data.ts --target=production --dry-run
npx tsx scripts/remove-retired-word-data.ts --target=production --apply
```

The default project is `vocab-trainer-490014`, database `vocab-database`; override
with `FIRESTORE_PROJECT` / `FIRESTORE_DATABASE_ID`. Target/environment mismatches
and ambiguous arguments fail before accessing data. Omitting `--apply` is read-only.

Only `words`, `word_drafts`, `quiz_sessions`, `combined_quiz_sessions` and
`flagged_words` are scanned. Word definitions lose category fields, legacy top-level
category/flag fields and session flag settings are removed, and flag records are
deleted. Session questions retain order, IDs, answers, retries, score, group scope
and review state. Grammar questions retain their descriptions. Existing scopes of
previously flag-limited quizzes remain fixed; resume never broadens them solely
because the flag setting disappeared. Archive collections and local historical JSON
sources are untouched.

Apply writes typed JSONL backups under ignored `backend/data/retired-word-data/`
with private file permissions. Each entry contains the document path, update time
and full original data. Timestamp, geopoint, reference, bytes and date values carry
`$type` tags (`seconds`/`nanoseconds`, `latitude`/`longitude`, `path`, `base64`, `iso`).
Backups are flushed to disk before each batch of at most 200 writes. Updates and
deletes require the original document update time: a concurrent edit fails the
batch rather than overwriting that edit. Rerun the script after resolving a failure;
already-clean documents require no writes. Restoration is an explicit maintenance
operation using the recorded original values; backups must never be committed.

Emulator regression (isolated synthetic project; no LLM or production access):

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 node --experimental-test-module-mocks --import tsx --test scripts/tests/emulator/retired-word-data.test.ts
```
