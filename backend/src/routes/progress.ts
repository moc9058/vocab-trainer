import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getProgressForLanguage,
  getWordProgress,
  deleteProgressForLanguage,
} from "../firestore.js";

const progressRoutes: FastifyPluginAsync = async (fastify) => {
  // Get progress for all words in a language
  fastify.get<{ Params: { language: string } }>(
    "/:language",
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      return await getProgressForLanguage(language);
    }
  );

  // Get single word progress
  fastify.get<{ Params: { language: string; wordId: string } }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      return await getWordProgress(language, wordId);
    }
  );

  // Reset progress for a language
  fastify.delete<{ Params: { language: string } }>(
    "/:language",
    async (request, reply) => {
      const { language } = request.params;
      await deleteProgressForLanguage(language);
      return reply.status(204).send();
    }
  );
};

export default progressRoutes;
