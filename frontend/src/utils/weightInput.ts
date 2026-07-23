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

// Greatest common divisor. gcd(0, n) === n, so zeros are ignored when reduced over an array.
function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

// Normalize a set of raw weight strings to the smallest whole numbers with the same ratios:
//  1. Scale by the smallest common power of 10 that clears every decimal (["10","0.3"] -> [100,3]).
//  2. Divide the whole set by its GCD ([40,10,5] -> [8,2,1]; [100,3] stays [100,3] since GCD=1).
// Blank/invalid entries become 0 (0 is preserved — gcd(0,n)=n — so "excluded" stays excluded).
export function scaleWeightsToIntegers(raws: (string | undefined)[]): number[] {
  const places = raws.reduce<number>((max, r) => Math.max(max, decimalPlaces(r)), 0);
  const factor = 10 ** places;
  const scaled = raws.map((r) => Math.max(0, Math.round((parseWeightInput(r) ?? 0) * factor)));
  const divisor = scaled.reduce((g, n) => gcd(g, n), 0);
  return divisor > 1 ? scaled.map((n) => n / divisor) : scaled;
}

// Record variant of scaleWeightsToIntegers: scales every value by one common factor and
// returns a record of integers keyed the same way. Use for a whole weight form (mix domain,
// group and "already-correct" fields into one record so they share a single factor).
export function scaleWeightRecord(rec: Record<string, string | undefined>): Record<string, number> {
  const keys = Object.keys(rec);
  const scaled = scaleWeightsToIntegers(keys.map((k) => rec[k]));
  return Object.fromEntries(keys.map((k, i) => [k, scaled[i]]));
}
