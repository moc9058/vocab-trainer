import { AzureOpenAI } from "openai";
import type { CompletionUsage } from "openai/resources/completions";
import { Firestore } from "@google-cloud/firestore";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { TOPICS, type Word, type Topic } from "./types.js";
import { logTokenUsage, ensureModelInCostConfig } from "./firestore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (takes priority over Firestore)
config({ path: resolve(__dirname, "../../.env") });

// Abort a streaming LLM call if no chunks arrive within this window
const STREAM_IDLE_MS = 30_000;

let client: AzureOpenAI | null = null;
let deploymentMini = "";
let deploymentFull = "";
let initPromise: Promise<void> | null = null;

async function loadLLMConfig(): Promise<void> {
  // If all env vars are already set (from .env), skip Firestore
  if (
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_API_VERSION &&
    process.env.AZURE_OPENAI_DEPLOYMENT_MINI
  ) {
    return;
  }

  // Fetch from Firestore config/llm
  try {
    const db = new Firestore({
      databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
      ignoreUndefinedProperties: true,
    });
    const doc = await db.collection("config").doc("llm").get();
    if (doc.exists) {
      const data = doc.data()!;
      for (const key of [
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_DEPLOYMENT_MINI",
        "AZURE_OPENAI_DEPLOYMENT_FULL",
      ]) {
        if (!process.env[key] && data[key]) {
          process.env[key] = data[key] as string;
        }
      }
      console.log("LLM config loaded from Firestore");
    } else {
      console.warn("No LLM config found in Firestore (config/llm)");
    }
  } catch (err) {
    console.error("Failed to load LLM config from Firestore:", err);
  }
}

// Single shared promise — all concurrent callers await the same initialization
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await loadLLMConfig();
      client = new AzureOpenAI({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION,
        maxRetries: 5,
      });
      deploymentMini = process.env.AZURE_OPENAI_DEPLOYMENT_MINI!;
      deploymentFull = process.env.AZURE_OPENAI_DEPLOYMENT_FULL ?? "";
    })();
  }
  return initPromise;
}

export async function createAzureClient(): Promise<AzureOpenAI> {
  await ensureInit();
  return client!;
}

export async function getDeploymentMini(): Promise<string> {
  await ensureInit();
  return deploymentMini;
}

export async function getDeploymentFull(): Promise<string> {
  await ensureInit();
  if (!deploymentFull) {
    throw new Error("AZURE_OPENAI_DEPLOYMENT_FULL is not configured");
  }
  return deploymentFull;
}

async function recordUsage(
  usage: CompletionUsage | undefined,
  model: string,
  caller: string,
  route: string
): Promise<void> {
  if (!usage) return;
  try {
    ensureModelInCostConfig(model).catch(() => {});
    await logTokenUsage({
      timestamp: new Date().toISOString(),
      model,
      caller,
      route,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? undefined,
    });
  } catch (err) {
    console.error("Failed to record token usage:", err);
  }
}

export async function callLLM(systemPrompt: string, userPrompt: string, route = "unknown"): Promise<string> {
  const cl = await createAzureClient();
  const model = await getDeploymentMini();
  const response = await cl.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });
  recordUsage(response.usage, model, "callLLM", route);
  return response.choices[0]?.message?.content ?? "";
}

export async function callLLMFull(systemPrompt: string, userPrompt: string, route = "unknown"): Promise<string> {
  const cl = await createAzureClient();
  const model = await getDeploymentFull();
  const response = await cl.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });
  recordUsage(response.usage, model, "callLLMFull", route);
  return response.choices[0]?.message?.content ?? "";
}

export async function callLLMWithSchema(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: Record<string, unknown>,
  route = "unknown"
): Promise<string> {
  const cl = await createAzureClient();
  const model = await getDeploymentMini();
  const response = await cl.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    } as unknown as { type: "json_object" },
  });
  recordUsage(response.usage, model, "callLLMWithSchema", route);
  return response.choices[0]?.message?.content ?? "";
}

export async function callLLMFullWithSchema(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: Record<string, unknown>,
  route = "unknown"
): Promise<string> {
  const cl = await createAzureClient();
  const model = await getDeploymentFull();
  const response = await cl.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    } as unknown as { type: "json_object" },
  });
  recordUsage(response.usage, model, "callLLMFullWithSchema", route);
  return response.choices[0]?.message?.content ?? "";
}

export async function streamLLMFull(
  systemPrompt: string,
  userPrompt: string,
  onChunk: (chunk: string) => void,
  route = "unknown"
): Promise<string> {
  const cl = await createAzureClient();
  const model = await getDeploymentFull();
  const abortController = new AbortController();
  const stream = await cl.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    stream: true,
    stream_options: { include_usage: true },
  }, { signal: abortController.signal });
  let full = "";
  let usage: CompletionUsage | undefined;
  let idledOut = false;
  let idleTimer = setTimeout(() => { idledOut = true; abortController.abort(); }, STREAM_IDLE_MS);
  try {
    for await (const chunk of stream) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idledOut = true; abortController.abort(); }, STREAM_IDLE_MS);
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        onChunk(delta);
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
  } catch (err) {
    if (!idledOut) throw err;
  } finally {
    clearTimeout(idleTimer);
  }
  recordUsage(usage, model, "streamLLMFull", route);
  return full;
}

