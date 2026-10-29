import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { ImportSession, ImportSourceOrigin } from '../types';

export interface CaptureRect { left: number; top: number; width: number; height: number }
export interface CaptureBlock { id: string; text: string; rects: CaptureRect[]; confidence: number }
export type CaptureRequest = Omit<ImportSession, 'id' | 'language' | 'createdAt' | 'updatedAt'> & { analyzeAsJob: true; ingestionId: string };
export interface CaptureOperation { request: string; createdAt: string; sessionId?: string }
export interface CaptureDraft {
  automaticAnalysisStarted?: boolean;
  text: string; selected: string[]; sourceLabel: string; sourceKind: ImportSourceOrigin['sourceKind']; sourceUrl: string;
  blockId?: string; wordGroupId?: string; grammarGroupId?: string; groupBNames: string[]; descriptionLanguage: string;
}
export interface ReadingLaunch { id: string; receivedAt: string; sourceUrl?: string; acknowledged: boolean }
export interface LocalCapture {
  id: string; receivedAt: string; inputKind: 'text' | 'image'; method: ImportSourceOrigin['method'];
  text?: string; width?: number; height?: number; imageUrl?: string;
  draft?: CaptureDraft; blocks?: CaptureBlock[]; operations: Record<string, CaptureOperation>; acknowledged: boolean;
}
export interface NativeCapturePlugin {
  list(): Promise<{ captures: LocalCapture[]; launches: ReadingLaunch[] }>;
  receiveText(input: { text: string }): Promise<LocalCapture>;
  saveDraft(input: { id: string; draft: CaptureDraft }): Promise<void>;
  acknowledgeLaunch(input: { id: string }): Promise<void>;
  load(input: { id: string }): Promise<LocalCapture>;
  recognize(input: { id: string }): Promise<LocalCapture>;
  pickImage(): Promise<{ id?: string; cancelled?: boolean }>;
  acknowledge(input: { id: string }): Promise<void>;
  recordOperation(input: { id: string; blockId: string; request: string; sessionId?: string }): Promise<void>;
  discard(input: { id: string }): Promise<void>;
  discardAll(): Promise<void>;
  addListener(event: 'captureReceived', listener: () => void): Promise<PluginListenerHandle>;
}
export const NativeCapture = registerPlugin<NativeCapturePlugin>('NativeCapture');

/** Refuse expired retries even if the OS has not yet physically cleaned the inbox. */
export function pendingCaptureRequest(operation: CaptureOperation): CaptureRequest {
  if (!Number.isFinite(Date.parse(operation.createdAt)) || Date.now() - Date.parse(operation.createdAt) >= 86400000) throw new Error('CAPTURE_EXPIRED');
  return JSON.parse(operation.request) as CaptureRequest;
}
