#!/usr/bin/env node
// Guardrail monitor: final 7-calendar-day position vs an unrounded baseline, early warnings from daily data,
// click-group alarm, main-URL capture share, back-calculation and a daily table with deploy markers.
import fs from 'node:fs';
import { parseArgs, formatHelp, parseRangeArg, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, normalizeUrl, scriptCmd } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { gscClient, loadGscFile, re2ToJs } from './lib/gsc.mjs';
import { groupMetrics } from './lib/metrics.mjs';
import { addDays, listDays, gscToday, weekday, WEEKDAYS, deployWindows } from './lib/dates.mjs';
import { loadWaves } from './lib/experiments.mjs';
import { loadEvents, overlapEvents, describeOverlap, metricReliability } from './lib/events.mjs';
import { fmtNum, fmtPct, mdTable } from './lib/format.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  site: { type: 'string', placeholder: 'property', desc: 'Override gsc.siteUrl' },
  query: { type: 'string', desc: 'Ad-hoc guardrail query (instead of config.guardrails)' },
  variant: { type: 'list', placeholder: 'q', desc: 'Ad hoc: other spellings merged into the site-level series' },
  page: { type: 'string', placeholder: 'url', desc: 'Ad hoc: main URL (warning series + capture share)' },
  scope: { type: 'string', desc: 'Ad hoc: site | page (pause metric scope)', choices: ['site', 'page'] },
  baseline: { type: 'string', placeholder: 'start:end', desc: 'Ad hoc: baseline window (final data)' },
  margin: { type: 'number', desc: 'Ad hoc: stop line = baseline + margin', default: 1 },
  'max-position': { type: 'number', desc: 'Ad hoc: explicit stop line' },
  'rollback-position': { type: 'number', desc: 'Ad hoc: rollback-consideration line' },
  'warn-days': { type: 'int', desc: 'Ad hoc: consecutive days above the warn line', default: 3 },
  'click-query': { type: 'list', placeholder: 'q', desc: 'Ad hoc: fixed query group for the click alarm' },
  'min-clicks-per-day': { type: 'number', desc: 'Ad hoc: click alarm threshold' },
  'min-share': { type: 'number', desc: 'Ad hoc: main-URL capture share threshold', default: 0.9 },
  days: { type: 'int', desc: 'Days in the daily table', default: 21 },
  input: { type: 'string', placeholder: 'file', desc: 'Offline: gsc-export with date,query[,page] rows instead of the API' },
  'latest-final': { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'Offline: newest final day (default: last date in --input)' },
  json: { type: 'boolean', desc: 'Print JSON' },
  'fail-on-breach': { type: 'boolean', desc: 'Exit 2 on pause, rollback-consideration or click alarm (for schedulers)' },
};

const HELP = formatHelp({
  usage: ['node scripts/guardrail.mjs', 'node scripts/guardrail.mjs --query "pour over" --page https://www.example.com/guides/pour-over/ --baseline 2026-09-01:2026-09-07'],
  summary:
    'For each config.guardrails entry: merged-variant query, site (or page) scope, impression-weighted position over the last 7 CALENDAR days ' +
    'of FINAL data vs an unrounded baseline. States: warning (exact query + main URL above the warn line for warnDays consecutive days, ' +
    'provisional data allowed; or click group < threshold; or main-URL capture share < minShare), pause (final 7-day average >= stop line), ' +
    'rollback consideration (final week > rollback line: numbers only, also needs a manual Google SERP check and the user\'s consent). ' +
    'Prints a daily table with deploy markers from experiments.json and a back-calculation of what it would take to get back under the line.',
  spec: SPEC,
  examples: ['node scripts/guardrail.mjs', 'node scripts/guardrail.mjs --fail-on-breach   (cron)'],
  notes: [
    'Config fields per guardrail: query, variants[], queryRegex, scope (site|page), page, baseline {start,end}, margin (1.0), maxPosition, rollbackPosition, warnPosition, warnDays (3), clickQueries[], minClicksPerDay, minShare (0.9), note.',
    'Decisions use final data only. The provisional 7-day figure excludes today (a partial day). Never loosen an existing threshold; start a new, separately named baseline after a confirmed core update.',
  ],
});

