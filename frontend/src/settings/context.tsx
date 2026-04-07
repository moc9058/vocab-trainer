import { createContext, useContext, useCallback, useState, useMemo } from "react";
import type { ReactNode } from "react";
import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS } from "./defaults";

interface SettingsContextValue {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  sortByLanguageOrder: <T>(items: T[], getKey: (item: T) => string) => T[];
  sortedEntries: (record: Record<string, string>) => [string, string][];
  /** Sorted entries filtered to languages selected for definition display. */
  displayDefEntries: (record: Record<string, string>) => [string, string][];
  /** Sorted entries filtered to languages selected for example translation display. */
  displayExEntries: (record: Record<string, string>) => [string, string][];
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const fullNameMap: Record<string, string> = {
  english: "en",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
};

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem("appSettings");
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      // Legacy field migration: defaultDefinitionLanguages → displayDefinitionLanguages
      // and defaultExampleTranslationLanguages → displayExampleTranslationLanguages.
      // The old "default*" naming reflected an LLM-generation setting that no longer
      // exists; the same lists now control display only.
      if ("defaultDefinitionLanguages" in parsed && !("displayDefinitionLanguages" in parsed)) {
        parsed.displayDefinitionLanguages = parsed.defaultDefinitionLanguages;
      }
      if (
        "defaultExampleTranslationLanguages" in parsed &&
        !("displayExampleTranslationLanguages" in parsed)
      ) {
        parsed.displayExampleTranslationLanguages = parsed.defaultExampleTranslationLanguages;
      }
      delete parsed.defaultDefinitionLanguages;
      delete parsed.defaultExampleTranslationLanguages;
      return { ...DEFAULT_SETTINGS, ...parsed } as AppSettings;
    }
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem("appSettings", JSON.stringify(next));
      return next;
    });
  }, []);

  const sortByLanguageOrder = useCallback(
    <T,>(items: T[], getKey: (item: T) => string): T[] => {
      const order = settings.languageOrder;
      return [...items].sort((a, b) => {
        const keyA = getKey(a).toLowerCase();
        const keyB = getKey(b).toLowerCase();
        const codeA = fullNameMap[keyA] ?? keyA;
        const codeB = fullNameMap[keyB] ?? keyB;
        const idxA = order.indexOf(codeA);
        const idxB = order.indexOf(codeB);
        return (idxA === -1 ? Infinity : idxA) - (idxB === -1 ? Infinity : idxB);
      });
    },
    [settings.languageOrder],
  );

  const sortedEntries = useCallback(
    (record: Record<string, string>): [string, string][] => {
      const entries = Object.entries(record);
      const order = settings.languageOrder;
      return entries.sort(([a], [b]) => {
        const idxA = order.indexOf(a);
        const idxB = order.indexOf(b);
        return (idxA === -1 ? Infinity : idxA) - (idxB === -1 ? Infinity : idxB);
      });
    },
    [settings.languageOrder],
  );

  const displayDefEntries = useCallback(
    (record: Record<string, string>): [string, string][] => {
      const allowed = new Set(settings.displayDefinitionLanguages);
      return sortedEntries(record).filter(([lang]) => allowed.has(lang));
    },
    [sortedEntries, settings.displayDefinitionLanguages],
  );

  const displayExEntries = useCallback(
    (record: Record<string, string>): [string, string][] => {
      const allowed = new Set(settings.displayExampleTranslationLanguages);
      return sortedEntries(record).filter(([lang]) => allowed.has(lang));
    },
    [sortedEntries, settings.displayExampleTranslationLanguages],
  );

  const value = useMemo(
    () => ({
      settings,
      updateSettings,
      sortByLanguageOrder,
      sortedEntries,
      displayDefEntries,
      displayExEntries,
    }),
    [settings, updateSettings, sortByLanguageOrder, sortedEntries, displayDefEntries, displayExEntries],
  );

  return (
    <SettingsContext value={value}>{children}</SettingsContext>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
