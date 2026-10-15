import { sourceMatchesSentences } from "../import-reading-analysis.js";
import { compactImportSchema, COMPACT_IMPORT_INSTRUCTIONS } from "../import-analysis-config.js";
import type { FastifyPluginAsync } from "fastify";
import { callLLM, stripMarkdownFences } from "../llm.js";
import { openSSE } from "../sse.js";
import {
  lowercaseGrammarAbbreviations,
  normalizeAnalysis,
  repairChangedAnything,
} from "../import-analysis.js";
import {
  languageExists,
  getImportConfig,
  getAllGrammarItems,
  lookupWordsByTerms,
  saveImportSession,
  getImportSessions,
  getImportSession,
  updateImportSession,
  deleteImportSession,
} from "../firestore.js";
import type {
  ImportQuizPool,
  ImportSession,
  ImportSessionSummary,
} from "../types.js";

/** How many existing grammar `statement`s to show the model as style examples. */
const STYLE_EXAMPLE_LIMIT = 40;
/** Guard against a runaway article: terra over a long text is the app's priciest call. */
const MAX_TEXT_LENGTH = 8000;

function buildAnalyzeSystemPrompt(basePrompt: string, statements: string[]): string {
  if (statements.length === 0) return basePrompt;
  // Appended AFTER the static prompt so the cached prefix stays byte-identical
  // across requests (same rationale as routes/translation.ts).
  return (
    `${basePrompt}\n\n## Existing grammar statements (style reference)\n\n` +
    `Write the \`statement\` field in the same notation as these entries already in the user's database:\n\n` +
    statements.map((s) => `- ${lowercaseGrammarAbbreviations(s)}`).join("\n")
  );
}

