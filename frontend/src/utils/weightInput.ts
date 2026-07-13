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

export function clampWeight(raw: string | undefined, min: number, fallback: number): number {
  const n = parseWeightInput(raw);
  return n !== null ? Math.max(min, Math.floor(n)) : fallback;
}
