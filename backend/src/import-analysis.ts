/**
 * The pure half of `routes/import.ts`: turning the model's raw analysis JSON into
 * the flat `ImportAnalysisResult` the client consumes, and guaranteeing that every
 * extracted word is attached to a sentence it actually occurs in.
 *
 * It lives in its own module so the tests can import it without pulling in
 * `firestore.js` (which constructs a client at import time) or fastify.
 *
 * ## Why the attribution has to be checked at all
 *
 * The schema used to make `words[]`/`grammar[]` FLAT top-level arrays whose items
 * each carried a model-emitted `sentenceIndex` — the word→sentence link was a
 * foreign key the model had to count out for itself, hundreds of times, against a
 * sentence list it had generated earlier in the same response. It miscounted, and
 * whole runs of words landed on neighbouring sentences (「行政区划」 under a sentence
 * about a GDP gap). The schema is now NESTED — a sentence carries its own words —
 * so the association is positional, the same mechanism that already makes
 * `ImportSentence.index` trustworthy. This module is the backstop: nesting makes
 * misattribution rare, `repairWordAttribution` removes the residue.
 */
import type {
  ImportAnalysisResult,
  ImportExtractedGrammar,
  ImportExtractedWord,
  ImportParagraph,
  ImportSentence,
} from "./types.js";

// ---------- grammar abbreviation casing ----------

/**
 * Grammatical placeholder abbreviations that a `statement` writes in LOWERCASE.
 * Matched as whole Latin-letter runs, so a trailing index (`v1`) or a hyphenated
 * suffix (`v-ing`) falls outside the run and survives untouched.
 */
const GRAMMAR_ABBREVIATIONS = new Set([
  "s", "v", "o", "c", "a", "b", "n", "m",
  "adj", "adv", "aux", "pron", "prep", "conj", "num", "part",
  "np", "vp", "ap", "pp",
  "sv", "svo", "svc", "svoo", "svoc",
]);

const FULLWIDTH_UPPER_START = 0xff21;
const FULLWIDTH_UPPER_END = 0xff3a;
const FULLWIDTH_TO_LOWER_OFFSET = 0x20;
/** Half- and full-width Latin letters, since textbook notation uses both (Ｖ＋Ｏ). */
const LATIN_RUN = /[A-Za-zＡ-Ｚａ-ｚ]+/g;

function foldWidth(run: string): string {
  return run.replace(/[Ａ-Ｚａ-ｚ]/g, (ch) =>
    String.fromCodePoint(ch.codePointAt(0)! - 0xfee0)
  );
}

/** Lowercases without changing width, so 「Ｖ」 becomes 「ｖ」 rather than "v". */
function lowerKeepingWidth(run: string): string {
  return run.replace(/[A-ZＡ-Ｚ]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    return code >= FULLWIDTH_UPPER_START && code <= FULLWIDTH_UPPER_END
      ? String.fromCodePoint(code + FULLWIDTH_TO_LOWER_OFFSET)
      : ch.toLowerCase();
  });
}

/**
 * Force grammar-element abbreviations to lowercase (「V＋O」 → 「v＋o」). Applied on
 * BOTH sides of the LLM call: to the style examples going out (40 uppercase entries
 * would otherwise out-vote the instruction, being the last thing the model reads)
 * and to the statements coming back. Only whole runs that ARE an abbreviation are
 * touched, so real words in a statement keep their casing.
 */
export function lowercaseGrammarAbbreviations(statement: string): string {
  return statement.replace(LATIN_RUN, (run) =>
    GRAMMAR_ABBREVIATIONS.has(foldWidth(run).toLowerCase()) ? lowerKeepingWidth(run) : run
  );
}

// ---------- occurrence matching ----------

