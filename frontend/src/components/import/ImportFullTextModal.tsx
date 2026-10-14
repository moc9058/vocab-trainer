import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/context";
import { sentenceRubySegments } from "../../utils/importSession";
import type { ImportSession } from "../../types";
import RubyText from "../RubyText";

const FULL_TEXT_PINYIN_PREF_KEY = "importShowFullTextPinyin";

interface Props {
  session: ImportSession;
  onClose: () => void;
}

export default function ImportFullTextModal({ session, onClose }: Props) {
  const { t } = useI18n();
  const isChinese = session.language === "chinese";
  const [showPinyin, setShowPinyin] = useState(
    () => localStorage.getItem(FULL_TEXT_PINYIN_PREF_KEY) !== "0"
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  function togglePinyin() {
    setShowPinyin((previous) => {
      localStorage.setItem(FULL_TEXT_PINYIN_PREF_KEY, previous ? "0" : "1");
      return !previous;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-full-text-title"
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-gray-800 px-4 py-3 sm:px-6">
          <h3 id="import-full-text-title" className="min-w-0 flex-1 truncate text-base font-bold text-gray-100 sm:text-lg">
            {t("importFullText")}
          </h3>
          {isChinese && (
            <button
              type="button"
              onClick={togglePinyin}
              aria-pressed={showPinyin}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs ${
                showPinyin
                  ? "border-indigo-600/70 bg-indigo-950/40 text-indigo-200"
                  : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"
              }`}
            >
              {showPinyin ? t("importHideFullTextPinyin") : t("importShowFullTextPinyin")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("importCloseFullText")}
            className="shrink-0 rounded-lg px-2 py-1 text-xl leading-none text-gray-400 hover:bg-gray-800 hover:text-gray-100"
          >
            ×
          </button>
        </header>

        <div className="overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
          <article className="mx-auto max-w-3xl space-y-5 text-[17px] leading-[2.15] text-gray-100 sm:text-lg">
            {session.paragraphs.map((paragraph, paragraphIndex) => (
              <p key={paragraphIndex} className="break-words">
                {paragraph.sentences.map((sentence, sentenceIndex) => {
                  const segments = sentenceRubySegments(session.items, sentence.index);
                  return (
                    <span key={sentence.index}>
                      {sentenceIndex > 0 && " "}
                      <RubyText
                        text={sentence.text}
                        segments={isChinese && showPinyin ? segments : undefined}
                      />
                    </span>
                  );
                })}
              </p>
            ))}
          </article>
        </div>
      </section>
    </div>
  );
}
