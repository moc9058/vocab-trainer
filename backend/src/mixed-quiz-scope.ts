import type { CombinedQuizSession, CombinedQuizQuestion, WordGroup, GrammarGroup, Word, Grammar } from './types.js';

type Membership = Record<string, string[]>;
/** Capture the fixed A selection once; the B pool is always reconstructed from live groups. */
export function initializeMixedScope(session: CombinedQuizSession, words: WordGroup[], grammar: GrammarGroup[], selection?: { word?: string[]; grammar?: string[] }): void {
  if (session.mixedScope) return;
  const snapshot = (groups: { id: string; category?: string; ids: string[] }[], selected: string[] | undefined, prior: Membership | undefined) => {
    const ids = new Set(selected ?? (prior ? Object.keys(prior) : groups.filter(g => g.category !== 'B').map(g => g.id)));
    const originalIds = new Set(session.questions.map(q => q.kind === 'word' ? q.wordId : q.grammarId));
    return Object.fromEntries(groups.filter(g => g.category !== 'B' && ids.has(g.id)).map(g => [g.id, selected ? g.ids : g.ids.filter(id => originalIds.has(id))]));
  };
  session.mixedScope = {
    version: 1,
    wordA: snapshot(words.map(g => ({ ...g, ids: g.wordIds })), selection?.word, session.wordGroupMembership),
    grammarA: snapshot(grammar.map(g => ({ ...g, ids: g.grammarIds })), selection?.grammar, session.grammarGroupMembership),
  };
  // Older sessions did not retain the original category ratios. Recover the ratios
  // represented by their effective domain/group weights before normalizing B groups.
  if (!session.mixWeights) {
    const mass = (groups: { id: string; category?: string }[], membership: Membership | undefined, weights: Record<string, number> | undefined, domain: number) => {
      const sums = { A: 0, B: 0 };
      for (const g of groups) if (membership?.[g.id]) sums[g.category === 'B' ? 'B' : 'A'] += weights?.[g.id] ?? 1;
      const total = sums.A + sums.B || 1;
      return { A: domain * sums.A / total, B: domain * sums.B / total };
    };
    const w = mass(words, session.wordGroupMembership, session.wordGroupWeights, session.domainWeights.word);
    const g = mass(grammar, session.grammarGroupMembership, session.grammarGroupWeights, session.domainWeights.grammar);
    session.mixWeights = {
      category: { A: w.A + g.A || 1, B: w.B + g.B || 1 },
      domain: { A: { word: w.A, grammar: g.A }, B: { word: w.B || 1, grammar: g.B || 1 } },
      groups: { word: { ...session.wordGroupWeights }, grammar: { ...session.grammarGroupWeights } },
    };
  }
  session.mixWeights.groups ??= { word: { ...session.wordGroupWeights }, grammar: { ...session.grammarGroupWeights } };
}