/**
 * A term written in Latin script only counts at word boundaries. Without this the
 * English article 「a」 matches the `a` inside 「analysis」 and every term looks
 * present. CJK terms have no boundaries to respect and are matched as plain
 * substrings.
 *
 * MIRRORS `frontend/src/utils/importSession.ts` (`LATIN_TERM`, `boundedAt`,
 * `termOccurrences`) — the client runs the identical predicate to decide whether a
 * saved row still belongs to its sentence, so the two must agree exactly. Kept as a
 * copy rather than shared: backend and frontend are independent npm projects with
 * their own Docker builds, and this repo already mirrors types and small helpers
 * across them by hand.
 */
const LATIN_TERM = /^[\p{Script=Latin}\p{M}''-]+$/u;

function boundedAt(sentence: string, at: number, len: number): boolean {
  const before = at > 0 ? sentence[at - 1] : "";
  const after = at + len < sentence.length ? sentence[at + len] : "";
  return !/\p{L}|\p{N}/u.test(before) && !/\p{L}|\p{N}/u.test(after);
}

/** Every position in `sentence` where `term` occurs, left to right. */
export function termOccurrences(sentence: string, term: string): number[] {
  if (!term) return [];
  const latin = LATIN_TERM.test(term);
  const haystack = latin ? sentence.toLowerCase() : sentence;
  const needle = latin ? term.toLowerCase() : term;
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (latin && !boundedAt(sentence, at, needle.length)) continue;
    out.push(at);
  }
  return out;
}

function occursIn(sentence: string, term: string): boolean {
  return termOccurrences(sentence, term).length > 0;
}

/**
 * Languages whose extracted `term` is required to be a verbatim substring of its
 * sentence, so a term that occurs nowhere is provably wrong rather than merely
 * inflected. Chinese has no inflection at all, and the English prompt forbids the
 * multi-word entries that would break verbatim matching.
 *
 * Japanese and Korean are deliberately absent: their prompts split inflections
 * (발표했다 → 발표하 + 았다), so verbatim absence is the NORMAL case there and even
 * the stem can be respelled (크 / 컸다).
 */
const VERBATIM_LANGUAGES = new Set(["chinese", "english"]);

/** Shortest prefix worth treating as evidence of an inflected form. One character
 *  matches almost anything in CJK and would justify any attachment at all. */
const MIN_PREFIX = 2;

/** The longest prefix of `term` (down to MIN_PREFIX) that occurs in `sentence`. */
function hasPrefixIn(sentence: string, term: string): boolean {
  for (let len = term.length - 1; len >= MIN_PREFIX; len--) {
    if (sentence.includes(term.slice(0, len))) return true;
  }
  return false;
}

// ---------- attribution repair ----------

export interface AttributionRepairSummary {
  /** Rows moved to a sentence the term actually occurs in. */
  reassigned: number;
  /** Rows dropped because the term occurs nowhere in the article (verbatim
   *  languages only) — `materializeGaps` re-surfaces the characters client-side. */
  dropped: number;
  /** Rows dropped because the sentence they would move to already lists the term. */
  redundant: number;
  /** Rows left where they were despite not matching (inflected languages). */
  unmatched: number;
  /** A few human-readable examples, for the server log. */
  samples: string[];
}

const SAMPLE_LIMIT = 8;

function emptySummary(): AttributionRepairSummary {
  return { reassigned: 0, dropped: 0, redundant: 0, unmatched: 0, samples: [] };
}

export function repairChangedAnything(summary: AttributionRepairSummary): boolean {
  return (
    summary.reassigned > 0 ||
    summary.dropped > 0 ||
    summary.redundant > 0 ||
    summary.unmatched > 0
  );
}

/**
 * Sentence indices ordered by distance from `from`, nearest first, ties going to the
 * lower index. A miscount shifts a run of words by a small amount, so the sentence
 * the model meant is almost always a neighbour — and picking deterministically
 * matters because the client runs the same search over saved sessions and must
 * arrive at the same answer.
 */
function byDistanceFrom(indices: number[], from: number): number[] {
  return [...indices].sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || a - b);
}

