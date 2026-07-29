import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { SettingsProvider } from "./settings/context";
import { I18nProvider } from "./i18n/context";
import { AuthProvider } from "./auth/context";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SettingsProvider>
        {/* AuthProvider sits inside I18nProvider so the login screen can translate itself. */}
        <I18nProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </I18nProvider>
      </SettingsProvider>
    </BrowserRouter>
  </StrictMode>,
);
