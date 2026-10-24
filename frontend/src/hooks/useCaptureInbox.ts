import { useCallback, useEffect, useState } from 'react';
import { App } from '@capacitor/app';
import { isNative } from '../platform/native';
import { NativeCapture, type LocalCapture } from '../platform/capture';

export function useCaptureInbox() {
  const [captures, setCaptures] = useState<LocalCapture[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!isNative()) return;
    try { setCaptures((await NativeCapture.list()).captures); setError(null); }
    catch { setError('captureLoadError'); }
  }, []);
  useEffect(() => {
    let live = true;
    const update = () => { if (live) void refresh(); };
    update();
    if (!isNative()) return;
    const received = NativeCapture.addListener('captureReceived', update);
    const active = App.addListener('appStateChange', ({ isActive }) => { if (isActive) update(); });
    return () => { live = false; void received.then(h => h.remove()); void active.then(h => h.remove()); };
  }, [refresh]);
  return { captures, error, refresh };
}
