import { useSettings } from "../settings/context";
import type { Grammar } from "../types";

interface Props {
  item: Grammar;
}

/**
 * Answer-reveal panel for a grammar item, shared by the grammar quiz and the
 * combined quiz (both the live reveal and the end-of-session review).
 *
 * Renders the same two pinyin fields the browse list (`GrammarList`) shows —
 * the statement's `transliteration` on top and each description's own
 * `pinyins` beside its part-of-speech chip. Both are stored on the item and
 * arrive with `GET /api/grammar/:language/items/:id`; the quiz screens simply
 * never rendered them.
 */
export default function GrammarDescriptionsPanel({ item }: Props) {
  const { displayDefEntries } = useSettings();

  return (
    <div className="w-full max-w-lg rounded-lg bg-gray-800 border border-gray-600 p-4">
      {item.transliteration && (
        <p className="mb-2 text-sm text-gray-400">{item.transliteration}</p>
      )}
      {item.descriptions?.map((d, di) => {
        const entries = displayDefEntries(d.text || {});
        const rows = entries.length > 0 ? entries : Object.entries(d.text || {});
        return (
          <div key={di} className="mb-2 last:mb-0">
            {d.partOfSpeech && (
              <span className="mr-2 rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300">
                {d.partOfSpeech}
              </span>
            )}
            {d.pinyins && d.pinyins.length > 0 && (
              <span className="mr-2 text-xs text-gray-400">{d.pinyins.join(", ")}</span>
            )}
            {rows.map(([lang, text]) => (
              <p key={lang} className="text-sm text-gray-300 whitespace-pre-line">
                <span className="text-xs text-gray-500">[{lang}] </span>
                {text}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}
