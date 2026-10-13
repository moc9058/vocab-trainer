import { describe, expect, it } from "vitest";
import {
  nextRecentWordGroupExpiry,
  recentWordGroupCategories,
  RECENT_GROUP_WINDOW_MS,
} from "./recentWordGroups";

describe("recent word group badges", () => {
  const a = Date.parse("2026-10-13T00:00:00.000Z");
  const b = Date.parse("2026-10-13T02:00:00.000Z");
  const timestamps = { A: new Date(a).toISOString(), B: new Date(b).toISOString() };

  it("expires A and B independently after rolling 24-hour windows", () => {
    expect(recentWordGroupCategories(timestamps, a + 23 * 60 * 60 * 1000)).toEqual(["A", "B"]);
    expect(recentWordGroupCategories(timestamps, a + 25 * 60 * 60 * 1000)).toEqual(["B"]);
    expect(recentWordGroupCategories(timestamps, b + RECENT_GROUP_WINDOW_MS)).toEqual([]);
  });

  it("schedules the nearest live expiry", () => {
    expect(nextRecentWordGroupExpiry(timestamps, a)).toBe(a + RECENT_GROUP_WINDOW_MS);
    expect(nextRecentWordGroupExpiry(timestamps, a + RECENT_GROUP_WINDOW_MS)).toBe(
      b + RECENT_GROUP_WINDOW_MS
    );
    expect(nextRecentWordGroupExpiry(timestamps, b + RECENT_GROUP_WINDOW_MS)).toBeNull();
  });

  it("ignores missing and malformed timestamps", () => {
    expect(recentWordGroupCategories(undefined, a)).toEqual([]);
    expect(recentWordGroupCategories({ A: "not-a-date" }, a)).toEqual([]);
  });
});
