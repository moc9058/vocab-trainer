/** Long articles keep occurrence readings/glosses; detailed syntax is generated per sentence on demand. */
export function compactImportSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const compact = structuredClone(schema) as any;
  const sentence = compact.schema?.properties?.paragraphs?.items?.properties?.sentences?.items;
  if (!sentence?.properties?.overview) return schema; // legacy config compatibility
  for (const field of ["overview", "ambiguityNotes"]) delete sentence.properties[field];
  sentence.required = Object.keys(sentence.properties);
  const word = sentence.properties.words.items;
  for (const field of ["partOfSpeech", "role", "reasoning", "contrast", "senseKey"]) delete word.properties[field];
  word.required = Object.keys(word.properties);
  const grammar = sentence.properties.grammar.items;
  for (const field of ["roleInSentence", "elements"]) delete grammar.properties[field];
  grammar.required = Object.keys(grammar.properties);
  return compact;
}

export const COMPACT_IMPORT_INSTRUCTIONS = `\nLong-article mode: use the compact response schema. Keep every occurrence's surface, ordinal, contextual reading and short meaning, including repeated words and function words. Return explanationLanguage as ja. Do not generate overview, ambiguityNotes, role, reasoning, contrast, senseKey or grammar elements: those are explained on demand for one sentence. Keep each gloss concise (roughly 15 Japanese characters); no dictionary-sense lists. Preserve ALL source sentences verbatim.\n`;
