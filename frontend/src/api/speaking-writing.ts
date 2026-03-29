import { postJson, fetchJson, deleteRequest } from "./client";
import type { SpeakingWritingSession } from "../types";

export async function submitCorrection(
  language: string,
  mode: "speaking" | "writing",
  useCase: string,
  inputText: string
): Promise<SpeakingWritingSession> {
  return postJson<SpeakingWritingSession>("/api/speaking-writing/correct", {
    language,
    mode,
    useCase,
    inputText,
  });
}

export interface CorrectionStreamCallbacks {
  onChunk?: (chunk: string) => void;
  onDone?: (session: SpeakingWritingSession) => void;
  onError?: (error: string) => void;
}

export async function submitCorrectionStream(
  language: string,
  mode: "speaking" | "writing",
  useCase: string,
  inputText: string,
  callbacks: CorrectionStreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch("/api/speaking-writing/correct-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language, mode, useCase, inputText }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let terminated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ") && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6));
          switch (currentEvent) {
            case "chunk":
              callbacks.onChunk?.(data.chunk);
              break;
            case "done":
              terminated = true;
              callbacks.onDone?.(data);
              break;
            case "error":
              terminated = true;
              callbacks.onError?.(data.message ?? "Unknown error");
              break;
          }
        } catch {
          // ignore malformed JSON
        }
        currentEvent = "";
      }
    }
  }

  if (!terminated) {
    callbacks.onError?.("Connection closed unexpectedly");
  }
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
