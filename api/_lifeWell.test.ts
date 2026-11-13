import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoKv } from './_tursoKv';
import { initializeTursoSchema } from './_tursoSchema';
import { SAVE_WELL } from './_lifeWell';
import { parseWellEdit, type WellDay, type WellEdit } from '../src/utils/lifeWell';

let client: Client, kv: ReturnType<typeof createTursoKv>;
const date = '2026-11-13';
const id = 'well-mutation-123456';
beforeEach(async () => { client = createClient({ url: 'file::memory:' }); await initializeTursoSchema(client); kv = createTursoKv(client); });
afterEach(() => client.close());
async function save(entries: WellEdit['entries'], mutationId = id, makeup?: WellEdit['makeup'], owner = 'bon') {
  const edit = parseWellEdit({ date, mutationId, entries, ...(makeup ? { makeup } : {}) });
  const payload = JSON.stringify(edit);
  return kv.eval<string[], [number, WellDay]>(SAVE_WELL, [`${owner}:life`, `${owner}:symptoms`, `${owner}:receipt:${mutationId}`],
    [date, mutationId, payload, createHash('sha256').update(payload).digest('hex')]);
}
describe('bonWell 原子保存', () => {
  it('多类和共享字段一起保存并回读，症状索引同步，不触及其他日或身体数据', async () => {
    await kv.hset('bon:life', { 'body:2026-11-13': { text: '', revision: 'body', body: { weight: 50 } }, 'mood:2026-11-12': { text: '昨天', revision: 'old' } });
    const entries = { skin: { text: '护理', revision: '', skin: { status: 'healthy' as const } }, eyes: { text: '眼', revision: '', eyes: { symptoms: {} } },
      discomfort: { text: '身体', revision: '', discomfort: { symptoms: {} } }, mood: { text: '开心', revision: '' } };
    const [ok, day] = await save(entries, id, { face: true, eyes: false, revision: '' });
    expect(ok).toBe(1); expect(Object.values(day.entries).every(item => item.revision === id)).toBe(true);
    expect(day.makeup).toEqual({ face: true, eyes: false, revision: id });
    expect(await kv.hget('bon:symptoms', `eyes:${date}`)).toEqual(day.entries.eyes);
    expect(await kv.hget('bon:symptoms', `discomfort:${date}`)).toEqual(day.entries.discomfort);
    expect(await kv.hget('bon:life', 'body:2026-11-13')).toMatchObject({ body: { weight: 50 } });
    expect(await kv.hget('bon:life', 'mood:2026-11-12')).toMatchObject({ text: '昨天' });
  });
  it('仅改情绪不生成皮肤或化妆记录；明确清空只清除指定分类并保留版本', async () => {
    await save({ mood: { text: '心情', revision: '' } });
    expect(await kv.hget('bon:life', `skin:${date}`)).toBeNull(); expect(await kv.hget('bon:life', `makeup:${date}`)).toBeNull();
    await kv.hset('bon:life', { [`eyes:${date}`]: { text: '旧', revision: 'old', eyes: { leftEye: '旧症状' } } });
    await save({ eyes: { text: '', revision: 'old', eyes: { symptoms: {} } } }, 'clear-mutation-123456');
    expect(await kv.hget('bon:life', `eyes:${date}`)).toEqual({ text: '', revision: 'clear-mutation-123456', eyes: { symptoms: {} } });
    expect(await kv.hget('bon:life', `mood:${date}`)).toMatchObject({ text: '心情' });
  });
  it('只改共享化妆不触及分类版本，省略结构字段时沿用原记录', async () => {
    await kv.hset('bon:life', { [`skin:${date}`]: { text: '原备注', revision: 's', skin: { status: 'healthy', morningProducts: '面霜' } } });
    expect((await save({}, id, { face: false, eyes: null, revision: '' }))[1].entries.skin.revision).toBe('s');
    const result = await save({ skin: { text: '新备注', revision: 's' } }, 'skin-mutation-123456');
    expect(result[1].entries.skin.skin).toEqual({ status: 'healthy', morningProducts: '面霜' });
    expect(result[1].makeup.revision).toBe(id);
  });
  it('任一分类或共享字段冲突时整笔拒绝，不写回执或症状索引', async () => {
    await kv.hset('bon:life', { [`mood:${date}`]: { text: '新', revision: 'new' }, [`makeup:${date}`]: { makeup: { face: false, eyes: false, revision: 'shared' } } });
    expect((await save({ eyes: { text: '不可写入', revision: '' }, mood: { text: '旧', revision: '' } }))[0]).toBe(0);
    expect((await save({ eyes: { text: '不可写入', revision: '' } }, id, { face: true, eyes: false, revision: '' }))[0]).toBe(0);
    expect(await kv.hget('bon:life', `eyes:${date}`)).toBeNull(); expect(await kv.hgetall('bon:symptoms')).toBeNull();
    expect(await kv.get(`bon:receipt:${id}`)).toBeNull();
  });
  it('重复提交回读最新值，不能恢复后来改动；复用标识更换内容被拒绝', async () => {
    const entries = { mood: { text: '初次', revision: '' } };
    await save(entries); await save({ mood: { text: '后来修改', revision: id } }, 'later-mutation-123456');
    const repeated = await save(entries); expect(repeated[0]).toBe(1); expect(repeated[1].entries.mood.text).toBe('后来修改');
    expect((await save({ mood: { text: '冒用标识', revision: '' } }))[0]).toBe(-1);
  });
  it('索引写入故障回滚前面的分类写入，共享字段与回执也不留下', async () => {
    await kv.set('bon:symptoms', 'wrong-type');
    await expect(save({ skin: { text: '先写入', revision: '' }, eyes: { text: '触发故障', revision: '' } })).rejects.toThrow('type mismatch');
    expect(await kv.hgetall('bon:life')).toBeNull(); expect(await kv.get(`bon:receipt:${id}`)).toBeNull();
  });
  it('并发版本只有一笔成功，相同 mutationId 在不同账号内独立', async () => {
    const entries = { mood: { text: '内容', revision: '' } };
    const results = await Promise.all([save(entries), save(entries, 'competing-mutation-123456')]);
    expect(results.map(row => row[0])).toEqual([1, 0]);
    expect((await save(entries, id, undefined, 'other'))[0]).toBe(1);
  });
});
