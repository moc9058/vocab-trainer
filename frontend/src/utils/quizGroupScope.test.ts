import { describe, expect, it } from "vitest";
import {
  representedGroupIds,
  restoreGroupWeightDraft,
  serializeGroupWeightDraft,
} from "./quizGroupScope";

describe("representedGroupIds", () => {
  it("includes only groups with a member in the created question set", () => {
    const result = representedGroupIds(
      {
        included: ["1", "2"],
        zeroWeight: ["3", "4"],
        empty: [],
      },
      new Set(["1", "2"])
    );

    expect([...result]).toEqual(["included"]);
  });

  it("returns an empty set when the session has no group membership", () => {
    expect(representedGroupIds(undefined, new Set(["1"]))).toEqual(new Set());
  });
});

describe("mixed quiz group-weight persistence", () => {
  it("serializes the original decimal inputs without folding or integer scaling", () => {
    expect(
      serializeGroupWeightDraft(["a", "b", "zero"], {
        a: "0.5",
        b: "4.5",
        zero: "0",
      })
    ).toEqual({ a: 0.5, b: 4.5, zero: 0 });
  });

  it("restores original inputs instead of the effective folded weights", () => {
    expect(
      restoreGroupWeightDraft(
        ["a", "b", "zero"],
        { a: 0.5, b: 4.5, zero: 0 },
        { a: 100, b: 900, zero: 0 }
      )
    ).toEqual({ a: "0.5", b: "4.5", zero: "0" });
  });

  it("reduces effective weights inside each category for legacy sessions", () => {
    const categories = new Map([
      ["b1", "B" as const],
      ["b2", "B" as const],
      ["a1", "A" as const],
      ["a2", "A" as const],
      ["a3", "A" as const],
    ]);
    expect(
      restoreGroupWeightDraft(
        ["b1", "b2", "a1", "a2", "a3"],
        undefined,
        { b1: 9, b2: 9, a1: 200, a2: 800, a3: 200 },
        categories
      )
    ).toEqual({ b1: "1", b2: "1", a1: "1", a2: "4", a3: "1" });
  });

  it("retains effective weights when legacy category metadata is unavailable", () => {
    expect(restoreGroupWeightDraft(["a", "b"], undefined, { a: 100, b: 9 })).toEqual({
      a: "100",
      b: "9",
    });
  });
});
