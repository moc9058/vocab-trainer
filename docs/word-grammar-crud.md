# Word / Grammar Domain — Technical Reference & CRUD Verification Report

Verified: 2026-07-29 · Backend commit `8e41dd5` · Firestore `vocab-trainer-490014 / vocab-database`

This document is two things at once:

1. a reference for how the Word and Grammar domains are actually stored and mutated (collections, ownership rules, Group A / Group B semantics), and
2. the record of a live end-to-end CRUD verification run against the real database — what was exercised, what passed, and the defects it surfaced.

---

## 1. Method

The backend was started locally against the production Firestore
(`FIRESTORE_PROJECT=vocab-trainer-490014 FIRESTORE_DATABASE_ID=vocab-database`, port 3111) and driven
over HTTP exactly as the frontend drives it. Nothing was stubbed and no emulator was used
(the Firestore emulator is not installed on this machine and there is no JRE).

| Pass | Language | Why |
|---|---|---|
| 1 — full suite (44 checks) | `english` | 4 words, 0 groups at the time — the smallest possible blast radius for a destructive suite |
| 2 — targeted (19 checks) | `chinese` | the language with real data and the Chinese-only code paths (pinyin, segments, hanja readings) |

Assertions were made against **both** the HTTP responses and the raw Firestore documents
(`words.exampleIds` / `appearsInIds`, `example_sentences`, `word_groups`, `grammar_groups`), because
the API deliberately hides some of those fields (see §4.3).

All test artefacts were removed afterwards; §8 is the cleanup record.

---

## 2. Storage model

### 2.1 Collections touched by Word/Grammar CRUD

| Collection | Doc id | Owns | Notes |
|---|---|---|---|
| `words` | `zh-001787`, `en-000019` | the word itself | id allocated by `getNextWordId` inside a Firestore transaction |
| `word_index` | `{language}_{term}` | term → wordId lookup | written on create, deleted on delete |
| `word_groups` | `{language}_{ts}{rand}` | membership via `wordIds[]` | optional `order`, optional `category:"B"` |
| `word_drafts` | server-assigned | pre-registration staging | no LLM at upload |
| `grammar_items` | client-generated `grammar-{language}-{ts}{rand}` | the grammar point | id comes from `GrammarFormModal`, not the server |
| `grammar_groups` | `{language}_{ts}{rand}` | membership via `grammarIds[]` | optional `category:"B"`; **not** reorderable |
| `grammar_drafts` | server-assigned | pre-registration staging | holds raw inline examples |
| `example_sentences` | `exs-zh-003087` | shared sentence pool | referenced by both domains |
| `example_sentence_index` | `{language}_{sha256(sentence)[:16]}` | dedup index | one sentence ⇒ one doc, across domains |

Observed size at verification time: chinese = 1715 words / 3073 examples / 187 grammar items;
english = 4 words / 8 examples / 0 grammar items.

### 2.2 Group membership is owned by the group

Neither `Word` nor `Grammar` carries a `groups` field. A group document holds the member ids, so
"add to group" is always a write to the *group*, never to the item. That is why the item-delete path
has to reach back into the groups — and currently does not (finding **F1**).

### 2.3 Example ownership: `exampleIds` vs `appearsInIds`

A word has two references into `example_sentences`:

- `exampleIds[]` — sentences the word **owns** (its own examples)
- `appearsInIds[]` — every sentence the word **occurs in**, including as a segment of another word's
  example. Enforced invariant: `appearsInIds ⊇ exampleIds` (`firestore.ts:addWord`).

Grammar has the same idea with a different name: `grammar_items.exampleIds[]`, reverse-linked as
`ExampleSentence.appearsInGrammarIds[]`.

