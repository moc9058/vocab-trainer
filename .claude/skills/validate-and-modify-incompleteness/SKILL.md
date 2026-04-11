---
name: validate-and-modify-incompleteness
description: Validate the word ↔ example-sentence mapping invariant across all languages and repair any drift (dangling references, missing appearsInIds, orphan words). Runs the full pipeline — smoke tests, read-only validator, backfill, dangling cleanup — and reports before/after state. Invoke whenever the user asks to "validate" or "check" or "fix" word/example completeness, or after schema migrations that touch these collections.
---

# Validate & modify incompleteness (word ↔ example invariant)

## The invariant

For every word `W` in Firestore:

```
W.appearsInIds == W.exampleIds ∪ { exId | example(exId).segments[*].id === W.id }
```

Every word's `appearsInIds` must equal the union of its own `exampleIds` and every example sentence whose segments reference `W.id`. The runtime code in `backend/src/firestore.ts` and `backend/src/routes/vocab.ts` is responsible for maintaining this on every mutation. This skill exists to *verify* that the runtime is doing its job and to *repair* historical drift without writing new code each time.

## When to run

- User asks to "validate", "check", "verify", or "repair" word/example-sentence completeness.
- After any schema migration or backfill that touches `words` or `example_sentences`.
- After deploying firestore.ts or vocab.ts changes that alter how links are maintained.
- As a health check before a major data export.

## Workflow

Always execute these in order. Stop and report if anything fails — never skip the runtime check.

### 1. Runtime smoke test (local helpers)

This test creates an isolated `_smoke_test` language and exercises the invariant-maintaining helpers end-to-end, including a 20-call concurrency stress. It must pass before touching production data — if it fails, runtime code has a regression and repairing the DB would paper over the real bug.

```bash
cd backend && npx tsx scripts/smoke-test-invariant.ts
```

Expected: `=== Results: 46 passed, 0 failed ===`. Any failure → stop and investigate the runtime code.

### 2. Read-only validator (production data)

Deep validator that walks every word and example for every configured language and reports:

- **violations** — real breakage (invariant drift, dangling refs, orphan examples, missing back-refs)
- **warnings** — informational only (e.g. legitimate dedup-shared examples)
- **orphan words** — words with no references at all

```bash
cd backend && npx tsx scripts/validate-invariant-all.ts
```

Exit code is non-zero if any violation exists. If `violations: 0` across all languages, stop — there is nothing to repair.

### 3. Repair, targeted by finding

Match each category of violation to the right repair. Always `--dry-run` first, confirm the preview matches what the validator reported, then run for real.

#### 3a. Missing `appearsInIds` entries (pre-fix `addWord` drift)

Symptom in validator output:
```
invariant drift: word <id> missing=[<exIds>] extra=[]
```

Fix — reconciles `appearsInIds` for one language by unioning own `exampleIds` + segment references:

```bash
cd backend && npx tsx scripts/backfill-word-appears-in.ts --language=<lang> --dry-run
cd backend && npx tsx scripts/backfill-word-appears-in.ts --language=<lang>
```

Repeat per affected language.

#### 3b. Dangling `exampleIds` / `appearsInIds` entries (pre-fix `deleteWord` drift)

Symptom in validator output:
```
dangling exampleIds: word <id> references non-existent example <exId>
dangling appearsInIds: word <id> references non-existent example <exId>
```

Fix — strips every entry pointing at a no-longer-existing example sentence doc:

```bash
cd backend && npx tsx scripts/cleanup-dangling-example-refs.ts --language=<lang> --dry-run
cd backend && npx tsx scripts/cleanup-dangling-example-refs.ts --language=<lang>
```

Repeat per affected language.

#### 3c. Orphan words (optional)

Symptom in validator output:
```
orphan words (no references): <count>
```

These are words whose `exampleIds` AND `appearsInIds` are both empty. They're still addressable via the UI and may be intentional (no example yet). Do NOT delete them automatically — ask the user whether they should be cleaned up or left alone.

#### 3d. Other violations

- `missing back-ref: example <id> has ownerWordId=<word> but word does not include it in exampleIds` — the word's `exampleIds` is stale. Investigate manually; don't blind-repair.
- `orphan example: <id> has ownerWordId=<word> but owner word does not exist` — delete the example if confirmed unreferenced elsewhere, otherwise reparent.
- `dangling segment.id` — a segment references a deleted word. Clear the `id` field on that segment via `updateExampleSentence`.

### 4. Re-validate

Always re-run the read-only validator as the final step. `violations: 0` is the success criterion.

```bash
cd backend && npx tsx scripts/validate-invariant-all.ts
```

## Response template

When reporting results to the user, use this structure:

```
**Runtime helpers:** <N>/<N> smoke-test assertions pass.

**Pre-repair validator:**
- <lang1>: <X> violations, <Y> warnings
- <lang2>: ...

**Repairs executed:**
- <brief list of what you did, with flags>

**Post-repair validator:**
- <lang1>: 0 violations, <Y> warnings
- <lang2>: ...
```

Never omit the before/after validator comparison. Never run a repair without `--dry-run` first. Never touch production data if the runtime smoke test is failing.

## Key files

All paths relative to the project root.

| File | Purpose |
|---|---|
| `backend/src/firestore.ts` | Invariant-maintaining helpers (`addWord`, `updateWord`, `deleteWord`, `reconcileExampleSegmentRefs`, `unlinkWordFromExampleSentence`, `deleteWordIfOrphaned`, `reconcileIncomingSegments`, `droppedSegmentWordIds`) |
| `backend/src/routes/vocab.ts` | Smart-add and PUT handlers that call the helpers + orphan cleanup |
| `backend/scripts/smoke-test-invariant.ts` | Runtime helper test (46 assertions, T1-T11 + concurrency stress T8) |
| `backend/scripts/validate-invariant-all.ts` | Read-only production validator |
| `backend/scripts/backfill-word-appears-in.ts` | Repair: reconcile `appearsInIds` (existing, language-scoped) |
| `backend/scripts/cleanup-dangling-example-refs.ts` | Repair: strip dangling refs from `exampleIds` / `appearsInIds` |

## Rules

1. **Always start with the runtime smoke test.** If it fails, stop. A runtime regression means repairs will drift again.
2. **Never repair without dry-running first.** Compare the preview to what the validator reported. If they don't match, stop and investigate.
3. **`validate-invariant-all.ts` is read-only.** Safe to run any time. Zero writes.
4. **Frontend/backend code changes are out of scope.** This skill only validates and repairs data. If the validator shows new categories of violation that no existing script handles, surface it to the user rather than improvising a fix — runtime code probably needs a new helper.
5. **Dedup-share warnings are not violations.** Two words holding the same `exampleId` with different `ownerWordId` is legitimate. Only surface them if the user asks.
