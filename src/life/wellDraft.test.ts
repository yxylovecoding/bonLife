import { beforeEach, describe, expect, it } from 'vitest';
import { saveDraft, readDraft } from './client';
import { createWellDraft, readWellDraft, rebaseWellDraft, removeWellDraft, saveWellDraft, wellDraftEdit } from './wellDraft';
import { wellDay, parseWellEdit, wellView } from '../utils/lifeWell';

const date = '2026-11-13';
const day = () => wellDay({}, date);
beforeEach(() => localStorage.clear());

describe('bonWell 草稿与提交', () => {
  it('只提交修改的分类，不把未编辑的肤况或化妆写入', () => {
    const draft = createWellDraft('bon', date, day());
    draft.entries.skin.skin = { status: 'acne', planDay: 2 };
    draft.entries.mood.text = '心情不错'; draft.changed = ['mood'];
    expect(wellDraftEdit(draft, {})).toEqual({ date, mutationId: draft.mutationId, entries: { mood: { text: '心情不错', revision: '' } } });
  });
  it('刷新恢复多分类草稿，日期和账号互相隔离', () => {
    const draft = createWellDraft('bon', date, day());
    draft.changed = ['mood', 'eyes']; draft.entries.mood.text = '草稿'; draft.names.eyes = { eye: '干涩' };
    saveWellDraft('bon', draft);
    expect(readWellDraft('bon')).toEqual(draft);
    expect(createWellDraft('bon', date, day())).toEqual(draft);
    expect(readWellDraft('other', date)).toBeNull();
    expect(readWellDraft('bon', '2026-11-12')).toBeNull();
    expect(wellDraftEdit(draft, {}).entries.eyes?.eyes?.symptoms?.['eye:干涩'].status).toBe('appeared');
  });
  it('恢复同日多份旧草稿并保留旧日期和其他类型草稿', () => {
    const old = { date, text: '眼睛备注', revision: '', mutationId: 'legacy-eye-123456', kind: 'eyes' as const, symptomNames: { eye: '红血丝' } };
    saveDraft('bon', old);
    saveDraft('bon', { ...old, kind: 'mood', text: '情绪备注', mutationId: 'legacy-mood-123456', symptomNames: undefined });
    saveDraft('bon', { ...old, date: '2025-12-31', mutationId: 'other-date-123456' });
    const draft = createWellDraft('bon', date, day());
    expect(draft.changed).toEqual(['eyes', 'mood']);
    expect(draft.names.eyes).toEqual({ eye: '红血丝' });
    saveWellDraft('bon', draft); removeWellDraft('bon', draft);
    expect(readWellDraft('bon')).toBeNull();
    expect(readDraft('bon', { date, kind: 'eyes' })).toBeNull();
    expect(readDraft('bon', { date: '2025-12-31', kind: 'eyes' })?.text).toBe('眼睛备注');
  });
  it('较新窗口的草稿不被旧窗口清除', () => {
    const first = createWellDraft('bon', date, day());
    const next = { ...first, mutationId: crypto.randomUUID() };
    saveWellDraft('bon', next); removeWellDraft('bon', first);
    expect(readWellDraft('bon')?.mutationId).toBe(next.mutationId);
  });
  it('解决冲突只保留编辑的分类，其他分类采用最新云端值', () => {
    const draft = createWellDraft('bon', date, day());
    draft.changed = ['mood']; draft.entries.mood.text = '我的修改';
    const current = day(); current.entries.skin = { text: '新肤况', revision: 'new-skin' }; current.entries.mood.revision = 'new-mood';
    const next = rebaseWellDraft(draft, current);
    expect(next.entries.skin).toEqual(current.entries.skin);
    expect(next.entries.mood).toEqual({ text: '我的修改', revision: 'new-mood' });
    expect(next.mutationId).not.toBe(draft.mutationId);
  });
  it('恢复草稿保留编辑内容和请求标识，未编辑分类读取最新云端值', () => {
    const draft = createWellDraft('bon', date, day()); draft.changed = ['mood']; draft.entries.mood.text = '未保存';
    saveWellDraft('bon', draft);
    const current = day(); current.entries.skin = { text: '另一页面已保存', revision: 'new' };
    const recovered = createWellDraft('bon', date, current);
    expect(recovered.entries.skin).toEqual(current.entries.skin);
    expect(recovered.entries.mood.text).toBe('未保存'); expect(recovered.mutationId).toBe(draft.mutationId);
    expect(Object.keys(wellDraftEdit(recovered, {}).entries)).toEqual(['mood']);
  });
  it('明确清空症状后不从旧文字恢复症状', () => {
    const draft = createWellDraft('bon', date, day()); draft.changed = ['eyes']; draft.entries.eyes.eyes = {};
    expect(wellDraftEdit(draft, {}).entries.eyes).toEqual({ text: '', revision: '', eyes: { symptoms: {} } });
  });
  it('四个旧链接映射到综合视图，运动与身体数据保持原入口', () => {
    for (const kind of ['skin', 'eyes', 'discomfort', 'mood'] as const) expect(wellView(kind)).toBe('well');
    expect(wellView('body')).toBe('body'); expect(wellView('training')).toBe('training');
  });
  it('拒绝越界分类、日期、跨分类字段和无修改提交', () => {
    const base = { date, mutationId: 'validation-123456', entries: { mood: { text: 'ok', revision: '' } } };
    expect(parseWellEdit(base)).toEqual(base);
    for (const value of [{ ...base, date: '2026-02-30' }, { ...base, entries: {} },
      { ...base, entries: { training: { text: '', revision: '' } } },
      { ...base, entries: { mood: { text: '', revision: '', skin: {} } } },
      { ...base, entries: { skin: { text: '', revision: '', makeup: {} } } }]) expect(() => parseWellEdit(value)).toThrow();
  });
});
