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
  updateSegmentWordLinks,
  reconcileExampleSegmentRefs,
  unlinkWordFromExampleSentence,
  deleteWordIfOrphaned,
  reconcileIncomingSegments,
  droppedSegmentWordIds,
  deleteExampleSentences,
  removeFromAppearsInIds,
  isExampleReferencedByAny,
  getWordDrafts,
  getWordDraft,
  addWordDrafts,
  updateWordDraft,
  deleteWordDraft,
  getWordGroups,
  getWordGroup,
  createWordGroup,
  removeWordFromCategoryBGroups,
  updateWordGroup,
  reorderWordGroups,
  deleteWordGroup,
  modifyWordGroupMembers,
  GroupNotFoundError,
  DuplicateTermError,
} from "../firestore.js";
import type { Word, WordDraft, Example, ExampleSentence, HanjaReading } from "../types.js";
import { TOPICS } from "../types.js";
import { generateHanjaReadings } from "../hanja.js";
import { callLLMWithSchema, stripMarkdownFences, validateWord, segmentBatch, fillSegmentPinyin, type Segment } from "../llm.js";
import {
  ALL_DEFINITION_LANGUAGES,
  LANGUAGE_TO_ISO,
  translationIsEmpty,
  generateMissingExampleTranslations,
  type MissingTranslationItem,
} from "../exampleTranslations.js";

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

const ALLOWED_LANGUAGES = new Set(Object.keys(LANGUAGE_TO_ISO));

function fillPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

