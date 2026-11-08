import { useEffect, useRef, useState } from 'react';
import { accountFetch } from '../utils/authClient';
import { requestWithRetry } from '../utils/requestWithRetry';
import type { TickTickPlanDetails } from '../utils/tickTickPlanDetails';

export function useOrchestrate(onExpired: () => void) {
  const [replanning, setReplanning] = useState(false);
  const [replanMessage, setReplanMessage] = useState('');
  const [replanError, setReplanError] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [planDetails, setPlanDetails] = useState<TickTickPlanDetails | null>(null);
  const replanController = useRef<AbortController | null>(null);
  const detailsController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; replanController.current?.abort(); detailsController.current?.abort(); };
  }, []);

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
      const result = await response.json() as { triggered?: boolean; error?: string };
      if (!response.ok || !result.triggered) throw new Error(result.error || 'Orchestrate 提交失败，请重试');
      if (mounted.current && !request.signal.aborted) setReplanMessage('Orchestrate 已提交');
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
    detailsController.current?.abort();
    setDetailsOpen(!detailsOpen);
    if (detailsOpen) return;
    const request = new AbortController(); detailsController.current = request;
    setDetailsLoading(true); setDetailsError(''); setPlanDetails(null);
    void requestWithRetry(async signal => {
      const response = await accountFetch('/api/ticktick-trips?action=plan-details', { credentials: 'same-origin', signal });
      if (response.status === 401) { onExpired(); return null; }
      const data = await response.json() as { details?: TickTickPlanDetails | null; error?: string };
      if (!response.ok) throw new Error(data.error || '排期详情读取失败');
      return data.details ?? null;
    }, { signal: request.signal, retry: true, timeoutMessage: '排期详情读取超时，请重试', networkMessage: '排期详情读取失败，请重试' })
      .then(details => { if (!request.signal.aborted) setPlanDetails(details); })
      .catch(cause => { if (!request.signal.aborted) setDetailsError(cause instanceof Error ? cause.message : '排期详情读取失败'); })
      .finally(() => { if (!request.signal.aborted) setDetailsLoading(false); });
  }
  return { replanning, replanMessage, replanError, triggerReplan, detailsOpen, detailsLoading, detailsError, planDetails, toggleDetails };
}
