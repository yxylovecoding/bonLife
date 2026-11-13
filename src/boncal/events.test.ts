import { describe, expect, it } from 'vitest';
import { applyOutlookSnapshotToState, buildOutlookSnapshot, DEFAULT_OUTLOOK_RULES, repairCalendarState, type OutlookDayEvent } from './events';
import { bonCalTrips } from './trips';
import { calendarDestinations, tripDestinationQueries } from './destinations';
import { repairReminderWishes } from './repair';

const event = (title: string, patch: Partial<OutlookDayEvent> = {}): OutlookDayEvent => ({ title, calendar: 'play', uid: title,
  startDate: '2026-11-13', endDate: '2026-11-14', allDay: true, ...patch });
const snapshot = (events: OutlookDayEvent[]) => buildOutlookSnapshot(events, '2026-11-01', '2026-12-01', DEFAULT_OUTLOOK_RULES);

describe('bonCal 的生日边界', () => {
  it.each(['生日', '妈妈生日🎂', 'Happy Birthday', 'ALICE’S BDAY', 'B-day', '🎂'])('%s 不生成出游、目的地或心愿', title => {
    for (const calendar of ['play', 'class', 'work', 'calendar'] as const) {
      const result = snapshot([event(title, { calendar, location: '北京', endDate: '2026-11-16' })]);
      expect(result.tags).toEqual({}); expect(result.travelTitles).toEqual({}); expect(result.wishEvents ?? []).toEqual([]);
      expect(calendarDestinations([event(title, { location: '北京' })])).toEqual([]);
      expect(tripDestinationQueries(title)).toEqual([]);
    }
  });
  it('同日旅行独立保留，不被生日延长或混入标题', () => {
    const result = snapshot([event('生日', { startDate: '2026-11-11', endDate: '2026-11-16' }), event('杭州')]);
    expect(result.tags).toEqual({ '2026-11-13': 'travel' });
    expect(result.travelTitles).toEqual({ '2026-11-13': '杭州' });
    expect(result.wishEvents?.map(item => item.title)).toEqual(['杭州']);
  });
  it('历史明确误标恢复基线，混合标题保留旅行，真正手动日期保留', () => {
    const old = { tagMap: { '2026-01-01': 'travel', '2026-01-02': 'travel', '2026-01-03': 'home', '2026-01-04': 'travel' },
      outlookTravelTitles: { '2026-01-01': '生日', '2026-01-02': '妈妈生日🎂、杭州', '2026-01-03': '生日' },
      outlookApplied: { '2026-01-01': { tag: 'travel', previousTag: 'school' }, '2026-01-02': { tag: 'travel', previousTag: 'school' },
        '2026-01-03': { tag: 'travel', previousTag: 'school' } }, confirmedExpenses: { keep: true } };
    const fixed = repairCalendarState(old);
    expect(fixed.tagMap).toEqual({ '2026-01-01': 'school', '2026-01-02': 'travel', '2026-01-03': 'home', '2026-01-04': 'travel' });
    expect(fixed.outlookTravelTitles).toEqual({ '2026-01-02': '杭州' });
    expect((fixed as Record<string, unknown>).confirmedExpenses).toEqual({ keep: true });
    expect(repairCalendarState(fixed)).toEqual(fixed);
    const replay = { startDate: '2026-01-01', endDate: '2026-01-02', tags: { '2026-01-01': 'travel' as const }, travelTitles: { '2026-01-01': '生日' } };
    expect(applyOutlookSnapshotToState(fixed, replay, 'outlook', '2026-11-13').tagMap).toEqual(fixed.tagMap);
  });
  it('所有行程消费者得到相同分段和标题', () => {
    const calendar = applyOutlookSnapshotToState({}, snapshot([event('生日'), event('北京', { startDate: '2026-11-15', endDate: '2026-11-18' })]), 'outlook');
    const result = bonCalTrips(calendar, { tripSplits: { '2026-11-17': true } });
    expect(result.map(trip => [trip.title, trip.startDate, trip.endDate])).toEqual([['北京', '2026-11-15', '2026-11-16'], ['北京', '2026-11-17', '2026-11-17']]);
  });
  it('移除空白自动心愿，有人工财务内容的生日心愿保留并解除错误关联', () => {
    const wish = { id: 'wish_trip_2026-11-13', name: '生日', linkedTripStartDate: '2026-11-13', targetAmount: 0, savedAmount: 0, plannedTravelDays: 0, isActive: true };
    expect(repairReminderWishes([wish])).toEqual([]);
    expect(repairReminderWishes([{ ...wish, targetAmount: 500 }])).toEqual([{ id: wish.id, name: wish.name, targetAmount: 500, savedAmount: 0, plannedTravelDays: 0, isActive: true }]);
  });
  it('Google 备用缺项不删除已有未来日程', () => {
    const old = applyOutlookSnapshotToState({}, snapshot([event('杭州')]), 'outlook', '2026-11-01');
    const backup = { ...snapshot([]), sources: [{ name: '玩', provider: 'google' as const, fetchedAt: '2026-11-01T00:00:00Z' }] };
    expect(applyOutlookSnapshotToState(old, backup, 'outlook', '2026-11-01').tagMap['2026-11-13']).toBe('travel');
  });
});

it.each(['🏠', '实习'])('生日与 %s 同日不覆盖真实场景', title => {
  const result = snapshot([event('🎂', { endDate: '2026-11-16' }), event(title)]);
  expect(result.tags['2026-11-13']).toBe(title === '🏠' ? 'home' : 'intern');
  expect(result.tags['2026-11-14']).toBeUndefined(); expect(result.travelTitles).toEqual({});
});
it('明确手动的出游日期不因同日旧生日日程被删', () => {
  const fixed = repairCalendarState({ tagMap: { '2026-11-13': 'travel' }, manualTagDates: { '2026-11-13': true },
    outlookApplied: { '2026-11-13': { tag: 'travel', previousTag: 'home' } }, outlookTravelTitles: { '2026-11-13': '生日' } });
  expect(fixed.tagMap['2026-11-13']).toBe('travel'); expect(fixed.outlookTravelTitles).toEqual({});
});
