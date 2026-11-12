import { calendarCells, type CycleSettings, type LifeEntries, type TrainingRecord } from './bonLife.js';
import ICAL from 'ical.js';
import { cycleDay, suggestedTraining } from './lifeCycle.js';
import { swimmingHairWashDates, type HairWashSchedule } from './lifeSwimming.js';
import { isCalendarDate } from './outlookCalendar.js';

export const TRAINING_MARKER = '运动是生活的第一个锚点';
export const trainingProjectKey = (name: string) => name.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
export const isTrainingTitle = (title: string) => trainingProjectKey(title).includes(TRAINING_MARKER)
  && trainingProjectKey(title) !== TRAINING_MARKER;
export const trainingName = (title: string) => (title.includes('运动') ? title.slice(0, title.indexOf('运动')).replace(/[\s·—\-:：]+$/u, '').trim() : title) || title;

export const TRAINING_TAGS = ['有氧', '力量'] as const;
export type TrainingTag = typeof TRAINING_TAGS[number];
export const isTrainingCategory = (name: string) => /^(有氧|力量)(运动|训练)?$/.test(trainingProjectKey(name));
export function trainingTags(project: { name: string; tags?: TrainingTag[] }): TrainingTag[] {
  if (project.tags) return project.tags;
  if (/爬坡|游泳|跑步|骑行|单车|椭圆机|燃脂操|有氧|HIIT/i.test(project.name)) return ['有氧'];
  if (/力量|力训|臀|腿|上半身|下半身|背|胸|哑铃/.test(project.name)) return ['力量'];
  return [];
}

export interface TrainingTask {
  id: string;
  key?: string;
  rotation?: boolean;
  tags?: TrainingTag[];
  name: string;
  title: string;
  schedule: string;
  dates: string[];
  scheduledDate?: string;
  repeatFlag?: string;
  notes: string;
  links: { title: string; url: string }[];
}
export interface TrainingCompletion { project: string; date: string }
export interface TrainingSource {
  year: number; tasks: TrainingTask[]; connected: boolean; syncedAt: string | null;
  completions?: TrainingCompletion[]; entries?: LifeEntries; periodDays?: string[];
  settings?: TrainingSettings;
  hairWash?: HairWashSchedule | null;
}

export interface TrainingProject { key: string; name: string; notes: string; rotation: boolean; tags?: TrainingTag[] }
export interface TrainingSettings { projects: TrainingProject[]; revision: string }
export const DEFAULT_TRAINING_SETTINGS: TrainingSettings = { projects: [], revision: '' };
export const trainingIdentity = (task: TrainingTask) => task.key ?? trainingProjectKey(task.name);
export const isSwimmingTraining = (task: Pick<TrainingTask, 'title' | 'name'>) => `${task.title}${task.name}`.includes('游泳');

export function parseTrainingSettings(value: unknown): TrainingSettings {
  const input = value as TrainingSettings | null;
  if (!input || typeof input.revision !== 'string' || input.revision.length > 80
    || !Array.isArray(input.projects) || input.projects.length > 60) throw new Error('运动项目设置无效');
  const keys = new Set<string>(); const names = new Set<string>();
  const projects = input.projects.map((project) => {
    if (!project || typeof project.key !== 'string' || !project.key || project.key.length > 120
      || typeof project.name !== 'string' || !project.name.trim() || project.name.length > 60 || !trainingProjectKey(project.name)
      || typeof project.notes !== 'string' || project.notes.length > 500 || typeof project.rotation !== 'boolean') throw new Error('运动项目信息无效');
    if (project.tags !== undefined && (!Array.isArray(project.tags) || project.tags.length > TRAINING_TAGS.length
      || project.tags.some((tag) => !TRAINING_TAGS.includes(tag)))) throw new Error('运动项目标签无效');
    const name = trainingProjectKey(project.name);
    if (keys.has(project.key) || names.has(name)) throw new Error('运动项目不能重复');
    keys.add(project.key); names.add(name);
    return { key: project.key, name: project.name.trim(), notes: project.notes.trim(), rotation: project.rotation,
      ...(project.tags !== undefined ? { tags: TRAINING_TAGS.filter((tag) => project.tags!.includes(tag)) } : {}) };
  });
  return { projects, revision: input.revision };
}

