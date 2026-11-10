import { describe, expect, it } from 'vitest';
import { createRoutineSceneDateFinder, getTickTickRoutineTargetDates, nextRoutineSceneDate, type TickTickTask } from './_ticktickTrips';
import { withActiveRule, withRulePolicy } from './_rulePolicy';
import { defaultRuleConfig } from '../src/utils/schedulingRules';
import { BEIJING, GUANGZHOU } from '../src/utils/internship';

const task = (tags: string[]): TickTickTask => ({ id: 'task', projectId: 'project', title: '任务', tags });

describe('单轮排程的场景日期索引', () => {
  it('无序日期、实习/学校、多个场景、无匹配与非法日期沿用原有语义', () => {
    const calendar = { tagMap: { '2027-01-02': 'home', '2026-11-10': 'travel', '2026-11-06': 'intern',
      '2026-11-04': 'school', '2026-11-05': 'home', '2026-11-31': 'travel', '2026-13-01': 'home',
      'invalid': 'school', '2026-11-03': 'other' } };
    const find = createRoutineSceneDateFinder(calendar);
    expect(find(task(['居']), '2026-11-05')).toBe('2026-11-06');
    expect(find(task(['寄', '旅']), '2026-11-06')).toBe('2026-11-10');
    expect(find(task(['旅']), '2026-11-11')).toBeNull();
    for (const tags of [[], ['寄'], ['居'], ['寓'], ['旅'], ['寄', '居', '旅']]) {
      for (const from of ['2026-11-01', '2026-11-04', '2026-11-05', '2026-11-07', '2027-01-03']) {
        expect(find(task(tags), from)).toBe(nextRoutineSceneDate(task(tags), calendar, from));
      }
    }
    expect(getTickTickRoutineTargetDates(calendar, '2026-11-04'))
      .toEqual({ home: '2026-11-05', school: '2026-11-04', travel: '2026-11-10' });
  });

  it('下一轮重新读取日历，索引不跨账号或请求复用', () => {
    const calendar = { tagMap: { '2026-11-05': 'home' } };
    const first = createRoutineSceneDateFinder(calendar);
    calendar.tagMap['2026-11-05'] = 'travel';
    expect(first(task(['寄']), '2026-11-04')).toBe('2026-11-05');
    expect(createRoutineSceneDateFinder(calendar)(task(['寄']), '2026-11-04')).toBeNull();
    expect(createRoutineSceneDateFinder({})(task(['寄']), '2026-11-04')).toBeNull();
  });

  it('查询时仍遵守当前规则顺序，不提前应用尚未生效的场景限制', () => {
    const find = createRoutineSceneDateFinder({ tagMap: { '2026-11-06': 'home' } });
    const config = defaultRuleConfig();
    config.order = ['daily-plan', ...config.order.filter(id => id !== 'daily-plan')];
    expect(withRulePolicy(config, () => withActiveRule('daily-plan', () => find(task(['寄']), '2026-11-04'))))
      .toBe('2026-11-04');
    expect(find(task(['寄']), '2026-11-04')).toBe('2026-11-06');
  });
  it('旧场景日期接口与索引均查完整地点条件，城市日期不要求已有场景', () => {
    const state = { tagMap: { '2026-11-05': 'school', '2026-11-06': 'home', '2026-11-07': 'intern' },
      cityMap: { '2026-11-05': GUANGZHOU, '2026-11-06': BEIJING, '2026-11-07': BEIJING, '2026-11-08': BEIJING } };
    const find = createRoutineSceneDateFinder(state);
    expect(find(task(['居', '北京']), '2026-11-05')).toBe('2026-11-07');
    expect(find(task(['北京']), '2026-11-05')).toBe('2026-11-06');
    expect(find(task(['北京']), '2026-11-08')).toBe('2026-11-08');
    expect(find(task(['居', '北京']), '2026-11-08')).toBeNull();
    for (const tags of [[], ['居'], ['北京'], ['居', '北京'], ['寄', '居', '北京', '广州']]) {
      for (const from of ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-08', '2026-11-09']) {
        expect(find(task(tags), from)).toBe(nextRoutineSceneDate(task(tags), state, from));
      }
    }
    state.cityMap['2026-11-07'] = GUANGZHOU;
    expect(find(task(['居', '北京']), '2026-11-05')).toBe('2026-11-07');
    expect(createRoutineSceneDateFinder(state)(task(['居', '北京']), '2026-11-05')).toBeNull();
  });
});
