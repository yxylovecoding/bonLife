import { isNonTravelCalendarTitle, type OutlookDayEvent } from './events.js';

export function calendarDestinations(events: Pick<OutlookDayEvent, 'title' | 'location'>[]) {
  return [...new Set(events.filter(event => !isNonTravelCalendarTitle(event.title)).flatMap(event => {
    if (event.location?.trim()) return [event.location.trim()];
    const match = event.title.trim().match(/(?:前往|去往|到达|目的地[：:]|[→➜])\s*([^，,。；;（(\n]{2,40})$/)
      ?? event.title.trim().match(/^([^，,。；;（(\n]{2,20}?)(?:出差|旅行|旅游)$/);
    return match ? [match[1].trim()] : [];
  }))];
}

// Only explicit destination candidates are geocoded; a title is never divided into guessed daily stops.
export function tripDestinationQueries(title: string): string[] {
  const name = title.trim().replace(/^(?:20)?\d{2}[.年/-]\d{1,2}(?:月|[./-]\d{1,2}日?)?\s*/, '')
    .replace(/^[\s:：_-]+/, '');
  return [...new Set(name.split(/[&＆、/→➜+＋—–]|\s+(?:-|和|及)\s+/).map((part) => part.trim()
    .replace(/^(?:前往|去往|到达|目的地[：:]|去)/, '')
    .replace(/(?:出差|出游|旅行|旅游|之旅|游玩|演唱会|会议|开会|探亲|度假)(?:.*)?$/, '')
    .replace(/[（(].*$/, '').trim()).filter((part) => !isNonTravelCalendarTitle(part) && /^[\p{L}\s·.-]{2,40}$/u.test(part)))].slice(0, 4);
}
