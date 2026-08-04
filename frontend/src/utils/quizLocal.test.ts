import { describe, expect, it } from "vitest";
import { refileCombinedMembership, reorderCombinedTailLocally, type RefileOpts } from "./quizLocal";
import type {
  CombinedQuizGrammarQuestion,
  CombinedQuizSession,
  CombinedQuizWordQuestion,
} from "../types";

function wq(id: string, userCorrect?: boolean): CombinedQuizWordQuestion {
  return {
    kind: "word",
    wordId: id,
    term: `w${id}`,
    definitions: [],
    ...(userCorrect !== undefined ? { userCorrect } : {}),
  };
}

function gq(id: string, userCorrect?: boolean): CombinedQuizGrammarQuestion {
  return {
    kind: "grammar",
    grammarId: id,
    statement: `s${id}`,
    ...(userCorrect !== undefined ? { userCorrect } : {}),
  };
}

function makeSession(overrides: Partial<CombinedQuizSession> = {}): CombinedQuizSession {
  return {
    sessionId: "chinese__mixed",
    language: "chinese",
    startedAt: "2026-08-04T00:00:00.000Z",
    status: "in-progress",
    score: { correct: 0, total: 0 },
    questions: [],
    domainWeights: { word: 1, grammar: 1 },
    initialTotal: 0,
    ...overrides,
  };
}

/** categoryOfGroup from a plain record — unknown ids yield undefined, like a failed fetch. */
function catOf(map: Record<string, "A" | "B">): RefileOpts["categoryOfGroup"] {
  return (gid) => map[gid];
}

function questionKey(q: CombinedQuizWordQuestion | CombinedQuizGrammarQuestion): string {
  return q.kind === "word" ? `word:${q.wordId}` : `grammar:${q.grammarId}`;
}

describe("refileCombinedMembership", () => {
  it("moves the id from its B bucket into an existing A bucket, leaving the other domain alone", () => {
    const session = makeSession({
      wordGroupMembership: { A1: ["1"], B1: ["2", "3"] },
      grammarGroupMembership: { GB: ["g1"] },
    });
    const result = refileCombinedMembership(session, "word", "2", {
      categoryOfGroup: catOf({ A1: "A", B1: "B", GB: "B" }),
      removedFromGroupIds: ["B1"],
      aGroupId: "A1",
    });
    expect(result.wordGroupMembership).toEqual({ A1: ["1", "2"], B1: ["3"] });
    expect(result.grammarGroupMembership).toBe(session.grammarGroupMembership);
  });

  it("strips groups named by removedFromGroupIds even when the category map knows nothing, creating an absent A key", () => {
    const session = makeSession({ wordGroupMembership: { B1: ["2"] } });
    const result = refileCombinedMembership(session, "word", "2", {
      categoryOfGroup: () => undefined,
      removedFromGroupIds: ["B1"],
      aGroupId: "A9",
    });
    // The emptied B key survives as [] — the server keeps it and the ⚖ panel iterates keys.
    expect(result.wordGroupMembership).toEqual({ B1: [], A9: ["2"] });
  });

  it("does not duplicate an id already present in its A bucket", () => {
    const session = makeSession({ wordGroupMembership: { A1: ["2"], B1: ["2"] } });
    const result = refileCombinedMembership(session, "word", "2", {
      categoryOfGroup: catOf({ A1: "A", B1: "B" }),
      removedFromGroupIds: ["B1"],
      aGroupId: "A1",
    });
    expect(result.wordGroupMembership).toEqual({ A1: ["2"], B1: [] });
  });

  it("strips only, when the item has no A home", () => {
    const session = makeSession({ grammarGroupMembership: { A1: ["g9"], B1: ["g1"] } });
    const result = refileCombinedMembership(session, "grammar", "g1", {
      categoryOfGroup: catOf({ A1: "A", B1: "B" }),
      removedFromGroupIds: ["B1"],
      aGroupId: undefined,
    });
    expect(result.grammarGroupMembership).toEqual({ A1: ["g9"], B1: [] });
  });

  it("returns the session unchanged when the domain's map is absent or empty", () => {
    const bare = makeSession();
    const empty = makeSession({ wordGroupMembership: {} });
    const opts: RefileOpts = {
      categoryOfGroup: () => "B",
      removedFromGroupIds: ["B1"],
      aGroupId: "A1",
    };
    expect(refileCombinedMembership(bare, "word", "2", opts)).toBe(bare);
    expect(refileCombinedMembership(empty, "word", "2", opts)).toBe(empty);
  });

  it("is idempotent — re-applying the same move changes nothing", () => {
    const session = makeSession({ wordGroupMembership: { A1: ["1"], B1: ["2"] } });
    const opts: RefileOpts = {
      categoryOfGroup: catOf({ A1: "A", B1: "B" }),
      removedFromGroupIds: ["B1"],
      aGroupId: "A1",
    };
    const once = refileCombinedMembership(session, "word", "2", opts);
    const twice = refileCombinedMembership(once, "word", "2", opts);
    expect(twice.wordGroupMembership).toEqual(once.wordGroupMembership);
  });
});

