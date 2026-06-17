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
            questionType: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, topics, categories, levels, groupIds, questionType } = request.body;
      const [exists, pool] = await Promise.all([
        languageExists(language),
        getFilteredWords(language, { topics, categories, levels, groupIds }),
      ]);

      if (!exists) {
        return reply.notFound(`Language '${language}' not found`);
      }

      if (pool.length === 0) {
        return reply.badRequest("No words match the given filters");
      }
      const count = questionCount ? Math.min(questionCount, pool.length) : pool.length;
      const selected = randomSample(pool, count);

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
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, topics, categories, levels, groupIds } = request.body;
      const [exists, pool] = await Promise.all([
        languageExists(language),
        getFilteredWords(language, { topics, categories, levels, groupIds }),
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
      session.questions = [...answered, ...shuffle(unanswered)];
      await updateQuizSession(session);

      return session;
    }
  );
};

function randomSample(words: Word[], count: number): Word[] {
  return shuffle(words).slice(0, count);
}

function insertRetryQuestion(
  questions: QuizQuestion[],
  retryQuestion: QuizQuestion,
  answeredIndex: number
): void {
  const insertAt = answeredIndex + 1;
  questions.splice(insertAt, 0, retryQuestion);
  questions.splice(insertAt, questions.length - insertAt, ...shuffle(questions.slice(insertAt)));
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
