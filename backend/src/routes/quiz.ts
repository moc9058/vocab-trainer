import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getFilteredWords,
  getProgressForLanguage,
  getWordProgress,
  updateWordProgress,
  getQuizSession,
  createQuizSession,
  updateQuizSession,
  deleteQuizSession,
  listQuizSessions,
  importQuizSessions,
  getAllQuizSessions,
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
            questionCount: { type: "number", minimum: 1, maximum: 100 },
            topics: { type: "array", items: { type: "string" } },
            categories: { type: "array", items: { type: "string" } },
            levels: { type: "array", items: { type: "string" } },
            questionType: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount = 10, topics, categories, levels, questionType } = request.body;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }

      const pool = await getFilteredWords(language, { topics, categories, levels });

      if (pool.length === 0) {
        return reply.badRequest("No words match the given filters");
      }

      const progressData = await getProgressForLanguage(language);
      const selected = weightedSample(pool, Math.min(questionCount, pool.length), progressData.words);
      const wordIds = selected.map((w) => w.id);

      const questions: QuizQuestion[] = selected.map((w) => {
        const definitions = Object.values(w.definition);
        const expectedAnswer = definitions[0] ?? "";
        return {
          wordId: w.id,
          term: w.term,
          expectedAnswer,
        };
      });

      const session: QuizSession = {
        sessionId: `qs-${Date.now()}`,
        language,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        score: { correct: 0, total: questions.length },
        questions,
        questionType,
        wordIds,
      };

      await createQuizSession(session);
      return reply.status(201).send(session);
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

      const question = session.questions.find((q) => q.wordId === wordId);
      if (!question) return reply.notFound(`Word '${wordId}' not in this session`);
      if (question.userCorrect !== undefined) return reply.badRequest("Question already answered");

      question.userCorrect = correct;
      if (correct) session.score.correct++;

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

  // Get session state
  fastify.get<{ Params: { sessionId: string } }>(
    "/session/:sessionId",
    async (request, reply) => {
      const session = await getQuizSession(request.params.sessionId);
      if (!session) return reply.notFound("Session not found");
      return session;
    }
  );

  // List past sessions
  fastify.get<{ Querystring: { language?: string } }>(
    "/history",
    async (request) => {
      const sessions = await listQuizSessions(request.query.language);
      return sessions.map((s) => ({
        sessionId: s.sessionId,
        language: s.language,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        status: s.status,
        score: s.score,
        questionType: s.questionType,
      }));
    }
  );

  // Get full session details
  fastify.get<{ Params: { sessionId: string } }>(
    "/history/:sessionId",
    async (request, reply) => {
      const session = await getQuizSession(request.params.sessionId);
      if (!session) return reply.notFound("Session not found");
      return session;
    }
  );

  // Delete session
  fastify.delete<{ Params: { sessionId: string } }>(
    "/history/:sessionId",
    async (request, reply) => {
      const deleted = await deleteQuizSession(request.params.sessionId);
      if (!deleted) return reply.notFound("Session not found");
      return reply.status(204).send();
    }
  );

  // Import quiz history
  fastify.post<{ Body: { sessions: QuizSession[] } }>(
    "/history/import",
    {
      schema: {
        body: {
          type: "object",
          required: ["sessions"],
          properties: {
            sessions: { type: "array" },
          },
        },
      },
    },
    async (request) => {
      const imported = request.body.sessions;
      await importQuizSessions(imported);
      const all = await getAllQuizSessions();
      return { imported: imported.length, total: all.sessions.length };
    }
  );

  // Export quiz history
  fastify.get("/history/export", async () => {
    return await getAllQuizSessions();
  });
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
