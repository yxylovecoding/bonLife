import { useCallback, useEffect, useRef, useState } from 'react';
import { accountFetch } from '../utils/authClient';
import { useDragSort } from '../hooks/useDragSort';
import { SCHEDULING_RULES, activeRuleOrder, assignRuleGroup, updateRuleGroups, removeSchedulingRule, restoreSchedulingRule, readRuleConfig, ruleTitle, type SchedulingRuleConfig, type SchedulingRuleGroup, type SchedulingRuleId, type SchedulingRun } from '../utils/schedulingRules';
import { RuleMoveMenu, RulePredecessors, RuleTags } from './SchedulingRuleControls';
import './schedulingRules.css';

interface Connection { id: string; name: string; kind: 'subscription' | 'period' | 'write'; connected: boolean; syncedAt?: string; error?: string; retryAt?: string }
interface Reply { config: SchedulingRuleConfig; lastRun?: SchedulingRun; outlook?: Connection[]; triggered?: boolean; error?: string }
const endpoint = '/api/ticktick-trips?action=rules';
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type TagInputs = Partial<Record<SchedulingRuleId, string>>;
function withPendingTags(draft: SchedulingRuleConfig, inputs: TagInputs) {
  const tags = { ...draft.tags };
  for (const [key, input] of Object.entries(inputs)) {
    const id = key as SchedulingRuleId;
    tags[id] = [...tags[id] ?? [], ...input.split(/[,，、;；\n]+/).map(tag => tag.trim()).filter(Boolean)];
  }
  return readRuleConfig({ ...draft, tags });
}

function GroupRules({ group, draft, busy, expanded, setExpanded, change, onDragging, onRename, tagInputs, onTagInput, onAddTags }: {
  group: SchedulingRuleGroup; draft: SchedulingRuleConfig; busy: boolean; expanded: SchedulingRuleId | null;
  setExpanded: (id: SchedulingRuleId | null) => void;
  change: (work: () => SchedulingRuleConfig) => boolean; onDragging: (active: boolean) => void;
  onRename: (id: SchedulingRuleId, name: string) => void;
  tagInputs: TagInputs; onTagInput: (id: SchedulingRuleId, value: string) => void; onAddTags: (id: SchedulingRuleId) => void;
}) {
  const reorder = (rules: SchedulingRuleId[]) => change(() => updateRuleGroups(draft, draft.groups!.map(item => item.id === group.id ? { ...item, rules } : item), true));
  const drag = useDragSort(group.rules, reorder);
  useEffect(() => { onDragging(drag.draggingIdx !== null); return () => onDragging(false); }, [drag.draggingIdx, onDragging]);
  return <ol className="schedule-rules-list">{group.rules.map((id, index) => <li key={id} value={draft.order.indexOf(id) + 1}
    ref={element => drag.itemRef(element, index)} className={drag.draggingIdx === index ? 'is-dragging' : ''}>
    <div className="schedule-rule-heading">
      <button type="button" {...(!busy ? drag.handleProps(index) : {})} className="schedule-drag" disabled={busy}
        aria-label={`拖动${ruleTitle(id, draft)}，也可用上下方向键移动`}
        onKeyDown={event => {
          const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : index;
          if (to === index) return; event.preventDefault();
          if (to >= 0 && to < group.rules.length) {
            const rules = [...group.rules]; rules.splice(to, 0, rules.splice(index, 1)[0]); reorder(rules);
          }
        }}>⠿</button>
      <span className="schedule-number">{draft.order.indexOf(id) + 1}</span>
      <input className="schedule-rule-name" aria-label={`${ruleTitle(id)}的规则名称`} value={ruleTitle(id, draft)} maxLength={40} disabled={busy}
        onChange={event => onRename(id, event.target.value)} />
      <button type="button" disabled={busy} className="schedule-predecessor-toggle" aria-expanded={expanded === id}
        onClick={() => setExpanded(expanded === id ? null : id)}>前序 {(draft.predecessors[id] ?? []).length || ''}</button>
    </div>
    <p>{SCHEDULING_RULES.find(rule => rule[0] === id)![2]}</p>
    <RuleTags tags={draft.tags?.[id]} name={ruleTitle(id, draft)} disabled={busy}
      onRemove={tag => change(() => readRuleConfig({ ...draft, tags: { ...draft.tags, [id]: draft.tags![id]!.filter(value => value !== tag) } }))} />
    <div className="schedule-rule-tools">
      <RuleMoveMenu name={ruleTitle(id, draft)} groups={draft.groups!} currentGroup={group.id} disabled={busy}
        onMove={groupId => change(() => assignRuleGroup(draft, id, groupId))} />
      <div className="schedule-tag-entry"><input aria-label={`${ruleTitle(id, draft)}添加标签`} placeholder="添加标签" list="schedule-tag-options"
        value={tagInputs[id] ?? ''} disabled={busy} onChange={event => onTagInput(id, event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onAddTags(id); }
        }} />
        <button type="button" disabled={busy || !tagInputs[id]?.trim()} title="添加标签" aria-label={`添加${ruleTitle(id, draft)}的标签`}
          onClick={() => onAddTags(id)}>＋</button>
      </div>
      <button type="button" disabled={busy} className="schedule-remove-rule" aria-label={`删除规则${ruleTitle(id, draft)}`}
      onClick={() => change(() => removeSchedulingRule(draft, id))}>删除</button></div>
    {!!draft.predecessors[id]?.length && <div className="schedule-predecessors">{draft.predecessors[id]!.map(rule => ruleTitle(rule, draft)).join('、')} → {ruleTitle(id, draft)}</div>}
    {expanded === id && <RulePredecessors id={id} draft={draft} disabled={busy} onToggle={(parent, checked) => change(() => readRuleConfig({ ...draft,
      predecessors: { ...draft.predecessors, [id]: checked ? [...draft.predecessors[id] ?? [], parent] : (draft.predecessors[id] ?? []).filter(p => p !== parent) },
    }))} />}
  </li>)}</ol>;
}

