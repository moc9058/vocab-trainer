import { deduplicateWords } from "./importDedup";
import type {
  ImportAnalysisResult,
  ImportGrammarItem,
  ImportItem,
  ImportRegistrationState,
  ImportSentence,
  ImportWordItem,
} from "../types";

/** Rows the user has removed or that a merge/split consumed are kept as
 *  tombstones, so "live" means everything still on screen. */
export function isLive(item: ImportItem): boolean {
  return item.status !== "skipped" && !(item.kind === "word" && item.suppressedByGrammar);
}

/** An item is locked against editing once it has been handed to the queue —
 *  editing a term after registration would silently disagree with the DB. */
export function isLocked(item: ImportItem): boolean {
  return item.status === "queued" || item.status === "registered" || item.status === "duplicate";
}

/** The destinations whose write is currently in flight for this row. */
export function pendingTargets(item: ImportItem): ("A" | "B")[] {
  return REGISTRATION_TARGETS.filter((d) => item.registrations?.[d]?.status === "queued");
}

const REGISTRATION_TARGETS = ["A", "B"] as const;

/**
 * Collapse the per-destination registration states into the row-level
 * `status`/`target`/`error` triple.
 *
 * Group A and Group B are independent writes that can be in flight together, so the
 * per-destination record is the truth. But `isLocked`, the progress counter
 * (`sessionCounts`), the load-time reconciliation and the backend's `registeredCount`
 * all read the single status, and each of them wants the same summary: is anything
 * happening, and if not, did anything go wrong.
 *
 * Hence the precedence: **queued beats failed beats duplicate beats registered**. A row
 * with one write still running is `queued` (so it stays locked against editing); once
 * everything has settled, a failure outweighs a success, because a half-registered row
 * is the one the user still has to deal with. `target` names whichever destination the
 * summary is about, which is what tells the UI which button to mark.
 *
 * A row with no registrations keeps the status it already had — `pending` for untouched
 * rows, `skipped` for tombstones, neither of which this can invent.
 */
export function summarizeRegistrations(
  item: ImportItem
): Pick<ImportItem, "status" | "target" | "error" | "rescuedAsDraft"> {
  const entries = REGISTRATION_TARGETS.flatMap((d) => {
    const state = item.registrations?.[d];
    return state ? [[d, state] as const] : [];
  });
  if (entries.length === 0 || item.status === "skipped") {
    return { status: item.status, target: item.target, error: item.error, rescuedAsDraft: item.rescuedAsDraft };
  }
  const pick =
    entries.find(([, s]) => s.status === "queued") ??
    entries.find(([, s]) => s.status === "failed") ??
    entries.find(([, s]) => s.status === "duplicate") ??
    entries[entries.length - 1];
  const [target, state] = pick;
  return {
    status: state.status,
    target,
    error: state.error,
    rescuedAsDraft: state.rescuedAsDraft,
  };
}

/** Set one destination's state and re-derive the row summary in one go — the two must
 *  never drift apart, so no caller writes `registrations` without going through this. */
export function withRegistration(
  item: ImportItem,
  target: "A" | "B",
  state: ImportRegistrationState
): ImportItem {
  const next = {
    ...item,
    registrations: { ...item.registrations, [target]: state },
  } as ImportItem;
  return { ...next, ...summarizeRegistrations(next) } as ImportItem;
}

export function newItemId(kind: "word" | "grammar"): string {
  return `${kind === "word" ? "wi" : "gi"}-${crypto.randomUUID()}`;
}

/**
 * Flattens a fresh analysis into the session's single working list.
 *
 * Word rows are ordered by WHERE THE TERM STARTS in its sentence rather than by
 * position in the analysis array. The array order is only as reliable as the model's
 * willingness to emit words in sentence order, and offsets are what let a
 * materialized gap slot into reading order. A term listed twice for one sentence
 * takes its second occurrence, counted per term rather than by a shared cursor —
 * a cursor would mis-place every word emitted out of order, which is exactly the
 * case this is meant to repair.
 *
 * Every sentence is then completed: whatever the analysis left uncovered becomes a
 * row of its own, so "every word of every sentence is on screen" holds from the
 * moment the review opens rather than depending on the user noticing a highlight.
 */
export function buildImportItems(
  analysis: ImportAnalysisResult,
  existing: Record<string, string>,
  /** Statement → grammar ID for patterns already in the library, so a row can extend
   *  group membership instead of storing the pattern a second time. */
  existingGrammar: Record<string, string> = {},
  /** Backend full-name language ("chinese"). Decides whether a term that is not a
   *  verbatim substring is a legitimate inflection or a misattribution. Defaults to
   *  the STRICT reading, so a caller that forgets it over-reports rather than
   *  silently waving misattributed rows through. */
  language: string = ""
): ImportItem[] {
  const sentenceById = new Map(
    flattenSentences(analysis.paragraphs).map((s) => [s.index, s.text])
  );
  /** `sentenceIndex \0 term` → how many rows for it have been placed already. */
  const seen = new Map<string, number>();
  /** Per sentence: the order last handed out, for a term that cannot be located. */
  const lastOrder = new Map<number, number>();

  const words: ImportItem[] = analysis.words.map((w) => {
    const term = w.term.trim();
    const text = sentenceById.get(w.sentenceIndex) ?? "";
    const seenKey = `${w.sentenceIndex}\0${term}`;
    const nth = seen.get(seenKey) ?? 0;
    seen.set(seenKey, nth + 1);
    const hits = termOccurrences(text, term);
    // The nth listing of a term takes its nth occurrence; if the model listed it
    // more times than it occurs, everything past the last one piles onto it.
    const at = w.range?.start ?? hits[Math.min(nth, hits.length - 1)] ?? -1;
    let order: number;
    if (at === -1) {
      // Not a verbatim substring. Routine for Japanese and Korean, where the prompts
      // split inflections (발표했다 → 「발표하」+「았다」); for Chinese and English it
      // means the row is on the wrong sentence, which `wordMismatch` flags and
      // `reattachMismatchedWords` repairs — this only has to place the row somewhere
      // sane meanwhile. Keep the model's relative order by nudging past the previous
      // row; the fractional step guarantees it cannot collide with a gap run's
      // integer offset.
      order = (lastOrder.get(w.sentenceIndex) ?? -1) + 0.001;
    } else {
      order = at;
    }
    lastOrder.set(w.sentenceIndex, order);
    return {
      id: newItemId("word"),
      kind: "word",
      sentenceIndex: w.sentenceIndex,
      order,
      status: "pending",
      origin: "llm",
      term,
      ...(w.occurrenceId ? { occurrenceId: w.occurrenceId, range: w.range, surface: w.surface, sourceTerm: w.sourceTerm, explanationLanguage: w.explanationLanguage } : {}),
      ...(w.transliteration?.trim() ? { transliteration: w.transliteration.trim() } : {}),
      ...(w.meaning?.trim() ? { meaning: w.meaning.trim() } : {}),
      ...(existing[term] ? { existingWordId: existing[term] } : {}),
    } satisfies ImportWordItem;
  });
  const grammar: ImportItem[] = analysis.grammar.map((g, i) => {
    const statement = g.statement.trim();
    return {
      id: newItemId("grammar"),
      kind: "grammar",
      sentenceIndex: g.sentenceIndex,
      order: i,
      status: "pending",
      origin: "llm",
      statement,
      description: (g.description ?? "").trim(),
      ...(g.constructionId ? { constructionId: g.constructionId, fixedElements: g.fixedElements, explanationLanguage: g.explanationLanguage } : {}),
      ...(g.excerpt?.trim() ? { excerpt: g.excerpt.trim() } : {}),
      ...(existingGrammar[statement] ? { existingGrammarId: existingGrammar[statement] } : {}),
    } satisfies ImportGrammarItem;
  });

  const fixed = grammar.flatMap(g => g.kind === "grammar" ? (g.fixedElements ?? []).map(e => ({ ...e, sentenceIndex: g.sentenceIndex })) : []);
  const candidates = words.filter(w => w.kind !== "word" || !w.occurrenceId || !w.range || !fixed.some(e =>
    e.sentenceIndex === w.sentenceIndex && e.range.start === w.range!.start && e.range.end === w.range!.end));
  let items = deduplicateImportItems([...candidates, ...grammar], analysis.paragraphs);
  for (const [sentenceIndex, text] of sentenceById) {
    items = materializeGaps(items, sentenceIndex, text, language);
  }
  return items;
}

