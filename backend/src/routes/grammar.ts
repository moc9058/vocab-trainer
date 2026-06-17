import type { FastifyPluginAsync } from "fastify";
import {
  getGrammarItems,
  getGrammarItem,
  upsertGrammarItem,
  deleteGrammarItem,
  getGrammarGroups,
  createGrammarGroup,
  updateGrammarGroup,
  deleteGrammarGroup,
  modifyGrammarGroupMembers,
  getGrammarConfig,
} from "../firestore.js";
import { callLLMWithSchema, stripMarkdownFences } from "../llm.js";
import type { Grammar, Meaning } from "../types.js";

const ALL_DEFINITION_LANGUAGES = ["en", "ja", "ko", "zh"] as const;

function fillPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

const grammarRoutes: FastifyPluginAsync = async (fastify) => {
  const grammarConfig = await getGrammarConfig();

  // List grammar items with filters & pagination
  fastify.get<{
    Params: { language: string };
    Querystring: {
      level?: string;
      search?: string;
      groupId?: string;
      page?: string;
      limit?: string;
    };
  }>("/:language/items", async (request) => {
    const { language } = request.params;
    const { level, search, groupId } = request.query;
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? "50", 10) || 50));

    return await getGrammarItems(language, { level, search, groupId }, { page, limit });
  });

  // Get single grammar item
  fastify.get<{ Params: { language: string; grammarId: string } }>(
    "/:language/items/:grammarId",
    async (request, reply) => {
      const item = await getGrammarItem(request.params.grammarId);
      if (!item) return reply.notFound("Grammar item not found");
      return item;
    }
  );

  // Add grammar item
  fastify.post<{
    Params: { language: string };
    Body: Omit<Grammar, "language">;
  }>(
    "/:language/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "statement", "descriptions"],
          properties: {
            id: { type: "string" },
            statement: { type: "string" },
            descriptions: { type: "array" },
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
      const item: Grammar = { ...request.body, language };
      await upsertGrammarItem(item);
      return reply.status(201).send(item);
    }
  );

  // Smart-add: enriches descriptions with missing language codes via LLM, then upserts.
  fastify.post<{
    Params: { language: string };
    Body: Omit<Grammar, "language">;
  }>(
    "/:language/smart-add",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "statement", "descriptions"],
          properties: {
            id: { type: "string" },
            statement: { type: "string" },
            descriptions: { type: "array" },
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
      const body = request.body;

      const defLangStr = ALL_DEFINITION_LANGUAGES.map((l) => `"${l}": "..."`).join(", ");
      const promptTemplate = grammarConfig.smartAddPrompts[language]
        ?? grammarConfig.smartAddPrompts["default"];
      const systemPrompt = fillPlaceholders(promptTemplate, {
        LANGUAGE: language,
        DEFINITION_LANGUAGES: defLangStr,
      });

      const userPrompt = JSON.stringify({
        statement: body.statement,
        descriptions: body.descriptions,
      }, null, 2);

      let llmResult: Record<string, unknown>;
      try {
        const raw = await callLLMWithSchema(systemPrompt, userPrompt, grammarConfig.smartAddSchema, "grammar/smart-add");
        llmResult = JSON.parse(stripMarkdownFences(raw));
      } catch (err) {
        fastify.log.error({ err, statement: body.statement }, "LLM call failed for grammar smart-add");
        return reply.internalServerError("Failed to enrich grammar descriptions");
      }

      const llmDescs = (llmResult.descriptions as Meaning[] | undefined) ?? [];

      // Merge: keep user's text for the language(s) they supplied, fill missing
      // codes from the LLM's same-index description.
      const mergedDescs: Meaning[] = body.descriptions.map((userDesc, i) => {
        const llmDesc = llmDescs[i];
        const mergedText: Record<string, string> = { ...(llmDesc?.text ?? {}) };
        for (const [lang, text] of Object.entries(userDesc.text ?? {})) {
          if (text && text.trim()) mergedText[lang] = text;
        }
        return {
          partOfSpeech: userDesc.partOfSpeech,
          text: mergedText,
          ...(userDesc.pinyins?.length ? { pinyins: userDesc.pinyins } : {}),
        };
      });

      const item: Grammar = { ...body, language, descriptions: mergedDescs };
      await upsertGrammarItem(item);
      return reply.status(201).send(item);
    }
  );

  // Update grammar item
  fastify.put<{
    Params: { language: string; grammarId: string };
    Body: Partial<Grammar>;
  }>(
    "/:language/items/:grammarId",
    async (request, reply) => {
      const existing = await getGrammarItem(request.params.grammarId);
      if (!existing) return reply.notFound("Grammar item not found");
      const updated: Grammar = {
        ...existing,
        ...request.body,
        id: existing.id,
        language: existing.language,
      };
      await upsertGrammarItem(updated);
      return updated;
    }
  );

  // Delete grammar item
  fastify.delete<{ Params: { language: string; grammarId: string } }>(
    "/:language/items/:grammarId",
    async (request, reply) => {
      const deleted = await deleteGrammarItem(request.params.grammarId);
      if (!deleted) return reply.notFound("Grammar item not found");
      return { deleted: true };
    }
  );

  // ----- Grammar Groups -----

  fastify.get<{ Params: { language: string } }>(
    "/:language/groups",
    async (request) => {
      return await getGrammarGroups(request.params.language);
    }
  );

  fastify.post<{
    Params: { language: string };
    Body: { name: string };
  }>(
    "/:language/groups",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const group = await createGrammarGroup(request.params.language, request.body.name);
      return reply.status(201).send(group);
    }
  );

  fastify.put<{
    Params: { language: string; groupId: string };
    Body: { name: string };
  }>(
    "/:language/groups/:groupId",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    },
    async (request) => {
      return await updateGrammarGroup(request.params.groupId, { name: request.body.name });
    }
  );

  fastify.delete<{ Params: { language: string; groupId: string } }>(
    "/:language/groups/:groupId",
    async (request) => {
      await deleteGrammarGroup(request.params.groupId);
      return { deleted: true };
    }
  );

  fastify.post<{
    Params: { language: string; groupId: string };
    Body: { grammarIds: string[]; action: "add" | "remove" };
  }>(
    "/:language/groups/:groupId/grammar",
    {
      schema: {
        body: {
          type: "object",
          required: ["grammarIds", "action"],
          properties: {
            grammarIds: { type: "array", items: { type: "string" } },
            action: { type: "string", enum: ["add", "remove"] },
          },
        },
      },
    },
    async (request) => {
      return await modifyGrammarGroupMembers(
        request.params.groupId,
        request.body.grammarIds,
        request.body.action
      );
    }
  );
};

export default grammarRoutes;
