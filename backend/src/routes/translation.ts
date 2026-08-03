import type { FastifyPluginAsync } from "fastify";
import { callLLM, stripMarkdownFences } from "../llm.js";
import { openSSE } from "../sse.js";
import {
  saveTranslationEntry,
  getTranslationHistory,
  deleteTranslationEntry,
  clearTranslationHistory,
  getTranslationConfig,
} from "../firestore.js";
import type { TranslationResult, TranslationPassage, SentenceAnalysisResult } from "../types.js";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
};

function langName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

function buildTranslateSystemPrompt(basePrompt: string, sourceLang: string, targetLang: string, context?: string): string {
  let prompt = `${basePrompt}\n\nSource language: ${langName(sourceLang)}\nTarget language: ${langName(targetLang)}\n\nApproach: First determine a natural, idiomatic translation for each sentence as a whole. Then, using that sentence translation as context, write explanations for each chunk and component. Component explanations are supplementary notes — they do not need to compose or sum up to the sentence translation.`;
  // Context goes LAST so the static prompt prefix stays byte-identical across
  // requests (OpenAI automatic prompt caching keys on the prefix).
  if (context && context.trim()) {
    prompt += `\n\nUser-provided context/situation (describes the circumstances of the text; it is NOT text to translate): ${context.trim()}\nReflect this context in register, politeness/honorific level, pronoun choice, tone, and word-sense disambiguation — in the passage translations, chunk meanings, and component explanations.`;
  }
  return prompt;
}

/**
 * Assign positional sentence/chunk/component IDs when missing. The slim
 * decompose schema omits IDs (they are fully derivable from position) — the
 * server owns them. Decompositions from the previous schema (or replayed by
 * the client) already carry IDs and pass through unchanged.
 */
function ensureDecompositionIds(decomposition: string): string {
  const parsed = JSON.parse(decomposition) as SentenceAnalysisResult;
  parsed.sentences.forEach((sentence, si) => {
    sentence.sentenceId ||= `s${si + 1}`;
    (sentence.chunks ?? []).forEach((chunk, ci) => {
      chunk.chunkId ||= `${sentence.sentenceId}c${ci + 1}`;
      (chunk.components ?? []).forEach((comp, pi) => {
        comp.componentId ||= `${chunk.chunkId}p${pi + 1}`;
      });
    });
  });
  return JSON.stringify(parsed);
}

/** Parse a client-replayed decomposition; returns null if unusable. */
function validateProvidedDecomposition(decomposition: string | undefined): string | null {
  if (typeof decomposition !== "string" || !decomposition.trim()) return null;
  try {
    const parsed = JSON.parse(decomposition) as SentenceAnalysisResult;
    if (!Array.isArray(parsed?.sentences) || parsed.sentences.length === 0) return null;
    if (!parsed.sentences.every((s) => typeof s?.text === "string" && s.text.length > 0)) return null;
    return ensureDecompositionIds(decomposition);
  } catch {
    return null;
  }
}

interface SlimTranslationResponse {
  passages: { sentenceIds: string[]; translation: string }[];
  chunks: { chunkId: string; meaning: string }[];
  components: { componentId: string; meaning: string; explanation: string }[];
}

function buildSlimInput(decomposition: string): string {
  const parsed = JSON.parse(decomposition) as SentenceAnalysisResult;
  const sentences = parsed.sentences.map((s) => ({ sentenceId: s.sentenceId, text: s.text }));
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
  return JSON.stringify({ sentences, chunks, components });
}

