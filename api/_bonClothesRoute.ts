import { READ_PHOTO, READ_WEAR_PAGE } from './_clothesReads.js';
import { READ_PHOTO_SIZES, COMPRESS_PHOTO, MIGRATE_PHOTO } from './_clothesPhotoStorage.js';
import { r2Enabled, r2Photo, readR2Photo, storeR2Photo } from './_clothesR2.js';
import { PHOTO_MAX_BYTES, PHOTO_MAX_STORED_BYTES } from '../src/clothes/photoCompression.js';
import { privateJson, privateCache } from './_privateCache.js';
import { withAccountScope } from './_accountRoute.js';
import { kv } from './_accountKv.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authOk, sameOrigin } from './_auth.js';
import { CONTEXTS_KEY, ITEMS_KEY, WEAR_KEY, SAVE_CLOTHES, photoKey, receiptKey, signature, readClothesCalendar, readWeather, searchCities } from './_bonClothes.js';
import { ClothesInputError, feelingsInput, numberInput, contextInput, dateInput, id, itemInput, locationInput, photoData, photoInput, requireInput, timezoneInput, validLayers } from './_clothesValidation.js';
import { CATEGORIES, MAX_OUTFIT_ITEMS, PURPOSES, SENSATIONS, categoryLabel, type ClothesDayContext, type ClothesItem, type WearRecord, type WeatherSnapshot } from '../src/clothes/types.js';
import { itemCategories, wearAs, outfitPairCounts } from '../src/clothes/pairing.js';
import { calibratedItems } from '../src/clothes/thermalLearning.js';
import { itemWarmth, normalizeItem, wearable } from '../src/clothes/warmth.js';
import { TRIP_PLANS_KEY, readClothesTrips, readTripForecast, tripPlanInput } from './_clothesTrips.js';
import { saveBonCalLocationRecord } from './_bonCal/repository.js';
import { readCalendarLocations, readCalendarWeather } from './_calendarWeather.js';
import { readDailyWeather } from './_dailyWeather.js';
import { deviceDate, totalWearCounts } from '../src/clothes/rules.js';

