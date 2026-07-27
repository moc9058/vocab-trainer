import type { FastifyPluginAsync } from "fastify";
import { streamLLMFullWithSchema, stripMarkdownFences } from "../llm.js";
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
  ImportAnalysisResult,
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
    statements.map((s) => `- ${s}`).join("\n")
  );
}

/**
 * Sentence indices are fully derivable from position, so the schema omits them and
 * the server assigns them — mirrors `ensureDecompositionIds` in routes/translation.ts.
 * Extracted items whose index falls outside the range are dropped rather than
 * silently pointing at the wrong sentence.
 */
function normalizeAnalysis(raw: string): ImportAnalysisResult {
  const parsed = JSON.parse(raw) as ImportAnalysisResult;
  const paragraphs = (parsed.paragraphs ?? []).map((p) => ({ sentences: p.sentences ?? [] }));
  let index = 0;
  for (const p of paragraphs) {
    for (const s of p.sentences) s.index = index++;
  }
  const total = index;
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < total;
  return {
    paragraphs,
    words: (parsed.words ?? []).filter((w) => w.term?.trim() && inRange(w.sentenceIndex)),
    grammar: (parsed.grammar ?? []).filter((g) => g.statement?.trim() && inRange(g.sentenceIndex)),
  };
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
  fastify.post<{ Params: { language: string }; Body: { text: string } }>(
    "/:language/analyze-stream",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH } },
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

      // Disable socket timeout for long-running SSE streams
      request.raw.socket.setTimeout(0);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const keepAlive = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(":keep-alive\n\n");
      }, 15_000);

      function sendEvent(event: string, data: unknown) {
        if (!reply.raw.destroyed) {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      }

      try {
        const existingGrammar = await getAllGrammarItems(language);
        const statements = existingGrammar
          .map((g) => g.statement)
          .filter(Boolean)
          .slice(0, STYLE_EXAMPLE_LIMIT);

        sendEvent("analysis-start", {});
        let accumulated = "";
        const raw = await streamLLMFullWithSchema(
          buildAnalyzeSystemPrompt(basePrompt, statements),
          text,
          analyzeSchema,
          (chunk) => {
            accumulated += chunk;
            sendEvent("analysis-delta", { text: accumulated });
          },
          "import/analyze-stream"
        );

        const analysis = normalizeAnalysis(stripMarkdownFences(raw));

        // Existence check reuses the vocab check-terms path (orphaned/mislinked
        // word_index entries are filtered out by `wordEntryIsLive`).
        const terms = [...new Set(analysis.words.map((w) => w.term.trim()).filter(Boolean))];
        const existing: Record<string, string> = {};
        if (terms.length > 0) {
          for (const m of await lookupWordsByTerms(language, terms)) existing[m.term] = m.id;
        }

        sendEvent("analysis-result", { analysis, existing });
        sendEvent("done", {});
      } catch (err) {
        request.log.error(err);
        sendEvent("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(keepAlive);
        reply.raw.end();
      }
    }
  );

  // ===== Import sessions =====
  // A review of one article, persisted so it can be paused and resumed days later.
  // Nested under :language to match the drafts convention (/api/vocab/:language/drafts)
  // and to keep these paths clear of the existing /:language/analyze-stream route.

  fastify.get<{ Params: { language: string } }>(
    "/:language/sessions",
    async (request) => {
      const sessions = await getImportSessions(request.params.language);
      // Projected summary: the resume list never needs text/paragraphs/items, and
      // shipping them would make listing cost as much as opening every session.
      return sessions.map(
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
      );
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
      if (!session) return reply.notFound("Import session not found");
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
