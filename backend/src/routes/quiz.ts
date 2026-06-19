import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getFilteredWords,
  getWordProgress,
  updateWordProgress,
  getQuizSession,
  getQuizSessionByLanguage,
  createQuizSession,
  updateQuizSession,
  getWordsByIds,
  flagWord,
  getWordGroup,
} from "../firestore.js";
import type { QuizSession, QuizQuestion, Word, WordProgress } from "../types.js";

const quizRoutes: FastifyPluginAsync = async (fastify) => {
  // Start quiz session
  fastify.post<{
    Body: {
      language: string;
      questionCount?: number;
      topics?: string[];
      categories?: string[];
      levels?: string[];
      groupIds?: string[];
      groupWeights?: Record<string, number>;
      flaggedOnly?: boolean;
      questionType?: string;
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
            questionCount: { type: "number", minimum: 1 },
            topics: { type: "array", items: { type: "string" } },
            categories: { type: "array", items: { type: "string" } },
            levels: { type: "array", items: { type: "string" } },
            groupIds: { type: "array", items: { type: "string" } },
            groupWeights: { type: "object", additionalProperties: { type: "number" } },
            flaggedOnly: { type: "boolean" },
            questionType: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, topics, categories, levels, groupIds, groupWeights, flaggedOnly, questionType } = request.body;
      const [exists, pool] = await Promise.all([
        languageExists(language),
        getFilteredWords(language, { topics, categories, levels, groupIds, flaggedOnly }),
      ]);

      if (!exists) {
        return reply.notFound(`Language '${language}' not found`);
      }

      if (pool.length === 0) {
        return reply.badRequest("No words match the given filters");
      }
      const count = questionCount ? Math.min(questionCount, pool.length) : pool.length;

      // When groups are selected, order the pool by a weighted interleave: each next word's
      // group is drawn proportionally to its weight (default 1), then a random word from it.
      // A group drops out of the draw once all its words have been placed; the existing retry
      // flow keeps a group "active" until its words are actually answered correct.
      let selected: Word[];
      let groupMembership: Record<string, string[]> | undefined;
      if (groupIds && groupIds.length > 0) {
        const membership = await buildGroupMembership(groupIds, pool);
        const buckets = groupIds.map((id) => ({
          weight: groupWeights?.[id] ?? 1,
          items: membership[id] ?? [],
        }));
        selected = weightedInterleave(buckets).slice(0, count);
        groupMembership = Object.fromEntries(
          Object.entries(membership).map(([id, ws]) => [id, ws.map((w) => w.id)])
        );
      } else {
        selected = randomSample(pool, count);
      }

      const questions: QuizQuestion[] = selected.map((w) => ({
        wordId: w.id,
        term: w.term,
        definitions: w.definitions,
        transliteration: w.transliteration,
        examples: w.examples,
        ...(w.hanjaReadings ? { hanjaReadings: w.hanjaReadings } : {}),
      }));

      const session: QuizSession = {
        sessionId: language,
        language,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        score: { correct: 0, total: questions.length },
        questions,
        ...(questionType ? { questionType } : {}),
        wordIds: selected.map((w) => w.id),
        ...(groupWeights ? { groupWeights } : {}),
        ...(groupMembership ? { groupMembership } : {}),
        ...(flaggedOnly ? { flaggedOnly } : {}),
      };

      await createQuizSession(session);
      // Return lightweight session (no heavy word data)
      return reply.status(201).send({
        ...session,
        questions: session.questions.map((q) => ({
          wordId: q.wordId,
          term: q.term,
        })),
      });
    }
  );

  // Stateless filter + random sample for printable worksheets.
  // Does NOT create a quiz session.
  fastify.post<{
    Body: {
      language: string;
      questionCount?: number;
      topics?: string[];
      categories?: string[];
      levels?: string[];
      groupIds?: string[];
      flaggedOnly?: boolean;
    };
  }>(
    "/sample",
    {
      schema: {
        body: {
          type: "object",
          required: ["language"],
          properties: {
            language: { type: "string" },
            questionCount: { type: "number", minimum: 1 },
            topics: { type: "array", items: { type: "string" } },
            categories: { type: "array", items: { type: "string" } },
            levels: { type: "array", items: { type: "string" } },
            groupIds: { type: "array", items: { type: "string" } },
            flaggedOnly: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, topics, categories, levels, groupIds, flaggedOnly } = request.body;
      const [exists, pool] = await Promise.all([
        languageExists(language),
        getFilteredWords(language, { topics, categories, levels, groupIds, flaggedOnly }),
      ]);
      if (!exists) return reply.notFound(`Language '${language}' not found`);
      if (pool.length === 0) return reply.badRequest("No words match the given filters");
      const count = questionCount ? Math.min(questionCount, pool.length) : pool.length;
      return { words: randomSample(pool, count) };
    }
  );

  // Batch-fetch hydrated questions for a quiz session
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

      const session = await getQuizSessionByLanguage(language);
      if (!session) return reply.notFound("No session found for this language");

      // Get the slice of questions for this batch
      const slice = session.questions.slice(offset, offset + limit);
      const wordIds = slice.map((q) => q.wordId);

      // Fetch full word data
      const wordsData = await getWordsByIds(wordIds);
      const wordMap = new Map(wordsData.map((w) => [w.id, w]));

      const hydrated: QuizQuestion[] = slice.map((q) => {
        const word = wordMap.get(q.wordId);
        return {
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

  // Submit answer
  fastify.post<{
    Body: { sessionId: string; wordId: string; correct: boolean; flagWordIds?: string[] };
  }>(
    "/answer",
    {
      schema: {
        body: {
          type: "object",
          required: ["sessionId", "wordId", "correct"],
          properties: {
            sessionId: { type: "string" },
            wordId: { type: "string" },
            correct: { type: "boolean" },
            flagWordIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { sessionId, wordId, correct, flagWordIds } = request.body;
      const session = await getQuizSession(sessionId);
      if (!session) return reply.notFound(`Session '${sessionId}' not found`);
      if (session.status === "completed") return reply.badRequest("Session already completed");

      const question = session.questions.find((q) => q.wordId === wordId && q.userCorrect === undefined);
      if (!question) return reply.notFound(`Word '${wordId}' not in this session`);

      question.userCorrect = correct;
      if (correct) {
        session.score.correct++;
      } else {
        insertRetryQuestion(session.questions, {
          wordId: question.wordId,
          term: question.term,
          definitions: question.definitions ?? [],
          transliteration: question.transliteration,
          examples: question.examples,
        }, session.questions.indexOf(question));
        session.score.total++;
      }

      // Update progress
      const wp: WordProgress = { ...(await getWordProgress(session.language, wordId)) };

      wp.timesSeen++;
      if (correct) {
        wp.timesCorrect++;
        wp.streak++;
      } else {
        wp.streak = 0;
      }
      wp.correctRate = wp.timesCorrect / wp.timesSeen;
      wp.lastReviewed = new Date().toISOString();
      await updateWordProgress(session.language, wordId, wp);

      // Flag words if requested
      if (flagWordIds && flagWordIds.length > 0) {
        await Promise.all(
          flagWordIds.map((id) => flagWord(session.language, id).catch(() => {}))
        );
      }

      // Check if session is complete
      const allAnswered = session.questions.every((q) => q.userCorrect !== undefined);
      if (allAnswered) {
        session.status = "completed";
        session.completedAt = new Date().toISOString();
      }

      await updateQuizSession(session);
      return { session, wordProgress: wp };
    }
  );

  // Get current session for a language (lightweight — no word data)
  fastify.get<{ Params: { language: string } }>(
    "/session/language/:language",
    async (request, reply) => {
      const session = await getQuizSessionByLanguage(request.params.language);
      if (!session) return reply.notFound("No session found for this language");

      const answered: QuizQuestion[] = [];
      const unanswered: QuizQuestion[] = [];
      for (const q of session.questions) {
        if (q.userCorrect !== undefined) answered.push(q);
        else unanswered.push(q);
      }
      // Preserve weighted ordering on resume when this was a weighted (grouped) session;
      // otherwise fall back to a uniform shuffle of the remaining questions.
      session.questions = [...answered, ...reweightUnanswered(unanswered, session)];
      await updateQuizSession(session);

      return session;
    }
  );
};

function randomSample(words: Word[], count: number): Word[] {
  return shuffle(words).slice(0, count);
}

// Weighted interleave: repeatedly pick a bucket with probability proportional to its
// weight (among buckets that still have items), then take a random item from it. Used to
// order the quiz by group weight. Buckets with weight <= 0 or no items are skipped.
function weightedInterleave<T>(buckets: { weight: number; items: T[] }[]): T[] {
  const pools = buckets
    .filter((b) => b.weight > 0 && b.items.length > 0)
    .map((b) => ({ weight: b.weight, items: shuffle(b.items) }));
  const order: T[] = [];
  while (pools.some((p) => p.items.length > 0)) {
    const active = pools.filter((p) => p.items.length > 0);
    const total = active.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * total;
    let chosen = active[active.length - 1];
    for (const p of active) {
      r -= p.weight;
      if (r <= 0) {
        chosen = p;
        break;
      }
    }
    order.push(chosen.items.pop()!);
  }
  return order;
}

// Assign each pooled word to exactly one of the selected groups — the first group (in
// groupIds order) whose membership contains it — so weighted draws have well-defined
// denominators and each word appears once.
async function buildGroupMembership(
  groupIds: string[],
  pool: Word[]
): Promise<Record<string, Word[]>> {
  const groupDocs = await Promise.all(groupIds.map((id) => getWordGroup(id)));
  const wordById = new Map(pool.map((w) => [w.id, w]));
  const assigned = new Set<string>();
  const membership: Record<string, Word[]> = {};
  for (const id of groupIds) membership[id] = [];
  for (const g of groupDocs) {
    if (!g) continue;
    for (const wid of g.wordIds) {
      if (wordById.has(wid) && !assigned.has(wid)) {
        assigned.add(wid);
        membership[g.id].push(wordById.get(wid)!);
      }
    }
  }
  return membership;
}

// Re-order the unanswered tail on resume. For weighted (grouped) sessions, rebuild the
// order with the stored per-group weights so resuming keeps the weighting; otherwise just
// shuffle uniformly.
function reweightUnanswered(unanswered: QuizQuestion[], session: QuizSession): QuizQuestion[] {
  const membership = session.groupMembership;
  if (!membership || Object.keys(membership).length === 0) {
    return shuffle(unanswered);
  }
  const byWordId = new Map<string, QuizQuestion>();
  for (const q of unanswered) byWordId.set(q.wordId, q);
  const buckets = Object.entries(membership).map(([gid, wordIds]) => ({
    weight: session.groupWeights?.[gid] ?? 1,
    items: wordIds.filter((wid) => byWordId.has(wid)).map((wid) => byWordId.get(wid)!),
  }));
  const ordered = weightedInterleave(buckets);
  // Append any unanswered question not covered by the stored membership.
  const covered = new Set(ordered.map((q) => q.wordId));
  for (const q of unanswered) {
    if (!covered.has(q.wordId)) ordered.push(q);
  }
  return ordered;
}

function insertRetryQuestion(
  questions: QuizQuestion[],
  retryQuestion: QuizQuestion,
  answeredIndex: number
): void {
  // Insert the retry copy at a random position within the remaining tail so it does not
  // always appear next. Unlike a full tail reshuffle, this preserves the existing order of
  // the rest of the tail — important for keeping a weighted (grouped) quiz's ordering intact.
  const tailStart = answeredIndex + 1;
  const tailLen = questions.length - tailStart;
  const pos = tailStart + Math.floor(Math.random() * (tailLen + 1));
  questions.splice(pos, 0, retryQuestion);
}

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
  }
  return shuffled;
}

export default quizRoutes;
