import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getFilteredWords,
  getWordsByIds,
  getWordProgress,
  updateWordProgress,
  flagWord,
  getWordGroup,
  getAllGrammarItems,
  getGrammarGroup,
  getGrammarComponentProgress,
  updateGrammarComponentProgress,
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
import { shuffle, weightedInterleave, weightedMerge, insertRetryQuestion } from "../quiz-utils.js";
import { prepareQuestion } from "./grammar-quiz.js";

// Cap on concurrent grammar-question preparation. Most items hydrate from Firestore
// example docs; the bound mainly protects the LLM fallback path for example-less items.
const PREPARE_CONCURRENCY = 5;

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
      const { language, domainWeights, word, grammar } = request.body;
      const wordWeight = Math.max(0, domainWeights?.word ?? 1);
      const grammarWeight = Math.max(0, domainWeights?.grammar ?? 1);
      if (wordWeight <= 0 && grammarWeight <= 0) {
        return reply.badRequest("At least one of the word/grammar weights must be positive");
      }

      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }

      // --- Word side: mirror /api/quiz/start ordering ---
      let wordQuestions: CombinedQuizWordQuestion[] = [];
      let wordGroupMembership: Record<string, string[]> | undefined;
      if (wordWeight > 0) {
        const pool = await getFilteredWords(language, {
          topics: word?.topics,
          categories: word?.categories,
          levels: word?.levels,
          groupIds: word?.groupIds,
          flaggedOnly: word?.flaggedOnly,
        });
        let ordered: Word[];
        if (word?.groupIds && word.groupIds.length > 0) {
          const membership = await buildWordMembership(word.groupIds, pool);
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
          ordered = shuffle(pool);
        }
        wordQuestions = ordered.map((w) => ({
          kind: "word" as const,
          wordId: w.id,
          term: w.term,
          definitions: w.definitions,
          transliteration: w.transliteration,
          examples: w.examples,
          ...(w.hanjaReadings ? { hanjaReadings: w.hanjaReadings } : {}),
        }));
      }

      // --- Grammar side: group-weighted like the word side (grammar groups gain weights here) ---
      let grammarQuestions: CombinedQuizGrammarQuestion[] = [];
      let grammarGroupMembership: Record<string, string[]> | undefined;
      if (grammarWeight > 0) {
        const pool = await getAllGrammarItems(language);
        let ordered: Grammar[];
        if (grammar?.groupIds && grammar.groupIds.length > 0) {
          const membership = await buildGrammarMembership(grammar.groupIds, pool);
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
          ordered = shuffle(pool);
        }
        grammarQuestions = await mapWithConcurrency(ordered, PREPARE_CONCURRENCY, async (item) => {
          try {
            const prepared = await prepareQuestion(item);
            return {
              kind: "grammar" as const,
              grammarId: item.id,
              exampleSentence: prepared.sentence,
              exampleTranslation: prepared.translation,
              ...(prepared.transliteration ? { exampleTransliteration: prepared.transliteration } : {}),
            };
          } catch (err) {
            fastify.log.error({ err, grammarId: item.id }, "Failed to prepare combined grammar question");
            const fallback = item.examples?.[0];
            return {
              kind: "grammar" as const,
              grammarId: item.id,
              exampleSentence: fallback?.sentence ?? item.statement,
              exampleTranslation: fallback?.translation ?? "",
              ...(fallback?.transliteration ? { exampleTransliteration: fallback.transliteration } : {}),
            };
          }
        });
      }

      if (wordQuestions.length === 0 && grammarQuestions.length === 0) {
        return reply.badRequest("No words or grammar items match the given filters");
      }

      const questions: CombinedQuizQuestion[] = weightedMerge<CombinedQuizQuestion>([
        { weight: wordWeight, items: wordQuestions },
        { weight: grammarWeight, items: grammarQuestions },
      ]);

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
        ...(word?.flaggedOnly ? { flaggedOnly: true } : {}),
      };

      await saveCombinedQuizSession(session);
      // Lightweight response: word questions carry only {kind, wordId, term}; the client
      // pages GET /questions/:language for definitions/examples. Grammar questions are small
      // (sentence + translation) and returned as-is.
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
                exampleSentence: question.exampleSentence,
                exampleTranslation: question.exampleTranslation,
                ...(question.exampleTransliteration
                  ? { exampleTransliteration: question.exampleTransliteration }
                  : {}),
              };
        insertRetryQuestion(session.questions, retry, session.questions.indexOf(question));
        session.score.total++;
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

      const answered: CombinedQuizQuestion[] = [];
      const unanswered: CombinedQuizQuestion[] = [];
      for (const q of session.questions) {
        if (q.userCorrect !== undefined) answered.push(q);
        else unanswered.push(q);
      }

      const wordTail = reweightDomain(
        unanswered.filter((q): q is CombinedQuizWordQuestion => q.kind === "word"),
        session.wordGroupMembership,
        session.wordGroupWeights,
        (q) => q.wordId
      );
      const grammarTail = reweightDomain(
        unanswered.filter((q): q is CombinedQuizGrammarQuestion => q.kind === "grammar"),
        session.grammarGroupMembership,
        session.grammarGroupWeights,
        (q) => q.grammarId
      );
      const merged = weightedMerge<CombinedQuizQuestion>([
        { weight: session.domainWeights?.word ?? 1, items: wordTail },
        { weight: session.domainWeights?.grammar ?? 1, items: grammarTail },
      ]);
      // weightedMerge drops zero-weight buckets; never lose questions on resume.
      const covered = new Set(merged);
      for (const q of unanswered) {
        if (!covered.has(q)) merged.push(q);
      }
      session.questions = [...answered, ...merged];
      await saveCombinedQuizSession(session);

      return session;
    }
  );
};

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

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export default combinedQuizRoutes;
