import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import {
  getAuthConfig,
  isSecureUri,
  isEmailAllowed,
  signSession,
  verifySession,
  signTransaction,
  verifyTransaction,
  SESSION_COOKIE,
  OAUTH_TX_COOKIE,
  SESSION_MAX_AGE_SEC,
  type SessionUser,
  type AuthConfig,
} from "../auth-config.js";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

interface GoogleIdTokenClaims {
  aud?: string;
  iss?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/**
 * Google's docs allow skipping JWKS signature verification for an ID token
 * received directly from the token endpoint over TLS — which is this code path,
 * a server-to-server POST. The claims below are still checked, because the
 * transport only proves who sent the token, not who it was minted for.
 */
function decodeIdToken(idToken: string): GoogleIdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as GoogleIdTokenClaims;
  } catch {
    return null;
  }
}

function claimsToUser(claims: GoogleIdTokenClaims, clientId: string): SessionUser | null {
  if (claims.aud !== clientId) return null;
  if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) return null;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
  // Google serialises this as a real boolean on the ID token, but as the string
  // "true" on the userinfo endpoint — accept both rather than silently rejecting.
  if (claims.email_verified !== true && claims.email_verified !== "true") return null;
  if (!claims.email) return null;
  return { email: claims.email, name: claims.name, picture: claims.picture };
}

/**
 * Pick the redirect URI belonging to the host the browser actually used.
 *
 * Cloud Run answers on two hostnames for one service. The `vt_oauth_tx` cookie is
 * origin-scoped, so starting on one host and being returned to the other loses the
 * cookie and fails the state check. nginx rewrites `Host` to the upstream, so the
 * public host only survives in `X-Forwarded-Host` (which nginx.conf.template sets).
 * Unknown or absent host falls back to the canonical entry.
 */
function resolveRedirectUri(request: FastifyRequest, cfg: AuthConfig): string {
  const forwarded = request.headers["x-forwarded-host"];
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  if (host) {
    const match = cfg.redirectUris.find((uri) => {
      try {
        return new URL(uri).host === host;
      } catch {
        return false;
      }
    });
    if (match) return match;
  }
  return cfg.redirectUris[0];
}

/** Where to send the browser after the flow — the SPA origin of the URI in play. */
function appRootFor(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin + "/";
  } catch {
    return "/";
  }
}

const authRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get("/me", async (request) => {
    const cfg = getAuthConfig();
    if (!cfg) return { authEnabled: false, authenticated: true, user: null };

    const user = verifySession(request.cookies[SESSION_COOKIE], cfg.sessionSecret);
    if (!user || !isEmailAllowed(user.email)) {
      return { authEnabled: true, authenticated: false, user: null };
    }
    return { authEnabled: true, authenticated: true, user };
  });

  fastify.get("/login", async (request, reply) => {
    const cfg = getAuthConfig();
    if (!cfg) return reply.redirect("/");

    const redirectUri = resolveRedirectUri(request, cfg);
    const { token, tx } = signTransaction(cfg.sessionSecret, redirectUri);
    reply.setCookie(OAUTH_TX_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: isSecureUri(redirectUri),
      sameSite: "lax",
      maxAge: 600,
    });

    const challenge = createHash("sha256").update(tx.verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: tx.state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "online",
      prompt: "select_account",
    });
    return reply.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params}`);
  });

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/callback",
    async (request, reply) => {
      const cfg = getAuthConfig();
      if (!cfg) return reply.redirect("/");

      // Before the transaction is verified, the best guess at "where the user came
      // from" is the forwarded host; afterwards the tx's own URI is authoritative.
      let appRoot = appRootFor(resolveRedirectUri(request, cfg));
      const fail = (reason: string) => {
        reply.clearCookie(OAUTH_TX_COOKIE, { path: "/" });
        return reply.redirect(`${appRoot}?auth_error=${encodeURIComponent(reason)}`);
      };

      const { code, state, error } = request.query;
      if (error) {
        fastify.log.warn({ error }, "[auth] Google returned an error");
        return fail(error);
      }
      if (!code || !state) return fail("invalid_request");

      const tx = verifyTransaction(request.cookies[OAUTH_TX_COOKIE], cfg.sessionSecret);
      if (!tx || tx.state !== state) {
        fastify.log.warn(
          { forwardedHost: request.headers["x-forwarded-host"], hadCookie: Boolean(request.cookies[OAUTH_TX_COOKIE]) },
          "[auth] state mismatch or expired login transaction",
        );
        return fail("state_mismatch");
      }
      appRoot = appRootFor(tx.redirectUri);

      let idToken: string | undefined;
      try {
        const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            // Must be byte-identical to the authorization request's value.
            redirect_uri: tx.redirectUri,
            grant_type: "authorization_code",
            code_verifier: tx.verifier,
          }),
        });
        if (!res.ok) {
          fastify.log.error(
            { status: res.status, body: await res.text().catch(() => "") },
            "[auth] token exchange failed",
          );
          return fail("token_exchange_failed");
        }
        idToken = ((await res.json()) as { id_token?: string }).id_token;
      } catch (err) {
        fastify.log.error(err, "[auth] token exchange threw");
        return fail("token_exchange_failed");
      }

      const claims = idToken ? decodeIdToken(idToken) : null;
      const user = claims ? claimsToUser(claims, cfg.clientId) : null;
      if (!user) {
        fastify.log.error("[auth] ID token missing or failed claim validation");
        return fail("invalid_token");
      }

      if (!isEmailAllowed(user.email)) {
        fastify.log.warn({ email: user.email }, "[auth] sign-in refused: not on the allowlist");
        return fail("forbidden");
      }

      reply.clearCookie(OAUTH_TX_COOKIE, { path: "/" });
      reply.setCookie(SESSION_COOKIE, signSession(user, cfg.sessionSecret), {
        path: "/",
        httpOnly: true,
        secure: isSecureUri(tx.redirectUri),
        // Lax, not Strict: the cookie has to survive the top-level redirect back
        // from accounts.google.com, which Strict would drop.
        sameSite: "lax",
        maxAge: SESSION_MAX_AGE_SEC,
      });
      fastify.log.info({ email: user.email }, "[auth] signed in");
      return reply.redirect(appRoot);
    },
  );

  fastify.post("/logout", async (request, reply) => {
    const cfg = getAuthConfig();
    reply.clearCookie(SESSION_COOKIE, {
      path: "/",
      httpOnly: true,
      secure: cfg ? isSecureUri(resolveRedirectUri(request, cfg)) : false,
      sameSite: "lax",
    });
    return { ok: true };
  });
};

export default authRoutes;
