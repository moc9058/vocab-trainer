/**
 * Migration script: uploads Google OAuth config to Firestore.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-auth-config-to-firestore.ts
 *   cd backend && npx tsx scripts/migrate-auth-config-to-firestore.ts --client-id=... --client-secret=...
 *
 * Credentials are resolved in this order:
 *   1. --client-id= / --client-secret= flags
 *   2. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from ../.env or the environment
 *   3. an interactive prompt (only when attached to a terminal)
 *
 * Anything entered at the prompt is written back to ../.env so later runs and
 * `npm run dev` pick it up without asking again. Mirrors
 * migrate-llm-config-to-firestore.ts, which reads config/llm the same way.
 *
 * Only the client ID and secret are required; the rest have working defaults.
 * SESSION_SECRET is generated on first run and preserved afterwards, because
 * regenerating it would sign every existing session out.
 */

import "./_project-env.js";
import { Firestore } from "@google-cloud/firestore";
import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../../.env");

config({ path: ENV_PATH });

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

/**
 * Both Cloud Run hostnames, plus local dev. Stored comma-separated: the flow picks
 * whichever matches the host the browser used, because the OAuth state cookie is
 * origin-scoped and would be lost on a cross-host return.
 */
const DEFAULT_REDIRECT_URIS = [
  "https://vocab-trainer-frontend-olncevthqa-an.a.run.app/api/auth/callback",
  "https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app/api/auth/callback",
  "http://localhost:5173/api/auth/callback",
].join(",");
const DEFAULT_REDIRECT_URI = DEFAULT_REDIRECT_URIS.split(",")[0];
const DEFAULT_ALLOWED_EMAILS = "moc9058@gmail.com";

function argValue(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3).trim() || undefined;
}

/** Ask on the terminal. `mask` suppresses echo so a pasted secret is not left on screen. */
function ask(question: string, mask = false): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (mask) {
      // readline has no built-in silent mode; overriding the writer is the
      // standard workaround. Echo the prompt itself, swallow the keystrokes.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (mask) process.stdout.write("\n");
      res(answer.trim());
    });
  });
}

/** Upsert KEY=value into .env, preserving every other line and any trailing comment-free layout. */
function saveToEnv(values: Record<string, string>): void {
  let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(values)) {
    const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  // Keep exactly one trailing newline.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

function printSetupHelp(): void {
  console.error("Create an OAuth 2.0 Client ID (Web application) at:");
  console.error("  https://console.cloud.google.com/apis/credentials?project=vocab-trainer-490014");
  console.error("with these Authorized redirect URIs:");
  console.error(`  ${DEFAULT_REDIRECT_URI}`);
  console.error(
    "  https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app/api/auth/callback",
  );
  console.error("  http://localhost:5173/api/auth/callback");
}

async function main() {
  let clientId = argValue("client-id") || process.env.GOOGLE_CLIENT_ID;
  let clientSecret = argValue("client-secret") || process.env.GOOGLE_CLIENT_SECRET;
  const needsPrompt = !clientId || !clientSecret;

  if (needsPrompt) {
    if (!process.stdin.isTTY) {
      // Non-interactive (CI, piped input): fail with instructions rather than hang.
      console.error("Missing GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET, and no terminal to ask on.");
      console.error("");
      printSetupHelp();
      console.error("");
      console.error("Then either put them in .env, or pass them directly:");
      console.error("  npx tsx scripts/migrate-auth-config-to-firestore.ts --client-id=... --client-secret=...");
      process.exit(1);
    }

    console.log("Google OAuth credentials needed.");
    printSetupHelp();
    console.log("");
    if (!clientId) clientId = await ask("Client ID: ");
    if (!clientSecret) clientSecret = await ask("Client secret (hidden): ", true);
    console.log("");

    if (!clientId || !clientSecret) {
      console.error("Both a client ID and a client secret are required.");
      process.exit(1);
    }
  }

  const ref = db.collection("config").doc("auth");
  const existing = (await ref.get()).data() ?? {};

  // Reuse in priority order: explicit env > what is already stored > freshly generated.
  const sessionSecret =
    process.env.SESSION_SECRET ||
    (existing.SESSION_SECRET as string) ||
    randomBytes(32).toString("base64url");
  const generated = !process.env.SESSION_SECRET && !existing.SESSION_SECRET;

  const data = {
    GOOGLE_CLIENT_ID: clientId!,
    GOOGLE_CLIENT_SECRET: clientSecret!,
    OAUTH_REDIRECT_URI: process.env.OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URIS,
    SESSION_SECRET: sessionSecret,
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS || DEFAULT_ALLOWED_EMAILS,
  };

  console.log("Writing auth config to Firestore config/auth...");
  await ref.set(data);

  if (needsPrompt) {
    saveToEnv({ GOOGLE_CLIENT_ID: clientId!, GOOGLE_CLIENT_SECRET: clientSecret! });
    console.log(`Saved credentials to ${ENV_PATH} (gitignored) so this won't ask again.`);
  }

  console.log("Done.");
  console.log(`  redirect URI   : ${data.OAUTH_REDIRECT_URI}`);
  console.log(`  allowed emails : ${data.ALLOWED_EMAILS}`);
  console.log(`  session secret : ${generated ? "generated (new)" : "preserved"}`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
