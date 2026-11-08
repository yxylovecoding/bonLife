import { useEffect, useRef, type Ref } from 'react';
import LifeSchedulingRules from './LifeSchedulingRules';
import LifeTaskDateStatus from './LifeTaskDateStatus';

export default function LifeOrchestrator({ onClose, onExpired, onManageOutlook, onManageCycle, cycleDisabled, recordsControlsRef }: {
  onClose: () => void;
  onExpired: () => void;
  onManageOutlook: () => void;
  onManageCycle: () => void;
  cycleDisabled: boolean;
  recordsControlsRef?: Ref<HTMLDivElement>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} id="life-orchestrator" className="life-orchestrator" aria-labelledby="life-orchestrator-title"
    onCancel={event => { if (event.target === event.currentTarget) { event.preventDefault(); onClose(); } }}>
    <div className="persistent-form">
      <div className="life-editor-heading"><h2 id="life-orchestrator-title">Orchestrator</h2></div>
      <div className="persistent-form-body">
        <div className="life-orchestrator-actions">
          <button type="button" onClick={onManageOutlook}>连接 Outlook</button>
          <button type="button" disabled={cycleDisabled} onClick={onManageCycle}>经期设置</button>
        </div>
        {recordsControlsRef && <div ref={recordsControlsRef} />}
        <LifeSchedulingRules onExpired={onExpired} onManageOutlook={onManageOutlook} />
        <LifeTaskDateStatus onExpired={onExpired} />
      </div>
      <div className="life-editor-actions"><button type="button" onClick={onClose}>关闭</button></div>
    </div>
  </dialog>;
}