export function RuleEditor({ initial, onSave, onClose }: {
  initial: SchedulingRuleConfig; onSave: (config: SchedulingRuleConfig) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => readRuleConfig(initial));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [expanded, setExpanded] = useState<SchedulingRuleId | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readRuleConfig(initial).groups!.map(group => group.id)));
  const [ruleDragging, setRuleDragging] = useState(false);
  const [restoreGroup, setRestoreGroup] = useState('');
  const [tagInputs, setTagInputs] = useState<TagInputs>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const scrollBody = useRef<HTMLDivElement>(null);
  const newGroupFocus = useRef<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!newGroupFocus.current) return;
    dialog.current?.querySelector<HTMLInputElement>(`input[data-group-id="${newGroupFocus.current}"]`)?.focus();
    newGroupFocus.current = null;
  }, [draft.groups]);
  const change = (work: () => SchedulingRuleConfig) => {
    if (busy) return false;
    try { setDraft(work()); setError(''); return true; } catch (cause) { setError((cause as Error).message); return false; }
  };
  const groups = draft.groups!;
  const reorder = (next: SchedulingRuleGroup[]) => change(() => updateRuleGroups(draft, next, true));
  const drag = useDragSort(groups, reorder);
  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await onSave(withPendingTags(draft, tagInputs)); onClose(); } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="schedule-dialog" aria-labelledby="schedule-editor-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <header><div className="schedule-editor-title"><h2 id="schedule-editor-title">规则分组与优先级</h2>
        <button type="button" disabled={busy} onClick={() => change(() => {
          let name = '新分组', number = 2;
          while (groups.some(group => group.name === name)) name = `新分组 ${number++}`;
          const id = `group-${crypto.randomUUID()}`;
          const next = updateRuleGroups(draft, [...groups, { id, name, rules: [] }]); newGroupFocus.current = id;
          return next;
        })}>新增分组</button></div>
        <span>组间、组内从上到下 · 冲突时靠前规则优先</span></header>
      <div className="schedule-editor-body" ref={scrollBody} onPointerMove={event => {
        if (drag.draggingIdx === null && !ruleDragging || !scrollBody.current) return;
        const bounds = scrollBody.current.getBoundingClientRect();
        if (event.clientY < bounds.top + 48) scrollBody.current.scrollTop -= 24;
        if (event.clientY > bounds.bottom - 48) scrollBody.current.scrollTop += 24;
      }}>
        <datalist id="schedule-tag-options">{[...new Set(Object.values(draft.tags ?? {}).flat())].map(tag => <option key={tag} value={tag} />)}</datalist>
        {groups.map((group, index) => <section key={group.id} ref={element => drag.itemRef(element, index)}
          className={`schedule-group${drag.draggingIdx === index ? ' is-dragging' : ''}`} aria-label={`${group.name}分组`}>
          <div className="schedule-group-heading">
            <button type="button" {...(!busy ? drag.handleProps(index) : {})} className="schedule-drag" disabled={busy}
              aria-label={`拖动分组${group.name}，也可用上下方向键移动`} onKeyDown={event => {
                const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : index;
                if (to === index) return; event.preventDefault();
                if (to >= 0 && to < groups.length) { const next = [...groups]; next.splice(to, 0, next.splice(index, 1)[0]); reorder(next); }
              }}>⠿</button>
            <button type="button" className="schedule-collapse" disabled={busy} aria-expanded={!collapsed.has(group.id)} aria-label={`${collapsed.has(group.id) ? '展开' : '折叠'}${group.name}`}
              onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>
              {collapsed.has(group.id) ? '▸' : '▾'}</button>
            <input data-group-id={group.id} aria-label={`分组 ${index + 1} 名称`} value={group.name} maxLength={30} disabled={busy}
              onChange={event => setDraft({ ...draft, groups: groups.map(item => item.id === group.id ? { ...item, name: event.target.value } : item) })} />
            <span>{group.rules.length} 条</span>
            <button type="button" aria-label={`删除分组${group.name}`} title={group.rules.length ? '先将规则移到其他分组' : '删除空分组'}
              disabled={busy || Boolean(group.rules.length) || groups.length === 1} onClick={() => change(() => updateRuleGroups(draft, groups.filter(item => item.id !== group.id)))}>×</button>
          </div>
          {!collapsed.has(group.id) && <GroupRules group={group} draft={draft} busy={busy} expanded={expanded} setExpanded={setExpanded} change={change} onDragging={setRuleDragging}
            onRename={(id, name) => setDraft({ ...draft, names: { ...draft.names, [id]: name } })}
            tagInputs={tagInputs} onTagInput={(id, value) => setTagInputs(previous => ({ ...previous, [id]: value }))}
            onAddTags={id => { if (change(() => withPendingTags(draft, { [id]: tagInputs[id] ?? '' }))) setTagInputs(previous => ({ ...previous, [id]: '' })); }} />}
          {!group.rules.length && !collapsed.has(group.id) && <p className="schedule-empty-group">通过规则旁的 → 移入</p>}
        </section>)}
        {!!draft.removed?.length && <details className="schedule-removed"><summary>已删除 · {draft.removed.length} 条</summary>
          <label className="schedule-rule-group-label">恢复到<select aria-label="恢复规则到分组" disabled={busy}
            value={groups.some(group => group.id === restoreGroup) ? restoreGroup : groups[0].id} onChange={event => setRestoreGroup(event.target.value)}>
            {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select></label>
          {draft.removed.map(id => <div className="schedule-removed-rule" key={id}><span>{ruleTitle(id, draft)}</span>
            <button type="button" disabled={busy} aria-label={`恢复规则${ruleTitle(id, draft)}`} onClick={() => change(() => restoreSchedulingRule(draft, id,
              groups.some(group => group.id === restoreGroup) ? restoreGroup : groups[0].id))}>恢复</button></div>)}
        </details>}
      </div>
      <footer>{error && <p role="alert">{error}</p>}<div>
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" disabled={busy}>{busy ? '保存中…' : '保存并 Orchestrate'}</button>
      </div></footer>
    </form>
  </dialog>;
}

