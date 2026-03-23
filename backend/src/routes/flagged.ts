import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getFlaggedWords,
  getFlaggedWordCount,
  flagWord,
  unflagWord,
  getWordsByIds,
} from "../firestore.js";

const flaggedRoutes: FastifyPluginAsync = async (fastify) => {
  // List all flagged words with full word data
  fastify.get<{ Params: { language: string } }>(
    "/:language",
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      const flagged = await getFlaggedWords(language);
      const wordIds = flagged.map((f) => f.wordId);
      const words = await getWordsByIds(wordIds);
      return { words, count: words.length };
    }
  );

  // Get flagged word count
  fastify.get<{ Params: { language: string } }>(
    "/:language/count",
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      const count = await getFlaggedWordCount(language);
      return { count };
    }
  );

  // Flag a word
  fastify.post<{ Params: { language: string; wordId: string } }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      await flagWord(language, wordId);
      return reply.status(201).send({ success: true });
    }
  );

  // Unflag a word
  fastify.delete<{ Params: { language: string; wordId: string } }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      const existed = await unflagWord(language, wordId);
      if (!existed) return reply.notFound("Word not flagged");
      return { success: true };
    }
  );
};

export default flaggedRoutes;
