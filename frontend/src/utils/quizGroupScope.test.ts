import { describe, expect, it } from "vitest";
import { representedGroupIds } from "./quizGroupScope";

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