/**
 * Re-attaches (or discards) every word the model filed under a sentence it does not
 * occur in.
 *
 * Rows are decided in two passes so a correctly-attributed row is never displaced by
 * a moved one: pass 1 claims every sentence/term pair that is already right, pass 2
 * places the rest around them. The output keeps the input's relative order, which is
 * what `backfillRepeatedWords` needs — its "first occurrence wins" contract is
 * article order.
 */
export function repairWordAttribution(
  words: ImportExtractedWord[],
  sentences: ImportSentence[],
  language: string
): { words: ImportExtractedWord[]; summary: AttributionRepairSummary } {
  const summary = emptySummary();
  if (sentences.length === 0) return { words: [], summary };

  const textOf = new Map(sentences.map((s) => [s.index, s.text ?? ""]));
  const indices = sentences.map((s) => s.index);
  const strict = VERBATIM_LANGUAGES.has(language);
  const placed = new Set<string>();
  const key = (index: number, term: string) => `${index} ${term}`;
  const note = (message: string) => {
    if (summary.samples.length < SAMPLE_LIMIT) summary.samples.push(message);
  };

  /** Target sentence per input row: a number to keep/move, `null` to drop. */
  const target = new Array<number | null | undefined>(words.length).fill(undefined);

  // Pass 1 — rows that are already right. They anchor the sentences they occupy.
  words.forEach((w, i) => {
    const term = w.term?.trim();
    if (!term) {
      target[i] = null;
      return;
    }
    if (occursIn(textOf.get(w.sentenceIndex) ?? "", term)) {
      target[i] = w.sentenceIndex;
      placed.add(key(w.sentenceIndex, term));
    }
  });

  // Pass 2 — everything the model got wrong (or that is legitimately inflected).
  words.forEach((w, i) => {
    if (target[i] !== undefined) return;
    const term = w.term.trim();
    const own = textOf.get(w.sentenceIndex) ?? "";

    // An inflected language gets the benefit of the doubt in its OWN sentence first:
    // 「食べる」 filed under a sentence reading 「食べました」 belongs exactly where it is,
    // and moving it to some other sentence that happens to spell it out would be worse
    // than leaving it.
    if (!strict && hasPrefixIn(own, term)) {
      target[i] = w.sentenceIndex;
      return;
    }

    const verbatim = byDistanceFrom(indices, w.sentenceIndex).find(
      (index) => index !== w.sentenceIndex && occursIn(textOf.get(index) ?? "", term)
    );
    const found =
      verbatim ??
      (strict
        ? undefined
        : byDistanceFrom(indices, w.sentenceIndex).find(
            (index) => index !== w.sentenceIndex && hasPrefixIn(textOf.get(index) ?? "", term)
          ));

    if (found === undefined) {
      if (strict) {
        // Nowhere in the article. Dropping loses nothing the user can see: the
        // characters of the sentence are still covered by `materializeGaps`, which
        // turns anything left unaccounted for into a row of its own.
        target[i] = null;
        summary.dropped++;
        note(`dropped "${term}" (not in the article; was filed under sentence ${w.sentenceIndex})`);
      } else {
        target[i] = w.sentenceIndex;
        summary.unmatched++;
      }
      return;
    }

    if (placed.has(key(found, term))) {
      // The sentence already lists this term, and a listed term covers all of its
      // occurrences there — a second row would be a duplicate, not a rescue.
      target[i] = null;
      summary.redundant++;
      note(`dropped duplicate "${term}" (sentence ${found} already lists it)`);
      return;
    }
    target[i] = found;
    placed.add(key(found, term));
    summary.reassigned++;
    note(`moved "${term}" from sentence ${w.sentenceIndex} to ${found}`);
  });

  const repaired = words
    .map((w, i) => (target[i] === null || target[i] === undefined ? null : { ...w, sentenceIndex: target[i]! }))
    .filter((w): w is ImportExtractedWord => w !== null);
  return { words: repaired, summary };
}

