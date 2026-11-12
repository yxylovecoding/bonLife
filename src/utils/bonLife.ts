import { parseSkinRecord, SKIN_FIELDS, SKIN_STATES, type SkinField, type SkinRecord, type SkinSettings } from './lifeSkin.js';
export { SKIN_FIELDS } from './lifeSkin.js';
export type { SkinRecord } from './lifeSkin.js';
import { isCalendarDate, nextCalendarDate } from './outlookCalendar.js';
import { SYMPTOM_STATES, parseSymptomRecord, symptomSummary, type DiscomfortRecord, type EyeRecord } from './lifeSymptoms.js';
import { makeupSummary, parseMakeupRecord, type MakeupRecord } from './lifeMakeup.js';

export const LIFE_KINDS = ['skin', 'eyes', 'discomfort', 'mood', 'body', 'training'] as const;
export type LifeKind = typeof LIFE_KINDS[number];
export type LifeView = LifeKind | 'done';
export const LIFE_LABELS: Record<LifeView, string> = { skin: '皮肤', eyes: '眼睛', discomfort: '身体', mood: '情绪', body: '身体数据', training: 'BonFit', done: 'DoneList' };
export const LIFE_TEXT_LIMIT = 2000;
export const BODY_FIELDS = {
  weight: { label: '体重', unit: 'kg', max: 500 },
  height: { label: '身高', unit: 'cm', max: 300 },
  bmi: { label: 'BMI', unit: '', max: 150 },
  bodyFat: { label: '体脂率', unit: '%', max: 100 },
  bodyWater: { label: '身体水分', unit: 'kg', max: 500 },
  protein: { label: '蛋白质', unit: 'kg', max: 100 },
  minerals: { label: '无机盐', unit: 'kg', max: 100 },
  boneMineral: { label: '骨内含量', unit: 'kg', max: 100 },
  bodyFatMass: { label: '体脂肪量', unit: 'kg', max: 500 },
  muscleMass: { label: '肌肉量', unit: 'kg', max: 500 },
  skeletalMuscleMass: { label: '骨骼肌量', unit: 'kg', max: 500 },
  fatFreeMass: { label: '去脂体重', unit: 'kg', max: 500 },
  visceralFatLevel: { label: '内脏脂肪等级', unit: '级', max: 100 },
  waistHipRatio: { label: '腰臀比', unit: '', max: 5 },
  inBodyScore: { label: '健康评分', unit: '分', max: 200 },
  basalMetabolicRate: { label: '基础代谢量', unit: 'kcal', max: 10000 },
  targetWeightChange: { label: '体重控制', unit: 'kg', min: -500, max: 500 },
  targetFatChange: { label: '脂肪控制', unit: 'kg', min: -500, max: 500 },
  targetMuscleChange: { label: '肌肉控制', unit: 'kg', min: -500, max: 500 },
  chest: { label: '胸围', unit: 'cm', max: 300 },
  waist: { label: '腰围', unit: 'cm', max: 300 },
  hips: { label: '臀围', unit: 'cm', max: 300 },
  neck: { label: '颈围', unit: 'cm', max: 300 },
  upperArm: { label: '上臂围', unit: 'cm', max: 300 },
  leftUpperArm: { label: '左上臂围', unit: 'cm', max: 300 },
  rightUpperArm: { label: '右上臂围', unit: 'cm', max: 300 },
  thigh: { label: '大腿围', unit: 'cm', max: 300 },
  leftThigh: { label: '左大腿围', unit: 'cm', max: 300 },
  rightThigh: { label: '右大腿围', unit: 'cm', max: 300 },
  calf: { label: '小腿围', unit: 'cm', max: 300 },
  leftArmMuscle: { label: '左上肢肌肉量', unit: 'kg', max: 100 },
  leftArmMusclePercent: { label: '左上肢肌肉率', unit: '%', max: 300 },
  rightArmMuscle: { label: '右上肢肌肉量', unit: 'kg', max: 100 },
  rightArmMusclePercent: { label: '右上肢肌肉率', unit: '%', max: 300 },
  trunkMuscle: { label: '躯干肌肉量', unit: 'kg', max: 300 },
  trunkMusclePercent: { label: '躯干肌肉率', unit: '%', max: 300 },
  leftLegMuscle: { label: '左下肢肌肉量', unit: 'kg', max: 200 },
  leftLegMusclePercent: { label: '左下肢肌肉率', unit: '%', max: 300 },
  rightLegMuscle: { label: '右下肢肌肉量', unit: 'kg', max: 200 },
  rightLegMusclePercent: { label: '右下肢肌肉率', unit: '%', max: 300 },
  leftArmFat: { label: '左上肢脂肪量', unit: 'kg', max: 100 },
  leftArmFatPercent: { label: '左上肢脂肪率', unit: '%', max: 500 },
  rightArmFat: { label: '右上肢脂肪量', unit: 'kg', max: 100 },
  rightArmFatPercent: { label: '右上肢脂肪率', unit: '%', max: 500 },
  trunkFat: { label: '躯干脂肪量', unit: 'kg', max: 300 },
  trunkFatPercent: { label: '躯干脂肪率', unit: '%', max: 500 },
  leftLegFat: { label: '左下肢脂肪量', unit: 'kg', max: 200 },
  leftLegFatPercent: { label: '左下肢脂肪率', unit: '%', max: 500 },
  rightLegFat: { label: '右下肢脂肪量', unit: 'kg', max: 200 },
  rightLegFatPercent: { label: '右下肢脂肪率', unit: '%', max: 500 },
  impedance5Ra: { label: '阻抗 5kHz RA', unit: 'Ω', max: 5000 },
  impedance5La: { label: '阻抗 5kHz LA', unit: 'Ω', max: 5000 },
  impedance5Tr: { label: '阻抗 5kHz TR', unit: 'Ω', max: 5000 },
  impedance5Rl: { label: '阻抗 5kHz RL', unit: 'Ω', max: 5000 },
  impedance5Ll: { label: '阻抗 5kHz LL', unit: 'Ω', max: 5000 },
  impedance50Ra: { label: '阻抗 50kHz RA', unit: 'Ω', max: 5000 },
  impedance50La: { label: '阻抗 50kHz LA', unit: 'Ω', max: 5000 },
  impedance50Tr: { label: '阻抗 50kHz TR', unit: 'Ω', max: 5000 },
  impedance50Rl: { label: '阻抗 50kHz RL', unit: 'Ω', max: 5000 },
  impedance50Ll: { label: '阻抗 50kHz LL', unit: 'Ω', max: 5000 },
  impedance250Ra: { label: '阻抗 250kHz RA', unit: 'Ω', max: 5000 },
  impedance250La: { label: '阻抗 250kHz LA', unit: 'Ω', max: 5000 },
  impedance250Tr: { label: '阻抗 250kHz TR', unit: 'Ω', max: 5000 },
  impedance250Rl: { label: '阻抗 250kHz RL', unit: 'Ω', max: 5000 },
  impedance250Ll: { label: '阻抗 250kHz LL', unit: 'Ω', max: 5000 },
} as const;
export type BodyMetric = keyof typeof BODY_FIELDS;
export const CIRCUMFERENCE_FIELDS = ['chest', 'waist', 'hips', 'upperArm', 'thigh', 'calf'] as const;
export type BodyRecord = Partial<Record<keyof typeof BODY_FIELDS, number>>;
export interface TrainingRecord { plan: string; effort: 'normal' | 'easy' | 'rest'; completed: boolean; mode?: 'auto' | 'manual'; projects?: string[] }
export interface LifeEntry { text: string; revision: string; skin?: SkinRecord; eyes?: EyeRecord; discomfort?: DiscomfortRecord; body?: BodyRecord; training?: TrainingRecord; makeup?: MakeupRecord }
export type LifeEntries = Record<string, LifeEntry>;
export interface LifeYear {
  year: number;
  entries: LifeEntries;
  periodDays: string[];
  syncedAt: string | null;
  connected: boolean;
  cycle?: CycleSettings;
  skinSettings?: SkinSettings;
  skinHistory?: LifeEntries;
  symptomHistory?: LifeEntries;
}
export interface CycleSettings {
  lastPeriodStart: string;
  cycleLength: number;
  periodLength: number;
  trainingDays: number[];
  revision: string;
  periodStarts?: string[];
  automatic?: boolean;
}
export const DEFAULT_CYCLE: CycleSettings = { lastPeriodStart: '', cycleLength: 28, periodLength: 5, trainingDays: [1, 3, 5], revision: '', automatic: true };
export interface DoneItem {
  id: string; taskId: string; projectId: string; title: string; completedAt: string; date: string;
  tags?: string[]; category?: '课' | '活' | '玩' | '未分类'; projectName?: string;
  source?: 'ticktick' | 'outlook'; durationMinutes?: number; durationBasis?: 'task' | 'default' | 'outlook';
  startedAt?: string; linkedTaskId?: string; linkedProjectId?: string;
}
export interface DoneMonth {
  month: string; items: DoneItem[]; connected: boolean; syncedAt: string | null; needsTagSync?: boolean;
  needsDurationSync?: boolean; outlookConnected?: boolean; outlookSyncedAt?: string | null; outlookError?: string;
}
export interface PeriodEvent { uid: string; startDate: string; endDate: string }

