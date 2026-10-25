import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from '@capacitor/app';
import { isNative } from '../platform/native';
import { NativeCapture, type ReadingLaunch, type LocalCapture, type NativeCapturePlugin } from '../platform/capture';

export function useCaptureInbox(source: NativeCapturePlugin = NativeCapture, enabled = isNative()) {
  const [captures, setCaptures] = useState<LocalCapture[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [launches, setLaunches] = useState<ReadingLaunch[]>([]);
  const generation = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    try {
      const result = await source.list();
      if (current !== generation.current) return;
      setLoaded(true); setCaptures(result.captures); setLaunches(result.launches ?? []); setError(null);
    } catch { if (current === generation.current) { setLoaded(true); setError('captureLoadError'); } }
  }, [source, enabled]);
  useEffect(() => {
    let live = true;
    const update = () => { if (live) void refresh(); };
    update();
    if (!enabled) return;
    const received = source.addListener('captureReceived', update);
    const active = isNative() ? App.addListener('appStateChange', ({ isActive }) => { if (isActive) update(); }) : null;
    return () => { live = false; generation.current++; void received.then(h => h.remove()).catch(() => {}); void active?.then(h => h.remove()).catch(() => {}); };
  }, [refresh]);
  return { captures, launches, loaded, error, refresh };
}
