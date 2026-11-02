// External events that confound before/after comparisons: Google ranking updates and incidents (Search Status
// Dashboard), Search Console data anomalies and reporting changes (scripts/data/google-events.json), newer
// dashboard incidents fetched into the workspace (search-events.mjs refresh) and site-specific external events
// logged with log-change.mjs (type external-event). All dates are Pacific Time days (the Search Console day).
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS_DIR, readJson, writeJson } from './util.mjs';
import { addDays, gscDaysForLocalDate, gscToday, ymdInTz, GSC_TZ, diffDays } from './dates.mjs';

export const EVENTS_FILE = path.join(SCRIPTS_DIR, 'data', 'google-events.json');
export const STATUS_INCIDENTS_URL = 'https://status.search.google.com/incidents.json';
const RANKING_KINDS = new Set(['core', 'spam', 'ranking-other']);

export function loadLedger(file = EVENTS_FILE) {
  return readJson(file, { events: [], gscAnomalies: [], reportingChanges: [], unverified: [], bufferDaysAfterEnd: {} });
}

export function statusCacheFile(ws) {
  return ws.path('data', 'events', 'google-status.json');
}

/** Map a Search Status Dashboard incident (incidents.json shape) to a ledger event. */
export function incidentToEvent(inc) {
  const service = String(inc.service_name || (inc.affected_products && inc.affected_products[0] && inc.affected_products[0].title) || '').trim();
  const title = String(inc.external_desc || '').replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  let kind = service.toLowerCase() || 'other';
  if (service === 'Ranking') kind = /core update/i.test(title) ? 'core' : /spam update/i.test(title) ? 'spam' : /discover/i.test(title) ? 'discover' : 'ranking-other';
  const start = inc.begin ? ymdInTz(new Date(inc.begin), GSC_TZ) : null;
  const end = inc.end ? ymdInTz(new Date(inc.end), GSC_TZ) : null;
  return {
    id: `gsd-${inc.id}`,
    kind,
    title: kind === 'ranking-other' || ['indexing', 'serving', 'crawling'].includes(kind) ? `${service} incident: ${title}` : title,
    start,
    end,
    startTime: inc.begin || null,
    endTime: inc.end || null,
    scope: kind === 'discover' ? 'discover' : 'search',
    url: inc.uri ? `https://status.search.google.com/${String(inc.uri).replace(/^\//, '')}` : 'https://status.search.google.com/summary',
    source: 'Google Search Status Dashboard',
    verified: true,
  };
}

/** Severity of an event for a web-search comparison: warn (likely confounder), info (other report/scope), note (unverified). */
export function severityOf(e) {
  if (e.verified === false) return 'note';
  if (e.origin === 'site-log') return 'warn';
  if (RANKING_KINDS.has(e.kind)) return 'warn';
  if (e.kind === 'gsc-anomaly') return e.scope === 'search' ? 'warn' : 'info';
  if (e.kind === 'measurement') return e.scope === 'search' ? 'warn' : 'info';
  if (e.kind === 'serp-feature') return 'note';
  return 'info';
}

/**
 * Every known event, normalized: {id, kind, title, start, end, ongoing, pattern ('period'|'step'), affects[], scope,
 * url, source, verified, origin ('ledger'|'workspace'|'site-log'), bufferDays, severity}. `ws` is optional.
 */
