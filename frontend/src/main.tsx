import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsProvider } from "./settings/context";
import { I18nProvider } from "./i18n/context";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </SettingsProvider>
  </StrictMode>,
);
