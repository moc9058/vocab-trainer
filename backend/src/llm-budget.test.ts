import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { awaitWithLLMSignal, getLLMRequestSignal, installLLMBudgets, withLLMBudget } from "./llm-budget.js";
import { openSSE } from "./sse.js";

test("a deadline releases callers waiting for uncancellable configuration reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const work = withLLMBudget(100, undefined, async (signal) =>
    awaitWithLLMSignal(new Promise<never>(() => {}), signal),
  );
  const rejected = assert.rejects(work, /time limit/);
  t.mock.timers.tick(100);
  await rejected;
});

test("a shared budget expires across sequential calls and clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withLLMBudget(100, undefined, async (signal) => {
    assert.equal(getLLMRequestSignal(), signal);
    t.mock.timers.tick(60);
    await withLLMBudget(100, signal, async (child) => {
      t.mock.timers.tick(40);
      assert.equal(child.aborted, true);
      assert.throws(() => child.throwIfAborted(), /time limit/);
    });
  });
  let completed!: AbortSignal;
  await withLLMBudget(100, undefined, async (signal) => { completed = signal; });
  t.mock.timers.tick(1000);
  assert.equal(completed.aborted, false);
  assert.equal(getLLMRequestSignal(), undefined);
});

test("concurrent requests have isolated signals, including routes in plugins", async (t) => {
  const app = Fastify();
  installLLMBudgets(app);
  t.after(() => app.close());
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const signals: AbortSignal[] = [];
  await app.register(async (child) => {
    child.post("/work", async () => {
      const signal = getLLMRequestSignal()!;
      signals.push(signal);
      if (signals.length === 2) release();
      await barrier;
      assert.equal(getLLMRequestSignal(), signal);
      return { aborted: signal.aborted };
    });
  }, { prefix: "/api" });
  const responses = await Promise.all([
    app.inject({ method: "POST", url: "/api/work" }),
    app.inject({ method: "POST", url: "/api/work" }),
  ]);
  assert.notEqual(signals[0], signals[1]);
  for (const response of responses) assert.deepEqual(response.json(), { aborted: false });
});

test("article handlers share a ten-minute budget, ordinary handlers three minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = Fastify();
  installLLMBudgets(app);
  t.after(() => app.close());
  await app.register(async (child) => {
    child.post("/analyze-stream", async () => {
      const signal = getLLMRequestSignal()!;
      t.mock.timers.tick(180_000);
      assert.equal(signal.aborted, false);
      t.mock.timers.tick(420_000);
      return { aborted: signal.aborted };
    });
  }, { prefix: "/api/import/chinese" });
  app.post("/normal", async () => {
    const signal = getLLMRequestSignal()!;
    t.mock.timers.tick(180_000);
    return { aborted: signal.aborted };
  });
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/import/chinese/analyze-stream" })).json(), { aborted: true });
  assert.deepEqual((await app.inject({ method: "POST", url: "/normal" })).json(), { aborted: true });
});

test("closing a real SSE connection aborts its LLM signal", async (t) => {
  const app = Fastify();
  installLLMBudgets(app);
  t.after(() => app.close());
  let settled!: () => void;
  const cancelled = new Promise<void>((resolve) => { settled = resolve; });
  app.post("/stream", async (request, reply) => {
    const { sendEvent, close } = openSSE(request, reply);
    const signal = getLLMRequestSignal()!;
    try {
      sendEvent("start", {});
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      assert.match((signal.reason as Error).message, /disconnected/);
    } finally {
      close();
      settled();
    }
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(`${url}/stream`, { method: "POST" }, (res) => {
      res.once("data", () => { res.destroy(); req.destroy(); resolve(); });
    });
    req.on("error", reject);
    req.end();
  });
  await cancelled;
});
