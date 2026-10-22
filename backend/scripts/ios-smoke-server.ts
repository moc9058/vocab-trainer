/** Synthetic, local-only iOS test server. No production seed or real LLM requests. */
import { mock } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080') throw new Error('Use FIRESTORE_EMULATOR_HOST=127.0.0.1:8080');
process.env.FIRESTORE_PROJECT = 'demo-vocab-ios-smoke'; process.env.FIRESTORE_DATABASE_ID = '(default)';
process.env.PORT = '3000';
// Do not inherit production OAuth credentials from the shell or root .env.
for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_URI', 'SESSION_SECRET', 'ALLOWED_EMAILS']) process.env[key] = '';
const db = new Firestore({ projectId: process.env.FIRESTORE_PROJECT, databaseId: '(default)' });
const words = ['hello', 'world', 'learn'];
await db.doc('config/auth').delete(); // Auth is disabled only in this synthetic emulator namespace.
await db.doc('quiz_sessions/english').delete(); // This dedicated synthetic namespace only.
await db.doc('config/vocabulary').set({ smartAddSchema: {}, smartAddPrompts: {}, segmentSchema: {}, segmentPrompt: 'mock' });
await db.doc('config/speaking_writing').set({ prompts: {}, schema: {} });
await db.doc('config/grammar').set({ smartAddSchema: {}, smartAddPrompts: {} });
await db.doc('config/translation').set({ decomposeSchema: {}, decomposePrompts: { en: 'mock', ja: 'mock', ko: 'mock', zh: 'mock' }, translateSchema: {}, translatePrompts: { en: 'mock', ja: 'mock', ko: 'mock', zh: 'mock' } });
await db.doc('languages/english').set({ wordCount: words.length, topics: [], levels: [] });
for (const [index, term] of words.entries()) await db.doc(`words/ios-smoke-${index}`).set({ id: `ios-smoke-${index}`, language: 'english', term,
  definitions: [{ partOfSpeech: 'noun', text: { ja: `テスト ${term}`, ko: `테스트 ${term}` } }], examples: [], topics: [] });
await db.doc('word_groups/ios-smoke-a').set({ id: 'ios-smoke-a', name: 'Simulator sample', language: 'english', category: 'A', wordIds: words.map((_, i) => `ios-smoke-${i}`), createdAt: new Date().toISOString() });
const actual = await import('../src/llm.js');
const blocked = () => { throw new Error('LLM is disabled in iOS smoke tests'); };
mock.module('../src/llm.js', { namedExports: { ...actual, createOpenAIClient: blocked, getModelMini: blocked, getModelFull: blocked,
  resolveModel: blocked, segmentBatch: blocked, fillGrammarTransliteration: blocked, fillSegmentPinyin: blocked,
  callLLM: async (options: { route?: string; onChunk?: (chunk: string) => void }) => {
    const data = options.route?.includes('decompose') ? { sentences: [{ text: 'Hello world.', chunks: [{ surface: 'Hello world.', components: [] }] }] }
      : { passages: [{ sentenceIds: ['s1'], translation: 'こんにちは。' }], chunks: [{ chunkId: 's1c1', meaning: '挨拶' }], components: [] };
    const json = JSON.stringify(data);
    for (let i = 0; i < json.length; i += 15) { options.onChunk?.(json.slice(i, i + 15)); await new Promise(r => setTimeout(r, 120)); }
    return json;
  } } });
await import('../src/index.js');
