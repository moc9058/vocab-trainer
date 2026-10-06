import type { CombinedQuizSession } from "../types";

/** Display membership is inclusive (B is a subset of A), unlike sampling membership. */
export function mixedCategoryProgress(session: CombinedQuizSession) {
  const seen = { word: new Set<string>(), grammar: new Set<string>() };
  const pending = { word: new Set<string>(), grammar: new Set<string>() };
  for (const q of session.questions) {
    const id = q.kind === "word" ? q.wordId : q.grammarId;
    seen[q.kind].add(id);
    if (q.userCorrect === undefined) pending[q.kind].add(id);
  }
  return (["A", "B"] as const).map(category => ({
    category,
    cells: (["word", "grammar"] as const).map(kind => {
      const b = new Set(Object.values((kind === "word" ? session.mixedScope?.wordB : session.mixedScope?.grammarB) ?? {}).flat());
      const ids = [...seen[kind]].filter(id => category === "A" || b.has(id));
      return { kind, total: ids.length, remaining: ids.filter(id => pending[kind].has(id)).length };
    }),
  }));
}
