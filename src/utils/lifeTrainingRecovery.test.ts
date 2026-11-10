import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CYCLE, type LifeEntries, type TrainingRecord } from './bonLife';
import { rollingTrainingPlan, type TrainingSource, type TrainingTask } from './lifeTraining';

const task = (name: string): TrainingTask => ({ id: name, name, title: name, schedule: '', dates: [], notes: '', links: [] });
const source = (today = '2026-10-05'): TrainingSource => ({ year: Number(today.slice(0, 4)), connected: true, syncedAt: null,
  tasks: ['上半身', '全身力训', '臀腿', 'HIIT'].map(task).concat({ ...task('游泳'), scheduledDate: today, repeatFlag: 'FREQ=DAILY;INTERVAL=2' }),
  hairWash: { scheduledDate: today, repeatFlag: 'FREQ=DAILY;INTERVAL=2', repeatFrom: '1' } });
const run = (input = source(), today = '2026-10-05', entries: LifeEntries = {}, year = 2026, month = 10) =>
  rollingTrainingPlan(year, month, today, input, DEFAULT_CYCLE, [], entries);
const active = (record: TrainingRecord) => Boolean(record.projects?.some(project => project !== '游泳'));
const entry = (training: TrainingRecord) => ({ text: '', revision: '', training });

