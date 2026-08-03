import { callLLM, stripMarkdownFences } from "./llm.js";
import type { HanjaReading } from "./types.js";

/**
 * Korean hanja readings for Chinese terms, one entry per character.
 *
 * Used at two moments: `scripts/backfill-hanja-readings.ts` for words that predate
 * this, and `routes/vocab.ts` smart-add so a newly added word arrives with its
 * readings already in place. Both share this module so the prompt and the shape of
 * the result cannot drift apart.
 *
 * The unit of work is a BATCH of terms — hanja readings are a per-character lookup
 * with no cross-word context, so asking for one word per request wastes a whole
 * round-trip and a whole prompt on each of them. Smart-add simply sends a batch of
 * one. The FULL model is used: the readings are a knowledge question, and a wrong
 * 훈음 is silently wrong.
 */

const SYSTEM_PROMPT = `You are a Korean hanja expert. You are given a LIST of Chinese words (simplified characters) with their pinyin. For EACH word, decompose every character of the term into its Korean hanja information.

For each character provide:
- simplifiedChar : the original simplified Chinese character (copy exactly from input)
- traditionalChar: the traditional (번체) Korean hanja form; if identical to simplified, repeat it
- hunEum         : list of ALL valid Korean 훈음 readings for this character
                   (e.g. ["사랑 애"] or ["다닐 행", "항렬 항", "줄 행"] for multi-reading characters)

Rules:
- Return one entry in "words" for EVERY word of the input, in the SAME ORDER, with "term" copied verbatim from the input. Never merge, drop, reorder or rewrite the input words.
- List every attested 훈음 — do NOT omit secondary readings.
- If a character has no established Korean hanja reading (digits, Latin letters, punctuation, or extremely rare characters not used in Korean), return hunEum as an empty array [].
- Do NOT fabricate readings. Only include attested 훈음.
- Process ONLY the characters in each "term" field, one entry per character, in order.`;

const LLM_SCHEMA = {
  name: "hanja_readings",
  strict: false,
  schema: {
    type: "object",
    required: ["words"],
    properties: {
      words: {
        type: "array",
        items: {
          type: "object",
          required: ["term", "readings"],
          properties: {
            term: { type: "string" },
            readings: {
              type: "array",
              items: {
                type: "object",
                required: ["simplifiedChar", "traditionalChar", "hunEum"],
                properties: {
                  simplifiedChar: { type: "string" },
                  traditionalChar: { type: "string" },
                  hunEum: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

interface LLMResponse {
  words: {
    term: string;
    readings: { simplifiedChar: string; traditionalChar: string; hunEum: string[] }[];
  }[];
}

export interface HanjaRequest {
  term: string;
  transliteration?: string;
}

/** Entries with no 훈음 are dropped: a term made entirely of digits or Latin
 *  letters legitimately yields `[]`, which the UI shows as "no hanja" rather than
 *  as "not looked up yet". */
function cleanReadings(readings: LLMResponse["words"][number]["readings"]): HanjaReading[] {
  return (readings ?? [])
    .filter((r) => Array.isArray(r.hunEum) && r.hunEum.length > 0)
    .map((r) => ({
      simplifiedChar: r.simplifiedChar,
      traditionalChar: r.traditionalChar,
      hunEum: r.hunEum,
    }));
}

/**
 * One LLM call for the whole batch. Keyed by term on the way back rather than by
 * position, so a response that drops or reorders an entry cannot attach one word's
 * readings to another — a term missing from the map is the caller's signal to
 * report it as unprocessed instead of storing something wrong.
 */
export async function generateHanjaReadingsBatch(
  items: HanjaRequest[],
  caller = "vocab/hanja-readings"
): Promise<Map<string, HanjaReading[]>> {
  const result = new Map<string, HanjaReading[]>();
  if (items.length === 0) return result;

  // Duplicate terms would only buy duplicate output tokens.
  const unique = [...new Map(items.map((i) => [i.term, i])).values()];
  const raw = await callLLM({
    system: SYSTEM_PROMPT,
    user: JSON.stringify({
      words: unique.map((i) => ({ term: i.term, pinyin: i.transliteration ?? "" })),
    }),
    schema: LLM_SCHEMA as unknown as Record<string, unknown>,
    tier: "full",
    route: caller,
  });
  const parsed = JSON.parse(stripMarkdownFences(raw)) as LLMResponse;

  const wanted = new Set(unique.map((i) => i.term));
  for (const entry of parsed.words ?? []) {
    if (!wanted.has(entry.term)) continue;
    result.set(entry.term, cleanReadings(entry.readings));
  }
  return result;
}

/** Single-term convenience wrapper — smart-add adds one word at a time. */
export async function generateHanjaReadings(
  term: string,
  transliteration: string | undefined,
  caller = "vocab/hanja-readings"
): Promise<HanjaReading[]> {
  const batch = await generateHanjaReadingsBatch([{ term, transliteration }], caller);
  const readings = batch.get(term);
  if (!readings) throw new Error(`No hanja readings returned for "${term}"`);
  return readings;
}
