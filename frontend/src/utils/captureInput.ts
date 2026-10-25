import type { CaptureDraft, CaptureOperation } from '../platform/capture';

export const emptyCaptureDraft = (descriptionLanguage = 'ja'): CaptureDraft => ({
  text: '', selected: [], sourceLabel: '', sourceKind: 'unknown', sourceUrl: '',
  groupBNames: [], descriptionLanguage,
});

export function captureTextKind(text: string): 'empty' | 'url' | 'long' | 'text' {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  // Do not fetch a link, or mistake a link-only share for the selected article.
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    try { if (new URL(trimmed).hostname) return 'url'; } catch { /* ordinary text */ }
  }
  return text.length > 8000 ? 'long' : 'text';
}
export function validCaptureUrl(url: string): boolean {
  if (!url) return true;
  try { const u = new URL(url); return url.length <= 2048 && u.protocol === 'https:' && !!u.hostname && !u.username && !u.password && !/[\u0000-\u001f\u007f]/u.test(url); }
  catch { return false; }
}

export function draftFromOperation(operation: CaptureOperation, draft: CaptureDraft, parse: (operation: CaptureOperation) => import('../platform/capture').CaptureRequest): CaptureDraft {
  const request = parse(operation);
  return { ...draft, text: request.text, sourceLabel: request.sourceOrigin?.sourceLabel ?? '',
    sourceUrl: request.sourceOrigin?.sourceUrl ?? '', sourceKind: request.sourceOrigin?.sourceKind ?? 'unknown',
    wordGroupId: request.wordGroupId, grammarGroupId: request.grammarGroupId, groupBNames: request.groupBNames ?? [] };
}
