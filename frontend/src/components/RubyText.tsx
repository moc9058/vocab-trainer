interface Segment {
  text: string;
  transliteration?: string;
}

interface Props {
  text: string;
  segments?: Segment[];
}

export default function RubyText({ text, segments }: Props) {
  if (!segments || segments.length === 0) {
    return <>{text}</>;
  }

  // Walk `text` left-to-right, matching word segments in order.
  // Any characters not covered by a segment (punctuation, spaces, numbers)
  // are emitted as plain text so nothing is dropped from the display.
  type Part = { seg: string; rt?: string } | string;
  const parts: Part[] = [];
  let pos = 0;
  for (const seg of segments) {
    const idx = text.indexOf(seg.text, pos);
    if (idx === -1) continue;
    if (idx > pos) parts.push(text.slice(pos, idx));
    parts.push({ seg: seg.text, rt: seg.transliteration });
    pos = idx + seg.text.length;
  }
  if (pos < text.length) parts.push(text.slice(pos));

  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <span key={i}>{part}</span>
        ) : part.rt ? (
          <ruby key={i}>
            {part.seg}
            <rt className="text-[70%]">{part.rt}</rt>
          </ruby>
        ) : (
          <span key={i}>{part.seg}</span>
        )
      )}
    </>
  );
}
