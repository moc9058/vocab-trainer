import { useSearchParams } from "react-router-dom";
import { useI18n } from "../i18n/context";
import { useAuth } from "../auth/context";

function GoogleMark() {
  return (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

export default function LoginPage() {
  const { t } = useI18n();
  const { login } = useAuth();
  const [searchParams] = useSearchParams();
  const error = searchParams.get("auth_error");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-900 p-6">
      <h1 className="mb-2 text-3xl font-bold text-gray-100">{t("appTitle")}</h1>
      <p className="mb-8 text-center text-gray-400">{t("signInPrompt") ?? "Sign in to continue"}</p>

      {error && (
        <div
          role="alert"
          className="mb-6 w-full max-w-sm rounded-xl border border-red-800 bg-red-950/50 px-4 py-3 text-center text-sm text-red-300"
        >
          {error === "forbidden"
            ? (t("authForbidden") ?? "This Google account is not authorized to use this app.")
            : (t("authError") ?? "Sign-in failed. Please try again.")}
        </div>
      )}

      <button
        onClick={login}
        className="flex w-full max-w-sm items-center justify-center gap-3 rounded-xl border border-gray-600 bg-gray-800 px-6 py-3.5 text-sm font-medium text-gray-100 hover:border-blue-500 hover:bg-gray-700 transition-colors"
      >
        <GoogleMark />
        {t("signInWithGoogle") ?? "Sign in with Google"}
      </button>
    </div>
  );
}
