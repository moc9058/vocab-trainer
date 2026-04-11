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
  getNextExampleId,
  createLanguage,
  deleteLanguage,
  lookupWordByTerm,
  lookupWordsByTerms,
  flagWord,
  getVocabularyConfig,
  addExampleSentence,
  findExampleByText,
  updateExampleSentence,
  getExampleSentencesByIds,
  linkWordToExistingExamples,
  reconcileExampleSegmentRefs,
  unlinkWordFromExampleSentence,
  deleteWordIfOrphaned,
  reconcileIncomingSegments,
  droppedSegmentWordIds,
  deleteExampleSentences,
  removeFromAppearsInIds,
  isExampleIdClaimedByOtherWord,
} from "../firestore.js";
import type { Word, Example, ExampleSentence } from "../types.js";
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

      // Create example sentence documents
      const exampleIds: string[] = [];
      for (const ex of examplesWithSegments) {
        // Check dedup: same sentence text shares one example_sentence doc
        const existing = await findExampleByText(language, ex.sentence);
        if (existing) {
          // Overwrite segments with the later occurrence, then reconcile
          // referenced words' appearsInIds (new ↔ old diff).
          if (ex.segments) {
            await updateExampleSentence(existing.id, { segments: ex.segments });
            await reconcileExampleSegmentRefs(existing.id, existing.segments, ex.segments);
          }
          exampleIds.push(existing.id);
        } else {
          const exId = await getNextExampleId(language);
          const es: ExampleSentence = {
            id: exId,
            sentence: ex.sentence,
            translation: ex.translation,
            segments: ex.segments,
            language,
            ownerWordId: id,
          };
          await addExampleSentence(es);
          // Register newly-referenced words in their appearsInIds.
          await reconcileExampleSegmentRefs(exId, [], ex.segments);
          exampleIds.push(exId);
        }
      }

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

      // addWord now defaults appearsInIds to include own exampleIds.
      await addWord(language, word, { exampleIds });

      // Reverse-link: find existing example sentences where this word appears as a segment
      await linkWordToExistingExamples(language, id, merged.term);

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

      const body = request.body;

      // If the frontend sends examples, resolve them to example sentence docs
      if (Array.isArray(body.examples)) {
        // Fetch existing word to get current exampleIds
        const existingWord = await getWord(wordId);
        if (!existingWord) return reply.notFound(`Word '${wordId}' not found`);

        // Get current example sentence docs for segment preservation
        const currentExIds = (existingWord as any).exampleIds as string[] | undefined;
        let oldExSentences: ExampleSentence[] = [];
        if (currentExIds && currentExIds.length > 0) {
          oldExSentences = await getExampleSentencesByIds(currentExIds);
        }
        const oldById = new Map(oldExSentences.map((es) => [es.id, es]));
        const oldBySentence = new Map(oldExSentences.map((es) => [es.sentence, es]));

        const newExampleIds: string[] = [];
        // Track candidates that may have become orphaned across all examples
        // touched by this PUT. We resolve them after the word update below.
        const maybeOrphaned = new Set<string>();

        for (const ex of body.examples) {
          // Only treat segments as "being edited" if the frontend explicitly
          // sent them. WordFormModal omits segments entirely (its form state
          // doesn't carry them), so we must preserve old segments in that case.
          const hasIncomingSegs = Array.isArray((ex as { segments?: unknown }).segments);
          const incomingId = (ex as { id?: string }).id;

          // --- Resolve target example sentence ---
          // Priority:
          //   1. Frontend sent back an explicit id AND the id belongs to this
          //      word's own exampleIds → in-place update (sentence text,
          //      translation, segments may all differ).
          //   2. Frontend sent an id that is NOT in currentExIds → this is an
          //      appears-in/shared example. Look it up directly and edit in
          //      place. Do NOT push it into newExampleIds (don't steal
          //      ownership just because the hydrated list passed through).
          //   3. No id → legacy/new-entry path: match by sentence text
          //      against own examples, then via dedup index, else create.
          let target: ExampleSentence | null = null;
          let claimOwnership = true; // whether to push target.id into newExampleIds

          if (incomingId) {
            const own = oldById.get(incomingId);
            if (own) {
              target = own;
              // claimOwnership stays true — it was already owned
            } else {
              const [byId] = await getExampleSentencesByIds([incomingId]);
              if (byId) {
                target = byId;
                claimOwnership = false; // hydrated pass-through, leave ownership alone
              }
            }
          }
          if (!target) {
            const bySentence = oldBySentence.get(ex.sentence);
            if (bySentence) {
              target = bySentence;
              // claimOwnership stays true — still an own example
            }
          }
          if (!target) {
            const found = await findExampleByText(language, ex.sentence);
            if (found) {
              target = found;
              // No id was provided, so the user typed this text fresh — treat
              // the dedup hit as "they intend to own this example" and push.
              claimOwnership = true;
            }
          }

          if (target) {
            // In-place update: sentence, translation, segments (any subset).
            const updates: Partial<ExampleSentence> = {};
            if (target.sentence !== ex.sentence) {
              updates.sentence = ex.sentence;
            }
            if (JSON.stringify(target.translation) !== JSON.stringify(ex.translation)) {
              updates.translation = ex.translation;
            }
            if (hasIncomingSegs) {
              await reconcileIncomingSegments(target.segments, ex.segments!);
              updates.segments = ex.segments;
            }
            if (Object.keys(updates).length > 0) {
              await updateExampleSentence(target.id, updates);
            }
            if (hasIncomingSegs) {
              await reconcileExampleSegmentRefs(target.id, target.segments, ex.segments);
              for (const dropped of droppedSegmentWordIds(target.segments, ex.segments)) {
                maybeOrphaned.add(dropped);
              }
            }
            if (claimOwnership) newExampleIds.push(target.id);
          } else {
            // Brand new example — create + set this word as owner
            const newId = await getNextExampleId(language);
            if (hasIncomingSegs) {
              await reconcileIncomingSegments(undefined, ex.segments!);
            }
            const es: ExampleSentence = {
              id: newId,
              sentence: ex.sentence,
              translation: ex.translation,
              segments: ex.segments,
              language,
              ownerWordId: wordId,
            };
            await addExampleSentence(es);
            await reconcileExampleSegmentRefs(newId, [], ex.segments);
            newExampleIds.push(newId);
          }
        }

        // Examples the user removed outright or renamed out from under this
        // word. For each one, decide whether the example doc can be deleted
        // entirely (this word owns it AND no other word still claims it) or
        // merely released from this word's grip (dedup share — leave the doc
        // alone, the real owner keeps managing it).
        const droppedExampleIds = (currentExIds ?? []).filter(
          (id) => !newExampleIds.includes(id),
        );
        const toDelete: string[] = [];
        for (const exId of droppedExampleIds) {
          const es = oldExSentences.find((x) => x.id === exId);
          if (!es) continue;
          if (es.ownerWordId !== wordId) continue; // dedup share — skip
          const claimedElsewhere = await isExampleIdClaimedByOtherWord(
            language,
            exId,
            wordId,
          );
          if (!claimedElsewhere) toDelete.push(exId);
        }
        // Run the delete BEFORE updateWord so that deleteExampleSentences can
        // atomically strip the example ids from segment-referenced words'
        // appearsInIds while this word's exampleIds still includes them.
        if (toDelete.length > 0) {
          await deleteExampleSentences(toDelete);
        }

        // Remove examples from the update body — stored via exampleIds now
        const { examples: _, ...rest } = body;
        const updated = await updateWord(language, wordId, rest, { exampleIds: newExampleIds });
        if (!updated) return reply.notFound(`Word '${wordId}' not found`);

        // updateWord only unions into appearsInIds; it never prunes. For each
        // dropped example, strip it from this word's appearsInIds unless the
        // word is still a segment of it (can only happen when the example
        // doc survived the delete step above, i.e. dedup-shared or not owned
        // here).
        let appearsInStripped = false;
        if (droppedExampleIds.length > 0) {
          const stillPresent = await getExampleSentencesByIds(droppedExampleIds);
          const keep = new Set<string>();
          for (const es of stillPresent) {
            if ((es.segments ?? []).some((s) => s.id === wordId)) keep.add(es.id);
          }
          const toStrip = droppedExampleIds.filter((id) => !keep.has(id));
          if (toStrip.length > 0) {
            await removeFromAppearsInIds(wordId, toStrip);
            appearsInStripped = true;
          }
        }

        // After all reconciliation, delete any word that became fully
        // orphaned because a merge/split removed its last reference.
        // Skip the word being edited — its appearsInIds was just rewritten.
        for (const wId of maybeOrphaned) {
          if (wId === wordId) continue;
          await deleteWordIfOrphaned(language, wId);
        }

        // Re-fetch if the post-updateWord prune changed appearsInIds so the
        // response reflects the final state.
        if (appearsInStripped) {
          const refreshed = await getWord(wordId);
          if (refreshed) return refreshed;
        }
        return updated;
      }

      const updated = await updateWord(language, wordId, body);
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

  // Unlink a word from a specific example sentence.
  // Behavior:
  //   - If the word has no own exampleIds → delete the word entirely.
  //   - Otherwise → clear the segment's `id` on that example and remove the
  //     exampleId from the word's appearsInIds.
  fastify.post<{
    Params: { language: string; wordId: string };
    Body: { sentence: string };
  }>(
    "/:language/:wordId/unlink-segment",
    {
      schema: {
        body: {
          type: "object",
          required: ["sentence"],
          properties: { sentence: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { language, wordId } = request.params;
      const { sentence } = request.body;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      const result = await unlinkWordFromExampleSentence(language, wordId, sentence);
      return result;
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
