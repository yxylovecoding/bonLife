import { expect, it } from 'vitest';
import { DEFAULT_CYCLE } from '../src/utils/bonLife';
import { BEIJING, GUANGZHOU } from '../src/utils/internship';
import { hairWashLocationDate } from './_hairWashLocation';
import type { TickTickTask } from './_ticktickTrips';

const task: TickTickTask = { id: 'prep', projectId: 'p', title: '下班准备游泳', tags: ['北京', '居', 'routine', 'hidden'],
  startDate: '2026-11-10T21:00:00+0800', dueDate: '2026-11-11T21:15:00+0800', timeZone: 'Asia/Shanghai' };
const schedule = { scheduledDate: '2026-11-12', repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=2' };
const calendar = { tagMap: { '2026-11-11': 'school', '2026-11-12': 'school', '2026-11-13': 'school', '2026-11-14': 'school' },
  cityMap: { '2026-11-11': GUANGZHOU, '2026-11-12': BEIJING, '2026-11-13': BEIJING, '2026-11-14': BEIJING } };
it('跨日游泳准备的整段日期都须符合地点，不能只查截止日', () => {
  expect(hairWashLocationDate(task, schedule, '2026-11-10', calendar)).toBe('2026-11-14');
});
it('跨日游泳准备任一天是经期就跳过该洗头日', () => {
  const state = { ...calendar, cityMap: { ...calendar.cityMap, '2026-11-11': BEIJING } };
  expect(hairWashLocationDate(task, schedule, '2026-11-10', state,
    { cycle: { ...DEFAULT_CYCLE, lastPeriodStart: '2026-11-11', periodLength: 1, automatic: false }, periods: [] })).toBe('2026-11-14');
});
