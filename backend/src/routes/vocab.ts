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
  lookupWordsByTerms,
  flagWord,
  getVocabularyConfig,
} from "../firestore.js";
import type { Word, Example } from "../types.js";
import { TOPICS } from "../types.js";
import { callLLMWithSchema, stripMarkdownFences, validateWord, type Segment } from "../llm.js";

const LEVEL_OPTIONS: Record<string, string[]> = {
  chinese: ["HSK1-4", "HSK5", "HSK6", "HSK7-9", "Advanced"],
  japanese: ["JLPT5", "JLPT4", "JLPT3", "JLPT2", "JLPT1", "Advanced"],
};

// Map any granular HSK label the LLM (or a user) might emit onto the unified
// buckets above. The LLM is instructed to use the buckets directly in the
// prompt, but it sometimes slips back to "HSK2" etc. — this is the guarantee.
const CHINESE_LEVEL_NORMALIZE: Record<string, string> = {
  HSK1: "HSK1-4",
  HSK2: "HSK1-4",
  HSK3: "HSK1-4",
  HSK4: "HSK1-4",
  "HSK1-extended": "HSK1-4",
  "HSK2-extended": "HSK1-4",
  "HSK3-extended": "HSK1-4",
  "HSK4-extended": "HSK1-4",
  "HSK1-4": "HSK1-4",
  HSK5: "HSK5",
  "HSK5-extended": "HSK5",
  HSK6: "HSK6",
  "HSK6-extended": "HSK6",
  HSK7: "HSK7-9",
  HSK8: "HSK7-9",
  HSK9: "HSK7-9",
  "HSK7-9": "HSK7-9",
  "HSK7-9-extended": "HSK7-9",
  Advanced: "Advanced",
};

function normalizeLevel(language: string, level: string): string {
  if (!level) return "";
  if (language === "chinese") return CHINESE_LEVEL_NORMALIZE[level] ?? level;
  return level;
}

// All supported definition / example-translation languages. The LLM is asked to
// generate every entry in all four; the frontend display settings then control
// which subset the user sees.
const ALL_DEFINITION_LANGUAGES = ["en", "ja", "ko", "zh"] as const;

// Map our internal full language names to the ISO codes used in
// definition / example-translation Records. Languages outside this map
// (custom user languages) have no source-language entry to strip.
const LANGUAGE_TO_ISO: Record<string, string> = {
  chinese: "zh",
  english: "en",
  japanese: "ja",
  korean: "ko",
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
      flag?: boolean;
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
            flag: { type: "boolean" },
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

      // Build LLM prompt — definitions are always requested in all four
      // supported languages, but example translations exclude the source
      // language (a same-language "translation" of an example sentence is
      // redundant). Display filtering happens client-side via settings.
      const isChinese = language === "chinese";
      const sourceLangCode = LANGUAGE_TO_ISO[language]; // undefined for custom languages
      const exampleTranslationLanguages = ALL_DEFINITION_LANGUAGES.filter(
        (l) => l !== sourceLangCode
      );
      const defLangStr = ALL_DEFINITION_LANGUAGES.map((l) => `"${l}": "..."`).join(", ");
      const exTranslationSpec = `"translation": { ${exampleTranslationLanguages
        .map((l) => `"${l}": "..."`)
        .join(", ")} }`;

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
      const systemPrompt = fillPlaceholders(promptTemplate, {
        LANGUAGE: language,
        DEFINITION_LANGUAGES: defLangStr,
        EXAMPLE_TRANSLATION_SPEC: exTranslationSpec,
        TOPICS: TOPICS.join(", "),
        LEVELS: langLevels?.join(", ") ?? "",
        LEVEL_FIELD: langLevels ? `\n  "level": "one of the allowed levels",` : "",
        LEVELS_LINE: langLevels ? `\nAllowed levels: ${langLevels.join(", ")}` : "",
      });

      const userPrompt = JSON.stringify(userInput, null, 2);

      let llmResult: Record<string, unknown>;
      try {
        const raw = await callLLMWithSchema(systemPrompt, userPrompt, vocabConfig.smartAddSchema, "vocab/smart-add");
        llmResult = JSON.parse(stripMarkdownFences(raw));
      } catch (err) {
        fastify.log.error({ err, term }, "LLM call failed for smart-add");
        return reply.internalServerError("Failed to generate word data");
      }

      // Merge: user-provided fields take priority; definitions & examples get supplemented
      const userDefs = body.definitions ?? [];
      const userDefCount = userDefs.length;
      const llmDefs = (llmResult.definitions as { partOfSpeech: string; text: Record<string, string> }[]) || [];
      const userExCount = body.examples?.length ?? 0;
      const llmExamples = (llmResult.examples as { sentence: string; translation: string }[]) || [];

      // For each user-provided definition, keep the user's text in whatever
      // languages they supplied, and fill in the missing-language entries from
      // the LLM's same-index definition (the LLM is instructed to translate the
      // user's meaning into every required language code).
      const mergedUserDefs = userDefs.map((userDef, i) => {
        const llmDef = llmDefs[i];
        const mergedText: Record<string, string> = { ...(llmDef?.text ?? {}) };
        for (const [lang, text] of Object.entries(userDef.text ?? {})) {
          if (text && text.trim()) mergedText[lang] = text;
        }
        return {
          partOfSpeech: userDef.partOfSpeech || llmDef?.partOfSpeech || "",
          text: mergedText,
        };
      });

      const merged = {
        term,
        transliteration: isChinese ? (body.transliteration || (llmResult.transliteration as string) || "") : undefined,
        definitions: userDefCount > 0
          ? [...mergedUserDefs, ...llmDefs.slice(userDefCount)]
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
        level: langLevels
          ? normalizeLevel(language, body.level || (llmResult.level as string) || "")
          : "",
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

      // Strip the source language from example translations: a same-language
      // "translation" is meaningless and the LLM has a tendency to emit one
      // even when prompted not to. The prompt is the polite ask; this is the
      // guarantee. Definitions are NOT touched (a same-language definition is
      // a useful monolingual gloss).
      if (sourceLangCode) {
        for (const ex of examplesWithSegments) {
          if (ex.translation && typeof ex.translation === "object") {
            delete (ex.translation as Record<string, string>)[sourceLangCode];
          }
        }
      }

      // Link segments to existing words in DB
      const allSegmentTexts = [
        ...new Set(
          examplesWithSegments.flatMap(ex => ex.segments?.map(s => s.text) ?? [])
        ),
      ];
      if (allSegmentTexts.length > 0) {
        const matches = await lookupWordsByTerms(language, allSegmentTexts);
        const termToId = new Map(matches.map(m => [m.term, m.id]));
        for (const ex of examplesWithSegments) {
          if (!ex.segments) continue;
          for (const seg of ex.segments) {
            const wordId = termToId.get(seg.text);
            if (wordId) seg.id = wordId;
          }
        }
      }

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
      if (body.flag !== false) {
        await flagWord(language, word.id);
      }

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

  // Check which terms exist in the word index
  fastify.post<{ Params: { language: string }; Body: { terms: string[] } }>(
    "/:language/check-terms",
    {
      schema: {
        body: {
          type: "object",
          required: ["terms"],
          properties: {
            terms: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const { terms } = request.body;
      if (terms.length === 0) return { existing: [] };
      const matches = await lookupWordsByTerms(language, terms);
      const existing: Record<string, string> = {};
      for (const m of matches) existing[m.term] = m.id;
      return { existing };
    }
  );
};

export default vocabRoutes;