export function trainingLibrary(tasks: TrainingTask[], settings = DEFAULT_TRAINING_SETTINGS): TrainingTask[] {
  const reusable = (name: string): TrainingTask => ({ id: `template:${name}`, key: trainingProjectKey(name), name, title: name,
    notes: '', rotation: false, schedule: '', dates: [], links: [] });
  const library = new Map(['爬坡', '游泳'].map((name) => [trainingProjectKey(name), reusable(name)]));
  for (const task of tasks) library.set(trainingIdentity(task), { ...task, key: trainingIdentity(task), rotation: task.rotation ?? true });
  for (const project of settings.projects) {
    const previous = library.get(project.key) ?? [...library.values()].find(task => trainingProjectKey(task.name) === trainingProjectKey(project.name));
    // A local reusable project can later gain a same-name TickTick task. Keep
    // its saved identity and settings, but bind it to that task only once.
    if (previous && trainingIdentity(previous) !== project.key) library.delete(trainingIdentity(previous));
    library.set(project.key, { ...(previous ?? reusable(project.name)), ...project, id: previous?.id ?? `template:${project.key}` });
  }
  return [...library.values()].filter((task) => !isTrainingCategory(task.name)).map((task) => ({ ...task, tags: trainingTags(task) }));
}

export function reuseTrainingProjects(tasks: TrainingTask[]): TrainingRecord {
  const plan = tasks.map((task) => `${task.name}${task.notes ? ` · ${task.notes.replace(/\n/g, '；')}` : ''}`).join('\n');
  if (plan.length > 1000) throw new Error('运动内容过长，请减少项目或简化项目内容');
  return { plan, projects: tasks.map(trainingIdentity), effort: 'normal', completed: false, mode: 'manual' };
}

export function recordedTrainingProjects(record: TrainingRecord, tasks: TrainingTask[]) {
  if (record.effort === 'rest') return [];
  const keys = new Set(tasks.map(trainingIdentity));
  const names = new Map(tasks.map((task) => [trainingProjectKey(task.name), trainingIdentity(task)]));
  // New records carry explicit project identities. Legacy/manual text is matched
  // only as an exact exercise heading, never as a mention such as “今天没练有氧”.
  return [...new Set((record.projects?.map(key => keys.has(key) ? key : names.get(trainingProjectKey(key)) ?? '')
    ?? record.plan.split('\n').map((line) => names.get(trainingProjectKey(line.split(' · ')[0].trim())) ?? ''))
    .filter((key) => keys.has(key)))];
}

// Personal defaults based on the user's template, not physiological performance guarantees.
// Evidence supports individual adjustment: https://pmc.ncbi.nlm.nih.gov/articles/PMC7497427/
export function personalTraining(date: string, tasks: TrainingTask[], settings: CycleSettings, periods: string[], effort: TrainingRecord['effort'] = 'normal'): string {
  if (effort === 'rest') return '休息';
  const phase = cycleDay(date, settings, periods);
  if (effort === 'easy' || (phase?.phase === 'menstrual' && phase.day <= 3)) return '轻松散步 15 分钟 · 舒缓拉伸 5 分钟';
  if (!tasks.length) return '休息 · 可选散步或拉伸';
  return [...new Set(tasks.map((task) => {
    if (!phase) return task.name;
    if (phase?.phase === 'menstrual' || phase?.phase === 'lateLuteal') {
      if (phase.phase === 'menstrual' && /HIIT|间歇/i.test(task.name)) return '低强度有氧 20 分钟';
      return `${task.name} · 轻量`;
    }
    if (phase.phase === 'earlyLuteal' && trainingTags(task).includes('力量')) return `${task.name} · 可加量`;
    return task.name;
  }))].join('\n');
}

export function automaticTraining(date: string, tasks: TrainingTask[] | undefined, settings: CycleSettings, periods: string[], effort: TrainingRecord['effort'] = 'normal'): TrainingRecord {
  const record: TrainingRecord = { plan: tasks ? personalTraining(date, tasks, settings, periods, effort) : suggestedTraining(date, settings, periods, effort),
    effort, completed: false, mode: 'auto' };
  if (tasks) record.projects = recordedTrainingProjects(record, tasks);
  return record;
}

