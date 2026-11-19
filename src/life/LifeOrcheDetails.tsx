import type { OrchestrateProgress } from '../utils/orchestrateProgress';
import type { TickTickPlanDetails } from '../utils/tickTickPlanDetails';
import LifePlanDetails from './LifePlanDetails';

const ruleLabels = { completed: '已完成', deferred: '暂缓', failed: '失败' } as const;

export default function LifeOrcheDetails({ progress, detailsLoading, detailsError, planDetails }: {
  progress: OrchestrateProgress | null;
  detailsLoading: boolean;
  detailsError: string;
  planDetails: TickTickPlanDetails | null;
}) {
  return <section id="life-orche-details" aria-label="当前排期" aria-busy={detailsLoading}>
    {progress && <p className={progress.state === 'failed' ? 'life-error' : 'life-empty-state'}
      role={progress.state === 'failed' ? 'alert' : 'status'}>{progress.message}</p>}
    {progress && (['completed', 'deferred', 'failed'] as const).map(kind => {
      const rules = progress[kind];
      return rules?.length ? <p className="life-empty-state" key={kind}>{ruleLabels[kind]}：{rules.join('、')}</p> : null;
    })}
    {detailsLoading && !planDetails ? <p className="life-empty-state" role="status">读取中…</p>
      : detailsError ? <p className="life-error" role="alert">{detailsError}</p>
        : planDetails ? <LifePlanDetails plan={planDetails} /> : !progress && <p className="life-empty-state">今日暂无排期记录</p>}
  </section>;
}
