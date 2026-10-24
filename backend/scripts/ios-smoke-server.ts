import { readFileSync } from 'node:fs';
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
await db.doc('config/import').set({ analyzePrompts: { chinese: 'Synthetic smoke only' }, analyzeSchema: JSON.parse(readFileSync(new URL('../DB/import/analyze_schema.json', import.meta.url), 'utf8')) });
await db.doc('config/grammar').set({ smartAddSchema: {}, smartAddPrompts: {} });
await db.doc('config/translation').set({ decomposeSchema: {}, decomposePrompts: { en: 'mock', ja: 'mock', ko: 'mock', zh: 'mock' }, translateSchema: {}, translatePrompts: { en: 'mock', ja: 'mock', ko: 'mock', zh: 'mock' } });
await db.doc('languages/chinese').set({ wordCount: 0, topics: [], levels: [] });
await db.doc('languages/english').set({ wordCount: words.length, topics: [], levels: [] });
for (const [index, term] of words.entries()) await db.doc(`words/ios-smoke-${index}`).set({ id: `ios-smoke-${index}`, language: 'english', term,
  definitions: [{ partOfSpeech: 'noun', text: { ja: `テスト ${term}`, ko: `테스트 ${term}` } }], examples: [], topics: [] });
await db.doc('word_groups/ios-smoke-a').set({ id: 'ios-smoke-a', name: 'Simulator sample', language: 'english', category: 'A', wordIds: words.map((_, i) => `ios-smoke-${i}`), createdAt: new Date().toISOString() });
const actual = await import('../src/llm.js');
const blocked = () => { throw new Error('LLM is disabled in iOS smoke tests'); };
mock.module('../src/llm.js', { namedExports: { ...actual, createOpenAIClient: blocked, getModelMini: blocked, getModelFull: blocked,
  resolveModel: async (_tier: string, route: string) => { if (route.startsWith('import/')) return 'mock-model'; return blocked(); }, segmentBatch: blocked, fillGrammarTransliteration: blocked, fillSegmentPinyin: blocked,
  callLLM: async (options: { route?: string; user?: string; onChunk?: (chunk: string) => void }) => {
    if (options.route?.startsWith('import/')) {
      const { target } = JSON.parse(options.user!);
      const detailed = options.route === 'import/sentence-explanation';
      const dictionary = [['虽然', 'suī rán', '〜だけれど'], ['很忙', 'hěn máng', 'とても忙しい'], ['但', 'dàn', 'しかし'], ['我', 'wǒ', '私'], ['还是', 'hái shì', 'それでも'], ['来', 'lái', '来る'], ['了', 'le', '完了']];
      const words = dictionary.filter(([term]) => target.includes(term)).map(([term, transliteration, meaning]) => ({ term, surface: term, occurrence: 0, transliteration, meaning }));
      const split = target.indexOf('，') + 1;
      const texts = split > 0 && split < target.length ? [target.slice(0, split), target.slice(split)] : [target];
      return JSON.stringify({ paragraphs: [{ sentences: [{ text: target, explanationLanguage: 'ja', words, grammar: [], ...(detailed ? { overview: '忙しいけれど、それでも来たことを伝えています。', ambiguityNotes: [], comprehension: { meaning: '忙しいけれど、それでも来た。', skeleton: '私が来た', connection: '前後の文脈は不明。', nuances: [], meaningUnits: { units: texts.map((text, i) => ({ text, meaning: i === 0 && texts.length > 1 ? '忙しいけれど' : 'それでも来た', role: i === 0 && texts.length > 1 ? '譲歩' : '結論' })), flow: '忙しいという事情から、それでも来たという結論につながります。' } } } : {}) }] }] });
    }
    const data = options.route?.includes('decompose') ? { sentences: [{ text: 'Hello world.', chunks: [{ surface: 'Hello world.', components: [] }] }] }
      : { passages: [{ sentenceIds: ['s1'], translation: 'こんにちは。' }], chunks: [{ chunkId: 's1c1', meaning: '挨拶' }], components: [] };
    const json = JSON.stringify(data);
    for (let i = 0; i < json.length; i += 15) { options.onChunk?.(json.slice(i, i + 15)); await new Promise(r => setTimeout(r, 120)); }
    return json;
  } } });
await import('../src/index.js');

const { reconcileAnalysisJobs } = await import('../src/import-job-store.js');
let workerBusy = false;
setInterval(() => {
  if (workerBusy) return;
  workerBusy = true;
  void reconcileAnalysisJobs(true).catch(() => console.error('Synthetic import worker failed')).finally(() => { workerBusy = false; });
}, 1000).unref();
