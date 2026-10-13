import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/context";
import type { GroupCategory } from "../types";
import {
  nextRecentWordGroupExpiry,
  recentWordGroupCategories,
} from "../utils/recentWordGroups";

interface Props {
  groupAddedAt?: Partial<Record<GroupCategory, string>>;
  /** Mixed/article-B removal is local-first, so suppress B before the server round-trip. */
  suppressB?: boolean;
}

export default function RecentWordGroupBadges({ groupAddedAt, suppressB = false }: Props) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const visibleTimestamps = useMemo(
    () => suppressB ? { ...groupAddedAt, B: undefined } : groupAddedAt,
    [groupAddedAt, suppressB]
  );
  const categories = recentWordGroupCategories(visibleTimestamps, now);

  useEffect(() => {
    let timer: number | undefined;
    const scheduleNextExpiry = () => {
      const current = Date.now();
      setNow(current);
      const expiry = nextRecentWordGroupExpiry(visibleTimestamps, current);
      if (expiry !== null) {
        timer = window.setTimeout(scheduleNextExpiry, Math.max(0, expiry - current + 10));
      }
    };
    scheduleNextExpiry();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [visibleTimestamps]);

  if (categories.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2" aria-label={t("recentGroupAdds")}>
      {categories.map((category) => (
        <span
          key={category}
          title={t(category === "A" ? "recentlyAddedToGroupA" : "recentlyAddedToGroupB")}
          className={`rounded-full border px-2.5 py-1 text-xs font-bold tracking-wide ${
            category === "A"
              ? "border-indigo-500/60 bg-indigo-900/50 text-indigo-200"
              : "border-amber-500/60 bg-amber-900/40 text-amber-200"
          }`}
        >
          {category} NEW
        </span>
      ))}
    </div>
  );
}
