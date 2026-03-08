import { createContext, useContext, useCallback } from "react";
import type { ReactNode } from "react";
import translations, { type TranslationKey } from "./translations";

interface I18nContextValue {
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const t = useCallback((key: TranslationKey): string => {
    return translations.en[key];
  }, []);

  return <I18nContext value={{ t }}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}
