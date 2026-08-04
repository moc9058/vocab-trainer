# Group A/B CRUD audit & hardening — 2026-08-01

An audit of the Group A/B CRUD paths (word + grammar), the word CRUD's behavior when a
request dies mid-sequence (network drop, instance shutdown, LLM failure), and the
English-specific word paths. Everything below was verified against the code before fixing;
line numbers are as found, pre-fix. Companion to `docs/word-grammar-crud.md` (the
2026-07-29 storage-model/CRUD verification, whose F1/F6 this work closes).

Group CRUD is language-agnostic — there is no Chinese-specific logic anywhere in the group
functions — so every fix here applies to the Chinese Group A/B flows directly. The
English-specific issues are the C-series.

## A. Group A/B CRUD (backend)

| # | Finding (pre-fix) | Fix |
|---|---|---|
| A1 | `deleteWord` (`firestore.ts:471`) / `deleteGrammarItem` (`:1664`) never removed the id from `word_groups.wordIds` / `grammar_groups.grammarIds`; `deleteWord` also left `flagged_words/{lang}_{id}` and `progress/{lang}_{id}` behind. Member counts (rendered from `wordIds.length` in five components) drifted upward forever. | Both deletes now query `array-contains` and strip membership with `FieldValue.arrayRemove` **in the same batch** as the doc delete; `deleteWord`'s final batch also deletes the index/flag/progress docs (deletes of missing docs are no-ops). `deleteWordIfOrphaned` inherits the full cascade. Backlog: `scripts/sweep-dangling-group-members.ts`. |
| A2 | `removeWordsFromOtherCategoryAGroups` / `removeWordFromCategoryBGroups` / `removeGrammarFromCategoryBGroups` wrote a **whole recomputed array from a stale read** — a concurrent add to the same group was silently erased (lost update, strictly worse than the documented two-groups race). | Write op is now `FieldValue.arrayRemove(...)`; the stale read only *selects* affected groups, where staleness is harmless (removing a non-member is a no-op). Call structure and the outside-the-transaction placement are unchanged — see Decision 3. |
| A3 | vocab's rename/member-modify wrapped everything in `catch → 404` (a post-commit cleanup failure was reported as "Group not found" **after the add had committed**); grammar's rename/member-modify had no catch at all (missing group → 500). | Typed `GroupNotFoundError` from the transactions → 404; unexpected errors are logged and return 500 with an honest message; both sides now behave identically. |
| A4 | Grammar group names were stored untrimmed with no minLength — and Group B sets are **name-joined** across `word_groups`+`grammar_groups`, so one trailing space silently split a B set into two half-sets. Vocab accepted whitespace-only names (`"  "` passed `minLength:1`, then trimmed to `""`). | `minLength: 1` + trim + post-trim blank check (400) on both sides. |
| A5 | No route verified that `:groupId` belongs to `:language` — `DELETE /api/vocab/english/groups/<chinese-group-id>` deleted the Chinese group. | Rename/delete/member routes pre-fetch the group and 404 on a language mismatch. Side effect: deleting a nonexistent group is now 404, not a silent 204. |
| A6 | `createWordGroup` assigned `order = existingGroups.length`, which collides after any delete (orders 0,1,2 → delete the middle → next create also got 2). | `order = max(existing orders) + 1` — **superseded the same day** by `min(existing) - 1`, once `order` became a priority and a new group had to land at the TOP; both forms fix the collision, see the follow-up below. |
| A7 | No duplicate-name protection anywhere. For B this is lossy: `loadGroupBGroups` merges by name into a `Map`, so the losing duplicate's members vanish from the study set. | **Category-B create is idempotent by (language, trimmed name)** on both routes — an existing match (oldest `createdAt`, deterministic) is returned with 200 instead of creating. See Decision 1. |

## B. Interruption / async consistency

### Backend