export function sentenceItems(items: ImportItem[], sentenceIndex: number) {
  const live = items.filter((i) => isLive(i) && i.sentenceIndex === sentenceIndex);
  const byOrder = (a: ImportItem, b: ImportItem) => a.order - b.order;
  return {
    words: live.filter((i): i is ImportWordItem => i.kind === "word").sort(byOrder),
    grammar: live.filter((i): i is ImportGrammarItem => i.kind === "grammar").sort(byOrder),
  };
}

/** RubyText segments for the read-only whole-source view. They come from the live
 * review rows so edits, merges, splits and removals are reflected immediately. */
export function sentenceRubySegments(items: ImportItem[], sentenceIndex: number) {
  return sentenceItems(items, sentenceIndex).words
    .map((word) => ({
      text: word.term.trim(),
      ...(word.transliteration?.trim()
        ? { transliteration: word.transliteration.trim() }
        : {}),
    }))
    .filter((segment) => segment.text.length > 0);
}

/**
 * Terms this session knows to be in the library, keyed by TERM rather than by row:
 * an article repeats its vocabulary, so registering 「経済」 in sentence 3 also settles
 * the 「経済」 rows in sentences 7 and 12 — and any row a later split produces. Group A
 * is the universe of all items, so "in the library" and "in Group A" are the same
 * thing here (a `duplicate` is a 409 from smart-add, i.e. the word is in the DB;
 * only its group membership was left untouched).
 *
 * Skipped rows are included on purpose: a row merged away still proves its term
 * exists. Trimmed to match how the rows are compared and registered.
 */
export function registeredTerms(items: ImportItem[]): Set<string> {
  const terms = new Set<string>();
  for (const i of items) {
    if (i.kind !== "word") continue;
    const term = i.term.trim();
    if (!term) continue;
    if (i.existingWordId || i.status === "registered" || i.status === "duplicate") {
      terms.add(term);
    }
  }
  return terms;
}

/** Mirror of the backend's `isLookupableTerm` (word-index-id.ts): a term with
 *  neither a letter nor a digit is silently dropped by `lookupWordsByTerms`, so
 *  sending it would make "never checked" indistinguishable from "absent" and
 *  reset such a row on every load. */
function isCheckableTerm(term: string): boolean {
  return /[\p{L}\p{N}]/u.test(term);
}

/**
 * Terms whose rows claim library presence, for the load-time `check-terms` probe.
 *
 * Live rows claim through `existingWordId` or a registration outcome
 * (`queued`/`registered`/`duplicate`); skipped tombstones claim through their id
 * alone — `registeredTerms` counts those on purpose, so a stale tombstone id
 * poisons `inLibrary` exactly like a live one and must be re-verified too.
 */
export function libraryClaimTerms(items: ImportItem[]): string[] {
  const terms = new Set<string>();
  for (const i of items) {
    if (i.kind !== "word") continue;
    const term = i.term.trim();
    if (!term || !isCheckableTerm(term)) continue;
    const claims =
      i.status === "skipped"
        ? Boolean(i.existingWordId)
        : Boolean(i.existingWordId) ||
          i.status === "queued" ||
          i.status === "registered" ||
          i.status === "duplicate";
    if (claims) terms.add(term);
  }
  return [...terms];
}

/** Grammar ids the session believes are in the library — live rows and tombstones
 *  alike. Grammar has no term-level existence check, so these are verified by id
 *  through the items/batch endpoint instead. */
export function claimedGrammarIds(items: ImportItem[]): string[] {
  const ids = new Set<string>();
  for (const i of items) {
    if (i.kind === "grammar" && i.existingGrammarId) ids.add(i.existingGrammarId);
  }
  return [...ids];
}

export interface LibraryReconcileInput {
  /** `check-terms` response: term → live word id. */
  wordIdByTerm: Record<string, string>;
  /** Exactly the terms that were sent — a term never checked is left untouched,
   *  which is what makes a failed probe safe to feed in as an empty set. */
  checkedTerms: ReadonlySet<string>;
  /** Live grammar ids from the items/batch probe; `null` = the probe failed or was
   *  skipped, so grammar rows are left untouched. */
  liveGrammarIds: ReadonlySet<string> | null;
}

