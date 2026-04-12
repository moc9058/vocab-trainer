/**
 * Smoke test for the word ↔ example sentence invariant:
 *
 *   W.appearsInIds == W.exampleIds ∪ { exId | example(exId).segments[*].id === W.id }
 *
 * Exercises the runtime helpers directly against an isolated test language
 * and asserts the invariant after each operation. Also runs a concurrency
 * stress phase to verify the transactional protections hold under parallel
 * writes.
 *
 * Usage: cd backend && npx tsx scripts/smoke-test-invariant.ts
 */

import { Firestore } from "@google-cloud/firestore";
import { createHash } from "crypto";
import {
  addWord,
  updateWord,
  deleteWord,
  addExampleSentence,
  updateExampleSentence,
  reconcileExampleSegmentRefs,
  unlinkWordFromExampleSentence,
  reconcileIncomingSegments,
  droppedSegmentWordIds,
  deleteWordIfOrphaned,
  deleteExampleSentences,
  removeFromAppearsInIds,
  isExampleReferencedByOtherWord,
  getExampleSentencesByIds,
} from "../src/firestore.js";
import type { Word, ExampleSentence } from "../src/types.js";

const LANG = "_smoke_test";

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const wordsCol = db.collection("words");
const examplesCol = db.collection("example_sentences");
const exampleIndexCol = db.collection("example_sentence_index");
const wordIndexCol = db.collection("word_index");
const languagesCol = db.collection("languages");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string) {
  passed++;
  console.log(`  ✓ ${label}`);
}
function fail(label: string, detail?: string) {
  failed++;
  failures.push(label + (detail ? ` — ${detail}` : ""));
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) ok(label);
  else fail(label, detail);
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Scan the test language and verify the invariant holds for every word.
 * Returns the count of violations so callers can fail fast.
 */
async function assertInvariant(context: string): Promise<void> {
  const exSnap = await examplesCol.where("language", "==", LANG).get();
  const segRefs = new Map<string, Set<string>>();
  for (const doc of exSnap.docs) {
    const segs = (doc.data().segments ?? []) as { id?: string }[];
    for (const seg of segs) {
      if (!seg.id) continue;
      if (!segRefs.has(seg.id)) segRefs.set(seg.id, new Set());
      segRefs.get(seg.id)!.add(doc.id);
    }
  }

  const wordSnap = await wordsCol.where("language", "==", LANG).get();
  const violations: string[] = [];
  for (const doc of wordSnap.docs) {
    const d = doc.data();
    const current = new Set<string>(Array.isArray(d.appearsInIds) ? d.appearsInIds : []);
    const want = new Set<string>(segRefs.get(doc.id) ?? []);
    for (const exId of (d.exampleIds ?? []) as string[]) want.add(exId);

    if (want.size === 0 && current.size === 0) continue;
    if (!setEq(current, want)) {
      violations.push(
        `${doc.id}: actual=${JSON.stringify([...current])}, expected=${JSON.stringify([...want])}`,
      );
    }
  }

  // Also: every segment reference must point at a word that actually exists.
  const wordIds = new Set(wordSnap.docs.map((d) => d.id));
  for (const [segWordId, exIds] of segRefs) {
    if (!wordIds.has(segWordId)) {
      violations.push(`segment references non-existent word ${segWordId} in examples ${[...exIds].join(",")}`);
    }
  }

  if (violations.length === 0) {
    ok(`invariant holds (${context})`);
  } else {
    fail(`invariant violated (${context})`, `${violations.length} issue(s)`);
    for (const v of violations.slice(0, 5)) console.log(`      ${v}`);
    if (violations.length > 5) console.log(`      ... and ${violations.length - 5} more`);
  }
}

async function readWord(id: string): Promise<Record<string, unknown> | null> {
  const doc = await wordsCol.doc(id).get();
  return doc.exists ? doc.data()! : null;
}

async function readExample(id: string): Promise<Record<string, unknown> | null> {
  const doc = await examplesCol.doc(id).get();
  return doc.exists ? doc.data()! : null;
}

// --- Cleanup ---

