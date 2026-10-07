import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";

export const LLM_BUDGET_MS = 180_000;
export const IMPORT_LLM_BUDGET_MS = 600_000;
export const LLM_ATTEMPT_TIMEOUT_MS = 120_000;

const context = new AsyncLocalStorage<AbortSignal>();

export function getLLMRequestSignal(): AbortSignal | undefined {
  return context.getStore();
}

/** Configuration reads cannot be cancelled, but an LLM caller need not wait for them. */
export async function awaitWithLLMSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Share a wall-clock deadline across sequential calls, parallel calls and retries. */
export async function withLLMBudget<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(
    new Error(`LLM processing exceeded its ${timeoutMs / 1000}s time limit.`),
  ), timeoutMs);
  timer.unref();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    return await context.run(signal, () => work(signal));
  } finally {
    clearTimeout(timer);
  }
}

/** Only LLM work observes cancellation; ordinary database writes finish normally. */
export function installLLMBudgets(fastify: FastifyInstance): void {
  fastify.addHook("onRoute", (route) => {
    const handler = route.handler;
    const timeoutMs = /^\/api\/import\/[^/]+\/analyze-stream$/.test(route.url)
      ? IMPORT_LLM_BUDGET_MS : LLM_BUDGET_MS;
    route.handler = async function (request, reply) {
      const disconnected = new AbortController();
      const onDisconnect = () => {
        if (!reply.raw.writableFinished) {
          disconnected.abort(new Error("Client disconnected."));
        }
      };
      request.raw.once("aborted", onDisconnect);
      reply.raw.once("close", onDisconnect);
      if (request.raw.aborted || reply.raw.destroyed) onDisconnect();
      try {
        return await withLLMBudget(timeoutMs, disconnected.signal, async () =>
          handler.call(this, request, reply),
        );
      } finally {
        request.raw.off("aborted", onDisconnect);
        reply.raw.off("close", onDisconnect);
      }
    };
  });
}