/**
 * Squares every library claim in the session against what the DB just said.
 *
 * A term the probe confirmed keeps (or gains) its `existingWordId` — including a
 * delete-then-recreate under a new id — and a row still `queued` from a tab that
 * died mid-write is settled `registered`, since check-terms proves the write
 * landed. A claim the probe DISPROVED (word deleted from the browse screen since
 * the last visit) is reset so the row stops rendering "already in your library"
 * and can be registered again.
 *
 * Returns the input array by identity when nothing changed, so callers can skip
 * the follow-up save on a clean load.
 */
export function reconcileLibraryClaims(
  items: ImportItem[],
  input: LibraryReconcileInput
): { items: ImportItem[]; changed: boolean } {
  let changed = false;
  const next = items.map((item) => {
    const out = reconcileItem(item, input);
    if (out !== item) changed = true;
    return out;
  });
  return { items: changed ? next : items, changed };
}

function reconcileItem(item: ImportItem, input: LibraryReconcileInput): ImportItem {
  if (item.kind === "word") {
    const term = item.term.trim();
    if (!term || !input.checkedTerms.has(term)) return item;
    const wordId = input.wordIdByTerm[term];
    return wordId ? reconcilePresentWord(item, wordId) : reconcileAbsentWord(item);
  }
  if (input.liveGrammarIds === null) return item;
  const id = item.existingGrammarId;
  if (!id || input.liveGrammarIds.has(id)) return item;
  return reconcileAbsentGrammar(item);
}

function reconcilePresentWord(item: ImportWordItem, wordId: string): ImportItem {
  const withId: ImportItem =
    item.existingWordId === wordId ? item : { ...item, existingWordId: wordId };
  if (item.status !== "queued") return withId;
  // The write died with the tab that started it, but check-terms proves it landed —
  // so every destination still marked in flight is settled, not just the row
  // summary. A row left spinning would keep its button disabled.
  const stillPending = pendingTargets(withId);
  if (stillPending.length === 0) return { ...withId, status: "registered" as const };
  return stillPending.reduce<ImportItem>(
    (acc, d) => withRegistration(acc, d, { status: "registered" }),
    withId
  );
}

function reconcileAbsentWord(item: ImportWordItem): ImportItem {
  if (item.status === "skipped") {
    // A tombstone only loses the id: `skipped` is the user's decision about the
    // ROW and survives anything the library does.
    if (!item.existingWordId) return item;
    const rest = { ...item };
    delete rest.existingWordId;
    return rest;
  }
  const prunable = REGISTRATION_TARGETS.some((d) => {
    const s = item.registrations?.[d]?.status;
    return s === "queued" || s === "registered" || s === "duplicate";
  });
  const summaryClaims =
    item.status === "queued" || item.status === "registered" || item.status === "duplicate";
  if (!item.existingWordId && !prunable && !summaryClaims) return item;
  const rest = { ...item };
  delete rest.existingWordId;
  return resetDisprovedClaim(rest);
}

function reconcileAbsentGrammar(item: ImportGrammarItem): ImportItem {
  const rest = { ...item };
  delete rest.existingGrammarId;
  if (item.status === "skipped") return rest;
  return resetDisprovedClaim(rest);
}

/**
 * The library disproved this row's claim, so its registration record is rebuilt:
 * slots that claimed success (`registered`/`duplicate`) are dropped, and so is a
 * `queued` slot — the queue that owned it died with its tab, and with the entity
 * gone there is nothing for the load-time settle to prove, so keeping it would
 * lock the row forever. `failed` slots stay: they claim nothing and carry the
 * error the user still has to deal with.
 *
 * ⚠ `summarizeRegistrations` with zero entries KEEPS the row's existing status, so
 * the summary is seeded back to `pending` explicitly before re-deriving — the one
 * place the derived-summary rule needs a manual reset.
 */
function resetDisprovedClaim(item: ImportItem): ImportItem {
  const kept: Partial<Record<"A" | "B", ImportRegistrationState>> = {};
  let hasKept = false;
  for (const d of REGISTRATION_TARGETS) {
    const state = item.registrations?.[d];
    if (state?.status === "failed") {
      kept[d] = state;
      hasKept = true;
    }
  }
  const seeded = {
    ...item,
    status: "pending" as const,
    target: undefined,
    error: undefined,
    rescuedAsDraft: undefined,
    registrations: hasKept ? kept : undefined,
  } as ImportItem;
  if (!hasKept) return seeded;
  return { ...seeded, ...summarizeRegistrations(seeded) } as ImportItem;
}

function maxOrder(items: ImportItem[], sentenceIndex: number, kind: "word" | "grammar"): number {
  const scoped = items.filter(
    (i) => isLive(i) && i.sentenceIndex === sentenceIndex && i.kind === kind
  );
  return scoped.reduce((max, i) => Math.max(max, i.order), -1);
}

/**
 * The text the merged rows actually span in the sentence — 「経済」+「成長」 inside
 * 「経済成長率が…」 becomes 「経済成長」, which naive concatenation would also get
 * right but which breaks the moment the parts are separated by a particle or a
 * space. Falls back to plain concatenation when a term is not a literal substring
 * (the LLM sometimes returns a lemma rather than the surface form); the field is
 * editable either way, so this never needs to be perfect.
 */
export function sentenceSpanForTerms(sentence: string, terms: string[]): string {
  let cursor = 0;
  let start = -1;
  let end = -1;
  for (const term of terms) {
    const at = sentence.indexOf(term, cursor);
    if (at === -1) return terms.join("");
    if (start === -1) start = at;
    end = at + term.length;
    cursor = end;
  }
  return start === -1 ? terms.join("") : sentence.slice(start, end);
}

/**
 * Merge several word rows into one. Sources become tombstones pointing at the new
 * row, so the merge can be undone without reconstructing anything.
 *
 * `transliteration` is the sources' readings joined whenever the merged term is
 * exactly those sources (see `mergeTransliteration`); it is dropped only when a
 * source had no reading at all, or when the merge spans more than its parts and
 * the joined reading would sit off its characters. `meaning` is always dropped:
 * a compound's gloss is not the sum
 * of its parts. Both fields are editable on the row, so what the merge cannot
 * derive the user fills in.
 */
