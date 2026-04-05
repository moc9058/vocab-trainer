import type { FastifyPluginAsync } from "fastify";
import { callLLMWithSchema, callLLMFullWithSchema, streamLLMWithSchema, streamLLMFullWithSchema, stripMarkdownFences } from "../llm.js";
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

function buildTranslateSystemPrompt(basePrompt: string, sourceLang: string, targetLang: string): string {
  return `${basePrompt}\n\nSource language: ${langName(sourceLang)}\nTarget language: ${langName(targetLang)}`;
}

interface SlimTranslationResponse {
  chunks: { chunkId: string; meaning: string }[];
  components: { componentId: string; meaning: string; explanation: string }[];
}

function buildSlimInput(decomposition: string): string {
  const parsed = JSON.parse(decomposition) as SentenceAnalysisResult;
  const sourceText = parsed.sentences.map((s) => s.text).join(" ");
  const chunks: { chunkId: string; surface: string }[] = [];
  const components: { componentId: string; chunkId: string; surface: string; baseForm: string | null; partOfSpeech: string }[] = [];
  for (const sentence of parsed.sentences) {
    for (const chunk of sentence.chunks) {
      chunks.push({ chunkId: chunk.chunkId, surface: chunk.surface });
      for (const comp of chunk.components) {
        components.push({
          componentId: comp.componentId,
          chunkId: chunk.chunkId,
          surface: comp.surface,
          baseForm: comp.baseForm,
          partOfSpeech: comp.partOfSpeech,
        });
      }
    }
  }
  return JSON.stringify({ sourceText, chunks, components });
}

function mergeTranslation(decomposition: string, slimRaw: string, language: string): TranslationResult {
  try {
    const decomp = JSON.parse(decomposition) as SentenceAnalysisResult;
    const slim = JSON.parse(stripMarkdownFences(slimRaw)) as SlimTranslationResponse;

    const chunkMap = new Map(slim.chunks.map((c) => [c.chunkId, c.meaning]));
    const compMap = new Map(slim.components.map((c) => [c.componentId, { meaning: c.meaning, explanation: c.explanation }]));

    const merged: SentenceAnalysisResult = {
      sentences: decomp.sentences.map((sentence) => ({
        sentenceId: sentence.sentenceId,
        text: sentence.text,
        chunks: sentence.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          surface: chunk.surface,
          meaning: chunkMap.get(chunk.chunkId) ?? "",
          components: chunk.components.map((comp) => ({
            componentId: comp.componentId,
            surface: comp.surface,
            baseForm: comp.baseForm,
            reading: comp.reading,
            partOfSpeech: comp.partOfSpeech,
            meaning: compMap.get(comp.componentId)?.meaning ?? "",
            explanation: compMap.get(comp.componentId)?.explanation ?? "",
          })),
        })),
      })),
    };

    return { language, analysis: merged };
  } catch {
    return { language, error: "Failed to parse or merge translation response" };
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

    // Step 1: decompose using source-language-specific prompt (MINI model — structural only)
    const decomposePrompt = decomposePrompts[sourceLanguage];
    if (!decomposePrompt) throw new Error(`Unsupported source language: ${sourceLanguage}`);
    const decomposeRaw = await callLLMWithSchema(decomposePrompt, sourceText, decomposeSchema, "translation/decompose");
    const decomposition = stripMarkdownFences(decomposeRaw);

    // Step 2: translate in parallel
    const slimInput = buildSlimInput(decomposition);
    const results = await Promise.allSettled(
      targetLanguages.map(async (lang) => {
        const prompt = translatePrompts[lang];
        if (!prompt) throw new Error(`Unsupported language: ${lang}`);
        const slimRaw = await callLLMFullWithSchema(
          buildTranslateSystemPrompt(prompt, sourceLanguage, lang),
          slimInput,
          translateSchema,
          "translation/translate"
        );
        return mergeTranslation(decomposition, slimRaw, lang);
      })
    );

    const translationResults: TranslationResult[] = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        language: targetLanguages[i],
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

    // Disable socket timeout for long-running SSE streams
    request.raw.socket.setTimeout(0);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send periodic keep-alive comments to prevent proxy/infrastructure idle timeouts
    const keepAlive = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(":keep-alive\n\n");
    }, 15_000);

    function sendEvent(event: string, data: unknown) {
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
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
      const decomposeRaw = await streamLLMWithSchema(
        decomposePrompt,
        sourceText,
        decomposeSchema,
        (chunk) => sendEvent("decompose-chunk", { chunk }),
        "translation/decompose-stream"
      );
      const decomposition = stripMarkdownFences(decomposeRaw);
      sendEvent("decompose-result", { decomposition });

      // Step 2: translate each language in parallel with streaming
      const slimInput = buildSlimInput(decomposition);
      for (const lang of targetLanguages) {
        sendEvent("start", { language: lang });
      }

      const settled = await Promise.allSettled(
        targetLanguages.map(async (lang): Promise<TranslationResult> => {
          const prompt = translatePrompts[lang];
          if (!prompt) throw new Error(`Unsupported language: ${lang}`);
          const raw = await streamLLMFullWithSchema(
            buildTranslateSystemPrompt(prompt, sourceLanguage, lang),
            slimInput,
            translateSchema,
            (chunk) => sendEvent("chunk", { language: lang, chunk }),
            "translation/translate-stream"
          );
          const result = mergeTranslation(decomposition, raw, lang);
          sendEvent("result", { language: lang, result });
          return result;
        })
      );

      const translationResults: TranslationResult[] = settled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        const errorResult: TranslationResult = {
          language: targetLanguages[i],
          error: r.reason?.message ?? "Translation failed",
        };
        sendEvent("result", { language: targetLanguages[i], result: errorResult });
        return errorResult;
      });

      // Send done immediately, save to Firestore in background
      const entryData = {
        sourceLanguage,
        sourceText,
        targetLanguages,
        results: translationResults,
        createdAt: new Date().toISOString(),
      };
      sendEvent("done", { id: `pending-${Date.now()}`, ...entryData });
      saveTranslationEntry(entryData).catch((err) =>
        fastify.log.error({ err }, "Failed to save translation entry")
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error processing translation";
      fastify.log.error({ err }, "Streaming translation failed");
      if (!reply.raw.destroyed) {
        sendEvent("error", { message });
      }
    } finally {
      clearInterval(keepAlive);
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