export function lifeYear(value: unknown): number {
  if (!/^[0-9]{4}$/.test(String(value))) throw new Error('年份无效');
  const year = Number(value);
  if (year < 1900 || year > 2200) throw new Error('年份无效');
  return year;
}

export function parseLifeEdit(value: unknown) {
  const edit = value as Record<string, unknown> | null;
  if (!edit || !LIFE_KINDS.includes(edit.kind as LifeKind) || typeof edit.date !== 'string'
    || !isCalendarDate(edit.date) || typeof edit.text !== 'string' || edit.text.length > LIFE_TEXT_LIMIT
    || typeof edit.revision !== 'string' || edit.revision.length > 80
    || typeof edit.mutationId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(edit.mutationId)) {
    throw new Error('记录内容无效');
  }
  const details: Pick<LifeEntry, 'skin' | 'eyes' | 'discomfort' | 'body' | 'training' | 'makeup'> = {};
  if (edit.makeup !== undefined) {
    if (edit.kind !== 'skin' && edit.kind !== 'eyes') throw new Error('记录类型不匹配');
    details.makeup = parseMakeupRecord(edit.makeup);
  }
  for (const field of ['skin', 'eyes', 'discomfort', 'body', 'training']) {
    if (edit[field] !== undefined && edit.kind !== field) throw new Error('记录类型不匹配');
  }
  if (edit.skin !== undefined) details.skin = parseSkinRecord(edit.skin);
  if (edit.eyes !== undefined) details.eyes = parseSymptomRecord(edit.eyes, 'eyes');
  if (edit.discomfort !== undefined) details.discomfort = parseSymptomRecord(edit.discomfort, 'discomfort');
  if (edit.body !== undefined) {
    if (!edit.body || typeof edit.body !== 'object' || Array.isArray(edit.body)) throw new Error('身体数据无效');
    details.body = {};
    for (const [key, value] of Object.entries(edit.body)) {
      if (!Object.prototype.hasOwnProperty.call(BODY_FIELDS, key) || !isBodyValue(key as BodyMetric, value)) throw new Error('身体数据无效');
      details.body[key as keyof BodyRecord] = value;
    }
  }
  if (edit.training !== undefined) {
    const training = edit.training as TrainingRecord | null;
    if (!training || typeof training.plan !== 'string' || training.plan.length > 1000
      || !['normal', 'easy', 'rest'].includes(training.effort) || typeof training.completed !== 'boolean'
      || (training.mode !== undefined && !['auto', 'manual'].includes(training.mode))
      || (training.projects !== undefined && (!Array.isArray(training.projects) || training.projects.length > 30
        || training.projects.some((key) => typeof key !== 'string' || !key || key.length > 120)))) throw new Error('运动记录无效');
    details.training = { plan: training.plan, effort: training.effort, completed: training.completed,
      ...(training.mode ? { mode: training.mode } : {}), ...(training.projects ? { projects: [...new Set(training.projects)] } : {}) };
  }
  const year = lifeYear(edit.date.slice(0, 4));
  return { year, kind: edit.kind as LifeKind, date: edit.date, text: edit.text,
    revision: edit.revision, mutationId: edit.mutationId, ...details };
}

