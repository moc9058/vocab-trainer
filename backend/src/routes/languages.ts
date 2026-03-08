import type { FastifyPluginAsync } from "fastify";
import { listVocabFiles, readVocabFile } from "../storage.js";
import type { LanguageInfo } from "../types.js";

const languagesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/", async () => {
    const files = await listVocabFiles();
    const languages: LanguageInfo[] = [];

    for (const file of files) {
      const language = file.replace(".json", "");
      const data = await readVocabFile(language);
      if (data) {
        const topics = [...new Set(data.words.flatMap((w) => w.topics))];
        languages.push({
          filename: file,
          language: language.charAt(0).toUpperCase() + language.slice(1),
          topics,
          wordCount: data.words.length,
        });
      }
    }

    return languages;
  });
};

export default languagesRoutes;