| # | Finding (pre-fix) | Fix |
|---|---|---|
| B1 | `addWord` = 3 unbatched writes. A crash between the word doc and `word_index` left a ghost word invisible to `check-terms` → the user re-added → duplicate doc. | Word doc + index entry commit in one batch; `updateLanguageMeta` (derived) stays after. |
| B2 | `addExampleSentence` = doc + sha256 dedup index, unbatched. A lost index write permanently broke dedup for that sentence — undetectable by any validator, since both resulting docs stay legitimately referenced. | One batch (mirrors `addGrammar`). |
| B3 | `deleteWord`'s word-doc delete and `word_index` delete were separate awaits — the exact ghost-entry mode `sweep-orphaned-word-index.ts` exists to repair. | Covered by the A1 batch; the doc/index pair is pinned to the final batch and can never be split by chunking. |
| B4 | `updateWord`'s index rename: old-entry delete + new-entry set unbatched, and the set was unconditional — renaming onto another word's term silently stole its index entry (the MISLINKED mode). | Batched; a rename refuses to overwrite a LIVE entry owned by another word (`DuplicateTermError` → 409 at the route). Stale/orphaned entries are still overwritten, same semantics as the sweep. |
| B5 | The PUT's Chinese re-segmentation (`segmentBatch`/`fillSegmentPinyin`) ran un-caught AFTER example docs/indexes/`appearsInIds` were written — an LLM failure 500'd mid-write and the word doc never updated, stranding orphaned examples. | Both LLM calls are caught and logged; the PUT proceeds without re-segmentation (old segments kept; `backfill-missing-segments.ts` covers new sentences). Same philosophy as grammar's `resolveTransliteration`. |
| B6 | `linkWordToExistingExamples` is fire-and-forget after smart-add's 201 — a Cloud Run shutdown can lose the run. | **Left as-is by design** (the 201 must not wait on a full collection scan). Self-repairs via `POST /:language/sync-segment-links` or `scripts/backfill-word-appears-in.ts`. |

### Frontend

| # | Finding (pre-fix) | Fix |
|---|---|---|
| B7 | The word/grammar queues treated ANY failure as a failed create: smart-add succeeding and the group attach failing produced a **rescue draft for a word already in the DB** (a guaranteed future duplicate), and a draft-originated item whose attach failed dead-ended forever (retry → 409 → no rescue, no group path, draft never retired). | `PostCreateError` carries the created id through the catch: no draft rescue, the term still counts as succeeded for the chips ("in the DB" is true), and `onSettled` gets `{ok:false, …, wordId/grammarId}`. The word queue adds a **draft-scoped 409 recovery** (`checkTerms` → group work → draft delete). Manual/chip adds keep the honest 409 — their hand-typed definitions were not saved. |
| B8 | `loadGroupBGroups` swallowed each side's read failure into `[]` — `resolveGroupBTargets` then **created** duplicate-named B groups it merely failed to see. | Read failures reject; the importer's `groupBIdsFor` already turns that into a visible, retryable registration failure. `GroupBUnifiedSelect` now shows the load error instead of rendering "no groups yet". |
| B9 | `createGroupBGroup` fired both halves via `Promise.all` with no dedup — a retry after a half-failure duplicated the surviving side (the inline picker only checked its stale in-memory list). | Re-reads the server and creates only the missing halves, sequentially; combined with A7's server-side idempotency, retries heal instead of duplicate. |
| B10 | `GroupPickerModal`'s add/create/rename/delete were `try…finally` with **no catch** — failures were unhandled rejections with zero UI. Create-then-add lost the created group from local state when the member-add failed, so a retry created a second same-named group. | All four handlers report into an `actionError` line; the created group is reflected locally **before** the member-add, so the retry goes down the plain add path. |
| B11 | The quiz's "remove from Group B" (button and "3" key) was fire-and-forget with a swallowed catch and showed the ✓ receipt regardless — a failed removal looked done while the server kept the item in B. | Awaited, success-only badge, busy state, error line (`removeFromGroupBFailed` i18n key), error cleared on card advance. |
| B12 | `useImportSession.groupBIdsFor`'s cache was keyed by names only and survived language switches — a same-named B set in another language reused the wrong group ids. | The key now includes the language (NUL-joined, matching the existing joiner). |

## C. English word CRUD