export async function streamLLMFullWithSchema(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: Record<string, unknown>,
  onChunk: (chunk: string) => void,
  route = "unknown"
): Promise<string> {
  const cl = await createAzureClient();
  const model = await getDeploymentFull();
  const abortController = new AbortController();
  const stream = await cl.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    } as unknown as { type: "json_object" },
    stream: true,
    stream_options: { include_usage: true },
  }, { signal: abortController.signal });
  let full = "";
  let usage: CompletionUsage | undefined;
  let idledOut = false;
  let idleTimer = setTimeout(() => { idledOut = true; abortController.abort(); }, STREAM_IDLE_MS);
  try {
    for await (const chunk of stream) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idledOut = true; abortController.abort(); }, STREAM_IDLE_MS);
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        onChunk(delta);
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
  } catch (err) {
    if (!idledOut) throw err;
  } finally {
    clearTimeout(idleTimer);
  }
  recordUsage(usage, model, "streamLLMFullWithSchema", route);
  return full;
}

export async function streamLLMWithSchema(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: Record<string, unknown>,
  onChunk: (chunk: string) => void,
  route = "unknown"
): Promise<string> {
  const cl = await createAzureClient();
  const model = await getDeploymentMini();
  const abortController = new AbortController();
  const stream = await cl.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    } as unknown as { type: "json_object" },
    stream: true,
    stream_options: { include_usage: true },
  }, { signal: abortController.signal });
  let full = "";
  let usage: CompletionUsage | undefined;
  let idledOut = false;
  let idleTimer = setTimeout(() => { idledOut = true; abortController.abort(); }, STREAM_IDLE_MS);
  try {
    for await (const chunk of stream) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idledOut = true; abortController.abort(); }, STREAM_IDLE_MS);
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        onChunk(delta);
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
  } catch (err) {
    if (!idledOut) throw err;
  } finally {
    clearTimeout(idleTimer);
  }
  recordUsage(usage, model, "streamLLMWithSchema", route);
  return full;
}

export function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();
}

const topicsSet = new Set<string>(TOPICS);

export function validateWord(w: unknown): w is Omit<Word, "id" | "level"> {
  if (!w || typeof w !== "object") return false;
  const obj = w as Record<string, unknown>;
  if (typeof obj.term !== "string" || !obj.term) return false;
  if (typeof obj.transliteration !== "string") return false;
  if (!Array.isArray(obj.definitions) || obj.definitions.length === 0) return false;
  for (const m of obj.definitions as Record<string, unknown>[]) {
    if (typeof m.partOfSpeech !== "string") return false;
    if (!m.text || typeof m.text !== "object") return false;
    const txt = m.text as Record<string, string>;
    if (Object.keys(txt).length === 0) return false;
  }
  if (!Array.isArray(obj.examples) || obj.examples.length === 0) return false;
  // Pass through segments on examples if present (generated by LLM)
  for (const ex of obj.examples as Record<string, unknown>[]) {
    if (Array.isArray(ex.segments)) {
      // Keep segments as-is — validated downstream or by add-pinyin-segments script
    }
  }
  if (!Array.isArray(obj.topics)) return false;
  // Filter topics to valid ones
  obj.topics = (obj.topics as string[]).filter((t) => topicsSet.has(t));
  if ((obj.topics as string[]).length === 0) return false;
  return true;
}

export interface Segment {
  text: string;
  transliteration?: string;
}

/** Call LLM to segment a batch of sentences into words with pinyin */
export async function segmentBatch(
  sentences: string[],
  config?: { prompt: string; schema: Record<string, unknown> }
): Promise<Map<number, Segment[]>> {
  const systemPrompt = config?.prompt
    ?? `You are a Chinese language expert. Segment Chinese sentences into individual words, providing pinyin with tone marks for each Chinese word. Non-Chinese tokens (punctuation, numbers, English text) should have no pinyin.

Return a JSON object with a "results" key containing an array. Each entry has:
- "index": the sentence number (0-based)
- "segments": array of {"text": "...", "pinyin": "..."} objects. Omit "pinyin" for non-Chinese tokens.

Rules:
- Segment into natural Chinese words (not individual characters unless they are standalone words)
- Use tone marks on pinyin (e.g. "nǐ hǎo" not "ni3 hao3")
- Multi-syllable words get space-separated pinyin (e.g. "xuéshēng" for 学生)
- Keep punctuation as separate segments with no pinyin`;

  const numbered = sentences
    .map((s, i) => `${i}. ${s}`)
    .join("\n");
  const userPrompt = `Segment these Chinese sentences:\n\n${numbered}`;

  const raw = config?.schema
    ? await callLLMWithSchema(systemPrompt, userPrompt, config.schema, "llm/segment-batch")
    : await callLLM(systemPrompt, userPrompt, "llm/segment-batch");
  const parsed = JSON.parse(stripMarkdownFences(raw));
  const results = new Map<number, Segment[]>();

  for (const entry of parsed.results ?? []) {
    if (typeof entry?.index !== "number" || !Array.isArray(entry?.segments)) continue;
    const segs: Segment[] = [];
    for (const seg of entry.segments) {
      if (typeof seg?.text !== "string" || seg.text.length === 0) continue;
      if (typeof seg.pinyin === "string" && seg.pinyin.length > 0) {
        segs.push({ text: seg.text, transliteration: seg.pinyin });
      } else {
        segs.push({ text: seg.text });
      }
    }
    if (segs.length > 0) {
      results.set(entry.index, segs);
    }
  }

  return results;
}