export function mergeWordItems(
  items: ImportItem[],
  ids: string[],
  sentence: string
): ImportItem[] {
  const sources = items.filter(
    (i): i is ImportWordItem => i.kind === "word" && ids.includes(i.id) && isLive(i) && !isLocked(i)
  );
  if (sources.length < 2) return items;
  const ordered = [...sources].sort((a, b) => a.order - b.order);
  const sourceIds = ordered.map((s) => s.id);

  const terms = ordered.map((s) => s.term);
  const ranges = ordered.map(source => source.range && source.sourceTerm === source.term
    && sentence.slice(source.range.start, source.range.end) === source.surface ? source.range : undefined);
  const range = ranges.every(Boolean) ? { start: Math.min(...ranges.map(value => value!.start)), end: Math.max(...ranges.map(value => value!.end)) } : undefined;
  const term = range ? sentence.slice(range.start, range.end) : sentenceSpanForTerms(sentence, terms);
  const transliteration = mergeTransliteration(term, terms, ordered.map((s) => s.transliteration));
  const merged: ImportWordItem = {
    id: newItemId("word"),
    kind: "word",
    sentenceIndex: ordered[0].sentenceIndex,
    order: ordered[0].order,
    status: "pending",
    origin: "merge",
    sourceIds,
    term,
    ...(range ? { range, surface: term, sourceTerm: term } : {}),
    // `meaning` is deliberately not carried over: a compound's gloss is not the sum
    // of its parts, and the row's meaning field is there for the user to fill in.
    ...(transliteration ? { transliteration } : {}),
  };

  return [
    ...items.map((i) =>
      sourceIds.includes(i.id)
        ? { ...i, status: "skipped" as const, supersededByIds: [merged.id] }
        : i
    ),
    merged,
  ];
}

/**
 * Split one word row into several. `parts` comes from the user typing spaces into
 * the term — the same space-as-boundary convention the Chinese chip workflow uses.
 * Reading and gloss are dropped on every part; they cannot be sliced reliably.
 */
/**
 * Splits a reading along the same boundaries as the term, by binding one
 * whitespace-separated syllable to one letter/ideograph: 「人工智能」
 * "rén gōng zhì néng" cut into 人工 / 智能 yields "rén gōng" / "zhì néng".
 *
 * The binding only holds where the writing system is syllabic per character, so
 * it is verified rather than assumed — if the syllable count does not match the
 * characters the parts cover (a Japanese kana reading, a reading typed as one
 * word, a part the user retyped), every part comes back `undefined` rather than
 * carrying a reading that belongs to the neighbouring characters.
 */
function syllablesOf(transliteration: string | undefined): string[] {
  return (transliteration ?? "").trim().split(/[\s　]+/).filter(Boolean);
}

function charCount(text: string): number {
  return [...text].filter(needsCoverage).length;
}

/**
 * The syllables of a reading, as `expected` of them, or null when it cannot be
 * cut that way. Whitespace is the primary boundary — the analysis is asked for
 * space-separated pinyin — with `tokenizePinyin` as the fallback for readings
 * that arrive glued ("réngōng"), which the model does return often enough that
 * dropping the reading over it is the wrong answer.
 */
function readingSyllables(
  transliteration: string | undefined,
  expected: number
): string[] | null {
  const spaced = syllablesOf(transliteration);
  if (spaced.length === 0) return null;
  if (spaced.length === expected) return spaced;
  const tokenized = tokenizePinyinChunks(spaced);
  return tokenized && tokenized.length === expected ? tokenized : null;
}

export function splitTransliteration(
  transliteration: string | undefined,
  parts: string[]
): (string | undefined)[] {
  const counts = parts.map(charCount);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const syllables = readingSyllables(transliteration, total);
  if (!syllables) return parts.map(() => undefined);

  let cursor = 0;
  return counts.map((n) => {
    const slice = syllables.slice(cursor, cursor + n);
    cursor += n;
    return slice.length > 0 ? slice.join(" ") : undefined;
  });
}

/**
 * The mirror of `splitTransliteration`: the readings of the merged rows, joined.
 *
 * When the merged term is exactly the sources concatenated — 「人工」+「智能」 over
 * 「人工智能」, which is every Chinese merge — the joined reading is right BY
 * CONSTRUCTION and is kept whatever shape it came in: no syllable arithmetic can
 * make it more correct, and requiring the arithmetic to succeed is what used to
 * throw away readings the model had returned glued ("réngōng" "zhìnéng").
 *
 * The check is only needed when the term is a WIDER span than its parts, i.e. the
 * merge swallowed something in between (「食べ」+「みる」 over 「食べてみる」): there the
 * joined reading is genuinely a syllable short, and the row is better off with an
 * empty reading the user can fill than with one shifted off its characters.
 */
export function mergeTransliteration(
  term: string,
  terms: string[],
  readings: (string | undefined)[]
): string | undefined {
  const parts = readings.map((r) => (r ?? "").trim());
  if (parts.some((p) => !p)) return undefined;
  const joined = parts.join(" ");
  // One syllable per space is the convention everything downstream expects, so a
  // glued source reading is re-spaced here when it can be cut confidently.
  const syllables = readingSyllables(joined, charCount(term));
  if (syllables) return syllables.join(" ");
  return term === terms.join("") ? joined : undefined;
}

// ---------- pinyin ----------

const TONE_TO_PLAIN: Record<string, string> = {
  ā: "a", á: "a", ǎ: "a", à: "a",
  ē: "e", é: "e", ě: "e", è: "e",
  ī: "i", í: "i", ǐ: "i", ì: "i",
  ō: "o", ó: "o", ǒ: "o", ò: "o",
  ū: "u", ú: "u", ǔ: "u", ù: "u",
  ǖ: "ü", ǘ: "ü", ǚ: "ü", ǜ: "ü",
  v: "ü",
};

/**
 * Every toneless Mandarin syllable. Membership, not initial+final arithmetic, is
 * what cuts a glued reading correctly: "réngōng" only comes apart as rén+gōng
 * because "ong" is not a syllable, and "tiānānmén" only as tiān+ān+mén because
 * "tia" is not one either. Interjections (m, hm, ng, hng) are left out; they do
 * not appear as a word's reading.
 */
