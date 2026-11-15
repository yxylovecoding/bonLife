import { describe, expect, it } from 'vitest';
import { DEFAULT_CYCLE } from './bonLife';
import { automaticTraining, completedTrainingRecord, parseTrainingSettings, recordedTrainingProjects, reuseTrainingProjects, rollingTrainingPlan, trainingIdentity, trainingLibrary, trainingTags,
  type TrainingSettings, type TrainingTask } from './lifeTraining';

const source = (name: string): TrainingTask => ({ id: name, name, title: `${name}-运动💪🏻是生活的第一个锚点🪝`, notes: '原有跟练', links: [{ title: '跟练', url: 'https://example.com/workout' }], schedule: '每周三', dates: [] });
const settings: TrainingSettings = { revision: '', projects: [{ key: '爬坡', name: '爬坡', notes: '30 分钟', rotation: true }] };
const roll = (tasks: TrainingTask[], entries = {}) => rollingTrainingPlan(2026, 10, '2026-10-05', { year: 2026, tasks, connected: false, syncedAt: null }, DEFAULT_CYCLE, [], entries);

describe('可复用训练项目', () => {
  it('忽略项目的时长括号，合并爬坡并保留待办内容、旧标识及完成历史', () => {
    const remote = source('爬坡 (45m)');
    const library = trainingLibrary([remote, source('爬坡（1.5h）')]);
    expect(library.filter(task => task.name === '爬坡')).toHaveLength(1);
    expect(library.find(task => task.name === '爬坡')).toMatchObject({ rotation: true, notes: '原有跟练', links: remote.links });
    for (const project of ['爬坡', '爬坡（45m）', '爬坡45m', '爬坡15h']) {
      expect(recordedTrainingProjects({ plan: '', projects: [project], completed: true, effort: 'normal' }, library)).toEqual(['爬坡']);
    }
    const result = rollingTrainingPlan(2026, 10, '2026-10-05', { year: 2026, tasks: [remote], connected: false, syncedAt: null,
      completions: [{ project: '爬坡45m', date: '2026-10-04' }] }, DEFAULT_CYCLE, [], {});
    expect(result.coverage).toEqual([expect.objectContaining({ lastCompleted: '2026-10-04' })]);
    const custom = trainingLibrary([remote], { revision: '', projects: [{ key: 'legacy-climb', name: '爬坡（45m）', notes: '保留', rotation: false }] });
    expect(custom.filter(task => task.name === '爬坡')).toHaveLength(1);
    expect(recordedTrainingProjects({ plan: '爬坡 (45m)', completed: true, effort: 'normal' }, custom)).toEqual(['legacy-climb']);
    expect(() => parseTrainingSettings({ ...settings, projects: [...settings.projects,
      { ...settings.projects[0], key: 'duplicate', name: '爬坡（45m）' }] })).toThrow('不能重复');
  });
  it('完成选择只读取实际记录，计划不预选，日历来源不写入手动完成', () => {
    const library = trainingLibrary([source('HIIT'), source('游泳')]);
    const planned = automaticTraining('2026-10-05', library, DEFAULT_CYCLE, []);
    expect(completedTrainingRecord('2026-10-05', library, planned).projects).toEqual([]);
    const calendar = [{ project: '爬坡 (45m)', date: '2026-10-05' }, { project: 'HIIT', date: '2026-10-04' }];
    const manual = { plan: '游泳', projects: ['游泳'], effort: 'normal' as const, completed: true };
    expect(completedTrainingRecord('2026-10-05', library, manual, calendar).projects).toEqual(['游泳', '爬坡']);
    expect(completedTrainingRecord('2026-10-05', library, manual)).toMatchObject({ projects: ['游泳'], completed: true });
    expect(completedTrainingRecord('2026-10-05', library)).toMatchObject({ projects: [], completed: false, mode: 'auto' });
  });
  it('TickTick 改名为燃脂操后绑定同名自建项目，保留原记录标识且不重复排课', () => {
    const project = { key: 'custom-cardio', name: '燃脂操', notes: '30 分钟', rotation: true, tags: ['有氧'] as const };
    const configured = { revision: '', projects: [{ ...project, tags: [...project.tags] }] };
    const remote = source('燃脂操');
    const library = trainingLibrary([remote], configured);
    const cardio = library.filter(task => task.name === '燃脂操');
    expect(cardio).toHaveLength(1);
    expect(cardio[0]).toMatchObject({ id: remote.id, key: 'custom-cardio', tags: ['有氧'], links: remote.links, notes: '30 分钟' });
    expect(trainingTags({ name: '燃脂操' })).toEqual(['有氧']);
    expect(library.find(task => task.name === '爬坡')?.rotation).toBe(false);
    for (const key of ['燃脂操', 'custom-cardio']) {
      expect(recordedTrainingProjects({ plan: '燃脂操', projects: [key], effort: 'normal', completed: true }, library)).toEqual(['custom-cardio']);
    }
    const result = rollingTrainingPlan(2026, 10, '2026-10-05', { year: 2026, tasks: [remote], settings: configured,
      connected: true, syncedAt: null, completions: [{ project: '燃脂操', date: '2026-10-04' }] }, DEFAULT_CYCLE, [], {});
    expect(result.coverage).toHaveLength(1);
    expect(result.coverage[0]).toMatchObject({ completed: true, lastCompleted: '2026-10-04' });
    expect([...result.completedByDate.get('2026-10-04')!]).toEqual(['custom-cardio']);
    const completedToday = rollingTrainingPlan(2026, 10, '2026-10-05', { year: 2026, tasks: [remote], settings: configured,
      connected: true, syncedAt: null, completions: [{ project: '燃脂操', date: '2026-10-05' }] }, DEFAULT_CYCLE, [], {});
    expect(completedToday.plans.get('2026-10-05')).toMatchObject({ plan: '燃脂操', projects: ['custom-cardio'], completed: true });
  });
  it('有氧、力量只作标签，爬坡和游泳仍是各自独立的项目', () => {
    const tasks = [source('有氧'), source('力量'), source('上半身'), source('游泳')];
    const library = trainingLibrary(tasks);
    expect(library.map(({ name, tags }) => ({ name, tags }))).toEqual([
      { name: '爬坡', tags: ['有氧'] }, { name: '游泳', tags: ['有氧'] }, { name: '上半身', tags: ['力量'] },
    ]);
    const result = rollingTrainingPlan(2026, 10, '2026-10-05', { year: 2026, tasks, settings, connected: false, syncedAt: null,
      completions: [{ project: '爬坡', date: '2026-10-04' }] }, DEFAULT_CYCLE, [], {});
    expect(result.coverage.find(({ task }) => task.name === '爬坡')?.completed).toBe(true);
    expect(result.coverage.find(({ task }) => task.name === '游泳')?.completed).toBe(false);
    expect(result.coverage.map(({ task }) => task.name).sort()).toEqual(['上半身', '游泳', '爬坡'].sort());
    expect([...result.byDate.values()].flat().some((task) => ['有氧', '力量'].includes(task.name))).toBe(false);
  });
  it('保留 TickTick 旧有氧完成记录，但不冒充任何具体项目的完成', () => {
    const result = rollingTrainingPlan(2026, 10, '2026-10-05', { year: 2026, tasks: [source('有氧'), source('游泳')], settings,
      connected: false, syncedAt: null, completions: [{ project: '有氧', date: '2026-10-04' }] }, DEFAULT_CYCLE, [], {});
    expect(result.plans.get('2026-10-04')).toMatchObject({ plan: '有氧', completed: true, projects: ['有氧'] });
    expect(result.coverage.every((item) => !item.completed)).toBe(true);
    expect(result.plans.get('2026-10-05')?.projects).not.toContain('有氧');
    const withoutPending = rollingTrainingPlan(2026, 10, '2026-10-05', { year: 2026, tasks: [], connected: false, syncedAt: null,
      completions: [{ project: '力量', date: '2026-10-05' }] }, DEFAULT_CYCLE, [], {});
    expect(withoutPending.plans.get('2026-10-05')).toMatchObject({ plan: '力量', completed: true });
    expect(withoutPending.coverage).toEqual([]);
  });
  it('标签可保存、取消或多选，旧设置兼容，改名仍保留明确标签', () => {
    const tagged: TrainingSettings = { ...settings, projects: [{ ...settings.projects[0], name: '我的训练', tags: ['有氧', '力量'] }] };
    expect(parseTrainingSettings(tagged)).toEqual(tagged);
    expect(trainingLibrary([], tagged).find((task) => task.key === '爬坡')?.tags).toEqual(['有氧', '力量']);
    expect(trainingTags({ name: '游泳', tags: [] })).toEqual([]);
    expect(trainingTags({ name: '游泳' })).toEqual(['有氧']);
    expect(parseTrainingSettings(settings)).toEqual(settings);
    for (const tags of ['有氧', null, ['其他'], [1], ['有氧', '力量', '有氧']]) {
      expect(() => parseTrainingSettings({ ...settings, projects: [{ ...settings.projects[0], tags }] })).toThrow('标签无效');
    }
  });
  it('预置爬坡、游泳，TickTick 同名游泳只出现一次且保留轮换和跟练', () => {
    const library = trainingLibrary([source('游泳'), source('有氧')]);
    expect(library.map((task) => task.name)).toEqual(['爬坡', '游泳']);
    expect(library[0].rotation).toBe(false);
    expect(library[1]).toMatchObject({ rotation: true, notes: '原有跟练', links: source('游泳').links });
    expect(roll(library).coverage.map(({ task }) => task.name)).toEqual(['游泳']);
  });
  it('保存的名称与内容可跨日复用，修改项目不会改写已保存的记录', () => {
    const library = trainingLibrary([], settings);
    const first = reuseTrainingProjects([library[0]]);
    expect(first).toMatchObject({ plan: '爬坡 · 30 分钟', projects: ['爬坡'], mode: 'manual', completed: false });
    const renamed = trainingLibrary([], { ...settings, projects: [{ ...settings.projects[0], name: '坡度走', notes: '40 分钟' }] });
    expect(reuseTrainingProjects([renamed[0]]).plan).toBe('坡度走 · 40 分钟');
    expect(first.plan).toBe('爬坡 · 30 分钟');
    const entries = { 'training:2026-10-04': { text: '', revision: '', training: { ...first, completed: true } } };
    expect(roll(renamed, entries).coverage[0]).toMatchObject({ completed: true, lastCompleted: '2026-10-04' });
    expect(recordedTrainingProjects(automaticTraining('2026-10-05', [renamed[0]], DEFAULT_CYCLE, []), renamed)).toEqual(['爬坡']);
  });
  it('自建项目可参加滚动轮换，取消轮换后仍可选择并保留完成历史', () => {
    const custom = { key: 'custom-yoga', name: '瑜伽', notes: '', rotation: true };
    const tasks = trainingLibrary([], { revision: '', projects: [custom] });
    expect(roll(tasks).plans.get('2026-10-05')?.projects).toEqual(['custom-yoga']);
    const entry = { text: '', revision: '', training: { ...reuseTrainingProjects([tasks.find((task) => trainingIdentity(task) === custom.key)!]), completed: true } };
    const paused = trainingLibrary([], { revision: '', projects: [{ ...custom, rotation: false }] });
    expect(roll(paused, { 'training:2026-10-04': entry }).plans.get('2026-10-04')).toBe(entry.training);
    expect(roll(paused).coverage).toEqual([]);
    expect(roll(paused).plans.get('2026-10-05')?.projects).toEqual([]);
    expect(paused.some((task) => task.name === '瑜伽')).toBe(true);
  });
  it('手动选择后恢复自动安排仍使用轮换建议，游泳项目继续避开经期', () => {
    const tasks = trainingLibrary([source('上半身')], settings);
    const picked = reuseTrainingProjects([tasks.find((task) => task.name === '爬坡')!]);
    const entries = { 'training:2026-10-05': { text: '', revision: '', training: picked } };
    expect(roll(tasks, entries).plans.get('2026-10-05')).toBe(picked);
    expect(roll(tasks, entries).byDate.get('2026-10-05')).toEqual(roll(tasks).byDate.get('2026-10-05'));
    const swimming = trainingLibrary([], { revision: '', projects: [{ key: '游泳', name: '游泳', notes: '', rotation: true }] });
    const result = rollingTrainingPlan(2026, 10, '2026-10-05', { year: 2026, tasks: swimming, connected: false, syncedAt: null,
      hairWash: { scheduledDate: '2026-10-06' } },
      { ...DEFAULT_CYCLE, lastPeriodStart: '2026-10-01' }, [], {});
    expect(result.plans.get('2026-10-05')?.projects).toEqual([]);
    expect(result.plans.get('2026-10-06')?.projects).toEqual(['游泳']);
  });
  it('限制空名称、重复名称、重复标识和过长内容', () => {
    expect(parseTrainingSettings(settings)).toEqual(settings);
    for (const project of [{ ...settings.projects[0], name: ' ' }, { ...settings.projects[0], key: '' },
      { ...settings.projects[0], notes: 'a'.repeat(501) }, { ...settings.projects[0], rotation: 'yes' }]) {
      expect(() => parseTrainingSettings({ ...settings, projects: [project] })).toThrow();
    }
    expect(() => parseTrainingSettings({ ...settings, projects: [...settings.projects, { ...settings.projects[0], key: 'different' }] })).toThrow('不能重复');
    expect(() => parseTrainingSettings({ ...settings, projects: [...settings.projects, { ...settings.projects[0], name: '另一项' }] })).toThrow('不能重复');
    expect(() => reuseTrainingProjects([source('有氧'), { ...source('游泳'), notes: 'a'.repeat(1000) }])).toThrow('内容过长');
  });
});
