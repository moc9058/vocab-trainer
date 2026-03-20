interface Segment {
  text: string;
  transliteration?: string;
}

interface Props {
  text: string;
  transliterationMap: Record<string, string>;
  segments?: Segment[];
}

export default function RubyText({ text, transliterationMap, segments: precomputed }: Props) {
  const segments = precomputed ?? segment(text, transliterationMap);

  return (
    <>
      {segments.map((seg, i) =>
        seg.transliteration ? (
          <ruby key={i}>
            {seg.text}
            <rt className="text-[70%]">{seg.transliteration}</rt>
          </ruby>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  );
}

function segment(text: string, transliterationMap: Record<string, string>): Segment[] {
  const maxLen = Math.max(0, ...Object.keys(transliterationMap).map((k) => k.length));
  const results: Segment[] = [];
  let i = 0;

  while (i < text.length) {
    let matched = false;
    const end = Math.min(i + maxLen, text.length);

    for (let len = end - i; len >= 1; len--) {
      const substr = text.slice(i, i + len);
      if (transliterationMap[substr]) {
        results.push({ text: substr, transliteration: transliterationMap[substr] });
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Accumulate unmatched characters into a single plain segment
      if (results.length > 0 && !results[results.length - 1].transliteration) {
        results[results.length - 1].text += text[i];
      } else {
        results.push({ text: text[i] });
      }
      i++;
    }
  }

  return results;
}
