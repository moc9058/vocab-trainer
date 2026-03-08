import type { FastifyPluginAsync } from "fastify";
import { readVocabFile, writeVocabFile, deleteVocabFile } from "../storage.js";
import type { Word, VocabFile, PaginatedResult } from "../types.js";

const vocabRoutes: FastifyPluginAsync = async (fastify) => {
  // List words with filtering & pagination
  fastify.get<{
    Params: { language: string };
    Querystring: { search?: string; topic?: string; category?: string; page?: string; limit?: string };
  }>("/:language", async (request, reply) => {
    const { language } = request.params;
    const data = await readVocabFile(language);
    if (!data) return reply.notFound(`Language file '${language}' not found`);

    let words = data.words;
    const { search, topic, category } = request.query;

    if (search) {
      const q = search.toLowerCase();
      words = words.filter(
        (w) =>
          w.term.toLowerCase().includes(q) ||
          w.transliteration?.toLowerCase().includes(q) ||
          Object.values(w.definition).some((d) => d.toLowerCase().includes(q))
      );
    }

    if (topic) {
      words = words.filter((w) => (w.topics as string[]).includes(topic));
    }

    if (category) {
      words = words.filter((w) => w.grammaticalCategory === category);
    }

    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? "50", 10) || 50));
    const total = words.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit;
    const items = words.slice(start, start + limit);

    const result: PaginatedResult<Word> = { items, total, page, limit, totalPages };
    return result;
  });

  // Get available filter options for a language
  fastify.get<{ Params: { language: string } }>(
    "/:language/filters",
    async (request, reply) => {
      const { language } = request.params;
      const data = await readVocabFile(language);
      if (!data) return reply.notFound(`Language file '${language}' not found`);
      const topics = [...new Set(data.words.flatMap((w) => w.topics))];
      const categories = [...new Set(data.words.map((w) => w.grammaticalCategory).filter(Boolean))].sort();
      return { topics, categories };
    }
  );

  // Get single word
  fastify.get<{ Params: { language: string; wordId: string } }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      const data = await readVocabFile(language);
      if (!data) return reply.notFound(`Language file '${language}' not found`);

      const word = data.words.find((w) => w.id === wordId);
      if (!word) return reply.notFound(`Word '${wordId}' not found`);
      return word;
    }
  );

  // Add new word
  fastify.post<{ Params: { language: string }; Body: Omit<Word, "id"> & { id?: string } }>(
    "/:language",
    {
      schema: {
        body: {
          type: "object",
          required: ["term", "definition", "grammaticalCategory", "topics"],
          properties: {
            id: { type: "string" },
            term: { type: "string" },
            transliteration: { type: "string" },
            definition: { type: "object", additionalProperties: { type: "string" } },
            grammaticalCategory: { type: "string" },
            examples: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sentence: { type: "string" },
                  translation: { type: "string" },
                },
              },
            },
            topics: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const data = await readVocabFile(language);
      if (!data) return reply.notFound(`Language file '${language}' not found`);

      const body = request.body;
      const id = body.id ?? generateWordId(data, language);

      if (data.words.some((w) => w.id === id)) {
        return reply.conflict(`Word with id '${id}' already exists`);
      }

      const word: Word = {
        id,
        term: body.term,
        transliteration: body.transliteration,
        definition: body.definition,
        grammaticalCategory: body.grammaticalCategory,
        examples: body.examples ?? [],
        topics: body.topics,
        notes: body.notes,
      };

      data.words.push(word);
      await writeVocabFile(language, data);
      return reply.status(201).send(word);
    }
  );

  // Update word
  fastify.put<{ Params: { language: string; wordId: string }; Body: Partial<Word> }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      const data = await readVocabFile(language);
      if (!data) return reply.notFound(`Language file '${language}' not found`);

      const idx = data.words.findIndex((w) => w.id === wordId);
      if (idx === -1) return reply.notFound(`Word '${wordId}' not found`);

      const updated = { ...data.words[idx], ...request.body, id: wordId };
      data.words[idx] = updated;
      await writeVocabFile(language, data);
      return updated;
    }
  );

  // Delete word
  fastify.delete<{ Params: { language: string; wordId: string } }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      const data = await readVocabFile(language);
      if (!data) return reply.notFound(`Language file '${language}' not found`);

      const idx = data.words.findIndex((w) => w.id === wordId);
      if (idx === -1) return reply.notFound(`Word '${wordId}' not found`);

      data.words.splice(idx, 1);
      await writeVocabFile(language, data);
      return reply.status(204).send();
    }
  );

  // Create new language file
  fastify.post<{
    Params: { language: string };
  }>(
    "/:language/file",
    async (request, reply) => {
      const { language } = request.params;
      const existing = await readVocabFile(language);
      if (existing) return reply.conflict(`Language file '${language}' already exists`);

      const file: VocabFile = { words: [] };
      await writeVocabFile(language, file);
      return reply.status(201).send(file);
    }
  );

  // Delete language file
  fastify.delete<{ Params: { language: string } }>(
    "/:language/file",
    async (request, reply) => {
      const { language } = request.params;
      const deleted = await deleteVocabFile(language);
      if (!deleted) return reply.notFound(`Language file '${language}' not found`);
      return reply.status(204).send();
    }
  );
};

function generateWordId(data: VocabFile, language: string): string {
  const prefix = language.slice(0, 3).toLowerCase();
  const maxNum = data.words.reduce((max, w) => {
    const match = w.id.match(/-(\d+)$/);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);
  return `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
}

export default vocabRoutes;
