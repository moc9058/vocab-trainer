import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyWordGroupMemberAction,
  liveWordGroupAddedAt,
} from "./word-group-recency.js";

describe("word group recency", () => {
  it("only treats membership absent from the target group as a new addition", () => {
    assert.deepEqual(
      applyWordGroupMemberAction(["one", "two"], ["two", "three", "three"], "add"),
      { next: ["one", "two", "three"], newlyAdded: ["three"] }
    );
  });

  it("makes a removed and later re-added member new again", () => {
    const removed = applyWordGroupMemberAction(["one"], ["one"], "remove");
    assert.deepEqual(removed, { next: [], newlyAdded: [] });
    assert.deepEqual(applyWordGroupMemberAction(removed.next, ["one"], "add").newlyAdded, ["one"]);
  });

  it("returns independent A/B timestamps only for live memberships", () => {
    const stored = {
      addedToGroupAAt: "2026-10-13T00:00:00.000Z",
      addedToGroupBAt: "2026-10-13T02:00:00.000Z",
    };
    assert.deepEqual(liveWordGroupAddedAt(stored, { A: true, B: true }), {
      A: stored.addedToGroupAAt,
      B: stored.addedToGroupBAt,
    });
    assert.deepEqual(liveWordGroupAddedAt(stored, { A: true, B: false }), {
      A: stored.addedToGroupAAt,
    });
    assert.equal(liveWordGroupAddedAt(stored, { A: false, B: false }), undefined);
    assert.equal(liveWordGroupAddedAt({}, { A: true, B: true }), undefined);
  });
});