describe('滚动训练恢复日', () => {
  it('燃脂操和 HIIT 补齐五个主训练项目；爬坡按需，泳日和两天恢复保持独立', () => {
    const input = source(); input.tasks.push(task('燃脂操')); input.tasks.at(4)!.scheduledDate = '2026-10-07';
    input.settings = { revision: '', projects: [
      { key: '臀腿', name: '下半身', notes: '', rotation: true, tags: ['力量'] },
      { key: 'custom-cardio', name: '燃脂操', notes: '', rotation: true, tags: ['有氧'] },
    ] };
    const result = rollingTrainingPlan(2026, 10, '2026-10-05', input,
      { ...DEFAULT_CYCLE, lastPeriodStart: '2026-09-15', periodLength: 7, automatic: false }, [], {});
    const week = [...result.plans].filter(([date]) => date >= '2026-10-05' && date <= '2026-10-11');
    expect(week.flatMap(([, record]) => record.projects?.filter(key => key !== '游泳') ?? []).sort())
      .toEqual(['hiit', '上半身', '全身力训', 'custom-cardio', '臀腿'].sort());
    expect(week.filter(([, record]) => !active(record)).map(([date]) => date)).toEqual(['2026-10-08', '2026-10-11']);
    expect(week.filter(([, record]) => record.plan.includes('燃脂操'))).toHaveLength(1);
    expect(week.find(([, record]) => record.projects?.includes('hiit'))?.[1].plan).toContain('HIIT · 轻量');
    expect(result.plans.get('2026-10-10')?.plan).toBe('下半身 · 轻量');
    expect(week.filter(([, record]) => record.projects?.includes('游泳')).map(([date]) => date)).toEqual(['2026-10-07', '2026-10-09', '2026-10-11']);
    expect(result.coverage.map(item => item.task.name)).not.toContain('爬坡');
  });
  it('截图这一周留出两天主训练休息，独立游泳仍可在主训练恢复日进行', () => {
    const input = source(); input.tasks.at(-1)!.scheduledDate = '2026-10-07';
    const result = rollingTrainingPlan(2026, 10, '2026-10-05', input,
      { ...DEFAULT_CYCLE, lastPeriodStart: '2026-09-15', periodLength: 7, automatic: false }, [], {});
    const week = [...result.plans].filter(([date]) => date >= '2026-10-05' && date <= '2026-10-11');
    expect(week.filter(([, record]) => !active(record)).map(([date]) => date)).toEqual(['2026-10-08', '2026-10-11']);
    expect(week.filter(([, record]) => !active(record)).every(([, record]) => /休息/.test(record.plan))).toBe(true);
    expect(week.filter(([, record]) => record.projects?.includes('游泳')).map(([date]) => date)).toEqual(['2026-10-07', '2026-10-09', '2026-10-11']);
    for (const project of ['上半身', '全身力训', '臀腿']) expect(week.some(([, record]) => record.projects?.includes(project))).toBe(true);
    expect(result.byDate.get('2026-10-08')).toEqual([]);
    expect(result.completedByDate.size).toBe(0);
  });
  it('跨周跨年任意七天最多训练五天，任意四天主训练不会全练，游泳不计入', () => {
    const today = '2026-12-29';
    const input = source(today);
    const forecast = [...run(input, today, {}, 2026, 12).plans, ...run(input, today, {}, 2027, 1).plans]
      .filter(([date]) => date >= today).map(([, record]) => record);
    for (let index = 0; index <= forecast.length - 7; index++) expect(forecast.slice(index, index + 7).filter(active)).toHaveLength(5);
    for (let index = 0; index <= forecast.length - 4; index++) expect(forecast.slice(index, index + 4).filter(active).length).toBeLessThanOrEqual(3);
    expect(forecast.slice(0, 7).filter(active)).toHaveLength(5);
  });
  it('只按真实完成计算连练，已退出项目的完成也算活动；休息后继续漏练顺序', () => {
    const input = source();
    input.completions = [{ project: '上半身', date: '2026-10-02' }, { project: '已退出的跑步项目', date: '2026-10-03' }, { project: '臀腿', date: '2026-10-04' }, { project: '游泳', date: '2026-10-04' }];
    const result = run(input);
    expect(result.plans.get('2026-10-05')).toMatchObject({ plan: '主训练休息\n游泳', projects: ['游泳'], completed: false });
    expect(result.recoveryByDate.get('2026-10-05')).toBe('consecutive');
    expect(result.plans.get('2026-10-06')?.projects).not.toContain('上半身');
    expect(result.coverage.find(item => item.task.name === '游泳')?.lastCompleted).toBe('2026-10-04');
    expect(result.plans.get('2026-10-07')?.projects).toContain('游泳');
  });
  it('上周漏练的自动计划不算连练，也不消耗轮换项目', () => {
    const entries = Object.fromEntries(['02', '03', '04'].map(day => [`training:2026-10-${day}`, entry({
      plan: '全身力训', projects: ['全身力训'], effort: 'normal', completed: false, mode: 'auto',
    })]));
    const result = run(source(), '2026-10-05', entries);
    expect(result.plans.get('2026-10-05')).toEqual(run().plans.get('2026-10-05'));
    expect(result.recoveryByDate.has('2026-10-05')).toBe(false);
  });
  it('前六天已练五天，即使尚未连练三天也安排主训练恢复，仍可游泳', () => {
    const input = source();
    input.completions = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-03', '2026-10-04']
      .map(date => ({ project: '上半身', date }));
    const result = run(input);
    expect(result.recoveryByDate.get('2026-10-05')).toBe('weekly');
    expect(result.plans.get('2026-10-05')).toMatchObject({ plan: '主训练休息\n游泳', projects: ['游泳'] });
  });
  it('增加或完成独立游泳不会改变整月主训练和恢复安排', () => {
    const input = source();
    input.completions = ['02', '03', '04'].map(day => ({ project: '上半身', date: `2026-10-${day}` }));
    const withoutSwimming = run({ ...input, tasks: input.tasks.filter(task => task.name !== '游泳'), hairWash: null });
    const withSwimming = run({ ...input, completions: [...input.completions,
      ...['02', '03', '04', '05'].map(day => ({ project: '游泳', date: `2026-10-${day}` }))] });
    const mainPlan = (result: ReturnType<typeof run>) => [...result.plans].filter(([date]) => date >= '2026-10-05')
      .map(([date, record]) => [date, record.projects?.filter(project => project !== '游泳') ?? []]);
    expect(mainPlan(withSwimming)).toEqual(mainPlan(withoutSwimming));
    expect(withSwimming.recoveryByDate).toEqual(withoutSwimming.recoveryByDate);
    expect(withSwimming.plans.get('2026-10-05')).toMatchObject({ plan: '主训练休息\n游泳', projects: ['游泳'], completed: true });
  });
  it.each([false, true])('手动游泳记录与当天 HIIT 并存，游泳完成=%s 不推进主训练', (completed) => {
    const swim: TrainingRecord = { plan: '游泳 · 50 分钟', projects: ['游泳'], effort: 'normal', completed, mode: 'manual' };
    const entries = { 'training:2026-10-05': entry(swim) };
    const baseline = run();
    const result = run(source(), '2026-10-05', entries);
    expect(result.plans.get('2026-10-05')).toMatchObject({ projects: ['hiit', '游泳'], completed: false });
    expect(result.plans.get('2026-10-05')?.plan).toBe(`HIIT\n游泳 · 50 分钟${completed ? ' · 已完成' : ''}`);
    expect(result.byDate.get('2026-10-05')?.map(task => task.name)).toEqual(completed ? ['HIIT'] : ['HIIT', '游泳']);
    expect([...(result.completedByDate.get('2026-10-05') ?? [])]).toEqual(completed ? ['游泳'] : []);
    expect(result.coverage.find(item => item.task.name === 'HIIT')?.lastCompleted).toBeUndefined();
    const mainPlans = (value: ReturnType<typeof run>) => [...value.plans].map(([date, record]) => [date, record.projects?.filter(key => key !== '游泳') ?? []]);
    expect(mainPlans(result)).toEqual(mainPlans(baseline));
    expect(result.recoveryByDate).toEqual(baseline.recoveryByDate);
    expect(entries['training:2026-10-05'].training).toBe(swim);
    expect(swim.projects).toEqual(['游泳']);
  });
  it('旧版无项目标识及自动已完成游泳也保留主训练，历史游泳不改写', () => {
    for (const mode of ['manual', 'auto', undefined] as const) {
      const swim: TrainingRecord = { plan: '游泳 · 50 分钟', effort: 'normal', completed: true, mode };
      const result = run(source(), '2026-10-05', { 'training:2026-10-05': entry(swim), 'training:2026-10-04': entry(swim) });
      expect(result.plans.get('2026-10-05')).toMatchObject({ projects: ['hiit', '游泳'], completed: false });
      expect(result.plans.get('2026-10-04')).toBe(swim);
    }
  });
  it('手动游泳完成仍遵守主训练恢复和场景；主训练完成后不重复安排', () => {
    const swim: TrainingRecord = { plan: '游泳', projects: ['游泳'], effort: 'normal', completed: true, mode: 'manual' };
    const input = source(); input.entries = { 'training:2026-10-05': entry(swim) };
    input.completions = ['02', '03', '04'].map(day => ({ project: '上半身', date: `2026-10-${day}` }));
    expect(run(input).plans.get('2026-10-05')).toMatchObject({ plan: '主训练休息\n游泳', projects: ['游泳'], completed: true });
    input.completions = [{ project: 'hiit', date: '2026-10-05' }];
    expect(run(input).plans.get('2026-10-05')).toMatchObject({ projects: ['hiit', '游泳'], completed: true });
    input.completions = [];
    const blocked = rollingTrainingPlan(2026, 10, '2026-10-05', input, DEFAULT_CYCLE, [], {}, (_task, date) => date !== '2026-10-05');
    expect(blocked.plans.get('2026-10-05')).toMatchObject({ projects: ['游泳'], completed: true });
  });
  it('TickTick 已完成游泳与手动未勾选记录合并去重，两项都完成后当天完成', () => {
    const swim: TrainingRecord = { plan: '游泳 · 50 分钟', projects: ['游泳'], effort: 'normal', completed: false, mode: 'manual' };
    const input = source(); input.entries = { 'training:2026-10-05': entry(swim) };
    input.completions = [{ project: '游泳', date: '2026-10-05' }];
    expect(run(input).plans.get('2026-10-05')).toMatchObject({ plan: 'HIIT\n游泳 · 50 分钟 · 已完成', projects: ['hiit', '游泳'], completed: false });
    input.completions.push({ project: 'hiit', date: '2026-10-05' });
    const result = run(input).plans.get('2026-10-05');
    expect(result?.completed).toBe(true);
    expect(result?.projects).toHaveLength(2);
    expect(result?.plan.match(/游泳/g)).toHaveLength(1);
    expect(swim.completed).toBe(false);
  });
  it('中文浏览器与英文后台按相同顺序轮换，恢复日和游泳日期也一致', () => {
    const compare = String.prototype.localeCompare;
    let locale = 'zh-CN';
    const mocked = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other, locales, options) {
      return compare.call(this, other, locales ?? locale, options);
    });
    try {
      const browserPlan = run();
      locale = 'en-US';
      const serverPlan = run();
      expect(browserPlan.plans).toEqual(serverPlan.plans);
      expect(browserPlan.byDate).toEqual(serverPlan.byDate);
      expect(browserPlan.recoveryByDate).toEqual(serverPlan.recoveryByDate);
    } finally { mocked.mockRestore(); }
  });
  it('手动休息计入两天恢复；手动训练和已完成内容不被自动计划覆盖', () => {
    const rest: TrainingRecord = { plan: '休息', effort: 'rest', projects: [], completed: false, mode: 'manual' };
    const result = run(source(), '2026-10-05', { 'training:2026-10-06': entry(rest) });
    expect(result.plans.get('2026-10-06')).toBe(rest);
    expect([...result.plans].filter(([date, record]) => date >= '2026-10-05' && date <= '2026-10-11' && !active(record)).map(([date]) => date))
      .toEqual(['2026-10-06', '2026-10-10']);
    const input = source(); input.completions = ['02', '03', '04'].map(day => ({ project: '上半身', date: `2026-10-${day}` }));
    const manual: TrainingRecord = { plan: '臀腿', effort: 'normal', projects: ['臀腿'], completed: false, mode: 'manual' };
    const overridden = run(input, '2026-10-05', { 'training:2026-10-05': entry(manual) });
    expect(overridden.plans.get('2026-10-05')).toBe(manual);
    expect(overridden.plans.get('2026-10-06')?.plan).toBe('休息');
    input.completions.push({ project: '臀腿', date: '2026-10-05' });
    expect(run(input).plans.get('2026-10-05')?.projects).toContain('臀腿');
  });
  it('一次性游泳遇到主训练恢复日仍按洗头日期进行，连着游泳不触发主训练休息', () => {
    const input = source(); input.tasks.at(-1)!.repeatFlag = undefined;
    input.completions = ['02', '03', '04'].map(day => ({ project: '上半身', date: `2026-10-${day}` }));
    const result = run(input);
    expect(result.plans.get('2026-10-05')?.plan).toBe('主训练休息\n游泳');
    expect([...result.plans].filter(([, record]) => record.projects?.includes('游泳')).map(([date]) => date)).toEqual(['2026-10-05']);
    input.completions = ['02', '03', '04'].map(day => ({ project: '游泳', date: `2026-10-${day}` }));
    expect(run(input).recoveryByDate.has('2026-10-05')).toBe(false);
    expect(active(run(input).plans.get('2026-10-05')!)).toBe(true);
  });
});
