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
