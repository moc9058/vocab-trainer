import { useEffect } from "react";
import { useI18n } from "../../i18n/context";
import type { ImportSession } from "../../types";
import ImportFullTextReader from "./ImportFullTextReader";

export default function ImportFullTextModal({ session, onClose }: { session: ImportSession; onClose: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", handler); };
  }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-label={t("importFullText")} className="flex max-h-[92dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-900">
      <header className="flex items-center border-b border-gray-800 px-4 py-3">
        <h3 className="flex-1 font-bold text-gray-100">{t("importFullText")}</h3>
        <button type="button" onClick={onClose} aria-label={t("importCloseFullText")} className="px-2 text-xl text-gray-400">×</button>
      </header>
      <div className="overflow-y-auto px-4 py-5 sm:px-8"><ImportFullTextReader session={session} /></div>
    </section>
  </div>;
}
