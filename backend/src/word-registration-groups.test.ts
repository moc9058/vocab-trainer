import assert from "node:assert/strict";
import { test } from "node:test";
import type { WordGroup } from "./types.js";
import { resolveWordRegistrationGroups, WordRegistrationGroupError } from "./word-registration-groups.js";

const group = (id: string, createdAt: string, category?: "A" | "B", language = "chinese", order = 0): WordGroup => ({ id, language, name: id, wordIds: [], createdAt, category, order });
const groups = [group("old-a", "2026-10-01", undefined, "chinese", 0), group("new-a", "2026-11-01", "A", "chinese", 9), group("b1", "2026-11-02", "B"), group("b2", "2026-11-02", "B"), group("foreign", "2026-12-01", "A", "japanese")];

test("implicit A is newest by creation date, ignoring priority and newer B/foreign groups", () => {
  for (const request of [{}, { groupIds: [] }, { groupIds: ["b1"] }, { groupBIds: ["b1"] }]) {
    const selected = resolveWordRegistrationGroups("chinese", groups, request);
    assert.equal(selected.a.id, "new-a");
  }
});
test("explicit A and multiple B targets are validated and deduplicated", () => {
  const selected = resolveWordRegistrationGroups("chinese", groups, { groupIds: ["old-a", "old-a", "b1"], groupBIds: ["b1", "b2", "b2"] });
  assert.equal(selected.a.id, "old-a");
  assert.deepEqual(selected.b.map(group => group.id), ["b1", "b2"]);
});
test("missing A, invalid/cross-language groups, multiple A groups and A in groupBIds fail", () => {
  for (const request of [{ groupIds: ["missing"] }, { groupIds: ["foreign"] }, { groupIds: ["old-a", "new-a"] }, { groupBIds: ["old-a"] }]) {
    assert.throws(() => resolveWordRegistrationGroups("chinese", groups, request), WordRegistrationGroupError);
  }
  assert.throws(() => resolveWordRegistrationGroups("chinese", groups.filter(group => group.category === "B"), { groupBIds: ["b1"] }), WordRegistrationGroupError);
});
