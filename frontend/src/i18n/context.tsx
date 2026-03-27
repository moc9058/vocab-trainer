import { createContext, useContext, useCallback, useState } from "react";
import type { ReactNode } from "react";
import translations, {
  type TranslationKey,
  type UILanguage,
  uiLanguages,
} from "./translations";

interface I18nContextValue {
  t: (key: TranslationKey) => string;
  language: UILanguage;
  setLanguage: (lang: UILanguage) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<UILanguage>(() => {
    const stored = localStorage.getItem("uiLanguage");
    return stored && uiLanguages.includes(stored as UILanguage)
      ? (stored as UILanguage)
      : "en";
  });

  const setLanguage = useCallback((lang: UILanguage) => {
    setLanguageState(lang);
    localStorage.setItem("uiLanguage", lang);
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => translations[language][key],
    [language],
  );

  return (
    <I18nContext value={{ t, language, setLanguage }}>{children}</I18nContext>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}