/**
 * The same repair for grammar, keyed on `excerpt` — the verbatim span of the
 * sentence that instantiates the pattern.
 *
 * A `statement` is pattern notation (「随着～，越来越～」) and can never be matched
 * positionally, which is why the schema asks for the excerpt separately. A row whose
 * excerpt is absent from the whole article is KEPT with the excerpt cleared rather
 * than dropped: grammar never contributes to sentence coverage, so a wrong
 * attachment costs a misplaced card, while dropping costs the pattern outright.
 */
export function repairGrammarAttribution(
  grammar: ImportExtractedGrammar[],
  sentences: ImportSentence[]
): { grammar: ImportExtractedGrammar[]; summary: AttributionRepairSummary } {
  const summary = emptySummary();
  if (sentences.length === 0) return { grammar: [], summary };

  const textOf = new Map(sentences.map((s) => [s.index, s.text ?? ""]));
  const indices = sentences.map((s) => s.index);

  const repaired = grammar.map((g) => {
    const excerpt = g.excerpt?.trim();
    if (!excerpt) return g;
    if (occursIn(textOf.get(g.sentenceIndex) ?? "", excerpt)) return { ...g, excerpt };
    const found = byDistanceFrom(indices, g.sentenceIndex).find(
      (index) => index !== g.sentenceIndex && occursIn(textOf.get(index) ?? "", excerpt)
    );
    if (found === undefined) {
      summary.unmatched++;
      const { excerpt: _dropped, ...rest } = g;
      return rest;
    }
    summary.reassigned++;
    if (summary.samples.length < SAMPLE_LIMIT) {
      summary.samples.push(`moved grammar "${g.statement}" from sentence ${g.sentenceIndex} to ${found}`);
    }
    return { ...g, excerpt, sentenceIndex: found };
  });
  return { grammar: repaired, summary };
}

// ---------- repeated-word backfill ----------

/**
 * Fills in the reading and gloss the model left blank on a repeated word.
 *
 * Every sentence has to be covered on its own, so a common word is listed once per
 * sentence it appears in — and paying for its pinyin and its Japanese gloss thirty
 * times over is the single largest avoidable cost in the whole analysis. The prompts
 * therefore ask for those two fields on a term's FIRST occurrence only, blank
 * thereafter, with an explicit exception for a genuinely different reading or sense
 * (还 hái/huán, 了 le/liǎo) which must still be spelled out.
 *
 * FIRST wins, not last, because that is the contract the prompt states: a blank
 * means "same as the first occurrence". Taking the latest non-empty value would make
 * an explicit polyphonic reading leak backwards onto every later blank.
 *
 * The two fields are inherited independently — the model routinely blanks one and
 * not the other. Runs after the attribution repair, so a dropped bogus entry can
 * never be the occurrence everything else inherits from.
 */
export function backfillRepeatedWords(
  words: ImportAnalysisResult["words"]
): ImportAnalysisResult["words"] {
  const firstByTerm = new Map<string, { transliteration?: string; meaning?: string }>();
  return words.map((w) => {
    const term = w.term.trim();
    const first = firstByTerm.get(term);
    const transliteration = w.transliteration?.trim() || first?.transliteration;
    const meaning = w.meaning?.trim() || first?.meaning;
    if (!first) {
      firstByTerm.set(term, { transliteration, meaning });
    } else {
      // A term whose first occurrence was itself blank can still be filled by a
      // later one; anything already known stays put.
      if (!first.transliteration && transliteration) first.transliteration = transliteration;
      if (!first.meaning && meaning) first.meaning = meaning;
    }
    return {
      ...w,
      ...(transliteration ? { transliteration } : {}),
      ...(meaning ? { meaning } : {}),
    };
  });
}

// ---------- normalization ----------

