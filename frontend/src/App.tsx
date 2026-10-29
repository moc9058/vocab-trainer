import ExtensionConnections, { rememberExtensionApproval, CONNECTION_RETURN } from './components/ExtensionConnections';
import { lazy, Suspense } from "react";
const MathRoutes = lazy(() => import("./math/MathRoutes"));
import CaptureLaunchNotice from './components/capture/CaptureLaunchNotice';
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import LanguageSelectPage from "./components/LanguageSelectPage";
import StudyLanguageRoute from "./components/StudyLanguageRoute";
import LoginPage from "./components/LoginPage";
import { useAuth } from "./auth/context";

export default function App() {
  const { status, resumeEpoch } = useAuth();
  if (status === "loading" || status === "anon" || status === "unavailable") rememberExtensionApproval();
  const location = useLocation();
  const quizRoute = /\/(quiz|grammar-quiz|combined-quiz|mixed-quiz|import-quiz-[ab]|expression-recall|expression-quiz)(\/|$)/.test(location.pathname);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-900">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-blue-500" />
      </div>
    );
  }

  if ((status === "anon" || status === "unavailable")) {
    return <LoginPage />;
  }

  if (location.pathname === '/') {
    try {
      const pending = JSON.parse(sessionStorage.getItem(CONNECTION_RETURN) ?? 'null');
      if (pending?.expiresAt > Date.now() && /^[A-Za-z0-9_-]{43}$/.test(pending.id)) return <Navigate to={`/extension/connect?id=${pending.id}`} replace />;
      sessionStorage.removeItem(CONNECTION_RETURN);
    } catch { sessionStorage.removeItem(CONNECTION_RETURN); }
  }
  return (
    <>
    <CaptureLaunchNotice />
    <Routes key={quizRoute ? resumeEpoch : 0}>
      <Route path="/extension/connect" element={<ExtensionConnections />} />
      <Route path="/extension/connections" element={<ExtensionConnections />} />
      <Route path="/" element={<LanguageSelectPage />} />
      <Route path="/math/*" element={<Suspense fallback={<div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-blue-500" />}><MathRoutes /></Suspense>} />
      <Route path="/:language/*" element={<StudyLanguageRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
