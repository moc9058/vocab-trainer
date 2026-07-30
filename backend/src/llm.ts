import OpenAI from "openai";
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

let client: OpenAI | null = null;
let modelMini = "";
let modelFull = "";
let initPromise: Promise<void> | null = null;

async function loadLLMConfig(): Promise<void> {
  // If all env vars are already set (from .env), skip Firestore
  if (
    process.env.OPENAI_API_KEY &&
    process.env.OPENAI_MODEL_MINI &&
    process.env.OPENAI_MODEL_FULL
  ) {
    return;
  }

  // Fetch from Firestore config/llm
  try {
    const db = new Firestore({
      // Honoured for the same reason firestore.ts does: without it the client
      // resolves the project from ADC, so a local run reads config/llm out of
      // whatever project gcloud is pointed at and silently finds no API key.
      // Unset (the deployed case) keeps the ADC behaviour.
      projectId: process.env.FIRESTORE_PROJECT || undefined,
      databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
      ignoreUndefinedProperties: true,
    });
    const doc = await db.collection("config").doc("llm").get();
    if (doc.exists) {
      const data = doc.data()!;
      for (const key of [
        "OPENAI_API_KEY",
        "OPENAI_MODEL_MINI",
        "OPENAI_MODEL_FULL",
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
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not configured");
      }
      if (!process.env.OPENAI_MODEL_MINI) {
        throw new Error("OPENAI_MODEL_MINI is not configured");
      }
      client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        maxRetries: 5,
      });
      modelMini = process.env.OPENAI_MODEL_MINI;
      modelFull = process.env.OPENAI_MODEL_FULL ?? "";
    })();
  }
  return initPromise;
}

export async function createOpenAIClient(): Promise<OpenAI> {
  await ensureInit();
  return client!;
}

export async function getModelMini(): Promise<string> {
  await ensureInit();
  return modelMini;
}

