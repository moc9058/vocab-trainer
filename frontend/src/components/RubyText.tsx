interface Segment {
  text: string;
  transliteration?: string;
}

interface Props {
  text: string;
  segments?: Segment[];
}

/**
 * Find each segment's occurrence in `text` independently, then place the
 * pinyin annotations in text-order. Order-tolerant: a segments array whose
 * entries don't follow the same order as the sentence still produces a
 * complete annotation (the previous `indexOf(text, pos)` walk silently
 * dropped any segment that appeared earlier than the current cursor).
 *
 * Each placed segment "claims" its character span so overlapping or repeated
 * segment texts can't double-cover the same character.
 */
function placeSegments(
  text: string,
  segments: Segment[],
): Array<{ start: number; end: number; rt?: string }> {
  const claimed = new Array<boolean>(text.length).fill(false);
  const placed: Array<{ start: number; end: number; rt?: string }> = [];

  for (const seg of segments) {
    if (!seg.text) continue;
    let idx = 0;
    while (idx < text.length) {
      const found = text.indexOf(seg.text, idx);
      if (found === -1) break;
      let overlap = false;
      for (let k = found; k < found + seg.text.length; k++) {
        if (claimed[k]) { overlap = true; break; }
      }
      if (!overlap) {
        for (let k = found; k < found + seg.text.length; k++) claimed[k] = true;
        placed.push({ start: found, end: found + seg.text.length, rt: seg.transliteration });
        break;
      }
      idx = found + 1;
    }
  }

  placed.sort((a, b) => a.start - b.start);
  return placed;
}

/**
 * When a segment's text is all Han characters AND its transliteration is N
 * space-separated syllables exactly matching the character count, return the
 * per-character pairs so each pinyin sits above its own character. Otherwise
 * return null and the caller renders one ruby over the whole segment.
 */
function splitPerCharSyllables(
  text: string,
  transliteration: string | undefined,
): Array<{ char: string; syllable: string }> | null {
  if (!transliteration) return null;
  const chars = [...text];
  if (chars.length < 2) return null;
  for (const c of chars) {
    if (!/\p{Script=Han}/u.test(c)) return null;
  }
  const syllables = transliteration.trim().split(/\s+/).filter(Boolean);
  if (syllables.length !== chars.length) return null;
  return chars.map((char, i) => ({ char, syllable: syllables[i] }));
}

export default function RubyText({ text, segments }: Props) {
  if (!segments || segments.length === 0) {
    return <>{text}</>;
  }

  const placed = placeSegments(text, segments);

  type Part = { seg: string; rt?: string } | string;
  const parts: Part[] = [];
  let pos = 0;
  for (const p of placed) {
    if (p.start > pos) parts.push(text.slice(pos, p.start));
    parts.push({ seg: text.slice(p.start, p.end), rt: p.rt });
    pos = p.end;
  }
  if (pos < text.length) parts.push(text.slice(pos));

  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === "string") return <span key={i}>{part}</span>;
        const perChar = splitPerCharSyllables(part.seg, part.rt);
        if (perChar) {
          return (
            <span key={i}>
              {perChar.map((pc, j) => (
                <ruby key={j}>
                  {pc.char}
                  <rt className="text-[70%]">{pc.syllable}</rt>
                </ruby>
              ))}
            </span>
          );
        }
        if (part.rt) {
          return (
            <ruby key={i}>
              {part.seg}
              <rt className="text-[70%]">{part.rt}</rt>
            </ruby>
          );
        }
        return <span key={i}>{part.seg}</span>;
      })}
    </>
  );
}