const re2Quote = (s) => s.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
const exactFilter = (dimension, value) => ({ dimension, operator: 'equals', expression: value });

function weighted(rows, days) {
  const set = new Set(days);
  let impressions = 0;
  let clicks = 0;
  let pw = 0;
  for (const r of rows) {
    if (!set.has(r.date)) continue;
    impressions += r.impressions;
    clicks += r.clicks;
    pw += r.position * r.impressions;
  }
  return { impressions, clicks, position: impressions ? pw / impressions : null, clicksPerDay: clicks / days.length, days: days.length };
}

/** Pure evaluation of one guardrail from daily series; exported for tests. */
export function evaluateGuardrail(g, series, { latestFinal, today }) {
  const final7 = listDays(addDays(latestFinal, -6), latestFinal);
  const prov7 = listDays(addDays(today, -7), addDays(today, -1));
  const merged = series.merged || [];
  const finalStats = weighted(merged, final7);
  const provStats = weighted(merged, prov7);
  const baseDays = g.baseline && g.baseline.start && g.baseline.end ? listDays(g.baseline.start, g.baseline.end) : null;
  const daysOf = (rows) => baseDays || [...new Set(rows.map((r) => r.date))].sort();
  const baseline = series.baseline && series.baseline.length ? weighted(series.baseline, daysOf(series.baseline)) : null;
  const baselinePos = baseline && baseline.position !== null ? baseline.position : null;
  const stopLine = g.maxPosition !== null && g.maxPosition !== undefined ? g.maxPosition : baselinePos !== null ? baselinePos + (g.margin ?? 1) : null;
  const rollbackLine = g.rollbackPosition ?? (baselinePos !== null ? baselinePos + 1.2 : stopLine !== null ? stopLine + 0.2 : null);
  const warnLine = g.warnPosition ?? stopLine;
  // early warning: consecutive complete days (provisional allowed) above the warn line, exact query + main URL
  const exact = new Map((series.exact || series.merged || []).map((r) => [r.date, r]));
  const complete = listDays(addDays(today, -40), addDays(today, -1));
  let streak = 0;
  for (let i = complete.length - 1; i >= 0; i--) {
    const r = exact.get(complete[i]);
    if (!r || !r.impressions) {
      if (streak) break;
      continue;
    }
    if (warnLine !== null && r.position > warnLine) streak++;
    else break;
  }
  const warnDays = g.warnDays ?? 3;
  const clickBase = series.clickBaseline && series.clickBaseline.length ? weighted(series.clickBaseline, daysOf(series.clickBaseline)).clicksPerDay : null;
  const minClicks = g.minClicksPerDay ?? (clickBase !== null ? clickBase * 0.72 : null);
  const clickFinal = series.clicks ? weighted(series.clicks, final7).clicksPerDay : null;
  let share = null;
  if (g.page && series.byPage) {
    const target = normalizeUrl(g.page) || g.page;
    let mine = 0;
    let all = 0;
    for (const r of series.byPage) {
      if (!final7.includes(r.date)) continue;
      all += r.impressions;
      if ((normalizeUrl(r.page) || r.page) === target) mine += r.impressions;
    }
    share = all ? mine / all : null;
  }
  const states = {
    warning: streak >= warnDays,
    warningReasons: [],
    pause: stopLine !== null && finalStats.position !== null && finalStats.position >= stopLine,
    rollbackConsider: rollbackLine !== null && finalStats.position !== null && finalStats.position > rollbackLine,
    clickAlarm: minClicks !== null && clickFinal !== null && clickFinal < minClicks,
    lowShare: share !== null && share < (g.minShare ?? 0.9),
  };
  if (states.warning) states.warningReasons.push(`${streak} consecutive days above ${warnLine.toFixed(3)}`);
  if (states.clickAlarm) states.warningReasons.push(`click group ${clickFinal.toFixed(1)}/day < ${minClicks.toFixed(1)}`);
  if (states.lowShare) states.warningReasons.push(`main URL holds ${(share * 100).toFixed(1)}% of impressions (< ${((g.minShare ?? 0.9) * 100).toFixed(0)}%)`);
  // back-calculation: what average position the next r days need for the rolling final 7-day mean to drop below the stop line
  const flip = [];
  if (stopLine !== null && finalStats.impressions) {
    const perDay = finalStats.impressions / 7;
    for (let r = 1; r <= 6; r++) {
      const known = final7.slice(r);
      const k = weighted(merged, known);
      const n = perDay * r;
      const need = (stopLine * (k.impressions + n) - (k.position || 0) * k.impressions) / n;
      flip.push({ days: r, impressions: Math.round(n), maxPosition: need, feasible: need >= 1 });
    }
  }
  return { final7: { start: final7[0], end: final7[6], ...finalStats }, provisional7: { start: prov7[0], end: prov7[6], ...provStats }, baseline: baseline ? { ...baseline, position: baselinePos } : null, stopLine, rollbackLine, warnLine, streak, warnDays, clickFinal, minClicks, clickBaseline: clickBase, share, states, flip };
}

