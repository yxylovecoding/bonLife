import type { ClothesCalendar, ClothesDayContext, ClothesItem, Outfit, Scene, WearRecord, WeatherSnapshot } from './types';
import { itemCategories, outfitPairCounts, pairingScore, wearAs } from './pairing.js';
import { accessoriesOverlap, COMFORT_TEMPERATURE, isOutdoorCoat, itemRegions, warmthGap, wearable } from './warmth.js';
import { BODY_REGIONS, CATEGORIES, categoryLabel, hasBraRequirement, type Category, type PairCounts } from './types.js';

export function deviceDate(now = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function emptyContext(date: string, timezone: string): ClothesDayContext {
  return { date, timezone, revision: '', location: null, purpose: null, scene: null, active: null, manualWeather: null };
}
export function inferActivities(events: ClothesCalendar['events']): { scene: Scene | null; active: boolean | null } {
  let scene: Scene | null = null;
  let active: boolean | null = null;
  for (const event of events) {
    const title = event.title.replace(/(?:不|没有|无需|无)(?:运动|健身|多走路|走很多路)/g, '');
    const long = /徒步|登山|爬山|露营|滑雪|马拉松|骑行|hiking|camping|skiing/i.test(title);
    const outdoor = /散步|公园|户外|室外|动物园|游园|海滩|outdoor|walking/i.test(title);
    const sport = /运动|健身|跑步|打球|篮球|足球|羽毛球|乒乓球|网球|排球|高尔夫|瑜伽|普拉提|游泳|舞蹈|跳舞|攀岩|滑雪|滑冰|骑行|马拉松|gym|workout|running|cycling|swimming|yoga/i.test(title);
    const walking = /徒步|登山|爬山|暴走|健走|走很多路|多走路|长距离步行|万步|hiking|trekking|long walk/i.test(title);
    const indoor = /上课|课程|课$|讲座|会议|办公室|居家|电影|展览|博物馆|图书馆|室内|实习|健身房|gym|lecture|meeting/i.test(title);
    if (long) scene = '长时间室外';
    else if ((outdoor || /跑步|running/i.test(title)) && scene !== '长时间室外') scene = '有室外';
    else if (indoor && !scene) scene = '基本室内';
    if (walking || sport) active = true;
    else if ((indoor || outdoor || long) && active === null) active = false;
  }
  return { scene, active };
}
export { calendarDestinations } from '../boncal/destinations.js';
export function effectiveContext(context: ClothesDayContext, calendar: ClothesCalendar | null): ClothesDayContext {
  const inferred = inferActivities(calendar?.events ?? []);
  return { ...context, scene: context.scene ?? inferred.scene, active: context.purpose === '运动' ? true : context.active ?? inferred.active };
}
export { chooseLocation } from '../boncal/clothesContext.js';
export function weatherFor(context: ClothesDayContext, weather: WeatherSnapshot | null): WeatherSnapshot | null {
  if (!context.manualWeather) return weather;
  const { temperature, rain } = context.manualWeather;
  return { date: context.date, timezone: context.timezone, latitude: context.location?.latitude ?? 0,
    longitude: context.location?.longitude ?? 0, fetchedAt: '', temperature, apparent: temperature,
    min: temperature, max: temperature, apparentMin: temperature, precipitation: rain ? 1 : 0, wind: 0 };
}
export function recentCounts(records: WearRecord[], date: string) {
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  const counts: Record<string, number> = {};
  for (const record of records) if (record.kind !== 'styled' && record.date >= start && record.date < date) {
    for (const item of record.items) counts[item.id] = (counts[item.id] ?? 0) + 1;
  }
  return counts;
}
export function totalWearCounts(records: WearRecord[]) {
  const counts: Record<string, number> = {};
  for (const record of records) if (record.kind !== 'styled') {
    for (const item of record.items) counts[item.id] = (counts[item.id] ?? 0) + 1;
  }
  return counts;
}
function needs(context: ClothesDayContext, weather: WeatherSnapshot) {
  const outdoor = context.scene !== '基本室内';
  const cold = weather.temperature;
  const rain = outdoor && weather.precipitation > 0;
  const wind = outdoor && weather.wind >= 25;
  return { cold, rain, wind, coat: cold < 18 || (weather.max - weather.min >= 10 && weather.min < 24) || rain || wind,
    accessory: cold < 5 && outdoor };
}
export function eligibleItems(items: ClothesItem[], requested: Category, context: ClothesDayContext, weather: WeatherSnapshot, wearing: ClothesItem[] = []) {
  const n = needs(context, weather), category = categoryLabel(requested);
  return items.filter((item) => wearable(item) && !item.sleepwear && itemCategories(item).includes(category) && !wearing.some((piece) => piece.id === item.id)
    && (!(context.active || context.purpose === '运动') || item.active)
    && (category !== '配饰' || !wearing.some((piece) => accessoriesOverlap(item, piece)))
    && (category !== '配饰' || !itemRegions(item).includes('head') || item.thickness !== 3 || n.cold < 5)
    && (category !== '外套' || ((!n.rain || item.waterproof) && (!n.wind || item.windproof)))
    && (category !== '鞋' || !n.rain || item.waterproof)).map((item) => wearAs(item, category));
}
function outfitKey(items: ClothesItem[]) { return items.map((item) => `${item.id}@${categoryLabel(item.category)}`).sort().join(':'); }
function ordered(items: ClothesItem[]) {
  return [...items].sort((a, b) => CATEGORIES.indexOf(categoryLabel(a.category)) - CATEGORIES.indexOf(categoryLabel(b.category)));
}
export function needsBra(items: ClothesItem[]) {
  const covering = items.find((item) => hasBraRequirement(item.category));
  return Boolean(covering && covering.braRequirement !== 'optional');
}
function withBra(outfit: Outfit, bra: ClothesItem | undefined): Outfit {
  const items = ordered([...outfit.items.filter((item) => categoryLabel(item.category) !== '文胸'), ...(bra ? [bra] : [])]);
  const missing = outfit.missing.filter((label) => label !== '文胸');
  if (needsBra(items) && !bra) missing.unshift('文胸');
  return { items, missing, key: outfitKey(items) };
}
export function recommend(items: ClothesItem[], context: ClothesDayContext, inputWeather: WeatherSnapshot | null,
  records: WearRecord[] = [], wearCounts = totalWearCounts(records), options: { fixedItems?: ClothesItem[]; pairCounts?: PairCounts } = {}): Outfit[] {
  const weather = weatherFor(context, inputWeather);
  if (!weather || !context.scene || context.active === null) return [];
  // Seed every search branch with the user's choices before pruning candidates.
  // Filtering the ranked results afterwards can lose a less common chosen item.
  const fixed = (options.fixedItems ?? []).flatMap((piece) => {
    const current = items.find((item) => item.id === piece.id);
    return current ? eligibleItems([current], piece.category, context, weather) : [];
  });
  if (fixed.length !== (options.fixedItems?.length ?? 0) || new Set(fixed.map((item) => item.id)).size !== fixed.length
    || fixed.some((item, i) => fixed.slice(i + 1).some((other) => categoryLabel(item.category) === categoryLabel(other.category)
      && (categoryLabel(item.category) === '配饰' && accessoriesOverlap(item, other))))) return [];
  const fixedCategories = new Set(fixed.map((item) => categoryLabel(item.category)));
  if (fixedCategories.has('连衣裙') && (fixedCategories.has('上衣') || fixedCategories.has('下装'))) return [];
  const pairs = options.pairCounts ?? outfitPairCounts(records);
  const n = needs(context, weather), counts = recentCounts(records, context.date);
  const thermalGap = (list: ClothesItem[], tolerance = 0) => {
    if (context.indoorTemperature == null) return warmthGap(list, weather.temperature, tolerance);
    const indoorWeight = context.scene === '基本室内' ? .8 : context.scene === '有室外' ? .5 : .2;
    return warmthGap(list.filter((item) => !isOutdoorCoat(item)), context.indoorTemperature, tolerance) * indoorWeight
      + warmthGap(list, weather.temperature, tolerance) * (1 - indoorWeight);
  };
  const score = (list: ClothesItem[]) => {
    const thermal = thermalGap(list);
    const colors = new Set(list.filter((item) => !['文胸', '内衣'].includes(categoryLabel(item.category))
      && !['黑', '白', '灰', '米', '棕'].includes(item.color)).map((item) => item.color));
    return thermal * 100 + Math.max(0, colors.size - 1) * 12 + list.reduce((sum, item) => sum + (counts[item.id] ?? 0) * 3, 0)
      + (list.some((item) => categoryLabel(item.category) === '内衣') ? 1 : 0)
      + list.filter((item) => categoryLabel(item.category) === '配饰').length * .1
      - list.reduce((sum, item) => sum + Math.min(5, pairingScore(item, fixed, pairs)) * 4, 0);
  };
  const comfortGap = (list: ClothesItem[]) => thermalGap(list, 2);
  const timesWorn = (list: ClothesItem[]) => list.reduce((sum, item) => sum + (wearCounts[item.id] ?? 0), 0);
  const social = context.purpose === '见朋友';
  const formal = context.purpose === '见重要的人';
  const styledCounts = records.filter((record) => record.kind === 'styled' && (!formal || record.purpose === context.purpose)).reduce((counts, record) => {
    const key = outfitKey(record.items);
    counts.set(key, (counts.get(key) ?? 0) + (record.purpose === context.purpose ? 2 : 1));
    return counts;
  }, new Map<string, number>());
  const underwearCount = (list: ClothesItem[]) => list.filter((item) => categoryLabel(item.category) === '内衣').length;
  const compareItems = (a: ClothesItem[], b: ClothesItem[]) => comfortGap(a) - comfortGap(b)
    || (social || formal ? (styledCounts.get(outfitKey(b)) ?? 0) - (styledCounts.get(outfitKey(a)) ?? 0) : 0)
    || (context.purpose === '休闲' ? underwearCount(a) - underwearCount(b) || timesWorn(a) - timesWorn(b) : 0)
    || score(a) - score(b);
  // Judge the main outfit before its underwear, so missing a bra never hides an
  // available shirt in favour of an empty dress outfit. Optional layers do not
  // improve completeness simply by adding more pieces.
  const coreMissing = (outfit: Outfit) => outfit.missing.filter((label) => label !== '文胸').length;
  const coreCount = (outfit: Outfit) => outfit.items.filter((item) => !['文胸', '内衣', '配饰'].includes(categoryLabel(item.category))).length;
  const compare = (a: Outfit, b: Outfit) => coreMissing(a) - coreMissing(b)
    || (coreMissing(a) ? coreCount(b) - coreCount(a) : 0) || a.missing.length - b.missing.length
    || compareItems(a.items, b.items) || a.key.localeCompare(b.key);
  const poolFor = (category: Category, wearing: ClothesItem[]) => eligibleItems(items, category, context, weather, wearing)
    .sort((a, b) => compareItems([...wearing, a], [...wearing, b]) || a.id.localeCompare(b.id)).slice(0, 24);
  const needsWarmth = Math.min(n.cold, context.indoorTemperature ?? n.cold) < COMFORT_TEMPERATURE;
  const inners = needsWarmth && !fixedCategories.has('内衣') ? poolFor('内衣', fixed) : [];
  const fixedBra = fixed.find((item) => categoryLabel(item.category) === '文胸');
  const bras = fixedBra ? [fixedBra] : poolFor('文胸', fixed);
  const layouts: Category[][] = [['上衣', '下装', '鞋'], ['连衣裙', '鞋']];
  const results: Outfit[] = [];
  for (const layout of layouts) {
    if (layout.includes('连衣裙') ? fixedCategories.has('上衣') || fixedCategories.has('下装') : fixedCategories.has('连衣裙')) continue;
    if (n.coat || needsWarmth) layout.push('外套');
    let candidates: Outfit[] = [fixed, ...inners.map((item) => [...fixed, item])].map((pieces) => ({ items: pieces, missing: [], key: outfitKey(pieces) }));
    for (const category of layout) {
      if (fixedCategories.has(categoryLabel(category))) continue;
      const label = category === '外套' && n.rain ? '防雨外套' : category === '外套' && n.wind ? '防风外套' : category;
      candidates = candidates.flatMap((outfit) => {
        const pool = poolFor(category, outfit.items);
        const optional = category === '外套';
        if (!pool.length) return [optional ? outfit : { ...outfit, missing: [...outfit.missing, label] }];
        return [...(optional ? [outfit] : []), ...pool.map((item) => {
          const next = [...outfit.items, item];
          return { ...outfit, items: next, key: outfitKey(next) };
        })];
      }).sort(compare).slice(0, 96);
    }
    // One optional accessory per covered region, allowing hat + mask + scarf +
    // socks + gloves together. Multi-region pieces are selected only once.
    for (const region of BODY_REGIONS) {
      const expanded = candidates.flatMap((outfit) => [outfit, ...eligibleItems(items, '配饰', context, weather, outfit.items)
        .filter((item) => itemRegions(item).includes(region))
        .sort((a, b) => compareItems([...outfit.items, a], [...outfit.items, b]) || a.id.localeCompare(b.id)).slice(0, 24)
        .map((item) => { const next = [...outfit.items, item]; return { ...outfit, items: next, key: outfitKey(next) }; })]);
      candidates = [...new Map(expanded.map((outfit) => [outfit.key + outfit.missing.join(), outfit])).values()].sort(compare).slice(0, 96);
    }
    results.push(...candidates.flatMap((outfit) => (fixedBra || needsBra(outfit.items)) && bras.length
      ? bras.map((bra) => withBra(outfit, bra)) : [withBra(outfit, undefined)]));
  }
  const unique = new Map(results.sort(compare).map((outfit) => [outfit.key + outfit.missing.join(), outfit]));
  const ranked = [...unique.values()].sort(compare);
  const temperatureCompatible = ranked.filter((outfit) => comfortGap(outfit.items) === 0);
  const eligibleRanked = temperatureCompatible.length ? temperatureCompatible : ranked;
  const best = eligibleRanked[0];
  return eligibleRanked.filter((outfit) => coreMissing(outfit) === coreMissing(best) && outfit.missing.length === best.missing.length
    && (!coreMissing(best) || coreCount(outfit) === coreCount(best))).map((outfit) => {
      const result = { ...outfit };
      if (n.coat && !outfit.items.some(isOutdoorCoat)) {
        const label = n.rain ? '防雨外套' : n.wind ? '防风外套' : '外套';
        result.missing = [label, ...outfit.missing];
      }
      if (!n.accessory) return result;
      const covered = new Set(result.items.flatMap(itemRegions));
      const missing = (['head', 'face', 'neck', 'hands'] as const).filter((region) => !covered.has(region))
        .map((region) => ({ head: '帽子', face: '口罩', neck: '围巾', hands: '手套' })[region]);
      return { ...result, missing: [...result.missing, ...missing] };
    });
}
export function replacements(item: ClothesItem, outfit: Outfit, items: ClothesItem[], context: ClothesDayContext, inputWeather: WeatherSnapshot | null) {
  const weather = weatherFor(context, inputWeather);
  if (!weather || !context.scene || context.active === null) return [];
  const retained = outfit.items.filter((piece) => piece.id !== item.id);
  return eligibleItems(items, item.category, context, weather, retained).filter((next) => next.id !== item.id
    && (categoryLabel(item.category) !== '配饰' || (itemRegions(next).length === itemRegions(item).length
      && itemRegions(item).every((region) => itemRegions(next).includes(region))))
    && !retained.some((worn) => worn.id === next.id)
    && retained.every((worn) => eligibleItems([worn], worn.category, context, weather, [...retained.filter((piece) => piece.id !== worn.id), next]).length > 0))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function replacePiece(outfit: Outfit, previous: string, next: ClothesItem,
  wardrobe: ClothesItem[], context: ClothesDayContext, inputWeather: WeatherSnapshot | null): Outfit {
  const items = outfit.items.map((item) => item.id === previous ? next : item);
  const weather = weatherFor(context, inputWeather);
  const bra = needsBra(items) ? items.find((item) => categoryLabel(item.category) === '文胸')
    ?? (weather ? eligibleItems(wardrobe, '文胸', context, weather).sort((a, b) => a.id.localeCompare(b.id))[0] : undefined) : undefined;
  return withBra({ ...outfit, items }, bra);
}
