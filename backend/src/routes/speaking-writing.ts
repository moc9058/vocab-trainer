import type { FastifyPluginAsync } from "fastify";
import { callLLMFullWithSchema, streamLLMFullWithSchema, stripMarkdownFences } from "../llm.js";
import {
  getSpeakingWritingSession,
  saveSpeakingWritingSession,
  deleteSpeakingWritingSession,
  getSpeakingWritingConfig,
} from "../firestore.js";
import type { CorrectionResult, SpeakingWritingSession } from "../types.js";

const SPEAKING_USE_CASES = ["professional", "casual", "presentation", "interview"];
const WRITING_USE_CASES = ["academic", "social", "email", "creative"];

const CONTEXT_HEADERS: Record<string, string> = {
  en: "## Context",
  ja: "## コンテキスト",
  ko: "## 컨텍스트",
  zh: "## 语境",
};

const speakingWritingRoutes: FastifyPluginAsync = async (fastify) => {
  // Load config from Firestore once during plugin registration
  const { outputSchema, prompts: basePrompts, useCases: useCasesData } =
    await getSpeakingWritingConfig();

  function buildSystemPrompt(language: string, mode: string, useCase: string): string | null {
    const base = basePrompts[language];
    if (!base) return null;

    const useCaseInstructions = useCasesData[mode]?.[useCase]?.[language];
    if (!useCaseInstructions) return base;

    const header = CONTEXT_HEADERS[language] ?? "## Context";
    return [base, header, useCaseInstructions].join("\n\n");
  }

  // POST /correct — submit text for correction
  fastify.post<{
    Body: { language: string; mode: "speaking" | "writing"; useCase: string; inputText: string };
  }>("/correct", {
    schema: {
      body: {
        type: "object",
        required: ["language", "mode", "useCase", "inputText"],
        properties: {
          language: { type: "string", minLength: 1 },
          mode: { type: "string", enum: ["speaking", "writing"] },
          useCase: { type: "string", minLength: 1 },
          inputText: { type: "string", minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { language, mode, useCase, inputText } = request.body;

    const validCases = mode === "speaking" ? SPEAKING_USE_CASES : WRITING_USE_CASES;
    if (!validCases.includes(useCase)) {
      return reply.badRequest(`Invalid use case "${useCase}" for mode "${mode}"`);
    }

    const prompt = buildSystemPrompt(language, mode, useCase);
    if (!prompt) {
      return reply.badRequest(`Unsupported language: ${language}`);
    }

    const userPrompt = `Mode: ${mode}\nContext: ${useCase}\n\nText to correct:\n${inputText}`;
    const raw = await callLLMFullWithSchema(prompt, userPrompt, outputSchema, "speaking-writing/correct");
    const result = JSON.parse(stripMarkdownFences(raw)) as CorrectionResult;

    // Load existing session or create new
    let session = await getSpeakingWritingSession(language);
    if (!session) {
      session = {
        sessionId: language,
        language,
        mode,
        useCase,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        corrections: [],
        currentIndex: 0,
      };
    }

    // Update mode/useCase in case they changed
    session.mode = mode;
    session.useCase = useCase;

    // Append new correction
    session.corrections.push({
      inputText,
      result,
      createdAt: new Date().toISOString(),
    });
    session.currentIndex = session.corrections.length - 1;

    await saveSpeakingWritingSession(session);
    return session;
  });

  // POST /correct-stream — SSE streaming correction
  fastify.post<{
    Body: { language: string; mode: "speaking" | "writing"; useCase: string; inputText: string };
  }>("/correct-stream", {
    schema: {
      body: {
        type: "object",
        required: ["language", "mode", "useCase", "inputText"],
        properties: {
          language: { type: "string", minLength: 1 },
          mode: { type: "string", enum: ["speaking", "writing"] },
          useCase: { type: "string", minLength: 1 },
          inputText: { type: "string", minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { language, mode, useCase, inputText } = request.body;

    const validCases = mode === "speaking" ? SPEAKING_USE_CASES : WRITING_USE_CASES;
    if (!validCases.includes(useCase)) {
      return reply.badRequest(`Invalid use case "${useCase}" for mode "${mode}"`);
    }

    const prompt = buildSystemPrompt(language, mode, useCase);
    if (!prompt) {
      return reply.badRequest(`Unsupported language: ${language}`);
    }

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

    const userPrompt = `Mode: ${mode}\nContext: ${useCase}\n\nText to correct:\n${inputText}`;

    try {
      sendEvent("start", {});
      const raw = await streamLLMFullWithSchema(
        prompt,
        userPrompt,
        outputSchema,
        (chunk) => sendEvent("chunk", { chunk }),
        "speaking-writing/correct-stream"
      );
      const result = JSON.parse(stripMarkdownFences(raw)) as CorrectionResult;

      // Save to session
      let session = await getSpeakingWritingSession(language);
      if (!session) {
        session = {
          sessionId: language,
          language,
          mode,
          useCase,
          startedAt: new Date().toISOString(),
          status: "in-progress",
          corrections: [],
          currentIndex: 0,
        };
      }
      session.mode = mode;
      session.useCase = useCase;
      session.corrections.push({ inputText, result, createdAt: new Date().toISOString() });
      session.currentIndex = session.corrections.length - 1;
      await saveSpeakingWritingSession(session);

      sendEvent("done", session);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error processing correction";
      fastify.log.error({ err }, "Streaming correction failed");
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

  // GET /session/:language — get current session (returns null if none)
  fastify.get<{
    Params: { language: string };
  }>("/session/:language", async (request) => {
    return await getSpeakingWritingSession(request.params.language);
  });

  // DELETE /session/:language — delete session
  fastify.delete<{
    Params: { language: string };
  }>("/session/:language", async (request, reply) => {
    const deleted = await deleteSpeakingWritingSession(request.params.language);
    if (!deleted) return reply.notFound("No session found");
    return { ok: true };
  });
};

export default speakingWritingRoutes;