describe("reorderCombinedTailLocally", () => {
  it("returns a randomOrder session untouched", () => {
    const session = makeSession({ randomOrder: true, questions: [wq("1"), wq("2"), gq("g1")] });
    expect(reorderCombinedTailLocally(session)).toBe(session);
  });

  it("returns the session untouched when at most one question is unanswered", () => {
    const session = makeSession({ questions: [wq("1", true), wq("2")] });
    expect(reorderCombinedTailLocally(session)).toBe(session);
  });

  it("keeps the answered prefix in place and pins the first unanswered card", () => {
    const questions = [wq("1", true), wq("2", false), wq("3"), wq("4"), wq("5"), gq("g1")];
    const session = makeSession({
      questions,
      wordGroupMembership: { A1: ["3", "4", "5"] },
      grammarGroupMembership: { GA: ["g1"] },
    });
    const result = reorderCombinedTailLocally(session);
    // Answered questions keep identity AND position; the on-screen card (first unanswered)
    // keeps its index, so the caller's cursor stays on the same question.
    expect(result.questions[0]).toBe(questions[0]);
    expect(result.questions[1]).toBe(questions[1]);
    expect(result.questions[2]).toBe(questions[2]);
    expect(result.questions).toHaveLength(questions.length);
    expect(result.questions.map(questionKey).sort()).toEqual(questions.map(questionKey).sort());
  });

  it("never drops questions — zero-weight groups and retry duplicates are appended", () => {
    // "3" appears twice (a retry copy) and A2 is weighted 0; both must survive the re-draw.
    const questions = [wq("2", true), wq("3"), wq("3"), wq("4"), gq("g1"), gq("g2")];
    const session = makeSession({
      questions,
      wordGroupMembership: { A1: ["3"], A2: ["4"] },
      wordGroupWeights: { A1: 1, A2: 0 },
      grammarGroupMembership: { GA: ["g1", "g2"] },
    });
    const result = reorderCombinedTailLocally(session);
    expect(result.questions).toHaveLength(questions.length);
    expect(result.questions.map(questionKey).sort()).toEqual(questions.map(questionKey).sort());
    // The pinned card is still first in the unanswered region.
    expect(result.questions[1]).toBe(questions[1]);
  });

  it("keeps mastered items in the session when a correct bucket is active", () => {
    const questions = [wq("1"), wq("2"), wq("3"), gq("g1")];
    const session = makeSession({
      questions,
      correctWeight: 0,
      correctMembership: { wordIds: ["2"], grammarIds: [] },
      wordGroupMembership: { A1: ["1", "3"] },
      grammarGroupMembership: { GA: ["g1"] },
    });
    const result = reorderCombinedTailLocally(session);
    // Weight 0 drops the mastered bucket from the merge; the coverage append restores it.
    expect(result.questions.map(questionKey).sort()).toEqual(questions.map(questionKey).sort());
  });
});
