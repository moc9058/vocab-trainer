import { randomUUID } from "node:crypto";
import { rebaseReadingAnalysis } from "./import-reading-analysis.js";
import { termOccurrences } from "./import-analysis.js";
import type { ImportAnalysisResult, ImportItem, ImportSession } from "./types.js";

/** Prefer complete sentences/paragraphs; bound pathological long sentences without splitting surrogate pairs. */
export function splitImportSource(source: string, target = 300): string[] {
  const units = source.match(/[^。！？!?\n]*[。！？!?]+[」』”’"']*|[^。！？!?\n]+\n+|[^。！？!?\n]+$|\n+/gu) ?? [source];
  const pieces: string[] = [];
  let pending = "";
  function flush() { if (pending) pieces.push(pending); pending = ""; }
  for (const unit of units) {
    if (pending.length + unit.length > target && pending) flush();
    if (unit.length <= target) { pending += unit; continue; }
    let rest = unit;
    while (rest.length > target) {
      // Clause/space boundaries are preferable to a hard cut in an unusually long sentence.
      const prefix = rest.slice(0, target);
      const boundary = Math.max(prefix.lastIndexOf("，"), prefix.lastIndexOf("；"), prefix.lastIndexOf(","), prefix.lastIndexOf(" "));
      let at = boundary > target / 2 ? boundary + 1 : target;
      if (/[\uD800-\uDBFF]/u.test(rest[at - 1])) at--;
      pending += rest.slice(0, at); flush(); rest = rest.slice(at);
    }
    pending += rest;
  }
  flush();
  if (pieces.join("") !== source) throw new Error("Source partition did not preserve the original text");
  return pieces;
}

export class ImportCheckpointError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

/** Build only new candidates. Existing rows, registrations, groups and edit history are untouched. */
export function appendImportPart(session: ImportSession, expected: number, analysis: ImportAnalysisResult,
  existing: Record<string, string>, existingGrammar: Record<string, string>): ImportSession {
  const progress = session.analysisProgress;
  if (!progress || progress.nextChunk < expected) throw new ImportCheckpointError(409, "Reload the article before continuing analysis.");
  if (progress.nextChunk > expected) return session; // A lost response/concurrent replay already committed.
  if (session.activeRevisionId) throw new ImportCheckpointError(409, "A revision is running.");
  const base = session.paragraphs.flatMap(p => p.sentences).reduce((max, s) => Math.max(max, s.index + 1), 0);
  const paragraphs = analysis.paragraphs.map(p => ({ sentences: p.sentences.map(s => ({ index: s.index + base, text: s.text, ...(s.translation ? { translation: s.translation } : {}), ...(s.readingAnalysis ? { readingAnalysis: rebaseReadingAnalysis(s.readingAnalysis, base) } : {}) })) }));
  const texts = new Map(analysis.paragraphs.flatMap(p => p.sentences).map(s => [s.index, s.text]));
  const additions: ImportItem[] = [];
  const covered = new Map<number, boolean[]>();
  const approximate = new Set<number>();
  for (const word of analysis.words) {
    const text = texts.get(word.sentenceIndex) ?? "";
    const range = word.range;
    const flags = covered.get(word.sentenceIndex) ?? new Array<boolean>(text.length).fill(false);
    covered.set(word.sentenceIndex, flags);
    const hits = termOccurrences(text, word.term);
    if (range && text.slice(range.start, range.end) === word.surface) {
      flags.fill(true, range.start, range.end);
    } else {
      for (const start of hits) flags.fill(true, start, start + word.term.length);
      if (!hits.length && ["japanese", "korean"].includes(session.language)) approximate.add(word.sentenceIndex);
    }
    const fixed = analysis.grammar.some(point => point.sentenceIndex === word.sentenceIndex && point.fixedElements?.some(element => range
      && element.range.start === range.start && element.range.end === range.end && element.surface === word.surface));
    if (fixed) continue;
    additions.push({ ...word, id: `wi-${randomUUID()}`, kind: "word", status: "pending", origin: "llm",
      sentenceIndex: word.sentenceIndex + base, order: range?.start ?? hits[0] ?? additions.length,
      ...(word.occurrenceId ? { occurrenceId: word.occurrenceId.replace(/^s\d+-/, `s${word.sentenceIndex + base}-`) } : {}),
      ...(existing[word.term.trim()] ? { existingWordId: existing[word.term.trim()] } : {}) });
  }
  for (const point of analysis.grammar) additions.push({ id: `gi-${randomUUID()}`, kind: "grammar", status: "pending", origin: "llm",
    sentenceIndex: point.sentenceIndex + base, order: additions.length, statement: point.statement, description: point.description,
    ...(point.constructionId ? { constructionId: point.constructionId.replace(/^s(\d+)-/, (_match, index) => `s${Number(index) + base}-`), fixedElements: point.fixedElements } : {}),
    ...(point.excerpt ? { excerpt: point.excerpt } : {}), ...(point.explanationLanguage ? { explanationLanguage: point.explanationLanguage } : {}),
    ...(existingGrammar[point.statement] ? { existingGrammarId: existingGrammar[point.statement] } : {}) });
  // Same coverage backstop as the client: unknown contiguous letters become editable gap rows.
  for (const [index, text] of texts) {
    if (approximate.has(index)) continue;
    const flags = covered.get(index) ?? [];
    let start = -1;
    for (let at = 0; at <= text.length; at++) {
      const gap = at < text.length && !flags[at] && /\p{L}/u.test(text[at]);
      if (gap && start < 0) start = at;
      if (!gap && start >= 0) {
        additions.push({ id: `wi-${randomUUID()}`, kind: "word", status: "pending", origin: "gap", sentenceIndex: index + base,
          order: start, term: text.slice(start, at) }); start = -1;
      }
    }
  }
  let joined = [...session.paragraphs, ...paragraphs];
  const separator = (progress.chunks[expected - 1]?.match(/\s*$/u)?.[0] ?? "") + (progress.chunks[expected]?.match(/^\s*/u)?.[0] ?? "");
  if (expected > 0 && session.paragraphs.length && paragraphs.length && !separator.includes("\n")) {
    const last = session.paragraphs[session.paragraphs.length - 1];
    joined = [...session.paragraphs.slice(0, -1), { ...last, sentences: [...last.sentences, ...paragraphs[0].sentences] }, ...paragraphs.slice(1)];
  }
  const next = { ...session, contentRevision: (session.contentRevision ?? 0) + 1, paragraphs: joined, items: [...session.items, ...additions],
    analysisProgress: { ...progress, nextChunk: expected + 1 }, updatedAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(next), "utf8") > 900_000) throw new ImportCheckpointError(413, "Article is too large to save. Import the remaining text in a separate article.");
  return next;
}

/** Retry a timed-out part at a smaller size without redoing completed work. */
export function subdivideImportPart(session: ImportSession, expected: number, source: string): ImportSession {
  const progress = session.analysisProgress;
  if (!progress || progress.nextChunk !== expected || progress.chunks[expected] !== source || source.length <= 120) return session;
  let at = Math.floor(source.length / 2);
  const prefix = source.slice(0, at);
  const boundary = Math.max(prefix.lastIndexOf("。"), prefix.lastIndexOf("，"), prefix.lastIndexOf("；"), prefix.lastIndexOf(" "));
  if (boundary > at / 2) at = boundary + 1;
  if (/[\uD800-\uDBFF]/u.test(source[at - 1])) at--;
  return { ...session, analysisProgress: { ...progress,
    chunks: [...progress.chunks.slice(0, expected), source.slice(0, at), source.slice(at), ...progress.chunks.slice(expected + 1)] }, updatedAt: new Date().toISOString() };
}
