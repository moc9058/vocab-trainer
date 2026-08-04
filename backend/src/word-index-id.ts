import { createHash } from "crypto";

/**
 * Document-ID construction for the term-keyed `word_index` collection.
 *
 * Pure on purpose — it imports nothing but `node:crypto`, so unit tests and the
 * maintenance scripts can pull it in without constructing the Firestore client
 * that loading `firestore.ts` would.
 *
 * It exists because `word_index` is keyed by the TERM (`{language}_{term}`, with
 * the numeric word id stored as a FIELD), and a term is arbitrary user- or
 * LLM-supplied text. A term containing "/" — Firestore's path separator — turns
 * the "document ID" into a multi-component path: an odd count throws
 * ("documentPath must point to a document"), and an even one silently reads and
 * writes a document inside a nested subcollection, invisible to every
 * `where("language","==",…)` sweep. The second failure is the worse of the two.
 * That is not hypothetical: the smart-add LLM segmented an article's stock-ticker
 * annotation as one segment ("09988.HK/NYSE : BABA") and the segment→word lookup
 * 500'd on it.
 */

/** Max UTF-8 bytes Firestore allows for a document ID. */
const MAX_DOC_ID_BYTES = 1500;

/**
 * Whether a term is worth a `word_index` read at all.
 *
 * Guard for BULK lookups only (`lookupWordsByTerms`): a token with neither a
 * letter nor a digit — a bare "/", "：", "。", "……" — can never be a library
 * word, so looking it up only costs a read. Digits count because `wordIndexDocId`
 * makes terms like "24/7" storable for the first time, and a `\p{L}`-only rule
 * would let such a word be added yet stay permanently invisible to check-terms
 * and segment linking.
 *
 * Deliberately NOT applied to the single-term `lookupWordByTerm`: that one backs
 * the smart-add duplicate check, where a false "not found" would permit a
 * duplicate word document.
 */
export function isLookupableTerm(term: string): boolean {
  return /[\p{L}\p{N}]/u.test(term);
}

/**
 * The `word_index` document ID for a term. Callers must always pass the RAW term
 * — never an already-encoded value.
 *
 * Identity for every term containing neither "%" nor "/", percent-encoded
 * otherwise, with a hash fallback for IDs Firestore would reject on other
 * grounds.
 *
 * **Injectivity** (two terms can never share an ID). The image splits into three
 * disjoint classes: identity outputs contain no "%" at all, since any "%"-bearing
 * term is routed to the encoder; encoded outputs contain "%" only as "%25" or
 * "%2F", and escaping the escape character first makes that mapping invertible;
 * hash outputs carry the marker "%23" immediately after the `{language}_` prefix,
 * which the other two classes cannot produce. Within the hash class, a collision
 * needs one in sha256's first 128 bits. The replacement ORDER is load-bearing —
 * encoding "/" first would corrupt the escapes introduced for "%".
 *
 * **Zero migration.** Every ID already in the collection was accepted by
 * Firestore, so it holds no "/", is ≤1500 bytes and is not `__…__`; for every
 * such term that also has no "%", this function returns exactly the existing ID.
 * "%"-bearing terms are the one storable class that moves, which is what the
 * MISKEYED pass of `scripts/sweep-orphaned-word-index.ts` audits and repairs.
 * A composed ID always contains "_", so it can never be "." or "..".
 */
export function wordIndexDocId(language: string, term: string): string {
  const suffix = /[%/]/.test(term)
    ? term.replace(/%/g, "%25").replace(/\//g, "%2F")
    : term;
  const id = `${language}_${suffix}`;
  if (Buffer.byteLength(id, "utf8") > MAX_DOC_ID_BYTES || /^__.*__$/.test(id)) {
    return `${language}_%23${createHash("sha256").update(term).digest("hex").slice(0, 32)}`;
  }
  return id;
}
