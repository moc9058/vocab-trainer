interface Props {
  text: string;
  pinyinMap: Record<string, string>;
}

export default function RubyText({ text, pinyinMap }: Props) {
  const segments = segment(text, pinyinMap);

  return (
    <>
      {segments.map((seg, i) =>
        seg.pinyin ? (
          <ruby key={i}>
            {seg.text}
            <rt>{seg.pinyin}</rt>
          </ruby>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  );
}

interface Segment {
  text: string;
  pinyin?: string;
}

function segment(text: string, pinyinMap: Record<string, string>): Segment[] {
  const maxLen = Math.max(0, ...Object.keys(pinyinMap).map((k) => k.length));
  const results: Segment[] = [];
  let i = 0;

  while (i < text.length) {
    let matched = false;
    const end = Math.min(i + maxLen, text.length);

    for (let len = end - i; len >= 1; len--) {
      const substr = text.slice(i, i + len);
      if (pinyinMap[substr]) {
        results.push({ text: substr, pinyin: pinyinMap[substr] });
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Accumulate unmatched characters into a single plain segment
      if (results.length > 0 && !results[results.length - 1].pinyin) {
        results[results.length - 1].text += text[i];
      } else {
        results.push({ text: text[i] });
      }
      i++;
    }
  }

  return results;
}
