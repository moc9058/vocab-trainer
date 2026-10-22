import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../api/quiz', () => ({ answerQuestion: vi.fn(), markQuizReviewComplete: vi.fn() }));
import { answerQuestion } from '../api/quiz';
import { ApiError } from '../api/client';
import { discardAnswers, enqueueAnswer, flushAnswers, getOutboxState, resumeAnswers, waitForAnswers } from './answerOutbox';
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { discardAnswers(); vi.clearAllMocks(); });
it('holds the head and later writes on 401 until confirmed authentication, preserving order', async () => {
  vi.mocked(answerQuestion).mockRejectedValueOnce(new ApiError(401, 'expired')).mockResolvedValue({} as never);
  enqueueAnswer({ domain: 'word', sessionId: 's', wordId: 'one', correct: true }); await settle();
  enqueueAnswer({ domain: 'word', sessionId: 's', wordId: 'two', correct: false });
  flushAnswers(); await settle();
  expect(getOutboxState()).toMatchObject({ pending: 2, failed: 0, authBlocked: true });
  expect(answerQuestion).toHaveBeenCalledTimes(1); expect(await waitForAnswers()).toBe('auth');
  resumeAnswers(); expect(await waitForAnswers()).toBe('synced');
  expect(vi.mocked(answerQuestion).mock.calls.map(([args]) => args.wordId)).toEqual(['one', 'one', 'two']);
});
it('distinguishes a permanent rejection and an unfinished offline queue', async () => {
  vi.mocked(answerQuestion).mockRejectedValueOnce(new ApiError(403, 'forbidden'));
  enqueueAnswer({ domain: 'word', sessionId: 's', wordId: 'one', correct: true }); await settle();
  expect(await waitForAnswers()).toBe('failed'); discardAnswers();
  vi.mocked(answerQuestion).mockRejectedValue(new TypeError('offline'));
  enqueueAnswer({ domain: 'word', sessionId: 's', wordId: 'two', correct: false }); await settle();
  expect(await waitForAnswers(1)).toBe('pending'); expect(getOutboxState().pending).toBe(1);
});