export function loadEvents(ws, { includeSite = true, includeUnverified = true, today = gscToday(), file = EVENTS_FILE } = {}) {
  const ledger = loadLedger(file);
  const buffers = ledger.bufferDaysAfterEnd || {};
  const byId = new Map();
  const put = (e, origin) => {
    if (!e || !e.id || !e.start) return;
    const prev = byId.get(e.id);
    byId.set(e.id, { ...(prev || {}), ...e, origin: prev && prev.origin === 'ledger' && origin === 'workspace' ? 'ledger+workspace' : origin });
  };
  for (const e of ledger.events || []) put({ pattern: 'period', affects: [], ...e }, 'ledger');
  for (const e of ledger.gscAnomalies || []) put({ kind: 'gsc-anomaly', pattern: 'period', ...e }, 'ledger');
  for (const e of ledger.reportingChanges || []) put({ kind: 'measurement', pattern: 'step', ...e }, 'ledger');
  if (includeUnverified) for (const e of ledger.unverified || []) put({ kind: 'measurement', pattern: 'step', ...e, verified: false }, 'ledger');
  if (ws) {
    const cache = statusCacheFile(ws);
    if (fs.existsSync(cache)) {
      const data = readJson(cache, { incidents: [] });
      for (const inc of data.incidents || []) {
        const e = incidentToEvent(inc);
        if (e.start) put({ pattern: 'period', affects: [], ...e }, 'workspace');
      }
    }
    if (includeSite) {
      const wavesFile = ws.path('logs', 'experiments.json');
      const waves = fs.existsSync(wavesFile) ? readJson(wavesFile, []) : [];
      for (const w of Array.isArray(waves) ? waves : []) {
        if (w.type !== 'external-event' || !w.date) continue;
        const tz = w.timezone || ws.timezone();
        const first = gscDaysForLocalDate(w.date, tz)[0];
        const lastDays = gscDaysForLocalDate(w.until && w.until >= w.date ? w.until : w.date, tz);
        put({ id: w.id, kind: 'site', title: w.title || w.id, start: first, end: lastDays[lastDays.length - 1], pattern: 'period', affects: [], scope: 'search', url: '', source: 'logs/experiments.json (external-event)', verified: true, note: w.notes || w.what || '' }, 'site-log');
      }
    }
  }
  const out = [];
  for (const e of byId.values()) {
    const ongoing = !e.end;
    const end = e.end || today;
    const ev = { affects: [], scope: 'search', ...e, end, ongoing, bufferDays: e.pattern === 'period' ? Number(buffers[e.kind] ?? 0) : 0 };
    ev.severity = e.severity && ['warn', 'info', 'note'].includes(e.severity) ? e.severity : severityOf(ev);
    out.push(ev);
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id.localeCompare(b.id)));
}

function overlapDays(aStart, aEnd, bStart, bEnd) {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return s <= e ? diffDays(s, e) + 1 : 0;
}

/**
 * Events that confound a comparison of `windows` ([{name, start, end}], e.g. pre/post or baseline/final).
 * Ranking updates, site events and step changes count when they fall anywhere between the first window's start and
 * the last window's end (an update between the windows still changes the post data); period anomalies count only
 * when they touch a window. `scopes` filters event scopes (default: search-level events).
 */
export function overlapEvents(events, windows, { scopes = ['search', 'search-desktop'], appearance = false, kinds = null, minSeverity = 'note' } = {}) {
  const ws = windows.filter((w) => w && w.start && w.end && w.start !== '?');
  if (!ws.length) return [];
  const spanStart = ws.map((w) => w.start).sort()[0];
  const spanEnd = ws.map((w) => w.end).sort().slice(-1)[0];
  const rank = { warn: 0, info: 1, note: 2 };
  const result = [];
  for (const e of events) {
    if (kinds && !kinds.includes(e.kind)) continue;
    const scopeOk = scopes.includes(e.scope) || (appearance && String(e.scope).startsWith('search-appearance:'));
    if (!scopeOk) continue;
    if (rank[e.severity] > rank[minSeverity]) continue;
    const effEnd = e.bufferDays ? addDays(e.end, e.bufferDays) : e.end;
    const perWindow = ws.map((w) => ({ name: w.name, days: overlapDays(e.start, effEnd, w.start, w.end) })).filter((x) => x.days > 0);
    const anomalyPeriod = e.kind === 'gsc-anomaly' && e.pattern === 'period';
    const spanOverlap = overlapDays(e.start, effEnd, spanStart, spanEnd) > 0;
    if (anomalyPeriod ? !perWindow.length : !spanOverlap) continue;
    result.push({ event: e, windows: perWindow, between: !perWindow.length, effectiveEnd: effEnd });
  }
  return result;
}

