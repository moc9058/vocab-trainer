import { prepareWordRegistration, PreparationError } from "../services/word-registration.js";
import { resolveWordRegistrationGroups, WordRegistrationGroupError } from "../word-registration-groups.js";
import { normalizeWordDefinitions, normalizeWordRecord } from "../word-format.js";
import { contextualDefinitions, sourceContextInstructions } from "../import-definitions.js";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import {
  languageExists,
  getWords,
  getWord,
  getWordSearchIndex,
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
  normalizeWordGroupMembership,
  GroupNotFoundError,
  DuplicateTermError,
} from "../firestore.js";
import type { Word, WordDraft, Example, ExampleSentence, HanjaReading, SearchIn } from "../types.js";
import { TOPICS } from "../types.js";
import { generateHanjaReadings } from "../hanja.js";
import { callLLM, stripMarkdownFences, validateWord, segmentBatch, fillSegmentPinyin, type Segment } from "../llm.js";
import {
  ALL_DEFINITION_LANGUAGES,
  LANGUAGE_TO_ISO,
  translationIsEmpty,
  generateMissingExampleTranslations,
  type MissingTranslationItem,
} from "../exampleTranslations.js";

/**
 * term → word id for segment linking, degrading to "no links" on failure.
 *
 * Linking a segment to an existing word is enrichment, not the point of the
 * write. The PUT below calls this from INSIDE its example loop — example docs,
 * indexes and appearsInIds links are already committed by then, while the word
 * doc is not — so a throw here would strand example sentences the word never
 * gets to reference. That is the same reasoning (and the same shape) as the
 * `segmentBatch` / `fillSegmentPinyin` catches further down. A missing link is
 * precisely what `POST /:language/sync-segment-links` and
 * `scripts/backfill-segment-word-ids.ts` exist to repair.
 */
async function linkSegmentTerms(
  language: string,
  terms: string[],
  log: FastifyBaseLogger,
): Promise<Map<string, string>> {
  if (terms.length === 0) return new Map();
  try {
    const hits = await lookupWordsByTerms(language, terms);
    return new Map(hits.map((m) => [m.term, m.id]));
  } catch (err) {
    log.error({ err }, "segment word lookup failed; leaving segments unlinked");
    return new Map();
  }
}