const vocabRoutes: FastifyPluginAsync = async (fastify) => {
  // Load vocabulary config from Firestore once during plugin registration
  const vocabConfig = await getVocabularyConfig();
  let segmentConfig: { prompt: string; schema: Record<string, unknown> } | undefined;
  try {
    segmentConfig = { prompt: vocabConfig.segmentPrompt, schema: vocabConfig.segmentSchema };
  } catch { /* fall back to hardcoded prompt in segmentBatch */ }

  // List words with filtering & pagination
  fastify.get<{
    Params: { language: string };
    Querystring: { search?: string; topic?: string; category?: string; level?: string; flaggedOnly?: string; groupId?: string; page?: string; limit?: string };
  }>("/:language", async (request, reply) => {
    const { language } = request.params;
    if (!(await languageExists(language))) {
      return reply.notFound(`Language '${language}' not found`);
    }

    const { search, topic, category, level, flaggedOnly, groupId } = request.query;
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? "50", 10) || 50));

    return await getWords(
      language,
      { search, topic, category, level, flaggedOnly: flaggedOnly === "true", groupId },
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
      // Empty translations (chip adds send `""`) become null so the LLM
      // treats them as missing and generates them, instead of echoing "".
      userInput.examples = (body.examples && body.examples.length > 0)
        ? body.examples.map(({ sentence, translation }) => ({
            sentence,
            translation: translationIsEmpty(translation as Example["translation"]) ? null : translation,
          })) : null;
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
      const llmDefs = (llmResult.definitions as { partOfSpeech: string; text: Record<string, string>; pinyins?: string[] }[]) || [];
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
        const pinyins = (userDef as any).pinyins?.length > 0
          ? (userDef as any).pinyins
          : (llmDef?.pinyins && llmDef.pinyins.length > 0 ? llmDef.pinyins : undefined);
        return {
          partOfSpeech: userDef.partOfSpeech || llmDef?.partOfSpeech || "",
          text: mergedText,
          ...(pinyins ? { pinyins } : {}),
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

      // Korean hanja readings, for Chinese words only. Started here and awaited
      // just before the word doc is built, so it runs alongside the example-sentence
      // writes instead of adding its own round-trip to the request. A failure is
      // logged and dropped: the word is worth more than its readings, and
      // `backfill-hanja-readings.ts` can fill in what is missing later.
      const hanjaPromise: Promise<HanjaReading[] | undefined> = isChinese
        ? generateHanjaReadings(merged.term, merged.transliteration).catch((err) => {
            fastify.log.error({ err, term }, "hanja reading generation failed");
            return undefined;
          })
        : Promise.resolve(undefined);

      // Parse segments from LLM response (Chinese only — segments are included in Call 1)
      const examplesWithSegments: Example[] = merged.examples.map((ex: any) => {
        if (!isChinese) {
          // Non-Chinese words must not carry segments at all: the schema still
          // exposes the key, and a stray LLM- or client-sent array would get
          // seg.id stamped and reconciled into appearsInIds links that no
          // non-Chinese code path maintains afterwards.
          const { segments: _drop, ...rest } = ex;
          return rest as Example;
        }
        if (!Array.isArray(ex.segments)) return ex as Example;
        const segments: Segment[] = [];
        for (const seg of ex.segments) {
          if (typeof seg?.text !== "string" || seg.text.length === 0) continue;
          const py = seg.pinyin ?? seg.transliteration;
          if (typeof py === "string" && py.length > 0) {
            segments.push({ text: seg.text, transliteration: py });
          } else {
            segments.push({ text: seg.text });
          }
        }
        return { sentence: ex.sentence, translation: ex.translation, segments } as Example;
      });

      // For user-provided Chinese examples with userSplits, override LLM segments with
      // the user's splits + LLM-filled pinyin.
      if (isChinese && userExCount > 0) {
        const fillItems: Array<{ index: number; sentence: string; splits: string[] }> = [];
        for (let i = 0; i < userExCount; i++) {
          const us = (body.examples![i] as any).userSplits as string[] | undefined;
          if (Array.isArray(us) && us.length > 0) {
            fillItems.push({ index: i, sentence: examplesWithSegments[i].sentence, splits: us });
          }
        }
        if (fillItems.length > 0) {
          const fillMap = await fillSegmentPinyin(
            fillItems.map((fi) => ({ sentence: fi.sentence, splits: fi.splits })),
          );
          for (let j = 0; j < fillItems.length; j++) {
            const rawSegs = fillMap.get(j);
            if (rawSegs) (examplesWithSegments[fillItems[j].index] as any).segments = rawSegs;
          }
        }
      }

      // Strip the source language from example translations and definitions:
      // a same-language translation/definition is redundant for the word's own language.
      if (sourceLangCode) {
        for (const ex of examplesWithSegments) {
          if (ex.translation && typeof ex.translation === "object") {
            delete (ex.translation as Record<string, string>)[sourceLangCode];
          }
        }
        for (const def of merged.definitions as { text: Record<string, string> }[]) {
          if (def.text && typeof def.text === "object") {
            // Keep the own-language gloss when it is all the definition has:
            // stripping it would store `text: {}` (the en-only fallback above
            // hits this for English words). A redundant gloss beats an empty
            // definition.
            const hasOther = Object.entries(def.text).some(
              ([lang, text]) => lang !== sourceLangCode && text && text.trim() !== "",
            );
            if (hasOther) delete def.text[sourceLangCode];
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

      // Create example sentence documents.
      // Dedup reads run in parallel; ID allocations and writes remain sequential.
      const existingLookups = await Promise.all(
        examplesWithSegments.map((ex) => findExampleByText(language, ex.sentence))
      );
      const exampleIds: string[] = [];
      // Docs whose final stored translation is still empty after the merge —
      // e.g. the LLM echoed the user's empty string. Same fallback as PUT.
      const needsTranslation: MissingTranslationItem[] = [];
      for (let i = 0; i < examplesWithSegments.length; i++) {
        const ex = examplesWithSegments[i];
        const existing = existingLookups[i];
        if (existing) {
          const updates: Partial<ExampleSentence> = {};

          // Segments: only fill if the existing doc has none yet.
          // Preserves manually-tuned or previously-generated segments.
          if (ex.segments && !existing.segments?.length) {
            updates.segments = ex.segments;
          }

          // Translation: fill missing, upgrade a legacy bare string, or add
          // language keys absent from the existing multi-lang object.
          const newTrans = ex.translation as Record<string, string> | null | undefined;
          const newTransIsMultiLang =
            newTrans != null &&
            typeof newTrans === "object" &&
            Object.keys(newTrans).length > 0;
          if (newTransIsMultiLang) {
            const existingTrans = existing.translation;
            const existingIsLegacyString = typeof existingTrans === "string";
            const existingObj: Record<string, string> =
              !existingIsLegacyString && existingTrans != null
                ? (existingTrans as Record<string, string>)
                : {};
            const existingHasAllKeys = Object.keys(newTrans).every(
              (k) => k in existingObj && existingObj[k]?.trim()
            );
            if (!existingHasAllKeys) {
              // Merge: prefer existing non-empty values, fill gaps from LLM.
              const merged: Record<string, string> = { ...newTrans };
              for (const [k, v] of Object.entries(existingObj)) {
                if (v && v.trim()) merged[k] = v;
              }
              updates.translation = merged;
            }
          }

          if (Object.keys(updates).length > 0) {
            await updateExampleSentence(existing.id, updates);
            if (updates.segments) {
              await reconcileExampleSegmentRefs(existing.id, existing.segments, updates.segments);
            }
          }
          if (translationIsEmpty(updates.translation ?? existing.translation)) {
            needsTranslation.push({ exampleId: existing.id, sentence: ex.sentence });
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
          };
          await addExampleSentence(es);
          await reconcileExampleSegmentRefs(exId, [], ex.segments);
          if (translationIsEmpty(ex.translation)) {
            needsTranslation.push({ exampleId: exId, sentence: ex.sentence });
          }
          exampleIds.push(exId);
        }
      }

      // Fallback: generate translations the merge left empty, and mirror them
      // into the word's inline examples so the stored word doc matches.
      if (needsTranslation.length > 0) {
        const generated = await generateMissingExampleTranslations(language, needsTranslation, {
          log: fastify.log,
        });
        for (let i = 0; i < examplesWithSegments.length; i++) {
          const trans = generated.get(exampleIds[i]);
          if (trans && translationIsEmpty(examplesWithSegments[i].translation)) {
            examplesWithSegments[i].translation = trans;
          }
        }
      }

      const hanjaReadings = await hanjaPromise;

      const word: Word = {
        id,
        term: merged.term,
        transliteration: merged.transliteration,
        definitions: merged.definitions,
        examples: examplesWithSegments,
        topics: merged.topics as Word["topics"],
        level: merged.level,
        notes: merged.notes,
        ...(hanjaReadings ? { hanjaReadings } : {}),
      };

      // addWord now defaults appearsInIds to include own exampleIds.
      await addWord(language, word, { exampleIds });

      // Reverse-link: find existing example sentences where this word appears as a segment.
      // Run fire-and-forget so the 201 response is not blocked by the full collection scan.
      // A run lost to an instance shutdown self-repairs via POST
      // /:language/sync-segment-links or scripts/backfill-word-appears-in.ts
      // (see docs/group-ab-crud-audit.md).
      linkWordToExistingExamples(language, id, merged.term).catch((e) =>
        fastify.log.error({ err: e, wordId: id, term: merged.term }, "linkWordToExistingExamples failed")
      );

      if (body.flag !== false) {
        await flagWord(language, word.id);
      }

      return reply.status(201).send(word);
    }
  );

  // Update word
  fastify.put<{ Params: { language: string; wordId: string }; Body: Partial<Word> }>(
    "/:language/:wordId",
    {
      schema: {
        body: {
          type: "object",
          // Whitelist of client-editable fields. With Fastify's default AJV
          // (removeAdditional), additionalProperties:false silently STRIPS
          // anything else — a client-sent language/appearsInIds/exampleIds/id
          // used to flow straight into words.doc().update(). Inner arrays stay
          // loose on purpose (translation is string | Record, examples carry
          // segments/userSplits) — same convention as the draft PUT schema.
          additionalProperties: false,
          properties: {
            term: { type: "string", minLength: 1 },
            transliteration: { type: "string" },
            definitions: { type: "array" },
            examples: { type: "array" },
            topics: { type: "array", items: { type: "string" } },
            level: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
    },
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
        const isChinese = language === "chinese";
        // Queue of examples whose text changed without incoming segments —
        // these will be batch re-segmented after the main loop.
        const needsResegment: Array<{
          target: ExampleSentence;
          exampleId: string;
          newSentence: string;
          userSplits?: string[];
        }> = [];
        // Examples (new or existing) that have no translation and need LLM generation.
        const needsTranslation: MissingTranslationItem[] = [];

        for (const ex of body.examples) {
          // Only treat segments as "being edited" if the frontend explicitly
          // sent them. WordFormModal omits segments entirely (its form state
          // doesn't carry them), so we must preserve old segments in that case.
          const hasIncomingSegs = Array.isArray((ex as { segments?: unknown }).segments);
          const exUserSplits = (ex as any).userSplits as string[] | undefined;
          const hasUserSplits = isChinese && Array.isArray(exUserSplits) && exUserSplits.length > 0;
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
            // If neither the stored nor the incoming translation has content, queue
            // this example for LLM translation generation (same as the brand-new path).
            if (translationIsEmpty(target.translation) && translationIsEmpty(ex.translation)) {
              needsTranslation.push({ exampleId: target.id, sentence: target.sentence });
            }
            if (hasIncomingSegs) {
              await reconcileIncomingSegments(target.segments, ex.segments!);
              const unlinked1 = [...new Set(ex.segments!.filter(s => !s.id && s.text?.trim()).map(s => s.text))];
              if (unlinked1.length > 0) {
                const hits1 = await lookupWordsByTerms(language, unlinked1);
                const termToId1 = new Map(hits1.map(m => [m.term, m.id]));
                for (const seg of ex.segments!) {
                  if (!seg.id) { const wId = termToId1.get(seg.text); if (wId) seg.id = wId; }
                }
              }
              updates.segments = ex.segments;
            } else if (isChinese && (hasUserSplits || target.sentence !== ex.sentence)) {
              // Text changed or user supplied explicit splits.
              // Snapshot the old state and queue for re-segmentation after the loop.
              needsResegment.push({
                target: {
                  ...target,
                  segments: target.segments?.map((s) => ({ ...s })),
                },
                exampleId: target.id,
                newSentence: ex.sentence,
                userSplits: hasUserSplits ? exUserSplits : undefined,
              });
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
              const unlinked2 = [...new Set(ex.segments!.filter(s => !s.id && s.text?.trim()).map(s => s.text))];
              if (unlinked2.length > 0) {
                const hits2 = await lookupWordsByTerms(language, unlinked2);
                const termToId2 = new Map(hits2.map(m => [m.term, m.id]));
                for (const seg of ex.segments!) {
                  if (!seg.id) { const wId = termToId2.get(seg.text); if (wId) seg.id = wId; }
                }
              }
            }
            const es: ExampleSentence = {
              id: newId,
              sentence: ex.sentence,
              translation: ex.translation,
              segments: ex.segments,
              language,
            };
            await addExampleSentence(es);
            await reconcileExampleSegmentRefs(newId, [], ex.segments);
            newExampleIds.push(newId);
            // Queue for LLM translation if the frontend sent no translation.
            if (translationIsEmpty(ex.translation)) {
              needsTranslation.push({ exampleId: newId, sentence: ex.sentence });
            }
            if (isChinese && !hasIncomingSegs) {
              needsResegment.push({
                target: { ...es },
                exampleId: newId,
                newSentence: ex.sentence,
                userSplits: hasUserSplits ? exUserSplits : undefined,
              });
            }
          }
        }

        // --- Batch re-segmentation for Chinese examples whose text changed ---
        if (isChinese && needsResegment.length > 0) {
          // Split into items with user-provided splits (fill pinyin only) vs
          // items needing full auto-segmentation.
          const withUserSplits = needsResegment
            .map((r, idx) => ({ ...r, origIdx: idx }))
            .filter((r) => r.userSplits);
          const withoutUserSplits = needsResegment
            .map((r, idx) => ({ ...r, origIdx: idx }))
            .filter((r) => !r.userSplits);

          // Build a merged result map keyed by original needsResegment index.
          const mergedSegMap = new Map<number, Segment[]>();

          // Example docs, indexes and appearsInIds links are already written by
          // the loop above — an LLM failure here must degrade (the sentence
          // keeps its old segments or none; backfill-missing-segments.ts covers
          // it later), not 500 the PUT mid-write and strand orphaned examples
          // the word doc never gets to reference.
          if (withoutUserSplits.length > 0) {
            try {
              const segMap = await segmentBatch(
                withoutUserSplits.map((r) => r.newSentence),
                segmentConfig,
              );
              for (let j = 0; j < withoutUserSplits.length; j++) {
                const segs = segMap.get(j);
                if (segs) mergedSegMap.set(withoutUserSplits[j].origIdx, segs);
              }
            } catch (err) {
              fastify.log.error({ err }, "segmentBatch failed; keeping prior segments");
            }
          }

          if (withUserSplits.length > 0) {
            try {
              const fillMap = await fillSegmentPinyin(
                withUserSplits.map((r) => ({ sentence: r.newSentence, splits: r.userSplits! })),
              );
              for (let j = 0; j < withUserSplits.length; j++) {
                const segs = fillMap.get(j);
                if (segs) mergedSegMap.set(withUserSplits[j].origIdx, segs);
              }
            } catch (err) {
              fastify.log.error({ err }, "fillSegmentPinyin failed; keeping prior segments");
            }
          }

          // Bulk word-lookup for segment→wordId linking
          const allSegTexts = new Set<string>();
          for (const [, segs] of mergedSegMap) {
            for (const s of segs) allSegTexts.add(s.text);
          }
          const matches = allSegTexts.size > 0
            ? await lookupWordsByTerms(language, [...allSegTexts])
            : [];
          const termToId = new Map(matches.map((m) => [m.term, m.id]));

          for (let i = 0; i < needsResegment.length; i++) {
            const { target, exampleId } = needsResegment[i];
            const rawSegs = mergedSegMap.get(i);
            if (!rawSegs) continue;

            const newSegs: { text: string; transliteration?: string; id?: string }[] = rawSegs.map((s) => ({
              text: s.text,
              transliteration: s.transliteration,
              ...(termToId.get(s.text) ? { id: termToId.get(s.text) } : {}),
            }));

            await reconcileIncomingSegments(target.segments, newSegs);
            await updateExampleSentence(exampleId, { segments: newSegs });
            await reconcileExampleSegmentRefs(exampleId, target.segments, newSegs);
            for (const dropped of droppedSegmentWordIds(target.segments, newSegs)) {
              maybeOrphaned.add(dropped);
            }
          }
        }

        // --- Generate missing translations (brand-new or existing without translation) ---
        if (needsTranslation.length > 0) {
          await generateMissingExampleTranslations(language, needsTranslation, { log: fastify.log });
        }

        // Examples the user removed outright or renamed out from under this
        // word. Delete an example only if no other word AND no grammar item
        // still references it (cross-domain check guards dedup-shared docs).
        const droppedExampleIds = (currentExIds ?? []).filter(
          (id) => !newExampleIds.includes(id),
        );
        const toDelete: string[] = [];
        for (const exId of droppedExampleIds) {
          const referenced = await isExampleReferencedByAny(
            language,
            exId,
            { exceptWordId: wordId },
          );
          if (!referenced) toDelete.push(exId);
        }
        // Run the delete BEFORE updateWord so that deleteExampleSentences can
        // atomically strip the example ids from segment-referenced words'
        // appearsInIds while this word's exampleIds still includes them.
        if (toDelete.length > 0) {
          await deleteExampleSentences(toDelete);
        }

        // Remove examples from the update body — stored via exampleIds now
        const { examples: _, ...rest } = body;
        let updated: Word | null;
        try {
          updated = await updateWord(language, wordId, rest, { exampleIds: newExampleIds });
        } catch (err) {
          if (err instanceof DuplicateTermError) return reply.conflict(err.message);
          throw err;
        }
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

      let updated: Word | null;
      try {
        updated = await updateWord(language, wordId, body);
      } catch (err) {
        if (err instanceof DuplicateTermError) return reply.conflict(err.message);
        throw err;
      }
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
  // Sync segment word-ID links for the given example sentence IDs.
  // For each example, looks up all segment texts in word_index and writes any
  // missing seg.id fields plus appearsInIds back-references.
  fastify.post<{ Params: { language: string }; Body: { exampleIds: string[] } }>(
    "/:language/sync-segment-links",
    {
      schema: {
        body: {
          type: "object",
          required: ["exampleIds"],
          properties: { exampleIds: { type: "array", items: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const { exampleIds } = request.body;
      if (!Array.isArray(exampleIds) || exampleIds.length === 0) {
        return reply.badRequest("exampleIds must be a non-empty array");
      }
      await Promise.all(exampleIds.map((id) => updateSegmentWordLinks(id, language)));
      return reply.status(200).send({ ok: true });
    }
  );

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
      if (!ALLOWED_LANGUAGES.has(language)) {
        return reply.badRequest(`Language '${language}' is not supported. Allowed: ${[...ALLOWED_LANGUAGES].join(", ")}`);
      }
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

  // ----- Word Drafts -----
  // Staging area for bulk JSON uploads (and the local OCR tool): raw uploads
  // reviewed in the word UI, then promoted to real words via smart-add. No LLM
  // calls here — mirrors the grammar_drafts flow.

  fastify.get<{ Params: { language: string } }>(
    "/:language/drafts",
    async (request) => {
      return await getWordDrafts(request.params.language);
    }
  );

  fastify.post<{
    Params: { language: string };
    Body: { drafts: Array<Omit<WordDraft, "language" | "id" | "createdAt">> };
  }>(
    "/:language/drafts",
    {
      schema: {
        body: {
          type: "object",
          required: ["drafts"],
          properties: {
            drafts: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["term"],
                properties: {
                  term: { type: "string", minLength: 1 },
                  transliteration: { type: "string" },
                  definitions: { type: "array" },
                  examples: { type: "array" },
                  level: { type: "string" },
                  topics: { type: "array", items: { type: "string" } },
                  sourceImage: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const now = new Date().toISOString();
      const ts = Date.now();
      // Flag drafts whose term already exists as a live word so the review panel
      // can surface a "duplicate" badge (single batched word_index lookup).
      const existingTerms = new Set(
        (await lookupWordsByTerms(language, request.body.drafts.map((d) => d.term))).map((e) => e.term)
      );
      const drafts: WordDraft[] = request.body.drafts.map((d, i) => {
        // Drafts no longer carry a group target — the registration group is
        // picked in the UI — so a legacy `groups` field is dropped here.
        const { groups: _groups, ...rest } = d as typeof d & { groups?: string[] };
        return {
          ...rest,
          language,
          createdAt: now,
          ...(existingTerms.has(d.term) ? { duplicate: true } : {}),
          // ts (13-digit epoch, lexically = chronologically sortable) + zero-padded
          // index preserves upload order within a batch; see getWordDrafts sort.
          id: `draft-${language}-${ts}-${String(i).padStart(4, "0")}-${Math.random().toString(36).slice(2, 8)}`,
        };
      });
      await addWordDrafts(drafts);
      return reply.status(201).send({ created: drafts.length, drafts });
    }
  );

  fastify.get<{ Params: { language: string; draftId: string } }>(
    "/:language/drafts/:draftId",
    async (request, reply) => {
      const draft = await getWordDraft(request.params.draftId);
      if (!draft) return reply.notFound("Word draft not found");
      return draft;
    }
  );

  // Save review edits back to the draft without promoting it. Arrays/strings
  // replace wholesale (send `examples: []` to clear); identity fields
  // (language/createdAt) and omitted fields are preserved.
  fastify.put<{
    Params: { language: string; draftId: string };
    Body: Partial<Omit<WordDraft, "id" | "language" | "createdAt">>;
  }>(
    "/:language/drafts/:draftId",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            term: { type: "string" },
            transliteration: { type: "string" },
            definitions: { type: "array" },
            examples: { type: "array" },
            level: { type: "string" },
            topics: { type: "array", items: { type: "string" } },
            sourceImage: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const updated = await updateWordDraft(request.params.draftId, request.body);
      if (!updated) return reply.notFound("Word draft not found");
      return updated;
    }
  );

  fastify.delete<{ Params: { language: string; draftId: string } }>(
    "/:language/drafts/:draftId",
    async (request, reply) => {
      const deleted = await deleteWordDraft(request.params.draftId);
      if (!deleted) return reply.notFound("Word draft not found");
      return { deleted: true };
    }
  );

  // ========== Word Group Routes ==========

  fastify.get<{ Params: { language: string } }>(
    "/:language/groups",
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) return reply.notFound(`Language '${language}' not found`);
      return await getWordGroups(language);
    }
  );

  fastify.post<{ Params: { language: string }; Body: { name: string; category?: "A" | "B" } }>(
    "/:language/groups",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            category: { type: "string", enum: ["A", "B"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const { name, category } = request.body;
      if (!(await languageExists(language))) return reply.notFound(`Language '${language}' not found`);
      const trimmed = name.trim();
      if (!trimmed) return reply.badRequest("Group name must not be blank");
      // Category B creation is idempotent by (language, name): B sets are
      // name-joined across word_groups and grammar_groups, so a duplicate-named
      // B group is actively destructive — loadGroupBGroups' name-keyed merge
      // hides one of them and its members vanish from the study set. A retry
      // after a half-failed pair create must therefore find, not duplicate.
      // Category A stays create-always: its identity is the id, and two
      // same-named lessons may be intentional. Oldest match wins so retries are
      // deterministic even against pre-existing duplicates.
      if (category === "B") {
        const existing = (await getWordGroups(language))
          .filter((g) => g.category === "B" && g.name === trimmed)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (existing) return existing;
      }
      const group = await createWordGroup(language, trimmed, category);
      reply.code(201);
      return group;
    }
  );

  /** Group B quiz "3" key: drop a word from every category-B group it belongs to. */
  fastify.delete<{ Params: { language: string; wordId: string } }>(
    "/:language/group-b/members/:wordId",
    async (request, reply) => {
      const { language, wordId } = request.params;
      if (!(await languageExists(language))) return reply.notFound(`Language '${language}' not found`);
      const removedFromGroupIds = await removeWordFromCategoryBGroups(language, wordId);
      return { removedFromGroupIds };
    }
  );

  fastify.put<{ Params: { language: string }; Body: { groupIds: string[] } }>(
    "/:language/groups/order",
    {
      schema: {
        body: {
          type: "object",
          required: ["groupIds"],
          properties: {
            groupIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) return reply.notFound(`Language '${language}' not found`);
      try {
        return await reorderWordGroups(language, request.body.groupIds);
      } catch (error) {
        return reply.badRequest(error instanceof Error ? error.message : "Invalid group order");
      }
    }
  );

  fastify.put<{ Params: { language: string; groupId: string }; Body: { name: string } }>(
    "/:language/groups/:groupId",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { language, groupId } = request.params;
      const { name } = request.body;
      const trimmed = name.trim();
      if (!trimmed) return reply.badRequest("Group name must not be blank");
      // Ownership check: group doc ids are globally unique, so without the
      // language comparison any /:language/ segment could rename (or below,
      // delete) another language's group.
      const group = await getWordGroup(groupId);
      if (!group || group.language !== language) {
        return reply.notFound(`Group '${groupId}' not found`);
      }
      try {
        return await updateWordGroup(groupId, { name: trimmed });
      } catch (err) {
        request.log.error({ err, groupId }, "word group rename failed");
        return reply.internalServerError("Failed to rename group");
      }
    }
  );

  fastify.delete<{ Params: { language: string; groupId: string } }>(
    "/:language/groups/:groupId",
    async (request, reply) => {
      const { language, groupId } = request.params;
      const group = await getWordGroup(groupId);
      if (!group || group.language !== language) {
        return reply.notFound(`Group '${groupId}' not found`);
      }
      await deleteWordGroup(groupId);
      reply.code(204);
    }
  );

  fastify.post<{
    Params: { language: string; groupId: string };
    Body: { wordIds: string[]; action: "add" | "remove" };
  }>(
    "/:language/groups/:groupId/words",
    {
      schema: {
        body: {
          type: "object",
          required: ["wordIds", "action"],
          properties: {
            wordIds: { type: "array", items: { type: "string" } },
            action: { type: "string", enum: ["add", "remove"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, groupId } = request.params;
      const { wordIds, action } = request.body;
      const group = await getWordGroup(groupId);
      if (!group || group.language !== language) {
        return reply.notFound(`Group '${groupId}' not found`);
      }
      try {
        return await modifyWordGroupMembers(groupId, wordIds, action);
      } catch (err) {
        // The pre-fetch above covers the normal not-found; GroupNotFoundError
        // here means a delete raced between the check and the transaction.
        // Anything else is a real failure and must not masquerade as 404 —
        // the old blanket catch reported "not found" even when the add had
        // already committed.
        if (err instanceof GroupNotFoundError) {
          return reply.notFound(`Group '${groupId}' not found`);
        }
        request.log.error({ err, groupId }, "group membership update failed");
        return reply.internalServerError("Failed to update group membership");
      }
    }
  );
};

export default vocabRoutes;
