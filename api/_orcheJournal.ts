import { createHash } from 'node:crypto';
import { kv } from './_accountKv.js';
import { acquireTickTickLock, releaseTickTickLock } from './_ticktickLock.js';
import { readAbandonedTaskRecords } from './_ticktickAbandoned.js';
import { collectCompleted } from './_ticktickCompleted.js';
import { automaticRestWindow } from '../src/utils/schedulerTime.js';
import {
  calendarDateInTimeZone, decryptTickTickToken, TICKTICK_CONNECTION_KEY, TickTickOpenApiClient,
  type TickTickApi, type TickTickConnection, type TickTickTask,
} from './_ticktickTrips.js';

export const ORCHE_JOURNAL_TITLE = 'Orche 通信窗口';
const oldTitle = 'Orche 排期未完成';
const intro = '(1m) 查看 BonLog 排期状态：https://log.bonbills.cn/?orche=1';
const start = '--- Orche 运行记录 ---', end = '--- Orche 记录结束 ---';
const shanghaiDay = (now: number) => calendarDateInTimeZone(new Date(now).toISOString(), 'Asia/Shanghai')!;
const formatTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
const MAX_VISIBLE = 60;
const results = { success: '成功', partial: '部分完成', failed: '失败' } as const;
const sources = { manual: '手动 Orche', full: '自动完整', hourly: '自动小时' } as const;
const reasons: Record<string, string> = {
  'rules-incomplete': '部分规则未完成', 'origin-not-ready': '排期服务暂不可用',
  'read-unavailable': '排期数据暂不可读', 'response-unknown': '结果待核对',
  'interrupted-response-unknown': '执行中断，结果待核对', 'expired': '已过期',
  'completion-archive': '完成记录未确认', 'period-import': '经期同步未确认', busy: '锁占用',
};
export interface OrcheJournalEvent {
  id: string; at: number; source: keyof typeof sources; status: keyof typeof results; attempt: number; reason?: string;
}
type Channel = { projectId: string; taskId?: string; startedAt?: number };
const archiveKey = (month: string) => `ticktick:orche-journal:archive:v1:${month}`;
const monthOf = (at: number) => shanghaiDay(at).slice(0, 7);
const owns = (object: object, key: unknown) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);
function newest(events: OrcheJournalEvent[]) {
  return [...new Map(events.map(event => [event.id, event])).values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
function line(event: OrcheJournalEvent) {
  const reason = event.reason && reasons[event.reason];
  return `${formatTime.format(event.at)} · ${sources[event.source]}${event.attempt ? `补跑 ${event.attempt}` : ''} · ${results[event.status]}${reason ? `（${reason}）` : ''}`;
}

export function parseOrcheJournalEvents(body: unknown): OrcheJournalEvent[] | null {
  const value = body as { events?: unknown[] } | null;
  if (!Array.isArray(value?.events) || value.events.length < 1 || value.events.length > 30) return null;
  const events: OrcheJournalEvent[] = [];
  for (const valueOfEvent of value.events) {
    const e = valueOfEvent as OrcheJournalEvent | null;
    if (!e || typeof e.id !== 'string' || !/^(?:manual|full|hourly)-[\w-]{1,110}$/.test(e.id)
      || !Number.isSafeInteger(e.at) || e.at < 1_700_000_000_000 || e.at > Date.now() + 60_000
      || !owns(sources, e.source) || !owns(results, e.status) || !Number.isInteger(e.attempt) || e.attempt < 0 || e.attempt > 99) return null;
    events.push({ id: e.id, at: e.at, source: e.source, status: e.status, attempt: e.attempt,
      ...(owns(reasons, e.reason) ? { reason: e.reason } : {}) });
  }
  return events;
}

function journalContent(content: string, entries: OrcheJournalEvent[]) {
  const first = content.indexOf(start), last = content.indexOf(end, first + start.length);
  const block = [start, ...entries.map(line),
    '按月查看完整记录：https://log.bonbills.cn/api/ticktick-trips?action=orche-journal', end].join('\n');
  return first >= 0 && last >= 0 ? content.slice(0, first) + block + content.slice(last + end.length)
    : [content, block].filter(Boolean).join('\n\n');
}

function sameDayDates(date: string) {
  const midnight = `${date}T00:00:00.000+0800`;
  return { startDate: midnight, dueDate: midnight, timeZone: 'Asia/Shanghai', isAllDay: true };
}
const sameContent = (a: string | undefined, b: string) => a?.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
const isOpen = (task: TickTickTask) => (task.status ?? 0) === 0 && !task.completedTime;
const isManaged = (task: TickTickTask) => !task.repeatFlag && (task.title === ORCHE_JOURNAL_TITLE && Boolean(task.content?.includes(start))
  || task.title === oldTitle && Boolean(task.content?.includes(intro)));

async function findChannelTask(api: TickTickApi, projectId: string, connectionId: string, channel: Channel | null) {
  if (channel?.taskId) return api.getTask(channel.projectId, channel.taskId);
  const project = await api.getProjectData(projectId);
  if (!Array.isArray(project?.tasks)) throw new Error('TickTick 通信窗口未确认');
  const candidates = project.tasks.filter(task => task.projectId === projectId && isManaged(task));
  const existing = candidates.find(task => task.title === ORCHE_JOURNAL_TITLE)
    ?? candidates.sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''))[0];
  if (existing) {
    const fresh = await api.getTask(projectId, existing.id);
    if (fresh?.id !== existing.id || fresh.projectId !== projectId) throw new Error('TickTick 通信窗口未确认');
    return fresh;
  }

  const oldKeys = Array.from({ length: 7 }, (_, i) => `ticktick:orche-failure-task:v1:${connectionId}:${shanghaiDay(Date.now() - i * 86400_000)}`);
  const receipts = await kv.mget<({ taskId?: string } | null)[]>(...oldKeys);
  const oldId = receipts?.find(receipt => receipt?.taskId)?.taskId;
  if (oldId) {
    try {
      const old = await api.getTask(projectId, oldId);
      if (old?.id === oldId && old.projectId === projectId) return old;
    } catch (error) {
      if (!(error instanceof Error && /^TickTick 404\b/.test(error.message))) throw error;
    }
  }

  if (channel?.startedAt) {
    const [completed, abandoned] = await Promise.all([
      collectCompleted(api, [projectId], channel.startedAt, Date.now(), Date.now() + 25_000),
      readAbandonedTaskRecords(api, [projectId]),
    ]);
    return [...completed, ...abandoned].find(task => task.projectId === projectId && isManaged(task)
      && task.title === ORCHE_JOURNAL_TITLE) ?? null;
  }
  return null;
}

