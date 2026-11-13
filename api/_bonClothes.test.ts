import { kv as rawKv } from '@vercel/kv';
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { READ_PHOTO, READ_WEAR_PAGE } from './_clothesReads';
import { COMPRESS_PHOTO, READ_PHOTO_SIZES, MIGRATE_PHOTO } from './_clothesPhotoStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from './_bonClothesRoute';
import dispatcher from './outlook-calendar';
import { ITEMS_KEY, CONTEXTS_KEY, WEAR_KEY, SAVE_CLOTHES, readClothesCalendar, readWeather, receiptKey, photoKey } from './_bonClothes';
import { photoInput } from './_clothesValidation';
import { readClothesTrips, readTripForecast, TRIP_PLANS_KEY } from './_clothesTrips';
import { encryptOutlookConnection } from './_outlookCalendar';
import { OUTLOOK_CONNECTION_KEY } from './_outlookSync';
import { parseOutlookCalendar } from './_outlookCalendar';
import { emptyContext } from '../src/clothes/rules';
import { CATEGORIES, type ClothesItem } from '../src/clothes/types';

const { data, hashes, auth, origin, evalMock } = vi.hoisted(() => ({ data: new Map<string, any>(), hashes: new Map<string, Record<string, any>>(), auth: vi.fn(), origin: vi.fn(), evalMock: vi.fn() }));
vi.mock('./_auth.js', () => ({ authOk: auth, sameOrigin: origin }));
vi.mock('@vercel/kv', () => ({ kv: { get: async (key: string) => data.get(key) ?? null,
  mget: async (...keys: string[]) => keys.map(key => data.get(key) ?? null),
  mset: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) data.set(key, value); return 'OK'; },
  set: async (key: string, value: unknown) => { data.set(key, value); return 'OK'; }, hgetall: async (key: string) => hashes.get(key) ?? null,
  hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null), eval: evalMock } }));
