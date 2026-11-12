import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrainingSettings, TrainingSource } from '../utils/lifeTraining';
import { LifeError, lifeRequest } from './client';

export function useLifeTraining(year: number, active: boolean, onExpired: () => void) {
  const [data, setData] = useState<TrainingSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const current = data?.year === year ? data : null;
  const refresh = useCallback(async (force = false) => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError('');
    try {
      const cached = await lifeRequest<TrainingSource>('GET', { view: 'training', year }, request.signal);
      if (request.signal.aborted) return;
      setData(cached);
      if (cached.connected && (force || !cached.completions || !cached.syncedAt || Date.now() - Date.parse(cached.syncedAt) > 300_000)) {
        const result = await lifeRequest<TrainingSource>('POST', { action: 'sync-training', year }, request.signal);
        if (!request.signal.aborted) setData(result);
      }
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof LifeError && cause.status === 401) onExpired();
      else setError(cause instanceof Error ? cause.message : '运动计划读取失败，请重试');
    } finally { if (!request.signal.aborted) setBusy(false); }
  }, [year, onExpired]);
  useEffect(() => {
    if (active) void refresh();
    return () => controller.current?.abort();
  }, [active, refresh]);
  const updateSettings = (settings: TrainingSettings) => setData((previous) => previous ? { ...previous, settings } : previous);
  return { current, busy, error, refresh, updateSettings };
}
