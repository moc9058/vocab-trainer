/** Initial imports keep occurrence readings/glosses; detailed syntax is generated per sentence on demand. */
export function compactImportSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const compact = structuredClone(schema) as any;
  const sentence = compact.schema?.properties?.paragraphs?.items?.properties?.sentences?.items;
  if (!sentence?.properties?.overview) return schema; // legacy config compatibility
  for (const field of ["overview", "ambiguityNotes", "comprehension"]) delete sentence.properties[field];
  sentence.required = Object.keys(sentence.properties);
  const word = sentence.properties.words.items;
  for (const field of ["partOfSpeech", "role", "reasoning", "contrast", "senseKey"]) delete word.properties[field];
  word.required = Object.keys(word.properties);
  const grammar = sentence.properties.grammar.items;
  for (const field of ["roleInSentence"]) delete grammar.properties[field];
  grammar.required = Object.keys(grammar.properties);
  return compact;
}

export const IMPORT_ELEMENT_INSTRUCTIONS = `\nFor EVERY grammar pattern, include ALL variable slots and fixed function elements in elements, in source order. A and B each refer to the COMPLETE participating phrase/clause, including modifiers, names and parenthetical names, not just its head word. For A + 与 + B, group all words of A in one fixed=false element, 与 in one fixed=true element, and all words of B in one fixed=false element. Use roles such as A / B / 動詞句 to identify slots. Do not label a content slot as fixed. For Chinese, EVERY Han-containing occurrence linked to a grammar element MUST have non-empty contextual pinyin with tone marks in the words array, including fixed function words and EVERY word in variable A/B/v/o slots. Never omit pinyin to save output. Latin names, placeholders and punctuation do not need pinyin. Every fixed element must also have a contextual meaning. Keep explanations short; never omit slot boundaries to save output.\n`;

export const COMPACT_IMPORT_INSTRUCTIONS = `\nInitial reading mode: use the compact response schema. Keep every occurrence's surface, ordinal, contextual reading and short meaning, including repeated words and function words. Return explanationLanguage as ja. Do not generate overview, ambiguityNotes, role, reasoning, contrast, senseKey or lengthy syntax explanations. Keep grammar elements with wordIndices, fixed flags and short roles/explanations: these are required to distinguish fixed function elements from complete variable slots. Keep each gloss concise (roughly 15 Japanese characters); no dictionary-sense lists. Preserve ALL source sentences verbatim.\n` + IMPORT_ELEMENT_INSTRUCTIONS;