async function readWearPage(date: string, mode: 'history' | 'day'): Promise<WearRecord[]> {
  const records = await kv.eval<string[], (string | WearRecord)[]>(READ_WEAR_PAGE, [WEAR_KEY], [date, mode]);
  return records.map((record) => typeof record === 'string' ? JSON.parse(record) as WearRecord : record)
    .sort((a, b) => b.date.localeCompare(a.date) || b.confirmedAt.localeCompare(a.confirmedAt));
}

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!sameOrigin(req)) return res.status(403).json({ error: '请求来源无效' });
  try {
    if (!await authOk(req)) return res.status(401).json({ error: '请先登录' });
    if (req.method === 'GET') {
      if (req.query.view === 'photo-sizes' || req.query.view === 'photo-migration') {
        const migration = req.query.view === 'photo-migration';
        if (migration && !r2Enabled()) return res.status(503).json({ error: '照片存储尚未配置' });
        const photos = await kv.eval<string[], [string, number][]>(READ_PHOTO_SIZES,
          [ITEMS_KEY, WEAR_KEY, photoKey('')], [String(migration ? 0 : PHOTO_MAX_STORED_BYTES)]);
        return res.status(200).json({ photos: photos.map(([id, bytes]) => ({ id, bytes })) });
      }
      if (req.query.view === 'photo') {
        const tags = (req.headers['if-none-match'] ?? '').split(',').map((tag) => tag.trim().replace(/^W\//, ''));
        const [validator, photo] = await kv.eval<string[], [string, string]>(READ_PHOTO,
          [photoKey(id(req.query.id))], [JSON.stringify(tags)]);
        if (!validator) return res.status(404).json({ error: '照片不存在' });
        const reference = photo ? r2Photo(photo) : null;
        const decoded = reference ? { mime: reference.mime, data: await readR2Photo(reference) } : photo ? photoData(photo) : null;
        privateCache(res, 30 * 24 * 60 * 60, true);
        res.setHeader('ETag', `"${validator}"`);
        if (!decoded) return res.status(304).end();
        const { mime, data } = decoded;
        res.setHeader('Content-Type', mime);
        return res.status(200).send(data);
      }
      if (req.query.view === 'cities') {
        requireInput(typeof req.query.q === 'string' && req.query.q.trim().length >= 2 && req.query.q.length <= 120, '请输入城市名');
        return privateJson(req, res, { cities: await searchCities(req.query.q.trim()) });
      }
      const date = dateInput(req.query.date);
      if (req.query.view === 'calendar-weather') {
        const end = dateInput(req.query.endDate);
        requireInput(date <= end && Date.parse(end) - Date.parse(date) < 31 * 86400000, '天气日期无效');
        return privateJson(req, res, await readCalendarWeather(date, end));
      }
      if (req.query.view === 'trips') return privateJson(req, res, await readClothesTrips(date, timezoneInput(req.query.timezone)));
      if (req.query.view === 'forecast') {
        const location = locationInput({ name: '行程目的地', latitude: Number(req.query.latitude), longitude: Number(req.query.longitude), source: 'manual' });
        return privateJson(req, res, await readTripForecast(location!, date, dateInput(req.query.endDate), timezoneInput(req.query.timezone)));
      }
      if (req.query.view === 'calendar') return privateJson(req, res, await readClothesCalendar(date, timezoneInput(req.query.timezone)));
      if (req.query.view === 'weather') {
        const location = locationInput({ name: '天气地点', latitude: Number(req.query.latitude), longitude: Number(req.query.longitude), source: 'manual' });
        const timezone = timezoneInput(req.query.timezone);
        if (date > deviceDate(new Date(), timezone)) {
          const forecast = await readTripForecast(location!, date, date, timezone);
          return privateJson(req, res, { weather: forecast.days[date] ?? null, stale: forecast.stale, ...(forecast.error ? { error: forecast.error } : {}) });
        }
        const result = await readWeather(location!, date, timezone);
        if (date < deviceDate(new Date(), timezone) && !result.weather) {
          const records = await readWearPage(date, 'day');
          result.weather = records.filter((record) => record.date === date && record.weather
            && Math.abs(record.weather.latitude - location!.latitude) < .1 && Math.abs(record.weather.longitude - location!.longitude) < .1)
            .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt))[0]?.weather ?? null;
        }
        if (date < deviceDate(new Date(), timezone) && !result.weather) {
          const history = await readDailyWeather(location!, date, date, timezone);
          return privateJson(req, res, { weather: history.days[date] ?? null, stale: history.stale, error: history.error });
        }
        return privateJson(req, res, result);
      }
      if (req.query.view === 'history') return privateJson(req, res, { records: await readWearPage(date, 'history') });
      const allRecords = Object.values(await kv.hgetall<Record<string, WearRecord>>(WEAR_KEY) ?? {})
        .sort((a, b) => b.date.localeCompare(a.date) || b.confirmedAt.localeCompare(a.confirmedAt));
      const worn = allRecords.filter((record) => record.kind !== 'styled' && record.date <= date);
      const outfits = allRecords.filter((record) => record.kind === 'styled');
      // Paginate whole dates so a busy day is never split or silently skipped.
      const dates = [...new Set(worn.map((record) => record.date))].slice(0, 30);
      const records = worn.filter((record) => dates.includes(record.date));
      const [items, context, locations] = await Promise.all([kv.hgetall<Record<string, ClothesItem>>(ITEMS_KEY), kv.hget<ClothesDayContext>(CONTEXTS_KEY, date), readCalendarLocations(date, date)]);
      const learningTimezone = timezoneInput(req.query.timezone ?? context?.timezone ?? 'Asia/Shanghai');
      return privateJson(req, res, { photoStorage: r2Enabled() ? 'r2' : 'redis', calendarLocation: locations[date], items: calibratedItems(Object.values(items ?? {}).filter((item) => !item.deleted).map(normalizeItem), allRecords, deviceDate(new Date(), learningTimezone)), context: context ?? allRecords.find((record) => record.date === date)?.context ?? null, records, outfits, wearCounts: totalWearCounts(worn), pairCounts: outfitPairCounts(allRecords) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: '请求方式无效' });
    let body: Record<string, any>;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw new ClothesInputError('请求内容无效'); }
    requireInput(body && typeof body === 'object' && !Array.isArray(body), '请求内容无效');
    requireInput(JSON.stringify(body).length <= 300000, '请求过大');
    if (body.action === 'migrate-photo') {
      if (!r2Enabled()) return res.status(503).json({ error: '照片存储尚未配置' });
      const key = photoKey(id(body.id));
      const [validator, source] = await kv.eval<string[], [string, string]>(READ_PHOTO, [key], ['[]']);
      if (!validator) return res.status(404).json({ error: '照片不存在' });
      if (r2Photo(source)) return res.status(200).json({ migrated: false, savedBytes: 0 });
      const reference = await storeR2Photo(source);
      const [result, savedBytes] = await kv.eval<string[], [number, number]>(MIGRATE_PHOTO, [key], [validator, JSON.stringify(reference)]);
      if (result === -1) return res.status(404).json({ error: '照片不存在' });
      if (result === -2) return res.status(409).json({ error: '照片已更新，请重试转存' });
      return res.status(200).json({ migrated: result === 1, savedBytes });
    }
    if (body.action === 'compress-photo') {
      const key = photoKey(id(body.id));
      requireInput(typeof body.validator === 'string' && /^photo-v2-[a-f0-9]{40}$/.test(body.validator), '请重新读取照片');
      const photo = photoInput(body.photo);
      requireInput(photoData(photo).data.length <= PHOTO_MAX_BYTES, '压缩后照片不能超过 40KB');
      const [result, savedBytes] = await kv.eval<string[], [number, number]>(COMPRESS_PHOTO, [key], [body.validator, photo]);
      if (result === -1) return res.status(404).json({ error: '照片不存在' });
      if (result === -2) return res.status(409).json({ error: '照片已更新，请重试压缩' });
      if (result === -3) return res.status(409).json({ error: '照片已转存，请刷新页面' });
      return res.status(200).json({ savedBytes });
    }
    const mutationId = id(body.mutationId), sig = signature(body);
    const receipt = await kv.get<{ signature: string; value: unknown }>(receiptKey(mutationId));
    if (receipt) {
      requireInput(receipt.signature === sig, '请重新提交本次修改');
      return res.status(200).json({ value: receipt.value });
    }
    let key: string, field: string, expected: string, value: unknown, photo = '', photoStorage = '';
    let checks: { id: string; revision: string }[] = [];
    if (body.action === 'save-item') {
      const item = itemInput(body.item);
      key = ITEMS_KEY; field = item.id; expected = item.revision;
      if (body.photo) { photo = photoInput(body.photo); item.photoId = mutationId; }
      requireInput(item.photoId, '请添加照片');
      photoStorage = photoKey(item.photoId);
      value = { ...item, revision: mutationId };
    } else if (body.action === 'delete-item') {
      key = ITEMS_KEY; field = id(body.id); expected = id(body.revision);
      value = { id: field, revision: mutationId, deleted: true };
    } else if (body.action === 'save-context') {
      const context = contextInput(body.context);
      key = CONTEXTS_KEY; field = context.date; expected = context.revision;
      value = { ...context, revision: mutationId };
    } else if (body.action === 'save-trip-plan') {
      const plan = tripPlanInput(body.plan);
      key = TRIP_PLANS_KEY; field = plan.tripId; expected = plan.revision;
      const selected = [...new Set(Object.values(plan.days).flatMap((day) => day.itemIds ?? []))];
      const items = await Promise.all(selected.map((id) => kv.hget<ClothesItem>(ITEMS_KEY, id)));
      if (items.some((item) => !item || !wearable(item))) return res.status(409).json({ error: '衣柜已更新，请刷新后重新选择', wardrobeChanged: true });
      for (const day of Object.values(plan.days)) {
        const pieces = items.filter((item) => day.itemIds?.includes(item!.id)).map((item) => {
          const role = day.itemCategories?.[item!.id] ?? item!.category;
          requireInput(itemCategories(item!).includes(categoryLabel(role)), '穿着位置无效');
          return wearAs(item!, role);
        });
        requireInput(validLayers(pieces as ClothesItem[])
          && (!(day.active || day.purpose === '运动') || pieces.every((item) => item!.active)), '搭配不符合行程条件');
      }
      checks = items.map((item) => ({ id: item!.id, revision: item!.revision }));
      value = { ...plan, revision: mutationId };
    } else if (body.action === 'confirm') {
      const context = contextInput(body.context);
      key = WEAR_KEY; expected = id(body.revision, true);
      const manual = body.recordId !== undefined;
      // Date keys keep old records and older clients editable during rollout.
      field = manual ? (body.recordId === context.date ? context.date : id(body.recordId)) : context.date;
      const previous = await kv.hget<WearRecord>(WEAR_KEY, field);
      requireInput(!previous || previous.date === context.date, '穿搭日期不一致');
      requireInput(body.kind === undefined || ['worn', 'styled'].includes(body.kind), '穿搭状态无效');
      const kind = body.kind ?? previous?.kind ?? 'worn';
      requireInput(['worn', 'styled'].includes(kind) && (manual || kind === 'worn'), '穿搭状态无效');
      if (manual) {
        requireInput(PURPOSES.includes(body.purpose), '请选择用途');
        if (kind === 'worn') requireInput([body.indoor, body.outdoor].every((value) => value === null || SENSATIONS.includes(value)), '请选择室内外体感');
        requireInput(typeof body.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time), '穿着时间无效');
        requireInput(body.indoorCoat === undefined || typeof body.indoorCoat === 'boolean', '室内外套状态无效');
      }
      requireInput(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= MAX_OUTFIT_ITEMS, '请选择穿搭');
      checks = body.items.map((item: { id: unknown; revision: unknown }) => ({ id: id(item.id), revision: id(item.revision) }));
      requireInput(new Set(checks.map((item) => item.id)).size === checks.length, '衣物重复');
      const [learningRecords, learningItems] = await Promise.all([kv.hgetall<Record<string, WearRecord>>(WEAR_KEY), kv.hgetall<Record<string, ClothesItem>>(ITEMS_KEY)]);
      const currentItems = checks.map((check) => learningItems?.[check.id] ?? null);
      const calibrated = new Map(calibratedItems(Object.values(learningItems ?? {}), Object.values(learningRecords ?? {}), deviceDate(new Date(), context.timezone)).map((item) => [item.id, item]));
      const retained = new Set<string>();
      const items = currentItems.map((item, i) => {
        const check = checks[i];
        const snapshot = manual && previous?.items.find((piece) => piece.id === check.id && piece.revision === check.revision);
        const source = snapshot || (item && wearable(item) && item.revision === check.revision ? normalizeItem(item) : null);
        if (!source) return null;
        const role = body.items[i].category;
        requireInput(role === undefined || (CATEGORIES.includes(categoryLabel(role)) && itemCategories(source).includes(categoryLabel(role))), '穿着位置无效');
        if (snapshot) retained.add(check.id);
        const learned = snapshot ? source : calibrated.get(source.id) ?? source;
        const frozen = learned.learnedWarmth === undefined ? source : { ...source, warmth: itemWarmth(learned) };
        return role === undefined ? frozen : wearAs(frozen, role);
      });
      if (items.some((item) => !item)) return res.status(409).json({ error: '衣柜已更新，请刷新后重新选择', wardrobeChanged: true });
      checks = checks.filter((check) => !retained.has(check.id));
      // Actual outfits may contain multiple layers or differ from recommendations.
      if (!manual) requireInput(validLayers(items as ClothesItem[])
        && (!context.active || items.every((item) => item!.active)), '搭配不符合当天条件');
      let weather: WeatherSnapshot | null = null;
      if (body.weather !== null) {
        const w = body.weather as WeatherSnapshot;
        requireInput(w && w.date === context.date && w.timezone === context.timezone
          && ['temperature', 'apparent', 'min', 'max', 'apparentMin', 'precipitation', 'wind', 'latitude', 'longitude']
            .every((key) => typeof w[key as keyof WeatherSnapshot] === 'number' && Number.isFinite(w[key as keyof WeatherSnapshot]))
          && typeof w.fetchedAt === 'string' && w.fetchedAt.length <= 40, '天气快照无效');
        requireInput(w.code === undefined || (typeof w.code === 'number' && Number.isInteger(w.code) && w.code >= 0 && w.code <= 99), '天气代码无效');
        const periodTemperatures = w.periodTemperatures;
        requireInput(periodTemperatures === undefined || (periodTemperatures && typeof periodTemperatures === 'object'
          && Object.entries(periodTemperatures).every(([period, temperature]) => ['早晨', '上午', '中午', '下午', '晚上'].includes(period)
            && typeof temperature === 'number' && Number.isFinite(temperature))), '天气快照无效');
        weather = { ...Object.fromEntries(['date', 'timezone', 'latitude', 'longitude', 'fetchedAt', 'temperature', 'apparent', 'min', 'max', 'apparentMin', 'precipitation', 'wind'].map((key) => [key, w[key as keyof WeatherSnapshot]])),
          ...(w.code !== undefined ? { code: w.code } : {}), ...(periodTemperatures ? { periodTemperatures } : {}) } as unknown as WeatherSnapshot;
      }
      const indoorTemperature = body.indoorTemperature === undefined ? previous?.indoorTemperature : body.indoorTemperature === null ? null : numberInput(body.indoorTemperature, -60, 60);
      const feelings = body.feelings === undefined ? previous?.feelings : feelingsInput(body.feelings);
      value = { ...(indoorTemperature !== undefined ? { indoorTemperature: kind === 'styled' ? null : indoorTemperature } : {}), ...(feelings ? { feelings: kind === 'styled' ? {} : Object.fromEntries(Object.entries(feelings).map(([period, entry]) => [period,
        body.purpose === '睡觉' ? { ...entry, ...(entry.cycling !== undefined ? { cycling: null } : {}), outdoor: null, outdoorTemperature: null } : entry])) } : {}), kind, ...(manual ? { id: field, purpose: body.purpose, indoor: kind === 'styled' ? null : body.indoor, outdoor: kind === 'styled' || body.purpose === '睡觉' ? null : body.outdoor, time: body.time,
        ...(body.indoorCoat !== undefined || previous?.indoorCoat !== undefined ? { indoorCoat: body.indoorCoat ?? previous?.indoorCoat } : {}) } : {}), date: context.date, revision: mutationId, confirmedAt: previous?.confirmedAt ?? new Date().toISOString(), items, context, weather };
    } else throw new ClothesInputError('操作无效');
    if (photo && r2Enabled()) photo = JSON.stringify(await storeR2Photo(photo));
    const write = () => kv.eval<string[], [number, string | unknown]>(SAVE_CLOTHES,
      [key, receiptKey(mutationId), ITEMS_KEY, photoStorage],
      [field, expected, mutationId, JSON.stringify(value), photo, JSON.stringify(checks), sig]);
    const [ok, raw] = await (key === CONTEXTS_KEY || key === TRIP_PLANS_KEY ? saveBonCalLocationRecord(write) : write());
    const stored = typeof raw === 'string' ? (raw ? JSON.parse(raw) : null) : raw;
    if (ok === -3) throw new ClothesInputError('请重新提交本次修改');
    if (ok === -1) throw new ClothesInputError('照片不存在，请重新上传');
    if (ok === -2) return res.status(409).json({ error: '衣柜已更新，请刷新后重新选择', wardrobeChanged: true });
    if (!ok) return res.status(409).json({ error: '已在其他页面更新，当前编辑已保留', current: stored });
    return res.status(200).json({ value: stored });
  } catch (error) {
    if (error instanceof ClothesInputError) return res.status(400).json({ error: error.message });
    const message = error instanceof Error ? error.message : '';
    if (message === '日历更新失败') return res.status(502).json({ error: message });
    return res.status(503).json({ error: '暂时无法读取或保存，请重试' });
  }
}

export default withAccountScope(handler);
