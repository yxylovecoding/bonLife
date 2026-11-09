import { dateTimeFormatter } from './_dateTimeFormat.js';
import { canAdvanceEyeDrop, eyeDropShanghaiDay, isEyeDrops } from './_ticktickEyeDrops.js';
import { currentRule, precedes } from './_rulePolicy.js';
import { collectCompleted } from './_ticktickCompleted.js';
import { hasNewTaskCompletion, isPendingTickTickTask } from './_ticktickTaskState.js';
import { schedulingStage } from './_schedulingFailure.js';
import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import { Lunar } from 'lunar-typescript';
import ICAL from 'ical.js';
import { withoutDurationAnnotations } from './_taskDuration.js';
import { getTripDisplayTitle, normalizeOutlookTravelTitles } from '../src/utils/outlookCalendar.js';

export const TICKTICK_CONNECTION_KEY = 'ticktick:connection:v1';
export const TICKTICK_SYNC_STATE_KEY = 'ticktick:trip-sync:v1';
export const TICKTICK_SYNC_LOCK_KEY = 'ticktick:trip-sync:lock';
export const TICKTICK_TEMPLATE_TITLE = '出门todo模版';
const TEMPLATE_TITLE_VARIANTS = [TICKTICK_TEMPLATE_TITLE, '出门todo模板'];
const LEGACY_TEMPLATE_TITLES = ['出行todo模板', '出行todo模版', '出门todo', '出行todo'];
export const TICKTICK_ANCHOR_TITLE = '出门当天';
export const TICKTICK_WISH_PREPARATION_TITLE = '出门前七个月';
export const TICKTICK_API_BASE_URL = 'https://api.ticktick.com/open/v1';

const TRIP_TAG_PREFIX = /^\d{2}\.\d{1,2}(?:\.\d{1,2})?\s*/;

export interface TickTickTripSource {
  key: string;
  startDate: string;
  endDate: string;
  dates: string[];
  name: string;
  note: string;
}

export interface EncryptedSecret {
  iv: string;
  tag: string;
  data: string;
}

export interface TickTickConnection {
  encryptedToken: EncryptedSecret;
  projectId: string;
  templateRootId: string;
  timeZone: string;
  connectedAt: string;
}

export interface TickTickChecklistItem {
  id?: string;
  title: string;
  status?: number | string | null;
  completedTime?: string;
  isAllDay?: boolean;
  sortOrder?: number;
  startDate?: string;
  timeZone?: string;
}

function checklistItemStatus(item: TickTickChecklistItem): 0 | 1 {
  if (item.status == null) return item.completedTime ? 1 : 0;
  const status = typeof item.status === 'string' && /^[012]$/.test(item.status.trim())
    ? Number(item.status.trim())
    : item.status;
  if (status === 0) return 0;
  // Task-style completion is 2; the checklist write contract only accepts 1.
  if (status === 1 || status === 2) return 1;
  throw new Error(`无法安全同步清单项“${item.title}”：未知状态 ${JSON.stringify(item.status)}`);
}

function taskWritePayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.items)) return payload;
  return {
    ...payload,
    items: payload.items.map((item: TickTickChecklistItem) => ({
      ...item,
      status: checklistItemStatus(item),
    })),
  };
}

export interface TickTickTask {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  isAllDay?: boolean;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  reminders?: string[];
  tags?: string[];
  repeatFlag?: string;
  repeatFrom?: string | number;
  priority?: number;
  sortOrder?: number;
  status?: number;
  completedTime?: string;
  createdTime?: string;
  kind?: string;
  parentId?: string;
  items?: TickTickChecklistItem[];
}

export interface TickTickProject {
  id: string;
  name: string;
}

export interface TickTickProjectData {
  project?: TickTickProject;
  tasks: TickTickTask[];
}

export interface TickTickTemplate {
  projectId: string;
  rootTask: TickTickTask;
  tasks: TickTickTask[];
  // Optional dates support legacy schedule migration and existing dated checklist items.
  anchorTask?: TickTickTask;
  anchorDate?: string;
}

interface TickTickDateSnapshot {
  startDate: string | null;
  dueDate: string | null;
  isAllDay: boolean;
  timeZone: string;
}

interface TickTickDateSyncState {
  lastSynced: TickTickDateSnapshot;
  manual: boolean;
}

export interface TickTickTripInstance {
  projectId?: string;
  tripKey: string;
  startDate: string;
  endDate: string;
  dates: string[];
  name: string;
  rootTaskId?: string;
  taskIdsByTemplateId: Record<string, string>;
  itemIdsByTemplateTaskId: Record<string, Record<string, string>>;
  taskDateStates?: Record<string, TickTickDateSyncState>;
  checklistDateStates?: Record<string, Record<string, TickTickDateSyncState>>;
}

export interface TickTickTripSyncState {
  instances: Record<string, TickTickTripInstance>;
  wishInstances?: Record<string, TickTickTripInstance>;
  lastSyncAt?: string;
  lastError?: string;
}

export interface TickTickSyncResult {
  createdTrips: number;
  updatedTrips: number;
  deletedTrips: number;
  activeTrips: number;
}

export interface TickTickRoutineTargets {
  home: string | null;
  school: string | null;
  travel: string | null;
}

export interface TickTickRoutineSyncResult {
  updatedRoutineTasks: number;
  routineTargets: TickTickRoutineTargets;
  routineTaskCounts: Record<keyof TickTickRoutineTargets, number>;
}

export interface TickTickApi {
  listProjects(): Promise<TickTickProject[]>;
  getPreference(): Promise<{ timeZone?: string }>;
  getProjectData(projectId: string): Promise<TickTickProjectData>;
  filterTasks(projectIds: string | string[] | undefined, statuses: number[]): Promise<TickTickTask[]>;
  listCompletedTasks(projectIds: string[], startDate: string, endDate: string): Promise<TickTickTask[]>;
  getTask(projectId: string, taskId: string): Promise<TickTickTask>;
  createTask(payload: Record<string, unknown>): Promise<TickTickTask>;
  updateTask(taskId: string, payload: Record<string, unknown>): Promise<TickTickTask>;
  deleteTask(projectId: string, taskId: string): Promise<void>;
}

function encryptionKey(secret: string): KeyObject {
  return createSecretKey(Uint8Array.from(createHash('sha256').update(secret).digest()));
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return Buffer.from(binary, 'binary').toString('base64');
}

export function encryptTickTickToken(token: string, secret: string): EncryptedSecret {
  const iv = Uint8Array.from(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const data = Uint8Array.from([...cipher.update(token, 'utf8'), ...cipher.final()]);
  return {
    iv: encodeBase64(iv),
    tag: encodeBase64(Uint8Array.from(cipher.getAuthTag())),
    data: encodeBase64(data),
  };
}

export function decryptTickTickToken(value: EncryptedSecret, secret: string): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    decodeBase64(value.iv),
  );
  decipher.setAuthTag(decodeBase64(value.tag));
  const decrypted = Uint8Array.from([
    ...decipher.update(decodeBase64(value.data)),
    ...decipher.final(),
  ]);
  return new TextDecoder().decode(decrypted);
}

export class TickTickOpenApiClient implements TickTickApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = TICKTICK_API_BASE_URL,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const readOnly = method === 'GET' || method === 'POST' && ['/preference', '/task/filter', '/task/completed'].includes(path);
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(15_000),
      }).catch(async error => {
        // Retry the individual read, never a creation/update/deletion whose
        // outcome is unknown. Keep this separate from whole-workflow retries.
        if (readOnly && attempt < 2 && !init.signal?.aborted) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          return null;
        }
        const route = path.replace(/\/project\/[^/]+/g, '/project/:id').replace(/\/task\/[^/]+/g, '/task/:id');
        throw new Error(`TickTick ${readOnly ? '读取' : '写入'}请求失败（${method} ${route}）`, { cause: error });
      });
      if (!response) continue;
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        // TickTick reports its query limit as HTTP 500 as well as 429. Only
        // retry explicit rejections; ambiguous write failures must not replay.
        if (attempt < 2 && (response.status === 429 || detail.includes('exceed_query_limit'))) {
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          continue;
        }
        throw new Error(`TickTick ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  listProjects() {
    return this.request<TickTickProject[]>('/project');
  }

  getPreference() {
    return this.request<{ timeZone?: string }>('/preference', { method: 'POST' });
  }

  getProjectData(projectId: string) {
    return this.request<TickTickProjectData>(`/project/${encodeURIComponent(projectId)}/data`);
  }

  filterTasks(projectIds: string | string[] | undefined, statuses: number[]) {
    return this.request<TickTickTask[]>('/task/filter', {
      method: 'POST',
      body: JSON.stringify({
        ...(projectIds === undefined ? {} : { projectIds: Array.isArray(projectIds) ? projectIds : [projectIds] }),
        status: statuses,
      }),
    });
  }

  listCompletedTasks(projectIds: string[], startDate: string, endDate: string) {
    return this.request<TickTickTask[]>('/task/completed', {
      method: 'POST',
      body: JSON.stringify({ projectIds, startDate, endDate }),
    });
  }

  getTask(projectId: string, taskId: string) {
    return this.request<TickTickTask>(`/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`);
  }

  private async writeTask(path: string, payload: Record<string, unknown>) {
    const normalized = taskWritePayload(payload);
    try {
      return await this.request<TickTickTask>(path, { method: 'POST', body: JSON.stringify(normalized) });
    } catch (error) {
      console.error('[ticktick-task-write]', JSON.stringify({
        path,
        checklistStatuses: Array.isArray(normalized.items) ? normalized.items.map((item) => item.status) : [],
      }));
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`同步任务“${String(payload.title ?? payload.id ?? '')}”失败：${detail}`);
    }
  }

  createTask(payload: Record<string, unknown>) {
    return this.writeTask('/task', payload);
  }

  updateTask(taskId: string, payload: Record<string, unknown>) {
    return this.writeTask(`/task/${encodeURIComponent(taskId)}`, payload);
  }

  async deleteTask(projectId: string, taskId: string) {
    await this.request<void>(`/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    });
  }
}