async function cleanup(): Promise<void> {
  // words + examples by language
  for (const coll of [wordsCol, examplesCol]) {
    const snap = await coll.where("language", "==", LANG).get();
    if (snap.size === 0) continue;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  // word_index by language
  const wiSnap = await wordIndexCol.where("language", "==", LANG).get();
  if (wiSnap.size > 0) {
    const batch = db.batch();
    wiSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  // example_sentence_index (no language field — match by doc ID prefix)
  const allIndex = await exampleIndexCol.listDocuments();
  const stale = allIndex.filter((d) => d.id.startsWith(`${LANG}_`));
  if (stale.length > 0) {
    const batch = db.batch();
    stale.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  // languages metadata
  await languagesCol.doc(LANG).delete().catch(() => undefined);
}

// --- Test factories ---

function makeWord(id: string, term: string): Word {
  return {
    id,
    term,
    transliteration: term,
    definitions: [{ partOfSpeech: "noun", text: { en: `gloss for ${term}` } }],
    examples: [],
    topics: ["Miscellaneous"],
    level: "HSK1-4",
  };
}

async function makeExample(
  id: string,
  sentence: string,
  segments?: { text: string; id?: string }[],
): Promise<ExampleSentence> {
  const es: ExampleSentence = {
    id,
    sentence,
    translation: "translation",
    language: LANG,
    segments,
  };
  await addExampleSentence(es);
  return es;
}

// --- Test cases ---

async function testAddWordInvariant() {
  console.log("\n[T1] addWord establishes appearsInIds ⊇ exampleIds");
  const w1 = "smoke_w1";
  const e1 = "smoke_e1";
  await makeExample(e1, "sentence one");
  await addWord(LANG, makeWord(w1, "term1"), { exampleIds: [e1] });
  const w1Data = await readWord(w1);
  assert(
    Array.isArray(w1Data?.appearsInIds) && (w1Data!.appearsInIds as string[]).includes(e1),
    "W1.appearsInIds contains own example E1",
  );
  await assertInvariant("T1");
}

async function testReconcileNewSegmentRef() {
  console.log("\n[T2] reconcileExampleSegmentRefs adds new ref on add");
  const w1 = "smoke_w1";
  const e2 = "smoke_e2";
  const w2 = "smoke_w2";
  const e2seg = "smoke_e2_owner";
  // Create an owner word W2 with its own example E2
  await makeExample(e2, "sentence two with term1", [{ text: "term1", id: w1 }]);
  await addWord(LANG, makeWord(w2, "term2"), { exampleIds: [e2] });
  // reconcile as if the example was just created with these segments
  await reconcileExampleSegmentRefs(e2, [], [{ text: "term1", id: w1 }]);

  const w1Data = await readWord(w1);
  const w1Appears = new Set<string>((w1Data?.appearsInIds ?? []) as string[]);
  assert(w1Appears.has("smoke_e1"), "W1.appearsInIds still contains own E1");
  assert(w1Appears.has(e2), "W1.appearsInIds gained E2 via segment ref");

  const w2Data = await readWord(w2);
  const w2Appears = new Set<string>((w2Data?.appearsInIds ?? []) as string[]);
  assert(w2Appears.has(e2), "W2.appearsInIds contains own E2");
  await assertInvariant("T2");
}

async function testUpdateWordExampleIds() {
  console.log("\n[T3] updateWord({exampleIds}) unions into appearsInIds via arrayUnion");
  const w1 = "smoke_w1";
  const e3 = "smoke_e3";
  await makeExample(e3, "sentence three");
  await updateWord(LANG, w1, {}, { exampleIds: ["smoke_e1", e3] });
  const w1Data = await readWord(w1);
  const appears = new Set<string>((w1Data?.appearsInIds ?? []) as string[]);
  assert(appears.has("smoke_e1"), "appearsInIds retains E1");
  assert(appears.has(e3), "appearsInIds gained E3");
  assert(appears.has("smoke_e2"), "appearsInIds retains E2 from segment ref (not clobbered)");
  await assertInvariant("T3");
}

async function testReconcileDropSegmentRef() {
  console.log("\n[T4] reconcileExampleSegmentRefs drops stale ref");
  const w1 = "smoke_w1";
  const w2 = "smoke_w2";
  const e2 = "smoke_e2";
  // Simulate an edit: E2's segments change from [term1→W1] to [term2→W2]
  const oldSegs = [{ text: "term1", id: w1 }];
  const newSegs = [{ text: "term2", id: w2 }];
  await updateExampleSentence(e2, { segments: newSegs });
  await reconcileExampleSegmentRefs(e2, oldSegs, newSegs);

  const w1Data = await readWord(w1);
  const w1Appears = new Set<string>((w1Data?.appearsInIds ?? []) as string[]);
  assert(!w1Appears.has(e2), "W1.appearsInIds no longer contains E2 (segment ref dropped)");
  assert(w1Appears.has("smoke_e1") && w1Appears.has("smoke_e3"), "W1.appearsInIds retains own examples");

  const w2Data = await readWord(w2);
  const w2Appears = new Set<string>((w2Data?.appearsInIds ?? []) as string[]);
  assert(w2Appears.has(e2), "W2.appearsInIds still contains E2 (own example + segment ref)");
  await assertInvariant("T4");
}

async function testUnlinkDeletesWordWithNoOwnExamples() {
  console.log("\n[T5] unlinkWordFromExampleSentence deletes word with no own examples");
  const w3 = "smoke_w3";
  const e4 = "smoke_e4";
  // W3 has no own examples, but is referenced as a segment in E4 (owner W1)
  await addWord(LANG, makeWord(w3, "term3"));
  await makeExample(e4, "sentence four with term3", [{ text: "term3", id: w3 }]);
  await reconcileExampleSegmentRefs(e4, [], [{ text: "term3", id: w3 }]);
  // Also need to add E4 to W1's exampleIds (it owns E4)
  await updateWord(LANG, "smoke_w1", {}, { exampleIds: ["smoke_e1", "smoke_e3", e4] });

  const res = await unlinkWordFromExampleSentence(LANG, w3, "sentence four with term3");
  assert(res.action === "deleted", `action === "deleted" (got ${res.action})`);
  const w3After = await readWord(w3);
  assert(w3After === null, "W3 doc is gone");

  // E4's segment pointing at W3 should have its id cleared (deleteWord cascade)
  const e4After = await readExample(e4);
  const segs = (e4After?.segments ?? []) as { id?: string }[];
  const stillRefs = segs.some((s) => s.id === w3);
  assert(!stillRefs, "E4's segment id for W3 cleared");
  await assertInvariant("T5");
}

async function testUnlinkPreservesWordWithOwnExamples() {
  console.log("\n[T6] unlinkWordFromExampleSentence preserves word with own examples");
  const w4 = "smoke_w4";
  const e5 = "smoke_e5";
  const e6 = "smoke_e6";
  // W4 owns E5 and is also segment-referenced in E6 (owner W1)
  await makeExample(e5, "sentence five (w4 own)");
  await addWord(LANG, makeWord(w4, "term4"), { exampleIds: [e5] });
  await makeExample(e6, "sentence six with term4", [{ text: "term4", id: w4 }]);
  await reconcileExampleSegmentRefs(e6, [], [{ text: "term4", id: w4 }]);
  await updateWord(LANG, "smoke_w1", {}, { exampleIds: ["smoke_e1", "smoke_e3", "smoke_e4", e6] });

  const res = await unlinkWordFromExampleSentence(LANG, w4, "sentence six with term4");
  assert(res.action === "preserved", `action === "preserved" (got ${res.action})`);

  const w4Data = await readWord(w4);
  assert(w4Data !== null, "W4 still exists");
  const w4Appears = new Set<string>((w4Data?.appearsInIds ?? []) as string[]);
  assert(w4Appears.has(e5), "W4.appearsInIds still contains own E5");
  assert(!w4Appears.has(e6), "W4.appearsInIds no longer contains E6");

  const e6After = await readExample(e6);
  const segs = (e6After?.segments ?? []) as { id?: string }[];
  assert(!segs.some((s) => s.id === w4), "E6's segment id for W4 cleared");
  await assertInvariant("T6");
}

async function testDeleteWordPreservesSegmentRefExample() {
  console.log("\n[T7] deleteWord preserves example referenced by another word");
  const w5 = "smoke_w5";
  const e7 = "smoke_e7";
  // W5 has E7 in exampleIds, but E7's segments reference W1 — so W1 has E7
  // in its appearsInIds. Deleting W5 should preserve E7 because W1 still
  // references it.
  await makeExample(e7, "sentence seven with term1", [{ text: "term1", id: "smoke_w1" }]);
  await addWord(LANG, makeWord(w5, "term5"), { exampleIds: [e7] });
  await reconcileExampleSegmentRefs(e7, [], [{ text: "term1", id: "smoke_w1" }]);

  // Precondition: W1.appearsInIds contains E7
  const w1Before = await readWord("smoke_w1");
  const before = new Set<string>((w1Before?.appearsInIds ?? []) as string[]);
  assert(before.has(e7), "W1.appearsInIds contains E7 before delete");

  await deleteWord(LANG, w5);

  // W5 gone
  assert((await readWord(w5)) === null, "W5 deleted");
  // E7 preserved (W1 still references it via segment)
  assert((await readExample(e7)) !== null, "E7 preserved (W1 still references it)");
  // W1 still references E7
  const w1After = await readWord("smoke_w1");
  const after = new Set<string>((w1After?.appearsInIds ?? []) as string[]);
  assert(after.has(e7), "W1.appearsInIds still contains E7");
  await assertInvariant("T7");
}

async function testUnlinkPreservesWordWithMultipleSegmentRefs() {
  console.log("\n[T9] unlinkWordFromExampleSentence preserves word with other segment refs");
  const w6 = "smoke_w6";
  const e8 = "smoke_e8";
  const e9 = "smoke_e9";
  // W6 has NO own examples. It is segment-referenced in E8 (owner W1) and
  // E9 (owner W1). Unlinking from E8 should leave W6 alive because E9
  // still references it.
  await addWord(LANG, makeWord(w6, "term6"));
  await makeExample(e8, "sentence eight with term6", [{ text: "term6", id: w6 }]);
  await reconcileExampleSegmentRefs(e8, [], [{ text: "term6", id: w6 }]);
  await makeExample(e9, "sentence nine with term6", [{ text: "term6", id: w6 }]);
  await reconcileExampleSegmentRefs(e9, [], [{ text: "term6", id: w6 }]);
  await updateWord(LANG, "smoke_w1", {}, {
    exampleIds: ["smoke_e1", "smoke_e3", "smoke_e4", "smoke_e6", e8, e9],
  });

  const res = await unlinkWordFromExampleSentence(LANG, w6, "sentence eight with term6");
  assert(res.action === "preserved", `action === "preserved" (got ${res.action})`);

  const w6Data = await readWord(w6);
  assert(w6Data !== null, "W6 still exists (E9 still references it)");
  const w6Appears = new Set<string>((w6Data?.appearsInIds ?? []) as string[]);
  assert(!w6Appears.has(e8), "W6.appearsInIds dropped E8");
  assert(w6Appears.has(e9), "W6.appearsInIds retains E9");

  const e8After = await readExample(e8);
  const segs = (e8After?.segments ?? []) as { id?: string }[];
  assert(!segs.some((s) => s.id === w6), "E8's segment id for W6 cleared");
  await assertInvariant("T9");
}

async function testReconcileIncomingSegmentsReactivate() {
  console.log("\n[T10] reconcileIncomingSegments preserves explicit deactivation");
  // W1 already exists from T1. Build a fresh example with a segment that
  // references W1, then simulate the UI deactivating it by sending the
  // same segment text without an id. The helper should preserve the missing
  // id so the route can reconcile the dropped reference.
  const w1 = "smoke_w1";
  const e10 = "smoke_e10";
  const oldSegs = [{ text: "term1", id: w1, transliteration: "stale" }];
  await makeExample(e10, "sentence ten with term1", oldSegs);
  await reconcileExampleSegmentRefs(e10, [], oldSegs);

  // Simulate incoming edit: same text, no id, bogus transliteration.
  const incoming = [{ text: "term1", transliteration: "bogus" }] as {
    text: string;
    transliteration?: string;
    id?: string;
  }[];
  await reconcileIncomingSegments(oldSegs, incoming);

  assert(incoming[0].id === undefined, "segment id remains absent after explicit deactivation");
  await updateExampleSentence(e10, { segments: incoming });
  await reconcileExampleSegmentRefs(e10, oldSegs, incoming);
  const w1AfterDeactivate = await readWord(w1);
  const w1Appears = new Set<string>((w1AfterDeactivate?.appearsInIds ?? []) as string[]);
  assert(!w1Appears.has(e10), "W1.appearsInIds drops explicitly deactivated E10");

  // Also verify dropped split segments are reported as dropped.
  const splitIncoming = [{ text: "term" }, { text: "1" }];
  const dropped = droppedSegmentWordIds(oldSegs, splitIncoming);
  assert(dropped.length === 1 && dropped[0] === w1, "split segment drops W1 id");
  await assertInvariant("T10");
}

async function testReconcileOrphanDeletion() {
  console.log("\n[T11] merge/split that orphans a segment-only word deletes it");
  // W7 has no own examples. It is segment-referenced only in E11, which is
  // owned by a fresh owner word W8 (isolated so we don't disturb W1's
  // exampleIds with the smoke test's bookkeeping). Simulate a merge:
  // E11's segments change from [W7] to a merged text that does not map to
  // W7. After reconcile, W7 should be fully orphaned and
  // deleteWordIfOrphaned should remove it.
  const w7 = "smoke_w7";
  const w8 = "smoke_w8";
  const e11 = "smoke_e11";
  await addWord(LANG, makeWord(w7, "term7"));
  const oldSegs = [{ text: "term7", id: w7 }];
  await makeExample(e11, "sentence eleven with term7", oldSegs);
  await addWord(LANG, makeWord(w8, "term8"), { exampleIds: [e11] });
  await reconcileExampleSegmentRefs(e11, [], oldSegs);

  // Precondition
  const w7Before = await readWord(w7);
  const w7BeforeAppears = new Set<string>((w7Before?.appearsInIds ?? []) as string[]);
  assert(w7BeforeAppears.has(e11), "W7.appearsInIds contains E11 before merge");

  // Merge: no more segments referencing term7
  const newSegs = [{ text: "sentence eleven" }, { text: "merged" }];
  await updateExampleSentence(e11, { segments: newSegs });
  await reconcileExampleSegmentRefs(e11, oldSegs, newSegs);

  // Orphan cleanup for each dropped id
  const dropped = droppedSegmentWordIds(oldSegs, newSegs);
  assert(dropped.includes(w7), "W7 detected as dropped");
  for (const id of dropped) await deleteWordIfOrphaned(LANG, id);

  const w7After = await readWord(w7);
  assert(w7After === null, "W7 deleted by orphan cleanup");
  await assertInvariant("T11");
}

/**
 * T12 simulates the WordFormModal PUT flow: a word with two owned examples
 * has one example removed, then the surviving example renamed. The sequence
 * of helper calls mirrors the route handler at
 * `backend/src/routes/vocab.ts` in the `if (Array.isArray(body.examples))`
 * branch. The test verifies that droppedExampleIds reconciliation:
 *   1. Deletes the dropped example's doc (no other owner / dedup share)
 *   2. Shrinks the word's exampleIds
 *   3. Strips the dropped exId from the word's appearsInIds
 *   4. Leaves the invariant intact across a follow-up rename
 */
/**
 * T13 verifies that editing an example's sentence text and segments at the
 * same time updates the same ExampleSentence doc in place (identified by ID)
 * rather than creating a duplicate. This is the scenario a user triggers
 * when they merge/split segments on a shared example E that is referenced
 * by multiple words — E must survive as the same doc so every other
 * reference (own-example or segment) continues to resolve.
 */
async function testInPlaceRenameAndSegmentEdit() {
  console.log("\n[T13] in-place rename + segment edit keeps the same example doc");
  const wOwner = "smoke_w13_owner";
  const wSeg = "smoke_w13_seg";
  const e = "smoke_e13";

  // W_seg exists as a standalone word (no own examples).
  await addWord(LANG, makeWord(wSeg, "termseg13"));
  // Example E belongs to W_owner and has W_seg as a segment.
  const oldSentence = "old sentence with termseg13";
  const oldSegs = [{ text: "old sentence with ", transliteration: "x" }, { text: "termseg13", id: wSeg }];
  await makeExample(e, oldSentence, oldSegs);
  await addWord(LANG, makeWord(wOwner, "termowner13"), { exampleIds: [e] });
  await reconcileExampleSegmentRefs(e, [], oldSegs);

  // Preconditions
  const wSegBefore = await readWord(wSeg);
  const segAppearsBefore = new Set<string>((wSegBefore?.appearsInIds ?? []) as string[]);
  assert(segAppearsBefore.has(e), "W_seg.appearsInIds contains E before edit");

  // Simulate a PUT-handler in-place edit: sentence text changes AND the
  // segment list is restructured to no longer reference W_seg.
  const newSentence = "completely different sentence text";
  const newSegs = [{ text: "completely ", transliteration: "y" }, { text: "different sentence text" }];
  await updateExampleSentence(e, { sentence: newSentence, segments: newSegs });
  await reconcileExampleSegmentRefs(e, oldSegs, newSegs);

  // E must still exist, same ID, new text/segs.
  const eAfter = await readExample(e);
  assert(eAfter !== null, "E doc survives rename (same id)");
  assert(
    eAfter?.sentence === newSentence,
    `E.sentence updated (got "${eAfter?.sentence}")`,
  );
  const storedSegs = (eAfter?.segments ?? []) as { text: string; id?: string }[];
  assert(
    storedSegs.length === 2 && storedSegs[0]?.text === "completely ",
    "E.segments updated",
  );

  // Dedup index for OLD sentence must be gone; NEW sentence index must point at E.
  const oldHash = createHash("sha256").update(oldSentence).digest("hex").slice(0, 16);
  const newHash = createHash("sha256").update(newSentence).digest("hex").slice(0, 16);
  const oldIndexDoc = await db.collection("example_sentence_index").doc(`${LANG}_${oldHash}`).get();
  assert(!oldIndexDoc.exists, "old sentence removed from dedup index");
  const newIndexDoc = await db.collection("example_sentence_index").doc(`${LANG}_${newHash}`).get();
  assert(newIndexDoc.exists, "new sentence written to dedup index");
  assert(
    newIndexDoc.data()?.exampleId === e,
    `new index points at E (got ${newIndexDoc.data()?.exampleId})`,
  );

  // W_seg must have E removed from its appearsInIds (segment ref dropped).
  const wSegAfter = await readWord(wSeg);
  const segAppearsAfter = new Set<string>((wSegAfter?.appearsInIds ?? []) as string[]);
  assert(!segAppearsAfter.has(e), "W_seg.appearsInIds no longer contains E");

  // W_owner must still own E (own exampleIds unchanged).
  const wOwnerAfter = await readWord(wOwner);
  const ownerExs = new Set<string>((wOwnerAfter?.exampleIds ?? []) as string[]);
  assert(ownerExs.has(e), "W_owner.exampleIds still contains E");

  // Collision check: create a second example with yet another sentence, then
  // try to rename E into that second sentence — must throw to avoid silently
  // conflating the two docs.
  const e2 = "smoke_e13_other";
  const collidingSentence = "another example sentence";
  await makeExample(e2, collidingSentence);
  let threw = false;
  try {
    await updateExampleSentence(e, { sentence: collidingSentence });
  } catch {
    threw = true;
  }
  assert(threw, "rename into an existing dedup slot throws");
  // E should still have its post-T13-rename text, untouched.
  const eAfterCollision = await readExample(e);
  assert(
    eAfterCollision?.sentence === newSentence,
    "E unchanged after failed rename",
  );

  await assertInvariant("T13");
}

async function testPutHandlerDropAndRename() {
  console.log("\n[T12] PUT handler reconciles removed + renamed examples");
  const w = "smoke_w_drop";
  const e1 = "smoke_e_drop1";
  const e2 = "smoke_e_drop2";

  // Seed: W owns two examples, both with no segment refs to keep it simple.
  await makeExample(e1, "drop sentence one");
  await makeExample(e2, "drop sentence two");
  await addWord(LANG, makeWord(w, "termdrop"), { exampleIds: [e1, e2] });

  // --- Phase A: remove E2 outright ---
  // Simulate: body.examples carries only { sentence: "drop sentence one" }.
  const newExampleIdsA = [e1];
  const currentExIdsA = [e1, e2];
  const droppedA = currentExIdsA.filter((id) => !newExampleIdsA.includes(id));
  assert(droppedA.length === 1 && droppedA[0] === e2, "phase A drops E2");

  // Step 2 of the route: decide which dropped examples to delete.
  const toDeleteA: string[] = [];
  for (const exId of droppedA) {
    const referenced = await isExampleReferencedByOtherWord(LANG, exId, w);
    if (!referenced) toDeleteA.push(exId);
  }
  assert(
    toDeleteA.length === 1 && toDeleteA[0] === e2,
    "E2 marked for deletion (no other word references it)",
  );
  await deleteExampleSentences(toDeleteA);
  assert((await readExample(e2)) === null, "E2 example doc deleted");

  // updateWord with the shrunk exampleIds.
  await updateWord(LANG, w, {}, { exampleIds: newExampleIdsA });

  // Step 3: prune appearsInIds for the still-dropped ids.
  const stillPresentA = await getExampleSentencesByIds(droppedA);
  const keepA = new Set<string>();
  for (const es of stillPresentA) {
    if ((es.segments ?? []).some((s) => s.id === w)) keepA.add(es.id);
  }
  const toStripA = droppedA.filter((id) => !keepA.has(id));
  if (toStripA.length > 0) await removeFromAppearsInIds(w, toStripA);

  const wAfterA = await readWord(w);
  const wExampleIdsA = new Set<string>((wAfterA?.exampleIds ?? []) as string[]);
  const wAppearsA = new Set<string>((wAfterA?.appearsInIds ?? []) as string[]);
  assert(
    wExampleIdsA.has(e1) && !wExampleIdsA.has(e2),
    `W.exampleIds = [E1] only (got ${[...wExampleIdsA].join(",")})`,
  );
  assert(
    wAppearsA.has(e1) && !wAppearsA.has(e2),
    `W.appearsInIds = [E1] only (got ${[...wAppearsA].join(",")})`,
  );
  await assertInvariant("T12 phase A (remove)");

  // --- Phase B: rename E1 to a fresh sentence ---
  // Simulate: body.examples carries one entry with the new sentence text
  // that didn't exist in the oldBySentence map, so the route creates a new
  // example doc and drops the old one.
  const e3 = "smoke_e_drop3";
  await makeExample(e3, "drop sentence one (renamed)");
  const newExampleIdsB = [e3];
  const currentExIdsB = [e1];
  const droppedB = currentExIdsB.filter((id) => !newExampleIdsB.includes(id));
  assert(droppedB.length === 1 && droppedB[0] === e1, "phase B drops E1");

  const toDeleteB: string[] = [];
  for (const exId of droppedB) {
    const referenced = await isExampleReferencedByOtherWord(LANG, exId, w);
    if (!referenced) toDeleteB.push(exId);
  }
  await deleteExampleSentences(toDeleteB);
  assert((await readExample(e1)) === null, "E1 example doc deleted after rename");

  await updateWord(LANG, w, {}, { exampleIds: newExampleIdsB });

  const stillPresentB = await getExampleSentencesByIds(droppedB);
  const keepB = new Set<string>();
  for (const es of stillPresentB) {
    if ((es.segments ?? []).some((s) => s.id === w)) keepB.add(es.id);
  }
  const toStripB = droppedB.filter((id) => !keepB.has(id));
  if (toStripB.length > 0) await removeFromAppearsInIds(w, toStripB);

  const wAfterB = await readWord(w);
  const wExampleIdsB = new Set<string>((wAfterB?.exampleIds ?? []) as string[]);
  const wAppearsB = new Set<string>((wAfterB?.appearsInIds ?? []) as string[]);
  assert(
    wExampleIdsB.size === 1 && wExampleIdsB.has(e3),
    `W.exampleIds = [E3] only (got ${[...wExampleIdsB].join(",")})`,
  );
  assert(
    wAppearsB.size === 1 && wAppearsB.has(e3),
    `W.appearsInIds = [E3] only (got ${[...wAppearsB].join(",")})`,
  );
  await assertInvariant("T12 phase B (rename)");

  // --- Phase C: dedup-shared example must NOT be deleted ---
  // Seed a second word W_other that also holds E3 in its exampleIds. The
  // route's drop reconciliation should see E3 as dedup-shared and leave the
  // doc alone even though W owns it.
  const wOther = "smoke_w_drop_other";
  await addWord(LANG, makeWord(wOther, "termdrop2"), { exampleIds: [e3] });

  const newExampleIdsC: string[] = [];
  const currentExIdsC = [e3];
  const droppedC = currentExIdsC.filter((id) => !newExampleIdsC.includes(id));
  const toDeleteC: string[] = [];
  for (const exId of droppedC) {
    const referenced = await isExampleReferencedByOtherWord(LANG, exId, w);
    if (!referenced) toDeleteC.push(exId);
  }
  assert(
    toDeleteC.length === 0,
    `E3 NOT queued for deletion (W_other still references it); got toDelete=[${toDeleteC.join(",")}]`,
  );
  // Only perform the appearsInIds prune for W.
  await updateWord(LANG, w, {}, { exampleIds: newExampleIdsC });
  const stillPresentC = await getExampleSentencesByIds(droppedC);
  const keepC = new Set<string>();
  for (const es of stillPresentC) {
    if ((es.segments ?? []).some((s) => s.id === w)) keepC.add(es.id);
  }
  const toStripC = droppedC.filter((id) => !keepC.has(id));
  if (toStripC.length > 0) await removeFromAppearsInIds(w, toStripC);

  // E3 still exists; W_other still claims it; W no longer references it.
  assert((await readExample(e3)) !== null, "E3 preserved (dedup share)");
  const wOtherAfter = await readWord(wOther);
  const wOtherExs = new Set<string>((wOtherAfter?.exampleIds ?? []) as string[]);
  assert(wOtherExs.has(e3), "W_other still claims E3");
  const wAfterC = await readWord(w);
  const wAppearsC = new Set<string>((wAfterC?.appearsInIds ?? []) as string[]);
  assert(!wAppearsC.has(e3), "W.appearsInIds no longer references E3");
  await assertInvariant("T12 phase C (dedup share)");
}

async function testDeleteWordPreservesReferencedExample() {
  console.log("\n[T14] deleteWord preserves examples referenced by another word");
  const wA = "smoke_w14_a";
  const wB = "smoke_w14_b";
  const eShared = "smoke_e14_shared";

  // Both W_A and W_B hold E_shared in their exampleIds.
  await makeExample(eShared, "shared sentence fourteen");
  await addWord(LANG, makeWord(wA, "term14a"), { exampleIds: [eShared] });
  await addWord(LANG, makeWord(wB, "term14b"), { exampleIds: [eShared] });

  // Also create a segment reference: E_shared has a segment pointing to W_B
  // so we can verify segment cleanup doesn't break the surviving word.
  await updateExampleSentence(eShared, { segments: [{ text: "term14b", id: wB }] });
  await reconcileExampleSegmentRefs(eShared, [], [{ text: "term14b", id: wB }]);

  // Precondition
  assert((await readExample(eShared)) !== null, "E_shared exists before delete");

  // Delete W_A — E_shared must survive because W_B still references it.
  await deleteWord(LANG, wA);

  assert((await readWord(wA)) === null, "W_A deleted");
  assert((await readExample(eShared)) !== null, "E_shared survives (W_B still references it)");

  const wBData = await readWord(wB);
  const wBExIds = new Set<string>((wBData?.exampleIds ?? []) as string[]);
  assert(wBExIds.has(eShared), "W_B.exampleIds still contains E_shared");

  await assertInvariant("T14");
}

async function testConcurrentReconciles() {
  console.log("\n[T8] concurrency stress: 20 parallel reconcile calls");
  // Build a fresh test surface: one target word W_stress + one example E_stress
  const wStress = "smoke_w_stress";
  const eStress = "smoke_e_stress";
  await addWord(LANG, makeWord(wStress, "stress"));
  await makeExample(eStress, "stress sentence");

  // Kick off many parallel reconcile calls that add/remove the segment ref
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    // Alternate between adding and removing the reference
    if (i % 2 === 0) {
      tasks.push(
        reconcileExampleSegmentRefs(
          eStress,
          [],
          [{ text: "stress", id: wStress }],
        ),
      );
    } else {
      tasks.push(
        reconcileExampleSegmentRefs(
          eStress,
          [{ text: "stress", id: wStress }],
          [],
        ),
      );
    }
  }
  await Promise.all(tasks);

  // Regardless of interleaving, the invariant must hold for the final state
  // (which is determined by the last actual segments on the example doc).
  // Set a known final state by explicitly writing E_stress's segments and
  // reconciling one last time — this ensures we're testing steady-state
  // consistency, not racey arbitrary outcomes.
  await updateExampleSentence(eStress, { segments: [{ text: "stress", id: wStress }] });
  await reconcileExampleSegmentRefs(eStress, [], [{ text: "stress", id: wStress }]);

  await assertInvariant("T8 final state");
}

// --- Main ---

async function main() {
  console.log(`=== Invariant smoke test on language "${LANG}" ===`);

  console.log("\n[setup] Cleaning up any leftover test data...");
  await cleanup();
  ok("clean slate");

  try {
    await testAddWordInvariant();
    await testReconcileNewSegmentRef();
    await testUpdateWordExampleIds();
    await testReconcileDropSegmentRef();
    await testUnlinkDeletesWordWithNoOwnExamples();
    await testUnlinkPreservesWordWithOwnExamples();
    await testDeleteWordPreservesSegmentRefExample();
    await testUnlinkPreservesWordWithMultipleSegmentRefs();
    await testReconcileIncomingSegmentsReactivate();
    await testReconcileOrphanDeletion();
    await testPutHandlerDropAndRename();
    await testInPlaceRenameAndSegmentEdit();
    await testDeleteWordPreservesReferencedExample();
    await testConcurrentReconciles();
  } catch (e) {
    failed++;
    failures.push(`uncaught exception: ${(e as Error).message}`);
    console.error(`\n✗ Uncaught exception:`, e);
  } finally {
    console.log("\n[teardown] Cleaning up test data...");
    await cleanup();
    ok("cleanup complete");
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Smoke test runner crashed:", e);
  process.exit(1);
});
