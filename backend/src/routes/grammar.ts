import type { FastifyPluginAsync } from "fastify";
import {
  getGrammarItems,
  getGrammarItem,
  getGrammarItemsByIds,
  addGrammar,
  updateGrammar,
  deleteGrammarItem,
  getGrammarStatements,
  getGrammarDrafts,
  getGrammarDraft,
  updateGrammarDraft,
  addGrammarDrafts,
  deleteGrammarDraft,
  getGrammarGroups,
  createGrammarGroup,
  removeGrammarFromCategoryBGroups,
  updateGrammarGroup,
  deleteGrammarGroup,
  modifyGrammarGroupMembers,
  getGrammarConfig,
  getGrammarSettings,
  setGrammarSettings,
  addExampleSentence,
  findExampleByText,
  getNextExampleId,
  isExampleReferencedByAny,
  deleteExampleSentences,
  updateExampleSentence,
  reconcileExampleSegmentRefs,
  lookupWordsByTerms,
} from "../firestore.js";
import {
  callLLMWithSchema,
  stripMarkdownFences,
  fillSegmentPinyin,
  fillGrammarTransliteration,
} from "../llm.js";
import type { Grammar, GrammarDraft, GrammarExample, Meaning, ExampleSentence, GrammarSettings } from "../types.js";
import {
  needsMoreTranslations,
  generateMissingExampleTranslations,
  type MissingTranslationItem,
} from "../exampleTranslations.js";

type ExampleSegment = { text: string; transliteration?: string; id?: string };

// Unlike vocab (which enriches definitions to ALL_DEFINITION_LANGUAGES),
// grammar descriptions are Japanese-only by design.
const GRAMMAR_DEFINITION_LANGUAGES = ["ja"] as const;

function fillPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

/**
 * Resolve incoming inline grammar examples to `example_sentences` doc IDs.
 *
 * Reuses the existing sha256 dedup index (shared with vocab examples), so a
 * sentence used by both a grammar item and a vocab word resolves to one doc.
 *
 * Segment handling (Chinese):
 *   - When `ex.userSplits` is present, the LLM fills pinyin for those splits
 *     via `fillSegmentPinyin`, then segment word IDs are wired via
 *     `lookupWordsByTerms` (same pattern as vocab smart-add).
 *   - On a NEW example, segments are written at create time.
 *   - On a REUSED example with no existing segments, segments are added via
 *     `updateExampleSentence` + `reconcileExampleSegmentRefs` so word
 *     `appearsInIds` stay in lockstep with the new segment refs.
 *   - A reused example that already has segments keeps them untouched
 *     (consistent with vocab smart-add — don't clobber manually-tuned or
 *     previously-generated segment metadata).
 */
async function resolveExamplesToIds(
  language: string,
  examples: GrammarExample[] | undefined,
): Promise<string[]> {
  if (!examples || examples.length === 0) return [];

  // Phase 1: dedup-or-allocate IDs in parallel.
  const lookups = await Promise.all(
    examples.map((ex) => findExampleByText(language, ex.sentence)),
  );

  // Phase 2: for any example carrying userSplits, build segments via the LLM
  // pinyin filler. Done in one batched call to amortize the LLM cost.
  const splitItems: Array<{ index: number; sentence: string; splits: string[] }> = [];
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i];
    if (Array.isArray(ex.userSplits) && ex.userSplits.length >= 2) {
      splitItems.push({ index: i, sentence: ex.sentence, splits: ex.userSplits });
    }
  }
  const segmentsByIndex = new Map<number, ExampleSegment[]>();
  if (splitItems.length > 0) {
    const fillMap = await fillSegmentPinyin(
      splitItems.map((it) => ({ sentence: it.sentence, splits: it.splits })),
    );
    // Link segment word IDs from the word_index in one round-trip.
    const allTexts = [
      ...new Set(splitItems.flatMap((it) => it.splits)),
    ];
    const matches = await lookupWordsByTerms(language, allTexts);
    const termToId = new Map(matches.map((m) => [m.term, m.id]));
    for (let j = 0; j < splitItems.length; j++) {
      const llmSegs = fillMap.get(j);
      if (!llmSegs) continue;
      const segs: ExampleSegment[] = llmSegs.map((s) => {
        const wId = termToId.get(s.text);
        return wId ? { ...s, id: wId } : { ...s };
      });
      segmentsByIndex.set(splitItems[j].index, segs);
    }
  }

  // Phase 3: create or reuse each example doc; thread in segments where present.
  const exampleIds: string[] = [];
  // Docs whose stored translation is empty (grammar saves historically wrote
  // "" verbatim) — LLM-filled after the loop, same fallback as the vocab routes.
  const needsTranslation: MissingTranslationItem[] = [];
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i];
    const existing = lookups[i];
    const segs = segmentsByIndex.get(i);

    if (existing) {
      // Only fill segments on an existing doc if it has none yet. Mirrors
      // the vocab smart-add rule: never clobber manually-tuned segments.
      if (segs && (!existing.segments || existing.segments.length === 0)) {
        await updateExampleSentence(existing.id, { segments: segs });
        await reconcileExampleSegmentRefs(existing.id, existing.segments, segs);
      }
      if (needsMoreTranslations(existing.translation, language)) {
        needsTranslation.push({ exampleId: existing.id, sentence: existing.sentence });
      }
      exampleIds.push(existing.id);
      continue;
    }

    const exId = await getNextExampleId(language);
    const es: ExampleSentence = {
      id: exId,
      sentence: ex.sentence,
      translation: ex.translation,
      language,
      ...(segs ? { segments: segs } : {}),
    };
    await addExampleSentence(es);
    if (segs) {
      await reconcileExampleSegmentRefs(exId, [], segs);
    }
    if (needsMoreTranslations(ex.translation, language)) {
      needsTranslation.push({ exampleId: exId, sentence: ex.sentence });
    }
    exampleIds.push(exId);
  }

  if (needsTranslation.length > 0) {
    await generateMissingExampleTranslations(language, needsTranslation, {
      route: "grammar/translate-examples",
    });
  }
  return exampleIds;
}

