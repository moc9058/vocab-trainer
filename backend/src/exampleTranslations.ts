import { callLLMWithSchema, stripMarkdownFences } from "./llm.js";
import { updateExampleSentence } from "./firestore.js";
import type { ExampleSentence } from "./types.js";

// All supported definition / example-translation languages. The LLM is asked to
// generate every entry in all four; the frontend display settings then control
// which subset the user sees.
export const ALL_DEFINITION_LANGUAGES = ["en", "ja", "ko", "zh"] as const;

// Map our internal full language names to the ISO codes used in
// definition / example-translation Records. Languages outside this map
// (custom user languages) have no source-language entry to strip.
export const LANGUAGE_TO_ISO: Record<string, string> = {
  chinese: "zh",
  english: "en",
  japanese: "ja",
  korean: "ko",
};

/**
 * True when a stored/incoming example translation carries no content:
 * null/undefined, an empty or whitespace-only string, or an object whose
 * values are all empty. (Chip adds historically wrote `""` verbatim.)
 */
export function translationIsEmpty(
  translation: ExampleSentence["translation"] | undefined,
): boolean {
  if (translation == null) return true;
  if (typeof translation === "string") return translation.trim() === "";
  const values = Object.values(translation);
  return values.length === 0 || values.every((v) => typeof v !== "string" || v.trim() === "");
}

/**
 * True when a stored/incoming translation is missing any of the target
 * definition languages for `language` (all of `ALL_DEFINITION_LANGUAGES`
 * except the sentence's own language). Unlike `translationIsEmpty`, this
 * also flags a non-empty single-language string or a partially-filled
 * Record as needing more work — the case a hand-typed single-field
 * translation always falls into.
 */
export function needsMoreTranslations(
  translation: ExampleSentence["translation"] | undefined,
  language: string,
): boolean {
  if (translationIsEmpty(translation) || translation == null) return true;
  const sourceLangCode = LANGUAGE_TO_ISO[language];
  const requiredLangs = (ALL_DEFINITION_LANGUAGES as readonly string[]).filter(
    (l) => l !== sourceLangCode
  );
  if (typeof translation === "string") return requiredLangs.length > 0;
  return requiredLangs.some((l) => !translation[l] || translation[l].trim() === "");
}

export interface MissingTranslationItem {
  exampleId: string;
  sentence: string;
}

// Sentences per LLM call — routes send a handful, but the backfill script may
// queue hundreds; chunking keeps each structured-output response small.
const LLM_BATCH_SIZE = 20;

/**
 * Generate example-sentence translations for docs saved without one and write
 * them back via `updateExampleSentence`. Target languages are all definition
 * languages except the sentence's own (`LANGUAGE_TO_ISO[language]`).
 *
 * Shared by the vocab PUT/smart-add routes, the grammar example resolver, and
 * `scripts/backfill-empty-example-translations.ts`. LLM failures are non-fatal
 * (logged and skipped) — the examples stay saved, just without translations.
 *
 * Returns the translations that were actually written, keyed by exampleId, so
 * callers can mirror them into in-memory copies (e.g. the word doc's inline
 * examples) without re-reading Firestore.
 */
export async function generateMissingExampleTranslations(
  language: string,
  items: MissingTranslationItem[],
  opts?: {
    log?: { error: (obj: object, msg?: string) => void };
    route?: string;
    dryRun?: boolean;
  },
): Promise<Map<string, Record<string, string>>> {
  const applied = new Map<string, Record<string, string>>();
  if (items.length === 0) return applied;

  const sourceLangCode = LANGUAGE_TO_ISO[language];
  const translLangs = (ALL_DEFINITION_LANGUAGES as readonly string[]).filter(
    (l) => l !== sourceLangCode
  );
  if (translLangs.length === 0) return applied;

  const langSpec = translLangs.map((l) => `"${l}": "..."`).join(", ");
  const translSchema = {
    name: "example_translations",
    strict: true,
    schema: {
      type: "object",
      properties: {
        translations: {
          type: "array",
          items: {
            type: "object",
            properties: Object.fromEntries(translLangs.map((l) => [l, { type: "string" }])),
            required: translLangs,
            additionalProperties: false,
          },
        },
      },
      required: ["translations"],
      additionalProperties: false,
    },
  };
  const systemPrompt = `You are a translation assistant. For each input sentence, provide a translation object with keys: { ${langSpec} }. Return an array with one object per sentence, in the same order as the input.`;
  const route = opts?.route ?? "vocab/translate-examples";

  for (let start = 0; start < items.length; start += LLM_BATCH_SIZE) {
    const batch = items.slice(start, start + LLM_BATCH_SIZE);
    const userPrompt = JSON.stringify(batch.map((n) => n.sentence));
    try {
      const raw = await callLLMWithSchema(systemPrompt, userPrompt, translSchema, route);
      const result = JSON.parse(stripMarkdownFences(raw)) as { translations: Record<string, string>[] };
      const translArr = result.translations ?? [];
      for (let ti = 0; ti < batch.length; ti++) {
        const trans = translArr[ti];
        if (trans && Object.keys(trans).length > 0) {
          if (!opts?.dryRun) {
            await updateExampleSentence(batch[ti].exampleId, { translation: trans });
          }
          applied.set(batch[ti].exampleId, trans);
        }
      }
    } catch (err) {
      opts?.log?.error({ err }, "Failed to generate example translations");
      // Non-fatal: examples are saved, just without translations
    }
  }
  return applied;
}
