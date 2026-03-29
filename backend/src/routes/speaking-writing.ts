import type { FastifyPluginAsync } from "fastify";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callLLMFullWithSchema, stripMarkdownFences } from "../llm.js";
import {
  getSpeakingWritingSession,
  saveSpeakingWritingSession,
  deleteSpeakingWritingSession,
} from "../firestore.js";
import type { CorrectionResult, SpeakingWritingSession } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_SW_DIR = resolve(__dirname, "../../DB/speaking&writing");

const outputSchema = JSON.parse(readFileSync(resolve(DB_SW_DIR, "output_schema.json"), "utf-8"));

const systemPrompts: Record<string, string> = {};
for (const [code, file] of [
  ["en", "english"],
  ["ja", "japanese"],
  ["ko", "korean"],
  ["zh", "chinese"],
] as const) {
  systemPrompts[code] = readFileSync(resolve(DB_SW_DIR, `system_prompt_${file}.md`), "utf-8");
}

const speakingWritingRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /correct — submit text for correction
  fastify.post<{
    Body: { language: string; mode: "speaking" | "writing"; inputText: string };
  }>("/correct", {
    schema: {
      body: {
        type: "object",
        required: ["language", "mode", "inputText"],
        properties: {
          language: { type: "string", minLength: 1 },
          mode: { type: "string", enum: ["speaking", "writing"] },
          inputText: { type: "string", minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { language, mode, inputText } = request.body;

    const prompt = systemPrompts[language];
    if (!prompt) {
      return reply.badRequest(`Unsupported language: ${language}`);
    }

    const userPrompt = `Mode: ${mode}\n\nText to correct:\n${inputText}`;
    const raw = await callLLMFullWithSchema(prompt, userPrompt, outputSchema);
    const result = JSON.parse(stripMarkdownFences(raw)) as CorrectionResult;

    // Load existing session or create new
    let session = await getSpeakingWritingSession(language);
    if (!session) {
      session = {
        sessionId: language,
        language,
        mode,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        corrections: [],
        currentIndex: 0,
      };
    }

    // Update mode in case it changed
    session.mode = mode;

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

  // GET /session/:language — get current session
  fastify.get<{
    Params: { language: string };
  }>("/session/:language", async (request, reply) => {
    const session = await getSpeakingWritingSession(request.params.language);
    if (!session) return reply.notFound("No session found");
    return session;
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
