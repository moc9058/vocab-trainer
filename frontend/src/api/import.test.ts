import { afterEach, expect, it, vi } from "vitest";
import { analyzeImportStream } from "./import";

afterEach(() => vi.unstubAllGlobals());

function mockStream(events: string) {
  // Split even within UTF-8 and SSE lines, as the network can do.
  const bytes = new TextEncoder().encode(events);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  const fetch = vi.fn().mockResolvedValue(new Response(body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("reassembles article chunks while preserving the accumulated onDelta contract", async () => {
  const fetch = mockStream(
    'event: analysis-start\ndata: {}\n\n' +
    'event: analysis-chunk\ndata: {"chunk":"你好"}\n\n' +
    'event: analysis-chunk\ndata: {"chunk":"世界"}\n\n' +
    'event: done\ndata: {}\n\n',
  );
  const onDelta = vi.fn();
  const onDone = vi.fn();
  const onError = vi.fn();
  await analyzeImportStream("chinese", "article", { onDelta, onDone, onError });
  expect(onDelta.mock.calls).toEqual([["你好"], ["你好世界"]]);
  expect(onDone).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ text: "article", streamFormat: "chunks" });
});

it("accepts the full-text frames from an older backend during deployment", async () => {
  mockStream('event: analysis-delta\ndata: {"text":"a"}\n\nevent: analysis-delta\ndata: {"text":"ab"}\n\nevent: done\ndata: {}\n\n');
  const onDelta = vi.fn();
  await analyzeImportStream("english", "article", { onDelta });
  expect(onDelta.mock.calls).toEqual([["a"], ["ab"]]);
});

it("keeps the server timeout when the stream errors after its terminal event", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: error\ndata: {"message":"LLM processing exceeded its 600s time limit."}\n\n'));
    setTimeout(() => { try { controller.error(new TypeError('Load failed')); } catch {} }, 5);
  } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
  const onError = vi.fn();
  await expect(analyzeImportStream('chinese','test',{onError})).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledOnce();
  expect(onError.mock.calls[0][0].message).toContain('600s');
});

it("waits for async result persistence before completing and does not swallow callback failures", async () => {
  mockStream('event: analysis-result\ndata: {"analysis":{},"existing":{}}\n\nevent: done\ndata: {}\n\n');
  const order: string[] = [];
  await analyzeImportStream('english','test',{onResult:async()=>{await Promise.resolve();order.push('saved');},onDone:()=>{order.push('done');}});
  expect(order).toEqual(['saved','done']);
  mockStream('event: analysis-result\ndata: {"analysis":{}}\n\n');
  await expect(analyzeImportStream('english','test',{onResult:()=>{throw new Error('save failed');}})).rejects.toThrow('save failed');
});

it("reports an interrupted stream without inventing a successful completion", async () => {
  mockStream('event: analysis-start\ndata: {}\n\n');
  await expect(analyzeImportStream('chinese','test',{})).rejects.toThrow('Connection closed unexpectedly');
});
