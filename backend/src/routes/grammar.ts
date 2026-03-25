import type { FastifyPluginAsync } from "fastify";
import {
  listGrammarChapters,
  getChapterSubchapters,
  getGrammarItems,
  getGrammarItem,
  getAllGrammarItems,
  upsertGrammarItem,
  deleteGrammarItem,
  type GrammarItemDoc,
} from "../firestore.js";

const grammarRoutes: FastifyPluginAsync = async (fastify) => {
  // List chapters
  fastify.get<{ Params: { language: string } }>(
    "/:language/chapters",
    async (request) => {
      return await listGrammarChapters(request.params.language);
    }
  );

  // List subchapters (optionally filtered by chapters)
  // Reads from grammar_chapters first (has subchapter metadata), falls back to grammar_items
  fastify.get<{
    Params: { language: string };
    Querystring: { chapters?: string };
  }>("/:language/subchapters", async (request) => {
    const { language } = request.params;
    const chapterNums = request.query.chapters
      ? request.query.chapters.split(",").map(Number).filter((n) => !isNaN(n))
      : undefined;

    // Primary: read subchapter metadata stored on grammar_chapters documents
    const fromChapters = await getChapterSubchapters(language, chapterNums);
    if (fromChapters.length > 0) return fromChapters;

    // Fallback: derive from grammar_items (for chapters without stored subchapter data)
    const items = await getAllGrammarItems(language);
    const filtered = chapterNums
      ? items.filter((item) => chapterNums.includes(item.chapterNumber))
      : items;

    const seen = new Set<string>();
    const result: { chapterNumber: number; subchapterId: string; subchapterTitle: Record<string, string> }[] = [];
    for (const item of filtered) {
      const key = `${item.chapterNumber}_${item.subchapterId}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          chapterNumber: item.chapterNumber,
          subchapterId: item.subchapterId,
          subchapterTitle: item.subchapterTitle,
        });
      }
    }
    return result;
  });

  // List grammar items with filters & pagination
  fastify.get<{
    Params: { language: string };
    Querystring: {
      chapter?: string;
      subchapter?: string;
      level?: string;
      search?: string;
      page?: string;
      limit?: string;
    };
  }>("/:language/items", async (request) => {
    const { language } = request.params;
    const { chapter, subchapter, level, search } = request.query;
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? "50", 10) || 50));

    return await getGrammarItems(
      language,
      {
        chapter: chapter ? parseInt(chapter, 10) : undefined,
        subchapter,
        level,
        search,
      },
      { page, limit }
    );
  });

  // Get single grammar item
  fastify.get<{ Params: { language: string; componentId: string } }>(
    "/:language/items/:componentId",
    async (request, reply) => {
      const item = await getGrammarItem(request.params.componentId);
      if (!item) return reply.notFound("Grammar item not found");
      return item;
    }
  );

  // Add grammar item
  fastify.post<{
    Params: { language: string };
    Body: Omit<GrammarItemDoc, "language">;
  }>(
    "/:language/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "chapterNumber", "subchapterId", "subchapterTitle", "term"],
          properties: {
            id: { type: "string" },
            chapterNumber: { type: "number" },
            subchapterId: { type: "string" },
            subchapterTitle: { type: "object" },
            term: { type: "object" },
            description: { type: "object" },
            examples: { type: "array" },
            words: { type: "array", items: { type: "string" } },
            level: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const item: GrammarItemDoc = { ...request.body, language };
      await upsertGrammarItem(item);
      return reply.status(201).send(item);
    }
  );

  // Update grammar item
  fastify.put<{
    Params: { language: string; componentId: string };
    Body: Partial<GrammarItemDoc>;
  }>(
    "/:language/items/:componentId",
    async (request, reply) => {
      const existing = await getGrammarItem(request.params.componentId);
      if (!existing) return reply.notFound("Grammar item not found");
      const updated: GrammarItemDoc = { ...existing, ...request.body, id: existing.id, language: existing.language };
      await upsertGrammarItem(updated);
      return updated;
    }
  );

  // Delete grammar item
  fastify.delete<{ Params: { language: string; componentId: string } }>(
    "/:language/items/:componentId",
    async (request, reply) => {
      const deleted = await deleteGrammarItem(request.params.componentId);
      if (!deleted) return reply.notFound("Grammar item not found");
      return { deleted: true };
    }
  );
};

export default grammarRoutes;
