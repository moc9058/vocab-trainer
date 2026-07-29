/**
 * Every request carries cookies so the backend's session cookie is sent.
 * The SPA is same-origin with /api (vite proxy in dev, nginx in prod), so this is
 * belt-and-braces today — but it is what keeps the app working if the API is ever
 * served from a different origin.
 */
const CREDENTIALS: RequestCredentials = "include";

/**
 * A 401 means the session went away mid-use. Announce it once, centrally, so
 * AuthProvider can show the login screen — otherwise callers that swallow errors
 * (most of them) would just render an empty list.
 */
function notifyIfUnauthorized(res: Response): void {
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("auth:expired"));
  }
}

async function errorFromResponse(res: Response): Promise<Error> {
  notifyIfUnauthorized(res);
  const body = await res.text().catch(() => "");
  return new Error(`API error: ${res.status}${body ? ` – ${body}` : ` ${res.statusText}`}`);
}

/** Exported so the streaming call sites, which bypass these helpers, share the behaviour. */
export { CREDENTIALS, notifyIfUnauthorized };

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: CREDENTIALS });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: CREDENTIALS,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    credentials: CREDENTIALS,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}

export async function deleteRequest(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE", credentials: CREDENTIALS });
  if (!res.ok) throw await errorFromResponse(res);
}

/** DELETE that returns a parsed body (most DELETE endpoints return nothing — use `deleteRequest`). */
export async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE", credentials: CREDENTIALS });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}
