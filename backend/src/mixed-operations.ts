// Mirrored in backend/src/mixed-operations.ts and frontend/src/utils/mixedOperations.ts.
import type { CombinedQuizSession, CombinedQuizQuestion } from "./types.js";
import { shuffle, weightedMerge, weightedInterleave } from "./quiz-utils.js";

export interface MixedOperation {
  kind: "word" | "grammar";
  refId: string;
  /** Absent for removal when ending a sitting without grading. */
  correct?: boolean;
  removeFromGroupB?: boolean;
}
export const UNGROUPED_A = "__ungroupedA";
const idOf = (q: CombinedQuizQuestion) => q.kind === "word" ? q.wordId : q.grammarId;

/** Rebuild effective weights using the same category/domain/group ratios on both sides. */
export function recalculateMixedWeights(session: CombinedQuizSession): void {
  const mix = session.mixWeights;
  const scope = session.mixedScope;
  if (!mix || !scope) return;
  mix.groups ??= { word: {}, grammar: {} };
  const masses = { A: { word: 0, grammar: 0 }, B: { word: 0, grammar: 0 } };
  for (const kind of ["word", "grammar"] as const) {
    const membership = (kind === "word" ? session.wordGroupMembership : session.grammarGroupMembership) ?? {};
    const b = new Set(Object.keys((kind === "word" ? scope.wordB : scope.grammarB) ?? {}));
    const raw = mix.groups[kind];
    const sums = { A: 0, B: 0 };
    for (const gid of Object.keys(membership)) {
      raw[gid] = b.has(gid) ? 1 : raw[gid] ?? 1;
      // Empty buckets must not dilute a category's configured weight.
      if (membership[gid].length) sums[b.has(gid) ? "B" : "A"] += raw[gid];
    }
    for (const cat of ["A", "B"] as const) {
      const total = mix.domain[cat].word + mix.domain[cat].grammar || 1;
      masses[cat][kind] = sums[cat] > 0 ? mix.category[cat] * mix.domain[cat][kind] / total : 0;
    }
    const weights = Object.fromEntries(Object.keys(membership).map(gid => {
      const cat = b.has(gid) ? "B" : "A";
      return [gid, raw[gid] * masses[cat][kind] / (sums[cat] || 1)];
    }));
    if (kind === "word") session.wordGroupWeights = weights;
    else session.grammarGroupWeights = weights;
  }
  const oldTotal = session.domainWeights.word + session.domainWeights.grammar || 2;
  const total = masses.A.word + masses.B.word + masses.A.grammar + masses.B.grammar || 1;
  session.domainWeights = {
    word: (masses.A.word + masses.B.word) * oldTotal / total,
    grammar: (masses.A.grammar + masses.B.grammar) * oldTotal / total,
  };
}

/** Unique pending IDs, equal chances within each bucket, and no wrong-answer priority. */
export function orderMixedQuestions(session: CombinedQuizSession, pinFirst = false): CombinedQuizSession {
  const answered = session.questions.filter(q => q.userCorrect !== undefined);
  const seen = new Set<string>();
  const pending = session.questions.filter(q => {
    const key = `${q.kind}:${idOf(q)}`;
    if (q.userCorrect !== undefined || seen.has(key)) return false;
    seen.add(key); return true;
  });
  const pinned = pinFirst ? pending.splice(0, 1) : [];
  const known = (q: CombinedQuizQuestion) => session.correctWeight !== undefined &&
    (q.kind === "word" ? session.correctMembership?.wordIds : session.correctMembership?.grammarIds)?.includes(idOf(q));
  const fresh = pending.filter(q => !known(q));
  const domain = (kind: "word" | "grammar") => {
    const candidates = fresh.filter(q => q.kind === kind);
    const membership = (kind === "word" ? session.wordGroupMembership : session.grammarGroupMembership) ?? {};
    const weights = (kind === "word" ? session.wordGroupWeights : session.grammarGroupWeights) ?? {};
    if (!Object.keys(membership).length) return shuffle(candidates);
    const claimed = new Set<string>();
    return weightedInterleave(Object.entries(membership).map(([gid, ids]) => ({
      weight: weights[gid] ?? 1,
      items: candidates.filter(q => {
        const id = idOf(q);
        if (!ids.includes(id) || claimed.has(id)) return false;
        claimed.add(id); return true;
      }),
    })));
  };
  const ordered = weightedMerge<CombinedQuizQuestion>([
    { weight: session.domainWeights.word, items: domain("word") },
    { weight: session.domainWeights.grammar, items: domain("grammar") },
    { weight: session.correctWeight ?? 0, items: shuffle(pending.filter(known)) },
  ]);
  const covered = new Set(ordered);
  const questions = [...answered, ...pinned, ...ordered, ...shuffle(pending.filter(q => !covered.has(q)))];
  return { ...session, questions, score: { ...session.score, total: questions.length } };
}

/** Home is resolved from real group documents by the server, never trusted from the client. */
export function applyMixedOperation(
  original: CombinedQuizSession, operation: MixedOperation, home?: string,
): CombinedQuizSession {
  const session = structuredClone(original);
  const { kind, refId, correct, removeFromGroupB } = operation;
  const matches = (q: CombinedQuizQuestion) => q.kind === kind && idOf(q) === refId;
  const question = session.questions.find(q => q.userCorrect === undefined && matches(q));
  if (!question) throw new Error("Question is not pending in this session");
  const scope = session.mixedScope;
  if (removeFromGroupB && scope) {
    home ??= (kind === "word" ? scope.wordAHomes : scope.grammarAHomes)?.[refId] ?? UNGROUPED_A;
    const b = (kind === "word" ? scope.wordB : scope.grammarB) ?? {};
    const membership = (kind === "word" ? session.wordGroupMembership : session.grammarGroupMembership) ?? {};
    for (const [gid, ids] of Object.entries(b)) {
      b[gid] = ids.filter(id => id !== refId);
      membership[gid] = (membership[gid] ?? []).filter(id => id !== refId);
    }
    // One exclusive A sampling home even if grammar has multiple A memberships.
    for (const gid of Object.keys(membership)) membership[gid] = membership[gid].filter(id => id !== refId);
    membership[home] = [...(membership[home] ?? []), refId];
    const retained = kind === "word" ? scope.retainedWordA ??= {} : scope.retainedGrammarA ??= {};
    retained[home] = [...new Set([...(retained[home] ?? []), refId])];
    if (kind === "word") session.wordGroupMembership = membership;
    else session.grammarGroupMembership = membership;
    recalculateMixedWeights(session);
  }
  if (correct !== undefined) {
    question.userCorrect = correct;
    // Old sessions may contain duplicate pending retries. Keep history, only one future slot.
    session.questions = session.questions.filter(q => q === question || q.userCorrect !== undefined || !matches(q));
    if (correct) session.score.correct++;
    else {
      const retry = { ...question }; delete retry.userCorrect;
      session.questions.push(retry);
      if (session.correctMembership) {
        const field = kind === "word" ? "wordIds" : "grammarIds";
        session.correctMembership[field] = session.correctMembership[field].filter(id => id !== refId);
      }
    }
  }
  const result = orderMixedQuestions(session, correct === undefined);
  if (result.questions.every(q => q.userCorrect !== undefined)) {
    result.status = "completed";
    result.completedAt = new Date().toISOString();
  }
  return result;
}