// Replan future automatic entries whenever cycle/source data changes. Manual, legacy and
// completed entries remain snapshots; opening or syncing the calendar never rewrites them.
export function plannedTraining(date: string, today: string, tasks: TrainingTask[] | undefined, settings: CycleSettings, periods: string[], saved?: TrainingRecord): TrainingRecord {
  if (saved && (saved.completed || saved.mode !== 'auto' || date < today)) return saved;
  if (date < today) return { plan: '', effort: 'normal', completed: false, mode: 'auto' };
  return automaticTraining(date, tasks, settings, periods, saved?.effort);
}

export function monthlyTrainingPlan(year: number, month: number, today: string, tasksByDate: Map<string, TrainingTask[]> | undefined, settings: CycleSettings, periods: string[], entries: LifeEntries) {
  return new Map(calendarCells(year, month).filter((date): date is string => Boolean(date)).map((date) => [date,
    plannedTraining(date, today, tasksByDate ? tasksByDate.get(date) ?? [] : undefined, settings, periods, entries[`training:${date}`]?.training)]));
}

const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// Use the backend's ordering everywhere: a Chinese browser's default collation
// otherwise picks different pending workouts from the same completion history.
const compareTrainingOrder = (left: string, right: string) => left.localeCompare(right, 'en');

// Personal scheduling preference: at least two recovery days in every rolling
// seven days, and at most three consecutive main-training days. Swimming is
// independent and never consumes or resets this main-training allowance.
const RECOVERY_DAYS = 2;
const MAX_CONSECUTIVE_TRAINING_DAYS = 3;
export type TrainingRecoveryReason = 'consecutive' | 'weekly';
function requiredTrainingRecovery(date: string, activeDays: ReadonlySet<string>): TrainingRecoveryReason | null {
  if (Array.from({ length: MAX_CONSECUTIVE_TRAINING_DAYS }, (_, index) => shiftDay(date, -index - 1))
    .every(day => activeDays.has(day))) return 'consecutive';
  const recent = Array.from({ length: 6 }, (_, index) => shiftDay(date, -index - 1)).filter(day => activeDays.has(day)).length;
  return recent >= 7 - RECOVERY_DAYS ? 'weekly' : null;
}

// Swimming is independent of the main rotation. Snap each pending occurrence
// to a non-menstrual hair-wash day; several deferred occurrences merge there.
export function swimmingTrainingDates(task: TrainingTask, today: string, through: string, settings: CycleSettings, periods: string[],
  hairWash?: HairWashSchedule | null) {
  const dates = new Set<string>();
  const allowed = swimmingHairWashDates(hairWash, today, through, settings, periods);
  if (!allowed.length) return dates;
  const add = (date: string) => {
    const target = allowed.find(day => day >= date && day >= today);
    if (target) dates.add(target);
  };
  if (task.scheduledDate) {
    add(task.scheduledDate);
    if (task.repeatFlag) {
      const rule = ICAL.Recur.fromString(task.repeatFlag.replace(/^RRULE:/i, ''));
      const iterator = rule.iterator(ICAL.Time.fromDateString(task.scheduledDate));
      for (let i = 0; i < 150_000; i++) {
        const next = iterator.next();
        if (!next) break;
        const date = next.toString().slice(0, 10);
        if (date > through) break;
        if (date >= today) add(date);
      }
    }
  } else if (task.dates.length) task.dates.forEach(add);
  else if (!task.schedule) add(today); // An enabled undated local project has one next session, no invented repeat rule.
  return dates;
}

