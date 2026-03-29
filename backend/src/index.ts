import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import languagesRoutes from "./routes/languages.js";
import vocabRoutes from "./routes/vocab.js";
import quizRoutes from "./routes/quiz.js";
import progressRoutes from "./routes/progress.js";
import flaggedRoutes from "./routes/flagged.js";
import grammarRoutes from "./routes/grammar.js";
import grammarQuizRoutes from "./routes/grammar-quiz.js";
import grammarProgressRoutes from "./routes/grammar-progress.js";
import translationRoutes from "./routes/translation.js";
import speakingWritingRoutes from "./routes/speaking-writing.js";
import metricsRoutes from "./routes/metrics.js";

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

await fastify.register(cors);
await fastify.register(sensible);

await fastify.register(languagesRoutes, { prefix: "/api/languages" });
await fastify.register(vocabRoutes, { prefix: "/api/vocab" });
await fastify.register(quizRoutes, { prefix: "/api/quiz" });
await fastify.register(progressRoutes, { prefix: "/api/progress" });
await fastify.register(flaggedRoutes, { prefix: "/api/flagged" });
await fastify.register(grammarRoutes, { prefix: "/api/grammar" });
await fastify.register(grammarQuizRoutes, { prefix: "/api/grammar-quiz" });
await fastify.register(grammarProgressRoutes, { prefix: "/api/grammar-progress" });
await fastify.register(translationRoutes, { prefix: "/api/translation" });
await fastify.register(speakingWritingRoutes, { prefix: "/api/speaking-writing" });
await fastify.register(metricsRoutes, { prefix: "/api/metrics" });

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await fastify.listen({ port, host });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
