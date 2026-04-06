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
  flagWord,
  getVocabularyConfig,
} from "../firestore.js";
import type { Word, Example } from "../types.js";
import { TOPICS } from "../types.js";
import { callLLMFullWithSchema, stripMarkdownFences, validateWord, type Segment } from "../llm.js";

const LEVEL_OPTIONS: Record<string, string[]> = {
  chinese: ["HSK1-4", "HSK5", "HSK6", "HSK7-9", "Advanced"],
  japanese: ["JLPT5", "JLPT4", "JLPT3", "JLPT2", "JLPT1", "Advanced"],
};

function fillPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

const vocabRoutes: FastifyPluginAsync = async (fastify) => {
  // Load vocabulary config from Firestore once during plugin registration
  const vocabConfig = await getVocabularyConfig();

  // List words with filtering & pagination
  fastify.get<{
    Params: { language: string };
    Querystring: { search?: string; topic?: string; category?: string; level?: string; flaggedOnly?: string; page?: string; limit?: string };
  }>("/:language", async (request, reply) => {
    const { language } = request.params;
    if (!(await languageExists(language))) {
      return reply.notFound(`Language '${language}' not found`);
    }

    const { search, topic, category, level, flaggedOnly } = request.query;
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? "50", 10) || 50));

    return await getWords(
      language,
      { search, topic, category, level, flaggedOnly: flaggedOnly === "true" },
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

  // Smart add word with LLM filling missing fields
  fastify.post<{
    Params: { language: string };
    Body: {
      term: string;
      transliteration?: string;
      definitions?: { partOfSpeech: string; text: Record<string, string> }[];
      topics?: string[];
      examples?: { sentence: string; translation: string }[];
      level?: string;
      notes?: string;
      definitionLanguages?: string[];
      exampleTranslationLanguages?: string[];
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
            definitions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  partOfSpeech: { type: "string" },
                  text: { type: "object", additionalProperties: { type: "string" } },
                },
              },
            },
            topics: { type: "array", items: { type: "string" } },
            examples: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sentence: { type: "string" },
                  translation: {},
                },
              },
            },
            level: { type: "string" },
            notes: { type: "string" },
            definitionLanguages: { type: "array", items: { type: "string" } },
            exampleTranslationLanguages: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        await createLanguage(language);
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
      const isChinese = language === "chinese";
      const defLangs = body.definitionLanguages ?? ["ja", "en", "ko"];
      const exLangs = body.exampleTranslationLanguages ?? ["en"];
      const defLangStr = defLangs.map((l) => `"${l}": "..."`).join(", ");
      const exTranslationSpec = exLangs.length === 1
        ? `"translation": "${exLangs[0] === "en" ? "English" : exLangs[0]} translation"`
        : `"translation": { ${exLangs.map((l) => `"${l}": "..."`).join(", ")} }`;

      const langLevels = LEVEL_OPTIONS[language];
      const userInput: Record<string, unknown> = { term };
      if (isChinese) {
        userInput.transliteration = body.transliteration || null;
      }
      userInput.definitions = (body.definitions && body.definitions.length > 0)
        ? body.definitions : null;
      userInput.topics = (body.topics && body.topics.length > 0)
        ? body.topics : null;
      userInput.examples = (body.examples && body.examples.length > 0)
        ? body.examples : null;
      if (langLevels) {
        userInput.level = body.level || null;
      }
      userInput.notes = body.notes || null;

      const promptTemplate = vocabConfig.smartAddPrompts[language]
        ?? vocabConfig.smartAddPrompts["default"];
      const exTranslationSpecForPrompt = language === "english" && exLangs.length === 1 && exLangs[0] === "en"
        ? ""
        : `, ${exTranslationSpec}`;
      const systemPrompt = fillPlaceholders(promptTemplate, {
        LANGUAGE: language,
        DEFINITION_LANGUAGES: defLangStr,
        EXAMPLE_TRANSLATION_SPEC: isChinese ? exTranslationSpec : exTranslationSpecForPrompt,
        TOPICS: TOPICS.join(", "),
        LEVELS: langLevels?.join(", ") ?? "",
        LEVEL_FIELD: langLevels ? `\n  "level": "one of the allowed levels",` : "",
        LEVELS_LINE: langLevels ? `\nAllowed levels: ${langLevels.join(", ")}` : "",
      });

      const userPrompt = JSON.stringify(userInput, null, 2);

      let llmResult: Record<string, unknown>;
      try {
        const raw = await callLLMFullWithSchema(systemPrompt, userPrompt, vocabConfig.smartAddSchema, "vocab/smart-add");
        llmResult = JSON.parse(stripMarkdownFences(raw));
      } catch (err) {
        fastify.log.error({ err, term }, "LLM call failed for smart-add");
        return reply.internalServerError("Failed to generate word data");
      }

      // Merge: user-provided fields take priority; definitions & examples get supplemented
      const userDefCount = body.definitions?.length ?? 0;
      const llmDefs = (llmResult.definitions as { partOfSpeech: string; text: Record<string, string> }[]) || [];
      const userExCount = body.examples?.length ?? 0;
      const llmExamples = (llmResult.examples as { sentence: string; translation: string }[]) || [];

      const merged = {
        term,
        transliteration: isChinese ? (body.transliteration || (llmResult.transliteration as string) || "") : undefined,
        definitions: userDefCount > 0
          ? [...body.definitions!, ...llmDefs.slice(userDefCount)]
          : llmDefs.length > 0 ? llmDefs : [{ partOfSpeech: "", text: { en: "" } }],
        examples: userExCount > 0
          ? [
              ...body.examples!.map((ex, i) => {
                const llmEx = llmExamples[i];
                const hasTranslation = typeof ex.translation === "string"
                  ? ex.translation.trim() !== ""
                  : ex.translation != null && Object.keys(ex.translation).length > 0;
                const merged = hasTranslation
                  ? ex
                  : llmEx?.translation ? { ...ex, translation: llmEx.translation } : ex;
                // Carry over LLM-generated segments for user-provided examples
                const llmSegs = (llmEx as any)?.segments;
                if (llmSegs && !(merged as any).segments) {
                  return { ...merged, segments: llmSegs };
                }
                return merged;
              }),
              ...llmExamples.slice(userExCount),
            ]
          : llmExamples,
        topics: (body.topics && body.topics.length > 0)
          ? body.topics
          : ((llmResult.topics as string[]) || []).filter((t) => (TOPICS as readonly string[]).includes(t)),
        level: langLevels ? (body.level || (llmResult.level as string) || "") : "",
        notes: body.notes || (llmResult.notes as string) || "",
      };

      // Ensure at least one valid topic
      if (merged.topics.length === 0) {
        merged.topics = ["Language Fundamentals"];
      }

      // Parse segments from LLM response (Chinese only — segments are included in Call 1)
      const examplesWithSegments: Example[] = merged.examples.map((ex: any) => {
        if (!isChinese || !Array.isArray(ex.segments)) return ex as Example;
        const segments: Segment[] = [];
        for (const seg of ex.segments) {
          if (typeof seg?.text !== "string" || seg.text.length === 0) continue;
          if (typeof seg.pinyin === "string" && seg.pinyin.length > 0) {
            segments.push({ text: seg.text, transliteration: seg.pinyin });
          } else {
            segments.push({ text: seg.text });
          }
        }
        return { sentence: ex.sentence, translation: ex.translation, segments } as Example;
      });

      const id = await getNextWordId(language);
      const word: Word = {
        id,
        term: merged.term,
        transliteration: merged.transliteration,
        definitions: merged.definitions,
        examples: examplesWithSegments,
        topics: merged.topics as Word["topics"],
        level: merged.level,
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