| # | Finding (pre-fix) | Fix |
|---|---|---|
| C1 | `PUT /:language/:wordId` had no body schema — client-sent `language`/`appearsInIds`/`exampleIds`/`id` flowed straight into `words.doc().update()`. | Whitelist schema with `additionalProperties: false`; Fastify's default AJV (`removeAdditional`) strips rather than 400s, so existing clients are unaffected. |
| C2 | For non-Chinese words the raw LLM `segments` array passed through unvalidated, got `seg.id` stamped, and created `appearsInIds` links no non-Chinese code path maintains. | Smart-add drops `segments` from every example when the word is not Chinese (covers LLM output and client-sent strays alike). |
| C3 | The own-language strip could leave an English word with `definitions: [{partOfSpeech:"", text:{}}]` (the `{en:""}` fallback minus `en`). | The strip keeps the own-language gloss when it is all the definition has — `text: {}` can no longer be produced. |

## Decisions

1. **Category-B-only idempotent create** (user-approved). A B name *is* the set's identity
   (the cross-domain join key), so same-name creation must converge on one document per
   side. Category A stays create-always: its identity is the id, and silently merging two
   intentionally same-named lessons would be wrong. Pre-existing duplicate-named B groups
   are *reported* by the sweep (WARN), not merged — merging moves members and is a manual
   decision.
2. **Post-create failure settles `ok:false` with the entity id.** Not `ok:true`+warning: the
   caller's actual intent (group membership; draft retirement) did not complete, and
   `ok:true` would mark importer rows `registered` — inflating the progress counter and
   locking the row (`isLocked`) out of retry. The id still propagates (row + siblings), so
   the retry press takes the idempotent group-add path. The queue's 409 recovery is
   restricted to draft items; the importer keeps its own (its rows carry no `draftId`, so
   the two never interact).
3. **A post-commit A-move failure logs and returns success.** The add is already committed
   when `removeWordsFromOtherCategoryAGroups` runs, so a thrown error would make the client
   retry (or distrust) a write that landed. The leftover state — one word in two A groups —
   is the documented self-healing state: the next add repairs it, and
   `scripts/dedupe-word-group-membership.ts` sweeps in bulk. The move stays OUTSIDE the
   transaction for the documented Firestore reads-before-writes reason; only the write op
   changed (arrayRemove).

## Observed but deliberately unchanged

- **B6** (`linkWordToExistingExamples` fire-and-forget) — see above.
- `deleteGrammarItem` does not cascade `grammar_progress` — pre-existing behavior, harmless
  (progress reads are keyed by live items), left alone to keep this change reviewable.
- `dedupe-word-group-membership.ts` still writes filtered arrays — acceptable for an
  offline, manually-run script; the runtime helpers are the ones that race with live adds.
- The smart-add duplicate check remains TOCTOU (read at request start, write after the LLM
  round-trip); the client-side `createChain` in the importer plus B1's atomic doc+index
  write bound the damage (no more ghost words), and `sweep-orphaned-word-index.ts` remains
  the repair.

## Maintenance

```bash
# One-off repair of ids stranded by pre-fix deletes (dry-run first):
cd backend && npx tsx scripts/sweep-dangling-group-members.ts --dry-run
cd backend && npx tsx scripts/sweep-dangling-group-members.ts [--language=<lang>]
```

Also WARNs about duplicate-named category-B groups (report-only). Idempotent; a re-run
reports 0.

## Verification

- `cd backend && npm run build` and `cd frontend && npx tsc --noEmit` — clean.
- Regression sweeps: `scripts/validate-invariant-all.ts` (word↔example invariant is
  untouched by the batching), `scripts/sweep-orphaned-word-index.ts --all --dry-run`
  (new orphans should stop appearing), `scripts/dedupe-word-group-membership.ts --dry-run`
  (stays 0 — A2 did not disturb A-exclusivity).
- Key manual scenarios: delete a word held in A+B groups (+flag, +progress) and watch the
  counts drop; PUT a word's term onto an existing term → 409; cross-language group
  delete → 404; create the same B name twice → one group per side; kill the network right
  after a queued smart-add resolves → no spurious draft, retry finishes the groups; "3" in
  the Group B quiz while offline → error, no ✓ receipt.

