/**
 * Default GCP project for the one-off scripts, published to the environment.
 *
 * MUST be imported BEFORE any `../src/*` module: `src/firestore.ts` builds its
 * Firestore client at module load, and a client built without a project resolves
 * to whatever gcloud is pointed at — which has no `vocab-database`, so every read
 * and write fails with a bare `5 NOT_FOUND`. Setting the variable from the script
 * body is too late; ES imports are evaluated first.
 *
 * The default matches deploy.sh. Override with FIRESTORE_PROJECT.
 */
if (!process.env.FIRESTORE_PROJECT) process.env.FIRESTORE_PROJECT = "vocab-trainer-490014";

export const PROJECT_ID = process.env.FIRESTORE_PROJECT;
export const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "vocab-database";
