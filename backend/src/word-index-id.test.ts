import assert from "node:assert/strict";
import { test } from "node:test";
import { isLookupableTerm, wordIndexDocId } from "./word-index-id.js";

// The segment from the bug report: the smart-add LLM emitted a stock-ticker
// annotation as one segment, and "/" broke the Firestore document path.
const TICKER = "09988.HK/NYSE : BABA";

// ---------- identity (the zero-migration guarantee) ----------

test("wordIndexDocId is the identity for every previously-storable term", () => {
  // Anything already in word_index was accepted by Firestore, so it has no "/",
  // and (bar the audited "%" case) must keep its existing document ID.
  assert.equal(wordIndexDocId("chinese", "新一代"), "chinese_新一代");
  assert.equal(wordIndexDocId("chinese", "09988.HK NYSE : BABA"), "chinese_09988.HK NYSE : BABA");
  assert.equal(wordIndexDocId("english", "company's"), "english_company's");
  assert.equal(wordIndexDocId("english", "don't"), "english_don't");
  assert.equal(wordIndexDocId("chinese", "849亿元"), "chinese_849亿元");
  assert.equal(wordIndexDocId("japanese", ""), "japanese_");
});

// ---------- "/" encoding (the fix) ----------

test("wordIndexDocId encodes / so the id stays one path component", () => {
  assert.equal(wordIndexDocId("chinese", TICKER), "chinese_09988.HK%2FNYSE : BABA");
  assert.equal(wordIndexDocId("chinese", "/"), "chinese_%2F");
  assert.equal(wordIndexDocId("english", "and/or"), "english_and%2For");
  // An even component count does not throw in Firestore — it silently addresses a
  // nested subcollection, so it has to be encoded just as carefully as an odd one.
  assert.equal(wordIndexDocId("english", "a/b/c"), "english_a%2Fb%2Fc");
  for (const term of [TICKER, "/", "and/or", "a/b/c", "%/", "///"]) {
    assert.ok(!wordIndexDocId("chinese", term).includes("/"), `raw / survived in "${term}"`);
  }
});

// ---------- injectivity ----------

test("wordIndexDocId escapes % before / so distinct terms never share an id", () => {
  // Encoding "/" first would turn "a/b" into the same string the literal term
  // "a%2Fb" maps to, silently merging two words onto one index entry.
  assert.equal(wordIndexDocId("chinese", "a/b"), "chinese_a%2Fb");
  assert.equal(wordIndexDocId("chinese", "a%2Fb"), "chinese_a%252Fb");
  assert.notEqual(wordIndexDocId("chinese", "a/b"), wordIndexDocId("chinese", "a%2Fb"));
  assert.equal(wordIndexDocId("english", "100%"), "english_100%25");
});

test("the %23 hash marker cannot appear in an identity or encoded id", () => {
  // The three output classes have to stay disjoint, or a hashed term could collide
  // with a literal one.
  for (const term of ["%23", "#", "%2", "%", "a#b", "%23x"]) {
    assert.ok(
      !wordIndexDocId("chinese", term).startsWith("chinese_%23"),
      `"${term}" masqueraded as a hash fallback`
    );
  }
});

// ---------- fallbacks ----------

test("wordIndexDocId falls back to a hash beyond the 1500-byte cap", () => {
  const long = "漢".repeat(600); // 3 bytes each — well past the cap
  const id = wordIndexDocId("chinese", long);
  assert.ok(id.startsWith("chinese_%23"));
  assert.equal(id.length, "chinese_%23".length + 32);
  assert.equal(id, wordIndexDocId("chinese", long), "must be deterministic");
  assert.notEqual(id, wordIndexDocId("chinese", "漢".repeat(601)));
});

test("wordIndexDocId falls back to a hash for reserved __…__ ids", () => {
  const id = wordIndexDocId("__lang", "x__");
  assert.ok(id.startsWith("__lang_%23"));
  assert.ok(!/^__.*__$/.test(id));
});

// ---------- the bulk-lookup guard ----------

test("isLookupableTerm accepts letters and digits, rejects pure punctuation", () => {
  for (const term of ["的", "GDP", "24/7", "849亿元", "don't", TICKER]) {
    assert.ok(isLookupableTerm(term), `"${term}" should be lookupable`);
  }
  for (const term of ["/", "：", "。", "……", "", " : ", "，"]) {
    assert.ok(!isLookupableTerm(term), `"${term}" should be skipped`);
  }
});