/** Metrics that cannot be compared across `windows` because of Search Console data anomalies or reporting changes. */
export function metricReliability(events, windows, opts = {}) {
  const hits = overlapEvents(events, windows, { ...opts, kinds: ['gsc-anomaly', 'measurement'] }).filter((h) => (h.event.affects || []).length && h.event.verified !== false);
  const unreliable = new Set();
  for (const h of hits) for (const m of h.event.affects) unreliable.add(m);
  return { unreliable: [...unreliable], hits };
}

const label = (e) => {
  if (e.origin === 'site-log') return `Site event ${e.id}: ${e.title}`;
  if (e.kind === 'gsc-anomaly') return `Search Console data anomaly: ${e.title}`;
  if (e.verified === false) return `Unverified (third-party): ${e.title}`;
  return `Google ${e.title}`;
};

/** One-line human description of an overlap returned by overlapEvents. */
export function describeOverlap(h) {
  const e = h.event;
  const when = `${e.start}${e.end !== e.start ? ` -> ${e.ongoing ? `ongoing (${e.end})` : e.end}` : ''} PT${e.bufferDays ? ` (+${e.bufferDays} days settling)` : ''}`;
  const where = h.between ? 'falls between the windows (the later window reflects it)' : `overlaps ${h.windows.map((w) => `${w.name} by ${w.days} day${w.days === 1 ? '' : 's'}`).join(', ')}`;
  const affects = (e.affects || []).length ? `; affects ${e.affects.join('/')}` : '';
  return `${label(e)} (${when}) ${where}${affects}.${e.url ? ` ${e.url}` : ''}`;
}

/** Advice for a list of overlaps (empty when nothing overlaps). */
export function overlapAdvice(hits) {
  const advice = [];
  if (hits.some((h) => RANKING_KINDS.has(h.event.kind))) advice.push('A Google ranking update overlaps the comparison: do not credit or blame the change from these windows alone; compare windows outside the update, rely on treatment vs control, or start a new baseline after it ends.');
  if (hits.some((h) => h.event.kind === 'gsc-anomaly' && h.event.scope === 'search' && (h.event.affects || []).includes('impressions'))) advice.push('A Search Console impressions anomaly touches a window: impressions, CTR and average position are not comparable; judge on clicks only.');
  if (hits.some((h) => h.event.origin === 'site-log')) advice.push('A logged site event overlaps: report it as interference in the review.');
  return advice;
}

/** Fetch the dashboard's incidents.json and upsert it into the workspace cache (it only keeps about a year). */
export async function refreshStatusEvents(ws, { url = process.env.SEO_AGENT_STATUS_ENDPOINT || STATUS_INCIDENTS_URL, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error(`${url} did not return a JSON array`);
  const file = statusCacheFile(ws);
  const cache = fs.existsSync(file) ? readJson(file, { incidents: [] }) : { incidents: [] };
  const byId = new Map((cache.incidents || []).map((i) => [i.id, i]));
  let added = 0;
  let updated = 0;
  const now = new Date().toISOString();
  for (const inc of list) {
    if (!inc || !inc.id) continue;
    const slim = { id: inc.id, begin: inc.begin, end: inc.end || null, external_desc: inc.external_desc, service_name: inc.service_name, uri: inc.uri, firstSeen: (byId.get(inc.id) || {}).firstSeen || now };
    const prev = byId.get(inc.id);
    if (!prev) added++;
    else if (prev.end !== slim.end || prev.external_desc !== slim.external_desc) updated++;
    byId.set(inc.id, slim);
  }
  const incidents = [...byId.values()].sort((a, b) => String(b.begin).localeCompare(String(a.begin)));
  writeJson(file, { source: url, fetchedAt: now, incidents });
  return { file, added, updated, total: incidents.length };
}

/** Days since the bundled ledger was last verified (for check-resources). */
export function ledgerAgeDays(today = gscToday(), file = EVENTS_FILE) {
  const l = loadLedger(file);
  return l.lastVerified ? Math.max(0, diffDays(l.lastVerified, today)) : null;
}
