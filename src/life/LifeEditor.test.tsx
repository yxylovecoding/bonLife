import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import LifeEditor from './LifeEditor';
import { DEFAULT_CYCLE } from '../utils/bonLife';
import { trainingLibrary } from '../utils/lifeTraining';

describe('BonFit 完成记录弹窗', () => {
  it('只显示实际项目选择、来源和添加入口，不显示自动计划与强度表单', () => {
    const library = trainingLibrary([{ id: 'hiit', name: 'HIIT', title: 'HIIT', notes: '', dates: [], schedule: '', links: [] }]);
    const html = renderToStaticMarkup(<LifeEditor initial={{ date: '2026-11-15', kind: 'training', text: '保留旧备注', revision: '', mutationId: 'test-mutation',
      training: { plan: 'HIIT', projects: ['hiit'], completed: false, mode: 'auto', effort: 'normal' } }} owner="test"
      cycle={DEFAULT_CYCLE} periodDays={[]} skinEntries={{}} symptomEntries={{}} trainingLibrary={library}
      trainingCompletions={[{ project: '爬坡（45m）', date: '2026-11-15' }]}
      calendarCompletions={[{ project: '爬坡（45m）', date: '2026-11-15' }]}
      onTrainingSettings={vi.fn()} onClose={vi.fn()} onSave={vi.fn()} onExpired={vi.fn()} />);
    expect(html).toContain('做了什么');
    expect(html).toMatch(/aria-pressed="true"[^>]*>爬坡<small[^>]*>日历<\/small>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>HIIT<\/button>/);
    expect(html).toContain('添加运动项目');
    expect(html).not.toMatch(/自动轮换|当日强度|运动计划|运动内容|<textarea|已完成<\/label>|保留旧备注/);
  });
});
