import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const errors = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), normalized = file.replaceAll('\\', '/');
    if (entry.isDirectory()) { if (!/\/(?:boncal|_bonCal)$/.test(normalized)) await visit(file); continue; }
    if (!/\.tsx?$/.test(file) || /\.(?:test|spec)\./.test(file)) continue;
    const text = await readFile(file, 'utf8');
    if (/\b(?:async\s+)?function\s+(?:buildOutlookSnapshot|resolveDailyContext|detectAllTrips|tripDestinationQueries|calendarDestinations)\b/.test(text)) errors.push(`${normalized}: 公共日历规则必须位于 bonCal`);
    if (normalized.startsWith('api/') && /\b(?:fetchCalendar|parseOutlookCalendar)\s*\(/.test(text)) errors.push(`${normalized}: 日历源读取必须经过 bonCal`);
    if (normalized.startsWith('api/') && /kv\.(?:get|set)\([^\n]*['"](?:calendar-tags|trip-tags)['"]/.test(text)) errors.push(`${normalized}: 公共字段必须经过 bonCal 仓储`);
  }
}
await visit('api'); await visit('src');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('bonCal 边界检查通过');
