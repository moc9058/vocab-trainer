import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SearchIndexEntry, SearchIn } from "../types";
import { matchSearchIndex } from "../utils/searchMatch";
import { useI18n } from "../i18n/context";

/**
 * Text input with an as-you-type preview dropdown fed by the client-side
 * search index (useSearchIndex — the caller owns the hook so the fetch can be
 * gated on first focus and shared with the list's own search request).
 *
 * `searchIn` is lifted to the caller for the same reason: the list screens
 * pass it through to the server so the checkbox governs the RESULT LIST too,
 * not just the dropdown. Add flows omit the toggle (term-only).
 */
interface SearchPreviewInputProps {
  value: string;
  onChange: (v: string) => void;
  entries: SearchIndexEntry[];
  onSelect: (entry: SearchIndexEntry) => void;
  /** Fired on first focus — the caller uses it to enable the index fetch. */
  onFirstFocus?: () => void;
  /** Show the term/meaning checkboxes. Off = term-only (add flows). */
  allowMeaningToggle?: boolean;
  searchIn?: SearchIn;
  onSearchInChange?: (s: SearchIn) => void;
  placeholder?: string;
  maxResults?: number;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Extra per-row content, e.g. the add flows' "registered" badge. */
  renderMeta?: (entry: SearchIndexEntry) => ReactNode;
}

const DEFAULT_INPUT_CLASS =
  "w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-400 focus:border-blue-400 focus:outline-none";

export default function SearchPreviewInput({
  value,
  onChange,
  entries,
  onSelect,
  onFirstFocus,
  allowMeaningToggle = false,
  searchIn = "term",
  onSearchInChange,
  placeholder,
  maxResults = 12,
  required,
  autoFocus,
  className,
  renderMeta,
}: SearchPreviewInputProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const focusedOnceRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(
    () => matchSearchIndex(entries, value, searchIn),
    [entries, value, searchIn]
  );
  const visible = matches.slice(0, maxResults);
  const overflow = matches.length - visible.length;
  const showDropdown = open && value.trim().length > 0;

  // Reset keyboard highlight whenever the result set changes.
  useEffect(() => {
    setHighlighted(-1);
  }, [value, searchIn]);

  // Close on click outside.
  useEffect(() => {
    if (!showDropdown) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showDropdown]);

  // Keep the highlighted row in view while navigating with the keyboard.
  useEffect(() => {
    if (highlighted < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  function selectEntry(entry: SearchIndexEntry) {
    setOpen(false);
    onSelect(entry);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown || visible.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % visible.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => (h <= 0 ? visible.length - 1 : h - 1));
    } else if (e.key === "Enter") {
      if (highlighted >= 0 && highlighted < visible.length) {
        e.preventDefault();
        selectEntry(visible[highlighted].entry);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function toggleSearchIn(which: "term" | "meaning") {
    if (!onSearchInChange) return;
    const termOn = searchIn !== "meaning";
    const meaningOn = searchIn !== "term";
    let nextTerm = which === "term" ? !termOn : termOn;
    let nextMeaning = which === "meaning" ? !meaningOn : meaningOn;
    // At least one must stay checked: unchecking the last re-checks the other.
    if (!nextTerm && !nextMeaning) {
      if (which === "term") nextMeaning = true;
      else nextTerm = true;
    }
    onSearchInChange(nextTerm && nextMeaning ? "both" : nextTerm ? "term" : "meaning");
  }

  function highlightLabel(label: string, span?: [number, number]): ReactNode {
    if (!span || span[0] >= label.length) return label;
    const end = Math.min(span[1], label.length);
    return (
      <>
        {label.slice(0, span[0])}
        <span className="text-blue-300">{label.slice(span[0], end)}</span>
        {label.slice(end)}
      </>
    );
  }

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (!focusedOnceRef.current) {
              focusedOnceRef.current = true;
              onFirstFocus?.();
            }
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          required={required}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          className={DEFAULT_INPUT_CLASS}
        />
        {allowMeaningToggle && (
          <div className="flex shrink-0 items-center gap-2 text-xs text-gray-300">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={searchIn !== "meaning"}
                onChange={() => toggleSearchIn("term")}
              />
              {t("searchByTerm")}
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={searchIn !== "term"}
                onChange={() => toggleSearchIn("meaning")}
              />
              {t("searchByMeaning")}
            </label>
          </div>
        )}
      </div>

      {showDropdown && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-gray-600 bg-gray-800 py-1 shadow-lg"
        >
          {visible.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-400">{t("previewNoResults")}</li>
          ) : (
            <>
              {visible.map((m, i) => (
                <li
                  key={m.entry.id}
                  data-index={i}
                  role="option"
                  aria-selected={i === highlighted}
                  onPointerDown={(e) => {
                    // pointerdown, not click: fire before the input's blur.
                    e.preventDefault();
                    selectEntry(m.entry);
                  }}
                  onMouseEnter={() => setHighlighted(i)}
                  className={`cursor-pointer px-3 py-1.5 text-sm ${
                    i === highlighted ? "bg-gray-700" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-gray-100">
                      {highlightLabel(m.entry.label, m.labelSpan)}
                    </span>
                    {m.entry.transliteration && (
                      <span className="text-xs text-gray-400">{m.entry.transliteration}</span>
                    )}
                    {m.entry.pos.length > 0 && (
                      <span className="text-xs text-gray-500">{m.entry.pos.join("/")}</span>
                    )}
                    {renderMeta?.(m.entry)}
                  </div>
                  {(m.matchedMeaning ?? m.entry.meanings[0]) && (
                    <div className="truncate text-xs text-gray-400">
                      {m.matchedMeaning ?? m.entry.meanings[0]}
                    </div>
                  )}
                </li>
              ))}
              {overflow > 0 && (
                <li className="px-3 py-1 text-xs text-gray-500">
                  {t("previewMoreResults").replace("{count}", String(overflow))}
                </li>
              )}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