const SYLLABLES = new Set(
  (
    "a ai an ang ao e ei en eng er o ou " +
    "ba bo bai bei bao ban ben bang beng bi bie biao bian bin bing bu " +
    "pa po pai pei pao pou pan pen pang peng pi pie piao pian pin ping pu " +
    "ma mo me mai mei mao mou man men mang meng mi mie miao miu mian min ming mu " +
    "fa fo fei fou fan fen fang feng fu " +
    "da de dai dei dao dou dan den dang deng dong di dia die diao diu dian ding du duo dui duan dun " +
    "ta te tai tei tao tou tan tang teng tong ti tie tiao tian ting tu tuo tui tuan tun " +
    "na ne nai nei nao nou nan nen nang neng nong ni nie niao niu nian nin niang ning nu nuo nuan nun nü nüe " +
    "la lo le lai lei lao lou lan lang leng long li lia lie liao liu lian lin liang ling lu luo luan lun lü lüe " +
    "ga ge gai gei gao gou gan gen gang geng gong gu gua guo guai gui guan gun guang " +
    "ka ke kai kei kao kou kan ken kang keng kong ku kua kuo kuai kui kuan kun kuang " +
    "ha he hai hei hao hou han hen hang heng hong hu hua huo huai hui huan hun huang " +
    "ji jia jie jiao jiu jian jin jiang jing jiong ju jue juan jun " +
    "qi qia qie qiao qiu qian qin qiang qing qiong qu que quan qun " +
    "xi xia xie xiao xiu xian xin xiang xing xiong xu xue xuan xun " +
    "zha zhe zhi zhai zhei zhao zhou zhan zhen zhang zheng zhong zhu zhua zhuo zhuai zhui zhuan zhun zhuang " +
    "cha che chi chai chao chou chan chen chang cheng chong chu chua chuo chuai chui chuan chun chuang " +
    "sha she shi shai shei shao shou shan shen shang sheng shu shua shuo shuai shui shuan shun shuang " +
    "re ri rao rou ran ren rang reng rong ru rua ruo rui ruan run " +
    "za ze zi zai zei zao zou zan zen zang zeng zong zu zuo zui zuan zun " +
    "ca ce ci cai cao cou can cen cang ceng cong cu cuo cui cuan cun " +
    "sa se si sai sao sou san sen sang seng song su suo sui suan sun " +
    "ya yo ye yao you yan yang yi yin ying yong yu yue yuan yun " +
    "wa wo wai wei wan wen wang weng wu"
  ).split(" ")
);

/** Longest syllable in the table ("zhuang", "chuang", "shuang"). */
const MAX_SYLLABLE = 6;

function toneCount(text: string): number {
  return [...text].filter((ch) => ch in TONE_TO_PLAIN && ch !== "v").length;
}

/**
 * Cuts one whitespace-free pinyin chunk into syllables — "réngōngzhìnéng" into
 * four. Longest-match with backtracking over `SYLLABLES`, plus one rule spelling
 * alone cannot supply: a candidate carrying two tone marks is two syllables, which
 * is what tells 「xīān」(西安) apart from 「xiān」(仙).
 *
 * Returns null for anything that is not pinyin (kana, hangul, a romanization that
 * happens not to parse) so callers can fall back rather than act on a wrong cut.
 */
function tokenizePinyin(chunk: string): string[] | null {
  const plain = [...chunk].map((ch) => TONE_TO_PLAIN[ch] ?? ch.toLowerCase()).join("");
  if (!/^[a-zü]+$/.test(plain)) return null;

  const walk = (at: number): string[] | null => {
    if (at === plain.length) return [];
    for (let len = Math.min(MAX_SYLLABLE, plain.length - at); len >= 1; len--) {
      if (!SYLLABLES.has(plain.slice(at, at + len))) continue;
      if (toneCount(chunk.slice(at, at + len)) > 1) continue;
      const rest = walk(at + len);
      if (rest) return [chunk.slice(at, at + len), ...rest];
    }
    return null;
  };
  return walk(0);
}

/** Every chunk tokenized, or null if any one of them is not pinyin. */
function tokenizePinyinChunks(chunks: string[]): string[] | null {
  const out: string[] = [];
  for (const chunk of chunks) {
    const tokens = tokenizePinyin(chunk);
    if (!tokens) return null;
    out.push(...tokens);
  }
  return out;
}

export function splitWordItem(items: ImportItem[], id: string, parts: string[]): ImportItem[] {
  const source = items.find(
    (i): i is ImportWordItem => i.kind === "word" && i.id === id && isLive(i) && !isLocked(i)
  );
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  if (!source || clean.length < 2) return items;

  const readings = splitTransliteration(source.transliteration, clean);
  let cursor = 0;
  const offsets = clean.map(term => {
    const start = source.term.indexOf(term, cursor);
    if (start < 0 || source.term.slice(cursor, start).trim()) return undefined;
    cursor = start + term.length;
    return { start, end: cursor };
  });
  const positioned = source.range && source.sourceTerm === source.term && source.surface === source.term
    && offsets.every(Boolean) && !source.term.slice(cursor).trim();
  const created: ImportWordItem[] = clean.map((term, k) => ({
    id: newItemId("word"),
    kind: "word",
    sentenceIndex: source.sentenceIndex,
    // Fractional offsets keep the parts between this row and the next one.
    order: source.order + (k + 1) / (clean.length + 1),
    status: "pending",
    origin: "split",
    sourceIds: [source.id],
    term,
    ...(positioned ? { range: { start: source.range!.start + offsets[k]!.start, end: source.range!.start + offsets[k]!.end }, surface: term, sourceTerm: term } : {}),
    ...(readings[k] ? { transliteration: readings[k] } : {}),
  }));

  return [
    ...items.map((i) =>
      i.id === source.id
        ? { ...i, status: "skipped" as const, supersededByIds: created.map((c) => c.id) }
        : i
    ),
    ...created,
  ];
}

/** Undo a merge or split: drop the derived rows, revive the tombstoned sources. */
export function undoDerivation(items: ImportItem[], derivedId: string): ImportItem[] {
  const derived = items.find((i) => i.id === derivedId);
  if (!derived?.sourceIds?.length || isLocked(derived)) return items;
  const sourceIds = new Set(derived.sourceIds);
  // A split produced several rows from one source; drop all of that source's issue.
  const siblingIds = new Set(
    items.filter((i) => i.sourceIds?.some((s) => sourceIds.has(s))).map((i) => i.id)
  );
  return items
    .filter((i) => !siblingIds.has(i.id))
    .map((i) =>
      sourceIds.has(i.id)
        ? { ...i, status: "pending" as const, supersededByIds: undefined }
        : i
    );
}

