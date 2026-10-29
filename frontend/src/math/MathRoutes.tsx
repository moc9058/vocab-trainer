import { Route, Routes, useLocation, Link } from "react-router-dom";
import { useI18n } from "../i18n/context";
import MathLibrary from "./MathLibrary";
import MathTestPage from "./MathTestPage";
import "./math.css";
export default function MathRoutes() {
  const location = useLocation();
  const { t } = useI18n();
  return (
    <main className="math-page">
      <Routes>
        <Route index element={<MathLibrary />} />
        <Route
          path="tests/:id"
          element={<MathTestPage key={location.pathname} />}
        />
        <Route
          path="*"
          element={
            <section className="math-panel">
              <h1>{t("mathNotFound")}</h1>
              <Link className="math-back" to="/math">
                {t("mathLibrary")}
              </Link>
            </section>
          }
        />
      </Routes>
    </main>
  );
}
