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
}: Props) {
  const { t } = useI18n();
  const [wordGroups, setWordGroups] = useState<WordGroup[]>([]);
  const [grammarGroups, setGrammarGroups] = useState<GrammarGroup[]>([]);

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

  return (
    <aside className="space-y-5 rounded-2xl border border-gray-700/70 bg-gray-800/50 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
        {t("importDestination")}
      </h3>

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
            className="w-full rounded-lg border border-gray-600 bg-gray-900 px-2.5 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
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
            className="w-full rounded-lg border border-gray-600 bg-gray-900 px-2.5 py-1.5 text-sm text-gray-100 focus:border-emerald-500 focus:outline-none"
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
    </aside>
  );
}
