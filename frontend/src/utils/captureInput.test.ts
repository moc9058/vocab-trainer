import { describe, expect, it } from 'vitest';
import { captureTextKind, draftFromOperation, emptyCaptureDraft, validCaptureUrl } from './captureInput';
import { pendingCaptureRequest, type CaptureRequest } from '../platform/capture';

describe('capture input boundaries', () => {
  it('distinguishes a link from shared Chinese text and never trims the stored original', () => {
    expect(captureTextKind(' \n ')).toBe('empty');
    expect(captureTextKind(' https://example.com/article \n')).toBe('url');
    expect(captureTextKind('http://example.com')).toBe('url');
    expect(captureTextKind('這是文章。 https://example.com')).toBe('text');
    expect(captureTextKind('臺灣经济，GDP😊。')).toBe('text');
  });
  it('uses UTF-16 limits consistently with native reception without splitting emoji', () => {
    expect(captureTextKind('字'.repeat(7998) + '😊')).toBe('text');
    expect(captureTextKind('字'.repeat(7999) + '😊')).toBe('long');
  });
  it('only accepts credential-free HTTPS source links', () => {
    expect(validCaptureUrl('')).toBe(true);
    expect(validCaptureUrl('https://example.com/文章')).toBe(true);
    for (const value of ['http://example.com', 'https://a:b@example.com', 'javascript:alert(1)', 'https://example.com/\nsecret']) expect(validCaptureUrl(value)).toBe(false);
  });
  it('restores the frozen request rather than edited text, source or destinations', () => {
    const request = { text: '確認済み', sourceOrigin: { version: 1, method: 'shared-text', sourceKind: 'article', textConfirmed: true, sourceLabel: '财新' }, wordGroupId: 'a', grammarGroupId: 'grammar-a', groupBNames: ['article-b'] } as CaptureRequest;
    const operation = { request: JSON.stringify(request), createdAt: new Date().toISOString() };
    const draft = { ...emptyCaptureDraft(), text: 'later edit', sourceLabel: 'wrong', groupBNames: ['wrong'] };
    expect(draftFromOperation(operation, draft, pendingCaptureRequest)).toMatchObject({ text: '確認済み', sourceLabel: '财新', sourceKind: 'article', wordGroupId: 'a', grammarGroupId: 'grammar-a', groupBNames: ['article-b'] });
    expect(() => pendingCaptureRequest({ ...operation, createdAt: new Date(Date.now() - 86400000).toISOString() })).toThrow('CAPTURE_EXPIRED');
  });
});