const importRoutes: FastifyPluginAsync = async (fastify) => {
  // Loaded lazily (and cached) rather than at registration: `config/import` is
  // seeded by a separate migration step, and a missing doc must not stop the
  // whole API from booting.
  let configPromise: ReturnType<typeof getImportConfig> | null = null;
  function loadConfig() {
    if (!configPromise) {
      configPromise = getImportConfig().catch((err) => {
        configPromise = null;
        throw err;
      });
    }
    return configPromise;
  }

  // SSE over POST — the article is too large for a query string, and the client
  // renders paragraphs as they stream in. Same transport shape as
  // /api/translation/translate-stream.
  fastify.post<{ Params: { language: string }; Body: { text: string; streamFormat?: "chunks" } }>(
    "/:language/analyze-stream",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH },
            streamFormat: { type: "string", enum: ["chunks"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const { text } = request.body;

      if (!(await languageExists(language))) {
        return reply.notFound(`Language '${language}' not found`);
      }
      let analyzeSchema: Record<string, unknown>;
      let basePrompt: string;
      try {
        const config = await loadConfig();
        analyzeSchema = config.analyzeSchema;
        basePrompt = config.analyzePrompts?.[language];
      } catch (err) {
        return reply.internalServerError(
          `Import config unavailable (seed it with migrate-db-config-to-firestore.ts --prompts): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      if (!basePrompt) {
        return reply.badRequest(`No import prompt configured for language '${language}'`);
      }

      const { sendEvent, close } = openSSE(request, reply);

      try {
        const grammarItems = await getAllGrammarItems(language);
        const statements = grammarItems
          .map((g) => g.statement)
          .filter(Boolean)
          .slice(0, STYLE_EXAMPLE_LIMIT);

        if (text.length > 1200) {
          analyzeSchema = compactImportSchema(analyzeSchema);
          basePrompt += COMPACT_IMPORT_INSTRUCTIONS;
        }
        sendEvent("analysis-start", {});
        let legacyText = "";
        const raw = await callLLM({
          system: buildAnalyzeSystemPrompt(basePrompt, statements),
          user: text,
          schema: analyzeSchema,
          tier: "full",
          onChunk: (chunk) => {
            if (request.body.streamFormat === "chunks") {
              sendEvent("analysis-chunk", { chunk });
            } else {
              // Cached clients keep working while the backend deploys first.
              legacyText += chunk;
              sendEvent("analysis-delta", { text: legacyText });
            }
          },
          route: "import/analyze-stream",
        });

        const { analysis, repair } = normalizeAnalysis(stripMarkdownFences(raw), language);
        if (!sourceMatchesSentences(text, analysis.paragraphs.flatMap(p => p.sentences).map(s => s.text))) {
          throw new Error("Analysis changed or omitted source text. Try importing fewer paragraphs.");
        }
        if (Buffer.byteLength(JSON.stringify(analysis), "utf8") > 850_000) {
          throw new Error("Analysis is too large to save. Import the source in smaller sections.");
        }
        if (repairChangedAnything(repair)) {
          // The model still files the odd word under a sentence it does not occur in.
          // Log what was corrected: silently reshaping the analysis would make a
          // systematic drift (a whole paragraph shifted by one) invisible.
          request.log.info({ repair }, "import: repaired word/grammar sentence attribution");
        }

        // Existence check reuses the vocab check-terms path (orphaned/mislinked
        // word_index entries are filtered out by `wordEntryIsLive`).
        const terms = [...new Set(analysis.words.map((w) => w.term.trim()).filter(Boolean))];
        const existing: Record<string, string> = {};
        if (terms.length > 0) {
          for (const m of await lookupWordsByTerms(language, terms)) existing[m.term] = m.id;
        }

        // Grammar has no `check-terms` equivalent, but the whole collection is
        // already in hand for the style examples above, so the same "already in your
        // library" answer costs nothing extra. Keyed by the normalized statement so a
        // stored 「把＋O＋V」 matches a freshly generated 「把＋o＋v」.
        const existingGrammar: Record<string, string> = {};
        for (const g of grammarItems) {
          const key = lowercaseGrammarAbbreviations(g.statement ?? "").trim();
          if (key && !existingGrammar[key]) existingGrammar[key] = g.id;
        }

        sendEvent("analysis-result", { analysis, existing, existingGrammar });
        sendEvent("done", {});
      } catch (err) {
        request.log.error(err);
        sendEvent("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        close();
      }
    }
  );

  // Return explanations only. Existing candidates, registrations and groups are never rewritten.
  fastify.post<{ Params: { language: string; sessionId: string; sentenceIndex: string } }>(
    "/:language/sessions/:sessionId/sentences/:sentenceIndex/explanation",
    async (request, reply) => {
      const { language, sessionId } = request.params;
      const session = await getImportSession(sessionId);
      if (!session || session.language !== language) return reply.notFound("Import session not found");
      const index = Number(request.params.sentenceIndex);
      if (!Number.isInteger(index) || index < 0) return reply.badRequest("Invalid sentence index");
      const sentences = session.paragraphs.flatMap(p => p.sentences);
      const at = sentences.findIndex(s => s.index === index);
      if (at < 0) return reply.notFound("Sentence not found");
      const sentence = sentences[at];
      try {
        const config = await loadConfig();
        const prompt = config.analyzePrompts?.[language];
        if (!prompt) return reply.badRequest("No import prompt configured for language");
        const raw = await callLLM({
          system: prompt + "\nAnalyze ONLY target as exactly one sentence. before/after are context, never output them. Preserve target verbatim, even if it contains sentence punctuation.",
          user: JSON.stringify({ target: sentence.text, before: sentences[at - 1]?.text ?? "", after: sentences[at + 1]?.text ?? "" }),
          schema: config.analyzeSchema, tier: "full", route: "import/sentence-explanation",
        });
        const { analysis } = normalizeAnalysis(stripMarkdownFences(raw), language);
        const result = analysis.paragraphs.flatMap(p => p.sentences);
        if (result.length !== 1 || result[0].text !== sentence.text || !result[0].readingAnalysis) {
          return reply.badGateway("The explanation did not match the source. Check the import prompt configuration and retry.");
        }
        const readingAnalysis = result[0].readingAnalysis;
        // The one-sentence model response is normalized at position 0; retain the article namespace.
        const reindex = (id: string) => id.replace(/^s0-/, `s${index}-`);
        readingAnalysis.occurrences = readingAnalysis.occurrences.map(word => ({ ...word,
          id: reindex(word.id), constructionIds: word.constructionIds.map(reindex) }));
        readingAnalysis.constructions = readingAnalysis.constructions.map(point => ({ ...point,
          id: reindex(point.id), elements: point.elements.map(element => ({ ...element, occurrenceIds: element.occurrenceIds.map(reindex) })) }));
        if (Buffer.byteLength(JSON.stringify(readingAnalysis), "utf8") > 150_000) return reply.badGateway("Explanation is too large");
        return { sentenceIndex: index, readingAnalysis };
      } catch (err) {
        request.log.error(err);
        return reply.badGateway("Failed to generate the sentence explanation. Please retry.");
      }
    },
  );

  // ===== Import sessions =====
  // A review of one article, persisted so it can be paused and resumed days later.
  // Nested under :language to match the drafts convention (/api/vocab/:language/drafts)
  // and to keep these paths clear of the existing /:language/analyze-stream route.

  fastify.get<{ Params: { language: string } }>(
    "/:language/sessions",
    async (request) => {
      const sessions = await getImportSessions(request.params.language);

      // The article quizzes drill every saved article at once, so their pool is the union
      // of the entities these sessions point at. It rides along with the list rather than
      // living on its own endpoint because this handler ALREADY reads every session
      // document in full — a sibling route would read the same heavy docs a second time on
      // one screen load. (Same call `useImportGroups` makes on the client: one read, two
      // consumers.) Which item went to Group A vs Group B is deliberately NOT decided here:
      // the session records a destination, not per-item membership, so the client
      // intersects these ids against the group documents it already holds.
      const wordIds = new Set<string>();
      const grammarIds = new Set<string>();
      for (const s of sessions) {
        for (const item of s.items ?? []) {
          // Merges and splits leave their sources behind as `skipped` tombstones so the
          // operation stays undoable; they are not live rows. Mirrors `isLive` in
          // frontend/src/utils/importSession.ts, which has no backend twin to import.
          if (item.status === "skipped") continue;
          if (item.kind === "word") {
            if (item.existingWordId) wordIds.add(item.existingWordId);
          } else if (item.existingGrammarId) {
            grammarIds.add(item.existingGrammarId);
          }
        }
      }

      // Projected summary: the resume list never needs text/paragraphs/items, and
      // shipping them would make listing cost as much as opening every session.
      return {
        sessions: sessions.map(
          (s): ImportSessionSummary => ({
            id: s.id,
            language: s.language,
            title: s.title,
            totalCount: s.items?.length ?? 0,
            registeredCount: (s.items ?? []).filter((i) => i.status === "registered").length,
            status: s.status,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          })
        ),
        pool: { wordIds: [...wordIds], grammarIds: [...grammarIds] } satisfies ImportQuizPool,
      };
    }
  );

  fastify.post<{
    Params: { language: string };
    Body: Omit<ImportSession, "id" | "language" | "createdAt" | "updatedAt">;
  }>(
    "/:language/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["text", "paragraphs", "items"],
          properties: {
            title: { type: "string" },
            text: { type: "string" },
            paragraphs: { type: "array" },
            items: { type: "array" },
            wordGroupId: { type: "string" },
            grammarGroupId: { type: "string" },
            groupBNames: { type: "array", items: { type: "string" } },
            focusedSentenceIndex: { type: "number" },
            status: { type: "string", enum: ["in-progress", "done"] },
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
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > 900_000) return reply.badRequest("Article is too large. Split it into smaller sections.");
      const now = new Date().toISOString();
      const session = await saveImportSession({
        language,
        title: body.title?.trim() || body.text.slice(0, 40),
        text: body.text,
        paragraphs: body.paragraphs ?? [],
        items: body.items ?? [],
        wordGroupId: body.wordGroupId,
        grammarGroupId: body.grammarGroupId,
        groupBNames: body.groupBNames ?? [],
        focusedSentenceIndex: body.focusedSentenceIndex ?? 0,
        status: body.status ?? "in-progress",
        createdAt: now,
        updatedAt: now,
      });
      return reply.status(201).send(session);
    }
  );

  fastify.get<{ Params: { language: string; sessionId: string } }>(
    "/:language/sessions/:sessionId",
    async (request, reply) => {
      const session = await getImportSession(request.params.sessionId);
      if (!session || session.language !== request.params.language) return reply.notFound("Import session not found");
      return session;
    }
  );

  // Autosave target. `items` replaces wholesale so deleted/merged rows disappear;
  // `updatedAt` is stamped server-side.
  fastify.put<{
    Params: { language: string; sessionId: string };
    Body: Partial<Omit<ImportSession, "id" | "language" | "createdAt" | "updatedAt">>;
  }>(
    "/:language/sessions/:sessionId",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            title: { type: "string" },
            text: { type: "string" },
            paragraphs: { type: "array" },
            items: { type: "array" },
            wordGroupId: { type: "string" },
            grammarGroupId: { type: "string" },
            groupBNames: { type: "array", items: { type: "string" } },
            focusedSentenceIndex: { type: "number" },
            status: { type: "string", enum: ["in-progress", "done"] },
          },
        },
      },
    },
    async (request, reply) => {
      const existing = await getImportSession(request.params.sessionId);
      if (!existing || existing.language !== request.params.language) return reply.notFound("Import session not found");
      if (Buffer.byteLength(JSON.stringify({ ...existing, ...request.body }), "utf8") > 900_000) return reply.badRequest("Article is too large. Split it into smaller sections.");
      const updated = await updateImportSession(request.params.sessionId, request.body);
      if (!updated) return reply.notFound("Import session not found");
      return updated;
    }
  );

  fastify.delete<{ Params: { language: string; sessionId: string } }>(
    "/:language/sessions/:sessionId",
    async (request, reply) => {
      const deleted = await deleteImportSession(request.params.sessionId);
      if (!deleted) return reply.notFound("Import session not found");
      return { deleted: true };
    }
  );
};

export default importRoutes;
