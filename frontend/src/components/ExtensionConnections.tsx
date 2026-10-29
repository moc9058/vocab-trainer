import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context';
import { fetchJson, postJson } from '../api/client';
export const CONNECTION_RETURN = 'safariConnectionReturn';
/** Persist only a short-lived approval request ID across Google's root redirect. */
export function rememberExtensionApproval() {
  const url = new URL(location.href);
  if (url.pathname !== '/extension/connect') return;
  const id = url.searchParams.get('id');
  if (id && /^[A-Za-z0-9_-]{43}$/.test(id)) {
    try { sessionStorage.setItem(CONNECTION_RETURN, JSON.stringify({ id, expiresAt: Date.now() + 600000 })); } catch { /* Login can continue; reopen the approval URL after sign-in. */ }
  }
}
export default function ExtensionConnections() {
  const { t } = useI18n();
  const id = new URLSearchParams(location.search).get('id');
  const [request, setRequest] = useState<{ code: string; expiresAt: number; approved: boolean }>();
  const [connections, setConnections] = useState<{ id: string; expiresAt: number; createdAt: number }[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  function refresh() { void fetchJson<{ connections: typeof connections }>('/api/auth/extension/connections').then(r => setConnections(r.connections)).catch(e => setError(String(e))); }
  useEffect(() => {
    refresh();
    sessionStorage.removeItem(CONNECTION_RETURN);
    if (id && /^[A-Za-z0-9_-]{43}$/.test(id)) void fetchJson<typeof request>(`/api/auth/extension/request/${id}`).then(setRequest).catch(e => setError(String(e)));
  }, [id]);
  const button = 'min-h-11 rounded-lg border border-gray-600 px-4 py-2 disabled:opacity-40';
  return <main className="min-h-screen space-y-5 bg-gray-900 p-5 text-gray-200">
    <h1 className="text-xl font-bold">{t('safariConnections')}</h1><p>{t('safariConnectHelp')}</p>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {request && <section className="space-y-3 rounded border border-gray-700 p-4"><p>{t('safariCode')}: <strong className="font-mono">{request.code}</strong></p>
      <p>{t('safariCompareCode')}</p>
      <button className={button} disabled={busy || request.approved || request.expiresAt <= Date.now()} onClick={() => {
        setBusy(true); void postJson('/api/auth/extension/approve', { id, code: request.code }).then(() => setRequest({ ...request, approved: true })).catch(e => setError(String(e))).finally(() => setBusy(false));
      }}>{t(request.approved ? 'safariApproved' : 'safariConnect')}</button>
    </section>}
    <p>{t('safariLogoutNotice')}</p>
    <ul className="space-y-3">{connections.map(c => <li key={c.id} className="flex flex-wrap items-center gap-3"><time>{new Date(c.createdAt).toLocaleString()} → {new Date(c.expiresAt).toLocaleDateString()}</time>
      <button className={button} disabled={busy} onClick={() => {
        setBusy(true); void postJson('/api/auth/extension/connections/revoke', { id: c.id }).then(refresh).catch(e => setError(String(e))).finally(() => setBusy(false));
      }}>{t('safariDisconnect')}</button></li>)}</ul>
    <a className="block underline" href="/">{t('back')}</a>
  </main>;
}
