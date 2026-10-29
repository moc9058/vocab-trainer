import { installApiTransport } from '../api/transport';
interface ExtensionBrowser { i18n: { getMessage(key: string): string }; runtime: { sendMessage(message: unknown): Promise<any> } }
declare global { interface Window { browser: ExtensionBrowser } }
export const contextId = new URLSearchParams(location.search).get('context') ?? undefined;
export async function rpc<T = any>(message: Record<string, unknown>): Promise<T> {
  const result = await window.browser.runtime.sendMessage({ ...message, context: contextId });
  if (result?.error) throw new Error(result.error);
  return result;
}
installApiTransport({ pollingOnly: true, async fetch(path, init = {}) {
  init.signal?.throwIfAborted();
  if (init.body !== undefined && typeof init.body !== 'string') throw new Error('JSON transport required');
  const request = rpc<{ status: number; body: string; headers: Record<string, string> }>({ type: 'api', path, method: init.method ?? 'GET', body: init.body });
  const response = init.signal ? await new Promise<Awaited<typeof request>>((resolve, reject) => {
    const abort = () => reject(init.signal!.reason ?? new DOMException('Aborted', 'AbortError'));
    init.signal!.addEventListener('abort', abort, { once: true });
    request.then(resolve, reject).finally(() => init.signal!.removeEventListener('abort', abort));
  }) : await request;
  init.signal?.throwIfAborted();
  return new Response([204, 205, 304].includes(response.status) ? null : response.body, { status: response.status, headers: response.headers });
} });
export interface SelectionContext {
  menu?: boolean; text?: string; source: { sourceLabel?: string; sourceUrl?: string }; request?: string;
  sessionId?: string; ingestionId: string; jobKey: string; expiresAt: number;
}
export async function bindPanel(): Promise<void> {
  if (!contextId || window.top === window) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('Panel binding unavailable')); }, 6000);
    function receive(event: MessageEvent) {
      if (event.source !== window.parent || event.data?.type !== 'vocab-bind' || event.data.context !== contextId) return;
      void rpc({ type: 'bind', bind: event.data.bind }).then(() => {
        clearTimeout(timeout); window.removeEventListener('message', receive); resolve();
      }, reject);
    }
    window.addEventListener('message', receive);
  });
}