const ALLOWED_LANGUAGES = new Set(Object.keys(LANGUAGE_TO_ISO));

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
    Querystring: { search?: string; searchIn?: string; topic?: string; category?: string; level?: string; flaggedOnly?: string; groupId?: string; page?: string; limit?: string };
  }>("/:language", async (request, reply) => {
    const { language } = request.params;
    if (!(await languageExists(language))) {
      return reply.notFound(`Language '${language}' not found`);
    }

    const { search, topic, level, groupId } = request.query;
    const searchIn: SearchIn = request.query.searchIn === "meaning" || request.query.searchIn === "both"
      ? request.query.searchIn
      : "term";
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? "50", 10) || 50));

    return await getWords(
      language,
      { search, searchIn, topic, level, groupId },
      { page, limit }
    );
  });

  // Slim search-preview index (term/transliteration/pos/meanings — no examples).
  // Registered above `/:language/:wordId`; find-my-way prefers the static
  // segment anyway, this just keeps the intent visible.
  fastify.get<{ Params: { language: string } }>(
    "/:language/search-index",
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      return { items: await getWordSearchIndex(language) };
    }
  );

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
      sourceContext?: import("../types.js").ImportSourceContext;
      transliteration?: string;
      definitions?: { text: Record<string, string> }[];
      topics?: string[];
      examples?: { sentence: string; translation: string }[];
      level?: string;
      notes?: string;
      groupIds?: string[];
      groupBIds?: string[];
    };
  }>(
    "/:language/smart-add",
    {
      schema: {
        body: {
          type: "object",
          required: ["term"],
          properties: {
            sourceContext: {
              type: "object", additionalProperties: false,
              required: ["sentence", "surface", "contextualMeaning", "explanationLanguage"],
              properties: {
                sentence: { type: "string", maxLength: 8000 }, surface: { type: "string", minLength: 1 },
                contextualMeaning: { type: "string", maxLength: 2000 }, explanationLanguage: { type: "string", enum: ["ja", "en", "ko", "zh"] },
              },
            },
            term: { type: "string" },
            transliteration: { type: "string" },
            definitions: {
              type: "array",
              items: {
                type: "object",
                properties: {
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
                  // Declared because the handler reads it (the Chinese chip flow
                  // sends segment texts here). It used to survive only because
                  // this item schema has no `additionalProperties: false`, so
                  // tightening the schema would have silently dropped it.
                  userSplits: { type: "array", items: { type: "string" } },
                },
              },
            },
            level: { type: "string" },
            notes: { type: "string" },
            groupIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
            groupBIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      let prepared: Awaited<ReturnType<typeof prepareWordRegistration>>;
      try { prepared = await prepareWordRegistration(language, request.body, fastify.log); }
      catch (error) { if (error instanceof PreparationError) return reply.code(error.statusCode).send({ message: error.message }); throw error; }
      const { merged, examplesWithSegments, registrationGroups, hanjaReadings } = prepared;
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
      try {
        await addWord(language, word, { exampleIds, registrationGroups });
      } catch (err) {
        if (err instanceof WordRegistrationGroupError) return reply.badRequest(err.message);
        if (err instanceof DuplicateTermError) return reply.conflict(err.message);
        throw err;
      }

      // Reverse-link: find existing example sentences where this word appears as a segment.
      // Run fire-and-forget so the 201 response is not blocked by the full collection scan.
      // A run lost to an instance shutdown self-repairs via POST
      // /:language/sync-segment-links or scripts/backfill-word-appears-in.ts
      // (see docs/group-ab-crud-audit.md).
      linkWordToExistingExamples(language, id, merged.term).catch((e) =>
        fastify.log.error({ err: e, wordId: id, term: merged.term }, "linkWordToExistingExamples failed")
      );

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
              const termToId1 = await linkSegmentTerms(language, unlinked1, fastify.log);
              for (const seg of ex.segments!) {
                if (!seg.id) { const wId = termToId1.get(seg.text); if (wId) seg.id = wId; }
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
              const termToId2 = await linkSegmentTerms(language, unlinked2, fastify.log);
              for (const seg of ex.segments!) {
                if (!seg.id) { const wId = termToId2.get(seg.text); if (wId) seg.id = wId; }
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
          const termToId = await linkSegmentTerms(language, [...allSegTexts], fastify.log);

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
          ...normalizeWordRecord(rest),
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

  /**
   * Re-file every word of the language according to category-A group PRIORITY:
   * a word in several A groups keeps only its highest-priority membership, and a word
   * in none is added to the top-priority group. Category B is untouched.
   *
   * `dryRun` computes the same result without writing — the UI previews it before the
   * user confirms, since the write is not reversible.
   *
   * `expectedGroupIds` is a PRECONDITION, not a second reorder path: it asserts that
   * the priority the preview was computed against is still the priority being applied,
   * so a reorder from another tab turns into a 409 instead of a surprising outcome.
   * Reordering itself stays with `PUT /groups/order`.
   */
  fastify.post<{
    Params: { language: string };
    Body?: { dryRun?: boolean; expectedGroupIds?: string[] };
  }>(
    "/:language/groups/normalize",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            dryRun: { type: "boolean" },
            expectedGroupIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      if (!(await languageExists(language))) return reply.notFound(`Language '${language}' not found`);
      // Fastify leaves `body` undefined for a bodyless POST.
      const { dryRun = false, expectedGroupIds } = request.body ?? {};

      if (expectedGroupIds) {
        const current = (await getWordGroups(language))
          .filter((g) => g.category !== "B")
          .map((g) => g.id);
        if (
          current.length !== expectedGroupIds.length
          || current.some((id, i) => id !== expectedGroupIds[i])
        ) {
          return reply.conflict("Group priority changed since the preview was computed");
        }
      }

      try {
        return await normalizeWordGroupMembership(language, { dryRun });
      } catch (err) {
        request.log.error({ err, language }, "word group normalize failed");
        return reply.internalServerError(
          err instanceof Error ? err.message : "Failed to normalize groups"
        );
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