export async function getModelFull(): Promise<string> {
  await ensureInit();
  if (!modelFull) {
    throw new Error("OPENAI_MODEL_FULL is not configured");
  }
  return modelFull;
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
  const cl = await createOpenAIClient();
  const model = await getModelMini();
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
  const cl = await createOpenAIClient();
  const model = await getModelFull();
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
  const cl = await createOpenAIClient();
  const model = await getModelMini();
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
  const cl = await createOpenAIClient();
  const model = await getModelFull();
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
  const cl = await createOpenAIClient();
  const model = await getModelFull();
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
  const cl = await createOpenAIClient();
  const model = await getModelFull();
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
  const cl = await createOpenAIClient();
  const model = await getModelMini();
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
- Exclude punctuation, numbers, and all non-word tokens — only include actual Chinese words or terms`;

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
      // Drop dirty segments: text must be composed entirely of Han characters
      // or Latin letters. This catches pure punctuation ("，") and mixed
      // content ("，所以") alike.
      if (!/^[\p{Script=Han}a-zA-Z]+$/u.test(seg.text)) continue;
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

const TONE_MARKS: Record<string, string[]> = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  "ü": ["ǖ", "ǘ", "ǚ", "ǜ"],
};

/**
 * Rewrite numbered pinyin into tone marks: "hao3" → "hǎo", "lv4" → "lǜ", "de5" → "de".
 *
 * A deterministic safety net under the prompt, not a replacement for it — the model
 * is told to emit marks directly, but a stray "shuo1" must never reach storage, since
 * tone marks are the whole point of the field. Mark placement follows the standard
 * rule (a/e win; in "ou" the o takes it; otherwise the last vowel), the same one
 * `frontend/src/components/PinyinInput.tsx` applies to typed input.
 */
export function toneMarkNumberedPinyin(text: string): string {
  return text.replace(/([a-zA-ZüÜ]+)([1-5])/g, (whole, syllable: string, digit: string) => {
    const tone = Number(digit);
    let out = syllable.replace(/v/g, "ü").replace(/V/g, "Ü");
    if (tone === 5) return out; // neutral tone carries no mark
    const lower = out.toLowerCase();
    let idx = -1;
    if (lower.includes("a")) idx = lower.indexOf("a");
    else if (lower.includes("e")) idx = lower.indexOf("e");
    else if (lower.includes("ou")) idx = lower.indexOf("o");
    else {
      for (let i = lower.length - 1; i >= 0; i--) {
        if ("iouü".includes(lower[i])) { idx = i; break; }
      }
    }
    const marked = idx === -1 ? undefined : TONE_MARKS[lower[idx]]?.[tone - 1];
    if (!marked) return whole; // not a romanizable syllable — leave it alone
    out = out.slice(0, idx) + marked + out.slice(idx + 1);
    return out;
  });
}

const GRAMMAR_TRANSLITERATION_SCHEMA = {
  name: "grammar_transliterations",
  strict: false,
  schema: {
    type: "object",
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "transliteration"],
          properties: {
            index: { type: "integer" },
            transliteration: { type: "string" },
          },
        },
      },
    },
  },
};

/**
 * Romanize Chinese grammar `statement`s into the `Grammar.transliteration` field.
 *
 * A statement is pattern notation, not a sentence ("敢+v", "v+得+很+adj"), so this is
 * NOT a plain romanization: only the Chinese lexical material is converted and every
 * other token — the lowercase element placeholders (v/o/s/n/adj…), the connectors
 * (+ ~ / parentheses) and any Japanese metalanguage label — must survive byte-for-byte
 * so the reading still lines up with the pattern it annotates.
 *
 * Batched in one call (like `fillSegmentPinyin`) so a backfill amortizes the cost.
 * Returns a map of input index → transliteration; an index is absent when the model
 * skipped it or returned something unusable.
 */
export async function fillGrammarTransliteration(
  statements: string[]
): Promise<Map<number, string>> {
  if (statements.length === 0) return new Map();

  const systemPrompt = `You are a Chinese language expert. Each input is a Chinese GRAMMAR PATTERN statement — pattern notation, not a sentence. Produce its pinyin reading.

Rules:
- Romanize ONLY the Chinese (Han) characters that are part of the pattern itself.
- ALWAYS use tone marks (ā á ǎ à ē é ě è ī í ǐ ì ō ó ǒ ò ū ú ǔ ù ǖ ǘ ǚ ǜ). NEVER use tone numbers ("hao3") and never leave a toned syllable unmarked ("hao"). A neutral-tone syllable correctly carries no mark (的 → de, 了 → le, 着 → zhe).
- Keep EVERY non-Chinese token exactly as it is, in the same position: the lowercase grammatical element placeholders (v, o, s, n, c, adj, adv, aux, vp, np …), connectors and punctuation (+ ~ ～ / ( ) 、 ，), digits, and Latin text. Do not reorder, translate, expand or re-case them.
- Keep Japanese metalanguage labels verbatim — they are annotations, not Chinese to be read. 程度副詞, 名詞, 動詞, 可能補語 and the like stay as-is. A Han run that sits next to kana (「人/もの」, 「状態を表す述語」) belongs to the Japanese annotation: leave the WHOLE slot alone, kanji included.
- If a statement contains no Chinese material at all (only placeholders and Japanese labels, e.g. "adv+v/adj" or "可能補語"), return an empty string rather than echoing the statement back.
- Multi-syllable Chinese words are written as one token with the syllables joined (学生 → xuéshēng); separate tokens stay separated by whatever separator the statement uses.
- Output one entry per input, with the input's index.

Examples:
- "敢+v" → "gǎn+v"
- "v+得+很+adj" → "v+de+hěn+adj"
- "v+得+程度副詞+adj" → "v+de+程度副詞+adj"
- "越来越+adj" → "yuèláiyuè+adj"
- "能(/可以)+v" → "néng(/kěyǐ)+v"`;

  const numbered = statements.map((s, i) => `${i}. ${s}`).join("\n");
  const userPrompt = `Give the pinyin reading of each grammar statement:\n\n${numbered}`;

  const raw = await callLLMWithSchema(
    systemPrompt,
    userPrompt,
    GRAMMAR_TRANSLITERATION_SCHEMA,
    "llm/fill-grammar-transliteration"
  );
  const parsed = JSON.parse(stripMarkdownFences(raw));
  const results = new Map<number, string>();

  for (const entry of parsed.results ?? []) {
    if (typeof entry?.index !== "number" || !Number.isInteger(entry.index)) continue;
    if (entry.index < 0 || entry.index >= statements.length) continue;
    if (typeof entry.transliteration !== "string") continue;
    const value = toneMarkNumberedPinyin(entry.transliteration.trim());
    // An echo of the statement means nothing was romanized — storing it would
    // display the prompt twice in the quiz rather than its reading.
    if (!value || value === statements[entry.index].trim()) continue;
    results.set(entry.index, value);
  }

  return results;
}

/** Call LLM to fill pinyin for user-provided segment splits (no re-segmentation) */
export async function fillSegmentPinyin(
  items: Array<{ sentence: string; splits: string[] }>,
  config?: { prompt: string; schema: Record<string, unknown> }
): Promise<Map<number, Segment[]>> {
  const systemPrompt = config?.prompt
    ?? `You are a Chinese language expert. Each sentence has already been split into segments by the user. Your ONLY task is to provide pinyin with tone marks for each segment. Do NOT re-segment, merge, or split — use the provided splits exactly.

Return a JSON object with a "results" key containing an array. Each entry has:
- "index": the sentence number (0-based)
- "segments": array of {"text": "...", "pinyin": "..."} objects. The "text" values must match the input splits exactly. Omit "pinyin" for non-Chinese tokens (numbers, Latin text, punctuation).

Rules:
- Use tone marks on pinyin (e.g. "nǐ" not "ni3")
- Multi-syllable words get space-separated syllables (e.g. "xuéshēng" for 学生)
- Keep every input split as its own segment — no merging, no splitting`;

  const numbered = items
    .map((item, i) => `${i}. Sentence: ${item.sentence}\n   Segments: ${JSON.stringify(item.splits)}`)
    .join("\n");
  const userPrompt = `Fill pinyin for these Chinese sentences and their pre-defined segments:\n\n${numbered}`;

  const raw = config?.schema
    ? await callLLMWithSchema(systemPrompt, userPrompt, config.schema, "llm/fill-segment-pinyin")
    : await callLLM(systemPrompt, userPrompt, "llm/fill-segment-pinyin");
  const parsed = JSON.parse(stripMarkdownFences(raw));
  const results = new Map<number, Segment[]>();

  for (const entry of parsed.results ?? []) {
    if (typeof entry?.index !== "number" || !Array.isArray(entry?.segments)) continue;
    const segs: Segment[] = [];
    for (const seg of entry.segments) {
      if (typeof seg?.text !== "string" || seg.text.length === 0) continue;
      if (!/^[\p{Script=Han}a-zA-Z]+$/u.test(seg.text)) continue;
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
