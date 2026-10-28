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

  return (
    <>
    <CaptureLaunchNotice />
    <Routes key={quizRoute ? resumeEpoch : 0}>
      <Route path="/" element={<LanguageSelectPage />} />
      <Route path="/math/*" element={<Suspense fallback={<div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-blue-500" />}><MathRoutes /></Suspense>} />
      <Route path="/:language/*" element={<StudyLanguageRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
