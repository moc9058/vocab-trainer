import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/context";
import { getGroups } from "../../api/vocab";
import { getGrammarGroups } from "../../api/grammar";
import GroupBUnifiedSelect from "../GroupBUnifiedSelect";
import {
  categoryGroups,
  latestGrammarGroup,
  latestWordGroup,
  type GrammarGroup,
  type WordGroup,
} from "../../types";

interface Props {
  /** Backend full-name language, e.g. "chinese". */
  language: string;
  wordGroupId?: string;
  grammarGroupId?: string;
  groupBNames: string[];
  onChange: (patch: {
    wordGroupId?: string;
    grammarGroupId?: string;
    groupBNames?: string[];
  }) => void;
  /** Seed the Group A selects with the newest group — only for a brand-new session;
   *  a resumed one already carries the user's choice. */
  autoSelectLatest?: boolean;
  /** Collapse to a one-line summary below `lg`, where this sits above the article
   *  rather than in the sidebar and would otherwise push the text off-screen. */
  collapsible?: boolean;
}

/**
 * Where approved items land. Group A is per-domain (word groups and grammar groups
 * are unrelated sets), while Group B is one cross-domain study set chosen by name —
 * which is why the two halves look different.
 */
export default function ImportDestinationRail({
  language,
  wordGroupId,
  grammarGroupId,
  groupBNames,
  onChange,
  autoSelectLatest = false,
  collapsible = false,
}: Props) {
  const { t } = useI18n();
  const [wordGroups, setWordGroups] = useState<WordGroup[]>([]);
  const [grammarGroups, setGrammarGroups] = useState<GrammarGroup[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getGroups(language)
      .then((gs) => {
        if (cancelled) return;
        const aGroups = categoryGroups(gs, "A");
        setWordGroups(aGroups);
        if (autoSelectLatest) {
          const latest = latestWordGroup(aGroups);
          if (latest) onChange({ wordGroupId: latest.id });
        }
      })
      .catch(() => setWordGroups([]));
    getGrammarGroups(language)
      .then((gs) => {
        if (cancelled) return;
        const aGroups = categoryGroups(gs, "A");
        setGrammarGroups(aGroups);
        if (autoSelectLatest) {
          const latest = latestGrammarGroup(aGroups);
          if (latest) onChange({ grammarGroupId: latest.id });
        }
      })
      .catch(() => setGrammarGroups([]));
    return () => { cancelled = true; };
    // `onChange` is a fresh closure each render; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, autoSelectLatest]);

  const summary =
    [
      wordGroups.find((g) => g.id === wordGroupId)?.name,
      grammarGroups.find((g) => g.id === grammarGroupId)?.name,
      ...groupBNames,
    ]
      .filter(Boolean)
      .join(" · ") || t("noGroupOption");

  return (
    <aside className="rounded-2xl border border-gray-700/70 bg-gray-800/50">
      {collapsible ? (
        // Below `lg` this is a disclosure; from `lg` the body is always shown and
        // the header degrades to a plain label.
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-4 py-3 text-left lg:cursor-default lg:py-4"
        >
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
            {t("importDestination")}
          </span>
          <span className="min-w-0 flex-1 truncate text-right text-xs text-gray-400 lg:hidden">
            {summary}
          </span>
          <span
            aria-hidden
            className={`shrink-0 text-gray-500 transition-transform lg:hidden ${open ? "rotate-180" : ""}`}
          >
            ▾
          </span>
        </button>
      ) : (
        <h3 className="px-4 pt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
          {t("importDestination")}
        </h3>
      )}

      <div
        className={`space-y-5 px-4 pb-4 ${collapsible ? "" : "pt-5"} ${
          collapsible && !open ? "hidden lg:block" : ""
        }`}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
            <span className="text-xs font-medium text-gray-300">{t("importGroupA")}</span>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] text-blue-300/80">{t("sectionVocabulary")}</span>
            <select
              value={wordGroupId ?? ""}
              onChange={(e) => onChange({ wordGroupId: e.target.value })}
              className="w-full rounded-lg border border-gray-600 bg-gray-900 px-2.5 py-2 text-base text-gray-100 focus:border-blue-500 focus:outline-none sm:py-1.5 sm:text-sm"
            >
              <option value="">{t("noGroupOption")}</option>
              {wordGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] text-emerald-300/80">{t("sectionGrammar")}</span>
            <select
              value={grammarGroupId ?? ""}
              onChange={(e) => onChange({ grammarGroupId: e.target.value })}
              className="w-full rounded-lg border border-gray-600 bg-gray-900 px-2.5 py-2 text-base text-gray-100 focus:border-emerald-500 focus:outline-none sm:py-1.5 sm:text-sm"
            >
              <option value="">{t("noGroupOption")}</option>
              {grammarGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="space-y-2 border-t border-gray-700/70 pt-4">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <span className="text-xs font-medium text-gray-300">{t("importGroupB")}</span>
          </div>
          <p className="text-[11px] leading-snug text-gray-500">{t("importGroupBHint")}</p>
          <GroupBUnifiedSelect
            language={language}
            selectedNames={groupBNames}
            onChange={(names) => onChange({ groupBNames: names })}
          />
        </div>
      </div>
    </aside>
  );
}
