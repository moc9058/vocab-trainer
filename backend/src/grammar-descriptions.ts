import type { Meaning } from "./types.js";

export const GRAMMAR_DEFINITION_LANGUAGES = ["ja", "ko"] as const;

export class IncompleteGrammarDescriptionsError extends Error {}

/** Preserve authored descriptions; supplement the same-index meaning in Japanese/Korean. */
export function mergeGrammarDescriptions(supplied: Meaning[], generated: Meaning[]): Meaning[] {
  return supplied.map((description, index) => {
    const text = { ...description.text };
    for (const language of GRAMMAR_DEFINITION_LANGUAGES) {
      if (typeof text[language] === "string" && text[language].trim()) continue;
      const translation = generated[index]?.text?.[language];
      if (typeof translation !== "string" || !translation.trim()) {
        throw new IncompleteGrammarDescriptionsError(`Missing ${language} description at index ${index}`);
      }
      text[language] = translation;
    }
    return {
      partOfSpeech: description.partOfSpeech,
      text,
      ...(description.pinyins?.length ? { pinyins: description.pinyins } : {}),
    };
  });
}
