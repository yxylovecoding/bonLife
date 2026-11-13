import type { VercelRequest, VercelResponse } from '@vercel/node';

import { readHolidayYear } from './_bonCal/holidays.js';

function parseYear(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  if (year < 2000 || year > 2100) return null;
  return year;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const year = parseYear(req.query.year);
  if (year === null) {
    return res.status(400).json({ error: 'invalid year' });
  }

  try {
    const data = await readHolidayYear(year);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return res.status(502).json({ error: 'holiday fetch failed', message });
  }
}
