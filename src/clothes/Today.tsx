import { linkedClothesContext } from './calendarContext';
import type { CalendarLocationDay } from '../utils/calendarWeather';
import { dailyWeatherLabel, weatherSymbol } from '../utils/weather';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClothesCalendar, ClothesDayContext, ClothesItem, ClothesLocation, Outfit, PairCounts, WearRecord, WeatherSnapshot } from './types';
import { SCENES, PURPOSES, PURPOSE_LABELS, wearId, type Purpose, type Category, categoryLabel } from './types';
import { calendarDestinations, deviceDate, effectiveContext, eligibleItems, recommend, replacements, weatherFor } from './rules';
import { ClothesError, clothesRequest } from './client';
import ItemPhoto from './ItemPhoto';
import CityPicker from './CityPicker';
import { createWearDraft, type WearDraft } from './WearEditor';
import OutfitWarmth from './OutfitWarmth';
import TripPlanner from './TripPlanner';
import WearDetails from './WearDetails';
import { useContextAutosave } from './useContextAutosave';
import { outfitPairCounts } from './pairing';
import { pinReplacement } from './outfitSelection';
import OutfitPieces from './OutfitPieces';
import PiecePicker from './PiecePicker';

interface WeatherResult { weather: WeatherSnapshot | null; stale: boolean; error?: string }
interface Props {
  calendarLocation?: CalendarLocationDay;
  owner: string; items: ClothesItem[]; initial: ClothesDayContext; records: WearRecord[]; outfits: WearRecord[];
  tomorrow: boolean; past: boolean; onReviewDay: (date: string) => void; onToggleDay: (location: ClothesLocation | null) => void;
  wearCounts?: Record<string, number>; pairCounts?: PairCounts;
  onContext: (context: ClothesDayContext) => void; onOpenWear: (draft: WearDraft) => void; hasWearDraft: boolean; onExpired: () => void;
  onRefresh: () => void; onWardrobe: () => void;
}
export default function Today({ calendarLocation, owner, items, initial, records, outfits, tomorrow, past, onReviewDay, onToggleDay, wearCounts, pairCounts, onContext, onOpenWear, hasWearDraft, onExpired, onRefresh, onWardrobe }: Props) {
  const future = initial.date > deviceDate(new Date(), initial.timezone);
  const datedHeading = past || (future && !tomorrow);
  const storageKey = `bonclothes:context-draft:${owner}:${initial.date}`;
  const preferred = useMemo(() => {
    const context = initial;
    const location = context.location;
    const beijing = location && (location.name.includes('北京') || (location.latitude >= 39.4 && location.latitude <= 41.1 && location.longitude >= 115.4 && location.longitude <= 117.6));
    return !past && context.indoorTemperature === undefined && beijing ? { ...context, indoorTemperature: 25 } : context;
  }, [initial, past]);
  const sync = useContextAutosave(storageKey, preferred);
  const { context, queue } = sync;
  const [calendar, setCalendar] = useState<ClothesCalendar | null>(null), [calendarError, setCalendarError] = useState('');
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [geoError, setGeoError] = useState(''), [geoBusy, setGeoBusy] = useState(false);
  const [cityQuery, setCityQuery] = useState<string | null>(null);
  const [weatherState, setWeatherState] = useState<WeatherResult>({ weather: null, stale: false });
  const [weatherBusy, setWeatherBusy] = useState(false), [weatherRetry, setWeatherRetry] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [manualTemperature, setManualTemperature] = useState(String(context.manualWeather?.temperature ?? 20));
  const [fixed, setFixed] = useState<ClothesItem[]>([]), [index, setIndex] = useState(0), [replace, setReplace] = useState<string | null>(null), [adding, setAdding] = useState<Category | null>(null);
  const [history, setHistory] = useState(false), [older, setOlder] = useState<WearRecord[]>([]), [moreHistory, setMoreHistory] = useState(true);
  const calendarRequest = useRef(0), geoRequest = useRef(0);
  const linked = useMemo(() => linkedClothesContext(context, calendarLocation), [context, calendarLocation]);
  const contextRef = useRef(linked); contextRef.current = linked;
  const todayRecords = [...records, ...outfits].filter((record) => record.date === initial.date).sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.confirmedAt.localeCompare(b.confirmedAt));
  const location = linked.location;
  const effective = useMemo(() => ({ ...effectiveContext(linked, calendar), location, timezone: location?.timezone ?? linked.timezone }), [linked, calendar, location]);
  const weather = weatherState.weather;
  const pairs = useMemo(() => pairCounts ?? outfitPairCounts([...records, ...outfits]), [pairCounts, records, outfits]);
  const candidates = useMemo(() => effective.purpose ? recommend(items, effective, weather, [...records, ...outfits], wearCounts, { fixedItems: fixed, pairCounts: pairs }) : [], [items, effective, weather, records, outfits, wearCounts, fixed, pairs]);
  const outfit: Outfit | undefined = candidates[index % Math.max(1, candidates.length)] ?? (fixed.length ? { items: fixed, missing: [], key: '' } : undefined);
  const openWear = (pieces: ClothesItem[] = [], record?: WearRecord) => onOpenWear(createWearDraft(effective, weatherFor(effective, weather), pieces, record));
  const changeContext = (next: Partial<ClothesDayContext>) => {
    queue.change(next); setIndex(0); setReplace(null); setError('');
  };
  useEffect(() => { if (!sync.dirty && !sync.saving) onContext(context); }, [context, sync.dirty, sync.saving, onContext]);
  useEffect(() => { if (context.purpose == null) queue.change({ purpose: '休闲' }); }, [context.purpose, queue]);
  useEffect(() => { if (sync.error instanceof ClothesError && sync.error.status === 401) onExpired(); }, [sync.error, onExpired]);
  useEffect(() => { setIndex(0); setReplace(null); }, [items, weather, effective.scene, effective.active, effective.purpose]);
  const refreshCalendar = useCallback(async () => {
    const token = ++calendarRequest.current; setCalendarBusy(true); setCalendarError('');
    try {
      const result = await clothesRequest<ClothesCalendar>('GET', { view: 'calendar', date: initial.date, timezone: initial.timezone });
      if (token === calendarRequest.current) setCalendar(result);
    } catch (cause) {
      if (token === calendarRequest.current) {
        if (cause instanceof ClothesError && cause.status === 401) onExpired();
        setCalendarError('日历更新失败');
      }
    } finally { if (token === calendarRequest.current) setCalendarBusy(false); }
  }, [initial.date, initial.timezone, onExpired]);
  useEffect(() => {
    void refreshCalendar();
    const interval = window.setInterval(() => { if (!document.hidden) void refreshCalendar(); }, 5 * 60000);
    return () => { clearInterval(interval); calendarRequest.current++; };
  }, [refreshCalendar]);
  const locate = useCallback((explicit: boolean) => {
    if (!navigator.geolocation) { setGeoError('当前浏览器无法定位'); return; }
    const token = ++geoRequest.current; setGeoBusy(true); setGeoError('');
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      if (token !== geoRequest.current) return;
      const found: ClothesLocation = { name: '当前位置', latitude: coords.latitude, longitude: coords.longitude, source: 'geo' };
      setGeoBusy(false);
      if (explicit || !contextRef.current.location || contextRef.current.location.source === 'geo') {
        // Automatic refresh never takes priority over a manual selection made while GPS was pending.
        if (!explicit && contextRef.current.location && contextRef.current.location.source !== 'geo') return;
        queue.change({ location: found });
      }
    }, () => {
      if (token !== geoRequest.current) return;
      setGeoBusy(false); setGeoError('定位失败，请选择城市');
      if (contextRef.current.location?.source === 'geo') {
        queue.change({ location: null });
      }
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }, [queue]);
  useEffect(() => {
    if (past || future || calendarLocation?.travel) return;
    let active = true;
    let attempted = false;
    const auto = async () => {
      if (contextRef.current.location && contextRef.current.location.source !== 'geo') return;
      let permission: PermissionState | undefined;
      try { permission = (await navigator.permissions?.query({ name: 'geolocation' }))?.state; } catch { /* Safari may not expose Permissions API. */ }
      if (!active) return;
      if (permission === 'denied') { setGeoError('定位未授权，请选择城市'); return; }
      if (permission === 'granted' || !attempted) { attempted = true; locate(false); }
    };
    void auto(); window.addEventListener('focus', auto);
    return () => { active = false; geoRequest.current++; window.removeEventListener('focus', auto); };
  }, [locate, past, future, calendarLocation?.travel]);
  useEffect(() => {
    if (!location) { setWeatherState({ weather: null, stale: false }); return; }
    const abort = new AbortController(); let active = true;
    // Never show weather from the previous destination while a request is pending.
    setWeatherState((value) => value.weather && value.weather.date === initial.date && value.weather.timezone === effective.timezone && Math.abs(value.weather.latitude - location.latitude) < .001
      && Math.abs(value.weather.longitude - location.longitude) < .001 ? value : { weather: null, stale: false });
    const load = async () => {
      setWeatherBusy(true);
      try {
        const result = await clothesRequest<WeatherResult>('GET', { view: 'weather', date: initial.date, timezone: effective.timezone,
          latitude: location.latitude, longitude: location.longitude }, abort.signal);
        if (active) setWeatherState(result);
      } catch (cause) {
        if (active) {
          if (cause instanceof ClothesError && cause.status === 401) onExpired();
          setWeatherState((value) => ({ ...value, stale: true, error: '天气更新失败' }));
        }
      } finally { if (active) setWeatherBusy(false); }
    };
    void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30 * 60000);
    const focus = () => setWeatherRetry((value) => value + 1);
    window.addEventListener('focus', focus);
    return () => { active = false; abort.abort(); clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [location?.latitude, location?.longitude, initial.date, effective.timezone, weatherRetry, onExpired]);
  function failed(cause: unknown) {
    if (cause instanceof ClothesError) {
      if (cause.status === 401) onExpired();
      if (cause.wardrobeChanged) onRefresh();
    }
    setError(cause instanceof Error ? cause.message : '保存失败，请重试');
  }
  const historyRecords = [...new Map([...older, ...records].map((record) => [wearId(record), record])).values()].filter((record) => !outfits.some((outfit) => wearId(outfit) === wearId(record))).sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? '').localeCompare(a.time ?? ''));
  async function loadHistory() {
    const last = historyRecords.at(-1)?.date; if (!last) return;
    setBusy(true); setError('');
    try {
      const date = new Date(Date.parse(`${last}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const result = await clothesRequest<{ records: WearRecord[] }>('GET', { view: 'history', date });
      setOlder((value) => [...value, ...result.records]); setMoreHistory(new Set(result.records.map((record) => record.date)).size === 30);
    } catch (cause) { failed(cause); } finally { setBusy(false); }
  }
  const destinations = calendarDestinations(calendar?.events ?? []);
  const selectCity = (city: ClothesLocation) => {
    geoRequest.current++; setGeoBusy(false); setGeoError(''); setCityQuery(null);
    changeContext({ location: { ...city, source: 'manual' }, timezone: city.timezone ?? context.timezone });
  };
  const replaceItem = outfit?.items.find((item) => item.id === replace);
  return <>
    <section className="clothes-today-records" aria-label={past ? '历史穿搭' : tomorrow ? '明日穿搭' : future ? '未来穿搭' : '今日穿搭'}>
      <div className="clothes-row clothes-section-heading"><h2><button className="clothes-day-toggle" title={past || future ? '返回今天' : '切换到明天'} onClick={() => onToggleDay(location)}>{datedHeading ? `${initial.date.slice(5).replace('-', '.')} 穿搭` : tomorrow ? '明天穿啥' : '今天穿了什么'}</button></h2><button className="life-primary" onClick={() => openWear()}>{hasWearDraft ? '继续记录' : todayRecords.length ? '再记一套' : past ? '补记穿搭' : future ? '搭一套' : '记录穿搭'}</button></div>
      {todayRecords.length ? todayRecords.map((record, i) => <article className="clothes-daily-record" key={wearId(record)}>
        <div className="clothes-row"><strong>{`第 ${i + 1} 套`}{record.purpose ? ` · ${record.purpose}` : ''} · {record.kind === 'styled' ? '搭了' : '穿了'}</strong><button className="clothes-link" onClick={() => openWear([], record)}>编辑穿搭</button></div>
        <WearDetails record={record} />
        <div className="clothes-history-pieces">{record.items.map((item) => <figure key={item.id}><ItemPhoto item={item} current={items.find((piece) => piece.id === item.id)} /><figcaption>{item.name}</figcaption></figure>)}</div>
      </article>) : <p className="clothes-muted">{past ? '这天还没有穿搭记录' : future ? '这天还没有搭配' : '今天还没有记录穿搭'}</p>}
    </section>
    <section className="clothes-context" aria-label="当天条件">
      <div className="clothes-row"><div className="clothes-location"><span className="clothes-label">地点</span><button onClick={() => setCityQuery('')}>{location?.name ?? '选择城市'} <span aria-hidden="true">⌄</span></button></div>
        {!past && !future && <button className="clothes-link" disabled={geoBusy || busy} onClick={() => locate(true)}>{geoBusy ? '定位中…' : '定位'}</button>}</div>
      {(calendarLocation?.locations.length ?? 0) > 1 && <div className="clothes-destinations"><span className="clothes-label">出游目的地</span>{calendarLocation!.locations.map((city) => <button key={`${city.latitude}:${city.longitude}`} onClick={() => selectCity(city)}>{city.name}</button>)}</div>}
      {geoError && <p className="clothes-status" role="status">{geoError}</p>}
      {destinations.length > 0 && <div className="clothes-destinations"><span className="clothes-label">日程地点</span>{destinations.map((destination) => <button key={destination} onClick={() => setCityQuery(destination)}>{destination}</button>)}</div>}
      <div className="clothes-weather">
        {weather ? <><span title={weatherSymbol(weather.code)?.label} aria-label={weatherSymbol(weather.code)?.label}>{weatherSymbol(weather.code)?.icon}</span><strong>{future || past ? `${Math.round(weather.min)}–${Math.round(weather.max)}` : Math.round(weather.temperature)}°</strong><div><span>{future ? `预报 · 体感 ${Math.round(weather.apparentMin)}–${Math.round(weather.apparent)}°` : `体感 ${Math.round(weather.apparent)}° · ${Math.round(weather.min)}–${Math.round(weather.max)}°`}</span><span>{dailyWeatherLabel(weather).split(' · ')[0]} · 风 {Math.round(weather.wind)} km/h</span></div></>
          : <span className="clothes-muted">{weatherBusy ? '天气加载中…' : location ? past ? '暂无历史天气' : '暂无天气' : '请选择城市'}</span>}
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>
      </div>
      {(weatherState.error || weatherState.stale) && <div className="clothes-status" role="status">天气更新失败 <button disabled={weatherBusy} onClick={() => setWeatherRetry((v) => v + 1)}>重试</button></div>}
      {weather && <div className="clothes-updated">{weatherState.stale ? '旧天气 · ' : ''}{new Date(weather.fetchedAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 更新</div>}
      <fieldset disabled={busy} className="clothes-fields clothes-context-fields">
        <label>场景<select aria-label="场景" value={effective.scene ?? ''} onChange={(e) => changeContext({ scene: e.target.value as ClothesDayContext['scene'] || null })}><option value="">待选择</option>{SCENES.map((scene) => <option key={scene}>{scene}</option>)}</select></label>
        <label>运动／多走路<select aria-label="运动或多走路" disabled={effective.purpose === '运动'} value={effective.active === null ? '' : String(effective.active)} onChange={(e) => changeContext({ active: e.target.value === '' ? null : e.target.value === 'true' })}><option value="">待选择</option><option value="false">没有</option><option value="true">有运动或走很多路</option></select></label>
        <label>室内温度 °C<input type="number" aria-label="当天室内温度" min={-60} max={60} step={0.5} placeholder="未记录" value={context.indoorTemperature ?? ''} onChange={(e) => changeContext({ indoorTemperature: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        <label className="clothes-check clothes-full"><input type="checkbox" checked={Boolean(context.manualWeather)} onChange={(e) => changeContext({ manualWeather: e.target.checked ? { temperature: Number(manualTemperature), rain: false } : null })} />手填天气</label>
        {context.manualWeather && <><label>温度 °C<input aria-label="温度" type="number" min={-60} max={60} value={manualTemperature} onChange={(e) => { setManualTemperature(e.target.value); if (e.target.value !== '' && Number.isFinite(Number(e.target.value))) changeContext({ manualWeather: { ...context.manualWeather!, temperature: Number(e.target.value) } }); }} /></label><label>雨况<select aria-label="雨况" value={String(context.manualWeather.rain)} onChange={(e) => changeContext({ manualWeather: { ...context.manualWeather!, rain: e.target.value === 'true' } })}><option value="false">无雨</option><option value="true">有雨</option></select></label></>}
      </fieldset>
      <div className="clothes-row clothes-calendar-status"><span className={calendarError ? 'clothes-error' : 'clothes-muted'}>{calendarBusy ? '日历更新中…' : calendarError || (calendar?.connected ? `日程 ${calendar.events.length} 项` : 'Outlook 未连接')}</span>
        <div><button className="clothes-link" disabled={calendarBusy} onClick={() => void refreshCalendar()}>{calendarError ? '重试' : '刷新日历'}</button><span className="clothes-muted" role="status">{sync.saving ? '保存中…' : sync.error ? '' : sync.dirty ? '' : context.revision ? '已保存' : ''}</span></div></div>
      {calendar?.events.length ? <details className="clothes-events"><summary>当日日程</summary>{calendar.events.map((event, i) => <div key={i}><span>{event.allDay ? '全天' : new Date(event.startDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span>{event.title}{event.location && <small>{event.location}</small>}</span></div>)}</details> : null}
    </section>
    {!past && <section className="clothes-outfit" aria-label="穿搭推荐">
      <div className="clothes-row clothes-section-heading"><h2>{tomorrow ? '明日穿搭推荐' : future ? `${initial.date.slice(5).replace('-', '.')} 穿搭推荐` : '穿搭推荐'}</h2><button className="clothes-link" disabled={candidates.length < 2 || busy} onClick={() => { setIndex((v) => v + 1); setReplace(null); }}>换一套</button></div>
      <div className="clothes-fields clothes-picker-controls"><label>用途<select aria-label="推荐用途" value={effective.purpose ?? ''} onChange={(e) => changeContext({ purpose: e.target.value as Purpose || null })}><option value="">请选择</option>{PURPOSES.filter((purpose) => purpose !== '睡觉').map((purpose) => <option key={purpose} value={purpose}>{PURPOSE_LABELS[purpose]}</option>)}</select></label></div>
      {outfit?.items.length ? <><OutfitPieces items={outfit.items} fixed={fixed} onReplace={(item) => setReplace(item.id)} onUnpin={(item) => { setFixed((value) => value.filter((piece) => piece.id !== item.id)); setIndex(0); setReplace(null); }} />
          <div className="clothes-row clothes-add-layers">
            <button type="button" className="clothes-link" onClick={() => setAdding('上衣')}>＋ 叠穿上衣</button>
            <button type="button" className="clothes-link" onClick={() => setAdding('外套')}>＋ 加件外套</button>
            <button type="button" className="clothes-link" onClick={() => setAdding('下装')}>＋ 叠穿下装</button>
          </div></>
          : <div className="clothes-empty">{!items.length ? <><p>衣柜还是空的</p><button className="clothes-link" onClick={onWardrobe}>添加衣物</button></> : !effective.purpose ? '请选择用途' : !effective.scene || effective.active === null ? '请补全当天条件' : !weatherFor(effective, weather) ? '请选择城市或手填天气' : '暂无合适衣物'}</div>}
      {outfit?.missing.length ? <p className="clothes-status">缺少：{outfit.missing.join('、')}</p> : null}
      {fixed.length > 0 && !candidates.length && <p className="clothes-status" role="status">已选衣物不适合当前条件</p>}
      {replaceItem && <PiecePicker key={replaceItem.id} previous={replaceItem} choices={replacements(replaceItem, { items: fixed, missing: [], key: '' }, items, effective, weather)} selected={outfit!.items} pairCounts={pairs}
        onClose={() => setReplace(null)} onSelect={(item) => { setFixed((value) => pinReplacement(value, replaceItem, item)); setIndex(0); setReplace(null); }} />}
      {adding && <PiecePicker title={`添加${adding}`} choices={eligibleItems(items, adding, effective, weatherFor(effective, weather)!, outfit?.items ?? [])} selected={outfit?.items ?? []} pairCounts={pairs}
        onClose={() => setAdding(null)} onSelect={(item) => {
          setFixed((value) => {
            const existing = outfit?.items.filter((i) => categoryLabel(i.category) === adding && !value.some((v) => v.id === i.id)) ?? [];
            return [...value, ...existing, item];
          });
          setIndex(0); setAdding(null);
        }} />}
      {outfit && <OutfitWarmth items={outfit.items} />}
      <div className="clothes-confirm"><button className="life-primary" disabled={!outfit?.items.length || !candidates.length} onClick={() => onOpenWear({ ...createWearDraft(effective, weatherFor(effective, weather), outfit?.items), adopted: true })}>采纳</button></div>
    </section>}
    {error && <div className="life-error" role="alert">{error}</div>}
    {sync.error && <div className="life-error" role="alert">{sync.error.message} {sync.conflict === null && <button onClick={() => void queue.flush()}>重试保存</button>}</div>}
    {sync.conflict !== null && <div className="life-conflict"><button onClick={() => queue.resolveConflict()}>保留当前内容</button></div>}
    {!past && <TripPlanner owner={owner} date={initial.date} timezone={initial.timezone} items={items} records={records} wearCounts={wearCounts} onExpired={onExpired} onRefresh={onRefresh} />}
    <section className="clothes-history"><button className="clothes-row" aria-expanded={history} onClick={() => setHistory(!history)}><span>穿搭历史</span><span>{history ? '−' : '+'}</span></button>
      {history && <div>{historyRecords.length ? historyRecords.map((record) => <article key={wearId(record)}>
        <div className="clothes-row"><strong>{record.date} {record.purpose} · 穿了</strong><button className="clothes-link" onClick={() => onReviewDay(record.date)}>回顾这天</button></div>
        <WearDetails record={record} />
        <div className="clothes-history-pieces">{record.items.map((item) => <figure key={item.id}><ItemPhoto item={item} current={items.find((piece) => piece.id === item.id)} /><figcaption>{item.name}</figcaption></figure>)}</div>
        <button className="clothes-link" onClick={() => openWear([], record)}>补记体感／编辑穿搭</button>
      </article>) : <p className="clothes-muted">暂无记录</p>}{moreHistory && historyRecords.length >= 30 && <button disabled={busy} onClick={() => void loadHistory()}>更早记录</button>}</div>}
    </section>
    {cityQuery !== null && <CityPicker initial={cityQuery} onClose={() => setCityQuery(null)} onSelect={selectCity} />}
  </>;
}