/** What the model returns: words and grammar nested inside their own sentence. */
interface RawSentence {
  text?: string;
  translation?: string;
  words?: Omit<ImportExtractedWord, "sentenceIndex">[];
  grammar?: Omit<ImportExtractedGrammar, "sentenceIndex">[];
}
interface RawAnalysis {
  paragraphs?: { sentences?: RawSentence[] }[];
  /** Pre-nesting shape: flat arrays carrying a model-emitted `sentenceIndex`. */
  words?: ImportExtractedWord[];
  grammar?: ImportExtractedGrammar[];
}

/**
 * Parses the model's JSON into the flat shape the client consumes.
 *
 * Sentence indices are assigned here by position — they are fully derivable from the
 * order of the paragraphs, which mirrors `ensureDecompositionIds` in
 * routes/translation.ts. Words and grammar arrive NESTED inside their sentence, so
 * their `sentenceIndex` is likewise positional rather than model-authored; the
 * flattening below is the only place it is set.
 *
 * A response in the pre-nesting shape (flat arrays with model-emitted indices) is
 * still accepted, because `config/import` is pushed separately from the code and a
 * local emulator can be holding an older snapshot. Those indices get the same
 * occurrence repair as everything else.
 */
export function normalizeAnalysis(
  raw: string,
  language: string
): { analysis: ImportAnalysisResult; repair: AttributionRepairSummary } {
  let parsed: RawAnalysis;
  try {
    parsed = JSON.parse(raw) as RawAnalysis;
  } catch (err) {
    // The analysis segments every sentence exhaustively, so a long article can run
    // the model into its output cap and the stream ends mid-token. Say so, rather
    // than surfacing a bare "Unexpected end of JSON input".
    throw new Error(
      `The analysis did not come back as complete JSON (${raw.length} characters received). ` +
        `Exhaustive word segmentation produces a lot of output, so a long article can exceed ` +
        `the model's response limit — try importing it a few paragraphs at a time. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const paragraphs: ImportParagraph[] = [];
  let nestedWords: ImportExtractedWord[] = [];
  let nestedGrammar: ImportExtractedGrammar[] = [];
  let index = 0;
  for (const p of parsed.paragraphs ?? []) {
    const sentences: ImportSentence[] = [];
    for (const s of p.sentences ?? []) {
      const sentenceIndex = index++;
      sentences.push({
        index: sentenceIndex,
        text: s.text ?? "",
        ...(s.translation ? { translation: s.translation } : {}),
      });
      for (const w of s.words ?? []) {
        if (w?.term?.trim()) nestedWords.push({ ...w, sentenceIndex });
      }
      for (const g of s.grammar ?? []) {
        if (g?.statement?.trim()) nestedGrammar.push({ ...g, sentenceIndex });
      }
    }
    paragraphs.push({ sentences });
  }
  const total = index;
  const sentences = paragraphs.flatMap((p) => p.sentences);

  // Legacy shape: nothing came back nested, but the top-level arrays are populated.
  if (nestedWords.length === 0 && nestedGrammar.length === 0) {
    const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < total;
    nestedWords = (parsed.words ?? []).filter((w) => w.term?.trim() && inRange(w.sentenceIndex));
    nestedGrammar = (parsed.grammar ?? []).filter(
      (g) => g.statement?.trim() && inRange(g.sentenceIndex)
    );
  }

  const words = repairWordAttribution(nestedWords, sentences, language);
  const grammar = repairGrammarAttribution(nestedGrammar, sentences);
  const repair: AttributionRepairSummary = {
    reassigned: words.summary.reassigned + grammar.summary.reassigned,
    dropped: words.summary.dropped,
    redundant: words.summary.redundant,
    unmatched: words.summary.unmatched + grammar.summary.unmatched,
    samples: [...words.summary.samples, ...grammar.summary.samples].slice(0, SAMPLE_LIMIT),
  };

  return {
    analysis: {
      paragraphs,
      words: backfillRepeatedWords(words.words),
      grammar: grammar.grammar.map((g) => ({
        ...g,
        statement: lowercaseGrammarAbbreviations(g.statement),
      })),
    },
    repair,
  };
}
