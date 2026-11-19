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

export const ORCHE_FAILURE_TITLE = 'Orche 排期未完成';
const TTL = 7 * 86400;
const shanghaiDay = (now: Date) => calendarDateInTimeZone(now.toISOString(), 'Asia/Shanghai')!;
type Receipt = { phase: 'sending' | 'confirmed'; taskId?: string };

function matchesAlert(task: TickTickTask, date: string, projectId: string) {
  return Boolean(task.id && task.projectId === projectId && task.title === ORCHE_FAILURE_TITLE && !task.repeatFlag
    && calendarDateInTimeZone(task.dueDate, 'Asia/Shanghai') === date);
}

export async function ensureOrcheFailureTask(api: TickTickApi, projectId: string, connectionId: string, now = new Date()) {
  const date = shanghaiDay(now);
  const receiptKey = `ticktick:orche-failure-task:v1:${connectionId}:${date}`;
  const receipt = await kv.get<Receipt>(receiptKey);
  if (receipt?.phase === 'confirmed') return { ok: true, sent: true, duplicate: true };

  async function confirm(task: TickTickTask, duplicate: boolean) {
    if (!matchesAlert(task, date, projectId) || task.priority !== 5 || task.isAllDay !== true)
      return { ok: false, sent: false };
    await kv.set(receiptKey, { phase: 'confirmed', taskId: task.id } satisfies Receipt, { ex: TTL });
    return { ok: true, sent: true, duplicate };
  }

  if (receipt?.taskId) {
    const saved = await api.getTask(projectId, receipt.taskId);
    return saved?.id === receipt.taskId ? confirm(saved, true) : { ok: false, sent: false };
  }

  const project = await api.getProjectData(projectId);
  if (!Array.isArray(project?.tasks)) return { ok: false, sent: false };
  const existing = project.tasks.find(task => matchesAlert(task, date, projectId));
  if (existing) return confirm(existing, true);
  if (receipt) {
    // A lost create response can leave a task already closed or abandoned.
    // The durable intent allows verification only, even on process restart.
    const [completed, abandoned] = await Promise.all([
      collectCompleted(api, [projectId], Date.parse(`${date}T00:00:00+08:00`), Date.now(), Date.now() + 25_000),
      readAbandonedTaskRecords(api, [projectId]),
    ]);
    const closed = [...completed, ...abandoned].find(task => matchesAlert(task, date, projectId));
    return closed ? confirm(closed, true) : { ok: false, sent: false };
  }

  const beforeWrite = new Date();
  if (shanghaiDay(beforeWrite) !== date || automaticRestWindow(beforeWrite)) return { ok: false, sent: false };
  if (!await kv.set(receiptKey, { phase: 'sending' } satisfies Receipt, { nx: true, ex: TTL }))
    return { ok: false, sent: false };
  const midnight = `${date}T00:00:00.000+0800`;
  let created: TickTickTask;
  try {
    created = await api.createTask({ projectId, title: ORCHE_FAILURE_TITLE, priority: 5, isAllDay: true,
      startDate: midnight, dueDate: midnight, timeZone: 'Asia/Shanghai',
      content: '(1m) 查看 BonLog 排期状态：https://log.bonbills.cn/?orche=1' });
  } catch (error) {
    // TickTick explicitly rejected these requests. Ambiguous responses leave
    // the intent in place so later alarms can only look for the original task.
    if (error instanceof Error && /失败：TickTick (?:400|401|403|404|422|429)\b/.test(error.message))
      await kv.del(receiptKey);
    throw error;
  }
  if (!created?.id || created.projectId !== projectId) return { ok: false, sent: false };
  await kv.set(receiptKey, { phase: 'sending', taskId: created.id } satisfies Receipt, { ex: TTL });
  const saved = await api.getTask(projectId, created.id);
  return saved?.id === created.id ? confirm(saved, false) : { ok: false, sent: false };
}

export async function deliverOrcheFailureTask() {
  const lock = await acquireTickTickLock();
  if (!lock) return { ok: false, busy: true };
  try {
    const connection = await kv.get<TickTickConnection>(TICKTICK_CONNECTION_KEY);
    if (!connection) return { ok: false, connected: false };
    const token = decryptTickTickToken(connection.encryptedToken, (process.env.SYNC_SECRET || '').trim());
    const api = new TickTickOpenApiClient(token, (process.env.TICKTICK_API_BASE_URL || '').trim() || undefined);
    const result = await ensureOrcheFailureTask(api, connection.projectId, createHash('sha256').update(token).digest('hex'));
    if (result.ok) console.info('[orche-failure-task]', result.duplicate ? 'confirmed-existing' : 'confirmed-created');
    return result;
  } finally {
    await releaseTickTickLock(lock);
  }
}
