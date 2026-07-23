// Shared ordering helpers used by the word, grammar, and combined quiz routes.

// A word/grammar item counts as "already-correct" (mastered) when its most recent answer was
// correct — i.e. its saved progress streak is >= 1. Unseen or last-wrong items are not mastered.
export function isMastered(p: { streak: number } | undefined | null): boolean {
  return !!p && p.streak >= 1;
}

export function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
  }
  return shuffled;
}

// Weighted merge: repeatedly pick a bucket with probability proportional to its weight
// (among buckets that still have items), then take that bucket's NEXT item — preserving
// each bucket's internal order. Buckets with weight <= 0 or no items are skipped, so
// callers that must not drop items should append the leftovers themselves.
export function weightedMerge<T>(buckets: { weight: number; items: T[] }[]): T[] {
  const pools = buckets
    .filter((b) => b.weight > 0 && b.items.length > 0)
    .map((b) => ({ weight: b.weight, items: [...b.items] }));
  const order: T[] = [];
  while (pools.some((p) => p.items.length > 0)) {
    const active = pools.filter((p) => p.items.length > 0);
    const total = active.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * total;
    let chosen = active[active.length - 1];
    for (const p of active) {
      r -= p.weight;
      if (r <= 0) {
        chosen = p;
        break;
      }
    }
    order.push(chosen.items.shift()!);
  }
  return order;
}

// Weighted interleave: like weightedMerge, but each draw takes a RANDOM item from the
// chosen bucket. Used to order a quiz by group weight.
export function weightedInterleave<T>(buckets: { weight: number; items: T[] }[]): T[] {
  return weightedMerge(buckets.map((b) => ({ weight: b.weight, items: shuffle(b.items) })));
}

export function insertRetryQuestion<T>(
  questions: T[],
  retryQuestion: T,
  answeredIndex: number
): void {
  // Insert the retry copy at a random position within the remaining tail so it does not
  // always appear next. Unlike a full tail reshuffle, this preserves the existing order of
  // the rest of the tail — important for keeping a weighted (grouped) quiz's ordering intact.
  const tailStart = answeredIndex + 1;
  const tailLen = questions.length - tailStart;
  const pos = tailStart + Math.floor(Math.random() * (tailLen + 1));
  questions.splice(pos, 0, retryQuestion);
}
