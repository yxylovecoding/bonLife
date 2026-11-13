import { useEffect, useRef, useState } from 'react';
import { accountFetch } from '../utils/authClient';
import { currentTickTickPlan, type TickTickPlanDetails } from '../utils/tickTickPlanDetails';
import { watchPlanDetails } from './watchPlanDetails';
import type { OrchestrateProgress } from '../utils/orchestrateProgress';

export function useOrchestrate(onExpired: () => void) {
  const [replanning, setReplanning] = useState(false);
  const [replanMessage, setReplanMessage] = useState('');
  const [replanError, setReplanError] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [planDetails, setPlanDetails] = useState<TickTickPlanDetails | null>(null);
  const [progress, setProgress] = useState<OrchestrateProgress | null>(null);
  const jobId = useRef<string>();
  const replanController = useRef<AbortController | null>(null);
  const detailsWatcher = useRef<ReturnType<typeof watchPlanDetails> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; replanController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!detailsOpen) return;
    setPlanDetails(null);
    const watcher = watchPlanDetails({
      onStart: () => { setDetailsLoading(true); setDetailsError(''); setPlanDetails(currentTickTickPlan); },
      onDetails: setPlanDetails,
      onError: setDetailsError,
      onSettled: () => setDetailsLoading(false),
      onExpired,
      getJobId: () => jobId.current,
      onProgress: (next, readJobId) => {
        if (jobId.current !== readJobId) return;
        setProgress(next);
        if (next?.state === 'success' || next?.state === 'failed' || next?.state === 'partial') jobId.current = undefined;
      },
    });
    detailsWatcher.current = watcher;
    return () => { watcher.dispose(); detailsWatcher.current = null; };
  }, [detailsOpen, onExpired]);

  async function triggerReplan() {
    if (replanController.current) return;
    const request = new AbortController(); replanController.current = request;
    const timer = window.setTimeout(() => request.abort(), 20_000);
    setReplanning(true); setReplanError(''); setReplanMessage('');
    try {
      const response = await accountFetch('/api/ticktick-trips?action=trigger-replan', {
        method: 'POST', credentials: 'same-origin', signal: request.signal,
      });
      if (response.status === 401) { onExpired(); return; }
      const result = await response.json() as { triggered?: boolean; jobId?: string; error?: string };
      if (!response.ok || !result.triggered) throw new Error(result.error || 'Orchestrate 提交失败，请重试');
      if (mounted.current && !request.signal.aborted) {
        setReplanMessage('Orchestrate 已提交');
        jobId.current = result.jobId;
        setProgress({ state: 'queued', message: 'Orchestrate 排队中…' });
        setDetailsOpen(true);
        detailsWatcher.current?.refresh();
      }
    } catch (cause) {
      if (mounted.current) setReplanError(request.signal.aborted ? 'Orchestrate 提交结果暂未确认，请稍后查看更新结果'
        : cause instanceof TypeError ? 'Orchestrate 提交失败，请检查网络后重试'
          : cause instanceof Error ? cause.message : 'Orchestrate 提交失败，请重试');
    } finally {
      clearTimeout(timer);
      if (replanController.current === request) replanController.current = null;
      if (mounted.current) setReplanning(false);
    }
  }

  function toggleDetails() {
    setDetailsOpen(open => !open);
  }
  return { replanning, progress, replanMessage, replanError, triggerReplan, detailsOpen, detailsLoading, detailsError, planDetails, toggleDetails };
}
