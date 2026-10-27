/** UI entry policy only. Keep APIs and saved learning data available for sync.
 * Remove the English entry when the revised English version is ready. */
const pausedStudyLanguages = new Set(["english"]);

export function isStudyLanguagePaused(language: string): boolean {
  const key = language.toLowerCase().replace(/\.json$/, "");
  return pausedStudyLanguages.has(key === "en" ? "english" : key);
}
