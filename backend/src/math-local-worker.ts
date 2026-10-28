if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Local math worker requires FIRESTORE_EMULATOR_HOST");
const { reconcileMathJobs } = await import("./math-jobs.js");
while (true) {
  try {
    await reconcileMathJobs(true);
  } catch (error) {
    console.error(
      "Local math worker failed:",
      error instanceof Error ? error.message : "unknown",
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