/**
 * Google updates / Search Console anomalies overlapping the baseline or the final 7 days. When an impressions anomaly
 * makes positions unreliable for the windows the stop line depends on, the position states are suppressed (shown as
 * a warning) and the click group decides. Mutates `ev`; exported for tests.
 */
export function applyEventChecks(g, ev, events) {
  const windows = [];
  if (g.baseline && g.baseline.start && g.baseline.end) windows.push({ name: 'baseline', start: g.baseline.start, end: g.baseline.end });
  if (ev.final7 && ev.final7.start) windows.push({ name: 'final 7 days', start: ev.final7.start, end: ev.final7.end });
  const hits = overlapEvents(events, windows);
  ev.events = hits.map((h) => ({ id: h.event.id, kind: h.event.kind, severity: h.event.severity, text: describeOverlap(h) }));
  const explicitStop = g.maxPosition !== null && g.maxPosition !== undefined;
  const posWindows = explicitStop ? windows.filter((w) => w.name !== 'baseline') : windows;
  const rel = metricReliability(events, posWindows);
  if (rel.unreliable.includes('position')) {
    const why = [...new Set(rel.hits.map((h) => h.event.title))].join('; ');
    ev.states.suppressed = { pause: ev.states.pause, rollbackConsider: ev.states.rollbackConsider };
    ev.states.pause = false;
    ev.states.rollbackConsider = false;
    ev.states.positionUnreliable = true;
    ev.states.warningReasons.push(`position thresholds disabled (${why}); judge on the click group${explicitStop ? '' : ' and set a new baseline outside the anomaly'}`);
  }
  if (hits.some((h) => ['core', 'spam', 'ranking-other'].includes(h.event.kind))) {
    ev.states.updateOverlap = true;
    ev.states.warningReasons.push('a Google ranking update overlaps the baseline or final window: confirm on the live SERP before pausing or rolling back; after a confirmed core update start a new, separately named baseline');
  }
  return ev;
}

