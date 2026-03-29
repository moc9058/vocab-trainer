import { createContext, useContext, useCallback, useState, useMemo } from "react";
import type { ReactNode } from "react";
import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS } from "./defaults";

interface SettingsContextValue {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  sortByLanguageOrder: <T>(items: T[], getKey: (item: T) => string) => T[];
  sortedEntries: (record: Record<string, string>) => [string, string][];
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
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_SETTINGS, ...parsed };
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

  const value = useMemo(
    () => ({ settings, updateSettings, sortByLanguageOrder, sortedEntries }),
    [settings, updateSettings, sortByLanguageOrder, sortedEntries],
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