/** Reconcile only the pending pool; answered attempts and outstanding retries survive. */
export function reconcileMixedScope(session: CombinedQuizSession, wordGroups: WordGroup[], grammarGroups: GrammarGroup[], words: Word[], grammar: Grammar[], mastered?: { wordIds: string[]; grammarIds: string[] }): void {
  const scope = session.mixedScope!;
  const mix = session.mixWeights!;
  const wordById = new Map(words.map(w => [w.id, w]));
  const grammarById = new Map(grammar.map(g => [g.id, g]));
  const build = (a: Membership, groups: { id: string; ids: string[] }[], exists: (id: string) => boolean) => {
    const seen = new Set<string>();
    const result: Membership = {};
    for (const [gid, ids] of [...groups.map(g => [g.id, g.ids] as const), ...Object.entries(a)]) {
      result[gid] = ids.filter(id => {
        if (!exists(id) || seen.has(id)) return false;
        seen.add(id); return true;
      });
    }
    return result;
  };
  session.wordGroupMembership = build(scope.wordA, wordGroups.filter(g => g.category === 'B').map(g => ({ id: g.id, ids: g.wordIds })), id => wordById.has(id));
  session.grammarGroupMembership = build(scope.grammarA, grammarGroups.filter(g => g.category === 'B').map(g => ({ id: g.id, ids: g.grammarIds })), id => grammarById.has(id));
  const wordIds = new Set(Object.values(session.wordGroupMembership).flat());
  const grammarIds = new Set(Object.values(session.grammarGroupMembership).flat());
  const key = (q: CombinedQuizQuestion) => q.kind === 'word' ? `w:${q.wordId}` : `g:${q.grammarId}`;
  session.questions = session.questions.filter(q => q.userCorrect !== undefined || (q.kind === 'word' ? wordIds.has(q.wordId) : grammarIds.has(q.grammarId)));
  const enabled = (id: string, kind: 'word' | 'grammar') => {
    const known = kind === 'word' ? mastered?.wordIds : mastered?.grammarIds;
    if (session.correctWeight !== undefined && known?.includes(id)) return session.correctWeight > 0;
    const membership = kind === 'word' ? session.wordGroupMembership! : session.grammarGroupMembership!;
    const groups = kind === 'word' ? wordGroups : grammarGroups;
    const gid = Object.keys(membership).find(gid => membership[gid].includes(id));
    const cat = groups.find(g => g.id === gid)?.category === 'B' ? 'B' : 'A';
    return mix.category[cat] > 0 && mix.domain[cat][kind] > 0 && (cat === 'B' || (mix.groups?.[kind][gid!] ?? 1) > 0);
  };
  const seen = new Set(session.questions.map(key));
  const addedWords: string[] = [], addedGrammar: string[] = [];
  for (const id of wordIds) if (!seen.has(`w:${id}`) && enabled(id, 'word')) {
    const w = wordById.get(id)!;
    session.questions.push({ kind: 'word', wordId: id, term: w.term, definitions: w.definitions });
    addedWords.push(id);
  }
  for (const id of grammarIds) if (!seen.has(`g:${id}`) && enabled(id, 'grammar')) {
    session.questions.push({ kind: 'grammar', grammarId: id, statement: grammarById.get(id)!.statement });
    addedGrammar.push(id);
  }
  if (session.correctWeight !== undefined) {
    const previous = session.correctMembership ?? { wordIds: [], grammarIds: [] };
    session.correctMembership = {
      wordIds: [...new Set([...previous.wordIds.filter(id => wordIds.has(id)), ...addedWords.filter(id => mastered?.wordIds.includes(id))])],
      grammarIds: [...new Set([...previous.grammarIds.filter(id => grammarIds.has(id)), ...addedGrammar.filter(id => mastered?.grammarIds.includes(id))])],
    };
  }
  const bWords = new Set(wordGroups.filter(g => g.category === 'B').map(g => g.id));
  const bGrammar = new Set(grammarGroups.filter(g => g.category === 'B').map(g => g.id));
  const mass = { A: { word: 0, grammar: 0 }, B: { word: 0, grammar: 0 } };
  for (const cat of ['A', 'B'] as const) {
    const total = mix.domain[cat].word + mix.domain[cat].grammar || 1;
    for (const k of ['word', 'grammar'] as const) {
      const membership = k === 'word' ? session.wordGroupMembership : session.grammarGroupMembership;
      const b = k === 'word' ? bWords : bGrammar;
      const represented = Object.keys(membership).some(id => (b.has(id) ? 'B' : 'A') === cat);
      mass[cat][k] = represented ? mix.category[cat] * mix.domain[cat][k] / total : 0;
    }
  }
  const oldTotal = session.domainWeights.word + session.domainWeights.grammar || 2;
  const totalMass = mass.A.word + mass.B.word + mass.A.grammar + mass.B.grammar || 1;
  session.domainWeights = { word: (mass.A.word + mass.B.word) * oldTotal / totalMass, grammar: (mass.A.grammar + mass.B.grammar) * oldTotal / totalMass };
  mix.groups ??= { word: {}, grammar: {} };
  for (const k of ['word', 'grammar'] as const) {
    const membership = k === 'word' ? session.wordGroupMembership : session.grammarGroupMembership;
    const b = k === 'word' ? bWords : bGrammar;
    const raw = mix.groups[k];
    const sums = { A: 0, B: 0 };
    for (const gid of Object.keys(membership)) {
      if (b.has(gid)) raw[gid] = 1;
      else raw[gid] ??= 1;
      sums[b.has(gid) ? 'B' : 'A'] += raw[gid];
    }
    const weights = Object.fromEntries(Object.keys(membership).map(gid => {
      const cat = b.has(gid) ? 'B' : 'A';
      return [gid, raw[gid] * mass[cat][k] / (sums[cat] || 1)];
    }));
    if (k === 'word') session.wordGroupWeights = weights;
    else session.grammarGroupWeights = weights;
  }
  session.score.total = session.questions.length;
  session.initialTotal = new Set(session.questions.map(key)).size;
  if (session.questions.some(q => q.userCorrect === undefined)) {
    session.status = 'in-progress'; delete session.completedAt;
  } else {
    session.status = 'completed'; session.completedAt ??= new Date().toISOString();
  }
}