const grammarRoutes: FastifyPluginAsync = async (fastify) => {
  const grammarConfig = await getGrammarConfig();

  /**
   * Statement pinyin for a Chinese grammar item.
   *
   * Applied at every write path rather than at one of them, so "a stored Chinese
   * grammar item has a reading" holds regardless of which route the caller used —
   * only `GrammarFormModal` ever had an input for the field, so anything else
   * (article import, drafts, a direct API call) would otherwise store nothing and
   * leave the quiz reveal blank.
   *
   * NEVER overwrites: a value already supplied or already stored wins, so a
   * hand-tuned reading survives an edit. Returns undefined for non-Chinese
   * languages (the field is Chinese-only) and for a statement with no Chinese
   * material at all — see `fillGrammarTransliteration`. A failure is logged and
   * swallowed; losing the reading must not cost the user the write.
   */
  async function resolveTransliteration(
    language: string,
    statement: string | undefined,
    existing: string | undefined
  ): Promise<string | undefined> {
    const current = existing?.trim() || undefined;
    if (current || language !== "chinese" || !statement?.trim()) return current;
    try {
      return (await fillGrammarTransliteration([statement])).get(0);
    } catch (err) {
      fastify.log.error(
        { err, statement },
        "Failed to generate grammar transliteration; storing without it"
      );
      return undefined;
    }
  }

  // GET /settings — get grammar-wide settings
  fastify.get("/settings", async () => {
    const settings = await getGrammarSettings();
    return settings ?? { defaultDefinitionLanguage: "en" };
  });

  // PUT /settings — update grammar-wide settings
  fastify.put<{ Body: GrammarSettings }>(
    "/settings",
    {
      schema: {
        body: {
          type: "object",
          required: ["defaultDefinitionLanguage"],
          properties: {
            defaultDefinitionLanguage: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const settings: GrammarSettings = {
        defaultDefinitionLanguage: request.body.defaultDefinitionLanguage,
      };
      await setGrammarSettings(settings);
      return settings;
    }
  );

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

  // Bulk fetch by id. The quiz screens hydrate every grammar item of a session up front so
  // a reveal never needs the network; doing that one-by-one through the route above was one
  // request (and one Firestore read) per item. Missing ids are omitted, not nulls.
  fastify.post<{
    Params: { language: string };
    Body: { ids: string[] };
  }>(
    "/:language/items/batch",
    {
      schema: {
        body: {
          type: "object",
          required: ["ids"],
          properties: { ids: { type: "array", items: { type: "string" } } },
        },
      },
    },
    async (request) => {
      const items = await getGrammarItemsByIds(request.body.ids);
      return { items };
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
            transliteration: { type: "string" },
            descriptions: { type: "array" },
            examples: { type: "array" },
            exampleIds: { type: "array", items: { type: "string" } },
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
      // The one LLM call on this otherwise LLM-free route, and only when the
      // caller sent no reading — the field has no other way to get filled.
      const [transliteration, exampleIds] = await Promise.all([
        resolveTransliteration(language, body.statement, body.transliteration),
        resolveExamplesToIds(language, body.examples),
      ]);
      const { examples: _legacy, ...rest } = body;
      const item: Grammar = { ...rest, language, transliteration };
      await addGrammar(item, { exampleIds });
      return reply.status(201).send({ ...item, exampleIds });
    }
  );

  // Smart-add: enriches descriptions with missing language codes via LLM,
  // resolves examples to the shared `example_sentences` collection, then
  // persists with `exampleIds` + bidirectional back-references.
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
            transliteration: { type: "string" },
            descriptions: { type: "array" },
            examples: { type: "array" },
            exampleIds: { type: "array", items: { type: "string" } },
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

      // Grammar descriptions are Japanese-only by design (unlike vocab, which
      // enriches to all of ALL_DEFINITION_LANGUAGES) — only "ja" is ever
      // requested from or accepted out of the LLM here.
      const defLangStr = GRAMMAR_DEFINITION_LANGUAGES.map((l) => `"${l}": "..."`).join(", ");
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
        const mergedText: Record<string, string> = {};
        for (const lang of GRAMMAR_DEFINITION_LANGUAGES) {
          const userText = userDesc.text?.[lang];
          if (userText && userText.trim()) {
            mergedText[lang] = userText;
          } else if (llmDesc?.text?.[lang]) {
            mergedText[lang] = llmDesc.text[lang];
          }
        }
        return {
          partOfSpeech: userDesc.partOfSpeech,
          text: mergedText,
          ...(userDesc.pinyins?.length ? { pinyins: userDesc.pinyins } : {}),
        };
      });

      // Statement pinyin. Only the manual form has a field for it, so every
      // queue-driven create (article import, drafts, segment chips) would
      // otherwise store a Chinese grammar item with no reading at all — and the
      // quiz reveal has nothing to show. Generated only when the user did not
      // supply one; a failure here must not sink the whole add.
      // Runs alongside example resolution, which is itself several round-trips.
      const [transliteration, exampleIds] = await Promise.all([
        resolveTransliteration(language, body.statement, body.transliteration),
        resolveExamplesToIds(language, body.examples),
      ]);
      const { examples: _legacy, ...rest } = body;
      const item: Grammar = { ...rest, language, descriptions: mergedDescs, transliteration };
      await addGrammar(item, { exampleIds });
      return reply.status(201).send({ ...item, exampleIds });
    }
  );

  // Update grammar item: reconcile examples (dedup/create new ones,
  // orphan-delete dropped ones via cross-domain check, sync back-references).
  fastify.put<{
    Params: { language: string; grammarId: string };
    Body: Partial<Grammar>;
  }>(
    "/:language/items/:grammarId",
    async (request, reply) => {
      const { language, grammarId } = request.params;
      const existing = await getGrammarItem(grammarId);
      if (!existing) return reply.notFound("Grammar item not found");

      const body = request.body;
      const oldExampleIds = (existing.exampleIds ?? []) as string[];

      // Fills a reading that was never there (the item predates generation, or
      // came in through a path that had none); a stored or supplied one is
      // returned untouched, so an edit can't clobber a hand-tuned value.
      // Started here and awaited at the patch so it overlaps the example work.
      const transliterationPromise = resolveTransliteration(
        language,
        body.statement ?? existing.statement,
        body.transliteration ?? existing.transliteration
      );

      // If the caller sent `examples`, normalize them. Otherwise keep the old
      // exampleIds untouched (a patch without `examples` shouldn't drop them).
      let newExampleIds = oldExampleIds;
      if (Array.isArray(body.examples)) {
        newExampleIds = await resolveExamplesToIds(language, body.examples);
      }

      // Orphan-delete any examples dropped from this grammar item, but only
      // if no other word or grammar item still references them.
      const droppedIds = oldExampleIds.filter((id) => !newExampleIds.includes(id));
      const toDelete: string[] = [];
      for (const exId of droppedIds) {
        const referenced = await isExampleReferencedByAny(language, exId, {
          exceptGrammarId: grammarId,
        });
        if (!referenced) toDelete.push(exId);
      }
      // Delete BEFORE updateGrammar so deleteExampleSentences can atomically
      // strip back-references while this grammar's exampleIds still includes
      // them (mirrors the vocab PUT delete-then-update ordering).
      if (toDelete.length > 0) {
        await deleteExampleSentences(toDelete);
      }

      const { examples: _legacy, ...rest } = body;
      const patch: Partial<Grammar> = {
        ...rest,
        id: existing.id,
        language: existing.language,
        // undefined (non-Chinese, or nothing romanizable) is dropped by
        // `ignoreUndefinedProperties`, leaving whatever is stored alone.
        transliteration: await transliterationPromise,
      };
      const updated = await updateGrammar(grammarId, patch, { exampleIds: newExampleIds });
      return updated ?? existing;
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

  // ----- Grammar Drafts -----
  // Staging area for the local OCR tool: raw uploads reviewed in the grammar
  // UI, then promoted to real items via smart-add. No LLM calls here.

  fastify.get<{ Params: { language: string } }>(
    "/:language/drafts",
    async (request) => {
      return await getGrammarDrafts(request.params.language);
    }
  );

  fastify.post<{
    Params: { language: string };
    Body: { drafts: Array<Omit<GrammarDraft, "language" | "id" | "createdAt">> };
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
                required: ["statement", "descriptions"],
                properties: {
                  statement: { type: "string" },
                  transliteration: { type: "string" },
                  descriptions: { type: "array" },
                  examples: { type: "array" },
                  level: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
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
      // Flag drafts whose statement already exists as a live grammar item so the
      // review panel can surface a "duplicate" badge (statements compared trimmed).
      const existingStatements = new Set(
        (await getGrammarStatements(language)).map((s) => s.trim())
      );
      const drafts: GrammarDraft[] = request.body.drafts.map((d, i) => {
        // Drafts no longer carry a group target — the registration group is
        // picked in the UI — so a legacy `groups` field is dropped here.
        const { groups: _groups, ...rest } = d as typeof d & { groups?: string[] };
        return {
          ...rest,
          language,
          createdAt: now,
          ...(existingStatements.has(d.statement.trim()) ? { duplicate: true } : {}),
          // ts (13-digit epoch, lexically = chronologically sortable) + zero-padded
          // index preserves upload order within a batch; see getGrammarDrafts sort.
          id: `draft-${language}-${ts}-${String(i).padStart(4, "0")}-${Math.random().toString(36).slice(2, 8)}`,
        };
      });
      await addGrammarDrafts(drafts);
      return reply.status(201).send({ created: drafts.length, drafts });
    }
  );

  fastify.get<{ Params: { language: string; draftId: string } }>(
    "/:language/drafts/:draftId",
    async (request, reply) => {
      const draft = await getGrammarDraft(request.params.draftId);
      if (!draft) return reply.notFound("Grammar draft not found");
      return draft;
    }
  );

  // Save review edits back to the draft without promoting it. Arrays/strings
  // replace wholesale (send `examples: []` to clear); identity fields
  // (language/createdAt) and omitted fields are preserved.
  fastify.put<{
    Params: { language: string; draftId: string };
    Body: Partial<Omit<GrammarDraft, "id" | "language" | "createdAt">>;
  }>(
    "/:language/drafts/:draftId",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            statement: { type: "string" },
            transliteration: { type: "string" },
            descriptions: { type: "array" },
            examples: { type: "array" },
            level: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            sourceImage: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const updated = await updateGrammarDraft(request.params.draftId, request.body);
      if (!updated) return reply.notFound("Grammar draft not found");
      return updated;
    }
  );

  fastify.delete<{ Params: { language: string; draftId: string } }>(
    "/:language/drafts/:draftId",
    async (request, reply) => {
      const deleted = await deleteGrammarDraft(request.params.draftId);
      if (!deleted) return reply.notFound("Grammar draft not found");
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
    Body: { name: string; category?: "A" | "B" };
  }>(
    "/:language/groups",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            category: { type: "string", enum: ["A", "B"] },
          },
        },
      },
    },
    async (request, reply) => {
      const group = await createGrammarGroup(
        request.params.language,
        request.body.name,
        request.body.category
      );
      return reply.status(201).send(group);
    }
  );

  /** Group B quiz "3" key: drop a grammar item from every category-B group it belongs to. */
  fastify.delete<{ Params: { language: string; grammarId: string } }>(
    "/:language/group-b/members/:grammarId",
    async (request) => {
      const removedFromGroupIds = await removeGrammarFromCategoryBGroups(
        request.params.language,
        request.params.grammarId
      );
      return { removedFromGroupIds };
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
