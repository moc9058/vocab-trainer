import { useEffect, useRef, useSyncExternalStore } from 'react';

const blockers = new Set<symbol>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export function useCaptureNavigationBlocker(blocked: boolean) {
  const id = useRef(Symbol('capture-navigation'));
  useEffect(() => {
    if (blocked) { blockers.add(id.current); emit(); }
    return () => { if (blockers.delete(id.current)) emit(); };
  }, [blocked]);
}
export function useCaptureNavigationBlocked() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => blockers.size > 0);
}
