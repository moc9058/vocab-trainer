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
  getTransliterationMap,
  flagWord,
} from "../firestore.js";
import type { Word, Meaning, Example, Topic } from "../types.js";
import { TOPICS } from "../types.js";
import { generateMissingWords } from "../word-generator.js";
import { callLLM, stripMarkdownFences, validateWord, type Segment } from "../llm.js";

const vocabRoutes: FastifyPluginAsync = async (fastify) => {
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

  // Smart add word with LLM filling missing fields
  fastify.post<{
    Params: { language: string };
    Body: {
      term: string;
      transliteration?: string;
      definitions?: { partOfSpeech: string; text: Record<string, string> }[];
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
      const fields: string[] = [`Term: ${term}`];
      if (isChinese) {
        if (body.transliteration) fields.push(`PROVIDED transliteration: ${body.transliteration}`);
        else fields.push("MISSING transliteration (generate pinyin with tone marks)");
      }
      if (body.definitions && body.definitions.length > 0) {
        fields.push(`PROVIDED definitions: ${JSON.stringify(body.definitions)}`);
      } else {
        fields.push("MISSING definitions (generate meanings with partOfSpeech and text in ja, en, ko)");
      }
      if (body.topics && body.topics.length > 0) fields.push(`PROVIDED topics: ${JSON.stringify(body.topics)}`);
      else fields.push("MISSING topics");
      if (body.examples && body.examples.length > 0) fields.push(`PROVIDED examples: ${JSON.stringify(body.examples)}`);
      else fields.push("MISSING examples (generate 2-3 example sentences with translations)");
      if (body.notes) fields.push(`PROVIDED notes: ${body.notes}`);
      else fields.push("MISSING notes");

      const definitionGuidelines = `
Definition guidelines:
- Only create multiple meanings if there is a clear semantic distinction (meanings cannot be substituted in the same sentence).
- Do NOT split meanings for minor, stylistic, or context-dependent differences.
- If the word has only one core meaning, return a single definition entry.
- Group closely related meanings into one definition rather than splitting them.`;

      const systemPrompt = isChinese
        ? `You are a Chinese vocabulary expert. Given a Chinese term and optionally some pre-filled fields, generate a complete vocabulary entry.

CRITICAL: If a field is marked "PROVIDED", keep that EXACT value unchanged. Only generate values for fields marked "MISSING".
${definitionGuidelines}

For each example sentence, also provide "segments": an array of word-level segments with pinyin.

Return a JSON object:
{
  "term": "the Chinese word",
  "transliteration": "pinyin with tone marks",
  "definitions": [{ "partOfSpeech": "noun|verb|adjective|adverb|preposition|conjunction|particle|measure word|pronoun|interjection|idiom|phrase", "text": { "ja": "...", "en": "...", "ko": "..." } }],
  "examples": [{ "sentence": "Chinese sentence", "translation": "English translation", "segments": [{ "text": "word", "pinyin": "pīnyīn" }] }],
  "topics": ["..."],
  "notes": "brief usage notes"
}

Segment rules:
- Segment into natural Chinese words (not individual characters unless standalone)
- Use tone marks on pinyin (e.g. "nǐ hǎo" not "ni3 hao3")
- Keep punctuation as separate segments with no pinyin
- Omit "pinyin" for non-Chinese tokens

Allowed topics: ${TOPICS.join(", ")}`
        : `You are a ${language} vocabulary expert. Given a ${language} term and optionally some pre-filled fields, generate a complete vocabulary entry.

CRITICAL: If a field is marked "PROVIDED", keep that EXACT value unchanged. Only generate values for fields marked "MISSING".
${definitionGuidelines}

Return a JSON object:
{
  "term": "the ${language} word",
  "definitions": [{ "partOfSpeech": "noun|verb|adjective|adverb|preposition|conjunction|particle|pronoun|interjection|idiom|phrase", "text": { "ja": "...", "en": "...", "ko": "..." } }],
  "examples": [{ "sentence": "${language} sentence using the word"${language === "english" ? "" : ', "translation": "English translation"'} }],
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
        transliteration: isChinese ? (body.transliteration || (llmResult.transliteration as string) || "") : undefined,
        definitions: (body.definitions && body.definitions.length > 0)
          ? body.definitions
          : (llmResult.definitions as { partOfSpeech: string; text: Record<string, string> }[]) || [{ partOfSpeech: "", text: { en: "" } }],
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
        level: "Advanced",
        notes: merged.notes,
      };

      await addWord(language, word);
      await flagWord(language, word.id);

      // Discover and auto-generate missing words from segments
      let generatedWords: Word[] = [];
      if (isChinese) {
        try {
          generatedWords = await generateMissingWordsFromSegments(language, word, fastify.log);
        } catch (err) {
          fastify.log.warn({ err, term }, "Missing word generation from segments failed");
        }
      }

      return reply.status(201).send({ ...word, generatedWords });
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

/** Discover unknown words from segments and batch-generate them */
async function generateMissingWordsFromSegments(
  language: string,
  sourceWord: Word,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }
): Promise<Word[]> {
  // Collect unique segment terms (exclude punctuation and the source term)
  const punctuation = /^[\s\p{P}\p{S}\p{N}]+$/u;
  const segmentTerms = new Map<string, { pinyin?: string; sentence: string; translation: string }>();

  for (const ex of sourceWord.examples) {
    if (!ex.segments) continue;
    for (const seg of ex.segments) {
      if (
        punctuation.test(seg.text) ||
        seg.text === sourceWord.term ||
        seg.text.length < 2 ||
        segmentTerms.has(seg.text)
      ) continue;
      segmentTerms.set(seg.text, {
        pinyin: seg.transliteration,
        sentence: ex.sentence,
        translation: ex.translation,
      });
    }
  }

  if (segmentTerms.size === 0) return [];

  // Batch-lookup which terms already exist in the DB
  const existing = await lookupWordsByTerms(language, [...segmentTerms.keys()]);
  const existingSet = new Set(existing.map((e) => e.term));
  const missing = [...segmentTerms.entries()].filter(([term]) => !existingSet.has(term));

  if (missing.length === 0) return [];
  logger.info(`[smart-add] Found ${missing.length} missing words from segments, generating...`);

  // Build batch prompt — we provide term, pinyin, and example sentence; LLM fills the rest
  const wordEntries = missing.map(([term, info]) => ({
    term,
    transliteration: info.pinyin ?? "",
    example: { sentence: info.sentence, translation: info.translation },
  }));

  const systemPrompt = `You are a Chinese vocabulary expert. Generate vocabulary entries for Chinese words.
Each word already has a term, transliteration (pinyin), and one example sentence provided.
You need to fill: definitions, topics, notes.

Return a JSON object with a "words" array:
[{
  "term": "the word (keep as provided)",
  "transliteration": "keep as provided",
  "definitions": [{ "partOfSpeech": "noun|verb|adjective|adverb|preposition|conjunction|particle|measure word|pronoun|interjection|idiom|phrase", "text": { "ja": "...", "en": "...", "ko": "..." } }],
  "topics": ["..."],
  "notes": "brief usage notes or empty string"
}]

Allowed topics: ${TOPICS.join(", ")}`;

  const userPrompt = wordEntries
    .map((w) => `- ${w.term} (${w.transliteration}), example: "${w.example.sentence}" → "${w.example.translation}"`)
    .join("\n");

  const addedWords: Word[] = [];
  try {
    const raw = await callLLM(systemPrompt, `Generate entries for these words:\n\n${userPrompt}`);
    const parsed = JSON.parse(stripMarkdownFences(raw));
    const generated: unknown[] = parsed.words ?? [];

    for (const g of generated) {
      if (!g || typeof g !== "object") continue;
      const entry = g as Record<string, unknown>;
      const term = entry.term as string;
      if (!term || existingSet.has(term)) continue;

      // Find the original segment data for the example sentence
      const info = segmentTerms.get(term);
      if (!info) continue;

      const id = await getNextWordId(language);
      const topics = ((entry.topics as string[]) ?? []).filter((t) => (TOPICS as readonly string[]).includes(t));

      const newWord: Word = {
        id,
        term,
        transliteration: (entry.transliteration as string) || info.pinyin || "",
        definitions: (entry.definitions as Meaning[]) || [{ partOfSpeech: "", text: { en: "" } }],
        examples: [{ sentence: info.sentence, translation: info.translation }],
        topics: (topics.length > 0 ? topics : ["Language Fundamentals"]) as Word["topics"],
        level: "Advanced",
        notes: (entry.notes as string) || "",
      };

      await addWord(language, newWord);
      await flagWord(language, newWord.id);
      existingSet.add(term);
      addedWords.push(newWord);
    }

    if (addedWords.length > 0) {
      logger.info(`[smart-add] Auto-generated ${addedWords.length} words from segments`);
    }
  } catch (err) {
    logger.warn(`[smart-add] Batch generation for missing words failed:`, err);
  }
  return addedWords;
}

export default vocabRoutes;