function taskDate(task: TickTickTask): string | null {
  const value = task.dueDate || task.startDate;
  const date = value?.slice(0, 10);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function addCalendarDays(date: string, delta: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

function addCalendarMonths(date: string, delta: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + delta);
  const monthEnd = new Date(value);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  value.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return value.toISOString().slice(0, 10);
}

function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function nextChineseNewYear(afterDate: string): string {
  const year = Number(afterDate.slice(0, 4));
  // ICU's Chinese calendar differs by a day for some years (including 2027).
  // Regression dates are checked against https://www.hko.gov.hk/en/gts/time/conversion.htm
  const thisYear = Lunar.fromYmd(year, 1, 1).getSolar().toYmd();
  return thisYear > afterDate ? thisYear : Lunar.fromYmd(year + 1, 1, 1).getSolar().toYmd();
}

function calendarDayDifference(date: string, anchor: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000);
}

export function shiftTickTickDate(value: string | undefined, anchorDate: string | undefined, tripStartDate: string): string | undefined {
  if (!value || !anchorDate) return undefined;
  const sourceDate = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) return value;
  const shiftedDate = addCalendarDays(tripStartDate, calendarDayDifference(sourceDate, anchorDate));
  return `${shiftedDate}${value.slice(10)}`;
}

function descendantsOf(tasks: TickTickTask[], rootId: string): TickTickTask[] {
  const byParent = new Map<string, TickTickTask[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const children = byParent.get(task.parentId) ?? [];
    children.push(task);
    byParent.set(task.parentId, children);
  }
  const result: TickTickTask[] = [];
  const visit = (id: string) => {
    const children = (byParent.get(id) ?? []).sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0));
    for (const child of children) {
      result.push(child);
      visit(child.id);
    }
  };
  visit(rootId);
  return result;
}

function mergeTaskLists(primaryTasks: TickTickTask[], fallbackTasks: TickTickTask[]) {
  const tasksById = new Map<string, TickTickTask>();
  for (const task of [...primaryTasks, ...fallbackTasks]) {
    const existing = tasksById.get(task.id);
    tasksById.set(task.id, existing ? { ...task, ...existing } : task);
  }
  return [...tasksById.values()];
}

export async function readAllTickTickTasks(api: TickTickApi, statuses: number[]) {
  // Neither /project nor /task/filter reliably includes the built-in Inbox.
  // Read its reserved alias explicitly, then keep each task's real projectId for writes.
  const [projects, filteredTasks, inbox] = await Promise.all([
    api.listProjects(), api.filterTasks(undefined, statuses), api.getProjectData('inbox'),
  ]);
  const inboxProjectIds = new Set(['inbox', ...inbox.tasks.map((task) => task.projectId)]);
  const projectIds = [...new Set([...projects.map((project) => project.id), ...filteredTasks.map((task) => task.projectId)])]
    .filter((projectId) => !inboxProjectIds.has(projectId));
  const projectData = await Promise.all(projectIds.map((projectId) => api.getProjectData(projectId)));
  // Project data carries hierarchy/checklist fields that /task/filter may omit.
  return mergeTaskLists([...inbox.tasks, ...projectData.flatMap((data) => data.tasks)], filteredTasks);
}

export async function discoverTickTickTemplate(api: TickTickApi): Promise<TickTickTemplate> {
  const allTasks = await readAllTickTickTasks(api, [0, 2]);
  const preferredRoots = allTasks.filter((task) => TEMPLATE_TITLE_VARIANTS.includes(task.title.trim()));
  const roots = preferredRoots.length > 0 ? preferredRoots
    : allTasks.filter((task) => LEGACY_TEMPLATE_TITLES.includes(task.title.trim()));
  console.info('[ticktick-template-discovery]', JSON.stringify({ taskCount: allTasks.length, preferredCount: preferredRoots.length, candidateCount: roots.length }));
  if (roots.length === 0) throw new Error(`未找到“${TICKTICK_TEMPLATE_TITLE}”模板`);
  if (roots.length > 1) throw new Error(`找到 ${roots.length} 个同名“${TICKTICK_TEMPLATE_TITLE}”模板`);
  const rootTask = roots[0];
  const tasks = [rootTask, ...descendantsOf(allTasks, rootTask.id)];
  const anchors = tasks.filter((task) => task.title.trim() === TICKTICK_ANCHOR_TITLE && taskDate(task));
  return {
    projectId: rootTask.projectId,
    rootTask,
    tasks,
    anchorTask: anchors[0],
    anchorDate: anchors[0] ? taskDate(anchors[0]) ?? undefined : undefined,
  };
}

export async function readConnectedTickTickTemplate(
  api: TickTickApi,
  _connection: Pick<TickTickConnection, 'projectId' | 'templateRootId'>,
): Promise<TickTickTemplate> {
  // Stored IDs describe the original connection, never which task is the current template.
  return discoverTickTickTemplate(api);
}

export function buildTripSourcesFromSyncState(calendarState: unknown, tripState: unknown): TickTickTripSource[] {
  const calendar = calendarState && typeof calendarState === 'object' ? calendarState as Record<string, unknown> : {};
  const trip = tripState && typeof tripState === 'object' ? tripState as Record<string, unknown> : {};
  const tagMap = calendar.tagMap && typeof calendar.tagMap === 'object'
    ? calendar.tagMap as Record<string, unknown>
    : {};
  const tripTags = trip.tripTags && typeof trip.tripTags === 'object' ? trip.tripTags as Record<string, string> : {};
  const tripNotes = trip.tripNotes && typeof trip.tripNotes === 'object' ? trip.tripNotes as Record<string, string> : {};
  const tripSplits = trip.tripSplits && typeof trip.tripSplits === 'object' ? trip.tripSplits as Record<string, true> : {};
  const outlookTravelTitles = normalizeOutlookTravelTitles(calendar.outlookTravelTitles);
  const travelDates = Object.entries(tagMap)
    .filter(([, tag]) => tag === 'travel')
    .map(([date]) => date)
    .sort();
  const splitDates = new Set(Object.keys(tripSplits));
  const segments: string[][] = [];
  let current: string[] = [];
  for (const date of travelDates) {
    const previous = current.at(-1);
    const previousDay = previous ? new Date(`${previous}T00:00:00Z`) : null;
    if (previousDay) previousDay.setUTCDate(previousDay.getUTCDate() + 1);
    const contiguous = previousDay?.toISOString().slice(0, 10) === date;
    if (!previous || (contiguous && !splitDates.has(date))) {
      current.push(date);
      continue;
    }
    segments.push(current);
    current = [date];
  }
  if (current.length > 0) segments.push(current);

  const formatShortDate = (date: string) => {
    const [, month, day] = date.split('-');
    return `${Number(month)}月${Number(day)}日`;
  };
  return segments.map((dates) => {
    const startDate = dates[0];
    const endDate = dates.at(-1)!;
    const normalizedName = tripTags[startDate]?.trim().replace(TRIP_TAG_PREFIX, '').trim();
    return {
      key: startDate,
      startDate,
      endDate,
      dates,
      name: normalizedName || getTripDisplayTitle(undefined, dates, outlookTravelTitles) || (startDate === endDate
        ? formatShortDate(startDate)
        : `${formatShortDate(startDate)}–${formatShortDate(endDate)}`),
      note: tripNotes[startDate]?.trim() ?? '',
    };
  });
}

export function buildWishPreparationSourcesFromSyncState(configState: unknown): TickTickTripSource[] {
  const stored = configState && typeof configState === 'object' ? configState as Record<string, unknown> : {};
  const config = stored.config && typeof stored.config === 'object' ? stored.config as Record<string, unknown> : {};
  const wishes = Array.isArray(config.wishes) ? config.wishes : [];
  const sources = new Map<string, TickTickTripSource>();
  for (const value of wishes) {
    if (!value || typeof value !== 'object') continue;
    const wish = value as Record<string, unknown>;
    if (wish.isActive !== true || wish.linkedTripStartDate) continue;
    if (typeof wish.id !== 'string' || !wish.id.trim() || /^wish_trip_\d{4}-\d{2}-\d{2}(?:_\d+)?$/.test(wish.id)
      || typeof wish.name !== 'string' || !wish.name.trim()) continue;
    if (!isValidCalendarDate(wish.deadline)) continue;
    const preparationDate = addCalendarMonths(wish.deadline, -7);
    sources.set(wish.id, {
      key: wish.id,
      startDate: preparationDate,
      // 生命周期截止日仍是预计出发日；七个月前的准备日期已过也不能跳过未到期心愿。
      endDate: wish.deadline,
      dates: [preparationDate],
      name: wish.name.trim(),
      note: '',
    });
  }
  return [...sources.values()];
}

function wishPreparationTemplate(template: TickTickTemplate): TickTickTemplate {
  const roots = template.tasks.filter((task) =>
    task.parentId === template.rootTask.id && isSevenMonthPreparationTask(task),
  );
  if (roots.length !== 1) throw new Error(`${TICKTICK_TEMPLATE_TITLE}需要唯一的“${TICKTICK_WISH_PREPARATION_TITLE}”任务`);
  const rootTask = roots[0];
  return {
    projectId: template.projectId,
    rootTask,
    tasks: [rootTask, ...descendantsOf(template.tasks, rootTask.id)],
    anchorTask: rootTask,
    anchorDate: taskDate(rootTask) ?? (template.anchorDate ? addCalendarMonths(template.anchorDate, -7) : undefined),
  };
}

function isSevenMonthPreparationTask(task: Pick<TickTickTask, 'title'>): boolean {
  return /^出门前(?:七|7)个月$/.test(task.title.normalize('NFKC').replace(/\s/g, ''));
}

function calendarTagMapFromSyncState(calendarState: unknown): Record<string, unknown> {
  const calendar = calendarState && typeof calendarState === 'object' ? calendarState as Record<string, unknown> : {};
  return calendar.tagMap && typeof calendar.tagMap === 'object'
    ? calendar.tagMap as Record<string, unknown>
    : {};
}

