import { useLayoutEffect, useRef, useState } from "react";

const TONE_MARKS: Record<string, string[]> = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  ü: ["ǖ", "ǘ", "ǚ", "ǜ"],
};

const PANEL_ROWS = [
  ["ā", "á", "ǎ", "à"],
  ["ē", "é", "ě", "è"],
  ["ī", "í", "ǐ", "ì"],
  ["ō", "ó", "ǒ", "ò"],
  ["ū", "ú", "ǔ", "ù"],
  ["ǖ", "ǘ", "ǚ", "ǜ", "ü"],
];

// Apply a tone mark (tone 1-4; 5 = neutral, no mark) to the trailing
// unmarked pinyin syllable of `text`. Returns null if there is no syllable
// to convert. "v" is treated as ü.
function applyToneToTail(text: string, tone: number): string | null {
  const m = text.match(/[a-zA-Zvü]+$/);
  if (!m) return null;
  let syllable = m[0].replace(/v/g, "ü").replace(/V/g, "Ü");
  const head = text.slice(0, text.length - m[0].length);
  if (tone >= 1 && tone <= 4) {
    const lower = syllable.toLowerCase();
    // Tone mark placement: a/e take it; in "ou" the o takes it;
    // otherwise the last vowel takes it.
    let idx = -1;
    if (lower.includes("a")) idx = lower.indexOf("a");
    else if (lower.includes("e")) idx = lower.indexOf("e");
    else if (lower.includes("ou")) idx = lower.indexOf("o");
    else {
      for (let i = lower.length - 1; i >= 0; i--) {
        if ("iouü".includes(lower[i])) { idx = i; break; }
      }
    }
    if (idx === -1) return null;
    const vowel = lower[idx];
    const marked = TONE_MARKS[vowel]?.[tone - 1];
    if (!marked) return null;
    syllable = syllable.slice(0, idx) + marked + syllable.slice(idx + 1);
  }
  return head + syllable;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export default function PinyinInput({ value, onChange, placeholder, className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    if (caretRef.current !== null && inputRef.current) {
      inputRef.current.setSelectionRange(caretRef.current, caretRef.current);
      caretRef.current = null;
    }
  }, [value]);

  const insertAtCaret = (char: string) => {
    const input = inputRef.current;
    const pos = input?.selectionStart ?? value.length;
    onChange(value.slice(0, pos) + char + value.slice(pos));
    caretRef.current = pos + char.length;
    input?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!/^[1-5]$/.test(e.key)) return;
    const input = e.currentTarget;
    const pos = input.selectionStart ?? value.length;
    if (input.selectionEnd !== pos) return;
    const converted = applyToneToTail(value.slice(0, pos), Number(e.key));
    if (converted === null) return;
    e.preventDefault();
    onChange(converted + value.slice(pos));
    caretRef.current = converted.length;
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        className={className}
      />
      {focused && (
        // Normal document flow (not absolutely positioned) so the panel pushes
        // following content down instead of floating over it and hiding it.
        <div
          className="mt-1 rounded-lg border border-gray-600 bg-gray-800 p-2 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex flex-col gap-1">
            {PANEL_ROWS.map((row, ri) => (
              <div key={ri} className="flex gap-1">
                {row.map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => insertAtCaret(ch)}
                    className="h-7 w-7 rounded border border-gray-600 bg-gray-700 text-sm text-gray-100 hover:bg-gray-600 hover:border-blue-400"
                  >
                    {ch}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-1.5 text-[10px] text-gray-400">hao3 → hǎo (1-4: tones, 5: neutral, v → ü)</div>
        </div>
      )}
    </div>
  );
}
