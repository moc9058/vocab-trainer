import { postJson, fetchJson, deleteRequest } from "./client";
import type { TranslationEntry, TranslationResult } from "../types";

export async function translate(
  sourceText: string,
  targetLanguages: string[]
): Promise<TranslationEntry> {
  return postJson<TranslationEntry>("/api/translation/translate", {
    sourceText,
    targetLanguages,
  });
}

export interface TranslateStreamCallbacks {
  onStart?: (language: string) => void;
  onChunk?: (language: string, chunk: string) => void;
  onResult?: (language: string, result: TranslationResult) => void;
  onDone?: (entry: TranslationEntry) => void;
  onError?: (error: Error) => void;
}

export async function translateStream(
  sourceText: string,
  targetLanguages: string[],
  callbacks: TranslateStreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch("/api/translation/translate-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceText, targetLanguages }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

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
            case "start":
              callbacks.onStart?.(data.language);
              break;
            case "chunk":
              callbacks.onChunk?.(data.language, data.chunk);
              break;
            case "result":
              callbacks.onResult?.(data.language, data.result);
              break;
            case "done":
              callbacks.onDone?.(data);
              break;
          }
        } catch {
          // ignore malformed JSON
        }
        currentEvent = "";
      }
    }
  }
}

export async function getTranslationHistory(
  page = 1,
  limit = 50
): Promise<{ entries: TranslationEntry[]; total: number }> {
  return fetchJson<{ entries: TranslationEntry[]; total: number }>(
    `/api/translation/history?page=${page}&limit=${limit}`
  );
}

export async function deleteTranslationHistory(): Promise<void> {
  return deleteRequest("/api/translation/history");
}

export async function deleteTranslationEntryById(id: string): Promise<void> {
  return deleteRequest(`/api/translation/history/${id}`);
}
