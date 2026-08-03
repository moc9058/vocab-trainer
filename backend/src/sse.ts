import type { FastifyReply, FastifyRequest } from "fastify";

export interface SSEChannel {
  /** Write one `event:`/`data:` frame. Safe after the client disconnects. */
  sendEvent(event: string, data: unknown): void;
  /** Stop the keep-alive timer and end the response. Call from `finally`. */
  close(): void;
}

/**
 * The SSE-over-POST preamble shared by every streaming route
 * (`routes/translation.ts`, `routes/speaking-writing.ts`, `routes/import.ts`).
 *
 * Once this has been called the response is hijacked from Fastify: the handler
 * must not `return reply.*` any more, must send failures as an `error` event,
 * and must `close()` in a `finally`. Validation that can still 4xx normally has
 * to happen BEFORE this call.
 */
export function openSSE(request: FastifyRequest, reply: FastifyReply): SSEChannel {
  // Disable socket timeout for long-running SSE streams
  request.raw.socket.setTimeout(0);

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send periodic keep-alive comments to prevent proxy/infrastructure idle timeouts
  const keepAlive = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(":keep-alive\n\n");
  }, 15_000);

  return {
    sendEvent(event, data) {
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
    close() {
      clearInterval(keepAlive);
      if (!reply.raw.destroyed) {
        reply.raw.end();
      }
    },
  };
}
