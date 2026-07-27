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
 * `transliteration` survives only if EVERY source had one — half a reading is
 * worse than none. `meaning` is always dropped: a compound's gloss is not the sum
 * of its parts, and smart-add supplies the real definitions at registration.
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

  const readings = ordered.map((s) => s.transliteration?.trim()).filter(Boolean) as string[];
  const merged: ImportWordItem = {
    id: newItemId("word"),
    kind: "word",
    sentenceIndex: ordered[0].sentenceIndex,
    order: ordered[0].order,
    status: "pending",
    origin: "merge",
    sourceIds,
    term: sentenceSpanForTerms(sentence, ordered.map((s) => s.term)),
    ...(readings.length === ordered.length ? { transliteration: readings.join(" ") } : {}),
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
export function splitWordItem(items: ImportItem[], id: string, parts: string[]): ImportItem[] {
  const source = items.find(
    (i): i is ImportWordItem => i.kind === "word" && i.id === id && isLive(i) && !isLocked(i)
  );
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  if (!source || clean.length < 2) return items;

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
