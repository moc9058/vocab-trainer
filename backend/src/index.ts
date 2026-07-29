import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  loadAuthConfig,
  getAuthConfig,
  isEmailAllowed,
  verifySession,
  SESSION_COOKIE,
} from "./auth-config.js";
import authRoutes from "./routes/auth.js";
import languagesRoutes from "./routes/languages.js";
import vocabRoutes from "./routes/vocab.js";
import quizRoutes from "./routes/quiz.js";
import progressRoutes from "./routes/progress.js";
import flaggedRoutes from "./routes/flagged.js";
import grammarRoutes from "./routes/grammar.js";
import grammarQuizRoutes from "./routes/grammar-quiz.js";
import combinedQuizRoutes, { groupBQuizRoutes } from "./routes/combined-quiz.js";
import grammarProgressRoutes from "./routes/grammar-progress.js";
import translationRoutes from "./routes/translation.js";
import speakingWritingRoutes from "./routes/speaking-writing.js";
import expressionRoutes from "./routes/expressions.js";
import expressionQuizRoutes from "./routes/expression-quiz.js";
import metricsRoutes from "./routes/metrics.js";
import importRoutes from "./routes/import.js";

const LOG_DIR = resolve(import.meta.dirname, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/:/g, "-");
const logFile = join(LOG_DIR, `app-${timestamp}.log`);

const fastify = Fastify({
  logger: {
    transport: {
      targets: [
        { target: "pino/file", level: "info", options: { destination: 1 } },
        { target: "pino/file", level: "info", options: { destination: logFile } },
      ],
    },
  },
});

// Eager, before anything is served: the auth hook below has to know the posture
// up front, and a misconfiguration must stop the boot rather than quietly serving
// the API unauthenticated. See auth-config.ts for the three outcomes.
await loadAuthConfig();

// The browser only ever talks to the frontend origin (nginx reverse-proxies /api/),
// so this allowlist costs nothing and closes the "any website can call the API
// cross-origin" hole left by the previous bare `register(cors)`.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://vocab-trainer-frontend-olncevthqa-an.a.run.app",
  "https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app",
];
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ??
    DEFAULT_ALLOWED_ORIGINS),
);

await fastify.register(cors, {
  // No Origin header means it is not a CORS request at all (same-origin, curl,
  // server-to-server) — those are gated by the auth hook, not by CORS.
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
  credentials: true,
});
// Registered before the auth hook so request.cookies is populated by the time it runs.
await fastify.register(cookie);
await fastify.register(sensible);

const PUBLIC_PATH_PREFIXES = ["/api/auth/"];

fastify.addHook("onRequest", async (request, reply) => {
  const cfg = getAuthConfig();
  if (!cfg) return;

  const path = request.url.split("?")[0];
  if (PUBLIC_PATH_PREFIXES.some((p) => path.startsWith(p))) return;

  const user = verifySession(request.cookies[SESSION_COOKIE], cfg.sessionSecret);
  // The allowlist is re-checked on every request, not just at sign-in, so removing
  // an address from config/auth revokes existing sessions immediately.
  if (!user || !isEmailAllowed(user.email)) {
    return reply.code(401).send({ error: "Unauthorized", message: "Sign in required." });
  }
});

await fastify.register(authRoutes, { prefix: "/api/auth" });
await fastify.register(languagesRoutes, { prefix: "/api/languages" });
await fastify.register(vocabRoutes, { prefix: "/api/vocab" });
await fastify.register(quizRoutes, { prefix: "/api/quiz" });
await fastify.register(progressRoutes, { prefix: "/api/progress" });
await fastify.register(flaggedRoutes, { prefix: "/api/flagged" });
await fastify.register(grammarRoutes, { prefix: "/api/grammar" });
await fastify.register(grammarQuizRoutes, { prefix: "/api/grammar-quiz" });
await fastify.register(combinedQuizRoutes, { prefix: "/api/combined-quiz" });
await fastify.register(groupBQuizRoutes, { prefix: "/api/group-b-quiz" });
await fastify.register(grammarProgressRoutes, { prefix: "/api/grammar-progress" });
await fastify.register(translationRoutes, { prefix: "/api/translation" });
await fastify.register(speakingWritingRoutes, { prefix: "/api/speaking-writing" });
await fastify.register(expressionRoutes, { prefix: "/api/expressions" });
await fastify.register(expressionQuizRoutes, { prefix: "/api/expression-quiz" });
await fastify.register(metricsRoutes, { prefix: "/api/metrics" });
await fastify.register(importRoutes, { prefix: "/api/import" });

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await fastify.listen({ port, host });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