function mergeTranslation(decomposition: string, slimRaw: string, language: string): TranslationResult {
  try {
    const decomp = JSON.parse(decomposition) as SentenceAnalysisResult;
    const slim = JSON.parse(stripMarkdownFences(slimRaw)) as SlimTranslationResponse;

    const chunkMap = new Map(slim.chunks.map((c) => [c.chunkId, c.meaning]));
    const compMap = new Map(slim.components.map((c) => [c.componentId, { meaning: c.meaning, explanation: c.explanation }]));

    const passages: TranslationPassage[] = slim.passages.map((p) => ({
      sentenceIds: p.sentenceIds,
      translation: p.translation,
    }));

    const analysis: SentenceAnalysisResult = {
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

    return { language, passages, analysis };
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
    Body: { sourceLanguage: string; sourceText: string; targetLanguages: string[]; context?: string };
  }>("/translate", {
    schema: {
      body: {
        type: "object",
        required: ["sourceLanguage", "sourceText", "targetLanguages"],
        properties: {
          sourceLanguage: { type: "string", minLength: 1 },
          sourceText: { type: "string", minLength: 1 },
          targetLanguages: { type: "array", items: { type: "string" }, minItems: 1 },
          context: { type: "string", maxLength: 2000 },
        },
      },
    },
  }, async (request) => {
    const { sourceLanguage, sourceText, targetLanguages, context } = request.body;

    // Step 1: decompose using source-language-specific prompt (MINI model — structural only)
    const decomposePrompt = decomposePrompts[sourceLanguage];
    if (!decomposePrompt) throw new Error(`Unsupported source language: ${sourceLanguage}`);
    const decomposeRaw = await callLLM({ system: decomposePrompt, user: sourceText, schema: decomposeSchema, route: "translation/decompose" });
    const decomposition = ensureDecompositionIds(stripMarkdownFences(decomposeRaw));

    // Step 2: translate in parallel
    const slimInput = buildSlimInput(decomposition);
    const results = await Promise.allSettled(
      targetLanguages.map(async (lang) => {
        const prompt = translatePrompts[lang];
        if (!prompt) throw new Error(`Unsupported language: ${lang}`);
        const slimRaw = await callLLM({
          system: buildTranslateSystemPrompt(prompt, sourceLanguage, lang, context),
          user: slimInput,
          schema: translateSchema,
          tier: "full",
          route: "translation/translate",
        });
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
      ...(context?.trim() ? { context: context.trim() } : {}),
      targetLanguages,
      results: translationResults,
      createdAt: new Date().toISOString(),
    });

    return entry;
  });

  // POST /translate-stream — SSE streaming two-step translation.
  // `context` biases register/tone; `decomposition` replays a decomposition the
  // client already received (regenerate) so step 1 is skipped entirely.
  fastify.post<{
    Body: { sourceLanguage: string; sourceText: string; targetLanguages: string[]; context?: string; decomposition?: string };
  }>("/translate-stream", {
    schema: {
      body: {
        type: "object",
        required: ["sourceLanguage", "sourceText", "targetLanguages"],
        properties: {
          sourceLanguage: { type: "string", minLength: 1 },
          sourceText: { type: "string", minLength: 1 },
          targetLanguages: { type: "array", items: { type: "string" }, minItems: 1 },
          context: { type: "string", maxLength: 2000 },
          decomposition: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    const { sourceLanguage, sourceText, targetLanguages, context } = request.body;

    const { sendEvent, close } = openSSE(request, reply);

    try {
      // Step 1: decompose — or reuse the client-replayed decomposition
      // (regenerate on unchanged text) and skip the LLM call entirely.
      let decomposition = validateProvidedDecomposition(request.body.decomposition);
      if (!decomposition) {
        const decomposePrompt = decomposePrompts[sourceLanguage];
        if (!decomposePrompt) {
          sendEvent("error", { message: `Unsupported source language: ${sourceLanguage}` });
          return;
        }
        sendEvent("decompose-start", {});
        const decomposeRaw = await callLLM({
          system: decomposePrompt,
          user: sourceText,
          schema: decomposeSchema,
          onChunk: (chunk) => sendEvent("decompose-chunk", { chunk }),
          route: "translation/decompose-stream",
        });
        decomposition = ensureDecompositionIds(stripMarkdownFences(decomposeRaw));
      }
      sendEvent("decompose-result", { decomposition });

      // Step 2: translate each language in parallel
      const slimInput = buildSlimInput(decomposition);
      for (const lang of targetLanguages) {
        sendEvent("start", { language: lang });
      }

      const settled = await Promise.allSettled(
        targetLanguages.map(async (lang): Promise<TranslationResult> => {
          const prompt = translatePrompts[lang];
          if (!prompt) throw new Error(`Unsupported language: ${lang}`);
          const raw = await callLLM({
            system: buildTranslateSystemPrompt(prompt, sourceLanguage, lang, context),
            user: slimInput,
            schema: translateSchema,
            tier: "full",
            onChunk: (chunk) => sendEvent("chunk", { language: lang, chunk }),
            route: "translation/translate-stream",
          });
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
        ...(context?.trim() ? { context: context.trim() } : {}),
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
      sendEvent("error", { message });
    } finally {
      close();
    }
  });

  // GET /history — paginated translation history (optional ?language= filter)
  fastify.get<{
    Querystring: { page?: string; limit?: string; language?: string };
  }>("/history", async (request) => {
    const page = parseInt(request.query.page ?? "1", 10);
    const limit = parseInt(request.query.limit ?? "20", 10);
    const { language } = request.query;
    return getTranslationHistory(page, limit, language);
  });

  // DELETE /history — clear translation history (optional ?language= filter)
  fastify.delete<{
    Querystring: { language?: string };
  }>("/history", async (request) => {
    await clearTranslationHistory(request.query.language);
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
