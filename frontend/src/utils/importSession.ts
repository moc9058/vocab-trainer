import type {
  ImportAnalysisResult,
  ImportGrammarItem,
  ImportItem,
  ImportSentence,
  ImportWordItem,
} from "../types";

/** Rows the user has removed or that a merge/split consumed are kept as
 *  tombstones, so "live" means everything still on screen. */
export function isLive(item: ImportItem): boolean {
  return item.status !== "skipped";
}

/** An item is locked against editing once it has been handed to the queue —
 *  editing a term after registration would silently disagree with the DB. */
export function isLocked(item: ImportItem): boolean {
  return item.status === "queued" || item.status === "registered" || item.status === "duplicate";
}

export function newItemId(kind: "word" | "grammar"): string {
  return `${kind === "word" ? "wi" : "gi"}-${crypto.randomUUID()}`;
}

/** Flattens a fresh analysis into the session's single working list. */
export function buildImportItems(
  analysis: ImportAnalysisResult,
  existing: Record<string, string>
): ImportItem[] {
  const words: ImportItem[] = analysis.words.map((w, i) => {
    const term = w.term.trim();
    return {
      id: newItemId("word"),
      kind: "word",
      sentenceIndex: w.sentenceIndex,
      order: i,
      status: "pending",
      origin: "llm",
      term,
      ...(w.transliteration?.trim() ? { transliteration: w.transliteration.trim() } : {}),
      ...(w.meaning?.trim() ? { meaning: w.meaning.trim() } : {}),
      ...(existing[term] ? { existingWordId: existing[term] } : {}),
    } satisfies ImportWordItem;
  });
  const grammar: ImportItem[] = analysis.grammar.map((g, i) => ({
    id: newItemId("grammar"),
    kind: "grammar",
    sentenceIndex: g.sentenceIndex,
    order: i,
    status: "pending",
    origin: "llm",
    statement: g.statement.trim(),
    description: (g.description ?? "").trim(),
  } satisfies ImportGrammarItem));
  return [...words, ...grammar];
}

export function sentenceItems(items: ImportItem[], sentenceIndex: number) {
  const live = items.filter((i) => isLive(i) && i.sentenceIndex === sentenceIndex);
  const byOrder = (a: ImportItem, b: ImportItem) => a.order - b.order;
  return {
    words: live.filter((i): i is ImportWordItem => i.kind === "word").sort(byOrder),
    grammar: live.filter((i): i is ImportGrammarItem => i.kind === "grammar").sort(byOrder),
  };
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
  const term = sentenceSpanForTerms(sentence, terms);
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
  term: string
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
    order: maxOrder(items, sentenceIndex, "word") + 1,
    status: "pending",
    origin: "manual",
    term: trimmed,
  };
  return [...items, created];
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

export interface SentenceCoverage {
  /** One flag per UTF-16 index of the sentence. */
  covered: boolean[];
  /** Characters that have to be accounted for at all. */
  required: number;
  /** …of which this many still are not. */
  missing: number;
  complete: boolean;
}

/**
 * Which characters of a sentence the extracted words already account for.
 *
 * The analysis is asked to segment a sentence exhaustively, so a complete
 * sentence is the normal case and a gap means something was missed — the gap is
 * highlighted so it can be selected and added. Only live word rows count;
 * grammar rows are pattern NOTATION (「随着～，越来越～」) rather than a substring of
 * the sentence, so they cannot be matched positionally and never contribute.
 */
export function sentenceCoverage(sentence: string, words: ImportWordItem[]): SentenceCoverage {
  const covered = new Array<boolean>(sentence.length).fill(false);
  const mark = (at: number, len: number) => {
    for (let i = at; i < at + len && i < covered.length; i++) covered[i] = true;
  };

  for (const word of words) {
    const term = word.term.trim();
    if (!term) continue;
    // Every occurrence: a word listed once per sentence is meant to cover all of
    // its occurrences in that sentence.
    let hit = false;
    for (let at = sentence.indexOf(term); at !== -1; at = sentence.indexOf(term, at + 1)) {
      mark(at, term.length);
      hit = true;
    }
    if (hit) continue;
    // The model may still hand back a dictionary form where the sentence has an
    // inflected one (食べる vs 食べました). Cover the longest prefix that does occur,
    // and only its first occurrence — a short prefix would otherwise over-claim.
    // Chinese has no inflection, so this branch never runs there.
    for (let len = term.length - 1; len >= 1; len--) {
      const at = sentence.indexOf(term.slice(0, len));
      if (at !== -1) {
        mark(at, len);
        break;
      }
    }
  }

  let required = 0;
  let missing = 0;
  for (let i = 0; i < sentence.length; i++) {
    if (!needsCoverage(sentence[i])) continue;
    required++;
    if (!covered[i]) missing++;
  }
  return { covered, required, missing, complete: missing === 0 };
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