const uid = (v: string) => v.padEnd(20, '0');
const context = { ...emptyContext('2026-10-05', 'Asia/Shanghai'), scene: '基本室内' as const, active: false };
const item: ClothesItem = { id: uid('item'), revision: uid('revision'), name: '白色上装', photoId: uid('photo'), category: '上装', color: '白', thickness: 1, active: true, status: '可穿', windproof: false, waterproof: false };
function jpeg(width = 960, height = 800) {
  const buffer = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 0, 0, 0, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
  buffer.writeUInt16BE(height, 7); buffer.writeUInt16BE(width, 9);
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}
const pngPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
function webpPhoto(width = 960, height = 800, kind = 'VP8X') {
  const chunk = (type: string, payload: Buffer) => {
    const result = Buffer.alloc(8 + payload.length + payload.length % 2);
    result.write(type); result.writeUInt32LE(payload.length, 4); payload.copy(result, 8); return result;
  };
  const vp8 = Buffer.alloc(10); Buffer.from([0x9d, 1, 0x2a]).copy(vp8, 3);
  vp8.writeUInt16LE(width, 6); vp8.writeUInt16LE(height, 8);
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((width - 1) | ((height - 1) << 14) | (1 << 28)) >>> 0, 1);
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x10;
  vp8x.writeUIntLE(width - 1, 4, 3); vp8x.writeUIntLE(height - 1, 7, 3);
  const chunks = kind === 'VP8X' ? [chunk('VP8X', vp8x), chunk('ALPH', Buffer.from([0, 255])), chunk('VP8 ', vp8)]
    : [chunk(kind, kind === 'VP8L' ? vp8l : vp8)];
  const data = Buffer.concat([Buffer.from('RIFF0000WEBP'), ...chunks]); data.writeUInt32LE(data.length - 8, 4);
  return `data:image/webp;base64,${data.toString('base64')}`;
}
async function call(method: string, query: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = {}) {
  const result = { status: 200, body: {} as any, headers: {} as Record<string, string> };
  const response = { status(code: number) { result.status = code; return this; }, setHeader(key: string, value: string) { result.headers[key] = value; }, json(value: unknown) { result.body = value; return this; }, send(value: unknown) { result.body = value; return this; }, end() { result.body = undefined; return this; } };
  await handler({ method, query, body, headers } as VercelRequest, response as unknown as VercelResponse);
  return result;
}
beforeEach(() => {
  for (const key of ['CLOTHES_R2_ENDPOINT', 'CLOTHES_R2_BUCKET', 'CLOTHES_R2_ACCESS_KEY_ID', 'CLOTHES_R2_SECRET_ACCESS_KEY']) vi.stubEnv(key, '');
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  vi.mocked(rawKv.hget).mockClear();
  data.clear(); hashes.clear(); auth.mockResolvedValue(true); origin.mockReturnValue(true); evalMock.mockReset();
  evalMock.mockImplementation(async (_script, keys: string[], args: string[]) => {
    if (keys.length === 1 && keys[0] === 'outlook:calendar-write:lock') { data.delete(keys[0]); return 1; }
    if (_script === READ_PHOTO) {
      const photo = data.get(keys[0]);
      if (!photo) return ['', ''];
      const etag = `"photo-v2-${createHash('sha1').update(photo).digest('hex')}"`;
      return [etag.slice(1, -1), JSON.parse(args[0]).some((tag: string) => tag === etag || tag === '*') ? '' : photo];
    }
    if (_script === READ_WEAR_PAGE) {
      const records = Object.values(hashes.get(keys[0]) ?? {}).filter((record) => args[1] === 'day'
        ? record.date === args[0] : record.kind !== 'styled' && record.date <= args[0]);
      const dates = [...new Set(records.map((record) => record.date))].sort().reverse().slice(0, 30);
      return records.filter((record) => dates.includes(record.date)).map((record) => JSON.stringify(record));
    }
    const hash = hashes.get(keys[0]) ?? {}, current = hash[args[0]];
    if ((current?.revision ?? '') !== args[1]) return [0, current ? JSON.stringify(current) : ''];
    const value = JSON.parse(args[3]); hash[args[0]] = value; hashes.set(keys[0], hash);
    data.set(keys[1], { signature: args[6], value });
    return [1, args[3]];
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('衣柜与实际穿搭接口', () => {
  it('R2 转存验证成功后才替换引用；失败保留旧照片；缓存命中不读取 R2', async () => {
    vi.stubEnv('CLOTHES_R2_ENDPOINT', `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
    vi.stubEnv('CLOTHES_R2_BUCKET', 'fixture-photos');
    vi.stubEnv('CLOTHES_R2_ACCESS_KEY_ID', 'offline-fixture');
    vi.stubEnv('CLOTHES_R2_SECRET_ACCESS_KEY', 'offline-fixture');
    const bytes = Buffer.from(pngPhoto.split(',')[1], 'base64');
    const token = `photo-v2-${createHash('sha1').update(pngPhoto).digest('hex')}`;
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any) => command instanceof PutObjectCommand ? {} : {
      ContentType: 'image/png', ContentLength: bytes.length, Body: { transformToByteArray: async () => bytes },
    });
    const migrate = { action: 'migrate-photo', id: item.photoId };
    evalMock.mockResolvedValueOnce([token, pngPhoto]).mockImplementationOnce(async (script, _keys, args) => {
      expect(script).toBe(MIGRATE_PHOTO);
      expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([PutObjectCommand, GetObjectCommand]);
      expect(JSON.parse(args[1])).toMatchObject({ storage: 'r2', validator: token });
      return [1, 12345];
    });
    expect((await call('POST', {}, migrate)).body).toEqual({ migrated: true, savedBytes: 12345 });
    const reference = JSON.parse(evalMock.mock.calls.at(-1)![2][1]);
    evalMock.mockClear(); send.mockClear();
    evalMock.mockResolvedValueOnce([token, reference]);
    expect((await call('POST', {}, migrate)).body).toEqual({ migrated: false, savedBytes: 0 });
    expect(send).not.toHaveBeenCalled();
    evalMock.mockResolvedValueOnce([token, '']);
    expect((await call('GET', { view: 'photo', id: item.photoId }, undefined, { 'if-none-match': `"${token}"` })).status).toBe(304);
    expect(send).not.toHaveBeenCalled();
    evalMock.mockResolvedValueOnce([token, reference]);
    expect((await call('GET', { view: 'photo', id: item.photoId })).body).toEqual(bytes);
    expect(send).toHaveBeenCalledTimes(1);
    evalMock.mockClear(); send.mockRejectedValueOnce(new Error('R2 unavailable'));
    evalMock.mockResolvedValueOnce([token, pngPhoto]);
    expect((await call('POST', {}, migrate)).status).toBe(503);
    expect(evalMock).toHaveBeenCalledTimes(1);
    auth.mockResolvedValue(false); send.mockClear();
    expect((await call('POST', {}, migrate)).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it('旧照片压缩只传递账号内照片大小，读取与写入继续鉴权', async () => {
    evalMock.mockResolvedValueOnce([[item.photoId, 90000]]);
    const sizes = await call('GET', { view: 'photo-sizes' });
    expect(sizes.body).toEqual({ photos: [{ id: item.photoId, bytes: 90000 }] });
    expect(evalMock).toHaveBeenLastCalledWith(READ_PHOTO_SIZES, [ITEMS_KEY, WEAR_KEY, photoKey('')], [expect.any(String)]);
    expect(sizes.headers['Cache-Control']).toContain('no-store');
    auth.mockResolvedValue(false); evalMock.mockClear();
    expect((await call('GET', { view: 'photo-sizes' })).status).toBe(401);
    expect((await call('POST', {}, { action: 'compress-photo' })).status).toBe(401);
    expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(0);
  });
  it('压缩保持照片引用并校验来源版本、图片格式与 40KB 上限', async () => {
    const body = { action: 'compress-photo', id: item.photoId, validator: `photo-v2-${'a'.repeat(40)}`, photo: pngPhoto };
    evalMock.mockResolvedValueOnce([1, 12345]);
    expect((await call('POST', {}, body)).body).toEqual({ savedBytes: 12345 });
    expect(evalMock).toHaveBeenLastCalledWith(COMPRESS_PHOTO, [photoKey(item.photoId)], [body.validator, pngPhoto]);
    evalMock.mockResolvedValueOnce([0, 0]);
    expect((await call('POST', {}, body)).body).toEqual({ savedBytes: 0 });
    evalMock.mockResolvedValueOnce([-2, 0]);
    expect((await call('POST', {}, body)).status).toBe(409);
    evalMock.mockResolvedValueOnce([-1, 0]);
    expect((await call('POST', {}, body)).status).toBe(404);
    expect((await call('POST', {}, { ...body, validator: 'invalid' })).status).toBe(400);
    expect((await call('POST', {}, { ...body, photo: 'data:image/png;base64,bm90IGFuIGltYWdl' })).status).toBe(400);
    const largeJpeg = Buffer.from(jpeg(480, 400).split(',')[1], 'base64');
    const padded = Buffer.concat([largeJpeg.subarray(0, -2), Buffer.from([0xff, 0xda]), Buffer.alloc(41 * 1024), largeJpeg.subarray(-2)]);
    expect((await call('POST', {}, { ...body, photo: `data:image/jpeg;base64,${padded.toString('base64')}` })).body.error).toBe('压缩后照片不能超过 40KB');
  });
  it('成功照片使用浏览器私有长期缓存，条件请求仍先鉴权，缺失照片不缓存', async () => {
    data.set(photoKey(item.photoId), jpeg());
    const query = { view: 'photo', id: item.photoId };
    const first = await call('GET', query);
    expect(first.headers['Cache-Control']).toBe('private, max-age=2592000, immutable');
    expect(first.headers['Vary']).toContain('Cookie');
    expect(first.headers['Vary']).toContain('Authorization');
    const headers = { 'if-none-match': `W/${first.headers.ETag}` };
    const cached = await call('GET', query, undefined, headers);
    expect(cached.status).toBe(304); expect(cached.body).toBeUndefined();
    const reads = evalMock.mock.calls.length;
    auth.mockResolvedValue(false);
    const denied = await call('GET', query, undefined, headers);
    expect(evalMock).toHaveBeenCalledTimes(reads);
    expect(denied.status).toBe(401); expect(denied.headers['Cache-Control']).toContain('no-store');
    auth.mockResolvedValue(true); data.delete(photoKey(item.photoId));
    const missing = await call('GET', query, undefined, headers);
    expect(missing.status).toBe(404); expect(missing.headers['Cache-Control']).toContain('no-store');
  });
  it('衣柜数据仅短时私有缓存，保存响应不缓存', async () => {
    const read = await call('GET', { date: context.date });
    expect(read.headers['Cache-Control']).toBe('private, max-age=30, must-revalidate');
    expect(read.headers['Vary']).toContain('X-BonBills-Cache');
    const saved = await call('POST', {}, { action: 'save-context', context, mutationId: uid('cache-save') });
    expect(saved.status).toBe(200); expect(saved.headers['Cache-Control']).toContain('no-store');
  });
  it('生产使用现有 Outlook 函数分派到独立衣柜接口', async () => {
    let payload: any;
    const response = { status() { return this; }, setHeader() {}, json(value: unknown) { payload = value; return this; } };
    await dispatcher({ method: 'GET', headers: {}, query: { app: 'bonclothes', date: context.date } } as unknown as VercelRequest, response as unknown as VercelResponse);
    expect(payload).toEqual({ calendarLocation: { locations: [], travel: false, scene: undefined, active: undefined }, photoStorage: 'redis', items: [], context: null, records: [], outfits: [], wearCounts: {}, pairCounts: {} });
  });
  it('未登录和跨站请求不可读照片或修改，方法受限', async () => {
    auth.mockResolvedValue(false); expect((await call('GET', { view: 'photo', id: item.photoId })).status).toBe(401);
    auth.mockResolvedValue(true); origin.mockReturnValue(false); expect((await call('POST', {}, {})).status).toBe(403);
    origin.mockReturnValue(true); expect((await call('PUT')).status).toBe(405);
    expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(0);
  });
  it('照片校验类型、字节数和真实尺寸', () => {
    expect(photoInput(jpeg())).toBe(jpeg());
    expect(() => photoInput('data:image/svg+xml;base64,PHN2Zz4=')).toThrow();
    expect(() => photoInput(jpeg(961))).toThrow('960');
    expect(() => photoInput(`data:image/jpeg;base64,${Buffer.alloc(205000).toString('base64')}`)).toThrow();
    expect(() => photoInput('data:image/jpeg;base64,YWJjZA==')).toThrow();
  });
  it('透明 PNG、WebP 和旧 JPEG 按实际格式保存并鉴权读取', async () => {
    for (const photo of [pngPhoto, webpPhoto(), webpPhoto(800, 960, 'VP8L'), webpPhoto(800, 960, 'VP8 '), jpeg()]) {
      expect(photoInput(photo)).toBe(photo);
      data.set(photoKey(item.photoId), photo);
      const result = await call('GET', { view: 'photo', id: item.photoId });
      expect(result.status).toBe(200);
      expect(result.headers['Content-Type']).toBe(photo.slice(5, photo.indexOf(';')));
      expect(result.body).toEqual(Buffer.from(photo.slice(photo.indexOf(',') + 1), 'base64'));
    }
    const saved = await call('POST', {}, { action: 'save-item', item: { ...item, revision: '' }, photo: pngPhoto, mutationId: uid('transparent') });
    expect(saved.status).toBe(200); expect(saved.body.value.photoId).toBe(uid('transparent'));
    expect(evalMock.mock.calls.find(([script]) => script === SAVE_CLOTHES)?.[2][4]).toBe(pngPhoto);
  });
  it('拒绝伪造 MIME、超尺寸、截断及动画容器', () => {
    expect(() => photoInput(pngPhoto.replace('image/png', 'image/jpeg'))).toThrow();
    expect(() => photoInput(webpPhoto().replace('image/webp', 'image/png'))).toThrow();
    for (const kind of ['VP8X', 'VP8L', 'VP8 ']) expect(() => photoInput(webpPhoto(961, 800, kind))).toThrow('960');
    const png = Buffer.from(pngPhoto.split(',')[1], 'base64'); png.writeUInt32BE(961, 16);
    expect(() => photoInput(`data:image/png;base64,${png.toString('base64')}`)).toThrow('960');
    const webp = Buffer.from(webpPhoto().split(',')[1], 'base64');
    webp[20] |= 2;
    expect(() => photoInput(`data:image/webp;base64,${webp.toString('base64')}`)).toThrow();
    for (const photo of [pngPhoto, webpPhoto()]) {
      const [header, encoded] = photo.split(',');
      const data = Buffer.from(encoded, 'base64').subarray(0, -3);
      expect(() => photoInput(`${header},${data.toString('base64')}`)).toThrow();
      expect(() => photoInput(`${header},${Buffer.alloc(205000).toString('base64')}`)).toThrow('200KB');
    }
  });
  it('保存逐项使用 CAS 和同一事务照片，不触碰财务键', async () => {
    const result = await call('POST', {}, { action: 'save-item', item: { ...item, revision: '', name: '' }, photo: jpeg(), mutationId: uid('mutation') });
    expect(result.status).toBe(200); expect(result.body.value.name).toBe('白色上衣');
    expect(evalMock.mock.calls[0][0]).toBe(SAVE_CLOTHES);
    expect(evalMock.mock.calls[0][1].every((key: string) => !key || key.startsWith('bonclothes:'))).toBe(true);
    expect(evalMock.mock.calls[0][2][4]).toBe(jpeg());
  });
  it('各层分类可保存，文胸选项校验并兼容旧上装', async () => {
    for (const category of CATEGORIES) {
      const result = await call('POST', {}, { action: 'save-item', item: { ...item, id: uid(`layer${CATEGORIES.indexOf(category)}`), category, revision: '', braRequirement: 'optional' }, photo: jpeg(), mutationId: uid(`save${CATEGORIES.indexOf(category)}`) });
      expect(result.status).toBe(200);
      expect(result.body.value.category).toBe(category);
      expect(result.body.value.braRequirement).toBe(['上衣', '连衣裙'].includes(category) ? 'optional' : undefined);
    }
    const legacy = await call('POST', {}, { action: 'save-item', item: { ...item, revision: '' }, photo: jpeg(), mutationId: uid('legacy') });
    expect(legacy.body.value).toMatchObject({ category: '上衣', name: item.name, braRequirement: 'required' });
    const invalid = await call('POST', {}, { action: 'save-item', item: { ...item, braRequirement: 'wrong' }, mutationId: uid('invalid') });
    expect(invalid.status).toBe(400);
  });
  it('多用途衣物保存穿着位置，换穿法不改衣柜或历史保暖值', async () => {
    const dual = { ...item, category: '上衣', wearAs: ['上衣', '外套'] };
    hashes.set(ITEMS_KEY, { [item.id]: dual });
    const body = { action: 'confirm', recordId: uid('dual-outfit'), context, revision: '', mutationId: uid('dual-save'),
      items: [{ id: item.id, revision: item.revision, category: '外套' }], weather: null, purpose: '休闲', time: '10:00', indoor: null, outdoor: null };
    const saved = await call('POST', {}, body);
    expect(saved.status).toBe(200);
    expect(saved.body.value.items[0]).toMatchObject({ category: '外套', wearAs: ['上衣', '外套'], warmth: 1 });
    expect(hashes.get(ITEMS_KEY)![item.id].category).toBe('上衣');
    hashes.set(ITEMS_KEY, {});
    const edited = await call('POST', {}, { ...body, revision: saved.body.value.revision, mutationId: uid('dual-edit'), items: [{ ...body.items[0], category: '上衣' }] });
    expect(edited.status).toBe(200);
    expect(edited.body.value.items[0]).toMatchObject({ category: '上衣', warmth: 1 });
    const invalid = await call('POST', {}, { ...body, revision: edited.body.value.revision, mutationId: uid('dual-invalid'), items: [{ ...body.items[0], category: '下装' }] });
    expect(invalid.status).toBe(400);
    expect((await call('POST', {}, { action: 'save-item', item: { ...dual, revision: '', wearAs: ['下装'] }, photo: jpeg(), mutationId: uid('bad-roles') })).status).toBe(400);
  });
  it('常搭统计包含分页外历史与搭了的套装，编辑后不会留下旧配对', async () => {
    const pants = { ...item, id: uid('pants'), category: '下装' };
    hashes.set(ITEMS_KEY, { [item.id]: item, [pants.id]: pants });
    hashes.set(WEAR_KEY, { old: { id: 'old', kind: 'worn', date: '2025-01-01', confirmedAt: '', items: [item, pants] } });
    const body = { action: 'confirm', kind: 'styled', recordId: uid('pair-set'), context, revision: '', mutationId: uid('pair-save'),
      items: [item, pants].map(({ id, revision }) => ({ id, revision })), weather: null, purpose: '休闲', time: '10:00' };
    const saved = await call('POST', {}, body);
    expect(saved.status).toBe(200);
    expect((await call('GET', { date: context.date })).body.pairCounts[item.id][pants.id]).toBe(2);
    await call('POST', {}, { ...body, items: [body.items[0]], revision: saved.body.value.revision, mutationId: uid('pair-edit') });
    expect((await call('GET', { date: context.date })).body.pairCounts[item.id][pants.id]).toBe(1);
  });
  it('出行计划按选定穿法校验并保存多用途衣物，不重复占用同一位置', async () => {
    const top = { ...item, id: uid('another-top') }, dual = { ...item, wearAs: ['上衣', '外套'] };
    hashes.set(ITEMS_KEY, { [top.id]: top, [item.id]: dual });
    const plan = { tripId: 'trip:2026-10-05', revision: '', title: '出游', startDate: context.date, endDate: context.date, location: null,
      days: { [context.date]: { scene: context.scene, active: false, itemIds: [top.id, item.id], itemCategories: { [item.id]: '外套' } } } };
    const saved = await call('POST', {}, { action: 'save-trip-plan', plan, mutationId: uid('dual-plan') });
    expect(saved.status).toBe(200);
    expect(saved.body.value.days[context.date].itemCategories[item.id]).toBe('外套');
    plan.days[context.date].itemCategories[item.id] = '下装';
    expect((await call('POST', {}, { action: 'save-trip-plan', plan, mutationId: uid('invalid-dual-plan') })).status).toBe(400);
  });
  it('七件分层搭配可确认、保存计划，历史保留文胸要求快照', async () => {
    const layers = CATEGORIES.filter((category) => category !== '连衣裙').map((category, i) => ({ ...item, id: uid(`layer${i}`), category, braRequirement: 'optional' as const }));
    hashes.set(ITEMS_KEY, Object.fromEntries(layers.map((piece) => [piece.id, piece])));
    const body = { action: 'confirm', context, items: layers.map(({ id, revision }) => ({ id, revision })), revision: '', weather: null, mutationId: uid('layers-confirm') };
    const first = await call('POST', {}, body); expect(first.status).toBe(200); expect(first.body.value.items).toHaveLength(7);
    expect(rawKv.hget).toHaveBeenCalledTimes(1); // previous record only: no seven duplicate item reads
    expect(rawKv.hget).toHaveBeenCalledWith(WEAR_KEY, context.date);
    expect((await call('POST', {}, body)).body).toEqual(first.body);
    const plan = { tripId: 'trip:2026-10-05', revision: '', title: '出游', startDate: context.date, endDate: context.date, location: null,
      days: { [context.date]: { scene: context.scene, active: false, itemIds: layers.map((piece) => piece.id) } } };
    expect((await call('POST', {}, { action: 'save-trip-plan', plan, mutationId: uid('layers-plan') })).status).toBe(200);
    hashes.set(ITEMS_KEY, {});
    const history = await call('GET', { view: 'history', date: context.date });
    expect(history.body.records[0].items).toEqual(layers);
  });
  it('旧上装与新上衣不能重复穿，内衣可与连衣裙叠穿', async () => {
    const inner = { ...item, id: uid('inner'), category: '内衣' };
    const top = { ...item, id: uid('top'), category: '上衣' };
    const dress = { ...item, id: uid('dress'), category: '连衣裙' };
    hashes.set(ITEMS_KEY, { [item.id]: item, [inner.id]: inner, [top.id]: top, [dress.id]: dress });
    const confirm = (selected: typeof inner[], mutation: string) => call('POST', {}, { action: 'confirm', context, items: selected.map(({ id, revision }) => ({ id, revision })), revision: '', weather: null, mutationId: uid(mutation) });
    expect((await confirm([item, top], 'duplicate')).status).toBe(400);
    expect((await confirm([top, dress], 'dress-top')).status).toBe(400);
    expect((await confirm([inner, dress], 'inner-dress')).status).toBe(200);
  });
  it('并发旧版本返回最新记录；客户端内容不作为成功保存', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: { ...item, revision: uid('newer') } });
    const result = await call('POST', {}, { action: 'save-item', item, mutationId: uid('mutation') });
    expect(result.status).toBe(409); expect(result.body.current.revision).toBe(uid('newer'));
  });
  it('重复请求返回第一次结果，旧请求不会在新版本后重新覆盖', async () => {
    const body = { action: 'save-context', context, mutationId: uid('mutation') };
    const first = await call('POST', {}, body); hashes.get(CONTEXTS_KEY)![context.date].scene = '有室外';
    const repeat = await call('POST', {}, body);
    expect(repeat.status).toBe(200); expect(repeat.body.value.revision).toBe(first.body.value.revision); expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(1);
    expect((await call('POST', {}, { ...body, context: { ...context, active: true } })).status).toBe(400);
    expect(data.has(receiptKey(uid('mutation')))).toBe(true);
  });
  it('确认保存服务端衣物快照，同日替换，删除衣物后历史可读且不自动待洗', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: item });
    const body = { action: 'confirm', context, items: [{ id: item.id, revision: item.revision }], revision: '', weather: null, mutationId: uid('confirm1') };
    const first = await call('POST', {}, body); expect(first.status).toBe(200);
    expect(hashes.get(ITEMS_KEY)![item.id].status).toBe('可穿');
    expect(evalMock.mock.calls[0][2][5]).toBe(JSON.stringify(body.items));
    expect((await call('POST', {}, { ...body, revision: uid('confirm1'), mutationId: uid('confirm2') })).status).toBe(200);
    hashes.set(ITEMS_KEY, {});
    const history = await call('GET', { view: 'history', date: context.date });
    expect(history.body.records).toHaveLength(1); expect(history.body.records[0].items[0].name).toBe('白色上装');
    expect(Object.keys(hashes.get(WEAR_KEY)!)).toEqual([context.date]);
  });
  it('丢弃与放回保留原照片和历史，重复提交幂等，旧版本不能覆盖丢弃状态', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: item });
    data.set(photoKey(item.photoId), jpeg());
    const record = { action: 'confirm', recordId: uid('before-discard'), context, items: [item], revision: '',
      weather: null, purpose: '休闲', time: '10:00', indoor: null, outdoor: null, mutationId: uid('record-discard') };
    const worn = await call('POST', {}, record);
    expect(worn.status).toBe(200);
    const request = { action: 'save-item', item: { ...item, status: '已丢弃' }, mutationId: uid('discard') };
    const discarded = await call('POST', {}, request);
    expect(discarded.status).toBe(200);
    expect(discarded.body.value).toMatchObject({ id: item.id, status: '已丢弃', photoId: item.photoId });
    expect((await call('POST', {}, request)).body).toEqual(discarded.body);
    expect((await call('POST', {}, { action: 'save-item', item, mutationId: uid('stale-restore') })).status).toBe(409);
    const dataResult = await call('GET', { date: context.date });
    expect(dataResult.body.items[0]).toMatchObject({ status: '已丢弃', photoId: item.photoId });
    expect(dataResult.body.records[0].items[0]).toEqual(worn.body.value.items[0]);
    // Feedback on an old outfit remains editable after its item is discarded.
    expect((await call('POST', {}, { ...record, revision: worn.body.value.revision, indoor: '舒适', mutationId: uid('edit-discarded') })).status).toBe(200);
    const restored = await call('POST', {}, { action: 'save-item', item: { ...discarded.body.value, status: '可穿' }, mutationId: uid('restore') });
    expect(restored.body.value).toMatchObject({ id: item.id, status: '可穿', photoId: item.photoId });
    const writes = evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES);
    expect(writes.every(([, , args]) => args[4] === '')).toBe(true);
    expect(data.get(photoKey(item.photoId))).toBe(jpeg());
  });
  it.each(['收起', '已丢弃'])('确认时衣物变为%s或事务中更新都拒绝保存', async (status) => {
    hashes.set(ITEMS_KEY, { [item.id]: { ...item, status } });
    const body = { action: 'confirm', context, items: [{ id: item.id, revision: item.revision }], revision: '', weather: null, mutationId: uid('confirm') };
    expect((await call('POST', {}, body)).status).toBe(409); expect(evalMock).not.toHaveBeenCalled();
    hashes.set(ITEMS_KEY, { [item.id]: item }); evalMock.mockResolvedValueOnce([-2, '']);
    expect((await call('POST', {}, body)).body.wardrobeChanged).toBe(true);
  });
  it('新记录同一天保留多套，用途和体感可独立修改，重试不会重复新增', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: item });
    const body = { action: 'confirm', recordId: uid('wear-one'), context: { ...context, scene: null, active: null },
      items: [{ id: item.id, revision: item.revision }], revision: '', weather: null, mutationId: uid('wear-save-one'),
      purpose: '休闲', indoor: '偏冷', outdoor: '舒适', time: '09:00' };
    const first = await call('POST', {}, body);
    expect(first.status).toBe(200);
    expect((await call('POST', {}, body)).body).toEqual(first.body);
    const second = await call('POST', {}, { ...body, recordId: uid('wear-two'), mutationId: uid('wear-save-two'), purpose: '运动', time: '18:00' });
    expect(second.status).toBe(200);
    const changed = await call('POST', {}, { ...body, revision: first.body.value.revision, mutationId: uid('wear-edit'), indoor: '舒适', outdoor: '偏热' });
    expect(changed.status).toBe(200);
    const history = await call('GET', { view: 'history', date: context.date });
    expect(history.body.records).toHaveLength(2);
    expect(history.body.records.find((record: any) => record.id === body.recordId)).toMatchObject({ indoor: '舒适', outdoor: '偏热', purpose: '休闲' });
    expect((await call('POST', {}, { ...body, mutationId: uid('wear-stale') })).status).toBe(409);
  });
  it('旧日期记录能补体感；衣物已删除仍保留原穿搭快照', async () => {
    hashes.set(WEAR_KEY, { [context.date]: { date: context.date, revision: uid('legacy'), items: [item], context, weather: null, confirmedAt: '2026-10-05T00:00:00Z' } });
    const body = { action: 'confirm', recordId: context.date, context, revision: uid('legacy'), mutationId: uid('legacy-edit'),
      items: [{ id: item.id, revision: item.revision }], weather: null, purpose: '见重要的人', time: '10:00', indoor: null, outdoor: '偏冷' };
    expect((await call('POST', {}, body)).status).toBe(200);
    expect(Object.keys(hashes.get(WEAR_KEY)!)).toEqual([context.date]);
    expect(evalMock.mock.calls[0][2][5]).toBe('[]');
    expect(hashes.get(WEAR_KEY)![context.date].items).toEqual([item]);
    expect(hashes.get(WEAR_KEY)![context.date].indoorCoat).toBeUndefined();
  });
  it('每套单独保存室内外套状态，编辑回填与旧客户端更新均保留明确选择', async () => {
    const coat = { ...item, id: uid('coat'), category: '外套' as const, warmth: 4 };
    hashes.set(ITEMS_KEY, { [item.id]: item, [coat.id]: coat });
    const body = { action: 'confirm', recordId: uid('coat-wear-one'), context, revision: '', mutationId: uid('coat-save-one'),
      items: [item, coat].map(({ id, revision }) => ({ id, revision })), weather: null, purpose: '休闲', time: '10:00', indoor: '舒适', outdoor: '偏冷' };
    const first = await call('POST', {}, { ...body, indoorCoat: false });
    expect(first.status).toBe(200);
    expect(first.body.value).toMatchObject({ indoorCoat: false, indoor: '舒适', outdoor: '偏冷', items: [item, coat] });
    expect((await call('POST', {}, { ...body, indoorCoat: false })).body).toEqual(first.body);
    await call('POST', {}, { ...body, recordId: uid('coat-wear-two'), mutationId: uid('coat-save-two'), indoorCoat: false });
    const changed = await call('POST', {}, { ...body, revision: first.body.value.revision, mutationId: uid('coat-edit'), indoorCoat: true });
    expect(changed.body.value.indoorCoat).toBe(true);
    const legacy = await call('POST', {}, { ...body, revision: changed.body.value.revision, mutationId: uid('coat-old-client') });
    expect(legacy.body.value.indoorCoat).toBe(true);
    const history = await call('GET', { view: 'history', date: context.date });
    expect(history.body.records.find((record: any) => record.id === uid('coat-wear-one')).indoorCoat).toBe(true);
    expect(history.body.records.find((record: any) => record.id === uid('coat-wear-two')).indoorCoat).toBe(false);
  });
  it('用途必须选择，体感及时间必须有效，不接受非法保暖值', async () => {
    const body = { action: 'confirm', recordId: uid('wear'), context, revision: '', mutationId: uid('wear-save'),
      items: [{ id: item.id, revision: item.revision }], weather: null, purpose: '休闲', time: '10:00', indoor: null, outdoor: null };
    for (const patch of [{ kind: 'unknown' }, { kind: null }, { purpose: undefined }, { purpose: '' }, { indoor: '错误' }, { outdoor: 26 }, { time: '24:00' }, { indoorCoat: 'false' }, { indoorCoat: null }, { indoorCoat: 1 }]) {
      expect((await call('POST', {}, { ...body, ...patch })).status).toBe(400);
    }
    for (const warmth of [-1, 41, '3']) expect((await call('POST', {}, { action: 'save-item', item: { ...item, warmth }, mutationId: uid('invalid-warmth') })).status).toBe(400);
    expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(0);
  });
  it('待洗旧数据按可穿读取及保存，保暖值可以为零或小数', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: { ...item, status: '待洗' } });
    expect((await call('GET', { date: context.date })).body.items[0].status).toBe('可穿');
    const result = await call('POST', {}, { action: 'save-item', item: { ...item, status: '待洗', warmth: .5 }, mutationId: uid('warmth-save') });
    expect(result.status).toBe(200);
    expect(result.body.value).toMatchObject({ warmth: .5, status: '可穿' });
  });
  it('历史按整天分页，同一天多于30套也不会漏掉', async () => {
    hashes.set(WEAR_KEY, Object.fromEntries(Array.from({ length: 35 }, (_, i) => [uid(`wear-${i}-`), { id: uid(`wear-${i}-`), date: context.date, confirmedAt: '2026-10-05T00:00:00Z', items: [item] }])));
    expect((await call('GET', { view: 'history', date: context.date })).body.records).toHaveLength(35);
  });
  it('搭了按套独立保存、重试幂等，穿这套新增记录而保留原搭配', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: item });
    const body = { action: 'confirm', recordId: uid('styled-one'), kind: 'styled', context, revision: '', mutationId: uid('styled-save'),
      items: [{ id: item.id, revision: item.revision }], weather: null, purpose: '见朋友', time: '10:00', indoor: '偏冷', outdoor: '舒适' };
    const first = await call('POST', {}, body);
    expect(first.status).toBe(200);
    expect(first.body.value).toMatchObject({ kind: 'styled', indoor: null, outdoor: null, items: [item] });
    expect((await call('POST', {}, body)).body).toEqual(first.body);
    expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(1);
    const worn = await call('POST', {}, { ...body, kind: undefined, recordId: uid('actually-worn'), mutationId: uid('actually-worn-save') });
    expect(worn.body.value.kind).toBe('worn');
    const loaded = await call('GET', { date: context.date });
    expect(loaded.body.outfits).toEqual([first.body.value]);
    expect(loaded.body.records).toEqual([worn.body.value]);
    expect(loaded.body.wearCounts).toEqual({ [item.id]: 1 });
    expect((await call('GET', { view: 'history', date: context.date })).body.records).toEqual([worn.body.value]);
  });
  it('保存的搭配不受穿着历史分页限制，衣物删除仍保留整套快照', async () => {
    hashes.set(WEAR_KEY, Object.fromEntries(Array.from({ length: 35 }, (_, i) => {
      const date = new Date(Date.parse('2026-10-05') - i * 86400000).toISOString().slice(0, 10);
      return [uid(`wear-${i}-`), { id: uid(`wear-${i}-`), date, confirmedAt: `${date}T00:00:00Z`, items: [item] }];
    })));
    hashes.get(WEAR_KEY)![uid('old-styled')] = { id: uid('old-styled'), kind: 'styled', date: '2025-01-01', confirmedAt: '2025-01-01T00:00:00Z', items: [item] };
    const result = await call('GET', { date: context.date });
    expect(result.body.records).toHaveLength(30);
    expect(result.body.outfits).toMatchObject([{ id: uid('old-styled'), items: [item] }]);
    expect(result.body.items).toEqual([]);
    expect(result.body.wearCounts).toEqual({ [item.id]: 35 });
  });
  it('编辑可切换穿了和搭了，旧客户端编辑保留搭配状态并检查并发冲突', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: item });
    const body = { action: 'confirm', recordId: uid('switch-kind'), context, revision: '', mutationId: uid('switch-worn'),
      items: [{ id: item.id, revision: item.revision }], weather: null, purpose: '休闲', time: '10:00', indoor: null, outdoor: null };
    const first = await call('POST', {}, body);
    const styled = await call('POST', {}, { ...body, revision: first.body.value.revision, kind: 'styled', mutationId: uid('switch-styled') });
    expect(styled.body.value.kind).toBe('styled');
    const legacyEdit = await call('POST', {}, { ...body, revision: styled.body.value.revision, mutationId: uid('styled-old-client') });
    expect(legacyEdit.body.value.kind).toBe('styled');
    expect((await call('GET', { date: context.date })).body.records).toEqual([]);
    expect((await call('POST', {}, { ...body, revision: first.body.value.revision, kind: 'worn', mutationId: uid('stale-kind-edit') })).status).toBe(409);
    const worn = await call('POST', {}, { ...body, revision: legacyEdit.body.value.revision, kind: 'worn', mutationId: uid('back-to-worn') });
    expect(worn.status).toBe(200);
    expect((await call('GET', { date: context.date })).body.outfits).toEqual([]);
  });
  it('睡衣标签保存回读，睡觉穿搭可单独记录室内体感', async () => {
    const saved = await call('POST', {}, { action: 'save-item', item: { ...item, revision: '', sleepwear: true }, mutationId: uid('sleep-item') });
    expect(saved.status).toBe(200);
    expect((await call('GET', { date: context.date })).body.items[0].sleepwear).toBe(true);
    const record = await call('POST', {}, { action: 'confirm', recordId: uid('sleep-record'), context, revision: '', mutationId: uid('sleep-wear'),
      items: [{ id: item.id, revision: saved.body.value.revision }], weather: null, purpose: '睡觉', time: '23:00', indoor: '舒适', outdoor: null, indoorCoat: false });
    expect(record.status).toBe(200);
    expect(record.body.value).toMatchObject({ purpose: '睡觉', indoor: '舒适', outdoor: null, items: [{ sleepwear: true }] });
    expect((await call('POST', {}, { action: 'save-item', item: { ...item, sleepwear: 'true' }, mutationId: uid('invalid-sleep') })).status).toBe(400);
  });
  it('分时段体感可保存、回顾和修改，非法时段或温度不落库', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: item });
    const feelings = { 上午: { indoor: '舒适', outdoor: '偏冷', cycling: '很冷', indoorTemperature: 25, outdoorTemperature: 16 }, 晚上: { indoor: '偏热', outdoor: null, indoorTemperature: 25, outdoorTemperature: null } };
    const body = { action: 'confirm', recordId: uid('periods'), revision: '', mutationId: uid('periods-save'), context: { ...context, indoorTemperature: 25 },
      items: [item], purpose: '休闲', time: '12:00', indoor: null, outdoor: null, weather: null, feelings };
    const saved = await call('POST', {}, body); expect(saved.status).toBe(200);
    expect((await call('GET', { view: 'history', date: context.date })).body.records[0].feelings).toEqual(feelings);
    const legacyEdit = await call('POST', {}, { ...body, feelings: undefined, revision: saved.body.value.revision, mutationId: uid('periods-legacy') });
    expect(legacyEdit.body.value.feelings).toEqual(feelings);
    const invalid = await call('POST', {}, { ...body, revision: legacyEdit.body.value.revision, mutationId: uid('bad-period'), feelings: { 凌晨: feelings.上午 } });
    expect(invalid.status).toBe(400);
    expect((await call('POST', {}, { ...body, mutationId: uid('bad-temp'), feelings: { 上午: { ...feelings.上午, indoorTemperature: 200 } } })).status).toBe(400);
    expect((await call('POST', {}, { ...body, mutationId: uid('bad-cycle'), feelings: { 上午: { ...feelings.上午, cycling: '错误' } } })).status).toBe(400);
    const indoor = await call('POST', {}, { ...body, revision: legacyEdit.body.value.revision, mutationId: uid('indoor-once'), indoor: '舒适', indoorTemperature: 24 });
    expect(indoor.body.value).toMatchObject({ indoor: '舒适', indoorTemperature: 24, feelings });
    const roundtrip = await call('GET', { view: 'history', date: context.date });
    expect(roundtrip.body.records.find((r: any) => r.id === body.recordId)).toMatchObject({ indoorTemperature: 24, feelings });
    expect((await call('POST', {}, { ...body, mutationId: uid('bad-indoor'), indoorTemperature: 100 })).status).toBe(400);
  });
  it('实际体感校准衣柜和新快照，旧快照及原始估值保持可回顾', async () => {
    const shirt = { ...item, warmth: 4 };
    hashes.set(ITEMS_KEY, { [item.id]: shirt });
    hashes.set(WEAR_KEY, Object.fromEntries(['one', 'two'].map((id) => [id, { id, date: context.date, revision: uid(id), confirmedAt: '', context, items: [shirt],
      feelings: { 上午: { indoor: '舒适', outdoor: null, indoorTemperature: 25, outdoorTemperature: null } } }])));
    const loaded = await call('GET', { date: context.date });
    expect(loaded.body.items[0]).toMatchObject({ warmth: 4, learnedWarmth: 2.5 });
    expect(loaded.body.records.every((record: any) => record.items[0].warmth === 4)).toBe(true);
    const saved = await call('POST', {}, { action: 'confirm', recordId: uid('new-learned'), revision: '', mutationId: uid('learned-save'), context, items: [item], purpose: '休闲', time: '12:00', indoor: null, outdoor: null, weather: null });
    expect(saved.status).toBe(200); expect(saved.body.value.items[0].warmth).toBe(2.5);
    expect(hashes.get(ITEMS_KEY)![item.id].warmth).toBe(4);
  });
  it.each([['Asia/Shanghai', 2.5], ['America/Los_Angeles', undefined]])('跨午夜按 %s 校准衣柜与新快照', async (timezone, learnedWarmth) => {
    vi.setSystemTime(new Date('2026-10-05T17:00:00Z'));
    const localContext = { ...context, date: '2026-10-06', timezone: String(timezone) };
    const shirt = { ...item, warmth: 4 };
    hashes.set(ITEMS_KEY, { [item.id]: shirt });
    hashes.set(WEAR_KEY, Object.fromEntries(['one', 'two'].map((id) => [id, { id, date: localContext.date, revision: uid(id), confirmedAt: '', context: localContext, items: [shirt],
      feelings: { 上午: { indoor: '舒适', outdoor: null, indoorTemperature: 25, outdoorTemperature: null } } }])));
    const loaded = await call('GET', { date: localContext.date, timezone: localContext.timezone });
    expect(loaded.status).toBe(200); expect(loaded.body.items[0].learnedWarmth).toBe(learnedWarmth);
    const saved = await call('POST', {}, { action: 'confirm', recordId: uid('boundary'), revision: '', mutationId: uid('boundary-save'), context: localContext,
      items: [item], purpose: '休闲', time: '01:00', indoor: null, outdoor: null, weather: null });
    expect(saved.status).toBe(200); expect(saved.body.value.items[0].warmth).toBe(learnedWarmth ?? 4);
  });
  it('断网失败不伪造成功，重试可继续保存', async () => {
    evalMock.mockRejectedValueOnce(new Error('offline'));
    const body = { action: 'save-context', context, mutationId: uid('mutation') };
    expect((await call('POST', {}, body)).status).toBe(503);
    expect((await call('POST', {}, body)).status).toBe(200);
  });
  it('异常输入在存储之前拒绝', async () => {
    for (const body of ['{bad', { action: 'save-context', context: { ...context, date: '2026-02-30' }, mutationId: uid('mutation') },
      { action: 'save-context', context: { ...context, timezone: 'invalid' }, mutationId: uid('mutation') }]) expect((await call('POST', {}, body)).status).toBe(400);
    expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(0);
  });
  it('推荐用途可保存回读，旧条件兼容且非法用途不落库', async () => {
    const result = await call('POST', {}, { action: 'save-context', context: { ...context, purpose: '休闲' }, mutationId: uid('casual-context') });
    expect(result.status).toBe(200);
    expect((await call('GET', { date: context.date })).body.context.purpose).toBe('休闲');
    for (const purpose of ['invalid', 1, '睡觉']) {
      expect((await call('POST', {}, { action: 'save-context', context: { ...context, purpose }, mutationId: uid('bad-purpose') })).status).toBe(400);
    }
  });
});
describe('天气、Outlook 和设备时区', () => {
  it('明日天气使用当天逐日预报，不把当前实况当成明天气温', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
    const fetchMock = vi.fn(async (_url: URL) => new Response(JSON.stringify({ current: { temperature_2m: 40 }, daily: {
      time: ['2026-10-06'], temperature_2m_min: [12], temperature_2m_max: [21], apparent_temperature_min: [10], apparent_temperature_max: [20], precipitation_sum: [2], wind_speed_10m_max: [15],
    } })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await call('GET', { view: 'weather', date: '2026-10-06', timezone: 'Asia/Shanghai', latitude: '30', longitude: '120' });
    expect(result.status).toBe(200);
    expect(result.body.weather).toMatchObject({ date: '2026-10-06', temperature: 21, min: 12, max: 21, apparentMin: 10, precipitation: 2 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('forecast_days=16');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('current=');
  });
  it('明日条件和成套搭配独立保存，不覆盖今天记录', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: item });
    const nextContext = { ...context, date: '2026-10-06', scene: '有室外' };
    await call('POST', {}, { action: 'save-context', context, mutationId: uid('today-context') });
    await call('POST', {}, { action: 'save-context', context: nextContext, mutationId: uid('tomorrow-context') });
    const body = { action: 'confirm', recordId: uid('today-outfit'), context, revision: '', mutationId: uid('today-worn'),
      items: [{ id: item.id, revision: item.revision }], weather: null, purpose: '休闲', time: '10:00', indoor: null, outdoor: null };
    const todayRecord = await call('POST', {}, body);
    const tomorrowRecord = await call('POST', {}, { ...body, context: nextContext, kind: 'styled', recordId: uid('tomorrow-outfit'), mutationId: uid('tomorrow-styled') });
    expect(tomorrowRecord.status).toBe(200);
    const todayResult = await call('GET', { date: context.date });
    const tomorrowResult = await call('GET', { date: nextContext.date });
    expect(todayResult.body.context.scene).toBe('基本室内');
    expect(tomorrowResult.body.context.scene).toBe('有室外');
    expect(todayResult.body.records).toEqual([todayRecord.body.value]);
    expect(todayResult.body.outfits).toEqual([tomorrowRecord.body.value]);
    expect(tomorrowResult.body.outfits).toEqual(todayResult.body.outfits);
  });
  it('天气缓存30分钟，过期失败保留旧快照，没有缓存返回空', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ current: { temperature_2m: 24, apparent_temperature: 25 },
      hourly: { time: ['2026-10-05T09:00', '2026-10-05T10:00', '2026-10-05T13:00', '2026-10-05T16:00', '2026-10-05T20:00'], temperature_2m: [18, 20, 23, 24, 21] },
      daily: { time: [context.date], temperature_2m_min: [18], temperature_2m_max: [27], apparent_temperature_min: [18], precipitation_sum: [0], wind_speed_10m_max: [12] } })));
    vi.stubGlobal('fetch', fetchMock);
    const city = { name: '杭州', latitude: 30, longitude: 120, source: 'manual' as const };
    const first = await readWeather(city, context.date, context.timezone);
    expect(first.stale).toBe(false);
    expect(first.weather?.periodTemperatures).toEqual({ 早晨: 18, 上午: 20, 中午: 23, 下午: 24, 晚上: 21 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('hourly=temperature_2m');
    await readWeather(city, context.date, context.timezone); expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-05T01:31:00Z')); fetchMock.mockRejectedValue(new Error('offline'));
    const stale = await readWeather(city, context.date, context.timezone); expect(stale.stale).toBe(true); expect(stale.weather).toEqual(first.weather);
    const missing = await readWeather({ ...city, latitude: 40 }, context.date, context.timezone); expect(missing.weather).toBeNull();
  });
  it('历史天气优先保存值和穿搭快照，缺失时只查询逐日历史', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const weather = { date: context.date, timezone: context.timezone, latitude: 30, longitude: 120, fetchedAt: '2026-10-05T10:00:00Z', temperature: 18, apparent: 17, min: 12, max: 20, apparentMin: 10, wind: 10, precipitation: 0 };
    const query = { view: 'weather', date: context.date, timezone: context.timezone, latitude: '30', longitude: '120' };
    expect((await call('GET', query)).body.weather).toBeNull();
    hashes.set(WEAR_KEY, { one: { id: 'one', date: context.date, confirmedAt: '', context, items: [item], weather } });
    expect((await call('GET', query)).body.weather).toEqual(weather);
    data.set('bonclothes:weather:v1:30:120:2026-10-05:Asia/Shanghai', { ...weather, temperature: 19 });
    expect((await call('GET', query)).body.weather.temperature).toBe(19);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('past_days=5');
    expect(String(fetch.mock.calls[0][0])).not.toContain('current=');
  });
  it('未连接日历返回独立状态，不覆盖手填条件', async () => {
    hashes.set(CONTEXTS_KEY, { [context.date]: context });
    expect((await readClothesCalendar(context.date, context.timezone)).connected).toBe(false);
    expect(hashes.get(CONTEXTS_KEY)![context.date]).toEqual(context);
  });
  it('地点可选读取，UTC跨日按设备时区；默认账本行为保持上海时区', () => {
    const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261005T010000Z\r\nDTEND:20261005T020000Z\r\nSUMMARY:电影\r\nLOCATION:杭州\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const options = { includeLocation: true, timezone: 'America/Los_Angeles' };
    expect(parseOutlookCalendar(text, 'play', '2026-10-04', '2026-10-05', false, true, options)[0].location).toBe('杭州');
    expect(parseOutlookCalendar(text, 'play', '2026-10-04', '2026-10-05', false, true)).toEqual([]);
    expect(parseOutlookCalendar(text, 'play', '2026-10-05', '2026-10-06', false, true)[0].location).toBeUndefined();
  });
  it('全天事件不转换日期；浮动时间按设备时区并处理DST', () => {
    const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260308T033000\r\nDTEND:20260308T043000\r\nSUMMARY:课程\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART;VALUE=DATE:20260308\r\nDTEND;VALUE=DATE:20260309\r\nSUMMARY:徒步\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const events = parseOutlookCalendar(text, 'class', '2026-03-08', '2026-03-09', false, true, { timezone: 'America/New_York' });
    expect(events[0].startDate).toBe('2026-03-08T07:30:00.000Z'); expect(events[1].startDate).toBe('2026-03-08');
  });
});

describe('出行预报与计划接口', () => {
  const city = { name: '杭州', latitude: 30, longitude: 120, source: 'manual' as const, timezone: 'Asia/Shanghai' };
  const plan = { tripId: 'trip:2026-10-05', revision: '', title: '杭州', startDate: '2026-10-05', endDate: '2026-10-06', location: city,
    days: { '2026-10-05': { scene: '基本室内', active: false, itemIds: [item.id] } } };
  it('包含五种配饰的九件穿搭可以确认并保存行程，继续限制过大的请求', async () => {
    const pieces: ClothesItem[] = [
      ...(['上衣', '下装', '外套', '鞋'] as const).map((category, index) => ({ ...item, id: uid(`core-${index}`), category })),
      ...['帽子', '口罩', '围巾', '袜子', '手套'].map((name, index) => ({ ...item, id: uid(`accessory-${index}`), name, category: '配饰' as const })),
    ];
    hashes.set(ITEMS_KEY, Object.fromEntries(pieces.map((piece) => [piece.id, piece])));
    const confirmed = await call('POST', {}, { action: 'confirm', context, weather: null, revision: '', mutationId: uid('full-body-confirm'),
      items: pieces.map(({ id, revision, category }) => ({ id, revision, category })) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.value.items).toHaveLength(9);
    const fullPlan = { ...plan, days: { [context.date]: { ...plan.days[context.date], itemIds: pieces.map((piece) => piece.id) } } };
    const saved = await call('POST', {}, { action: 'save-trip-plan', plan: fullPlan, mutationId: uid('full-body-trip') });
    expect(saved.status).toBe(200);
    expect(saved.body.value.days[context.date].itemIds).toHaveLength(9);
    const tooMany = Array.from({ length: 25 }, (_, index) => uid(`extra-${index}`));
    expect((await call('POST', {}, { action: 'save-trip-plan', plan: { ...plan, days: { [context.date]: { ...plan.days[context.date], itemIds: tooMany } } }, mutationId: uid('too-many-clothes') })).status).toBe(400);
  });
  it('未来使用逐日预报，只查询16天范围，缓存与失败回退独立于今日天气', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
    const fetchMock = vi.fn(async (_url: URL) => new Response(JSON.stringify({ current: { temperature_2m: 40 }, daily: {
      time: ['2026-10-19', '2026-10-20'], temperature_2m_min: [10, 11], temperature_2m_max: [20, 21], apparent_temperature_min: [9, 10], apparent_temperature_max: [19, 20], precipitation_sum: [0, 3], wind_speed_10m_max: [12, 20],
    } })));
    vi.stubGlobal('fetch', fetchMock);
    const first = await readTripForecast(city, '2026-10-19', '2026-10-25', city.timezone);
    expect(Object.keys(first.days)).toEqual(['2026-10-19', '2026-10-20']); expect(first.days['2026-10-19'].temperature).toBe(20);
    const url = String(fetchMock.mock.calls[0][0]); expect(url).toContain('forecast_days=16'); expect(url).not.toContain('current=');
    await readTripForecast(city, '2026-10-19', '2026-10-25', city.timezone); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await readTripForecast(city, '2026-11-01', '2026-11-03', city.timezone)).days).toEqual({}); expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-05T01:31:00Z')); fetchMock.mockRejectedValue(new Error('offline'));
    expect(await readTripForecast(city, '2026-10-19', '2026-10-25', city.timezone)).toMatchObject({ days: first.days, stale: true });
    expect((await readTripForecast({ ...city, latitude: 40 }, '2026-10-19', '2026-10-20', city.timezone)).days).toEqual({});
  });
  it('保存计划独立 CAS、幂等，并不确认实际穿搭或写入日历', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: item });
    const body = { action: 'save-trip-plan', plan, mutationId: uid('trip-save') };
    const saved = await call('POST', {}, body); expect(saved.status).toBe(200); expect(saved.body.value.location.timezone).toBe(city.timezone);
    expect((await call('POST', {}, body)).body).toEqual(saved.body); expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(1);
    expect((await call('POST', {}, { ...body, mutationId: uid('trip-conflict') })).status).toBe(409);
    expect(hashes.has(TRIP_PLANS_KEY)).toBe(true); expect(hashes.has(WEAR_KEY)).toBe(false);
    expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES).every((call) => call[1].every((key: string) => !key || key.startsWith('bonclothes:')))).toBe(true);
  });
  it('不接受收起、不方便运动的单品或超出行程日期的计划', async () => {
    hashes.set(ITEMS_KEY, { [item.id]: { ...item, status: '收起' } });
    const body = { action: 'save-trip-plan', plan, mutationId: uid('trip-save') };
    expect((await call('POST', {}, body)).status).toBe(409);
    hashes.set(ITEMS_KEY, { [item.id]: { ...item, status: '已丢弃' } });
    expect((await call('POST', {}, body)).status).toBe(409);
    hashes.set(ITEMS_KEY, { [item.id]: { ...item, active: false } });
    expect((await call('POST', {}, { ...body, plan: { ...plan, days: { '2026-10-05': { ...plan.days['2026-10-05'], active: true } } } })).status).toBe(400);
    expect((await call('POST', {}, { ...body, plan: { ...plan, endDate: '2026-10-04' } })).status).toBe(400);
    expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(0);
  });
  it('行程消失保留计划，Outlook 失败仍能读取已有出游', async () => {
    data.set('calendar-tags', { tagMap: { '2026-10-06': 'travel' } }); data.set('trip-tags', { tripTags: { '2026-10-06': '杭州' } });
    hashes.set(TRIP_PLANS_KEY, { [plan.tripId]: plan });
    vi.stubEnv('SYNC_SECRET', 'test-only-secret');
    data.set(OUTLOOK_CONNECTION_KEY, { id: 'test', encrypted: encryptOutlookConnection({ playUrl: 'https://outlook.live.com/owa/calendar/example/test.ics', classUrl: '', policy: 'manual', rules: { homeTitles: [], ignoredPlayTitles: [] } }, 'test-only-secret') });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await readClothesTrips('2026-10-05', 'Asia/Shanghai');
    expect(result.calendarError).toContain('日历更新失败'); expect(result.trips.find((trip) => trip.id === plan.tripId)?.archived).toBe(true);
    expect(result.trips.some((trip) => trip.title === '杭州')).toBe(true); expect(evalMock.mock.calls.filter(([script]) => script === SAVE_CLOTHES)).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});

vi.mock('./_accountRoute.js', () => ({ withAccountScope: (handler: unknown) => handler }));
