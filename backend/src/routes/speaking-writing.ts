import type { FastifyPluginAsync } from "fastify";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callLLMFullWithSchema, streamLLMFullWithSchema, stripMarkdownFences } from "../llm.js";
import {
  getSpeakingWritingSession,
  saveSpeakingWritingSession,
  deleteSpeakingWritingSession,
} from "../firestore.js";
import type { CorrectionResult, SpeakingWritingSession } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_SW_DIR = resolve(__dirname, "../../DB/speaking&writing");

const outputSchema = JSON.parse(readFileSync(resolve(DB_SW_DIR, "output_schema.json"), "utf-8"));

const basePrompts: Record<string, string> = {};
for (const [code, file] of [
  ["en", "english"],
  ["ja", "japanese"],
  ["ko", "korean"],
  ["zh", "chinese"],
] as const) {
  basePrompts[code] = readFileSync(resolve(DB_SW_DIR, `system_prompt_${file}.md`), "utf-8");
}

// Use case instructions keyed by mode → useCase → language
const useCasesData = JSON.parse(readFileSync(resolve(DB_SW_DIR, "use_cases.json"), "utf-8")) as Record<string, Record<string, Record<string, string>>>;

const CONTEXT_HEADERS: Record<string, string> = {
  en: "## Context",
  ja: "## コンテキスト",
  ko: "## 컨텍스트",
  zh: "## 语境",
};

function buildSystemPrompt(language: string, mode: string, useCase: string): string | null {
  const base = basePrompts[language];
  if (!base) return null;

  const useCaseInstructions = useCasesData[mode]?.[useCase]?.[language];
  if (!useCaseInstructions) return base;

  const header = CONTEXT_HEADERS[language] ?? "## Context";
  return [base, header, useCaseInstructions].join("\n\n");
}

const SPEAKING_USE_CASES = ["professional", "casual", "presentation", "interview"];
const WRITING_USE_CASES = ["academic", "social", "email", "creative"];

const speakingWritingRoutes: FastifyPluginAsync = async (fastify) => {
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
    const raw = await callLLMFullWithSchema(prompt, userPrompt, outputSchema);
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

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    function sendEvent(event: string, data: unknown) {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const userPrompt = `Mode: ${mode}\nContext: ${useCase}\n\nText to correct:\n${inputText}`;

    sendEvent("start", {});
    const raw = await streamLLMFullWithSchema(
      prompt,
      userPrompt,
      outputSchema,
      (chunk) => sendEvent("chunk", { chunk })
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
    reply.raw.end();
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
