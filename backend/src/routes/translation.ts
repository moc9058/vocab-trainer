import type { FastifyPluginAsync } from "fastify";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callLLMFullWithSchema, streamLLMFullWithSchema, stripMarkdownFences } from "../llm.js";
import {
  saveTranslationEntry,
  getTranslationHistory,
  deleteTranslationEntry,
  clearTranslationHistory,
} from "../firestore.js";
import type { TranslationResult, SentenceAnalysisResult } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_TRANSLATION_DIR = resolve(__dirname, "../../DB/translation");

// Step 1: decomposition (language-agnostic)
const decomposeSchema = JSON.parse(readFileSync(resolve(DB_TRANSLATION_DIR, "decompose_scheme.json"), "utf-8"));
const decomposePrompt = readFileSync(resolve(DB_TRANSLATION_DIR, "system_prompt_decompose.md"), "utf-8");

// Step 2: translation (per-language) — uses the full output schema
const translateSchema = JSON.parse(readFileSync(resolve(DB_TRANSLATION_DIR, "output_scheme.json"), "utf-8"));
const translatePrompts: Record<string, string> = {};
for (const [code, file] of [["en", "english"], ["ja", "japanese"], ["ko", "korean"], ["zh", "chinese"]] as const) {
  translatePrompts[code] = readFileSync(resolve(DB_TRANSLATION_DIR, `system_prompt_${file}.md`), "utf-8");
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
  // POST /translate — run two-step translation (non-streaming)
  fastify.post<{
    Body: { sourceText: string; targetLanguages: string[] };
  }>("/translate", {
    schema: {
      body: {
        type: "object",
        required: ["sourceText", "targetLanguages"],
        properties: {
          sourceText: { type: "string", minLength: 1 },
          targetLanguages: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  }, async (request) => {
    const { sourceText, targetLanguages } = request.body;

    // Step 1: decompose
    const decomposeRaw = await callLLMFullWithSchema(decomposePrompt, sourceText, decomposeSchema);
    const decomposition = stripMarkdownFences(decomposeRaw);

    // Step 2: translate in parallel
    const results = await Promise.allSettled(
      targetLanguages.map(async (lang) => {
        const prompt = translatePrompts[lang];
        if (!prompt) throw new Error(`Unsupported language: ${lang}`);
        return parseSchemaResult(
          await callLLMFullWithSchema(prompt, decomposition, translateSchema),
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
      sourceText,
      targetLanguages,
      results: translationResults,
      createdAt: new Date().toISOString(),
    });

    return entry;
  });

  // POST /translate-stream — SSE streaming two-step translation
  fastify.post<{
    Body: { sourceText: string; targetLanguages: string[] };
  }>("/translate-stream", {
    schema: {
      body: {
        type: "object",
        required: ["sourceText", "targetLanguages"],
        properties: {
          sourceText: { type: "string", minLength: 1 },
          targetLanguages: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { sourceText, targetLanguages } = request.body;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    function sendEvent(event: string, data: unknown) {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    // Step 1: decompose with streaming
    sendEvent("decompose-start", {});
    const decomposeRaw = await streamLLMFullWithSchema(
      decomposePrompt,
      sourceText,
      decomposeSchema,
      (chunk) => sendEvent("decompose-chunk", { chunk })
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
          decomposition,
          translateSchema,
          (chunk) => sendEvent("chunk", { language: lang, chunk })
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
      sourceText,
      targetLanguages,
      results: translationResults,
      createdAt: new Date().toISOString(),
    });

    sendEvent("done", entry);
    reply.raw.end();
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
