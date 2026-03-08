import type { FastifyPluginAsync } from "fastify";
import { readProgressFile, deleteProgressFile, readVocabFile } from "../storage.js";

const progressRoutes: FastifyPluginAsync = async (fastify) => {
  // Get progress for all words in a language
  fastify.get<{ Params: { language: string } }>(
    "/:language",
    async (request, reply) => {
      const { language } = request.params;
      const vocab = await readVocabFile(language);
      if (!vocab) return reply.notFound(`Language file '${language}' not found`);

      const progress = await readProgressFile(language);
      return progress;
    }
  );

  // Get single word progress
  fastify.get<{ Params: { language: string; wordId: string } }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      const vocab = await readVocabFile(language);
      if (!vocab) return reply.notFound(`Language file '${language}' not found`);

      const progress = await readProgressFile(language);
      const wordProgress = progress.words[wordId] ?? {
        timesSeen: 0,
        timesCorrect: 0,
        correctRate: 0,
        lastReviewed: null,
        streak: 0,
      };
      return wordProgress;
    }
  );

  // Reset progress for a language
  fastify.delete<{ Params: { language: string } }>(
    "/:language",
    async (request, reply) => {
      const { language } = request.params;
      await deleteProgressFile(language);
      return reply.status(204).send();
    }
  );
};

export default progressRoutes;