function findRoutineTargetDate(tagMap: Record<string, unknown>, fromDate: string, matches: (tag: unknown) => boolean): string | null {
  let nearest: string | null = null;
  for (const date of Object.keys(tagMap)) {
    if (date < fromDate || (nearest && date >= nearest) || !matches(tagMap[date])) continue;
    if (isValidCalendarDate(date)) nearest = date;
  }
  return nearest;
}

export function getTickTickRoutineTargetDates(calendarState: unknown, today: string): TickTickRoutineTargets {
  const tagMap = calendarTagMapFromSyncState(calendarState);
  const targets: TickTickRoutineTargets = { home: null, school: null, travel: null };
  for (const date of Object.keys(tagMap)) {
    if (date < today) continue;
    const scene = routineCalendarScene(tagMap[date]);
    // Validate only a potential minimum, not every historical day three times.
    if (scene && (!targets[scene] || date < targets[scene]) && isValidCalendarDate(date)) targets[scene] = date;
  }
  return targets;
}

// A plan reads one immutable calendar snapshot. Build its sorted scene dates
// once; retain no calendar/account data after that plan returns.
export function createRoutineSceneDateFinder(calendarState: unknown) {
  const days: Record<keyof TickTickRoutineTargets, string[]> = { home: [], school: [], travel: [] };
  for (const [date, tag] of Object.entries(calendarTagMapFromSyncState(calendarState))) {
    const scene = routineCalendarScene(tag);
    if (scene && isValidCalendarDate(date)) days[scene].push(date);
  }
  for (const dates of Object.values(days)) dates.sort();
  return (task: TickTickTask, from: string): string | null => {
    const scenes = routineScenes(task);
    if (!scenes.length) return from;
    let nearest: string | null = null;
    for (const scene of scenes) {
      const dates = days[scene];
      let low = 0, high = dates.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (dates[middle] < from) low = middle + 1;
        else high = middle;
      }
      const date = dates[low];
      if (date && (!nearest || date < nearest)) nearest = date;
    }
    return nearest;
  };
}

export function routineScenes(task: TickTickTask): Array<keyof TickTickRoutineTargets> {
  const active = currentRule();
  if (active && !['scene-date', 'scene-eligibility', 'repeat-date'].includes(active) && !precedes('scene-eligibility', active)) return [];
  const scenes = new Set<keyof TickTickRoutineTargets>();
  for (const tag of task.tags ?? []) {
    const label = tag.normalize('NFKC').trim();
    if (label === '寄') scenes.add('home');
    if (label === '居' || label === '寓') scenes.add('school');
    if (label === '旅') scenes.add('travel');
  }
  return [...scenes];
}

function routineCalendarScene(tag: unknown): keyof TickTickRoutineTargets | null {
  if (tag === 'home') return 'home';
  if (tag === 'school' || tag === 'intern') return 'school';
  if (tag === 'travel') return 'travel';
  return null;
}

const ROUTINE_REPEAT_PARTS = new Set([
  'FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY',
  'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'BYHOUR', 'BYMINUTE', 'BYSECOND',
]);
const ROUTINE_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export function routineRecurrence(repeatFlag: string | undefined): 'none' | 'daily' | 'long' | 'unknown' {
  if (!repeatFlag?.trim()) return 'none';
  const rule = repeatFlag.trim().toUpperCase().replace(/^RRULE:/, '');
  const parts = new Map<string, string>();
  for (const part of rule.split(';')) {
    const match = /^([A-Z]+)=([^;=\s]+)$/.exec(part);
    if (!match || !ROUTINE_REPEAT_PARTS.has(match[1]) || parts.has(match[1])) return 'unknown';
    parts.set(match[1], match[2]);
  }
  // ICAL accepts unknown fields and coerces invalid intervals; do not let those
  // defaults turn an unsupported TickTick repeat rule into a daily task.
  for (const key of ['INTERVAL', 'COUNT']) {
    const value = parts.get(key);
    if (value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) return 'unknown';
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.get('FREQ') ?? '')) return 'unknown';
  try {
    const recurrence = ICAL.Recur.fromString(rule);
    if (recurrence.interval > 1 || recurrence.freq === 'MONTHLY' || recurrence.freq === 'YEARLY') return 'long';
    if (['BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS'].some((key) => parts.has(key))) return 'long';
    const weekdays = new Set(parts.get('BYDAY')?.split(',') ?? []);
    const everyWeekday = ROUTINE_WEEKDAYS.every((day) => weekdays.has(day));
    if (recurrence.freq === 'WEEKLY') return everyWeekday ? 'daily' : 'long';
    return weekdays.size > 0 && !everyWeekday ? 'long' : 'daily';
  } catch {
    return 'unknown';
  }
}

export function getTickTickRoutineExcludedTaskIds(template: TickTickTemplate, state: TickTickTripSyncState): Set<string> {
  const ids = new Set(template.tasks.map((task) => task.id));
  ids.add(template.rootTask.id);
  for (const instance of [...Object.values(state.instances), ...Object.values(state.wishInstances ?? {})]) {
    if (instance.rootTaskId) ids.add(instance.rootTaskId);
    for (const id of Object.values(instance.taskIdsByTemplateId)) ids.add(id);
  }
  return ids;
}

