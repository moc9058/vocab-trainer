import type { AppSettings } from "./types";

export const ALL_KNOWN_LANGUAGES = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "zh", label: "Chinese", nativeLabel: "中文" },
] as const;

export const LANG_LABEL_MAP: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
};

export const DEFAULT_SETTINGS: AppSettings = {
  languageOrder: ["en", "ja", "ko", "zh"],
  activeUiLanguages: ["en", "ja", "ko"],
  displayDefinitionLanguages: ["en", "ja", "ko", "zh"],
  displayExampleTranslationLanguages: ["en", "ja", "ko", "zh"],
  defaultAddWordLanguage: "english",
  defaultDefinitionLanguage: "en",
  defaultCorrectionMode: "speaking",
  defaultSpeakingUseCase: "professional",
  defaultWritingUseCase: "academic",
  defaultTranslationSourceLanguage: "en",
  defaultTranslationTargetLanguages: ["ja"],
};
