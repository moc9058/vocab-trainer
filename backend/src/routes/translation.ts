import type { FastifyPluginAsync } from "fastify";
import { callLLMFullWithSchema, streamLLMFullWithSchema, stripMarkdownFences } from "../llm.js";
import {
  saveTranslationEntry,
  getTranslationHistory,
  deleteTranslationEntry,
  clearTranslationHistory,
  getTranslationConfig,
} from "../firestore.js";
import type { TranslationResult, SentenceAnalysisResult } from "../types.js";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
};

function langName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

function buildTranslateUserMessage(sourceLang: string, targetLang: string, decomposition: string): string {
  return `Source language: ${langName(sourceLang)}\nTarget language: ${langName(targetLang)}\n\n${decomposition}`;
}

function parseSchemaResult(raw: string, language: string): TranslationResult {
  try {
    const parsed = JSON.parse(stripMarkdownFences(raw)) as SentenceAnalysisResult;
    return {
      language,
      translation: "",
      grammarBreakdown: "",
      keyVocabulary: [],
      alternativeExpressions: [],
      culturalNotes: "",
      analysis: parsed,
    };
  } catch {
    return {
      language,
      translation: "",
      grammarBreakdown: "",
      keyVocabulary: [],
      alternativeExpressions: [],
      culturalNotes: "",
      error: "Failed to parse schema-based LLM response",
    };
  }
}

const translationRoutes: FastifyPluginAsync = async (fastify) => {
  // Load config from Firestore once during plugin registration
  const { decomposeSchema, decomposePrompts, translateSchema, translatePrompts } =
    await getTranslationConfig();

  // POST /translate — run two-step translation (non-streaming)
  fastify.post<{
    Body: { sourceLanguage: string; sourceText: string; targetLanguages: string[] };
  }>("/translate", {
    schema: {
      body: {
        type: "object",
        required: ["sourceLanguage", "sourceText", "targetLanguages"],
        properties: {
          sourceLanguage: { type: "string", minLength: 1 },
          sourceText: { type: "string", minLength: 1 },
          targetLanguages: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  }, async (request) => {
    const { sourceLanguage, sourceText, targetLanguages } = request.body;

    // Step 1: decompose using source-language-specific prompt
    const decomposePrompt = decomposePrompts[sourceLanguage];
    if (!decomposePrompt) throw new Error(`Unsupported source language: ${sourceLanguage}`);
    const decomposeRaw = await callLLMFullWithSchema(decomposePrompt, sourceText, decomposeSchema, "translation/decompose");
    const decomposition = stripMarkdownFences(decomposeRaw);

    // Step 2: translate in parallel
    const results = await Promise.allSettled(
      targetLanguages.map(async (lang) => {
        const prompt = translatePrompts[lang];
        if (!prompt) throw new Error(`Unsupported language: ${lang}`);
        return parseSchemaResult(
          await callLLMFullWithSchema(prompt, buildTranslateUserMessage(lang, decomposition), translateSchema, "translation/translate"),
          lang
        );
      })
    );

    const translationResults: TranslationResult[] = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        language: targetLanguages[i],
        translation: "",
        grammarBreakdown: "",
        keyVocabulary: [],
        alternativeExpressions: [],
        culturalNotes: "",
        error: r.reason?.message ?? "Translation failed",
      };
    });

    const entry = await saveTranslationEntry({
      sourceLanguage,
      sourceText,
      targetLanguages,
      results: translationResults,
      createdAt: new Date().toISOString(),
    });

    return entry;
  });

  // POST /translate-stream — SSE streaming two-step translation
  fastify.post<{
    Body: { sourceLanguage: string; sourceText: string; targetLanguages: string[] };
  }>("/translate-stream", {
    schema: {
      body: {
        type: "object",
        required: ["sourceLanguage", "sourceText", "targetLanguages"],
        properties: {
          sourceLanguage: { type: "string", minLength: 1 },
          sourceText: { type: "string", minLength: 1 },
          targetLanguages: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { sourceLanguage, sourceText, targetLanguages } = request.body;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    function sendEvent(event: string, data: unknown) {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    try {
      // Step 1: decompose with streaming using source-language-specific prompt
      const decomposePrompt = decomposePrompts[sourceLanguage];
      if (!decomposePrompt) {
        sendEvent("error", { message: `Unsupported source language: ${sourceLanguage}` });
        reply.raw.end();
        return;
      }
      sendEvent("decompose-start", {});
      const decomposeRaw = await streamLLMFullWithSchema(
        decomposePrompt,
        sourceText,
        decomposeSchema,
        (chunk) => sendEvent("decompose-chunk", { chunk }),
        "translation/decompose-stream"
      );
      const decomposition = stripMarkdownFences(decomposeRaw);
      sendEvent("decompose-result", { decomposition });

      // Step 2: translate each language in parallel with streaming
      for (const lang of targetLanguages) {
        sendEvent("start", { language: lang });
      }

      const settled = await Promise.allSettled(
        targetLanguages.map(async (lang): Promise<TranslationResult> => {
          const prompt = translatePrompts[lang];
          if (!prompt) throw new Error(`Unsupported language: ${lang}`);
          const raw = await streamLLMFullWithSchema(
            prompt,
            buildTranslateUserMessage(lang, decomposition),
            translateSchema,
            (chunk) => sendEvent("chunk", { language: lang, chunk }),
            "translation/translate-stream"
          );
          const result = parseSchemaResult(raw, lang);
          sendEvent("result", { language: lang, result });
          return result;
        })
      );

      const translationResults: TranslationResult[] = settled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        const errorResult: TranslationResult = {
          language: targetLanguages[i],
          translation: "",
          grammarBreakdown: "",
          keyVocabulary: [],
          alternativeExpressions: [],
          culturalNotes: "",
          error: r.reason?.message ?? "Translation failed",
        };
        sendEvent("result", { language: targetLanguages[i], result: errorResult });
        return errorResult;
      });

      // Save to Firestore and send final entry
      const entry = await saveTranslationEntry({
        sourceLanguage,
        sourceText,
        targetLanguages,
        results: translationResults,
        createdAt: new Date().toISOString(),
      });

      sendEvent("done", entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error processing translation";
      fastify.log.error({ err }, "Streaming translation failed");
      if (!reply.raw.destroyed) {
        sendEvent("error", { message });
      }
    } finally {
      if (!reply.raw.destroyed) {
        reply.raw.end();
      }
    }
  });

  // GET /history — paginated translation history
  fastify.get<{
    Querystring: { page?: string; limit?: string };
  }>("/history", async (request) => {
    const page = parseInt(request.query.page ?? "1", 10);
    const limit = parseInt(request.query.limit ?? "20", 10);
    return getTranslationHistory(page, limit);
  });

  // DELETE /history — clear all translation history
  fastify.delete("/history", async () => {
    await clearTranslationHistory();
    return { ok: true };
  });

  // DELETE /history/:id — delete single entry
  fastify.delete<{
    Params: { id: string };
  }>("/history/:id", async (request, reply) => {
    const deleted = await deleteTranslationEntry(request.params.id);
    if (!deleted) return reply.notFound("Translation entry not found");
    return { ok: true };
  });
};

export default translationRoutes;