/** A word created by selecting a range of the sentence, or by the "add word" button. */
export function addWordItem(
  items: ImportItem[],
  sentenceIndex: number,
  term: string,
  /** Where the row sits among its sentence's words. Defaults to the end; the gap
   *  materializer passes the run's character offset so the row lands in reading
   *  order instead. */
  opts: { order?: number; origin?: ImportWordItem["origin"] } = {}
): ImportItem[] {
  const trimmed = term.trim();
  const existingRow = items.find(
    (i) => isLive(i) && i.kind === "word" && i.sentenceIndex === sentenceIndex && i.term === trimmed
  );
  if (trimmed && existingRow) return items; // already on screen — don't duplicate
  const created: ImportWordItem = {
    id: newItemId("word"),
    kind: "word",
    sentenceIndex,
    order: opts.order ?? maxOrder(items, sentenceIndex, "word") + 1,
    status: "pending",
    origin: opts.origin ?? "manual",
    term: trimmed,
  };
  return [...items, created];
}

/**
 * Turns whatever a sentence still leaves uncovered into real word rows.
 *
 * The analysis is asked to segment exhaustively, so anything uncovered is something
 * it missed — and a highlight the user has to notice and act on is not the same as
 * the word being present. A run becomes one row even when it spans several words;
 * splitting it is a keystroke away (type a space) and guessing the boundaries here
 * would only invent a segmentation nobody asked for.
 *
 * Refuses to act on an `approximate` sentence: there the covered flags are a guess,
 * so the runs can sit on the wrong characters and the rows would be nonsense. Those
 * sentences keep the highlight and the human.
 */
export function materializeGaps(
  items: ImportItem[],
  sentenceIndex: number,
  sentenceText: string,
  language: string
): ImportItem[] {
  const { words, grammar } = sentenceItems(items, sentenceIndex);
  const coverage = sentenceCoverage(sentenceText, words, language, grammar);
  if (coverage.complete || coverage.approximate) return items;

  let next = items;
  let offset = 0;
  for (const run of coverageRuns(sentenceText, coverage)) {
    const at = offset;
    offset += run.text.length;
    if (!run.gap) continue;
    // The offset IS the order: word rows are ordered by where they start in the
    // sentence, so a gap slots into reading order without renumbering anything.
    next = addWordItem(next, sentenceIndex, run.text, { order: at, origin: "gap" });
  }
  return next;
}

export function addGrammarItem(items: ImportItem[], sentenceIndex: number): ImportItem[] {
  const created: ImportGrammarItem = {
    id: newItemId("grammar"),
    kind: "grammar",
    sentenceIndex,
    order: maxOrder(items, sentenceIndex, "grammar") + 1,
    status: "pending",
    origin: "manual",
    statement: "",
    description: "",
  };
  return [...items, created];
}

export function sessionCounts(items: ImportItem[]) {
  const live = items.filter(isLive);
  return {
    total: live.length,
    words: live.filter((i) => i.kind === "word").length,
    grammar: live.filter((i) => i.kind === "grammar").length,
    registered: live.filter((i) => i.status === "registered" || i.status === "duplicate").length,
    failed: live.filter((i) => i.status === "failed").length,
    pending: live.filter((i) => i.status === "pending").length,
  };
}

/** Flat, ordered sentence list — the accordion and the prev/next controls both
 *  need positions across paragraph boundaries. */
export function flattenSentences(paragraphs: { sentences: ImportSentence[] }[]): ImportSentence[] {
  return paragraphs.flatMap((p) => p.sentences);
}

// ---------- coverage ----------

/**
 * A character has to be accounted for when it is a letter or an ideograph.
 * Punctuation (。、！？「」…), spaces, digits and symbols are deliberately out of
 * scope — they are not vocabulary and are never asked of the analysis.
 */
