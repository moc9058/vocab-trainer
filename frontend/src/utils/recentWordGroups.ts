import type { GroupCategory } from "../types";

export const RECENT_GROUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function recentWordGroupCategories(
  groupAddedAt: Partial<Record<GroupCategory, string>> | undefined,
  now = Date.now()
): GroupCategory[] {
  if (!groupAddedAt) return [];
  return (["A", "B"] as const).filter((category) => {
    const timestamp = groupAddedAt[category];
    if (!timestamp) return false;
    const addedAt = Date.parse(timestamp);
    return Number.isFinite(addedAt) && now < addedAt + RECENT_GROUP_WINDOW_MS;
  });
}

export function nextRecentWordGroupExpiry(
  groupAddedAt: Partial<Record<GroupCategory, string>> | undefined,
  now = Date.now()
): number | null {
  const expiries = recentWordGroupCategories(groupAddedAt, now)
    .map((category) => Date.parse(groupAddedAt![category]!) + RECENT_GROUP_WINDOW_MS);
  return expiries.length > 0 ? Math.min(...expiries) : null;
}