---

## Follow-up (2026-08-01) — group order became a priority

`word_groups.order` was a display order; it is now the category-A **priority**, and the
top A group is simultaneously the default target of every "add a word" flow
(`frontend/src/types.ts:defaultWordGroup`) and the absorb target of the new
`POST /api/vocab/:language/groups/normalize`. Three consequences worth recording here,
since they touch the same invariants this audit covers:

- **A third enforcement point for A-exclusivity.** Alongside `modifyWordGroupMembers`
  (per write) and `scripts/dedupe-word-group-membership.ts` (bulk), the normalize
  endpoint repairs a whole language on demand — and it also closes the "a B item is
  always also in A" hole from the other direction, since a word sitting only in a
  Group B set counts as ungrouped and joins the top A group. The two repair paths pick
  **different survivors**: the script keeps the most recently created group, the
  endpoint keeps the highest-priority one. Prefer the endpoint; the script remains a
  useful independent duplicate *detector*.
- **No dangling-id pruning in the endpoint.** F1 is fixed, so the backlog belongs to
  `scripts/sweep-dangling-group-members.ts`. A dangling id cannot corrupt the result:
  the ungrouped set is computed as `liveIds - claimed`.
- **Read order is load-bearing.** The routine reads group documents *before* word ids.
  A word created between the two reads then looks ungrouped and merely gains a
  transient duplicate membership, which the next add, a re-run, or the dedupe script
  repairs. Reading words first would invert that into data loss — the same word would
  look like a deleted word's leftover and be stripped from the group it had just been
  added to. Writes are `arrayRemove`/`arrayUnion`, matching the helpers hardened above.

Legacy `order` values encoded the old append behaviour (literally the creation
sequence), which would have handed the default add target to the *oldest* group. One-time
repair: `scripts/reprioritize-word-groups-newest-first.ts`, guarded to skip any language
whose order is not plain creation order.

Verified live against `vocab-trainer-490014` / `vocab-database`: dry run on `chinese`
(1887 words, 1722 grouped, 0 duplicates, 165 ungrouped) left every group byte-identical;
409 on a stale `expectedGroupIds`; a language with no A groups returns 200 with
`topGroup: null`; a seeded duplicate on `english` was resolved to the higher-priority
group with both ungrouped words absorbed, Group B untouched, and a second run reported 0.

---

## Follow-up (2026-08-04) — the remove side of "a B item is always also in A"

The invariant was only ever upheld on the ADD side (every add flow assigns an A group).
The remove side had three holes, all of which stranded Group B memberships: taking a
word out of its category-A group in the editor's group picker, the same remove on a
grammar item, and deleting an A group outright. Closed server-side:

- `firestore.ts:removeOrphanedWordsFromCategoryBGroups` /
  `removeOrphanedGrammarFromCategoryBGroups` strip an item from every B group once it
  belongs to **no** category-A group. The remaining-A-membership re-check (not an
  unconditional strip) keeps a move between A groups inside its B sets, tolerates
  legacy duplicate A memberships, and is the rule that stays correct for grammar's
  legal multi-A membership.
- Called best-effort after the committed write — the `remove` branch of both
  `modify*GroupMembers` and both `delete*Group` functions — mirroring the add branch's
  `removeWordsFromOtherCategoryAGroups` contract (a cleanup failure never fails the
  route).
- **The race direction is worse than the add side's**: losing to a concurrent A-add
  wrongly strips B, and nothing re-adds B on its own. The four client "move" call sites
  (`WordList.handleUpdateWord`, the `useWordQueue`/`useGrammarQueue` update items,
  `GrammarFormModal`'s edit diff) therefore sequence adds strictly before removes
  instead of one `Promise.all`.
- Memberships stranded before this existed are not retro-cleaned;
  `POST /groups/normalize` re-files such words into the top A group (the gentler
  repair, unchanged).

Word/grammar **document** deletion needed nothing: both cascades already removed the id
from every group regardless of category (F1, fixed 2026-08-01).
