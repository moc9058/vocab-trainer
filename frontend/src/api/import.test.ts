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