export function rollingTrainingPlan(year: number, month: number, today: string, source: TrainingSource,
  settings: CycleSettings, periods: string[], localEntries: LifeEntries, allowed: (task: TrainingTask, date: string) => boolean = () => true) {
  // Category-only TickTick tasks remain readable as history, but cannot become
  // a selectable project or count as a completed climb/swim session.
  const categoryHistory: TrainingTask[] = [
    ...source.tasks.filter((task) => isTrainingCategory(task.name)),
    ...(source.settings?.projects ?? []).filter((project) => isTrainingCategory(project.name)).map((project) => ({
      ...project, id: `history:${project.key}`, title: project.name, schedule: '', dates: [], links: [],
    })),
    ...(source.completions ?? []).filter((completion) => isTrainingCategory(completion.project)).map((completion) => ({
      id: `history:${completion.project}`, key: completion.project, name: completion.project, title: completion.project,
      notes: '', schedule: '', dates: [], links: [],
    })),
  ];
  const tasks = [...new Map([...categoryHistory.map((task) => ({ ...task, rotation: false })),
    ...trainingLibrary([...source.tasks].sort((a, b) => compareTrainingOrder(a.id, b.id)), source.settings)]
    .map((task) => [trainingIdentity(task), task])).values()];
  const byKey = new Map(tasks.map((task) => [trainingIdentity(task), task]));
  const byName = new Map(tasks.map(task => [trainingProjectKey(task.name), trainingIdentity(task)]));
  const resolveKey = (key: string) => byKey.has(key) ? key : byName.get(trainingProjectKey(key));
  const entries = { ...source.entries, ...localEntries };
  const actual = new Map<string, Set<string>>();
  const add = (date: string, projects: string[]) => {
    if (!isCalendarDate(date) || date > today) return;
    const done = actual.get(date) ?? new Set<string>();
    projects.forEach(key => { const resolved = resolveKey(key); if (resolved) done.add(resolved); });
    actual.set(date, done);
  };
  for (const completion of source.completions ?? []) add(completion.date, [completion.project]);
  for (const [key, entry] of Object.entries(entries)) {
    if (key.startsWith('training:') && entry.training?.completed) add(key.slice(9), recordedTrainingProjects(entry.training, tasks));
  }
  const last = new Map<string, string>();
  for (const [date, projects] of actual) for (const key of projects) if (date > (last.get(key) ?? '')) last.set(key, date);
  const coverage = tasks.filter((task) => task.rotation !== false).map((task) => ({ task, lastCompleted: last.get(trainingIdentity(task)),
    completed: (last.get(trainingIdentity(task)) ?? '') >= shiftDay(today, -6) }));
  const plans = new Map<string, TrainingRecord>();
  const byDate = new Map<string, TrainingTask[]>();
  const recoveryByDate = new Map<string, TrainingRecoveryReason>();
  // Missed automatic entries are not activity. Only actual completions seed
  // recovery; future projected sessions are added below without saving history.
  const isMainProject = (key: string) => { const resolved = resolveKey(key); return resolved ? !isSwimmingTraining(byKey.get(resolved)!) : !key.includes('游泳'); };
  const activeDays = new Set([...actual].filter(([, projects]) => [...projects].some(isMainProject)).map(([date]) => date));
  for (const completion of source.completions ?? []) {
    if (completion.project && isMainProject(completion.project) && isCalendarDate(completion.date) && completion.date <= today) activeDays.add(completion.date);
  }
  const days = calendarCells(year, month).filter((date): date is string => Boolean(date));
  const swims = new Map(tasks.filter(task => task.rotation !== false && isSwimmingTraining(task))
    .map(task => [trainingIdentity(task), swimmingTrainingDates(task, today, days.at(-1)!, settings, periods, source.hairWash)]));
  for (const date of days) {
    const done = [...(actual.get(date) ?? [])].map((key) => byKey.get(key)!);
    byDate.set(date, done);
    const saved = entries[`training:${date}`]?.training;
    plans.set(date, saved ?? (done.length ? { plan: done.map((task) => task.name).join('\n'), effort: 'normal',
      completed: true, mode: 'auto', projects: done.map(trainingIdentity) }
      : { plan: '', effort: 'normal', completed: false, mode: 'auto' }));
  }
  // Future days are a forecast. Each new visit starts from actual completions,
  // so an uncompleted past plan cannot silently move the rotation forward.
  for (let date = today; date <= days[days.length - 1]; date = shiftDay(date, 1)) {
    const saved = entries[`training:${date}`]?.training;
    const done = [...(actual.get(date) ?? [])].map((key) => byKey.get(key)!);
    // A swimming-only entry records the independent session, not a replacement
    // for the whole day's main workout. Keep the saved entry itself untouched.
    const savedProjects = saved ? recordedTrainingProjects(saved, tasks) : [];
    const independentSwimming = saved && (saved.completed || saved.mode !== 'auto')
      && (!saved.completed || date === today) && savedProjects.length && savedProjects.every(key => !isMainProject(key)) ? saved : undefined;
    const phase = cycleDay(date, settings, periods);
    const mainDone = done.some(task => !isSwimmingTraining(task));
    const main = tasks.filter((task) => {
      if (!allowed(task, date) || task.rotation === false || isSwimmingTraining(task) || mainDone) return false;
      if (phase?.phase === 'menstrual' && /HIIT|间歇/i.test(task.name)) return false;
      return true;
    }).sort((a, b) => compareTrainingOrder(last.get(trainingIdentity(a)) ?? '', last.get(trainingIdentity(b)) ?? '')
      || compareTrainingOrder(trainingIdentity(a), trainingIdentity(b))).slice(0, 1);
    let suggested = [...main, ...tasks.filter(task => allowed(task, date) && swims.get(trainingIdentity(task))?.has(date)
      && !actual.get(date)?.has(trainingIdentity(task)))];
    if (independentSwimming) suggested = suggested.filter(task => !savedProjects.includes(trainingIdentity(task)));
    let record: TrainingRecord;
    if (saved && !independentSwimming && (saved.completed || saved.mode !== 'auto')) {
      record = saved;
    } else {
      const effort = independentSwimming ? 'normal' : saved?.effort ?? 'normal';
      record = automaticTraining(date, suggested, settings, periods, effort);
      if (!mainDone && recordedTrainingProjects(record, tasks).some(isMainProject)) {
        const recovery = requiredTrainingRecovery(date, activeDays);
        if (recovery) {
          recoveryByDate.set(date, recovery);
          suggested = suggested.filter(isSwimmingTraining);
          record = automaticTraining(date, suggested, settings, periods, effort);
        }
      }
      const pendingSwimming = independentSwimming ? savedProjects.filter(key => !actual.get(date)?.has(key)) : [];
      if (independentSwimming && pendingSwimming.length) {
        const pending = recordedTrainingProjects(record, tasks);
        record = { ...record, plan: [...(pending.length ? [record.plan] : []), independentSwimming.plan].join('\n'),
          projects: [...pending, ...pendingSwimming] };
        suggested = [...suggested, ...pendingSwimming.map(key => byKey.get(key)!)];
      }
      if (done.length) {
        const pending = recordedTrainingProjects(record, tasks);
        const completedPlans = done.filter(task => !independentSwimming || pendingSwimming.length || !savedProjects.includes(trainingIdentity(task)))
          .map(task => `${task.name}${pending.length ? ' · 已完成' : ''}`);
        if (independentSwimming && !pendingSwimming.length) completedPlans.push(`${independentSwimming.plan}${pending.length ? ' · 已完成' : ''}`);
        record = { ...record, completed: pending.length === 0,
          plan: [...(pending.length ? [record.plan] : []), ...completedPlans].join('\n'),
          projects: [...new Set([...pending, ...done.map(trainingIdentity)])] };
      }
      if (recoveryByDate.has(date)) {
        const hasSwimming = recordedTrainingProjects(record, tasks).some(key => !isMainProject(key));
        record = { ...record, effort: hasSwimming ? effort : 'rest',
          plan: hasSwimming ? `主训练休息\n${record.plan}` : '休息' };
      }
    }
    // Only simulate future planned sessions; they never enter the actual history.
    const projects = recordedTrainingProjects(record, tasks);
    for (const key of projects) last.set(key, date);
    if (projects.some(isMainProject)) activeDays.add(date);
    if (plans.has(date)) { plans.set(date, record); byDate.set(date, record.completed ? done : suggested); }
  }
  return { plans, byDate, coverage, completedByDate: actual, recoveryByDate };
}
