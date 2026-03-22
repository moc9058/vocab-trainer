import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getFilteredWords,
  getProgressForLanguage,
  getWordProgress,
  updateWordProgress,
  getQuizSession,
  getQuizSessionByLanguage,
  createQuizSession,
  updateQuizSession,
  getWordsByIds,
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
            questionType: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, topics, categories, levels, questionType } = request.body;
      const [exists, pool, progressData] = await Promise.all([
        languageExists(language),
        getFilteredWords(language, { topics, categories, levels }),
        getProgressForLanguage(language),
      ]);

      if (!exists) {
        return reply.notFound(`Language '${language}' not found`);
      }

      if (pool.length === 0) {
        return reply.badRequest("No words match the given filters");
      }
      const count = questionCount ? Math.min(questionCount, pool.length) : pool.length;
      const selected = weightedSample(pool, count, progressData.words);

      const questions: QuizQuestion[] = selected.map((w) => ({
        wordId: w.id,
        term: w.term,
        definition: w.definition,
        transliteration: w.transliteration,
        examples: w.examples,
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
          term: q.term,
          definition: word?.definition ?? {},
          transliteration: word?.transliteration,
          examples: word?.examples ?? [],
          ...(q.userCorrect !== undefined ? { userCorrect: q.userCorrect } : {}),
        };
      });

      return { questions: hydrated, total: session.questions.length };
    }
  );

  // Submit answer
  fastify.post<{
    Body: { sessionId: string; wordId: string; correct: boolean };
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
          },
        },
      },
    },
    async (request, reply) => {
      const { sessionId, wordId, correct } = request.body;
      const session = await getQuizSession(sessionId);
      if (!session) return reply.notFound(`Session '${sessionId}' not found`);
      if (session.status === "completed") return reply.badRequest("Session already completed");

      const question = session.questions.find((q) => q.wordId === wordId && q.userCorrect === undefined);
      if (!question) return reply.notFound(`Word '${wordId}' not in this session`);

      question.userCorrect = correct;
      if (correct) {
        session.score.correct++;
      } else {
        // Re-queue wrong answer to appear again later
        session.questions.push({
          wordId: question.wordId,
          term: question.term,
          definition: question.definition ?? {},
          transliteration: question.transliteration,
          examples: question.examples,
        });
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

      // Shuffle unanswered questions so resume order differs each time
      const answered: QuizQuestion[] = [];
      const unanswered: QuizQuestion[] = [];
      for (const q of session.questions) {
        if (q.userCorrect !== undefined) answered.push(q);
        else unanswered.push(q);
      }
      for (let i = unanswered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unanswered[i], unanswered[j]] = [unanswered[j], unanswered[i]];
      }
      session.questions = [...answered, ...unanswered];

      return session;
    }
  );
};

/**
 * Weighted random sampling: words with lower accuracy, unseen words,
 * and words not reviewed recently get higher weight.
 */
function weightedSample(
  words: Word[],
  count: number,
  progressMap: Record<string, WordProgress>
): Word[] {
  const now = Date.now();
  const weighted = words.map((w) => {
    const p = progressMap[w.id];
    let weight = 1;

    if (!p || p.timesSeen === 0) {
      weight = 5;
    } else {
      weight += (1 - p.correctRate) * 4;
      const daysSince = (now - new Date(p.lastReviewed).getTime()) / (1000 * 60 * 60 * 24);
      weight += Math.min(daysSince, 7) * 0.5;
    }

    return { word: w, weight };
  });

  const selected: Word[] = [];
  const remaining = [...weighted];

  for (let i = 0; i < count && remaining.length > 0; i++) {
    const totalWeight = remaining.reduce((sum, item) => sum + item.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < remaining.length - 1; idx++) {
      r -= remaining[idx].weight;
      if (r <= 0) break;
    }
    selected.push(remaining[idx].word);
    remaining.splice(idx, 1);
  }

  return selected;
}

export default quizRoutes;
