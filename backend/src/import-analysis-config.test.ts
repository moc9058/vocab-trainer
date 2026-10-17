import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { compactImportSchema } from './import-analysis-config.js';

test('compact schema remains strict, does not mutate loaded config and preserves per-occurrence glosses', () => {
  const schema = JSON.parse(readFileSync(new URL('../DB/import/analyze_schema.json', import.meta.url), 'utf8'));
  const compact = compactImportSchema(schema) as any;
  const sentence = compact.schema.properties.paragraphs.items.properties.sentences.items;
  assert.equal(sentence.properties.overview, undefined);
  assert.equal(sentence.properties.words.items.properties.reasoning, undefined);
  assert.ok(sentence.properties.words.items.properties.occurrence);
  assert.ok(sentence.properties.grammar.items.properties.elements, "slot boundaries must survive compact imports");
  assert.ok(schema.schema.properties.paragraphs.items.properties.sentences.items.properties.overview);
  const check = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') { assert.equal(node.additionalProperties, false); assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties))); }
    for (const value of Object.values(node)) if (typeof value === 'object') Array.isArray(value) ? value.forEach(check) : check(value);
  };
  check(compact.schema);
});
