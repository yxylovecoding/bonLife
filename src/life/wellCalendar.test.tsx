import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CYCLE, type LifeEntries } from '../utils/bonLife';
import { DEFAULT_SKIN_SETTINGS } from '../utils/lifeSkin';
import { wellCalendarDay } from './wellCalendar';
import { calendarStripSegments } from './calendarStrips';
import LifeWellCalendar from './LifeWellCalendar';
import LifeWellEditor from './LifeWellEditor';
import { wellDay } from '../utils/lifeWell';

const date = '2026-11-13';
const entries: LifeEntries = {
  [`skin:${date}`]: { text: '护肤备注', revision: 's', skin: { status: 'healthy' }, makeup: { face: true, eyes: false, revision: 'm' } },
  [`eyes:${date}`]: { text: '眼部备注', revision: 'e', eyes: { symptoms: { 'eye:干涩': { area: 'eye', name: '干涩', status: 'ongoing', note: '' } } }, makeup: { face: true, eyes: false, revision: 'm' } },
  [`discomfort:${date}`]: { text: '身体备注', revision: 'b', discomfort: { symptoms: { 'body:干涩': { area: 'body', name: '干涩', status: 'resolved', note: '' } } } },
  [`mood:${date}`]: { text: '心情不错', revision: 'm' },
};
describe('bonWell 综合月历', () => {
  it('四类汇总、化妆去重、同名不同部位独立，消失不延续色条', () => {
    const value = wellCalendarDay(date, date, entries, entries, DEFAULT_SKIN_SETTINGS);
    expect(value.summaries.map(item => item.kind)).toEqual(['skin', 'eyes', 'discomfort', 'mood']);
    expect(value.summaries.every(item => !item.text.includes('有化妆'))).toBe(true);
    expect(value.strips.map(item => item.key)).toEqual(['skin:healthy', 'eye:干涩', 'body:干涩']);
    expect(calendarStripSegments([date], new Map([[date, value.strips]])).get(date)?.map(item => item.key)).toEqual(['eye:干涩', 'skin:healthy']);
  });
  it('年初护理建议读取去年历史，明确清空后不再展示建议，也不改变原记录', () => {
    const history: LifeEntries = { 'skin:2025-12-31': { text: '', revision: 'old', skin: { status: 'acne', planDay: 1, morningMedication: '炉甘石' } } };
    const before = JSON.stringify(history);
    expect(wellCalendarDay('2026-01-01', '2026-01-01', {}, history, DEFAULT_SKIN_SETTINGS).suggested).toBe(true);
    expect(wellCalendarDay('2026-01-01', '2026-01-01', { 'skin:2026-01-01': { text: '', revision: 'cleared', skin: {} } }, history, DEFAULT_SKIN_SETTINGS).suggested).toBe(false);
    expect(JSON.stringify(history)).toBe(before);
  });
  it('渲染带类别的摘要、经期及日期按钮，编辑窗口只出现一份共享字段和保存按钮', () => {
    const html = renderToStaticMarkup(<LifeWellCalendar year={2026} month={11} now={date} data={{ year: 2026, entries, periodDays: [date],
      cycle: DEFAULT_CYCLE, connected: false, syncedAt: null }} skinEntries={entries} loading={false} error="" onEdit={() => {}} />);
    expect(html).toContain('2026年11月bonWell日历'); expect(html).toContain('phase-menstrual'); expect(html).toContain('is-today');
    for (const text of ['皮肤', '眼睛', '身体', '情绪', '心情不错']) expect(html).toContain(text);
    const editor = renderToStaticMarkup(<LifeWellEditor date={date} initial={wellDay(entries, date)} owner="fixture" skinSettings={DEFAULT_SKIN_SETTINGS}
      skinEntries={entries} symptomEntries={entries} onSave={() => {}} onClose={() => {}} onExpired={() => {}} />);
    expect(editor.match(/>化妆<select/g)).toHaveLength(1); expect(editor.match(/>眼妆<select/g)).toHaveLength(1);
    expect(editor.match(/type="submit"/g)).toHaveLength(1); expect(editor.match(/aria-expanded="true"/g)).toHaveLength(4);
  });
});
