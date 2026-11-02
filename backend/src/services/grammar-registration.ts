import { getGrammarConfig } from '../firestore.js';
import { callLLM, stripMarkdownFences, fillGrammarTransliteration } from '../llm.js';
import { mergeGrammarDescriptions, GRAMMAR_DEFINITION_LANGUAGES } from '../grammar-descriptions.js';
import type { Meaning } from '../types.js';
export async function completeGrammarDescriptions(language: string, statement: string, descriptions: Meaning[]) {
  const config = await getGrammarConfig();
  const template = config.smartAddPrompts[language] ?? config.smartAddPrompts.default;
  const variables: Record<string,string> = { LANGUAGE: language, DEFINITION_LANGUAGES: GRAMMAR_DEFINITION_LANGUAGES.map(l => `"${l}": "..."`).join(', ') };
  const system = template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? '');
  const raw = await callLLM({ system, user: JSON.stringify({ statement, descriptions }, null, 2), schema: config.smartAddSchema, route: 'grammar/smart-add' });
  return mergeGrammarDescriptions(descriptions, JSON.parse(stripMarkdownFences(raw)).descriptions ?? []);
}
export async function prepareGrammarRegistration(body: { statement: string; descriptions: Meaning[]; transliteration?: string }) {
  const descriptions = await completeGrammarDescriptions('chinese', body.statement, body.descriptions);
  let transliteration = body.transliteration;
  if (!transliteration) {
    try { transliteration = (await fillGrammarTransliteration([body.statement])).get(0); } catch { /* Optional reading, same policy as legacy create. */ }
  }
  return { ...body, descriptions, ...(transliteration ? { transliteration } : {}) };
}
