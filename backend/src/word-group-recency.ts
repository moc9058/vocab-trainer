import type { GroupCategory } from "./types.js";

export function applyWordGroupMemberAction(
  current: string[],
  requested: string[],
  action: "add" | "remove"
): { next: string[]; newlyAdded: string[] } {
  const uniqueRequested = [...new Set(requested)];
  const currentSet = new Set(current);
  if (action === "add") {
    const newlyAdded = uniqueRequested.filter((id) => !currentSet.has(id));
    return { next: [...current, ...newlyAdded], newlyAdded };
  }
  const toRemove = new Set(uniqueRequested);
  return { next: current.filter((id) => !toRemove.has(id)), newlyAdded: [] };
}

export function liveWordGroupAddedAt(
  stored: { addedToGroupAAt?: string; addedToGroupBAt?: string } | undefined,
  membership: { A: boolean; B: boolean }
): Partial<Record<GroupCategory, string>> | undefined {
  if (!stored) return undefined;
  const result: Partial<Record<GroupCategory, string>> = {};
  if (membership.A && stored.addedToGroupAAt) result.A = stored.addedToGroupAAt;
  if (membership.B && stored.addedToGroupBAt) result.B = stored.addedToGroupBAt;
  return Object.keys(result).length > 0 ? result : undefined;
}
