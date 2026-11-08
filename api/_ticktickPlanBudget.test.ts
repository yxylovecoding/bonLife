import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LifePlanDetails from '../src/life/LifePlanDetails';
import { planTickTickDay, type DailyPlanState } from './_ticktickDailyPlan';
import type { TickTickTask } from './_ticktickTrips';

const today = '2026-10-11';
const task = (id: string, minutes: number, priority = 0): TickTickTask => ({ id, projectId: 'inbox', title: id,
  content: `(${minutes}m)`, status: 0, isAllDay: true, dueDate: `${today}T00:00:00+08:00`, priority });
const state = (): DailyPlanState => ({ connectionId: 'test', history: [], deadlines: {} });
const shown = (s: DailyPlanState) => renderToStaticMarkup(createElement(LifePlanDetails, { plan: s.briefing! }));

describe('后台排期与页面共用预算', () => {
  it.each([['22:00', 0], ['21:45', 15]])('日程从 %s 开始时，页面区分完整时长和排期占用', (start, occupiedMinutes) => {
    const s = state();
    const end = start === '22:00' ? '22:30' : '22:15';
    planTickTickDay({ state: s, today, now: new Date(`${today}T20:00:00+08:00`), calendarState: {}, tasks: [],
      availability: { startDate: today, endDate: '2026-11-12', events: [
        { title: '洗头', start: `${today}T${start}:00+08:00`, end: `${today}T${end}:00+08:00` },
      ] } });
    const html = shown(s);
    expect(html).toContain('<span>洗头</span><span>30 分钟</span>');
    expect(html).toContain(`Outlook 日程 · 共 1 项 · 占用可排期时间 ${occupiedMinutes} 分钟`);
    expect(html).toContain(`<dt>扣除日程后剩余</dt><dd>${120 - occupiedMinutes} 分钟</dd>`);
  });
  it.each([[91, 0, 0], [61, 30, 1], [120, 0, 0]])('空闲91分钟、重要事项%i分钟，新增额度为%i分钟', (important, capacity, count) => {
    const s = state();
    const result = planTickTickDay({ state: s, today, now: new Date(`${today}T15:28:01+08:00`),
      tasks: [task('ordinary-long', 60), task('ordinary-short', 30), task('important', important, 5)],
      calendarState: { tagMap: { [today]: 'travel' } }, availability: { startDate: today, endDate: '2026-11-12', events: [
        { title: '晚间约定', start: `${today}T19:00:00+08:00`, end: `${today}T22:00:00+08:00` },
        { title: '吃饭', start: `${today}T17:00:00+08:00`, end: `${today}T18:00:00+08:00` },
      ] } });
    expect(s.briefing!.breakdown).toMatchObject({ windowMinutes: 271, occupiedMinutes: 180, freeMinutes: 91,
      importantOccupiedMinutes: important, freeAfterImportantMinutes: capacity, newTaskCapacityMinutes: capacity });
    expect(result.summary).toMatchObject({ availableMinutes: capacity, plannedMinutes: capacity, todayCount: count });
    expect(s.briefing!.selected.reduce((sum, t) => sum + t.minutes, 0)).toBeLessThanOrEqual(capacity);
    if (!count) expect(result.dates.get('ordinary-short')).toBe('2026-10-12');
    const html = shown(s);
    expect(html).toContain(`<dt>扣除今日重要之事后剩余</dt><dd>${capacity} 分钟</dd>`);
    expect(html).toContain(`<dt>本轮可新增安排</dt><dd>${capacity} 分钟</dd>`);
    expect(html).toContain(`排入今日事 · ${count} 项 · 约 ${capacity} 分钟`);
  });
  it('重要事项已有 Outlook 预约时不重复扣除，页面显示另需时间', () => {
    const s = state();
    planTickTickDay({ state: s, today, now: new Date(`${today}T20:00:00+08:00`), calendarState: {},
      tasks: [task('预约事项', 60, 5), task('未定时重要事项', 30, 5), task('ordinary', 30)],
      availability: { startDate: today, endDate: '2026-11-12', events: [
        { title: '预约事项', start: `${today}T20:00:00+08:00`, end: `${today}T21:00:00+08:00` },
      ] } });
    expect(s.briefing!.breakdown).toMatchObject({ freeMinutes: 60, importantAdditionalMinutes: 30,
      importantOccupiedMinutes: 30, freeAfterImportantMinutes: 30, newTaskCapacityMinutes: 30 });
    expect(s.briefing!.selected.map(t => t.id)).toEqual(['ordinary']);
    expect(shown(s)).toContain('今日重要之事 · 共 2 项 · 另需 30 分钟');
    expect(shown(s)).toContain('<dt>本轮可新增安排</dt><dd>30 分钟</dd>');
  });
  it('旧快照直接显示后台额度，不在前端制造二次扣减', () => {
    const s = state();
    planTickTickDay({ state: s, today, now: new Date(`${today}T20:00:00+08:00`), calendarState: {},
      tasks: [task('ordinary', 30)], budgetMinutes: 60 });
    delete s.briefing!.breakdown!.importantOccupiedMinutes;
    delete s.briefing!.breakdown!.freeAfterImportantMinutes;
    s.briefing!.breakdown!.important = [{ ...task('important', 90, 5), minutes: 90, additionalMinutes: 0, durationBasis: '' }];
    expect(shown(s)).toContain('<dt>本轮可新增安排</dt><dd>60 分钟</dd>');
    expect(shown(s)).toContain('<dt>扣除今日重要之事后剩余</dt><dd>—</dd>');
  });
});