export function parseCycleSettings(value: unknown): CycleSettings {
  const input = value as CycleSettings | null;
  if (!input || typeof input.lastPeriodStart !== 'string'
    || (input.lastPeriodStart !== '' && !isCalendarDate(input.lastPeriodStart))
    || !Number.isInteger(input.cycleLength) || input.cycleLength < 21 || input.cycleLength > 45
    || !Number.isInteger(input.periodLength) || input.periodLength < 1 || input.periodLength > 10
    || (input.automatic !== undefined && typeof input.automatic !== 'boolean')
    || !Array.isArray(input.trainingDays) || input.trainingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    || typeof input.revision !== 'string' || input.revision.length > 80) throw new Error('经期设置无效');
  if (input.lastPeriodStart) lifeYear(input.lastPeriodStart.slice(0, 4));
  return { lastPeriodStart: input.lastPeriodStart, cycleLength: input.cycleLength, periodLength: input.periodLength,
    trainingDays: [...new Set(input.trainingDays)].sort(), revision: input.revision, automatic: input.automatic !== false };
}

export function entrySummary(kind: LifeKind, entry?: LifeEntry): string {
  if (!entry) return '';
  const details = kind === 'skin' ? Object.entries(SKIN_FIELDS).flatMap(([key, label]) => {
    const value = entry.skin?.[key as SkinField]; return value ? [`${label} · ${value}`] : [];
  }) : kind === 'eyes' || kind === 'discomfort' ? symptomSummary(kind, entry[kind])
    : kind === 'body' ? Object.entries(BODY_FIELDS).flatMap(([key, { label, unit }]) => {
    const value = entry.body?.[key as BodyMetric]; return isBodyValue(key as BodyMetric, value) ? [`${label} ${value}${unit ? ` ${unit}` : ''}`] : [];
  }) : kind === 'training' && entry.training ? [`${entry.training.completed ? '✓ ' : ''}${entry.training.plan}`] : [];
  const skinState = kind === 'skin' && entry.skin?.status ? `${SKIN_STATES[entry.skin.status]}${entry.skin.planDay ? ` · 第 ${entry.skin.planDay} 天` : ''}` : '';
  const skinLabel = kind === 'skin' ? [skinState, entry.skin?.status === 'acne' && entry.skin.acneProgress ? SYMPTOM_STATES[entry.skin.acneProgress] : '',
    entry.skin?.acneMarks ? '痘印' : ''].filter(Boolean).join(' · ') : '';
  return [skinLabel, ...(kind === 'skin' || kind === 'eyes' ? makeupSummary(entry.makeup) : []), ...details, entry.text].filter(Boolean).join('\n');
}

