import { postJson, fetchJson, deleteRequest } from "./client";
import type { SpeakingWritingSession } from "../types";

export async function submitCorrection(
  language: string,
  mode: "speaking" | "writing",
  inputText: string
): Promise<SpeakingWritingSession> {
  return postJson<SpeakingWritingSession>("/api/speaking-writing/correct", {
    language,
    mode,
    inputText,
  });
}

export async function getSpeakingWritingSession(
  language: string
): Promise<SpeakingWritingSession | null> {
  try {
    return await fetchJson<SpeakingWritingSession>(
      `/api/speaking-writing/session/${encodeURIComponent(language)}`
    );
  } catch {
    return null;
  }
}

export async function deleteSpeakingWritingSession(
  language: string
): Promise<void> {
  await deleteRequest(`/api/speaking-writing/session/${encodeURIComponent(language)}`);
}
