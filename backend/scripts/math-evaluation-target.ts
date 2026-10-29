// Evaluate against the same explicit defaults as math:sync, before firestore.ts
// initializes its shared client. Never inherit the active gcloud project silently.
process.env.FIRESTORE_PROJECT ||= "vocab-trainer-490014";
process.env.FIRESTORE_DATABASE_ID ||= "vocab-database";