export async function ensureOrcheJournal(api: TickTickApi, projectId: string, connectionId: string, events: OrcheJournalEvent[]) {
  const channelKey = `ticktick:orche-journal:channel:v1:${connectionId}`;
  const recentKey = 'ticktick:orche-journal:recent:v1';
  const [channel, previous] = await Promise.all([kv.get<Channel>(channelKey), kv.get<OrcheJournalEvent[]>(recentKey)]);
  const byMonth = new Map<string, Record<string, OrcheJournalEvent>>();
  for (const event of events) {
    const month = monthOf(event.at), bucket = byMonth.get(month) ?? {};
    bucket[event.id] = event; byMonth.set(month, bucket);
  }
  await Promise.all([...byMonth].map(([month, bucket]) => kv.hset(archiveKey(month), bucket)));
  const recent = newest([...(previous ?? []), ...events]).slice(0, MAX_VISIBLE);
  await kv.set(recentKey, recent);

  const targetProject = channel?.projectId ?? projectId;
  const current = await findChannelTask(api, targetProject, connectionId, channel);
  const now = new Date();
  if (automaticRestWindow(now)) return { ok: false, sent: false };
  const date = shanghaiDay(now.getTime());
  let taskId: string, expected: { content: string; title: string; today: boolean; status: number };
  if (current) {
    if (!current.id || current.projectId !== targetProject || channel?.taskId && channel.taskId !== current.id)
      return { ok: false, sent: false };
    taskId = current.id;
    if (!channel?.taskId) await kv.set(channelKey, { projectId: targetProject, taskId } satisfies Channel);
    const title = current.title === oldTitle && isManaged(current) ? ORCHE_JOURNAL_TITLE : current.title;
    const content = journalContent(current.content ?? '', recent);
    const today = isOpen(current), status = current.status ?? 0;
    expected = { content, title, today, status };
    if (sameContent(current.content, content) && current.title === title && (!today || current.priority === 5 && current.isAllDay === true
        && calendarDateInTimeZone(current.dueDate, 'Asia/Shanghai') === date)) return { ok: true, sent: true, duplicate: true };
    const etag = (current as TickTickTask & { etag?: string }).etag;
    await api.updateTask(taskId, { id: taskId, projectId: targetProject, title, content,
      ...(etag ? { etag } : {}), ...(today ? { ...sameDayDates(date), priority: 5 } : { status }) });
  } else {
    if (channel || !await kv.set(channelKey, { projectId: targetProject, startedAt: now.getTime() } satisfies Channel, { nx: true }))
      return { ok: false, sent: false };
    const title = ORCHE_JOURNAL_TITLE, content = journalContent(intro, recent);
    expected = { content, title, today: true, status: 0 };
    let created: TickTickTask;
    try {
      created = await api.createTask({ projectId: targetProject, title, content, priority: 5, ...sameDayDates(date) });
    } catch (error) {
      if (error instanceof Error && /失败：TickTick (?:400|401|403|404|422|429)\b/.test(error.message)) await kv.del(channelKey);
      throw error;
    }
    if (!created?.id || created.projectId !== targetProject) return { ok: false, sent: false };
    taskId = created.id;
    await kv.set(channelKey, { projectId: targetProject, taskId } satisfies Channel);
  }
  const saved = await api.getTask(targetProject, taskId);
  const ok = saved?.id === taskId && saved.projectId === targetProject && saved.title === expected.title
    && sameContent(saved.content, expected.content)
    && (saved.status ?? 0) === expected.status && (!expected.today || saved.priority === 5 && saved.isAllDay === true
      && calendarDateInTimeZone(saved.dueDate, 'Asia/Shanghai') === date);
  return { ok, sent: ok };
}

export async function deliverOrcheJournal(events: OrcheJournalEvent[]) {
  const lock = await acquireTickTickLock();
  if (!lock) return { ok: false, busy: true };
  try {
    const connection = await kv.get<TickTickConnection>(TICKTICK_CONNECTION_KEY);
    if (!connection) return { ok: false, connected: false };
    const token = decryptTickTickToken(connection.encryptedToken, (process.env.SYNC_SECRET || '').trim());
    const api = new TickTickOpenApiClient(token, (process.env.TICKTICK_API_BASE_URL || '').trim() || undefined);
    return await ensureOrcheJournal(api, connection.projectId, createHash('sha256').update(token).digest('hex'), events);
  } finally {
    await releaseTickTickLock(lock);
  }
}

export async function readOrcheJournal(month: string) {
  const records = await kv.hgetall<Record<string, OrcheJournalEvent>>(archiveKey(month));
  return [`Orche 运行记录 · ${month} · 北京时间`, '', ...newest(Object.values(records ?? {})).map(line)].join('\n');
}
