import { Link } from "react-router-dom";
import { useI18n } from "../i18n/context";

/** Category entry point retained while the mathematics test mode is redesigned. */
export default function MathRoutes() {
  const { t } = useI18n();
  return (
    <main className="mx-auto max-w-3xl p-6 text-gray-100">
      <nav><Link to="/" className="text-blue-400">← {t("mathCategories")}</Link></nav>
      <h1 className="mt-6 text-2xl font-semibold">{t("mathTitle")}</h1>
      <p role="status" className="mt-4 text-gray-400">{t("mathRebuilding")}</p>
    </main>
  );
}
