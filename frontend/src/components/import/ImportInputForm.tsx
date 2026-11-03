import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/context';

const MAX_TEXT = 8000;
const LONG_TEXT_WARNING = 1500;

/** Shared presentation; acquisition, draft persistence and retries stay with the caller. */
export default function ImportInputForm({ text, onTextChange, onCancel, onSubmit, options, error, disabled = false, readOnly = false, cancelDisabled = false, submitLabel }: {
  text: string; onTextChange: (text: string) => void; onCancel: () => void;
  onSubmit: () => void; options?: ReactNode; error?: ReactNode;
  disabled?: boolean; readOnly?: boolean; cancelDisabled?: boolean; submitLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-5xl px-3 py-4 sm:p-6">
        <header className="mb-5 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-gray-100 sm:text-lg">{t("importNewSession")}</h2>
            <p className="mt-1 text-xs text-gray-400 sm:text-sm">{t("importDescription")}</p>
          </div>
          <button
            disabled={cancelDisabled}
            onClick={onCancel}
            className="shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-gray-500 hover:text-gray-200 sm:text-sm"
          >
            {t("cancel")}
          </button>
        </header>

        {error && (
          <div className="mb-4 rounded-lg border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[1fr_19rem] lg:gap-5">
          <div>
            {/* `text-base` keeps iOS from zooming the viewport on focus — the
                usual cause of a page that suddenly scrolls sideways. */}
            <textarea
              aria-label={t("captureConfirmText")}
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              disabled={readOnly}
              rows={16}
              placeholder={t("importPastePlaceholder")}
              className="h-48 w-full resize-y rounded-2xl border border-gray-700 bg-gray-800/60 px-3 py-3 text-base leading-relaxed text-gray-100 placeholder-gray-600 focus:border-indigo-500 focus:outline-none sm:h-auto sm:px-4 sm:text-[15px]"
            />
            <p
              className={`mt-1 text-right text-xs ${
                text.length > LONG_TEXT_WARNING ? "text-amber-500/90" : "text-gray-600"
              }`}
            >
              {text.length} / {MAX_TEXT}
            </p>
            {text.length > LONG_TEXT_WARNING && (
              <p className="mt-1 rounded-lg border border-amber-700/50 bg-amber-950/25 px-3 py-2 text-[11px] leading-snug text-amber-200/90">
                {t("importLongTextWarning")}
              </p>
            )}
          </div>

          <div className="space-y-3">
            {options}
            <button
              onClick={onSubmit}
              disabled={disabled || !text.trim() || text.length > MAX_TEXT}
              className="w-full rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitLabel ?? t("importAnalyze")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