export default function LifeSchedulingRules({ onExpired, onManageOutlook }: { onExpired: () => void; onManageOutlook?: () => void }) {
  const [data, setData] = useState<Reply | null>(null), [editing, setEditing] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [retryDispatch, setRetryDispatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useCallback(async (method = 'GET', config?: SchedulingRuleConfig, signal?: AbortSignal): Promise<Reply> => {
    const response = await accountFetch(endpoint, { method, signal, headers: { 'Content-Type': 'application/json' }, ...(config ? { body: JSON.stringify(config) } : {}) });
    if (response.status === 401) { onExpired(); throw new Error('请重新登录'); }
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '规则读取失败');
    return { ...value, config: readRuleConfig(value.config) };
  }, [onExpired]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const value = await request('GET', undefined, signal); if (!signal?.aborted) { setData(value); setError(''); } }
    catch (cause) { if (!signal?.aborted) setError((cause as Error).message); }
  }, [request]);
  useEffect(() => {
    const controller = new AbortController(); void refresh(controller.signal);
    const focus = () => { if (!document.hidden && !editing) void refresh(controller.signal); };
    window.addEventListener('focus', focus);
    const timer = window.setInterval(focus, 30_000);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [refresh, editing]);
  const save = async (config: SchedulingRuleConfig) => {
    const value = await request('PATCH', config, AbortSignal.timeout(25_000));
    setData(previous => ({ ...previous, config: value.config }));
    setRetryDispatch(!value.triggered); setMessage(value.triggered ? '已保存并提交 Orchestrate' : '已保存，Orchestrate 未提交');
  };
  const retry = async () => {
    setBusy(true);
    try {
      const response = await accountFetch('/api/ticktick-trips?action=trigger-replan', { method: 'POST', signal: AbortSignal.timeout(20_000) });
      if (response.status === 401) { onExpired(); return; }
      if (!response.ok) throw new Error('Orchestrate 未提交，请重试');
      setRetryDispatch(false); setMessage('Orchestrate 已提交');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="schedule-settings" aria-label="规则和 Outlook 连接">
    <div className="schedule-summary"><details><summary>规则优先级{data ? ` · ${data.config.groups!.length} 组 · ${activeRuleOrder(data.config).length} 条` : ''}</summary>
      {data && <><div className="schedule-list-actions"><span>{data.lastRun ? `${time.format(new Date(data.lastRun.generatedAt))} · 配置 v${data.lastRun.version}` : '尚未执行'}</span>
        <button onClick={() => setEditing(true)}>编辑规则</button></div>
        <p className="schedule-priority-note">组间、组内从上到下 · 冲突时靠前规则优先</p>
        {data.config.groups!.map(group => <details key={group.id} className="schedule-group">
          <summary>{group.name}<span>{group.rules.length} 条</span></summary>
        <ol className="schedule-rules-list">{group.rules.map(id => {
          const result = data.lastRun?.results.find(r => r.id === id);
          return <li key={id} value={data.config.order.indexOf(id) + 1}><div className="schedule-rule-heading">
            <span className="schedule-number">{data.config.order.indexOf(id) + 1}</span><strong>{ruleTitle(id, data.config)}</strong>
            <span>{result?.status === 'success' ? `${result.deferred ? '部分完成' : '已执行'} · ${result.matched} 项${result.deferred ? ` · 暂缓 ${result.deferred} 项` : ''}` : result?.status === 'failed' ? '失败' : result?.status === 'skipped' ? '暂缓／跳过' : ''}</span></div>
            <p>{SCHEDULING_RULES.find(rule => rule[0] === id)![2]}</p>
            <RuleTags tags={data.config.tags?.[id]} name={ruleTitle(id, data.config)} />
            {!!data.config.predecessors[id]?.length && <div className="schedule-predecessors">前序：{data.config.predecessors[id]!.map(rule => ruleTitle(rule, data.config)).join('、')}</div>}
            {result?.reason && <p>{result.reason}</p>}
            {!!result?.conflicts?.length && <p>冲突采用：{[...new Set(result.conflicts.map(c => ruleTitle(c.winner, data.lastRun)))].join('、')}</p>}
          </li>;
        })}</ol></details>)}</>}
    </details></div>
    <details className="schedule-outlook"><summary>Outlook</summary>
      {data?.outlook?.map(connection => <div className="schedule-connection" key={connection.id}>
        <div><strong>{connection.name}</strong><span>{connection.error || (connection.connected ? '已连接' : '未连接')}
          {connection.syncedAt ? ` · 上次成功同步 ${time.format(new Date(connection.syncedAt))}` : ''}</span>
          {connection.retryAt && <span>下次额度释放 {time.format(new Date(connection.retryAt))}</span>}</div>
        {connection.kind === 'subscription' ? <a href="https://bill.bonbills.cn/calendar" target="_blank" rel="noreferrer">管理订阅 ↗</a>
          : <button onClick={onManageOutlook}>管理连接</button>}
      </div>)}
    </details>
    {message && <p role="status">{message}{retryDispatch && <button disabled={busy} onClick={() => void retry()}>重试 Orchestrate</button>}</p>}
    {error && <p role="alert">{error} <button onClick={() => void refresh()}>重新读取</button></p>}
    {editing && data && <RuleEditor initial={data.config} onSave={save} onClose={() => setEditing(false)} />}
  </section>;
}
