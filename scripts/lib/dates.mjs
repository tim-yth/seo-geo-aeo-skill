// Timezone-aware calendar math (no dependencies) and Search Console data-lag helpers.
import { UserError } from './util.mjs';

export const GSC_TZ = 'America/Los_Angeles'; // Search Console reports days in Pacific Time.
export const DEFAULT_FINAL_LAG_DAYS = 3; // "final" data usually settles 2-3 days after the PT day ends.

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(value) {
  const m = YMD_RE.exec(String(value || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === value;
}

export function assertYmd(value, label = 'date') {
  if (!isYmd(value)) throw new UserError(`Invalid ${label} "${value}" (expected YYYY-MM-DD)`);
  return value;
}

const toUtc = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export function addDays(ymd, days) {
  return fromUtc(toUtc(ymd) + days * 86400000);
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

export function spanDays(start, end) {
  return diffDays(start, end) + 1;
}

/** 0 = Sunday ... 6 = Saturday (calendar date, timezone independent). */
export function weekday(ymd) {
  return new Date(toUtc(ymd)).getUTCDay();
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function listDays(start, end) {
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

export function validTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function ymdInTz(date = new Date(), timeZone = 'UTC') {
  if (!validTimeZone(timeZone)) throw new UserError(`Unknown time zone "${timeZone}"`, { hint: 'Use an IANA name such as Asia/Taipei, Europe/Berlin or America/New_York.' });
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
export function tzOffsetMs(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) if (part.type !== 'literal') p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** UTC instant (ms) of local midnight for `ymd` in `timeZone`. */
export function zonedMidnight(ymd, timeZone) {
  const guess = toUtc(ymd);
  const first = guess - tzOffsetMs(guess, timeZone);
  const second = guess - tzOffsetMs(first, timeZone);
  return second;
}

/** Pacific-Time (GSC) calendar days that overlap the given local day in `siteTz`. */
export function gscDaysForLocalDate(localYmd, siteTz) {
  const start = zonedMidnight(localYmd, siteTz);
  const end = zonedMidnight(addDays(localYmd, 1), siteTz) - 1;
  const a = ymdInTz(new Date(start), GSC_TZ);
  const b = ymdInTz(new Date(end), GSC_TZ);
  return a === b ? [a] : listDays(a, b);
}

export function todayInTz(timeZone) {
  return ymdInTz(new Date(), timeZone);
}

export function gscToday() {
  return ymdInTz(new Date(), GSC_TZ);
}

/** Offline estimate of the newest GSC day that is safe to use. */
export function estimatedGscEnd(dataState = 'final') {
  return addDays(gscToday(), dataState === 'final' ? -DEFAULT_FINAL_LAG_DAYS : -1);
}

/**
 * Resolve a date range from flags. `latestEnd` is the newest usable day (e.g. from the API).
 * Without --start, the window is --days long and ends at --end (or latestEnd).
 */
export function resolveRange({ start, end, days, latestEnd, defaultDays = 28 }) {
  if (start) assertYmd(start, '--start');
  if (end) assertYmd(end, '--end');
  const e = end || latestEnd;
  if (!e) throw new UserError('No end date available; pass --end YYYY-MM-DD');
  const s = start || addDays(e, -((days || defaultDays) - 1));
  if (s > e) throw new UserError(`Start date ${s} is after end date ${e}`);
  return { start: s, end: e, days: spanDays(s, e) };
}

/**
 * Equal-length pre/post windows around a deploy. The deploy day (every GSC day that overlaps the
 * deploy date in the site time zone) is excluded. If the window length is not a multiple of 7 and
 * alignment is on, the pre window is shifted back so both windows start on the same weekday.
 */
export function deployWindows(deployDate, windowDays, { siteTz = 'UTC', alignWeekday = true, excludeExtraDays = 0 } = {}) {
  assertYmd(deployDate, 'deploy date');
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new UserError('Window length must be a positive whole number of days');
  const excluded = gscDaysForLocalDate(deployDate, siteTz);
  for (let i = 0; i < excludeExtraDays; i++) excluded.push(addDays(excluded[excluded.length - 1], 1));
  const postStart = addDays(excluded[excluded.length - 1], 1);
  const postEnd = addDays(postStart, windowDays - 1);
  let preEnd = addDays(excluded[0], -1);
  let preStart = addDays(preEnd, -(windowDays - 1));
  let shift = 0;
  if (alignWeekday && windowDays % 7 !== 0) {
    shift = (weekday(preStart) - weekday(postStart) + 7) % 7;
    preStart = addDays(preStart, -shift);
    preEnd = addDays(preEnd, -shift);
  }
  return {
    pre: { start: preStart, end: preEnd, days: windowDays },
    post: { start: postStart, end: postEnd, days: windowDays },
    excluded,
    shift,
  };
}

/** Same-length window immediately before [start, end]. */
export function previousWindow(start, end) {
  const n = spanDays(start, end);
  return { start: addDays(start, -n), end: addDays(start, -1), days: n };
}

/** Year-over-year window shifted by 364 days (keeps weekdays aligned). */
export function yoyWindow(range) {
  return { start: addDays(range.start, -364), end: addDays(range.end, -364), days: range.days };
}

/** Site-local calendar date on which GSC "final" data for the given PT day should exist. */
export function finalDataReadyOn(gscDay, siteTz, lagDays = DEFAULT_FINAL_LAG_DAYS) {
  const noonPt = zonedMidnight(addDays(gscDay, lagDays), GSC_TZ) + 12 * 3600000;
  return ymdInTz(new Date(noonPt), siteTz);
}

export function fmtRange(r) {
  return `${r.start} -> ${r.end} (${spanDays(r.start, r.end)} days)`;
}

/** "YYYY-MM-DD HH:MM" of an instant in a time zone. */
export function formatInTz(instantMs, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`;
}

/** Parse "YYYY-MM-DD", "YYYY-MM-DD HH:MM" (local to timeZone) or an ISO string with offset. Returns epoch ms. */
export function parseLocalDateTime(value, timeZone) {
  const s = String(value || '').trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && /T/.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new UserError(`Cannot parse time "${value}"`);
    return t;
  }
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (!m) throw new UserError(`Cannot parse time "${value}" (use YYYY-MM-DD, "YYYY-MM-DD HH:MM" in the site time zone, or ISO with offset)`);
  assertYmd(m[1], 'date');
  const [y, mo, d] = m[1].split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, Number(m[2] || 0), Number(m[3] || 0));
  const first = guess - tzOffsetMs(guess, timeZone);
  return guess - tzOffsetMs(first, timeZone);
}

/** Human-readable zone: "Etc/GMT-10" really means UTC+10 (POSIX signs are inverted). */
export function describeTz(tz) {
  const m = /^Etc\/GMT([+-])(\d{1,2})$/.exec(String(tz || ''));
  return m ? `${tz} (= UTC${m[1] === '-' ? '+' : '-'}${m[2]}; POSIX signs are inverted)` : String(tz || '');
}
