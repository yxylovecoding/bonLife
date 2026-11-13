import { accountFetch } from '../utils/authClient';
import { requestWithRetry } from '../utils/requestWithRetry';
import { currentTickTickPlan, type TickTickPlanDetails } from '../utils/tickTickPlanDetails';
import type { OrchestrateProgress } from '../utils/orchestrateProgress';

// Created only while the details panel is open. Reads never dispatch a replan.
export function watchPlanDetails(callbacks: {
  onStart: () => void;
  onDetails: (details: TickTickPlanDetails | null) => void;
  onError: (error: string) => void;
  onSettled: () => void;
  onExpired: () => void;
  getJobId?: () => string | undefined;
  onProgress?: (progress: OrchestrateProgress | null, jobId?: string) => void;
}) {
  let active: AbortController | null = null;
  let disposed = false;
  function refresh() {
    if (disposed || active || document.visibilityState === 'hidden') return;
    const request = new AbortController(); active = request;
    const jobId = callbacks.getJobId?.();
    callbacks.onStart();
    void requestWithRetry(async signal => {
      const response = await accountFetch(`/api/ticktick-trips?action=plan-details${jobId ? `&jobId=${encodeURIComponent(jobId)}` : ''}`, {
        credentials: 'same-origin', cache: 'no-store', signal,
      });
      if (response.status === 401) { callbacks.onExpired(); return null; }
      const data = await response.json() as { details?: TickTickPlanDetails | null; progress?: OrchestrateProgress | null; error?: string };
      if (!response.ok) throw new Error(data.error || '排期详情读取失败');
      if (!request.signal.aborted) callbacks.onProgress?.(data.progress ?? null, jobId);
      return data.details ?? null;
    }, { signal: request.signal, retry: true, timeoutMessage: '排期详情读取超时，请重试', networkMessage: '排期详情读取失败，请重试' })
      .then(details => { if (!request.signal.aborted) callbacks.onDetails(currentTickTickPlan(details)); })
      .catch(cause => { if (!request.signal.aborted) callbacks.onError(cause instanceof Error ? cause.message : '排期详情读取失败'); })
      .finally(() => {
        if (active === request) active = null;
        if (!request.signal.aborted) callbacks.onSettled();
      });
  }
  const timer = window.setInterval(refresh, 30_000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true; active?.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    },
  };
}
