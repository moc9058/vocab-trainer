import { Firestore } from "@google-cloud/firestore";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same root .env as llm.ts — env wins over Firestore, so a local run can override.
config({ path: resolve(__dirname, "../../.env") });

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Every redirect URI registered for this OAuth client; `[0]` is canonical.
   * Cloud Run serves this app on two hostnames, and the `vt_oauth_tx` cookie is
   * origin-scoped — so the flow has to come back to the SAME host it started on,
   * or the state check fails. One entry per host the app is reachable at.
   */
  redirectUris: string[];
  sessionSecret: string;
  allowedEmails: string[];
}

/** Cookies may only carry the Secure flag over https, which local dev is not. */
export function isSecureUri(uri: string): boolean {
  return uri.startsWith("https://");
}

export interface SessionUser {
  email: string;
  name?: string;
  picture?: string;
}

const REQUIRED_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OAUTH_REDIRECT_URI",
  "SESSION_SECRET",
  "ALLOWED_EMAILS",
] as const;

export const SESSION_COOKIE = "vt_session";
export const OAUTH_TX_COOKIE = "vt_oauth_tx";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

let authConfig: AuthConfig | null = null;

function fatal(message: string): never {
  console.error(`[auth] FATAL: ${message}`);
  console.error(
    "[auth] Refusing to start rather than serving the API unauthenticated. " +
      "Fix config/auth (backend/scripts/migrate-auth-config-to-firestore.ts) or unset GOOGLE_CLIENT_ID to run without auth.",
  );
  process.exit(1);
}

function build(source: Record<string, string | undefined>, origin: string): AuthConfig {
  const missing = REQUIRED_KEYS.filter((k) => !source[k]);
  if (missing.length > 0) {
    fatal(`${origin} is missing: ${missing.join(", ")}`);
  }

  const allowedEmails = source
    .ALLOWED_EMAILS!.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowedEmails.length === 0) {
    fatal(`${origin} has an empty ALLOWED_EMAILS — nobody could ever sign in.`);
  }

  // Comma-separated so a single stored value still parses as a one-element list.
  const redirectUris = source
    .OAUTH_REDIRECT_URI!.split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (redirectUris.length === 0) {
    fatal(`${origin} has an empty OAUTH_REDIRECT_URI.`);
  }

  return {
    clientId: source.GOOGLE_CLIENT_ID!,
    clientSecret: source.GOOGLE_CLIENT_SECRET!,
    redirectUris,
    sessionSecret: source.SESSION_SECRET!,
    allowedEmails,
  };
}

/**
 * Resolve auth config once, at boot — the request hook has to know the posture
 * before the first request is served, which is why this is eager where
 * `llm.ts:loadLLMConfig` is lazy.
 *
 * Three outcomes, and the distinction matters:
 *   - env has everything            -> auth on, Firestore untouched
 *   - config/auth does not exist    -> auth OFF (definitive answer: never configured)
 *   - Firestore read failed         -> fatal (indeterminate; guessing "off" here
 *                                      would reopen the public API on a transient blip)
 */
export async function loadAuthConfig(): Promise<AuthConfig | null> {
  if (REQUIRED_KEYS.every((k) => process.env[k])) {
    authConfig = build(process.env, "environment");
    console.log(`[auth] enabled from environment (${authConfig.allowedEmails.length} allowed email(s))`);
    return authConfig;
  }

  let doc;
  try {
    const db = new Firestore({
      projectId: process.env.FIRESTORE_PROJECT || undefined,
      databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
      ignoreUndefinedProperties: true,
    });
    doc = await db.collection("config").doc("auth").get();
  } catch (err) {
    console.error("[auth] could not read config/auth from Firestore:", err);
    // Locally this is nearly always ADC pointing at the wrong project: without
    // FIRESTORE_PROJECT the client resolves whatever gcloud is set to, which has
    // no vocab-database, and the read fails with a bare `5 NOT_FOUND`.
    console.error(
      "[auth] If running locally, set FIRESTORE_PROJECT=vocab-trainer-490014 and check `gcloud auth application-default login`.",
    );
    fatal("Firestore read failed, so whether auth is configured is unknown.");
  }

  if (!doc.exists) {
    console.warn(
      "[auth] ******************************************************************\n" +
        "[auth] * NO AUTH CONFIG (config/auth does not exist) — API IS PUBLIC.   *\n" +
        "[auth] * Anyone with the URL can read and write the vocabulary database.*\n" +
        "[auth] * Run: npx tsx scripts/migrate-auth-config-to-firestore.ts       *\n" +
        "[auth] ******************************************************************",
    );
    authConfig = null;
    return null;
  }

  authConfig = build(doc.data() as Record<string, string | undefined>, "Firestore config/auth");
  console.log(`[auth] enabled from Firestore config/auth (${authConfig.allowedEmails.length} allowed email(s))`);
  return authConfig;
}

export function getAuthConfig(): AuthConfig | null {
  return authConfig;
}

export function isAuthEnabled(): boolean {
  return authConfig !== null;
}

export function isEmailAllowed(email: string): boolean {
  if (!authConfig) return true;
  return authConfig.allowedEmails.includes(email.trim().toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Stateless session token                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Sessions are a signed, self-contained cookie rather than server state: Cloud Run
 * can scale past the one warm instance, and an in-memory store would drop sessions
 * the moment it did.
 */
interface SessionPayload extends SessionUser {
  exp: number;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signSession(user: SessionUser, secret: string): string {
  const payload: SessionPayload = {
    ...user,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

export function verifySession(token: string | undefined, secret: string): SessionUser | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(secret, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (!payload.email || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { email: payload.email, name: payload.name, picture: payload.picture };
  } catch {
    return null;
  }
}

/** Short-lived state+PKCE envelope, signed with the same secret and format. */
export interface OAuthTransaction {
  state: string;
  verifier: string;
  /**
   * Carried through the flow because the token exchange MUST replay the exact
   * redirect_uri the authorization request used — Google rejects a mismatch.
   */
  redirectUri: string;
  exp: number;
}

export function signTransaction(
  secret: string,
  redirectUri: string,
): { token: string; tx: OAuthTransaction } {
  const tx: OAuthTransaction = {
    state: randomBytes(16).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    redirectUri,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const body = b64url(JSON.stringify(tx));
  return { token: `${body}.${hmac(secret, body)}`, tx };
}

export function verifyTransaction(
  token: string | undefined,
  secret: string,
): OAuthTransaction | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(secret, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const tx = JSON.parse(Buffer.from(body, "base64url").toString()) as OAuthTransaction;
    if (!tx.state || !tx.verifier || !tx.redirectUri) return null;
    if (tx.exp < Math.floor(Date.now() / 1000)) return null;
    return tx;
  } catch {
    return null;
  }
}
