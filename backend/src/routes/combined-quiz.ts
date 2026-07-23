import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getFilteredWords,
  getWordsByIds,
  getWordProgress,
  updateWordProgress,
  getProgressForLanguage,
  flagWord,
  getWordGroup,
  getAllGrammarItems,
  getGrammarGroup,
  getGrammarComponentProgress,
  updateGrammarComponentProgress,
  getGrammarProgressForLanguage,
  getCombinedQuizSession,
  saveCombinedQuizSession,
} from "../firestore.js";
import type {
  CombinedQuizQuestion,
  CombinedQuizSession,
  CombinedQuizWordQuestion,
  CombinedQuizGrammarQuestion,
  Grammar,
  Word,
  WordProgress,
} from "../types.js";
import { shuffle, weightedInterleave, weightedMerge, insertRetryQuestion, isMastered } from "../quiz-utils.js";

interface WordFilterBody {
  topics?: string[];
  categories?: string[];
  levels?: string[];
  groupIds?: string[];
  groupWeights?: Record<string, number>;
  flaggedOnly?: boolean;
}

interface GrammarFilterBody {
  groupIds?: string[];
  groupWeights?: Record<string, number>;
}

const combinedQuizRoutes: FastifyPluginAsync = async (fastify) => {
  // Start a combined session: each domain is ordered internally by group weights
  // (words exactly like /api/quiz, grammar analogously), then the two streams are
  // merged by the word/grammar domain weights.
  fastify.post<{
    Body: {
      language: string;
      domainWeights?: { word?: number; grammar?: number };
      correctWeight?: number;
      word?: WordFilterBody;
      grammar?: GrammarFilterBody;
    };
  }>(
    "/start",
    {
      schema: {
        body: {
          type: "object",
          required: ["language"],
          properties: {
            language: { type: "string" },
            domainWeights: {
              type: "object",
              properties: {
                word: { type: "number", minimum: 0 },
                grammar: { type: "number", minimum: 0 },
              },
            },
            correctWeight: { type: "number", minimum: 0 },
            word: {
              type: "object",
              properties: {
                topics: { type: "array", items: { type: "string" } },
                categories: { type: "array", items: { type: "string" } },
                levels: { type: "array", items: { type: "string" } },
                groupIds: { type: "array", items: { type: "string" } },
                groupWeights: { type: "object", additionalProperties: { type: "number" } },
                flaggedOnly: { type: "boolean" },
              },
            },
            grammar: {
              type: "object",
              properties: {
                groupIds: { type: "array", items: { type: "string" } },
                groupWeights: { type: "object", additionalProperties: { type: "number" } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, domainWeights, correctWeight, word, grammar } = request.body;
      const wordWeight = Math.max(0, domainWeights?.word ?? 1);
      const grammarWeight = Math.max(0, domainWeights?.grammar ?? 1);
      const useCorrect = correctWeight !== undefined;
      if (wordWeight <= 0 && grammarWeight <= 0 && (correctWeight ?? 0) <= 0) {
        return reply.badRequest("At least one of the word/grammar/already-correct weights must be positive");
      }

      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }

      const toWordQuestion = (w: Word): CombinedQuizWordQuestion => ({
        kind: "word",
        wordId: w.id,
        term: w.term,
        definitions: w.definitions,
        transliteration: w.transliteration,
        examples: w.examples,
        ...(w.hanjaReadings ? { hanjaReadings: w.hanjaReadings } : {}),
      });
      const toGrammarQuestion = (item: Grammar): CombinedQuizGrammarQuestion => ({
        kind: "grammar",
        grammarId: item.id,
        statement: item.statement,
      });

      // Load long-term progress only when partitioning mastered items into their own bucket.
      const [wordProgress, grammarProgress] = useCorrect
        ? await Promise.all([getProgressForLanguage(language), getGrammarProgressForLanguage(language)])
        : [null, null];

      // --- Word side: mirror /api/quiz/start ordering (fresh pool only when partitioning) ---
      let wordQuestions: CombinedQuizWordQuestion[] = [];
      let wordGroupMembership: Record<string, string[]> | undefined;
      let knownWordItems: Word[] = [];
      if (wordWeight > 0 || useCorrect) {
        const pool = await getFilteredWords(language, {
          topics: word?.topics,
          categories: word?.categories,
          levels: word?.levels,
          groupIds: word?.groupIds,
          flaggedOnly: word?.flaggedOnly,
        });
        let freshPool = pool;
        if (useCorrect) {
          knownWordItems = pool.filter((w) => isMastered(wordProgress!.words[w.id]));
          freshPool = pool.filter((w) => !isMastered(wordProgress!.words[w.id]));
        }
        if (wordWeight > 0) {
          let ordered: Word[];
          if (word?.groupIds && word.groupIds.length > 0) {
            const membership = await buildWordMembership(word.groupIds, freshPool);
            ordered = weightedInterleave(
              word.groupIds.map((id) => ({
                weight: word.groupWeights?.[id] ?? 1,
                items: membership[id] ?? [],
              }))
            );
            wordGroupMembership = Object.fromEntries(
              Object.entries(membership).map(([id, ws]) => [id, ws.map((w) => w.id)])
            );
          } else {
            ordered = shuffle(freshPool);
          }
          wordQuestions = ordered.map(toWordQuestion);
        }
      }

      // --- Grammar side: group-weighted like the word side (grammar groups gain weights here) ---
      let grammarQuestions: CombinedQuizGrammarQuestion[] = [];
      let grammarGroupMembership: Record<string, string[]> | undefined;
      let knownGrammarItems: Grammar[] = [];
      if (grammarWeight > 0 || useCorrect) {
        const pool = await getAllGrammarItems(language);
        let freshPool = pool;
        if (useCorrect) {
          knownGrammarItems = pool.filter((it) => isMastered(grammarProgress![it.id]));
          freshPool = pool.filter((it) => !isMastered(grammarProgress![it.id]));
        }
        if (grammarWeight > 0) {
          let ordered: Grammar[];
          if (grammar?.groupIds && grammar.groupIds.length > 0) {
            const membership = await buildGrammarMembership(grammar.groupIds, freshPool);
            ordered = weightedInterleave(
              grammar.groupIds.map((id) => ({
                weight: grammar.groupWeights?.[id] ?? 1,
                items: membership[id] ?? [],
              }))
            );
            grammarGroupMembership = Object.fromEntries(
              Object.entries(membership).map(([id, gs]) => [id, gs.map((g) => g.id)])
            );
          } else {
            ordered = shuffle(freshPool);
          }
          // The question is the grammar element itself; descriptions/examples are
          // fetched by the client on answer reveal.
          grammarQuestions = ordered.map(toGrammarQuestion);
        }
      }

      // Mastered items from BOTH domains form one top-level bucket, peer to word/grammar.
      const knownQuestions: CombinedQuizQuestion[] = useCorrect
        ? shuffle([...knownWordItems.map(toWordQuestion), ...knownGrammarItems.map(toGrammarQuestion)])
        : [];

      const buckets: { weight: number; items: CombinedQuizQuestion[] }[] = [
        { weight: wordWeight, items: wordQuestions },
        { weight: grammarWeight, items: grammarQuestions },
      ];
      if (useCorrect) buckets.push({ weight: correctWeight ?? 0, items: knownQuestions });
      const questions: CombinedQuizQuestion[] = weightedMerge<CombinedQuizQuestion>(buckets);

      if (questions.length === 0) {
        return reply.badRequest("No words or grammar items match the given filters");
      }

      const session: CombinedQuizSession = {
        sessionId: language,
        language,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        score: { correct: 0, total: questions.length },
        questions,
        domainWeights: { word: wordWeight, grammar: grammarWeight },
        initialTotal: questions.length,
        ...(word?.groupWeights ? { wordGroupWeights: word.groupWeights } : {}),
        ...(wordGroupMembership ? { wordGroupMembership } : {}),
        ...(grammar?.groupWeights ? { grammarGroupWeights: grammar.groupWeights } : {}),
        ...(grammarGroupMembership ? { grammarGroupMembership } : {}),
        ...(useCorrect
          ? {
              correctWeight,
              correctMembership: {
                wordIds: knownWordItems.map((w) => w.id),
                grammarIds: knownGrammarItems.map((g) => g.id),
              },
            }
          : {}),
        ...(word?.flaggedOnly ? { flaggedOnly: true } : {}),
      };

      await saveCombinedQuizSession(session);
      // Lightweight response: word questions carry only {kind, wordId, term}; the client
      // pages GET /questions/:language for definitions/examples. Grammar questions are small
      // (grammarId + statement) and returned as-is.
      return reply.status(201).send({
        ...session,
        questions: session.questions.map((q) =>
          q.kind === "word" ? { kind: "word", wordId: q.wordId, term: q.term } : q
        ),
      });
    }
  );

  // Batch-fetch hydrated questions (word questions get definitions/examples/hanja).
  fastify.get<{
    Params: { language: string };
    Querystring: { offset?: number; limit?: number };
  }>(
    "/questions/:language",
    {
      schema: {
        params: {
          type: "object",
          required: ["language"],
          properties: { language: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            offset: { type: "number", minimum: 0 },
            limit: { type: "number", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const offset = request.query.offset ?? 0;
      const limit = request.query.limit ?? 50;

      const session = await getCombinedQuizSession(language);
      if (!session) return reply.notFound("No combined quiz session found for this language");

      const slice = session.questions.slice(offset, offset + limit);
      const wordIds = slice.filter((q) => q.kind === "word").map((q) => (q as CombinedQuizWordQuestion).wordId);
      const wordsData = wordIds.length > 0 ? await getWordsByIds(wordIds) : [];
      const wordMap = new Map(wordsData.map((w) => [w.id, w]));

      const hydrated: CombinedQuizQuestion[] = slice.map((q) => {
        if (q.kind !== "word") return q;
        const word = wordMap.get(q.wordId);
        return {
          kind: "word" as const,
          wordId: q.wordId,
          term: word?.term ?? q.term,
          definitions: word?.definitions ?? [],
          transliteration: word?.transliteration,
          examples: word?.examples ?? [],
          ...(q.userCorrect !== undefined ? { userCorrect: q.userCorrect } : {}),
          ...(word?.hanjaReadings ? { hanjaReadings: word.hanjaReadings } : {}),
        };
      });

      return { questions: hydrated, total: session.questions.length };
    }
  );

  // Submit answer for either kind; wrong answers are re-queued into the tail.
  fastify.post<{
    Body: {
      language: string;
      kind: "word" | "grammar";
      refId: string;
      correct: boolean;
      flagWordIds?: string[];
    };
  }>(
    "/answer",
    {
      schema: {
        body: {
          type: "object",
          required: ["language", "kind", "refId", "correct"],
          properties: {
            language: { type: "string" },
            kind: { type: "string", enum: ["word", "grammar"] },
            refId: { type: "string" },
            correct: { type: "boolean" },
            flagWordIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, kind, refId, correct, flagWordIds } = request.body;
      const session = await getCombinedQuizSession(language);
      if (!session) return reply.notFound("No combined quiz session found for this language");
      if (session.status === "completed") return reply.badRequest("Session already completed");

      const question = session.questions.find(
        (q) =>
          q.userCorrect === undefined &&
          (kind === "word"
            ? q.kind === "word" && q.wordId === refId
            : q.kind === "grammar" && q.grammarId === refId)
      );
      if (!question) return reply.notFound(`Question '${kind}:${refId}' not in this session`);

      question.userCorrect = correct;
      if (correct) {
        session.score.correct++;
      } else {
        const retry: CombinedQuizQuestion =
          question.kind === "word"
            ? {
                kind: "word",
                wordId: question.wordId,
                term: question.term,
                definitions: question.definitions ?? [],
                transliteration: question.transliteration,
                examples: question.examples,
              }
            : {
                kind: "grammar",
                grammarId: question.grammarId,
                statement: question.statement,
              };
        insertRetryQuestion(session.questions, retry, session.questions.indexOf(question));
        session.score.total++;
        // A wrong answer means it's no longer "already-correct": drop it from the mastered
        // bucket so its retry is treated as a normal (unmastered) item for the rest of the session.
        if (session.correctMembership) {
          if (kind === "word") {
            session.correctMembership.wordIds = session.correctMembership.wordIds.filter((id) => id !== refId);
          } else {
            session.correctMembership.grammarIds = session.correctMembership.grammarIds.filter((id) => id !== refId);
          }
        }
      }

      // Update per-domain progress (same bookkeeping as the standalone quizzes).
      if (kind === "word") {
        const wp: WordProgress = { ...(await getWordProgress(language, refId)) };
        wp.timesSeen++;
        if (correct) {
          wp.timesCorrect++;
          wp.streak++;
        } else {
          wp.streak = 0;
        }
        wp.correctRate = wp.timesCorrect / wp.timesSeen;
        wp.lastReviewed = new Date().toISOString();
        await updateWordProgress(language, refId, wp);
      } else {
        const gp = await getGrammarComponentProgress(language, refId);
        gp.timesSeen++;
        if (correct) {
          gp.timesCorrect++;
          gp.streak++;
        } else {
          gp.streak = 0;
        }
        gp.correctRate = gp.timesCorrect / gp.timesSeen;
        gp.lastReviewed = new Date().toISOString();
        await updateGrammarComponentProgress(language, refId, gp);
      }

      if (flagWordIds && flagWordIds.length > 0) {
        await Promise.all(flagWordIds.map((id) => flagWord(language, id).catch(() => {})));
      }

      const allAnswered = session.questions.every((q) => q.userCorrect !== undefined);
      if (allAnswered) {
        session.status = "completed";
        session.completedAt = new Date().toISOString();
      }

      await saveCombinedQuizSession(session);
      return { session };
    }
  );

  // Get current session for a language — reorders the unanswered tail so a resumed
  // session keeps both the per-group and word/grammar weighting.
  fastify.get<{ Params: { language: string } }>(
    "/session/language/:language",
    async (request, reply) => {
      const session = await getCombinedQuizSession(request.params.language);
      if (!session) return reply.notFound("No combined quiz session found for this language");

      reorderUnansweredTail(session);
      await saveCombinedQuizSession(session);

      return session;
    }
  );

  // Adjust domain and/or per-group weights mid-session: store the new weights and
  // reorder the unanswered tail with them. Returns the full session so the client
  // can re-sync its local order.
  fastify.put<{
    Params: { language: string };
    Body: {
      domainWeights?: { word?: number; grammar?: number };
      wordGroupWeights?: Record<string, number>;
      grammarGroupWeights?: Record<string, number>;
      correctWeight?: number;
    };
  }>(
    "/session/language/:language/weights",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            domainWeights: {
              type: "object",
              properties: {
                word: { type: "number", minimum: 0 },
                grammar: { type: "number", minimum: 0 },
              },
            },
            wordGroupWeights: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
            grammarGroupWeights: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
            correctWeight: { type: "number", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await getCombinedQuizSession(request.params.language);
      if (!session) return reply.notFound("No combined quiz session found for this language");
      if (session.status === "completed") return reply.badRequest("Session already completed");

      const { domainWeights, wordGroupWeights, grammarGroupWeights, correctWeight } = request.body;
      if (correctWeight !== undefined) {
        session.correctWeight = correctWeight;
        // Activate the mastered partition on demand if the session didn't start with one.
        if (!session.correctMembership) {
          const [wp, gp] = await Promise.all([
            getProgressForLanguage(request.params.language),
            getGrammarProgressForLanguage(request.params.language),
          ]);
          const wordIds: string[] = [];
          const grammarIds: string[] = [];
          for (const q of session.questions) {
            if (q.userCorrect !== undefined) continue;
            if (q.kind === "word") {
              if (isMastered(wp.words[q.wordId])) wordIds.push(q.wordId);
            } else if (isMastered(gp[q.grammarId])) {
              grammarIds.push(q.grammarId);
            }
          }
          session.correctMembership = { wordIds, grammarIds };
        }
      }
      if (domainWeights) {
        const wordWeight = Math.max(0, domainWeights.word ?? session.domainWeights?.word ?? 1);
        const grammarWeight = Math.max(0, domainWeights.grammar ?? session.domainWeights?.grammar ?? 1);
        if (wordWeight <= 0 && grammarWeight <= 0 && (session.correctWeight ?? 0) <= 0) {
          return reply.badRequest("At least one of the word/grammar/already-correct weights must be positive");
        }
        session.domainWeights = { word: wordWeight, grammar: grammarWeight };
      }
      if (wordGroupWeights) {
        session.wordGroupWeights = { ...session.wordGroupWeights, ...wordGroupWeights };
      }
      if (grammarGroupWeights) {
        session.grammarGroupWeights = { ...session.grammarGroupWeights, ...grammarGroupWeights };
      }

      reorderUnansweredTail(session);
      await saveCombinedQuizSession(session);

      return session;
    }
  );
};

// Reorder the unanswered tail by the session's current domain + group weights,
// keeping answered questions in place. Shared by resume (GET session) and the
// mid-session weight update (PUT weights).
function reorderUnansweredTail(session: CombinedQuizSession): void {
  const answered: CombinedQuizQuestion[] = [];
  const unanswered: CombinedQuizQuestion[] = [];
  for (const q of session.questions) {
    if (q.userCorrect !== undefined) answered.push(q);
    else unanswered.push(q);
  }

  const useCorrect = session.correctWeight !== undefined;
  const knownWordIds = new Set(session.correctMembership?.wordIds ?? []);
  const knownGrammarIds = new Set(session.correctMembership?.grammarIds ?? []);
  const isKnown = (q: CombinedQuizQuestion): boolean =>
    q.kind === "word" ? knownWordIds.has(q.wordId) : knownGrammarIds.has(q.grammarId);
  const freshUnanswered = useCorrect ? unanswered.filter((q) => !isKnown(q)) : unanswered;

  const wordTail = reweightDomain(
    freshUnanswered.filter((q): q is CombinedQuizWordQuestion => q.kind === "word"),
    session.wordGroupMembership,
    session.wordGroupWeights,
    (q) => q.wordId
  );
  const grammarTail = reweightDomain(
    freshUnanswered.filter((q): q is CombinedQuizGrammarQuestion => q.kind === "grammar"),
    session.grammarGroupMembership,
    session.grammarGroupWeights,
    (q) => q.grammarId
  );
  const merged = weightedMerge<CombinedQuizQuestion>([
    { weight: session.domainWeights?.word ?? 1, items: wordTail },
    { weight: session.domainWeights?.grammar ?? 1, items: grammarTail },
    ...(useCorrect
      ? [{ weight: session.correctWeight ?? 0, items: shuffle(unanswered.filter(isKnown)) }]
      : []),
  ]);
  // weightedMerge drops zero-weight buckets; never lose questions.
  const covered = new Set(merged);
  for (const q of unanswered) {
    if (!covered.has(q)) merged.push(q);
  }
  session.questions = [...answered, ...merged];
}

// Assign each pooled word to exactly one selected group (first group in groupIds order that
// contains it) — mirrors buildGroupMembership in routes/quiz.ts.
async function buildWordMembership(
  groupIds: string[],
  pool: Word[]
): Promise<Record<string, Word[]>> {
  const groupDocs = await Promise.all(groupIds.map((id) => getWordGroup(id)));
  return assignMembership(
    groupIds,
    groupDocs.map((g) => (g ? { id: g.id, memberIds: g.wordIds } : null)),
    pool
  );
}

async function buildGrammarMembership(
  groupIds: string[],
  pool: Grammar[]
): Promise<Record<string, Grammar[]>> {
  const groupDocs = await Promise.all(groupIds.map((id) => getGrammarGroup(id)));
  return assignMembership(
    groupIds,
    groupDocs.map((g) => (g ? { id: g.id, memberIds: g.grammarIds } : null)),
    pool
  );
}

function assignMembership<T extends { id: string }>(
  groupIds: string[],
  groupDocs: ({ id: string; memberIds: string[] } | null)[],
  pool: T[]
): Record<string, T[]> {
  const itemById = new Map(pool.map((item) => [item.id, item]));
  const assigned = new Set<string>();
  const membership: Record<string, T[]> = {};
  for (const id of groupIds) membership[id] = [];
  for (const g of groupDocs) {
    if (!g) continue;
    for (const memberId of g.memberIds) {
      if (itemById.has(memberId) && !assigned.has(memberId)) {
        assigned.add(memberId);
        membership[g.id].push(itemById.get(memberId)!);
      }
    }
  }
  return membership;
}

// Re-order one domain's unanswered tail on resume using its stored membership/weights;
// falls back to a uniform shuffle for ungrouped domains (mirrors reweightUnanswered).
function reweightDomain<T extends object>(
  unanswered: T[],
  membership: Record<string, string[]> | undefined,
  weights: Record<string, number> | undefined,
  idOf: (q: T) => string
): T[] {
  if (!membership || Object.keys(membership).length === 0) {
    return shuffle(unanswered);
  }
  const byId = new Map<string, T>();
  for (const q of unanswered) byId.set(idOf(q), q);
  const buckets = Object.entries(membership).map(([gid, ids]) => ({
    weight: weights?.[gid] ?? 1,
    items: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
  }));
  const ordered = weightedInterleave(buckets);
  // Append any unanswered question not covered by the stored membership (includes retry
  // duplicates collapsed by the byId map).
  const covered = new Set(ordered);
  for (const q of unanswered) {
    if (!covered.has(q)) ordered.push(q);
  }
  return ordered;
}

export default combinedQuizRoutes;