export function isBodyValue(metric: BodyMetric, value: unknown): value is number {
  const field = BODY_FIELDS[metric] as { max: number; min?: number };
  return typeof value === 'number' && Number.isFinite(value) && value >= (field.min ?? 0.01) && value <= field.max;
}

export function calendarCells(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const size = Math.ceil((offset + count) / 7) * 7;
  return Array.from({ length: size }, (_, index) => index < offset || index >= offset + count ? null
    : `${year}-${String(month).padStart(2, '0')}-${String(index - offset + 1).padStart(2, '0')}`);
}

export function periodDays(events: PeriodEvent[], year: number): string[] {
  const days = new Set<string>();
  const from = `${year}-01-01`;
  const until = `${year + 1}-01-01`;
  for (const event of events) {
    if (!isCalendarDate(event.startDate) || !isCalendarDate(event.endDate)) continue;
    const start = event.startDate < from ? from : event.startDate;
    const end = event.endDate > until ? until : event.endDate;
    for (let day = start; day < end; day = nextCalendarDate(day)) days.add(day);
  }
  return [...days].sort();
}

// A published feed can stop including older events. Preserve that history, but
// replace any series still present (including cancellations, moves and renames).
export function reconcilePeriodEvents(previous: PeriodEvent[], next: PeriodEvent[], seenUids: string[], today: string): PeriodEvent[] {
  const seen = new Set(seenUids);
  const retained = previous.filter((event) => !seen.has(event.uid) && event.startDate < today)
    .map((event) => ({ ...event, endDate: event.endDate < today ? event.endDate : today }));
  return [...retained, ...next];
}