export function calendarDateInTimeZone(value: string | undefined, timeZone = 'Asia/Shanghai'): string | null {
  if (!value) return null;
  const rawDate = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return null;
  // Floating TickTick dates already contain their calendar date. Zoned values,
  // especially all-day midnight returned as the previous UTC day at 16:00,
  // must be interpreted in the task's timezone.
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return rawDate;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return rawDate;
  try {
    const parts = dateTimeFormatter('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : rawDate;
  } catch {
    return rawDate;
  }
}

export function routineTaskDate(task: TickTickTask): string | null {
  return calendarDateInTimeZone(task.dueDate || task.startDate, task.timeZone);
}

export function isPastEyeDrop(task: TickTickTask, today: string): boolean {
  if (!isEyeDrops(task)) return false;
  const date = eyeDropShanghaiDay(task);
  return date !== null && date < today;
}

export function isAlwaysTodayTask(task: TickTickTask): boolean {
  const active = currentRule();
  if (active && active !== 'always-today' && !precedes('always-today', active)) return false;
  return (task.tags ?? []).some(tag => tag.normalize('NFKC').trim().toLowerCase() === 'always-today');
}

export function routineOccurrenceKey(task: TickTickTask): string {
  // Completing a repeating task creates a history record with a new ID.
  // Keep the parent boundary so unrelated same-named tasks cannot postpone it.
  return JSON.stringify([task.projectId, task.parentId ?? '', task.title]);
}

export function matchCompletedOccurrences(tasks: TickTickTask[], completed: TickTickTask[]) {
  const identity = (task: TickTickTask) => JSON.stringify([task.projectId, task.id]);
  const completedIds = new Set(completed.map(identity));
  const completedFamilies = new Set(completed.map(routineOccurrenceKey));
  const familyCounts = new Map<string, number>();
  for (const task of tasks) {
    if (!isPendingTickTickTask(task)) continue;
    const key = routineOccurrenceKey(task);
    familyCounts.set(key, (familyCounts.get(key) ?? 0) + 1);
  }
  return (task: TickTickTask) => {
    if (completedIds.has(identity(task))) return true;
    const key = routineOccurrenceKey(task);
    return Boolean(task.repeatFlag) && familyCounts.get(key) === 1 && completedFamilies.has(key);
  };
}

export function sprayKind(task: TickTickTask): 'fragrance' | 'mite' | null {
  const title = withoutDurationAnnotations(task.title);
  return title === '香香喷雾' ? 'fragrance' : title === '除螨喷雾' ? 'mite' : null;
}

// Apply the user's exclusion to final dates, including future deferrals,
// important/timed tasks and actual completions. This is not a completion.
export function separateTickTickSprays(options: {
  tasks: TickTickTask[]; dates: Map<string, string>; history: TickTickTask[];
  calendarState: unknown; today: string; now?: Date; excludedTaskIds?: ReadonlySet<string>;
  movableTaskIds?: ReadonlySet<string>;
  nextEligibleDate?: (task: TickTickTask, from: string) => string | null;
}): Map<string, string> {
  const { tasks, dates, history, calendarState, today, excludedTaskIds = new Set<string>() } = options;
  const nextDate = options.nextEligibleDate ?? ((task: TickTickTask, from: string) => nextRoutineSceneDate(task, calendarState, from));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const excluded = (task: TickTickTask) => {
    if ((task.tags ?? []).some(tag => tag.normalize('NFKC').trim() === '不关我事')) return true;
    const seen = new Set<string>();
    let current: TickTickTask | undefined = task;
    while (current && !seen.has(current.id)) {
      if (excludedTaskIds.has(current.id) || Boolean(current.parentId && excludedTaskIds.has(current.parentId))) return true;
      seen.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };
  const open = tasks.filter(task => isPendingTickTickTask(task) && sprayKind(task) && !excluded(task));
  const completed = history.filter(task => sprayKind(task) && !excluded(task) && (task.status ?? 2) === 2
    && task.completedTime && Number.isFinite(Date.parse(task.completedTime))
    && Date.parse(task.completedTime) <= (options.now?.getTime() ?? Date.now()));
  const family = (task: TickTickTask) => JSON.stringify([task.projectId, task.parentId ?? '', sprayKind(task)]);
  const last = (task: TickTickTask) => {
    const unique = open.filter(other => family(other) === family(task)).length === 1;
    return Math.max(0, ...completed.filter(record => record.projectId === task.projectId
      && (record.id === task.id || (unique && family(record) === family(task))))
      .map(record => Date.parse(record.completedTime!)));
  };
  open.sort((a, b) => (last(a) || Date.parse(a.createdTime ?? '') || 0) - (last(b) || Date.parse(b.createdTime ?? '') || 0)
    || a.id.localeCompare(b.id));
  const bookings = new Map<string, Set<string>>(), resolved = new Map<string, string>();
  const reserve = (day: string, kind: string) => { const set = bookings.get(day) ?? new Set(); set.add(kind); bookings.set(day, set); };
  const conflict = (day: string, kind: string) => [...bookings.get(day) ?? []].some(other => other !== kind);
  for (const task of completed) {
    const day = calendarDateInTimeZone(task.completedTime, 'Asia/Shanghai');
    if (day) reserve(day, sprayKind(task)!);
  }
  // A scoped replan treats other tasks as reservations, never as write targets.
  for (const task of open) {
    if (!isAlwaysTodayTask(task) && (!options.movableTaskIds || options.movableTaskIds.has(task.id))) continue;
    const day = dates.get(task.id) ?? routineTaskDate(task);
    if (day) {
      const effective = day < today ? today : day;
      if (options.nextEligibleDate && conflict(effective, sprayKind(task)!)) throw new Error('喷雾固定日期冲突，保留原安排');
      reserve(effective, sprayKind(task)!);
    }
  }
  for (const task of open) {
    if (isAlwaysTodayTask(task) || (options.movableTaskIds && !options.movableTaskIds.has(task.id))) continue;
    const original = dates.get(task.id) ?? routineTaskDate(task);
    if (!original) continue;
    const kind = sprayKind(task)!, effective = original < today ? today : original;
    let target = options.nextEligibleDate ? nextDate(task, effective) : effective;
    if (!target) throw new Error('喷雾需要后续适用场景日才能错开，未更新本轮安排');
    for (let attempt = 0; conflict(target, kind); attempt++) {
      if (attempt >= 730) throw new Error('喷雾暂时找不到可错开的日期，未更新本轮安排');
      const next = nextDate(task, addCalendarDays(target, 1));
      if (!next) throw new Error('喷雾需要后续适用场景日才能错开，未更新本轮安排');
      target = next;
    }
    if (target !== effective) dates.set(task.id, target);
    resolved.set(task.id, target === effective ? original : target);
    reserve(target, kind);
  }
  return resolved;
}

function checklistItemDate(item: TickTickChecklistItem, fallbackTimeZone?: string): string | null {
  const date = calendarDateInTimeZone(item.startDate, item.timeZone || fallbackTimeZone);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function shiftedRoutineItems(task: TickTickTask, targetDate: string): TickTickChecklistItem[] | undefined {
  return task.items?.map((item) => {
    const date = checklistItemDate(item, task.timeZone);
    const status = checklistItemStatus(item);
    if (!date || status !== 0) return { ...item, status };
    return {
      ...item,
      status,
      startDate: shiftTickTickDate(item.startDate, date, targetDate),
    };
  });
}

function routineTaskIsAligned(task: TickTickTask, targetDate: string): boolean {
  const date = routineTaskDate(task);
  if (date !== targetDate) return false;
  return !(task.items ?? []).some(
    (item) => checklistItemStatus(item) === 0
      && checklistItemDate(item, task.timeZone)
      && checklistItemDate(item, task.timeZone) !== targetDate,
  );
}

export function routineTaskPayload(task: TickTickTask, targetDate: string, requireDueDate = false): Record<string, unknown> {
  const scheduledDate = routineTaskDate(task);
  const newDate = `${targetDate}T00:00:00+0800`;
  const shiftedStartDate = scheduledDate
    ? shiftTickTickDate(task.startDate, scheduledDate, targetDate)
    : newDate;
  let shiftedDueDate = scheduledDate
    ? shiftTickTickDate(task.dueDate, scheduledDate, targetDate)
    : newDate;
  if (requireDueDate && !shiftedDueDate) shiftedDueDate = shiftedStartDate || newDate;
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    ...(task.content !== undefined ? { content: task.content } : {}),
    ...(task.desc !== undefined ? { desc: task.desc } : {}),
    ...(!scheduledDate ? { isAllDay: true } : task.isAllDay !== undefined ? { isAllDay: task.isAllDay } : {}),
    ...(shiftedStartDate ? { startDate: shiftedStartDate } : {}),
    ...(shiftedDueDate ? { dueDate: shiftedDueDate } : {}),
    ...(!scheduledDate ? { timeZone: 'Asia/Shanghai' } : task.timeZone ? { timeZone: task.timeZone } : {}),
    ...(task.reminders !== undefined ? { reminders: task.reminders } : {}),
    ...(task.tags !== undefined ? { tags: task.tags } : {}),
    ...(task.repeatFlag ? { repeatFlag: task.repeatFlag } : {}),
    ...(task.repeatFrom !== undefined ? { repeatFrom: task.repeatFrom } : {}),
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
    ...(task.sortOrder !== undefined ? { sortOrder: task.sortOrder } : {}),
    ...(task.kind ? { kind: task.kind } : {}),
    ...(task.parentId ? { parentId: task.parentId } : {}),
    ...(task.items !== undefined ? { items: shiftedRoutineItems(task, targetDate) } : {}),
  };
}

export async function updateRoutineTaskDate(
  api: TickTickApi, task: TickTickTask, targetDate: string, preserveRepeat: boolean, requireDueDate = false,
): Promise<TickTickTask | null> {
  if (routineTaskIsAligned(task, targetDate) && (!requireDueDate || task.dueDate)) return null;
  const payload = routineTaskPayload(task, targetDate, requireDueDate);
  await api.updateTask(task.id, payload);
  const updated = await api.getTask(task.projectId, task.id);
  if (updated?.id !== task.id) throw new Error(`TickTick 未正确更新“${task.title}”的日期`);
  const datesPersisted = (['startDate', 'dueDate'] as const).every((key) => {
    const expected = payload[key];
    if (typeof expected !== 'string') return true;
    return updated[key] === expected || Date.parse(updated[key] ?? '') === Date.parse(expected);
  });
  const itemsPersisted = !(task.items ?? []).some((item) => {
    if (checklistItemStatus(item) !== 0 || !checklistItemDate(item, task.timeZone)) return false;
    const saved = updated.items?.find((candidate) => candidate.id === item.id);
    return !saved || checklistItemDate(saved, updated.timeZone) !== targetDate;
  });
  if (preserveRepeat && ((updated.repeatFlag || '') !== (task.repeatFlag || '')
    || (task.repeatFrom !== undefined && String(updated.repeatFrom) !== String(task.repeatFrom)))) {
    throw new Error(`TickTick 未正确保留“${task.title}”的重复规则`);
  }
  if (!datesPersisted || !itemsPersisted || !routineTaskIsAligned(updated, targetDate)) {
    throw new Error(`TickTick 未正确更新“${task.title}”的日期`);
  }
  return updated;
}

// Callers hold the shared write lock. Re-read each matching task to retain edits
// made since the list snapshot, and never revive a completed occurrence.
export async function readRoutineCalendarState(): Promise<unknown> {
  const [{ kv }, { resolveCalendarState }] = await Promise.all([import('./_accountKv.js'), import('../src/utils/internship.js')]);
  const [calendar, config] = await Promise.all([kv.get('calendar-tags'), kv.get('app-config')]);
  return resolveCalendarState(config, calendar);
}

export function nextRoutineSceneDate(task: TickTickTask, calendarState: unknown, from: string): string | null {
  const scenes = routineScenes(task);
  if (!scenes.length) return from;
  const targets = getTickTickRoutineTargetDates(calendarState, from);
  return scenes.map(scene => targets[scene]).filter((date): date is string => Boolean(date)).sort()[0] ?? null;
}

// A candidate day only needs its own scene. Looking up the next scene date
// scans the entire lifetime calendar for every project in a rolling forecast.
export function routineSceneMatchesDate(task: TickTickTask, calendarState: unknown, date: string): boolean {
  const scenes = routineScenes(task);
  if (!scenes.length) return true;
  if (!isValidCalendarDate(date)) return false;
  const scene = routineCalendarScene(calendarTagMapFromSyncState(calendarState)[date]);
  return scene !== null && scenes.includes(scene);
}

export async function syncTickTickAlwaysToday(api: TickTickApi, options: { tasks?: TickTickTask[]; today?: string; calendarState?: unknown; protectedTaskIds?: ReadonlySet<string> } = {}) {
  const tasks = options.tasks ?? await readAllTickTickTasks(api, [0]);
  const today = options.today ?? calendarDateInTimeZone(new Date().toISOString())!;
  // A skipped eye-drop slot is already scheduled for its next occurrence.
  // Only yesterday's (or older) tagged slots need to be aligned to today.
  const needsToday = (task: TickTickTask) => !isEyeDrops(task) || isPastEyeDrop(task, today) && canAdvanceEyeDrop(task);
  const candidates = tasks.filter(task => !options.protectedTaskIds?.has(task.id) && needsToday(task) && isAlwaysTodayTask(task) && isPendingTickTickTask(task));
  if (!candidates.length) return { matched: 0, updated: 0 };
  const calendarState = options.calendarState ?? (candidates.some(task => routineScenes(task).length)
    ? await readRoutineCalendarState() : undefined);
  // A repeating task can already be pending again with a new ID after completion.
  // Read today's actual completions before any writes; failed reads must not look empty.
  const completed = await schedulingStage('completion-history', true, async () => {
    const records = await collectCompleted(api, [...new Set(candidates.map(task => task.projectId))],
      Date.parse(`${today}T00:00:00+08:00`), Date.parse(`${today}T23:59:59.999+08:00`), Date.now() + 55_000);
    return records.filter(task => {
      if ((task.status ?? 2) !== 2) return false;
      if (!task.id || !task.projectId || !task.title || !task.completedTime
        || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(task.completedTime) || !Number.isFinite(Date.parse(task.completedTime))) {
        throw new Error('TickTick 完成记录无效，未调整固定今日任务');
      }
      return Date.parse(task.completedTime) <= Date.now() && calendarDateInTimeZone(task.completedTime, 'Asia/Shanghai') === today;
    });
  });
  const wasCompleted = matchCompletedOccurrences(tasks, completed);
  let matched = 0, updated = 0;
  for (const candidate of candidates) {
    if (!isAlwaysTodayTask(candidate) || !isPendingTickTickTask(candidate)) continue;
    const task = await api.getTask(candidate.projectId, candidate.id);
    if (!task || task.id !== candidate.id || task.projectId !== candidate.projectId) throw new Error('always-today 待办读取失败');
    const datesChanged = candidate.startDate !== task.startDate || candidate.dueDate !== task.dueDate;
    const completionChanged = hasNewTaskCompletion(task, candidate);
    Object.assign(candidate, task);
    if (!isAlwaysTodayTask(task) || !needsToday(task) || !isPendingTickTickTask(task) || completionChanged) continue;
    matched++;
    if (wasCompleted(task)) continue;
    // A new recurring occurrence may have appeared after the history snapshot.
    // Leave concurrently advanced/edited dates for the next fresh read.
    if (task.repeatFlag && datesChanged) continue;
    const sceneDate = nextRoutineSceneDate(task, calendarState, today);
    if (!sceneDate) continue;
    // The date writer expects a task-local day. A midnight Beijing slot may
    // still belong to the previous calendar day in the task's timezone.
    const eyeDay = isEyeDrops(task) ? eyeDropShanghaiDay(task) : null;
    const target = eyeDay ? addCalendarDays(routineTaskDate(task)!, calendarDayDifference(sceneDate, eyeDay)) : sceneDate;
    const saved = await updateRoutineTaskDate(api, task, target, true, true);
    if (!saved) continue;
    if (!isPendingTickTickTask(saved) || hasNewTaskCompletion(saved, task) || saved.projectId !== task.projectId
      || (['title', 'content', 'desc', 'priority', 'tags', 'reminders', 'parentId', 'sortOrder', 'kind'] as const)
        .some(key => JSON.stringify(saved[key] ?? null) !== JSON.stringify(task[key] ?? null))) {
      throw new Error('always-today 待办更新结果未确认');
    }
    Object.assign(candidate, saved);
    updated++;
  }
  return { matched, updated };
}

function isHairWashAnchor(task: TickTickTask): boolean {
  return task.title.normalize('NFKC').trim() === '洗头';
}

export function followsHairWash(task: TickTickTask): boolean {
  return !isHairWashAnchor(task) && (task.tags ?? []).some((tag) => tag.normalize('NFKC').trim() === '洗头');
}

export async function syncTickTickRoutines(options: {
  api: TickTickApi;
  calendarState: unknown;
  today: string;
  excludedTaskIds?: ReadonlySet<string>;
  minimumTaskDates?: ReadonlyMap<string, string>;
  fixedTaskDates?: ReadonlyMap<string, string>;
  completedTasks?: TickTickTask[];
  planDay?: (tasks: TickTickTask[]) => Promise<ReadonlyMap<string, string>>;
}): Promise<TickTickRoutineSyncResult> {
  const { api, calendarState, today, excludedTaskIds = new Set<string>() } = options;
  const tagMap = calendarTagMapFromSyncState(calendarState);
  const currentScene = routineCalendarScene(tagMap[today]);
  const routineTargets = getTickTickRoutineTargetDates(calendarState, today);
  const allTasks = await readAllTickTickTasks(api, [0]);
  const alwaysToday = await syncTickTickAlwaysToday(api, { tasks: allTasks, today, calendarState });
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const pendingTasks = allTasks.filter((task) => (task.status ?? 0) === 0);
  const hairWashFollowers = pendingTasks.filter(task => followsHairWash(task) && !isAlwaysTodayTask(task) && !isEyeDrops(task));
  const hairWashAnchors = pendingTasks.filter(isHairWashAnchor);
  if (hairWashFollowers.length > 0 && hairWashAnchors.length > 1) {
    throw new Error(`找到 ${hairWashAnchors.length} 个未完成的“洗头”待办，请保留一个同名待办作为日期来源`);
  }
  const isExcluded = (task: TickTickTask) => {
    const visited = new Set<string>();
    let current: TickTickTask | undefined = task;
    while (current && !visited.has(current.id)) {
      if (excludedTaskIds.has(current.id)) return true;
      visited.add(current.id);
      if (current.parentId && excludedTaskIds.has(current.parentId)) return true;
      current = current.parentId ? tasksById.get(current.parentId) : undefined;
    }
    return false;
  };
  const candidates = allTasks
    .filter((task) => (task.status ?? 0) === 0 && !isExcluded(task) && !isAlwaysTodayTask(task) && !isEyeDrops(task))
    .map((task) => {
      const scenes = routineScenes(task);
      const recurrence = scenes.includes('school') || scenes.includes('travel')
        ? routineRecurrence(task.repeatFlag) : 'none';
      return { task, scenes, recurrence };
    })
    .filter(({ scenes }) => scenes.length > 0);
  let updatedRoutineTasks = alwaysToday.updated;
  const routineTaskCounts = { home: 0, school: 0, travel: 0 };
  for (const { scenes } of candidates) {
    for (const scene of scenes) routineTaskCounts[scene] += 1;
  }

  const schedulingCandidates = candidates.filter(({ task, scenes, recurrence }) => {
    // Explicit date following takes precedence over every scene / recurrence rule,
    // including when the anchor is missing or has no usable date.
    if (followsHairWash(task)) return false;
    if (recurrence === 'unknown') return false;
    if (recurrence !== 'long') return true;
    // In an applicable scene, TickTick owns the next occurrence, even if it is
    // overdue or was just generated after completion. Do not realign checklist dates either.
    return currentScene !== null && !(scenes.includes(currentScene) && routineTaskDate(task));
  });
  const routineProjectIds = [...new Set(schedulingCandidates
    .filter(({ task }) => Boolean(task.repeatFlag)).map(({ task }) => task.projectId))];
  const completedToday = routineProjectIds.length > 0 ? await api.listCompletedTasks(
    routineProjectIds,
    `${today}T00:00:00+0800`,
    `${today}T23:59:59.999+0800`,
  ) : [];
  const wasCompleted = matchCompletedOccurrences(allTasks, completedToday.filter(task =>
    (task.status ?? 2) === 2 && calendarDateInTimeZone(task.completedTime, 'Asia/Shanghai') === today));
  const tomorrowTargets = getTickTickRoutineTargetDates(calendarState, addCalendarDays(today, 1));

  const targetDates = new Map<string, string>();
  let sprayDates = new Map<string, string>();
  const boundedDate = (task: TickTickTask, date: string): string | null => {
    const sprayDate = sprayDates.get(task.id);
    if (sprayDate) return nextRoutineSceneDate(task, calendarState, sprayDate);
    // Rolling training owns these dates, including for hair-wash followers.
    const fixed = options.fixedTaskDates?.get(task.id);
    if (fixed) return nextRoutineSceneDate(task, calendarState, fixed);
    const minimum = options.minimumTaskDates?.get(task.id);
    if (!minimum) return nextRoutineSceneDate(task, calendarState, date);
    const from = date < minimum ? minimum : date;
    const scenes = routineScenes(task);
    if (!scenes.length) return from;
    const targets = getTickTickRoutineTargetDates(calendarState, from);
    return scenes.map(scene => targets[scene]).filter((day): day is string => day !== null).sort()[0] ?? null;
  };
  for (const { task, scenes, recurrence } of schedulingCandidates) {
    const completedThisOccurrence = Boolean(task.repeatFlag) && wasCompleted(task);
    const targets = completedThisOccurrence ? tomorrowTargets : routineTargets;
    const taskTargetDate = recurrence === 'long'
      ? findRoutineTargetDate(tagMap, completedThisOccurrence ? addCalendarDays(today, 1) : today, (tag) => {
        const scene = routineCalendarScene(tag);
        return scene !== null && scenes.includes(scene);
      })
      : scenes.map((scene) => targets[scene]).filter((date): date is string => date !== null).sort()[0];
    if (!taskTargetDate) continue;
    targetDates.set(task.id, taskTargetDate);
  }

  // Include a spray's explicit hair-wash date before applying the exclusion,
  // so the later follower pass cannot undo the separation.
  const sprayAnchor = hairWashAnchors.length === 1 ? hairWashAnchors[0] : undefined;
  const sprayAnchorDate = sprayAnchor ? targetDates.get(sprayAnchor.id) ?? routineTaskDate(sprayAnchor) : null;
  if (sprayAnchorDate) for (const task of hairWashFollowers.filter(task => sprayKind(task) && !isExcluded(task))) {
    const target = boundedDate(task, sprayAnchorDate);
    if (target) targetDates.set(task.id, target);
  }

  // Plan against the scene-adjusted snapshot before writing, so a second sync
  // does not first pull deferred tasks back to today and then move them again.
  if (options.planDay) {
    const sceneTasks = allTasks.map((task) => targetDates.has(task.id)
      ? { ...task, ...routineTaskPayload(task, targetDates.get(task.id)!) } as TickTickTask : task);
    for (const [id, date] of await options.planDay(sceneTasks)) {
      if (!isAlwaysTodayTask(tasksById.get(id)!)) targetDates.set(id, date);
    }
  }
  sprayDates = separateTickTickSprays({ tasks: allTasks, dates: targetDates,
    history: [...options.completedTasks ?? [], ...completedToday], calendarState, today, excludedTaskIds });
  for (const [id, date] of targetDates) {
    const task = tasksById.get(id)!;
    const target = boundedDate(task, date);
    if (!target) continue;
    const updated = await updateRoutineTaskDate(api, task, target, true);
    if (!updated) continue;
    tasksById.set(task.id, updated);
    updatedRoutineTasks += 1;
  }

  // Read the anchor after its scene schedule has settled in this same sync.
  const anchor = hairWashAnchors.length === 1 ? tasksById.get(hairWashAnchors[0].id) : undefined;
  const hairWashDate = anchor ? routineTaskDate(anchor) : null;
  if (hairWashDate && isValidCalendarDate(hairWashDate)) {
    for (const task of hairWashFollowers) {
      const current = tasksById.get(task.id) ?? task;
      const target = boundedDate(current, hairWashDate);
      const updated = target ? await updateRoutineTaskDate(api, current, target, true) : null;
      if (updated) { tasksById.set(task.id, updated); updatedRoutineTasks += 1; }
    }
  }

  return { updatedRoutineTasks, routineTargets, routineTaskCounts };
}

function templateDepth(task: TickTickTask, byId: Map<string, TickTickTask>): number {
  let depth = 0;
  let parentId = task.parentId;
  const seen = new Set<string>();
  while (parentId && byId.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentId;
  }
  return depth;
}

function checklistItemKey(item: TickTickChecklistItem, index: number): string {
  return item.id || `index:${index}:${item.title}`;
}

function overlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.reduce((count, date) => count + (rightSet.has(date) ? 1 : 0), 0);
}

function inheritedPreparationDate(
  task: TickTickTask,
  template: TickTickTemplate,
  trip: TickTickTripSource,
): string | undefined {
  if (task.startDate || task.dueDate) return undefined;
  const byId = new Map(template.tasks.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let stage: TickTickTask | undefined = task;
  while (stage && !seen.has(stage.id)) {
    seen.add(stage.id);
    if (isSevenMonthPreparationTask(stage)) {
      const date = stage.id === template.rootTask.id
        ? trip.startDate
        : shiftTickTickDate(taskDate(stage) ?? undefined, template.anchorDate, trip.startDate)
          ?? addCalendarMonths(trip.startDate, -7);
      return `${date}T00:00:00+0800`;
    }
    stage = stage.parentId ? byId.get(stage.parentId) : undefined;
  }
  return undefined;
}

export function canonicalStageTitle(title: string): string {
  return title.normalize('NFKC').replace(/[\s\uFE0E\uFE0F]/g, '').replace(/[🎒🧳📦📌]+$/u, '');
}

export function relativeStageDate(title: string, departureDate: string): string {
  const normalized = canonicalStageTitle(title);
  if (normalized === TICKTICK_ANCHOR_TITLE) return departureDate;
  const match = /^出门(前|后)(半|[0-9零〇一二两三四五六七八九十百]+)(?:个)?(天|日|周|星期|月|年)$/.exec(normalized);
  if (!match) {
    if (/^出门[前后]/.test(normalized)) throw new Error(`无法识别模板阶段“${title}”的时间，请使用“出门前七个月”或“出门前两周”等名称`);
    return departureDate;
  }
  const digits: Record<string, number> = { 零: 0, '〇': 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const raw = match[2];
  let amount = raw === '半' ? 0.5 : Number(raw);
  if (Number.isNaN(amount)) {
    amount = 0;
    let digit = 0;
    for (const char of raw) {
      if (char === '十' || char === '百') {
        amount += (digit || 1) * (char === '十' ? 10 : 100);
        digit = 0;
      } else digit = digits[char];
    }
    amount += digit;
  }
  const sign = match[1] === '前' ? -1 : 1;
  const unit = match[3];
  if (unit === '年') return addCalendarMonths(departureDate, sign * amount * 12);
  if (unit === '月' && Number.isInteger(amount)) return addCalendarMonths(departureDate, sign * amount);
  const days = amount * (unit === '月' ? 30 : unit === '周' || unit === '星期' ? 7 : 1);
  if (!Number.isInteger(days)) throw new Error(`模板阶段“${title}”需要按整天设置`);
  return addCalendarDays(departureDate, sign * days);
}

function scheduledTaskDate(task: TickTickTask, template: TickTickTemplate, trip: TickTickTripSource): string {
  if (isSevenMonthPreparationTask(template.rootTask) || task.id === template.rootTask.id) return trip.startDate;
  const byId = new Map(template.tasks.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let stage = task;
  while (stage.parentId && stage.parentId !== template.rootTask.id && !seen.has(stage.id)) {
    seen.add(stage.id);
    const parent = byId.get(stage.parentId);
    if (!parent) break;
    stage = parent;
  }
  return relativeStageDate(stage.title, trip.startDate);
}

function inheritsParentSchedule(task: TickTickTask, template: TickTickTemplate): boolean {
  return task.id !== template.rootTask.id && Boolean(task.parentId)
    && (isSevenMonthPreparationTask(template.rootTask) || task.parentId !== template.rootTask.id);
}

function followParentSchedule(payload: Record<string, unknown>, parent: TickTickTask | undefined) {
  if (!parent) return payload;
  return {
    ...payload,
    startDate: parent.startDate ?? null,
    dueDate: parent.dueDate ?? null,
    isAllDay: parent.isAllDay ?? true,
    timeZone: parent.timeZone || 'Asia/Shanghai',
  };
}

function generatedTaskTags(templateTask: TickTickTask, template: TickTickTemplate, source = templateTask): string[] {
  const tags = source.tags ?? [];
  // Wish preparation roots are also children of the original travel template.
  const isTemplateChild = templateTask.id !== template.rootTask.id || isSevenMonthPreparationTask(templateTask);
  const cleanedTags = isTemplateChild ? tags.filter((tag) => tag.normalize('NFKC').trim() !== '不关我事') : tags;
  return [...new Set([...cleanedTags, '当天'])];
}

function baseTaskPayload(
  templateTask: TickTickTask,
  trip: TickTickTripSource,
  template: TickTickTemplate,
  parentId: string | undefined,
  items: TickTickChecklistItem[],
  legacySchedule = false,
): Record<string, unknown> {
  const isRoot = templateTask.id === template.rootTask.id;
  const inferredStageDate = inheritedPreparationDate(templateTask, template, trip);
  const namedDate = `${scheduledTaskDate(templateTask, template, trip)}T00:00:00+0800`;
  const startDate = !legacySchedule ? namedDate : isRoot
    ? `${trip.startDate}T00:00:00+0800`
    : shiftTickTickDate(templateTask.startDate, template.anchorDate, trip.startDate) ?? inferredStageDate;
  const dueDate = !legacySchedule ? namedDate : isRoot
    ? `${trip.startDate}T00:00:00+0800`
    : shiftTickTickDate(templateTask.dueDate, template.anchorDate, trip.startDate) ?? inferredStageDate;
  const rootContent = [templateTask.content?.trim(), trip.note].filter(Boolean).join('\n\n');
  const isTripTemplateRoot = isRoot && (
    TEMPLATE_TITLE_VARIANTS.includes(templateTask.title.trim())
    || LEGACY_TEMPLATE_TITLES.includes(templateTask.title.trim())
  );
  return {
    projectId: template.projectId,
    title: `${trip.name} · ${isTripTemplateRoot ? '出门todo' : templateTask.title}`,
    content: isRoot ? rootContent : (templateTask.content ?? ''),
    desc: templateTask.desc ?? '',
    isAllDay: !legacySchedule || isRoot ? true : (templateTask.isAllDay ?? true),
    ...(startDate ? { startDate } : {}),
    ...(dueDate ? { dueDate } : {}),
    timeZone: legacySchedule ? templateTask.timeZone || 'Asia/Shanghai' : 'Asia/Shanghai',
    reminders: templateTask.reminders ?? [],
    tags: generatedTaskTags(templateTask, template),
    ...(templateTask.repeatFlag ? { repeatFlag: templateTask.repeatFlag } : {}),
    priority: templateTask.priority ?? 0,
    sortOrder: templateTask.sortOrder ?? 0,
    kind: templateTask.kind ?? (items.length > 0 ? 'CHECKLIST' : 'TEXT'),
    ...(parentId ? { parentId } : {}),
    items,
  };
}

function initialChecklistItems(templateTask: TickTickTask, template: TickTickTemplate, trip: TickTickTripSource) {
  return (templateTask.items ?? []).map((item) => ({
    title: item.title,
    status: 0,
    isAllDay: item.isAllDay ?? true,
    sortOrder: item.sortOrder ?? 0,
    ...(item.startDate ? { startDate: shiftTickTickDate(item.startDate, template.anchorDate, trip.startDate) } : {}),
    timeZone: item.timeZone || templateTask.timeZone || 'Asia/Shanghai',
  }));
}

type DateFields = Pick<TickTickTask, 'startDate' | 'dueDate' | 'isAllDay' | 'timeZone'>;
const DATE_FIELDS = ['startDate', 'dueDate', 'isAllDay', 'timeZone'] as const;

function dateSnapshot(value: DateFields, fallback?: DateFields): TickTickDateSnapshot {
  return {
    startDate: value.startDate || null,
    dueDate: value.dueDate || null,
    isAllDay: value.isAllDay ?? fallback?.isAllDay ?? true,
    timeZone: value.timeZone || fallback?.timeZone || 'Asia/Shanghai',
  };
}

function sameDateSnapshot(left: TickTickDateSnapshot, right: TickTickDateSnapshot): boolean {
  const datesMatch = (['startDate', 'dueDate'] as const).every((key) => {
    if (left[key] === right[key]) return true;
    if (!left[key] || !right[key]) return false;
    // API responses can canonicalize +0800 to +0000 without a user edit.
    const leftTime = Date.parse(left[key]);
    const rightTime = Date.parse(right[key]);
    return Number.isFinite(leftTime) && leftTime === rightTime;
  });
  if (!datesMatch) return false;
  if (!left.startDate && !left.dueDate) return true;
  return left.isAllDay === right.isAllDay && left.timeZone === right.timeZone;
}

function hasManualDates(
  current: TickTickDateSnapshot,
  previousAuto: TickTickDateSnapshot,
  state: TickTickDateSyncState | undefined,
): boolean {
  return state?.manual === true || !sameDateSnapshot(current, state?.lastSynced ?? previousAuto);
}

function withoutDateFields<T extends DateFields>(value: T): Omit<T, typeof DATE_FIELDS[number]> {
  const result = { ...value };
  for (const key of DATE_FIELDS) delete result[key];
  return result;
}

function preserveChecklistDates(
  items: TickTickChecklistItem[],
  previousAutoItems: TickTickChecklistItem[],
  generatedTask: TickTickTask,
  instance: TickTickTripInstance,
) {
  const existingById = new Map((generatedTask.items ?? []).map((item) => [item.id, item]));
  const previousAutoById = new Map(previousAutoItems.map((item) => [item.id, item]));
  const manualIds = new Set<string>();
  const protectedItems = items.map((item) => {
    const existing = item.id ? existingById.get(item.id) : undefined;
    const previousAuto = item.id ? previousAutoById.get(item.id) : undefined;
    if (!item.id || !existing || !previousAuto) return item;
    const state = instance.checklistDateStates?.[generatedTask.id]?.[item.id];
    if (!hasManualDates(dateSnapshot(existing, generatedTask), dateSnapshot(previousAuto, generatedTask), state)) return item;
    manualIds.add(item.id);
    // Checklist arrays are sent in full: copy the existing date fields, including
    // their absence after a user clears a date, without replacing other metadata.
    const preserved = { ...withoutDateFields(item) } as TickTickChecklistItem;
    for (const key of ['startDate', 'isAllDay', 'timeZone'] as const) {
      if (Object.prototype.hasOwnProperty.call(existing, key)) Object.assign(preserved, { [key]: existing[key] });
    }
    return preserved;
  });
  return { items: protectedItems, manualIds };
}

function rememberDateStates(
  instance: TickTickTripInstance,
  task: TickTickTask,
  manualTask: boolean,
  manualItems = new Set<string>(),
) {
  (instance.taskDateStates ??= {})[task.id] = { lastSynced: dateSnapshot(task), manual: manualTask };
  const itemStates: Record<string, TickTickDateSyncState> = {};
  for (const item of task.items ?? []) {
    if (item.id) itemStates[item.id] = { lastSynced: dateSnapshot(item, task), manual: manualItems.has(item.id) };
  }
  (instance.checklistDateStates ??= {})[task.id] = itemStates;
}

function forgetDateStates(instance: TickTickTripInstance, taskId: string) {
  delete instance.taskDateStates?.[taskId];
  delete instance.checklistDateStates?.[taskId];
}

function updatedChecklistItems(
  templateTask: TickTickTask,
  generatedTask: TickTickTask,
  instance: TickTickTripInstance,
  template: TickTickTemplate,
  trip: TickTickTripSource,
) {
  const idMap = instance.itemIdsByTemplateTaskId[templateTask.id] ?? {};
  const existingById = new Map((generatedTask.items ?? []).filter((item) => item.id).map((item) => [item.id!, item]));
  const mappedGeneratedIds = new Set(Object.values(idMap));
  const templateItems = (templateTask.items ?? []).map((item, index) => {
    const key = checklistItemKey(item, index);
    const existing = existingById.get(idMap[key]);
    return {
      ...(existing?.id ? { id: existing.id } : {}),
      title: item.title,
      status: existing ? checklistItemStatus(existing) : 0,
      ...(existing?.completedTime ? { completedTime: existing.completedTime } : {}),
      isAllDay: item.isAllDay ?? true,
      sortOrder: item.sortOrder ?? 0,
      ...(item.startDate ? { startDate: shiftTickTickDate(item.startDate, template.anchorDate, trip.startDate) } : {}),
      timeZone: item.timeZone || templateTask.timeZone || 'Asia/Shanghai',
    };
  });
  const manualItems = (generatedTask.items ?? [])
    .filter((item) => !item.id || !mappedGeneratedIds.has(item.id))
    .map((item) => ({ ...item, status: checklistItemStatus(item) }));
  return [...templateItems, ...manualItems];
}

function refreshChecklistIdMap(
  templateTask: TickTickTask,
  generatedTask: TickTickTask,
  instance: TickTickTripInstance,
) {
  const previousMap = instance.itemIdsByTemplateTaskId[templateTask.id] ?? {};
  const available = [...(generatedTask.items ?? [])];
  const nextMap: Record<string, string> = {};
  (templateTask.items ?? []).forEach((item, index) => {
    const key = checklistItemKey(item, index);
    const previousId = previousMap[key];
    const matchIndex = available.findIndex((candidate) => candidate.id && (
      candidate.id === previousId || candidate.title === item.title
    ));
    if (matchIndex < 0) return;
    const [matched] = available.splice(matchIndex, 1);
    if (matched.id) nextMap[key] = matched.id;
  });
  instance.itemIdsByTemplateTaskId[templateTask.id] = nextMap;
}

async function getGeneratedTask(
  api: TickTickApi,
  projectId: string,
  taskId: string,
  knownTasks: Map<string, TickTickTask>,
): Promise<TickTickTask | null> {
  const known = knownTasks.get(taskId);
  if (known) return known;
  try {
    const task = await api.getTask(projectId, taskId);
    knownTasks.set(task.id, task);
    return task;
  } catch (error) {
    if (error instanceof Error && /TickTick 404/.test(error.message)) return null;
    throw error;
  }
}

async function deleteGeneratedTree(
  api: TickTickApi,
  instance: TickTickTripInstance,
  projectId: string,
  templateTasks: TickTickTask[],
  persist: () => Promise<void>,
) {
  const byId = new Map(templateTasks.map((task) => [task.id, task]));
  const ids = Object.entries(instance.taskIdsByTemplateId)
    .sort(([left], [right]) => templateDepth(byId.get(right) ?? { id: right } as TickTickTask, byId) - templateDepth(byId.get(left) ?? { id: left } as TickTickTask, byId));
  for (const [templateTaskId, generatedTaskId] of ids) {
    try {
      await api.deleteTask(projectId, generatedTaskId);
    } catch (error) {
      if (!(error instanceof Error) || !/TickTick 404/.test(error.message)) throw error;
    }
    delete instance.taskIdsByTemplateId[templateTaskId];
    delete instance.itemIdsByTemplateTaskId[templateTaskId];
    forgetDateStates(instance, generatedTaskId);
    await persist();
  }
}

async function rebindTemplateTaskIds(
  api: TickTickApi, template: TickTickTemplate, instance: TickTickTripInstance,
  orderedTasks: TickTickTask[], projectTasks: Map<string, TickTickTask>,
) {
  const currentIds = new Set(orderedTasks.map((task) => task.id));
  if (!Object.keys(instance.taskIdsByTemplateId).some((id) => !currentIds.has(id))) return;
  await Promise.all(Object.values(instance.taskIdsByTemplateId).map((id) => getGeneratedTask(api, template.projectId, id, projectTasks)));
  const rebind = (oldId: string, newId: string) => {
    instance.taskIdsByTemplateId[newId] = instance.taskIdsByTemplateId[oldId];
    if (instance.itemIdsByTemplateTaskId[oldId]) instance.itemIdsByTemplateTaskId[newId] = instance.itemIdsByTemplateTaskId[oldId];
    delete instance.taskIdsByTemplateId[oldId];
    delete instance.itemIdsByTemplateTaskId[oldId];
  };
  for (const task of orderedTasks) {
    if (instance.taskIdsByTemplateId[task.id]) continue;
    const parentId = task.parentId ? instance.taskIdsByTemplateId[task.parentId] : undefined;
    const candidates = Object.entries(instance.taskIdsByTemplateId).filter(([oldId, generatedId]) => {
      if (currentIds.has(oldId)) return false;
      if (task.id === template.rootTask.id) return generatedId === instance.rootTaskId;
      const generated = projectTasks.get(generatedId);
      return parentId && generated?.parentId === parentId && generated.title === `${instance.name} · ${task.title}`;
    });
    // A recreated template can have new IDs. Reuse unambiguous existing tasks and their progress.
    if (candidates.length === 1) rebind(candidates[0][0], task.id);
  }
}

async function syncTripInstance(
  api: TickTickApi,
  template: TickTickTemplate,
  projectTasks: Map<string, TickTickTask>,
  trip: TickTickTripSource,
  instance: TickTickTripInstance,
  persist: () => Promise<void>,
) {
  // Existing installations do not have per-task snapshots yet. Reconstruct the
  // last automatic schedule using the *previous* trip, not its newly edited dates.
  const previousTrip: TickTickTripSource = {
    key: instance.tripKey, startDate: instance.startDate, endDate: instance.endDate,
    dates: instance.dates, name: instance.name, note: '',
  };
  const templateById = new Map(template.tasks.map((task) => [task.id, task]));
  const orderedTemplateTasks = [...template.tasks].sort(
    (left, right) => templateDepth(left, templateById) - templateDepth(right, templateById),
  );

  // Validate stage names before creating or updating any part of the instance.
  for (const task of orderedTemplateTasks) scheduledTaskDate(task, template, trip);
  // A generated tree can move independently of its template. Confirm the root's
  // current location before using a persisted project ID for writes or creation.
  const rootId = instance.rootTaskId ?? instance.taskIdsByTemplateId[template.rootTask.id];
  const knownRoot = rootId ? projectTasks.get(rootId) : undefined;
  if (knownRoot && knownRoot.projectId !== template.projectId) {
    const currentRoot = await api.getTask(knownRoot.projectId, knownRoot.id);
    if (currentRoot.id !== knownRoot.id || !currentRoot.projectId) throw new Error('无法确认出行任务当前清单，未继续同步');
    template = { ...template, projectId: currentRoot.projectId };
    instance.projectId = currentRoot.projectId;
    projectTasks.set(currentRoot.id, currentRoot);
    await persist();
  }
  await rebindTemplateTaskIds(api, template, instance, orderedTemplateTasks, projectTasks);

  for (const templateTask of orderedTemplateTasks) {
    const parentId = templateTask.parentId ? instance.taskIdsByTemplateId[templateTask.parentId] : undefined;
    const inheritsParent = inheritsParentSchedule(templateTask, template);
    const scheduledParent = inheritsParent && parentId ? projectTasks.get(parentId) : undefined;
    const generatedTaskId = instance.taskIdsByTemplateId[templateTask.id];
    const generatedTask = generatedTaskId
      ? await getGeneratedTask(api, template.projectId, generatedTaskId, projectTasks)
      : null;
    if (!generatedTask) {
      if (generatedTaskId) forgetDateStates(instance, generatedTaskId);
      const payload = followParentSchedule(baseTaskPayload(
        templateTask,
        trip,
        template,
        parentId,
        initialChecklistItems(templateTask, template, trip),
      ), scheduledParent);
      const created = await api.createTask(payload);
      if (!created?.id) throw new Error('TickTick 创建任务后未返回任务 ID');
      // Keep fields from the request when an API reply contains only an ID.
      let resolved = { ...payload, ...created } as unknown as TickTickTask;
      instance.taskIdsByTemplateId[templateTask.id] = created.id;
      if (templateTask.id === template.rootTask.id) instance.rootTaskId = created.id;
      const requestedItems = payload.items as TickTickChecklistItem[];
      if (requestedItems.length && (created.items?.length !== requestedItems.length || !created.items.every((item) => item.id))) {
        // Save the new identity before a follow-up request can fail. A retry must
        // resume this task, not create another copy of the same template task.
        rememberDateStates(instance, resolved, false);
        await persist();
        resolved = { ...resolved, ...await api.getTask(template.projectId, created.id) };
      }
      refreshChecklistIdMap(templateTask, resolved, instance);
      rememberDateStates(instance, resolved, false);
      projectTasks.set(created.id, resolved);
      await persist();
      continue;
    }

    // Recover missing item mappings after a compact create response / interrupted
    // follow-up read, before constructing a full checklist replacement.
    const previousItemMap = instance.itemIdsByTemplateTaskId[templateTask.id] ?? {};
    refreshChecklistIdMap(templateTask, generatedTask, instance);
    instance.itemIdsByTemplateTaskId[templateTask.id] = {
      ...previousItemMap, ...instance.itemIdsByTemplateTaskId[templateTask.id],
    };
    const previousItems = updatedChecklistItems(templateTask, generatedTask, instance, template, previousTrip);
    const protectedChecklist = preserveChecklistDates(
      updatedChecklistItems(templateTask, generatedTask, instance, template, trip),
      previousItems, generatedTask, instance,
    );
    const previousAuto = baseTaskPayload(templateTask, previousTrip, template, parentId, previousItems);
    const savedDateState = instance.taskDateStates?.[generatedTask.id];
    const isUndatedScheduleMigration = !templateTask.startDate && !templateTask.dueDate
      && !generatedTask.startDate
      && !generatedTask.dueDate
      && !savedDateState;
    const legacyAuto = baseTaskPayload(templateTask, previousTrip, template, parentId, previousItems, true);
    const matchesLegacyAuto = !savedDateState && sameDateSnapshot(dateSnapshot(generatedTask), dateSnapshot(legacyAuto));
    // Parent dates are the default for descendants, but an individual task's
    // manual override takes precedence at every depth of the generated tree.
    const manualTask = !isUndatedScheduleMigration && !matchesLegacyAuto && hasManualDates(
      dateSnapshot(generatedTask), dateSnapshot(previousAuto), savedDateState,
    );
    const automaticPayload = followParentSchedule(baseTaskPayload(templateTask, trip, template, parentId, protectedChecklist.items), scheduledParent);
    const payload = {
      id: generatedTask.id,
      // Omit task dates entirely for manual overrides; a metadata-only update
      // cannot reintroduce a date that the user cleared or moved again meanwhile.
      ...(manualTask ? withoutDateFields(automaticPayload) : automaticPayload),
      tags: generatedTaskTags(templateTask, template, generatedTask),
    };
    const updated = await api.updateTask(generatedTask.id, payload);
    let resolved = { ...generatedTask, ...payload, ...updated } as TickTickTask;
    if (protectedChecklist.items.some((item) => !item.id)) {
      resolved = { ...resolved, ...await api.getTask(template.projectId, generatedTask.id) };
    }
    refreshChecklistIdMap(templateTask, resolved, instance);
    rememberDateStates(instance, resolved, manualTask, protectedChecklist.manualIds);
    projectTasks.set(generatedTask.id, resolved);
    await persist();
  }

  const templateTaskIds = new Set(template.tasks.map((task) => task.id));
  const obsolete = Object.entries(instance.taskIdsByTemplateId)
    .filter(([templateTaskId]) => !templateTaskIds.has(templateTaskId));
  const generatedIds = new Set(Object.values(instance.taskIdsByTemplateId));
  for (const [obsoleteTemplateId, generatedTaskId] of obsolete) {
    const manualChildren = [...projectTasks.values()].filter(
      (task) => task.parentId === generatedTaskId && !generatedIds.has(task.id),
    );
    for (const manualChild of manualChildren) {
      if (!instance.rootTaskId || manualChild.id === instance.rootTaskId) continue;
      const moved = await api.updateTask(manualChild.id, {
        id: manualChild.id,
        projectId: template.projectId,
        parentId: instance.rootTaskId,
      });
      projectTasks.set(manualChild.id, moved?.id ? moved : { ...manualChild, parentId: instance.rootTaskId });
    }
    try {
      await api.deleteTask(template.projectId, generatedTaskId);
    } catch (error) {
      if (!(error instanceof Error) || !/TickTick 404/.test(error.message)) throw error;
    }
    delete instance.taskIdsByTemplateId[obsoleteTemplateId];
    delete instance.itemIdsByTemplateTaskId[obsoleteTemplateId];
    forgetDateStates(instance, generatedTaskId);
    await persist();
  }

  instance.tripKey = trip.key;
  instance.startDate = trip.startDate;
  instance.endDate = trip.endDate;
  instance.dates = [...trip.dates];
  instance.name = trip.name;
  await persist();
}

export async function reconcileTickTickTrips(options: {
  api: TickTickApi;
  template: TickTickTemplate;
  trips: TickTickTripSource[];
  state: TickTickTripSyncState;
  today: string;
  matchByDateOverlap?: boolean;
  legacyProjectId?: string;
  sourceTasks?: TickTickTask[];
  saveState: (state: TickTickTripSyncState) => Promise<void>;
}): Promise<TickTickSyncResult> {
  const { api, template, state, today, saveState } = options;
  const activeTrips = options.trips.filter((trip) => trip.endDate >= today);
  const activeKeys = new Set(activeTrips.map((trip) => trip.key));
  const activeInstances = Object.entries(state.instances).filter(([key, instance]) => instance.endDate >= today || activeKeys.has(key));
  const originalProjectId = options.legacyProjectId ?? template.projectId;
  const projectIds = [...new Set([template.projectId, ...activeInstances.map(([, instance]) => instance.projectId ?? originalProjectId)])];
  const projectData = await Promise.all(projectIds.map((projectId) => api.getProjectData(projectId)));
  const projectTasks = new Map([...(options.sourceTasks ?? []), ...projectData.flatMap((data) => data.tasks)].map((task) => [task.id, task]));
  const unmatchedInstances = new Map(activeInstances);
  const matches = new Map<string, { oldKey: string; instance: TickTickTripInstance }>();

  for (const trip of activeTrips) {
    const exact = unmatchedInstances.get(trip.key);
    if (!exact) continue;
    matches.set(trip.key, { oldKey: trip.key, instance: exact });
    unmatchedInstances.delete(trip.key);
  }
  for (const trip of activeTrips) {
    if (options.matchByDateOverlap === false || matches.has(trip.key)) continue;
    const candidates = [...unmatchedInstances.entries()]
      .map(([key, instance]) => ({ key, instance, overlap: overlapCount(trip.dates, instance.dates) }))
      .filter((candidate) => candidate.overlap > 0)
      .sort((left, right) => right.overlap - left.overlap);
    if (candidates.length === 0) continue;
    const best = candidates[0];
    matches.set(trip.key, { oldKey: best.key, instance: best.instance });
    unmatchedInstances.delete(best.key);
  }

  let createdTrips = 0;
  let updatedTrips = 0;
  let deletedTrips = 0;
  const persist = async () => {
    state.lastError = undefined;
    await saveState(state);
  };

  for (const trip of activeTrips) {
    const matched = matches.get(trip.key);
    const instance = matched?.instance ?? {
      projectId: template.projectId,
      tripKey: trip.key,
      startDate: trip.startDate,
      endDate: trip.endDate,
      dates: [...trip.dates],
      name: trip.name,
      taskIdsByTemplateId: {},
      itemIdsByTemplateTaskId: {},
    };
    instance.projectId ??= originalProjectId;
    if (matched && matched.oldKey !== trip.key) delete state.instances[matched.oldKey];
    state.instances[trip.key] = instance;
    await persist();
    await syncTripInstance(api, { ...template, projectId: instance.projectId }, projectTasks, trip, instance, persist);
    if (matched) updatedTrips += 1;
    else createdTrips += 1;
  }

  for (const [key, instance] of unmatchedInstances) {
    await deleteGeneratedTree(api, instance, instance.projectId ?? originalProjectId, template.tasks, persist);
    delete state.instances[key];
    deletedTrips += 1;
    await persist();
  }

  state.lastSyncAt = new Date().toISOString();
  state.lastError = undefined;
  await saveState(state);
  return { createdTrips, updatedTrips, deletedTrips, activeTrips: activeTrips.length };
}

export async function reconcileTickTickWishPreparations(options: {
  api: TickTickApi;
  template: TickTickTemplate;
  configState: unknown;
  state: TickTickTripSyncState;
  today: string;
  legacyProjectId?: string;
  sourceTasks?: TickTickTask[];
  saveState: (state: TickTickTripSyncState) => Promise<void>;
}) {
  const { state, template, today, saveState } = options;
  const wishes = buildWishPreparationSourcesFromSyncState(options.configState);
  const hasActiveWishes = wishes.some((wish) => wish.endDate >= today);
  if (!hasActiveWishes && !Object.values(state.wishInstances ?? {}).some((instance) => instance.endDate >= today)) {
    return { createdWishPreparations: 0, updatedWishPreparations: 0, deletedWishPreparations: 0, activeWishPreparations: 0 };
  }
  // 没有待生成心愿时无需七个月模板，仍可清理后来已关联/停用/删除的心愿副本。
  const selectedTemplate = hasActiveWishes ? wishPreparationTemplate(template) : template;
  const result = await reconcileTickTickTrips({
    api: options.api,
    template: selectedTemplate,
    trips: wishes,
    state: { instances: state.wishInstances ?? {} },
    today,
    legacyProjectId: options.legacyProjectId,
    sourceTasks: options.sourceTasks,
    // 同一天的不同心愿不能像日历行程那样凭日期重叠合并。
    matchByDateOverlap: false,
    saveState: async (next) => {
      state.wishInstances = next.instances;
      if (next.lastSyncAt) state.lastSyncAt = next.lastSyncAt;
      await saveState(state);
    },
  });
  return {
    createdWishPreparations: result.createdTrips,
    updatedWishPreparations: result.updatedTrips,
    deletedWishPreparations: result.deletedTrips,
    activeWishPreparations: result.activeTrips,
  };
}