function needsCoverage(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

/**
 * A term written in Latin script only counts at word boundaries. Without this the
 * English article 「a」 marks the `a` inside 「analysis」 and coverage is grossly
 * over-claimed — every sentence looks complete and the gaps are never reported.
 * Chinese/Japanese/Korean terms have no boundaries to respect, so they are matched
 * as plain substrings exactly as before.
 */
const LATIN_TERM = /^[\p{Script=Latin}\p{M}''-]+$/u;

/**
 * What breaks a Latin term's word boundary: another LATIN letter, and nothing else.
 *
 * The rule exists for one reason — stop the English article 「a」 matching inside
 * 「analysis」 — so only a letter of the same script can break it.
 *
 * NOT `\p{L}`: a Han character is a letter, so 「的GDP差」 would leave 「GDP」 with no
 * valid boundary anywhere and the term would read as absent from a sentence it is
 * plainly in. NOT digits either: Chinese runs a number straight onto an acronym
 * (「实现GDP19843亿元」, 「制造业PMI49.3%」), and digits are outside coverage scope
 * anyway. With the same predicate now deciding whether a row is misattributed, both
 * over-strict readings would flag every acronym and refuse its registration.
 */
const LATIN_NEIGHBOUR = /\p{Script=Latin}/u;

function boundedAt(sentence: string, at: number, len: number): boolean {
  const before = at > 0 ? sentence[at - 1] : "";
  const after = at + len < sentence.length ? sentence[at + len] : "";
  return !LATIN_NEIGHBOUR.test(before) && !LATIN_NEIGHBOUR.test(after);
}

/**
 * Every position in `sentence` where `term` occurs, left to right.
 *
 * A Latin-script term gets two extra rules: it matches only at word boundaries, and
 * it ignores case. Without the first, the English article 「a」 marks the `a` inside
 * 「analysis」 and coverage is so over-claimed that no sentence ever reports a gap.
 * Without the second, a sentence-initial 「The」 and the 「the」 the model listed are
 * different strings. Chinese/Japanese/Korean terms have neither property and are
 * matched as plain case-sensitive substrings, exactly as before.
 */
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

/**
 * Languages whose extracted term legitimately fails to occur verbatim, because the
 * prompt splits inflections (발표했다 → 「발표하」+「았다」, 食べました → 「食べ」+…).
 * Everywhere else a term that is not in the sentence is a term on the WRONG
 * sentence — Chinese has no inflection at all and the English prompt forbids the
 * multi-word entries that would break verbatim matching.
 *
 * MIRRORS `backend/src/import-analysis.ts` (`VERBATIM_LANGUAGES` is its complement,
 * `MIN_PREFIX` is the same constant). The server repairs a fresh analysis with these
 * rules and the client repairs a saved session with them, so the two must agree.
 */
const INFLECTED_LANGUAGES = new Set(["japanese", "korean"]);

/** Shortest prefix worth treating as evidence of an inflected form. A single
 *  character matches almost anything in CJK and would excuse any attachment. */
const MIN_PREFIX = 2;

/**
 * Whether "the term is not in this sentence" is a VERDICT rather than a guess.
 *
 * True for Chinese and English, where a mismatched row can safely have its
 * registration refused; false for Japanese and Korean, where the prompt splits
 * inflections and a row that matches nothing may still be legitimate.
 */
export function requiresVerbatimTerms(language: string): boolean {
  return !INFLECTED_LANGUAGES.has(language);
}

/** The longest prefix of `term` (down to MIN_PREFIX) that occurs in `sentence`,
 *  as the position it starts at and how many characters it covers. */
function longestPrefixIn(sentence: string, term: string): { at: number; len: number } | null {
  for (let len = term.length - 1; len >= MIN_PREFIX; len--) {
    const at = sentence.indexOf(term.slice(0, len));
    if (at !== -1) return { at, len };
  }
  return null;
}

/**
 * Whether this word row is filed under a sentence it does not belong to.
 *
 * The one predicate behind the row's warning badge, the review banner's count and
 * the repair itself, so all three can never disagree. An inflected language gets the
 * prefix benefit of the doubt; everywhere else "not a substring" is conclusive.
 */
export function wordMismatch(sentenceText: string, term: string, language: string): boolean {
  const trimmed = term.trim();
  // An empty row is a blank the user still has to fill in, not a misattribution.
  if (!trimmed) return false;
  if (termOccurrences(sentenceText, trimmed).length > 0) return false;
  if (!INFLECTED_LANGUAGES.has(language)) return true;
  return longestPrefixIn(sentenceText, trimmed) === null;
}

/**
 * The sentence a mismatched term really belongs to, with the offset it starts at.
 *
 * Sentences are tried nearest-first (ties going to the lower index) because a
 * miscount shifts a run of words by a small amount, so the intended sentence is
 * almost always a neighbour. Deterministic by construction: the server runs the
 * same search over a fresh analysis and has to reach the same answer.
 */
export function findWordHome(
  term: string,
  from: number,
  sentences: ImportSentence[],
  language: string
): { index: number; at: number } | null {
  const trimmed = term.trim();
  if (!trimmed) return null;
  const ordered = [...sentences]
    .filter((s) => s.index !== from)
    .sort((a, b) => Math.abs(a.index - from) - Math.abs(b.index - from) || a.index - b.index);
  for (const s of ordered) {
    const hits = termOccurrences(s.text ?? "", trimmed);
    if (hits.length > 0) return { index: s.index, at: hits[0] };
  }
  if (!INFLECTED_LANGUAGES.has(language)) return null;
  for (const s of ordered) {
    const prefix = longestPrefixIn(s.text ?? "", trimmed);
    if (prefix) return { index: s.index, at: prefix.at };
  }
  return null;
}

/** Live word rows sitting on a sentence they do not occur in. */
export function mismatchedWords(
  items: ImportItem[],
  sentences: ImportSentence[],
  language: string
): ImportWordItem[] {
  const textOf = new Map(sentences.map((s) => [s.index, s.text ?? ""]));
  return items.filter(
    (i): i is ImportWordItem =>
      isLive(i) &&
      i.kind === "word" &&
      wordMismatch(textOf.get(i.sentenceIndex) ?? "", i.term, language)
  );
}

/**
 * Moves every mismatched word row onto the sentence it actually occurs in.
 *
 * This is the repair path for sessions saved BEFORE the analysis started nesting
 * words inside their sentence — those hold whatever the model miscounted, and no
 * amount of prompt or schema work reaches data already on disk. It is deliberately
 * an explicit user action rather than something `load` does: autosave would persist
 * a silent bulk rewrite with no undo.
 *
 * A row whose destination already lists the same term is tombstoned instead of
 * moved — a listed term covers all of its occurrences in that sentence, so a second
 * row would be a duplicate. A row that matches nowhere is left where it is, still
 * flagged, for the user to judge.
 *
 * Gaps are re-materialized only for the sentences rows moved OUT of: those lost
 * coverage, while a sentence that gained a row cannot have gained a gap. Re-running
 * it everywhere would resurrect gap rows the user deliberately deleted, which is why
 * `load` never re-runs it at all.
 */
export function reattachMismatchedWords(
  items: ImportItem[],
  sentences: ImportSentence[],
  language: string,
  /** Repair a single row — the per-row "move" button. Omit for the bulk fix. */
  onlyItemId?: string
): ImportItem[] {
  const textOf = new Map(sentences.map((s) => [s.index, s.text ?? ""]));
  const candidates = mismatchedWords(items, sentences, language).filter(
    // A registered row has already written its example sentence; moving it now would
    // make the session claim it was registered from a sentence it never saw. It stays
    // flagged, and its registration controls stay refused.
    (i) => !isLocked(i) && (!onlyItemId || i.id === onlyItemId)
  );

  let next = items;
  const vacated = new Set<number>();
  for (const row of candidates) {
    const home = findWordHome(row.term, row.sentenceIndex, sentences, language);
    if (!home) continue;
    const term = row.term.trim();
    const occupied = next.some(
      (i) =>
        isLive(i) &&
        i.kind === "word" &&
        i.id !== row.id &&
        i.sentenceIndex === home.index &&
        i.term.trim() === term
    );
    next = next.map((i) =>
      i.id !== row.id
        ? i
        : occupied
        ? { ...i, status: "skipped" as const }
        : { ...i, sentenceIndex: home.index, order: home.at }
    );
    vacated.add(row.sentenceIndex);
  }

  for (const index of vacated) {
    next = materializeGaps(next, index, textOf.get(index) ?? "", language);
  }
  return next;
}

export interface SentenceCoverage {
  /** One flag per UTF-16 index of the sentence. */
  covered: boolean[];
  /** Characters that have to be accounted for at all. */
  required: number;
  /** …of which this many still are not. */
  missing: number;
  complete: boolean;
  /**
   * True when at least one term was matched by the inflection fallback rather than
   * found verbatim. The fallback guesses at a position, so the `covered` flags — and
   * therefore the gap runs derived from them — may sit on the wrong characters.
   * Callers that turn gaps into real rows must refuse to do so for such a sentence;
   * highlighting them for a human to judge is still fine.
   */
  approximate: boolean;
}

/**
 * Which characters of a sentence the extracted words already account for.
 *
 * The analysis is asked to segment a sentence exhaustively, so a complete
 * sentence is the normal case and a gap means something was missed — the gap is
 * highlighted so it can be selected and added. Only live word rows count;
 * grammar statements are pattern NOTATION, so neither statements nor entire excerpts
 * claim coverage. Only validated fixedElements from live grammar rows contribute.
 */
export function sentenceCoverage(
  sentence: string,
  words: ImportWordItem[],
  /** Backend full-name language ("chinese"). Only an inflected language gets the
   *  prefix fallback below — see the comment on it. */
  language: string,
  grammar: ImportGrammarItem[] = []
): SentenceCoverage {
  const covered = new Array<boolean>(sentence.length).fill(false);
  const mark = (at: number, len: number) => {
    for (let i = at; i < at + len && i < covered.length; i++) covered[i] = true;
  };
  for (const point of grammar) {
    // Only validated fixed FUNCTION elements, never the whole grammar excerpt.
    if (point.status === "skipped" || point.edited) continue;
    for (const element of point.fixedElements ?? []) {
      const { start, end } = element.range;
      if (Number.isInteger(start) && start >= 0 && end > start && end <= sentence.length &&
          sentence.slice(start, end) === element.surface && element.meaning.trim() && element.transliteration?.trim()) mark(start, end - start);
    }
  }
  const inflected = INFLECTED_LANGUAGES.has(language);

  let approximate = false;
  for (const word of words) {
    const term = word.term.trim();
    if (!term) continue;
    if (word.range && word.sourceTerm === term && word.surface && sentence.slice(word.range.start, word.range.end) === word.surface) {
      mark(word.range.start, word.range.end - word.range.start);
      continue;
    }
    // Every occurrence: a word listed once per sentence is meant to cover all of
    // its occurrences in that sentence.
    const hits = termOccurrences(sentence, term);
    for (const at of hits) mark(at, term.length);
    if (hits.length > 0) continue;

    // No hit at all. In Chinese and English that means the row is on the wrong
    // sentence — it accounts for nothing here and must not claim to. Guessing at a
    // prefix instead used to be actively harmful: a misattributed 「行政区划」 whose
    // single character 「一」 or 「约」 happened to occur marked some unrelated word as
    // covered AND set `approximate`, which makes `materializeGaps` refuse to run —
    // so one misfiled word silently voided the "every character has a row"
    // guarantee for the whole sentence.
    if (!inflected) continue;

    // Japanese and Korean genuinely inflect, so the sentence may hold 食べました
    // where the row says 食べる. Cover the longest prefix that does occur, and only
    // its first occurrence — a short prefix would over-claim, hence MIN_PREFIX.
    const prefix = longestPrefixIn(sentence, term);
    if (prefix) {
      mark(prefix.at, prefix.len);
      // The search starts from 0 rather than from where this word belongs, so the
      // prefix may well have been found on some other word. Flag the whole
      // sentence as guessed-at rather than pretending to know.
      approximate = true;
    }
  }

  let required = 0;
  let missing = 0;
  for (let i = 0; i < sentence.length; i++) {
    if (!needsCoverage(sentence[i])) continue;
    required++;
    if (!covered[i]) missing++;
  }
  return { covered, required, missing, complete: missing === 0, approximate };
}

/** The sentence split into runs so the uncovered stretches can be highlighted.
 *  `gap` is true only for characters that both need covering and lack it. */
export function coverageRuns(
  sentence: string,
  coverage: SentenceCoverage
): { text: string; gap: boolean }[] {
  const runs: { text: string; gap: boolean }[] = [];
  for (let i = 0; i < sentence.length; i++) {
    const gap = !coverage.covered[i] && needsCoverage(sentence[i]);
    const last = runs[runs.length - 1];
    if (last && last.gap === gap) last.text += sentence[i];
    else runs.push({ text: sentence[i], gap });
  }
  return runs;
}

/** Clean old analyses without deleting manual edits, merge/split history or registration claims. */
export function deduplicateImportItems(items: ImportItem[], paragraphs: ImportAnalysisResult["paragraphs"]): ImportItem[] {
  const texts = new Map(flattenSentences(paragraphs).map(s => [s.index, s.text]));
  const automatic = (row: ImportItem) => !(row.kind === "word" && row.occurrenceId) && isLive(row) && !row.edited && (row.origin === "llm" || row.origin === "gap") && !row.sourceIds?.length;
  const words = items.filter((i): i is ImportWordItem => i.kind === "word" && automatic(i));
  const result = deduplicateWords(words, i => texts.get(i) ?? "", termOccurrences,
    (a, b) => {
      let merged: ImportWordItem = { ...a, transliteration: a.transliteration || b.transliteration,
        meaning: a.meaning || b.meaning, existingWordId: a.existingWordId || b.existingWordId };
      const rank = { failed: 0, duplicate: 1, registered: 2, queued: 3 };
      for (const destination of ["A", "B"] as const) {
        const left = a.registrations?.[destination];
        const right = b.registrations?.[destination];
        const state = !left ? right : !right ? left : rank[left.status] >= rank[right.status] ? left : right;
        if (state) merged = withRegistration(merged, destination, state) as ImportWordItem;
      }
      return merged;
    },
    (a, b) => (!a.existingWordId || !b.existingWordId || a.existingWordId === b.existingWordId) &&
      (a.status === "pending" || !!a.registrations) && (b.status === "pending" || !!b.registrations) &&
      (["A", "B"] as const).every(target => {
        const left = a.registrations?.[target]?.groupIds;
        const right = b.registrations?.[target]?.groupIds;
        return !left || !right || JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
      }),
    row => row.status !== "queued");
  const byId = new Map(result.map(i => [i.id, i]));
  const candidates = new Set(words.map(i => i.id));
  const grammar = new Set<string>();
  return items.flatMap(item => {
    if (candidates.has(item.id)) {
      const retained = byId.get(item.id);
      if (retained) return [retained];
      // A contained fragment may already have been registered. Hide its extraction row
      // without erasing its registration record or deleting anything from the library.
      const mergedIntoSameTerm = item.kind === "word" && result.some(row =>
        row.sentenceIndex === item.sentenceIndex && row.term.trim() === item.term.trim());
      if (!mergedIntoSameTerm && item.kind === "word" && (item.existingWordId || item.registrations))
        return [{ ...item, status: "skipped" as const }];
      return [];
    }
    if (item.kind === "grammar" && automatic(item) && item.status === "pending" && !item.existingGrammarId && !item.registrations) {
      const key = JSON.stringify([item.sentenceIndex, item.statement.trim(), item.description.trim()]);
      if (grammar.has(key)) return [];
      grammar.add(key);
    }
    return [item];
  });
}
