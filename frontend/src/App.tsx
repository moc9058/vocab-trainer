import { Routes, Route, Navigate } from "react-router-dom";
import LanguageSelectPage from "./components/LanguageSelectPage";
import Dashboard from "./components/Dashboard";
import LoginPage from "./components/LoginPage";
import { useAuth } from "./auth/context";

export default function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-900">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-blue-500" />
      </div>
    );
  }

  if (status === "anon") {
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route path="/" element={<LanguageSelectPage />} />
      <Route path="/:language/*" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
