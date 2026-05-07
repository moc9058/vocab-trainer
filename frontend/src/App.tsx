import { Routes, Route, Navigate } from "react-router-dom";
import LanguageSelectPage from "./components/LanguageSelectPage";
import Dashboard from "./components/Dashboard";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LanguageSelectPage />} />
      <Route path="/:language" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
