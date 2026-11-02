import type { WordMeaning } from "./types.js";

/** Word meanings deliberately have no grammatical category. Accept legacy input. */
export function normalizeWordDefinitions(data: { definitions?: unknown; definition?: unknown }): WordMeaning[] {
  const values = Array.isArray(data.definitions) ? data.definitions :
    data.definition && typeof data.definition === "object" ? [{ text: data.definition }] : [];
  return values.filter(value => value && typeof value === "object").map(def => ({
    text: def.text && typeof def.text === "object" ? def.text : {},
    ...(Array.isArray(def.pinyins) && def.pinyins.length > 0 ? { pinyins: def.pinyins } : {}),
  }));
}

/** Preserve all other word/draft fields; never let legacy clients recreate retired data. */
export function normalizeWordRecord<T extends Record<string, unknown>>(data: T): T {
  const result: Record<string, unknown> = { ...data };
  delete result.grammaticalCategory;
  delete result.partOfSpeech;
  delete result.flag;
  delete result.flaggedOnly;
  delete result.flagWordIds;
  if (Array.isArray(data.definitions) || data.definition) result.definitions = normalizeWordDefinitions(data);
  return result as T;
}

/** Only word payloads in sessions are cleaned; grammar descriptions remain intact. */
export function normalizeWordSession<T extends Record<string, unknown>>(data: T): T {
  const result: Record<string, unknown> = { ...data };
  delete result.flaggedOnly;
  delete result.flagWordIds;
  if (Array.isArray(data.questions)) {
    result.questions = data.questions.map(q => q?.kind === "grammar" ? q : normalizeWordRecord(q));
  }
  return result as T;
}
