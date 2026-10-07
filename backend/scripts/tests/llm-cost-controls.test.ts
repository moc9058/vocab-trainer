import assert from "node:assert/strict";
import { test, mock } from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { installLLMBudgets, withLLMBudget } from "../../src/llm-budget.js";

// No credentials, real LLM calls or cloud database access.
mock.module("dotenv", { namedExports: { config: () => ({}) } });
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_MODEL_MINI = "test-model";
process.env.OPENAI_MODEL_FULL = "test-model";
let clientOptions: Record<string, unknown>;
let complete: (body: any, options: { signal: AbortSignal }) => Promise<any>;
mock.module("openai", { defaultExport: class {
  constructor(options: Record<string, unknown>) { clientOptions = options; }
  chat = { completions: { create: (body: any, options: { signal: AbortSignal }) => complete(body, options) } };
} });
mock.module("../../src/firestore.js", { namedExports: {
  getLLMModelConfig: async () => null,
  ensureModelInCostConfig: async () => {},
  logTokenUsage: async () => {},
  languageExists: async () => true,
  getImportConfig: async () => ({ analyzeSchema: {}, analyzePrompts: { chinese: "test" } }),
  getAllGrammarItems: async () => [],
  lookupWordsByTerms: async () => [],
  saveImportSession: async () => {},
  getImportSessions: async () => [],
  getImportSession: async () => null,
  updateImportSession: async () => {},
  deleteImportSession: async () => {},
} });
const { callLLM } = await import("../../src/llm.js");
const { default: importRoutes } = await import("../../src/routes/import.js");
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const opts = { system: "test", user: "test", route: "translation/translate" };

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("nonstreaming calls carry cancellation and configure bounded retries", async () => {
  complete = async (_body, { signal }) => {
    assert.equal(signal.aborted, false);
    return { choices: [{ message: { content: "result" } }] };
  };
  assert.equal(await callLLM(opts), "result");
  assert.equal(clientOptions!.maxRetries, 2);
  assert.equal(clientOptions!.timeout, 120_000);
});

test("the total deadline aborts even before stream headers arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  complete = async (_body, { signal }) => untilAborted(signal);
  const work = callLLM({ ...opts, onChunk: () => {} });
  const rejected = assert.rejects(work, /180s time limit/);
  await nextTurn();
  t.mock.timers.tick(180_000);
  await rejected;
});

test("sequential model calls use the remaining request budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let count = 0;
  complete = async (_body, { signal }) => {
    if (++count === 1) {
      t.mock.timers.tick(120_000);
      return { choices: [{ message: { content: "first" } }] };
    }
    return untilAborted(signal);
  };
  const work = withLLMBudget(180_000, undefined, async () => {
    await callLLM(opts);
    return callLLM(opts);
  });
  const rejected = assert.rejects(work, /180s time limit/);
  await nextTurn();
  t.mock.timers.tick(60_000);
  await rejected;
  assert.equal(count, 2);
});

test("a stalled stream fails instead of returning partial data for persistence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  complete = async (_body, { signal }) => ({
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: '{"partial":' } }] };
      await untilAborted(signal);
    },
  });
  const work = callLLM({ ...opts, onChunk: () => {} });
  const rejected = assert.rejects(work, /stalled for 30s/);
  await nextTurn();
  t.mock.timers.tick(30_000);
  await rejected;
});

test("article routes negotiate chunks and preserve cached clients", async (t) => {
  const chunks = ['{"paragraphs":[', '{"sentences":[{"text":"你好。","words":[]}]}],"grammar":[]}'];
  complete = async () => ({
    async *[Symbol.asyncIterator]() {
      for (const content of chunks) yield { choices: [{ delta: { content } }] };
    },
  });
  const app = Fastify();
  installLLMBudgets(app);
  // light-my-request's injected socket has no timeout method; real sockets do.
  app.addHook("onRequest", async (request) => {
    request.raw.socket.setTimeout = () => request.raw.socket;
  });
  await app.register(sensible);
  await app.register(importRoutes, { prefix: "/api/import" });
  t.after(() => app.close());
  for (const chunkMode of [true, false]) {
    const response = await app.inject({
      method: "POST", url: "/api/import/chinese/analyze-stream",
      payload: { text: "你好。", ...(chunkMode ? { streamFormat: "chunks" } : {}) },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /event: done/);
    assert.doesNotMatch(response.body, /event: error/);
    assert.match(response.body, chunkMode ? /event: analysis-chunk/ : /event: analysis-delta/);
    assert.doesNotMatch(response.body, chunkMode ? /event: analysis-delta/ : /event: analysis-chunk/);
  }
});
