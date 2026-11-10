import { expect, it, vi } from 'vitest';
import type { TickTickApi } from './_ticktickTrips';
import { readTickTickLocationTags } from './_ticktickLocationTags';

const api = (value: unknown) => ({ listTags: vi.fn(async () => value) }) as unknown as TickTickApi;

it('读取地点的全部后代，仅返回规范 name，排除父标签与其他目录', async () => {
  const tags = [
    { name: '北京', label: '北京', parent: '地点' },
    { name: '地点', label: '地点', parent: '' },
    { name: '居', parent: '地点' },
    { name: '广州', parent: '地点' },
    { name: '寄', parent: '地点' },
    { name: '旅', parent: '地点' },
    { name: 'worksite', label: '北京', parent: '居' },
    { name: 'desk', parent: 'worksite' },
    { name: 'routine', parent: '' },
  ];
  const source = structuredClone(tags), client = api(tags);
  expect(await readTickTickLocationTags(client)).toEqual(['北京', '居', '广州', '寄', '旅', 'worksite', 'desk']);
  expect(tags).toEqual(source);
  expect(client.listTags).toHaveBeenCalledOnce();
});

it('label 仅用于识别地点根，子标签名称按 NFKC、空白与大小写规范化', async () => {
  expect(await readTickTickLocationTags(api([
    { name: ' PLACES ', label: ' 地点 ', parent: null },
    { name: 'ＢＥＩＪＩＮＧ', label: '北京', parent: 'places' },
  ]))).toEqual(['beijing']);
});

it('缺少地点根或目录为空返回空数组，区别于不支持标签的旧适配器', async () => {
  expect(await readTickTickLocationTags(api([]))).toEqual([]);
  expect(await readTickTickLocationTags(api([{ name: 'routine' }, { name: '北京', parent: 'routine' }]))).toEqual([]);
  expect(await readTickTickLocationTags({} as TickTickApi)).toBeUndefined();
});

it.each([
  null, {}, { result: [] }, [null], [1], [[]], [{}], [{ name: '' }], [{ name: '  ' }],
  [{ name: '地点', parent: 1 }], [{ name: '地点', label: {} }],
  [{ name: '地点' }, { name: '北京', parent: 'missing' }],
  [{ name: '地点' }, { name: '北京', parent: '地点' }, { name: ' 北京 ', parent: '地点' }],
  [{ name: '地点' }, { name: 'places', label: '地点' }],
  [{ name: '地点', parent: '地点' }],
  [{ name: '地点' }, { name: 'a', parent: 'b' }, { name: 'b', parent: 'a' }],
])('目录无效、存在歧义或父关系不完整时拒绝：%j', async value => {
  await expect(readTickTickLocationTags(api(value))).rejects.toThrow('地点标签读取失败');
});

it('读取失败不被当成空目录，异常不泄露上游信息', async () => {
  const client = { listTags: vi.fn(async () => { throw new Error('PRIVATE token or provider response'); }) } as unknown as TickTickApi;
  await expect(readTickTickLocationTags(client)).rejects.toEqual(new Error('地点标签读取失败'));
});

it('通过实例调用，保留读取方法所需的 this', async () => {
  const client = { value: [{ name: '地点' }, { name: '居', parent: '地点' }],
    async listTags() { return this.value; } };
  expect(await readTickTickLocationTags(client as unknown as TickTickApi)).toEqual(['居']);
});

it('多层目录使用迭代遍历，不依赖递归调用栈', async () => {
  const tags = [{ name: '地点', parent: '' }, ...Array.from({ length: 3000 }, (_, index) =>
    ({ name: `tag-${index}`, parent: index ? `tag-${index - 1}` : '地点' }))];
  const result = await readTickTickLocationTags(api(tags));
  expect(result).toHaveLength(3000);
  expect(result?.at(-1)).toBe('tag-2999');
});
