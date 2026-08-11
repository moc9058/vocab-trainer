import { describe, expect, it } from "vitest";
import {
  appendSessionReview,
  completeSessionReview,
  hasPendingSessionReview,
  loadSessionReview,
  sessionReviewKey,
  unreviewedSessionQuestions,
} from "./sessionReview";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

type Question = { id: string; userCorrect?: boolean };

describe("session review persistence", () => {
  it("recovers only answers after the durable review boundary", () => {
    const storage = new MemoryStorage() as Storage;
    const key = sessionReviewKey("word", "chinese");
    const questions: Question[] = [
      { id: "1", userCorrect: true },
      { id: "2" },
      { id: "3", userCorrect: false },
    ];

    const unreviewed = unreviewedSessionQuestions(questions, 1);
    expect(loadSessionReview(key, "start-1", unreviewed, storage)).toEqual([questions[2]]);
    expect(hasPendingSessionReview(key, "start-1", questions, 1, storage)).toBe(true);
  });

  it("does not resurrect historical answers for a legacy session with no boundary", () => {
    const questions: Question[] = [
      { id: "old-1", userCorrect: true },
      { id: "old-2", userCorrect: false },
    ];
    expect(unreviewedSessionQuestions(questions, undefined)).toEqual([]);
  });

  it("restores only attempts after a large historical review boundary", () => {
    const historical: Question[] = Array.from({ length: 494 }, (_, i) => ({
      id: `old-${i}`,
      userCorrect: true,
    }));
    const questions: Question[] = [
      ...historical,
      { id: "new-1", userCorrect: false },
      { id: "new-2", userCorrect: false },
      { id: "next" },
    ];

    expect(unreviewedSessionQuestions(questions, 494).map((q) => q.id)).toEqual([
      "new-1",
      "new-2",
    ]);
  });

  it("survives reloads and keeps retry attempts as separate entries", () => {
    const storage = new MemoryStorage() as Storage;
    const key = sessionReviewKey("grammar", "chinese");
    const first = appendSessionReview(key, "start-1", [], { id: "g1", userCorrect: false }, storage);
    appendSessionReview(key, "start-1", first, { id: "g1", userCorrect: true }, storage);

    expect(loadSessionReview<Question>(key, "start-1", [], storage)).toEqual([
      { id: "g1", userCorrect: false },
      { id: "g1", userCorrect: true },
    ]);
  });

  it("keeps an empty reviewed marker so old server answers do not return", () => {
    const storage = new MemoryStorage() as Storage;
    const key = sessionReviewKey("combined", "chinese__mixed");
    const answered: Question[] = [{ id: "1", userCorrect: true }];
    loadSessionReview(key, "start-1", answered, storage);
    completeSessionReview(key, "start-1", storage);

    expect(loadSessionReview(key, "start-1", answered, storage)).toEqual([]);
    expect(hasPendingSessionReview(key, "start-1", answered, 0, storage)).toBe(false);
  });

  it("does not carry the prior review boundary into a newly started quiz", () => {
    const storage = new MemoryStorage() as Storage;
    const key = sessionReviewKey("word", "chinese");
    completeSessionReview(key, "start-1", storage);
    const nextQuestions: Question[] = [{ id: "2", userCorrect: true }];

    expect(loadSessionReview(key, "start-2", nextQuestions, storage)).toEqual(nextQuestions);
  });
});
