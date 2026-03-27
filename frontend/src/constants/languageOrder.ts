export const LANGUAGE_ORDER = ["en", "ja", "ko", "zh"] as const;

const fullNameMap: Record<string, string> = {
  english: "en",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
};

export function sortByLanguageOrder<T>(items: T[], getKey: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const keyA = getKey(a).toLowerCase();
    const keyB = getKey(b).toLowerCase();
    const codeA = fullNameMap[keyA] ?? keyA;
    const codeB = fullNameMap[keyB] ?? keyB;
    const idxA = LANGUAGE_ORDER.indexOf(codeA as typeof LANGUAGE_ORDER[number]);
    const idxB = LANGUAGE_ORDER.indexOf(codeB as typeof LANGUAGE_ORDER[number]);
    return (idxA === -1 ? Infinity : idxA) - (idxB === -1 ? Infinity : idxB);
  });
}
