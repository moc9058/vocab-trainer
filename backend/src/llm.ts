import { AzureOpenAI } from "openai";
import { Firestore } from "@google-cloud/firestore";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { TOPICS, type Word, type Topic } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (takes priority over Firestore)
config({ path: resolve(__dirname, "../../.env") });

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

export async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const cl = await createAzureClient();
  const response = await cl.chat.completions.create({
    model: await getDeploymentMini(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });
  return response.choices[0]?.message?.content ?? "";
}

export async function callLLMFull(systemPrompt: string, userPrompt: string): Promise<string> {
  const cl = await createAzureClient();
  const response = await cl.chat.completions.create({
    model: await getDeploymentFull(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });
  return response.choices[0]?.message?.content ?? "";
}

export async function callLLMFullWithSchema(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: Record<string, unknown>
): Promise<string> {
  const cl = await createAzureClient();
  const response = await cl.chat.completions.create({
    model: await getDeploymentFull(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    } as unknown as { type: "json_object" },
  });
  return response.choices[0]?.message?.content ?? "";
}

export async function streamLLMFull(
  systemPrompt: string,
  userPrompt: string,
  onChunk: (chunk: string) => void
): Promise<string> {
  const cl = await createAzureClient();
  const stream = await cl.chat.completions.create({
    model: await getDeploymentFull(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    stream: true,
  });
  let full = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      full += delta;
      onChunk(delta);
    }
  }
  return full;
}

export async function streamLLMFullWithSchema(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema: Record<string, unknown>,
  onChunk: (chunk: string) => void
): Promise<string> {
  const cl = await createAzureClient();
  const stream = await cl.chat.completions.create({
    model: await getDeploymentFull(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    } as unknown as { type: "json_object" },
    stream: true,
  });
  let full = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      full += delta;
      onChunk(delta);
    }
  }
  return full;
}

export function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();
}

export const PARTICLES = new Set([
  "的", "了", "着", "过", "吗", "呢", "吧", "啊", "呀",
  "哦", "哇", "嘛", "啦", "嘞", "喽", "罢了", "而已", "来着",
]);

export const PARTICLE_PINYIN: Record<string, string> = {
  "的": "de", "了": "le", "着": "zhe", "过": "guò",
  "吗": "ma", "呢": "ne", "吧": "ba", "啊": "ā",
  "呀": "ya", "哦": "ó", "哇": "wa", "嘛": "ma",
  "啦": "la", "嘞": "lei", "喽": "lou",
  "罢了": "bàle", "而已": "éryǐ", "来着": "láizhe",
};

export async function generatePinyinForChars(
  chars: string[]
): Promise<{ char: string; pinyin: string }[]> {
  if (chars.length === 0) return [];

  const systemPrompt = `You are a Chinese pronunciation expert. Given a list of individual Chinese characters, return their most common pinyin with tone marks. Return a JSON object with a "results" key containing an array of {"char": "...", "pinyin": "..."} objects.`;
  const userPrompt = `Provide pinyin for these characters: ${chars.join(", ")}`;

  const raw = await callLLM(systemPrompt, userPrompt);
  const parsed = JSON.parse(stripMarkdownFences(raw));
  const results: { char: string; pinyin: string }[] = [];

  for (const entry of parsed.results ?? []) {
    if (
      typeof entry?.char === "string" &&
      typeof entry?.pinyin === "string" &&
      entry.char.length === 1 &&
      entry.pinyin.length > 0
    ) {
      results.push({ char: entry.char, pinyin: entry.pinyin });
    }
  }

  return results;
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
  sentences: string[]
): Promise<Map<number, Segment[]>> {
  const systemPrompt = `You are a Chinese language expert. Segment Chinese sentences into individual words, providing pinyin with tone marks for each Chinese word. Non-Chinese tokens (punctuation, numbers, English text) should have no pinyin.

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

  const raw = await callLLM(systemPrompt, userPrompt);
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

export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
