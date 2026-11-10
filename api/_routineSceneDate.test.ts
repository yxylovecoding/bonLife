import { describe, expect, it } from 'vitest';
import { defaultRuleConfig } from '../src/utils/schedulingRules';
import { withActiveRule, withRulePolicy } from './_rulePolicy';
import { routineSceneMatchesDate, routineScenes, type TickTickTask } from './_ticktickTrips';
import { BEIJING, GUANGZHOU } from '../src/utils/internship';

describe('候选日场景资格', () => {
  const task = (tags: string[]): TickTickTask => ({ id: 'exercise', projectId: 'life', title: '训练', tags });
  const date = '2026-11-05';
  it.each([
    [['寄'], 'home', true], [['寄'], 'school', false],
    [['居'], 'school', true], [['寓'], 'intern', true],
    [['旅'], 'travel', true], [['居', '寄'], 'home', true],
    [['居', '寄'], 'travel', false], [['居'], 'unknown', false],
    [['动'], 'travel', true],
  ] as const)('%j 在 %s 场景的候选资格为 %s', (tags, scene, expected) => {
    expect(routineSceneMatchesDate(task([...tags]), { tagMap: { [date]: scene } }, date)).toBe(expected);
  });
  it('未来有适用场景也不能让缺少场景的当天参加轮换', () => {
    expect(routineSceneMatchesDate(task(['居']), { tagMap: { '2026-11-06': 'school' } }, date)).toBe(false);
    expect(routineSceneMatchesDate(task(['居']), null, date)).toBe(false);
    expect(routineSceneMatchesDate(task(['居']), { tagMap: { '2026-02-30': 'school' } }, '2026-02-30')).toBe(false);
  });
  it('场景约束遵守本轮规则顺序，不使用上轮资格', () => {
    const config = defaultRuleConfig();
    const check = () => withActiveRule('exercise', () => routineSceneMatchesDate(task(['居']), { tagMap: { [date]: 'travel' } }, date));
    expect(withRulePolicy(config, check)).toBe(false);
    config.order = ['exercise', ...config.order.filter(id => id !== 'exercise')];
    expect(withRulePolicy(config, check)).toBe(true);
    expect(withRulePolicy(defaultRuleConfig(), check)).toBe(false);
  });
  it('原场景查询同时核对城市，场景和城市各自取并集后再取交集', () => {
    const state = { tagMap: { [date]: 'intern' }, cityMap: { [date]: GUANGZHOU } };
    expect(routineSceneMatchesDate(task(['居', '北京']), state, date)).toBe(false);
    expect(routineSceneMatchesDate(task(['寄', '居', '广州', '北京']), state, date)).toBe(true);
    expect(routineSceneMatchesDate(task(['北京']), state, date)).toBe(false);
    expect(routineSceneMatchesDate(task(['广州']), state, date)).toBe(true);
    expect(routineSceneMatchesDate(task(['北京']), { cityMap: { [date]: BEIJING } }, date)).toBe(true);
    expect(routineSceneMatchesDate(task(['居', '北京']), { cityMap: { [date]: BEIJING } }, date)).toBe(false);
    expect(routineSceneMatchesDate(task(['北京']), { tagMap: { [date]: 'school' } }, date)).toBe(false);
  });
  it('城市与场景使用同一前序开关，不出现只有城市提前生效', () => {
    const config = defaultRuleConfig();
    config.order = ['exercise', ...config.order.filter(id => id !== 'exercise')];
    const check = () => withActiveRule('exercise', () => routineSceneMatchesDate(task(['居', '北京']),
      { tagMap: { [date]: 'travel' }, cityMap: { [date]: GUANGZHOU } }, date));
    expect(withRulePolicy(config, check)).toBe(true);
    expect(withRulePolicy(defaultRuleConfig(), check)).toBe(false);
  });
  it('分类只读取地点目录内的场景，不把目录外寓作为居的别名', () => {
    expect(routineScenes(task(['寄', '居', '寓', '旅']), { locationTags: ['寄', '旅'] })).toEqual(['home', 'travel']);
    expect(routineScenes(task(['寓']), { locationTags: ['居'] })).toEqual([]);
    expect(routineScenes(task(['寓']), { locationTags: ['寓'] })).toEqual(['school']);
    expect(routineScenes(task(['居']), { locationTags: [] })).toEqual([]);
    expect(routineScenes(task(['寓']))).toEqual(['school']);
  });
});
