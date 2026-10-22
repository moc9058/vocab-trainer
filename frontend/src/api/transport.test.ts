import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../platform/native', () => ({ isNative: vi.fn(() => true), NativeAuth: { token: vi.fn(async () => ({ token: 'secure-session' })) } }));
import { NativeAuth, isNative } from '../platform/native';
import { apiFetch, DEFAULT_API_ORIGIN, resolveApiUrl } from './transport';
afterEach(() => vi.unstubAllGlobals());
describe('native API boundary', () => {
  it('keeps Web paths relative and rejects arbitrary URLs or path escapes', () => {
    expect(resolveApiUrl('/api/auth/me', false)).toBe('/api/auth/me');
    expect(resolveApiUrl('/api/auth/me', true)).toBe(DEFAULT_API_ORIGIN + '/api/auth/me');
    for (const path of ['https://evil.invalid/api/x', '//evil.invalid/api/x', '/api/../../outside', '/api/\\evil']) expect(() => resolveApiUrl(path, true)).toThrow();
    expect(() => resolveApiUrl('/api/x', true, 'http://unsafe.invalid')).toThrow();
  });
  it('adds Keychain credentials only to API fetch; keeps the stream and signal intact', async () => {
    const signal = new AbortController().signal;
    const body = new ReadableStream<Uint8Array>(); const response = new Response(body);
    const fetch = vi.fn(async () => response); vi.stubGlobal('fetch', fetch);
    expect((await apiFetch('/api/translation/translate-stream', { method: 'POST', signal })).body).toBe(body);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(DEFAULT_API_ORIGIN)).toBe(true); expect(init.signal).toBe(signal);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secure-session');
    expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error'); expect(fetch).toHaveBeenCalledTimes(1);
    await expect(apiFetch('https://evil.invalid/api/x')).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses Cookie authentication on Web without touching Keychain', async () => {
    vi.mocked(isNative).mockReturnValueOnce(false); vi.mocked(NativeAuth.token).mockClear();
    const fetch = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetch);
    await apiFetch('/api/auth/me'); expect(NativeAuth.token).not.toHaveBeenCalled();
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe('include');
  });
});
