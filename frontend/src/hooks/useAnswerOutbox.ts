import { useEffect, useSyncExternalStore } from "react";
import {
  acknowledgeFailedAnswers,
  enqueueAnswer,
  flushAnswers,
  getOutboxState,
  subscribeToOutbox,
  type OutboxState,
  type PendingAnswer,
} from "../utils/answerOutbox";

/**
 * React view of the module-level answer outbox (`utils/answerOutbox.ts`).
 *
 * The queue deliberately lives outside React so it survives the quiz component unmounting
 * (e.g. the user goes home mid-flush). This hook only subscribes to it, and adds the
 * `beforeunload` guard — a hard reload is the one thing that CAN lose unsynced answers,
 * since nothing is persisted client-side.
 */
export function useAnswerOutbox(): OutboxState & {
  enqueue: (item: PendingAnswer) => void;
  flush: () => void;
  acknowledgeFailed: () => void;
} {
  const state = useSyncExternalStore(subscribeToOutbox, getOutboxState, getOutboxState);

  useEffect(() => {
    if (state.pending === 0) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Browsers show their own wording; a non-empty returnValue is what triggers the prompt.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.pending]);

  return {
    ...state,
    enqueue: enqueueAnswer,
    flush: flushAnswers,
    acknowledgeFailed: acknowledgeFailedAnswers,
  };
}
