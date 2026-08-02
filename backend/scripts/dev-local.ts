/**
 * dev-local: start the API server against the local Firestore EMULATOR.
 *
 * Usage:
 *   docker compose up -d firestore
 *   cd backend && npm run dev:local        (tsx watch — reloads on src/** changes)
 *
 * A wrapper script rather than inline env in package.json because inline
 * `VAR=x cmd` does not work on Windows (deploy.ps1 exists, so Windows is used).
 * Setting the variables here, before src/index.ts is imported, routes all three
 * Firestore clients (firestore.ts / auth-config.ts / llm.ts) to the emulator —
 * production is never touched. `npm run dev` remains the against-production
 * variant for deliberate debugging.
 */
process.env.FIRESTORE_EMULATOR_HOST ||= "localhost:8080";
// The emulator namespaces data by project id — must match what seed-load wrote.
process.env.FIRESTORE_PROJECT ||= "vocab-trainer-490014";

const host = process.env.FIRESTORE_EMULATOR_HOST;
try {
  await fetch(`http://${host}/`);
} catch {
  // Without this preflight, auth-config.ts would exit(1) with a misleading
  // ADC/production hint when the emulator is simply not running.
  console.error(`[dev:local] Firestore emulator is not reachable at ${host}.`);
  console.error("[dev:local] Start it with: docker compose up -d firestore");
  process.exit(1);
}

console.log(`[dev:local] Firestore emulator at ${host} — production Firestore is NOT touched.`);
await import("../src/index.js");
