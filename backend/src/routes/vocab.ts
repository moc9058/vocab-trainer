import type { FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getWords,
  getWord,
  getWordFilters,
  addWord,
  updateWord,
  deleteWord,
  wordIdExists,
  getNextWordId,
  createLanguage,
  deleteLanguage,
  lookupWordByTerm,
  getTransliterationMap,
  flagWord,
} from "../firestore.js";
import type { Word, Example } from "../types.js";
import { TOPICS } from "../types.js";
import { generateMissingWords } from "../word-generator.js";
import { callLLM, stripMarkdownFences, validateWord } from "../llm.js";

const vocabRoutes: FastifyPluginAsync = async (fastify) => {
  // List words with filtering & pagination
  fastify.get<{
    Params: { language: string };
    Querystring: { search?: string; topic?: string; category?: string; level?: string; page?: string; limit?: string };
  }>("/:language", async (request, reply) => {
    const { language } = request.params;
    if (!(await languageExists(language))) {
      return reply.notFound(`Language '${language}' not found`);
    }

    const { search, topic, category, level } = request.query;
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? "50", 10) || 50));

    return await getWords(
      language,
      { search, topic, category, level },
      { page, limit }
    );
  });

  // Get available filter options for a language
  fastify.get<{ Params: { language: string } }>(
    "/:language/filters",
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      return await getWordFilters(language);
    }
  );

  // Lookup word by term in word_index
  fastify.get<{
    Params: { language: string };
    Querystring: { term: string };
  }>(
    "/:language/lookup",
    async (request, reply) => {
      const { language } = request.params;
      const { term } = request.query;
      if (!term) {
        return reply.badRequest("Query parameter 'term' is required");
      }
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      const entry = await lookupWordByTerm(language, term);
      if (!entry) return reply.notFound(`Term '${term}' not found in index`);
      return entry;
    }
  );

  // Get transliteration map (term → transliteration) for all words in a language
  fastify.get<{ Params: { language: string } }>(
    "/:language/transliteration-map",
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      const map = await getTransliterationMap(language);
      // Fire-and-forget: generate missing words in the background
      generateMissingWords(language, request.log);
      return map;
    }
  );

  // Get single word
  fastify.get<{ Params: { language: string; wordId: string } }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      const word = await getWord(wordId);
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
            level: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }

      const body = request.body;
      const id = body.id ?? (await getNextWordId(language));

      if (await wordIdExists(id)) {
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
        level: body.level,
        notes: body.notes,
      };

      await addWord(language, word);
      return reply.status(201).send(word);
    }
  );

  // Smart add word with LLM filling missing fields
  fastify.post<{
    Params: { language: string };
    Body: {
      term: string;
      transliteration?: string;
      definition?: Record<string, string>;
      grammaticalCategory?: string;
      topics?: string[];
      examples?: { sentence: string; translation: string }[];
      notes?: string;
    };
  }>(
    "/:language/smart-add",
    {
      schema: {
        body: {
          type: "object",
          required: ["term"],
          properties: {
            term: { type: "string" },
            transliteration: { type: "string" },
            definition: { type: "object", additionalProperties: { type: "string" } },
            grammaticalCategory: { type: "string" },
            topics: { type: "array", items: { type: "string" } },
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
            notes: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }

      const body = request.body;
      const term = body.term.trim();
      if (!term) return reply.badRequest("Term is required");

      // Check if word already exists
      const existing = await lookupWordByTerm(language, term);
      if (existing) {
        return reply.conflict(`Word '${term}' already exists in the database`);
      }

      // Build LLM prompt
      const fields: string[] = [`Term: ${term}`];
      if (body.transliteration) fields.push(`PROVIDED transliteration: ${body.transliteration}`);
      else fields.push("MISSING transliteration");
      if (body.definition && Object.keys(body.definition).length > 0) {
        fields.push(`PROVIDED definition: ${JSON.stringify(body.definition)}`);
      } else {
        fields.push("MISSING definition (generate Japanese, English, Korean)");
      }
      if (body.grammaticalCategory) fields.push(`PROVIDED grammaticalCategory: ${body.grammaticalCategory}`);
      else fields.push("MISSING grammaticalCategory");
      if (body.topics && body.topics.length > 0) fields.push(`PROVIDED topics: ${JSON.stringify(body.topics)}`);
      else fields.push("MISSING topics");
      if (body.examples && body.examples.length > 0) fields.push(`PROVIDED examples: ${JSON.stringify(body.examples)}`);
      else fields.push("MISSING examples (generate 2-3 example sentences with translations)");
      if (body.notes) fields.push(`PROVIDED notes: ${body.notes}`);
      else fields.push("MISSING notes");

      const systemPrompt = `You are a Chinese vocabulary expert. Given a Chinese term and optionally some pre-filled fields, generate a complete vocabulary entry.

CRITICAL: If a field is marked "PROVIDED", keep that EXACT value unchanged. Only generate values for fields marked "MISSING".

Return a JSON object:
{
  "term": "the Chinese word",
  "transliteration": "pinyin with tone marks",
  "definition": { "Japanese": "...", "English": "...", "Korean": "..." },
  "grammaticalCategory": "noun|verb|adjective|adverb|preposition|conjunction|particle|measure word|pronoun|interjection|idiom|phrase",
  "examples": [{ "sentence": "Chinese sentence", "translation": "English translation" }],
  "topics": ["..."],
  "notes": "brief usage notes"
}

Allowed topics: ${TOPICS.join(", ")}`;

      const userPrompt = fields.join("\n");

      let llmResult: Record<string, unknown>;
      try {
        const raw = await callLLM(systemPrompt, userPrompt);
        llmResult = JSON.parse(stripMarkdownFences(raw));
      } catch (err) {
        fastify.log.error({ err, term }, "LLM call failed for smart-add");
        return reply.internalServerError("Failed to generate word data");
      }

      // Merge: user-provided fields take priority
      const merged = {
        term,
        transliteration: body.transliteration || (llmResult.transliteration as string) || "",
        definition: (body.definition && Object.keys(body.definition).length > 0)
          ? body.definition
          : (llmResult.definition as Record<string, string>) || { English: "" },
        grammaticalCategory: body.grammaticalCategory || (llmResult.grammaticalCategory as string) || "",
        examples: (body.examples && body.examples.length > 0)
          ? body.examples
          : (llmResult.examples as { sentence: string; translation: string }[]) || [],
        topics: (body.topics && body.topics.length > 0)
          ? body.topics
          : ((llmResult.topics as string[]) || []).filter((t) => (TOPICS as readonly string[]).includes(t)),
        notes: body.notes || (llmResult.notes as string) || "",
      };

      // Ensure at least one valid topic
      if (merged.topics.length === 0) {
        merged.topics = ["Language Fundamentals"];
      }

      const id = await getNextWordId(language);
      const word: Word = {
        id,
        term: merged.term,
        transliteration: merged.transliteration,
        definition: merged.definition,
        grammaticalCategory: merged.grammaticalCategory,
        examples: merged.examples as Example[],
        topics: merged.topics as Word["topics"],
        level: "Advanced",
        notes: merged.notes,
      };

      await addWord(language, word);
      await flagWord(language, word.id);
      return reply.status(201).send(word);
    }
  );

  // Update word
  fastify.put<{ Params: { language: string; wordId: string }; Body: Partial<Word> }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }

      const updated = await updateWord(language, wordId, request.body);
      if (!updated) return reply.notFound(`Word '${wordId}' not found`);
      return updated;
    }
  );

  // Delete word
  fastify.delete<{ Params: { language: string; wordId: string } }>(
    "/:language/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }

      const deleted = await deleteWord(language, wordId);
      if (!deleted) return reply.notFound(`Word '${wordId}' not found`);
      return reply.status(204).send();
    }
  );

  // Create new language
  fastify.post<{ Params: { language: string } }>(
    "/:language/file",
    async (request, reply) => {
      const { language } = request.params;
      if (await languageExists(language)) {
        return reply.conflict(`Language '${language}' already exists`);
      }
      await createLanguage(language);
      return reply.status(201).send({ words: [] });
    }
  );

  // Delete language
  fastify.delete<{ Params: { language: string } }>(
    "/:language/file",
    async (request, reply) => {
      const { language } = request.params;
      const deleted = await deleteLanguage(language);
      if (!deleted) return reply.notFound(`Language '${language}' not found`);
      return reply.status(204).send();
    }
  );
};

export default vocabRoutes;
