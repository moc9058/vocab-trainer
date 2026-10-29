import { isNative, NativeAuth } from '../platform/native';
export const DEFAULT_API_ORIGIN = 'https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app';
export function apiOrigin(): string { return import.meta.env.VITE_API_ORIGIN || DEFAULT_API_ORIGIN; }

export function resolveApiUrl(path: string, native = isNative(), origin = apiOrigin()): string {
  // Only application API paths. Do not send Keychain credentials to caller supplied origins.
  if (!path.startsWith('/api/') || path.includes('\\') || /[\r\n]/.test(path)) throw new Error('Invalid API path');
  if (!native) return path;
  const base = new URL(origin);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) throw new Error('Invalid API origin');
  if (base.protocol !== 'https:' && !(import.meta.env.MODE === 'ios-local' && base.protocol === 'http:')) throw new Error('HTTPS API required');
  return url.href;
}

export interface ApiTransport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Extension RPC transfers complete JSON responses, never streams. */
  pollingOnly?: boolean;
}
let adapter: ApiTransport | undefined;
export function installApiTransport(transport: ApiTransport): void { adapter = transport; }
export function apiPollingOnly(): boolean { return adapter?.pollingOnly ?? false; }

/** Native fetch stays unpatched so ReadableStream/AbortSignal work in WKWebView. No automatic POST replay. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (adapter) return adapter.fetch(path, init);
  const native = isNative();
  const url = resolveApiUrl(path, native);
  const headers = new Headers(init.headers);
  if (native) {
    headers.delete('Authorization');
    const { token } = await NativeAuth.token({ apiOrigin: apiOrigin() });
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...init, headers, credentials: native ? 'omit' : 'include', redirect: 'error' });
}