function guardrailsFrom(ws, flags) {
  if (flags.query) {
    return [{
      query: flags.query,
      variants: flags.variant,
      page: flags.page || '',
      scope: flags.scope || 'site',
      baseline: flags.baseline ? parseRangeArg(flags.baseline, 'baseline') : null,
      margin: flags.margin,
      maxPosition: flags.maxPosition ?? null,
      rollbackPosition: flags.rollbackPosition ?? null,
      warnDays: flags.warnDays,
      clickQueries: flags.clickQuery,
      minClicksPerDay: flags.minClicksPerDay ?? null,
      minShare: flags.minShare,
      note: 'ad hoc',
    }];
  }
  return ws.guardrails().map((g) => ({ scope: 'site', margin: 1, warnDays: 3, minShare: 0.9, variants: [], clickQueries: [], ...g }));
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const guards = guardrailsFrom(ws, flags);
  if (!guards.length) {
    out('No guardrails configured. Pick 1-3 queries that must not get worse (usually the main clicks of your core pages, not the queries you are trying to win) and add them:');
    out(`  ${scriptCmd('init.mjs')} --guardrail "your core query|<maxPosition>"   then add baseline {start,end} in config.json`);
    return 0;
  }
  let gsc = null;
  let offline = null;
  let today = gscToday();
  if (flags.input) {
    const file = loadGscFile(flags.input);
    if (!file.dimensions.includes('date') || !file.dimensions.includes('query')) throw new UserError('--input needs date and query dimensions');
    const lastDate = file.rows.map((r) => r.date).sort().pop();
    const firstIncomplete = file.meta && file.meta.firstIncompleteDate;
    const inferred = firstIncomplete ? addDays(firstIncomplete, -1) : file.meta && file.meta.dataState && file.meta.dataState !== 'final' ? addDays(lastDate, -3) : lastDate;
    offline = { rows: file.rows, latestFinal: flags.latestFinal || inferred };
    if (!flags.latestFinal && inferred !== lastDate) log(`Input contains provisional days; treating data through ${inferred} as final (override with --latest-final).`);
    today = addDays(lastDate, 1);
  } else gsc = gscClient(ws, flags);
  const start = addDays(today, -(Math.max(flags.days, 14) - 1));
  const waves = fs.existsSync(ws.path('logs', 'experiments.json')) ? loadWaves(ws) : [];
  const deploysByDay = new Map();
  for (const w of waves) {
    if (w.type === 'freeze') continue;
    for (const d of deployWindows(w.date, 1, { siteTz: w.timezone || ws.timezone() }).excluded) {
      if (!deploysByDay.has(d)) deploysByDay.set(d, []);
      deploysByDay.get(d).push(`${w.id}${w.type !== 'seo-change' ? ` (${w.type})` : ''}`);
    }
  }
  const results = [];
  let latestFinal = null;
  const allEvents = loadEvents(ws, { today: gscToday() });
  for (const g of guards) {
    const variants = [g.query, ...(g.variants || [])].map((q) => String(q).toLowerCase().trim()).filter(Boolean);
    const mergedExpr = g.queryRegex || `^(${variants.map(re2Quote).join('|')})$`;
    const pageF = g.page ? [exactFilter('page', g.page)] : [];
    const mergedFilters = [{ dimension: 'query', operator: 'includingRegex', expression: mergedExpr }, ...(g.scope === 'page' ? pageF : [])];
    const q = offline
      ? async (s, e, dims, filters) => {
        const keep = (r) => r.date >= s && r.date <= e && filters.every((f) => (f.operator === 'equals' ? (f.dimension === 'page' ? (normalizeUrl(r.page) || r.page) === (normalizeUrl(f.expression) || f.expression) : String(r[f.dimension]).toLowerCase() === f.expression) : re2ToJs(f.expression).test(String(r[f.dimension]).toLowerCase())));
        const rows = [...groupMetrics(offline.rows.filter(keep), (r) => dims.map((d) => r[d]).join('\t'))].map(([k, v]) => {
          const parts = k.split('\t');
          const rec = {};
          dims.forEach((d, i) => {
            rec[d] = parts[i];
          });
          return { ...rec, ...v };
        });
        const first = addDays(offline.latestFinal, 1);
        return { rows, metadata: e >= first ? { firstIncompleteDate: first } : {} };
      }
      : (s, e, dims, filters, dataState = 'all') => gsc.query({ startDate: s, endDate: e, dimensions: dims, type: 'web', dataState, dimensionFilterGroups: [{ groupType: 'and', filters }] });
    log(`Guardrail "${g.query}" (${g.scope || 'site'} scope${variants.length > 1 ? `, ${variants.length} spellings merged` : ''})...`);
    const clickQs = (g.clickQueries && g.clickQueries.length ? g.clickQueries : variants).map((x) => String(x).toLowerCase());
    const clickFilters = [{ dimension: 'query', operator: 'includingRegex', expression: `^(${clickQs.map(re2Quote).join('|')})$` }, ...pageF];
    const [merged, exact, byPage, clicks] = await Promise.all([
      q(start, today, ['date'], mergedFilters),
      q(start, today, ['date'], [exactFilter('query', variants[0]), ...pageF]),
      g.page ? q(start, today, ['date', 'page'], [{ dimension: 'query', operator: 'includingRegex', expression: mergedExpr }]) : null,
      q(start, today, ['date'], clickFilters),
    ]);
    const first = merged.metadata.firstIncompleteDate || exact.metadata.firstIncompleteDate;
    latestFinal = first ? addDays(first, -1) : merged.rows.map((r) => r.date).sort().pop() || addDays(today, -3);
    let baselineRows = null;
    let clickBaselineRows = null;
    if (g.baseline && g.baseline.start && g.baseline.end) {
      [baselineRows, clickBaselineRows] = (await Promise.all([q(g.baseline.start, g.baseline.end, ['date'], mergedFilters, 'final'), q(g.baseline.start, g.baseline.end, ['date'], clickFilters, 'final')])).map((x) => x.rows);
    }
    const ev = evaluateGuardrail(g, { merged: merged.rows, exact: exact.rows, byPage: byPage ? byPage.rows : null, clicks: clicks.rows, baseline: baselineRows, clickBaseline: clickBaselineRows }, { latestFinal, today });
    if (!g.baseline && (g.maxPosition === null || g.maxPosition === undefined)) ev.note = 'No baseline and no maxPosition: set baseline {start,end} (a clean 7-day window before your changes) in config.json.';
    applyEventChecks(g, ev, allEvents);
    const days = listDays(start, addDays(today, -1));
    const byDate = (rows) => new Map((rows || []).map((r) => [r.date, r]));
    const m = byDate(merged.rows);
    const e = byDate(exact.rows);
    const c = byDate(clicks.rows);
    const shareByDay = new Map();
    if (byPage) {
      const target = normalizeUrl(g.page) || g.page;
      for (const d of days) {
        const rows = byPage.rows.filter((r) => r.date === d);
        const all = rows.reduce((s, r) => s + r.impressions, 0);
        const mine = rows.filter((r) => (normalizeUrl(r.page) || r.page) === target).reduce((s, r) => s + r.impressions, 0);
        if (all) shareByDay.set(d, mine / all);
      }
    }
    const daily = days.map((d) => ({
      date: d,
      weekday: WEEKDAYS[weekday(d)],
      final: d <= latestFinal,
      exact: e.get(d) || null,
      merged: m.get(d) || null,
      clicks: c.get(d) ? c.get(d).clicks : 0,
      share: shareByDay.has(d) ? shareByDay.get(d) : null,
      deploys: deploysByDay.get(d) || [],
    }));
    results.push({ guardrail: g, ...ev, daily });
  }

  const cell = (r) => (r && r.impressions ? `${r.impressions}@${r.position.toFixed(2)} (${r.clicks})` : '-');
  const L = [];
  for (const r of results) {
    const g = r.guardrail;
    L.push(`# ${g.query} guardrail | PT ${r.daily[0].date} -> ${r.daily[r.daily.length - 1].date} (* = provisional)`, '');
    if (g.note) L.push(`_${g.note}_`, '');
    L.push(mdTable(
      [
        { label: 'Date', value: (d) => `${d.date}${d.final ? '' : '*'}` },
        { label: 'Day', key: 'weekday' },
        { label: `Exact query${g.page ? ' + main URL' : ''} impr@pos (clicks)`, value: (d) => cell(d.exact) },
        { label: `Merged spellings (${g.scope || 'site'}) impr@pos (clicks)`, value: (d) => cell(d.merged) },
        { label: 'Click group', align: 'right', value: (d) => d.clicks },
        { label: 'Main URL share', align: 'right', value: (d) => (d.share === null ? '-' : fmtPct(d.share, 1)) },
        { label: 'Deploys', value: (d) => d.deploys.join(', ') },
      ],
      r.daily,
    ));
    const fmtP = (p) => (p === null || p === undefined ? '-' : p.toFixed(3));
    L.push(`Final 7 days (${r.final7.start} -> ${r.final7.end}): ${fmtP(r.final7.position)} (baseline ${r.baseline ? `${r.baseline.position.toFixed(4)} unrounded` : '-'}, stop line ${fmtP(r.stopLine)}, rollback line ${fmtP(r.rollbackLine)}) | incl. provisional (${r.provisional7.start} -> ${r.provisional7.end}, today excluded): ${fmtP(r.provisional7.position)}`);
    L.push(`Click group: ${r.clickFinal === null ? '-' : fmtNum(r.clickFinal)}/day (threshold ${r.minClicks === null ? '-' : fmtNum(r.minClicks)}${r.clickBaseline !== null ? `, baseline ${fmtNum(r.clickBaseline)}` : ''}) | main URL share ${r.share === null ? '-' : fmtPct(r.share, 1)}`);
    for (const e of r.events || []) L.push(`${e.severity === 'warn' ? '**WARNING**' : e.severity === 'note' ? 'Note (unverified)' : 'Info'}: ${e.text}`);
    L.push(`Status: warning ${r.states.warning || r.states.clickAlarm || r.states.lowShare || r.states.positionUnreliable || r.states.updateOverlap ? `YES (${r.states.warningReasons.join('; ')})` : 'no'} | pause ${r.states.pause ? 'YES' : 'no'} | rollback consideration ${r.states.rollbackConsider ? 'YES (numbers condition only - also needs a manual Google SERP check and the user\'s consent; roll back one variable only)' : 'no'} | click alarm ${r.states.clickAlarm ? 'YES' : 'no'}`);
    if (r.states.pause && r.flip.length) {
      const ok = r.flip.find((f) => f.feasible);
      L.push(`What it takes to get back under the stop line: ${r.flip.map((f) => (f.feasible ? `${f.days}d: ~${f.impressions} impr. at avg position < ${f.maxPosition.toFixed(2)}` : `${f.days}d: impossible (would need position < 1)`)).join('; ')}.${ok ? '' : ' Not reachable within a week: investigate instead of waiting.'}`);
    }
    if (r.note) L.push(`Note: ${r.note}`);
    L.push('');
  }
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-guardrail.md`), L.join('\n'));
  const json = writeJson(ws.dataFile('gsc', 'guardrail', 'json'), { latestFinal, results: results.map(({ daily, ...rest }) => ({ ...rest, daily })) });
  if (flags.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else {
    for (const r of results) {
      const s = r.states;
      const label = s.rollbackConsider ? 'ROLLBACK CONSIDERATION' : s.pause ? 'PAUSE' : s.warning || s.clickAlarm || s.lowShare || s.positionUnreliable || s.updateOverlap ? 'WARNING' : 'ok';
      out(`${r.guardrail.query}: ${label} | final 7d ${r.final7.position === null ? '-' : r.final7.position.toFixed(3)} vs stop ${r.stopLine === null ? '-' : r.stopLine.toFixed(3)}${s.warningReasons.length ? ` | ${s.warningReasons.join('; ')}` : ''}`);
      for (const e of (r.events || []).filter((x) => x.severity === 'warn')) out(`  WARNING: ${e.text}`);
      if (s.rollbackConsider) out('  numbers condition only: also needs a manual Google SERP check (no new competitor or SERP block) and the user\'s consent; roll back ONE variable.');
      if (s.pause) out('  pause: no releases touching home, core pages or shared templates; investigate (indexing, SERP, external events) before any change.');
    }
    out(`\nwrote ${md}\nwrote ${json}`);
  }
  const breach = results.some((r) => r.states.pause || r.states.rollbackConsider || r.states.clickAlarm);
  return flags.failOnBreach && breach ? 2 : 0;
}

runMain(import.meta.url, main);
