// Weight <input> fields are edited as raw strings so the field can sit blank
// while the user retypes a value, instead of snapping back to a default the
// instant the field is cleared. These helpers convert that raw text to a
// number only where it's actually needed (validity checks, submission).

export function parseWeightInput(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function isWeightValid(raw: string | undefined, min: number): boolean {
  const n = parseWeightInput(raw);
  return n !== null && n >= min;
}

// Count the decimal places in a raw weight string: "0.3" -> 1, "10" -> 0, "1.25" -> 2.
// Scientific notation isn't supported (users don't type it for weights); it just yields the
// digit count after any ".", which is harmless for scaling.
export function decimalPlaces(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  const dot = trimmed.indexOf(".");
  return dot === -1 ? 0 : trimmed.length - dot - 1;
}

// Scale a set of raw weight strings by the smallest common power of 10 that turns every value
// into a whole number, preserving all ratios. e.g. ["10", "0.3"] -> [100, 3]. Ratios are NOT
// reduced (no GCD) — matching the requested "10, 0.3 -> 100, 3" behavior. Blank/invalid
// entries become 0. A single common factor keeps every pairwise ratio intact.
export function scaleWeightsToIntegers(raws: (string | undefined)[]): number[] {
  const places = raws.reduce<number>((max, r) => Math.max(max, decimalPlaces(r)), 0);
  const factor = 10 ** places;
  return raws.map((r) => Math.max(0, Math.round((parseWeightInput(r) ?? 0) * factor)));
}

// Record variant of scaleWeightsToIntegers: scales every value by one common factor and
// returns a record of integers keyed the same way. Use for a whole weight form (mix domain,
// group and "already-correct" fields into one record so they share a single factor).
export function scaleWeightRecord(rec: Record<string, string | undefined>): Record<string, number> {
  const keys = Object.keys(rec);
  const scaled = scaleWeightsToIntegers(keys.map((k) => rec[k]));
  return Object.fromEntries(keys.map((k, i) => [k, scaled[i]]));
}
