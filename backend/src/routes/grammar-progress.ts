import type { FastifyPluginAsync } from "fastify";
import {
  getGrammarProgressForLanguage,
  deleteGrammarProgressForLanguage,
} from "../firestore.js";

const grammarProgressRoutes: FastifyPluginAsync = async (fastify) => {
  // Get all grammar progress for a language
  fastify.get<{ Params: { language: string } }>(
    "/:language",
    async (request) => {
      const progress = await getGrammarProgressForLanguage(request.params.language);
      return { language: request.params.language, components: progress };
    }
  );

  // Reset grammar progress for a language
  fastify.delete<{ Params: { language: string } }>(
    "/:language",
    async (request) => {
      await deleteGrammarProgressForLanguage(request.params.language);
      return { deleted: true };
    }
  );
};

export default grammarProgressRoutes;