Deletion of a sentence is therefore always conditional — `isExampleReferencedByAny()` checks *both*
domains before an example doc is removed. Verified: a sentence dropped from a word's `exampleIds`
survives if that word still appears in it via a segment link (check C2.3), and is deleted once nothing
references it (C2.6 in pass 1's cleanup, and the explicit deletion in §8).

---

## 3. Group A / Group B

`category` is absent for Group A and the literal `"B"` for Group B; absent ⇒ A, so no migration was
ever needed. Verified end-to-end:

| Property | Verified by | Result |
|---|---|---|
| `POST …/groups` with no `category` creates an A group | 2.1 / 6.1 | `category` field absent in the response |
| `POST …/groups {category:"B"}` creates a B group | 3.1 / 6.2 | `category:"B"` |
| An item can be in an A group and a B group simultaneously | 3.2 / 6.3 | both membership arrays contain the id |
| `DELETE …/group-b/members/:id` removes the item from **every** B group and **only** B groups | 3.3–3.4 / 6.6–6.7 | returns just the B group ids; the A group still contains the item |
| That call is idempotent | 3.5 | second call returns `[]` |
| Group A ordering (`PUT …/groups/order`) | 4.1–4.3 | reorders, restores, and rejects an incomplete list with 400 |

The last row matters because the reorder endpoint requires **every** group of the language exactly
once — including hidden Group B groups. `GroupPickerModal` appends the hidden category's ids for
exactly this reason; the 400 in check 4.3 confirms the server enforces it
(`"Group order must contain every group exactly once"`).

**Cross-domain Group B.** A Group B study set spans words *and* grammar but is stored as two
documents joined by name (`frontend/src/utils/groupB.ts`). Both sides are plain category-B group docs,
so everything verified above applies to each side independently.

---

## 4. API surface, as exercised

Every route below was called for real. `frontend/src/api/vocab.ts` and `api/grammar.ts` were diffed
against this list — the frontend uses these paths and no others.

### 4.1 Word

| Method | Path | Verified | Note |
|---|---|---|---|
| POST | `/api/vocab/:language/smart-add` | ✅ 1.1 | **the only create path** — always an LLM call |
| GET | `/api/vocab/:language/:wordId` | ✅ 1.2 | |
| GET | `/api/vocab/:language?search=&groupId=&page=&limit=` | ✅ 1.3, 2.4 | |
| GET | `/api/vocab/:language/lookup?term=` | ✅ 1.4, 7.4 | reads `word_index` |
| POST | `/api/vocab/:language/check-terms` | ✅ 0.1 | filters ghost index entries via `wordEntryIsLive` |
| PUT | `/api/vocab/:language/:wordId` | ✅ 1.5, 1.6, C2.2, C2.5 | example reconciliation lives here |
| DELETE | `/api/vocab/:language/:wordId` | ✅ 7.3, C3.1 | 204; second call 404 |
| GET/POST | `/api/vocab/:language/groups` | ✅ 2.1, 2.2, 3.1 | |
| PUT | `/api/vocab/:language/groups/:groupId` | ✅ 2.5 | rename only |
| PUT | `/api/vocab/:language/groups/order` | ✅ 4.1–4.3 | |
| POST | `/api/vocab/:language/groups/:groupId/words` | ✅ 2.3, 4.4 | `action: add \| remove` |
| DELETE | `/api/vocab/:language/groups/:groupId` | ✅ 7.6 | 204 |
| DELETE | `/api/vocab/:language/group-b/members/:wordId` | ✅ 3.3–3.5 | |

### 4.2 Grammar

| Method | Path | Verified | Note |
|---|---|---|---|
| POST | `/api/grammar/:language/items` | ✅ 5.1, C4.1 | **no LLM** — the client supplies the id |
| POST | `/api/grammar/:language/smart-add` | — | not exercised (LLM enrichment of descriptions) |
| GET | `/api/grammar/:language/items/:grammarId` | ✅ 5.2 | examples hydrated |
| GET | `/api/grammar/:language/items?search=&groupId=` | ✅ 5.3, 6.4 | |
| PUT | `/api/grammar/:language/items/:grammarId` | ✅ 5.4–5.6 | |
| DELETE | `/api/grammar/:language/items/:grammarId` | ✅ 7.1, C4.2 | `{deleted:true}`; second call 404 |
| GET/POST | `/api/grammar/:language/groups` | ✅ 6.1, 6.2 | |
| PUT/DELETE | `/api/grammar/:language/groups/:groupId` | ✅ 6.5, 7.7 | |
| POST | `/api/grammar/:language/groups/:groupId/grammar` | ✅ 6.3, 6.8 | |
| DELETE | `/api/grammar/:language/group-b/members/:grammarId` | ✅ 6.6–6.7 | |

### 4.3 Behaviours worth knowing before writing another test

- **`Word.examples` in a response is `own ⧺ appears-in`.** `hydrateWords` concatenates the two lists
  and *strips* `exampleIds`/`appearsInIds` from the payload. A test that asserts on
  `response.examples.length` after a PUT is asserting on the union, not on ownership — pass 1 got
  this wrong (checks 1.6/1.7) and pass 2 re-verified it correctly against the raw documents.
- **A PUT that omits `examples` keeps the existing ones** (check 5.5); only an explicitly sent array
  reconciles them.
- **PUT with `examples: []` clears ownership, not necessarily the document** (C2.5/C2.6) — see §2.3.
- **Grammar update always reasserts `id` and `language`** from the stored item, so those cannot be
  changed through PUT.

---

## 5. Results

**54 of 63 checks passed.** Of the 9 failures, 3 were faulty assertions in the harness (§4.3) and
6 are the two genuine defects below.

| Area | Checks | Outcome |
|---|---|---|
| Word create / read / update / delete | 12 | pass (2 harness errors, re-verified in pass 2) |
| Word groups — A | 7 | pass |
| Word groups — B | 5 | pass |
| Group ordering | 3 | pass |
| Grammar create / read / update / delete | 8 | pass |
| Grammar groups — A / B | 8 | pass |
| Delete semantics (404s, index purge) | 6 | pass |
| Chinese-specific enrichment | 4 | 3 pass, 1 → **F2** |
| Example ownership (raw-document level) | 6 | pass |
| Group membership after item delete | 4 | **all 4 fail → F1** |

---

## 6. Findings

### F1 — Deleting a word or grammar item leaves a dangling id in every group it belonged to · **Medium**

> **FIXED (2026-08-01)** — `deleteWord` / `deleteGrammarItem` now strip the id from every group
> (plus, for words, the `flagged_words` and `progress` docs) in the same batch as the doc delete,
> and `scripts/sweep-dangling-group-members.ts` repairs ids already stranded. See
> `docs/group-ab-crud-audit.md` (A1). The record below describes the pre-fix behavior.

`firestore.ts:deleteWord` cleans up example sentences, segment back-references and the `word_index`
entry, then deletes the doc. It never touches `word_groups`. `deleteGrammarItem` has the same gap for
`grammar_groups`. Group A and Group B are equally affected.

Evidence — a word in one A group and one B group, then deleted:

```
C3.1  CHINESE word delete -> 204
C3.2  FAIL  A.wordIds=["zh-001787"]      ← word no longer exists
C3.3  FAIL  B.wordIds=["zh-001787"]
C4.3  FAIL  A.grammarIds=["grammar-chinese-crudtest-…"]
C4.4  FAIL  B.grammarIds=["grammar-chinese-crudtest-…"]
```

**Impact is cosmetic and cumulative, not functional.** Every read path resolves ids to documents and
drops the misses, so listings and quiz pools stay correct (verified: C3.4 / C4.5 return
`total=0, items=0`). What is wrong is the **member count**, which is rendered straight from the array
length in five places:

- `WordList.tsx:899`, `GrammarList.tsx:553` — the group selectors
- `QuizFilterModal.tsx:99`, `GrammarFilterModal.tsx:155`, `CombinedQuizFilterModal.tsx:131,396`

A group that has had words deleted from it shows a number larger than the quiz it starts. The dead ids
also accumulate forever, since nothing ever prunes them.

*Fix sketch* — in `deleteWord`, before deleting the doc:

```ts
const groups = await wordGroups.where("language", "==", language)
                               .where("wordIds", "array-contains", wordId).get();
if (!groups.empty) {
  const batch = db.batch();
  for (const g of groups.docs) batch.update(g.ref, { wordIds: FieldValue.arrayRemove(wordId) });
  await batch.commit();
}
```

and the mirror of it in `deleteGrammarItem` over `grammar_groups`/`grammarIds`. A one-off sweep is
needed for ids already stranded in the live groups.

### F2 — The source-language definition is stripped at save time, and the docs say otherwise · **Low**

A Chinese word comes back with definition codes `["en","ja","ko"]` — no `zh`; an English word with
`["ja","ko","zh"]` — no `en`. This is **deliberate**, not LLM drift: `routes/vocab.ts` deletes the key
after the merge.

```ts
// Strip the source language from example translations and definitions:
// a same-language translation/definition is redundant for the word's own language.
if (sourceLangCode) { … delete def.text[sourceLangCode]; }
```

Two consequences:

1. `CLAUDE.md` describes only *example translations* as excluding the source language and states that
   definitions are asked for in all four codes. The prompt does ask for four; only three are stored.
   The line has been amended alongside this report.
2. The stripping arrived in `b7e81ac` (2026-04-08), so the data is **mixed**: words added before that
   date still carry the source-language definition. In a 25-word chinese sample, 58 definitions had all
   four codes and 4 had three. A user whose display languages include the study language sees a
   definition on old words and nothing on new ones.

No action is required if the stripping is intended; if the inconsistency is unwanted, a backfill that
drops the source code from pre-April words would make the corpus uniform.

### F3 — Chinese smart-add exceeds five minutes · **Low (informational)**

Measured on this run: english smart-add **8.6 s**, chinese smart-add **> 303 s** (the client aborted
at its 300 s default; the server had already written the word). The Chinese path chains the main
completion with segment/pinyin filling and per-character hanja lookups.

Cloud Run is deployed with `--timeout=3600` (`deploy.sh:124,150`), so production tolerates it, and
browser `fetch` has no default timeout. The risk is narrower: any intermediary with a 5-minute
default (a Node client, a proxy) aborts *while the write succeeds*. The queue then treats it as a
failure and rescues the input as a draft — a draft for a word that now exists, which will 409 when
registered. Worth keeping in mind before putting a proxy in front of the API.

### F4 — `validate-invariant-all.ts` ignores `FIRESTORE_PROJECT` · **Low (DX)**

Its `new Firestore({...})` sets `databaseId` but not `projectId`, unlike every sibling script in
`backend/scripts/`. Run locally with gcloud pointed elsewhere it fails with a bare gRPC `code: 5`
NOT_FOUND and a 20-line stack. Workaround used here:

```bash
GOOGLE_CLOUD_PROJECT=vocab-trainer-490014 npx tsx scripts/validate-invariant-all.ts --language=chinese
```

One line (`projectId: process.env.FIRESTORE_PROJECT || undefined`) makes it behave like the others.

### F5 — Pre-existing invariant drift in chinese data · **Informational**

The validator (run after cleanup) reports:

```
chinese: words 1715, examples 3073, grammar 187 — violations 4, warnings 0
  - invariant drift: word zh-000764 (精神) extra=[exs-zh-001119]
  - invariant drift: word zh-000785 (以为) extra=[exs-zh-001148, exs-zh-001147]
  - invariant drift: word zh-001020 (千万) extra=[exs-zh-001487]
  - invariant drift: word zh-001729 (无法) extra=[exs-zh-003022]
  orphan words (no references): zh-001463 (千), zh-001501 (春)
english: violations 0; orphan word en-000018 (ostensible)
```

All four reference example ids that predate this verification run, and none of the words were touched
by it. `extra` means `appearsInIds` holds a sentence that neither `exampleIds` nor a segment reference
justifies. The repo already ships the repair path — see the `validate-and-modify-incompleteness`
skill / `backfill-word-appears-in.ts` + `cleanup-dangling-example-refs.ts`.

### F6 — Duplicate group names are accepted · **Low**

> **FIXED for category B (2026-08-01)** — `POST /:language/groups` is now idempotent by
> (language, trimmed name) when `category === "B"` on both the vocab and grammar routes, and
> `createGroupBGroup` re-checks the server before creating either half. Category A deliberately
> stays create-always (two same-named lessons may be intentional; the id is the identity).
> See `docs/group-ab-crud-audit.md` (A7). The record below describes the pre-fix behavior.

`createWordGroup`/`createGrammarGroup` do not check for an existing name. For Group A that is merely
confusing; for Group B it is lossy, because `loadGroupBGroups` merges the two domains **by name** into
a `Map` — a second B group with the same name overwrites the first entry, making one document
unreachable from `GroupBUnifiedSelect` while it keeps its members.

---

## 7. Not covered

Out of scope for this run, and therefore unverified:

- Word/grammar **drafts** CRUD (`/drafts`, `/drafts/:draftId`) and the draft → register promotion flow
- `POST /api/grammar/:language/smart-add` (grammar LLM enrichment)
- The quiz routes (word / grammar / combined / Group B) beyond confirming that a dangling group member
  does not corrupt a pool
- The article importer and import sessions
- Frontend interaction: the queues (`useWordQueue`, `useGrammarQueue`), optimistic UI, chip status.
  Only the API paths those hooks call were checked, statically, against the route table.

---

## 8. Cleanup record

Everything created during verification was removed, and the removal itself was verified:

| Artefact | State |
|---|---|
| `en-000019` (perambulate), `zh-001787` (蟾蜍) | deleted; `word_index` entries return 404 |
| `exs-en-000015/16`, `exs-zh-003085/86/87` | deleted via `deleteExampleSentences` (back-references stripped; 0 lingering `appearsIn` refs; no stale `example_sentence_index` rows) |
| `exs-en-000017` | already orphan-deleted by the grammar delete path |
| Grammar items `grammar-english-crudtest-…`, `grammar-chinese-crudtest-…` | deleted |
| 8 `__crudtest_*` groups (word/grammar × A/B × english/chinese) | deleted; both group lists back to their original contents |
| Word count | back to 1715 (chinese) / 4 (english) |
| Working tree | clean — the harness ran from a scratch directory and its temporary scripts were removed |

The one lasting side effect is `word_groups`/`grammar_groups` **ids**: the counters
(`getNextWordId`, `getNextExampleId`) advanced, so `en-000019`, `zh-001787`, `exs-zh-003085…87` and
`exs-en-000015/16` are burned and will not be reused. That is inherent to a transaction-allocated
counter and harmless.

---

## 9. Reproducing

```bash
# 1. backend against the real database
cd backend && FIRESTORE_PROJECT=vocab-trainer-490014 FIRESTORE_DATABASE_ID=vocab-database \
  PORT=3111 HOST=127.0.0.1 npx tsx src/index.ts

# 2. smallest meaningful smoke test — group B does not touch group A
curl -s -X POST localhost:3111/api/vocab/english/groups -H 'content-type: application/json' -d '{"name":"tmpA"}'
curl -s -X POST localhost:3111/api/vocab/english/groups -H 'content-type: application/json' -d '{"name":"tmpB","category":"B"}'
curl -s -X POST localhost:3111/api/vocab/english/groups/<A>/words -H 'content-type: application/json' -d '{"wordIds":["en-000017"],"action":"add"}'
curl -s -X POST localhost:3111/api/vocab/english/groups/<B>/words -H 'content-type: application/json' -d '{"wordIds":["en-000017"],"action":"add"}'
curl -s -X DELETE localhost:3111/api/vocab/english/group-b/members/en-000017   # -> {"removedFromGroupIds":["<B>"]}
curl -s localhost:3111/api/vocab/english/groups                                 # A still holds the word
curl -s -X DELETE localhost:3111/api/vocab/english/groups/<A>
curl -s -X DELETE localhost:3111/api/vocab/english/groups/<B>

# 3. data-integrity check afterwards
cd backend && GOOGLE_CLOUD_PROJECT=vocab-trainer-490014 npx tsx scripts/validate-invariant-all.ts
```

Word creation cannot be smoke-tested without an LLM call: `smart-add` is the only create path.
Grammar creation can — `POST /:language/items` is LLM-free as long as every example carries a full
`translation` object (an empty one triggers `generateMissingExampleTranslations`).
