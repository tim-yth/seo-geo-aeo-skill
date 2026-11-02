#!/usr/bin/env node
// Opportunity lists from Search Console: striking distance, weak pages, CTR gaps, zero-click,
// rank-up-but-CTR-down, decliners and cannibalization (with daily primary-URL rotation).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, normalizeUrl } from './lib/util.mjs';
import { loadWorkspace, makeBrandMatcher } from './lib/config.mjs';
import { gscClient, loadGscFile, re2ToJs } from './lib/gsc.mjs';
import { addDays } from './lib/dates.mjs';
import { groupMetrics, expectedCtr, loadCtrCurve, DEFAULT_CTR_CURVE } from './lib/metrics.mjs';
import { loadWaves, isOpen } from './lib/experiments.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { fmtInt, fmtPct, fmtPos, fmtSigned, fmtSignedPct, mdTable, shortUrl } from './lib/format.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  site: { type: 'string', placeholder: 'property', desc: 'Override gsc.siteUrl' },
  days: { type: 'int', desc: 'Current window length (ends at the newest final day)', default: 28 },
  end: { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'End of the current window (default: newest final day)' },
  'cannibal-days': { type: 'int', desc: 'Long window for cannibalization (also checks the last 14 days)', default: 90 },
  input: { type: 'string', placeholder: 'file', desc: 'Offline: gsc-export with date,query,page rows (enables every category)' },
  'current-input': { type: 'string', placeholder: 'file', desc: 'Offline: query,page export for the current window only' },
  'previous-input': { type: 'string', placeholder: 'file', desc: 'Offline: query,page export for the previous window' },
  'min-pos': { type: 'number', desc: 'Striking distance: best position', default: 4 },
  'max-pos': { type: 'number', desc: 'Striking distance: worst position', default: 20 },
  'striking-min-impr': { type: 'int', desc: 'Striking distance: min query impressions', default: 20 },
  'weak-page-min-impr': { type: 'int', desc: 'Weak pages: min page impressions', default: 50 },
  'ctr-min-impr': { type: 'int', desc: 'CTR gap: min impressions', default: 100 },
  'ctr-curve': { type: 'string', placeholder: 'step|default|site|file', desc: 'CTR gap test: step thresholds (5%/2.5%/1% for pos 1-3/4-10/11-20) or an expected-CTR curve', default: 'step' },
  'ctr-ratio': { type: 'number', desc: 'With a curve: flag CTR below this share of expected', default: 0.5 },
  'zero-click-min': { type: 'int', desc: 'Zero-click: min impressions', default: 100 },
  'drop-positions': { type: 'number', desc: 'Decliners: position worse by at least this', default: 3 },
  'drop-pct': { type: 'number', desc: 'Decliners: clicks or impressions down by at least this share', default: 0.2 },
  'cannibal-share': { type: 'number', desc: 'Cannibalization: second URL share of page-level impressions', default: 0.15 },
  'cannibal-min-impr': { type: 'int', desc: 'Cannibalization: min impressions of the second URL', default: 10 },
  'cannibal-query-min': { type: 'int', desc: 'Cannibalization: min query impressions over the long window', default: 50 },
  'include-brand': { type: 'boolean', desc: 'Keep brand queries (excluded by default)' },
  'exclude-query': { type: 'string', placeholder: 're2', desc: 'Drop queries matching this regex, e.g. other sites\' navigational queries ("(?i)" allowed)' },
  top: { type: 'int', desc: 'Rows per section in the Markdown report', default: 25 },
  json: { type: 'boolean', desc: 'Print the result JSON to stdout' },
};

const HELP = formatHelp({
  usage: ['node scripts/gsc-opportunities.mjs [--days 28]', 'node scripts/gsc-opportunities.mjs --input date-query-page.json   (offline)'],
  summary:
    'Builds the prioritized opportunity lists: striking distance (pos 4-20), weak pages, CTR gaps, impressions-but-zero-clicks, rank up but CTR ' +
    'down, decliners (current vs previous equal window) and cannibalization (second URL >= 15% of impressions, with daily primary-URL ' +
    'rotation and query trend to separate harmful from harmless splits). Pages under an open change wave are marked "in test" and left out ' +
    'of the suggested queue. Writes CSVs to data/gsc/ and a Markdown report to logs/reviews/.',
  spec: SPEC,
  examples: ['node scripts/gsc-opportunities.mjs', 'node scripts/gsc-opportunities.mjs --ctr-curve site --ctr-ratio 0.6', 'node scripts/gsc-opportunities.mjs --input data/gsc/2026-11-01-date-query-page-120d.json'],
  notes: [
    'Default CTR thresholds (5% / 2.5% / 1%) come from a real case study; --ctr-curve site compares against your own CTR-by-position curve.',
    'Two pages sharing impressions is not a problem by itself: it is flagged "harmful" only when the primary URL rotates AND the query is losing position or clicks.',
    'Weekly capacity suggestion: at most 2 full rewrites and 3 title/snippet changes; cool down a page for 7 days after a change.',
  ],
});

const STEP = [
  [3.5, 0.05],
  [10.5, 0.025],
  [20.5, 0.01],
];
const stepThreshold = (pos) => (STEP.find(([max]) => pos <= max) || [0, 0])[1];
const pageKey = (p) => normalizeUrl(p, { stripTracking: false }) || p;

function aggregateBy(rows, keyFn, keep = () => true) {
  return groupMetrics(rows.filter(keep), keyFn);
}

function bestPageByQuery(rows) {
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.query);
    if (!cur || r.impressions > cur.impressions) map.set(r.query, { page: r.page, impressions: r.impressions });
  }
  return map;
}

/** Pure analysis; exported for tests. windows: { current:{qp,pages,range}, previous?:{qp,pages,range}, longQp?, shortQp?, dailyQp? } */
export function findOpportunities(w, opts) {
  const o = {
    minPos: 4, maxPos: 20, strikingMinImpr: 20, weakPageMinImpr: 50, ctrMinImpr: 100, ctrCurve: 'step', curve: DEFAULT_CTR_CURVE, ctrRatio: 0.5,
    zeroClickMin: 100, dropPositions: 3, dropPct: 0.2, cannibalShare: 0.15, cannibalMinImpr: 10, cannibalQueryMin: 50, isBrand: () => false, includeBrand: false, inTest: () => false,
    ...opts,
  };
  const keepQuery = (r) => o.includeBrand || !o.isBrand(r.query);
  const cur = w.current;
  const queries = aggregateBy(cur.qp, (r) => r.query, keepQuery);
  const best = bestPageByQuery(cur.qp);
  const pages = w.current.pages && w.current.pages.length ? new Map(w.current.pages.map((r) => [pageKey(r.page), r])) : aggregateBy(cur.qp, (r) => pageKey(r.page));
  const target = expectedCtr(3, o.curve);
  const res = {};
  const withPage = (q, m) => ({ query: q, page: best.get(q) ? best.get(q).page : '', clicks: m.clicks, impressions: m.impressions, ctr: m.ctr, position: m.position, inTest: best.get(q) ? o.inTest(best.get(q).page) : false });

  res.striking = [...queries]
    .filter(([, m]) => m.position >= o.minPos && m.position <= o.maxPos && m.impressions >= o.strikingMinImpr)
    .map(([q, m]) => ({ ...withPage(q, m), potentialClicks: Math.max(0, m.impressions * (target - m.ctr)) }))
    .sort((a, b) => b.potentialClicks - a.potentialClicks);

  res.weakPages = [...pages]
    .filter(([, m]) => m.position >= o.minPos && m.position <= o.maxPos && m.impressions >= o.weakPageMinImpr)
    .map(([p, m]) => ({ page: p, clicks: m.clicks, impressions: m.impressions, ctr: m.ctr, position: m.position, potentialClicks: Math.max(0, m.impressions * (target - m.ctr)), inTest: o.inTest(p) }))
    .sort((a, b) => b.potentialClicks - a.potentialClicks);

  res.ctrGaps = [...queries]
    .filter(([, m]) => m.impressions >= o.ctrMinImpr && m.position > 0 && m.position <= 20.5)
    .map(([q, m]) => {
      const expected = expectedCtr(m.position, o.curve);
      const threshold = o.ctrCurve === 'step' ? stepThreshold(m.position) : expected * o.ctrRatio;
      return { ...withPage(q, m), expectedCtr: expected, threshold, potentialClicks: Math.max(0, m.impressions * (expected - m.ctr)) };
    })
    .filter((r) => r.ctr < r.threshold)
    .sort((a, b) => b.potentialClicks - a.potentialClicks);

  res.zeroClick = [...queries]
    .filter(([, m]) => m.impressions >= o.zeroClickMin && m.clicks === 0)
    .map(([q, m]) => ({ ...withPage(q, m), hint: m.position <= 10.5 ? 'on page 1 but no clicks: title/snippet does not match intent, or a SERP feature/AI answer takes the click' : 'impressions only from deep rankings; improve ranking first' }))
    .sort((a, b) => b.impressions - a.impressions);

  res.rankUpCtrDown = [];
  res.decliningPages = [];
  res.decliningQueries = [];
  if (w.previous) {
    const prevPages = w.previous.pages && w.previous.pages.length ? new Map(w.previous.pages.map((r) => [pageKey(r.page), r])) : aggregateBy(w.previous.qp, (r) => pageKey(r.page));
    const prevQueries = aggregateBy(w.previous.qp, (r) => r.query, keepQuery);
    const compare = (kind, a, b) => {
      const outRows = [];
      for (const [k, now] of a) {
        const before = b.get(k);
        if (!before) continue;
        const posDelta = now.position && before.position ? now.position - before.position : 0;
        const clickDrop = before.clicks ? (before.clicks - now.clicks) / before.clicks : 0;
        const imprDrop = before.impressions ? (before.impressions - now.impressions) / before.impressions : 0;
        const row = { kind, key: k, page: kind === 'page' ? k : best.get(k) ? best.get(k).page : '', clicksBefore: before.clicks, clicks: now.clicks, impressionsBefore: before.impressions, impressions: now.impressions, ctrBefore: before.ctr, ctr: now.ctr, positionBefore: before.position, position: now.position, posDelta, inTest: o.inTest(kind === 'page' ? k : best.get(k) ? best.get(k).page : '') };
        if (now.impressions >= 100 && before.impressions >= 100 && posDelta <= -0.3 && before.ctr > 0 && now.ctr <= before.ctr * 0.75) res.rankUpCtrDown.push({ ...row, reason: `position ${fmtPos(before.position)} -> ${fmtPos(now.position)} but CTR ${fmtPct(before.ctr, 2)} -> ${fmtPct(now.ctr, 2)}` });
        const reasons = [];
        if (posDelta >= o.dropPositions && now.impressions >= 20 && before.impressions >= 20) reasons.push(`position ${fmtSigned(posDelta, 1)}`);
        if (clickDrop >= o.dropPct && before.clicks - now.clicks >= 5) reasons.push(`clicks ${fmtSignedPct(-clickDrop)}`);
        if (imprDrop >= o.dropPct && before.impressions - now.impressions >= 50) reasons.push(`impressions ${fmtSignedPct(-imprDrop)}`);
        if (reasons.length) outRows.push({ ...row, reason: reasons.join(', '), clickLoss: before.clicks - now.clicks });
      }
      for (const [k, before] of b) {
        if (a.has(k) || before.clicks < 5) continue;
        outRows.push({ kind, key: k, page: kind === 'page' ? k : '', clicksBefore: before.clicks, clicks: 0, impressionsBefore: before.impressions, impressions: 0, ctrBefore: before.ctr, ctr: 0, positionBefore: before.position, position: 0, posDelta: null, reason: 'disappeared', clickLoss: before.clicks, inTest: o.inTest(kind === 'page' ? k : '') });
      }
      return outRows.sort((x, y) => y.clickLoss - x.clickLoss || y.impressionsBefore - y.impressions - (x.impressionsBefore - x.impressions));
    };
    res.decliningPages = compare('page', pages, prevPages);
    res.decliningQueries = compare('query', queries, prevQueries);
    res.rankUpCtrDown.sort((a, b) => b.impressions - a.impressions);
  }

  res.cannibalization = cannibalization(w, o, { queries, prevQueries: w.previous ? aggregateBy(w.previous.qp, (r) => r.query, keepQuery) : null, keepQuery });
  return res;
}

function cannibalization(w, o, { queries, prevQueries, keepQuery }) {
  const longQp = (w.longQp || w.current.qp).filter(keepQuery);
  const shortQp = (w.shortQp || []).filter(keepQuery);
  const split = (rows) => {
    const byQuery = new Map();
    for (const r of rows) {
      if (!byQuery.has(r.query)) byQuery.set(r.query, new Map());
      const m = byQuery.get(r.query);
      const k = pageKey(r.page);
      const cur = m.get(k) || { clicks: 0, impressions: 0, pw: 0 };
      cur.clicks += r.clicks;
      cur.impressions += r.impressions;
      cur.pw += r.position * r.impressions;
      m.set(k, cur);
    }
    return byQuery;
  };
  const longSplit = split(longQp);
  const shortSplit = split(shortQp);
  const flagged = [];
  for (const [q, pagesMap] of longSplit) {
    const pagesArr = [...pagesMap].map(([page, m]) => ({ page, ...m, position: m.impressions ? m.pw / m.impressions : 0 })).sort((a, b) => b.impressions - a.impressions);
    const total = pagesArr.reduce((s, p) => s + p.impressions, 0);
    if (total < o.cannibalQueryMin || pagesArr.length < 2) continue;
    const passes = (arr) => {
      if (arr.length < 2) return false;
      const t = arr.reduce((s, p) => s + p.impressions, 0);
      return t > 0 && arr[1].impressions / t >= o.cannibalShare && arr[1].impressions >= o.cannibalMinImpr;
    };
    const shortArr = shortSplit.has(q) ? [...shortSplit.get(q)].map(([page, m]) => ({ page, ...m })).sort((a, b) => b.impressions - a.impressions) : [];
    if (!passes(pagesArr) && !passes(shortArr)) continue;
    const row = {
      query: q,
      impressions: total,
      pages: pagesArr.slice(0, 4).map((p) => ({ page: p.page, share: p.impressions / total, clicks: p.clicks, impressions: p.impressions, position: p.position })),
      daysWithData: null,
      coRankDays: null,
      primaryDays: null,
      switches: null,
      trend: null,
      verdict: 'split (no daily data)',
      inTest: pagesArr.slice(0, 2).some((p) => o.inTest(p.page)),
    };
    if (w.dailyQp) {
      const days = new Map();
      for (const r of w.dailyQp) {
        if (r.query !== q) continue;
        if (!days.has(r.date)) days.set(r.date, []);
        days.get(r.date).push(r);
      }
      const ordered = [...days.keys()].sort();
      const primaryDays = {};
      let co = 0;
      let switches = 0;
      let last = '';
      for (const d of ordered) {
        const list = days.get(d).filter((r) => r.impressions > 0).sort((a, b) => b.impressions - a.impressions);
        if (!list.length) continue;
        if (list.length >= 2) co++;
        const primary = pageKey(list[0].page);
        primaryDays[primary] = (primaryDays[primary] || 0) + 1;
        if (last && primary !== last) switches++;
        last = primary;
      }
      const counts = Object.values(primaryDays).sort((a, b) => b - a);
      const withData = counts.reduce((s, c) => s + c, 0);
      const rotating = counts.length >= 2 && counts[1] / withData >= 0.2 && switches >= 2;
      row.daysWithData = withData;
      row.coRankDays = co;
      row.primaryDays = Object.entries(primaryDays).sort((a, b) => b[1] - a[1]).map(([page, n]) => ({ page, days: n }));
      row.switches = switches;
      row.rotating = rotating;
    }
    if (prevQueries && queries.has(q) && prevQueries.has(q)) {
      const a = prevQueries.get(q);
      const b = queries.get(q);
      row.trend = { positionBefore: a.position, position: b.position, clicksBefore: a.clicks, clicks: b.clicks };
      const worse = b.position - a.position >= 0.5 || (a.clicks >= 5 && (a.clicks - b.clicks) / a.clicks >= 0.2);
      if (row.rotating !== undefined) row.verdict = row.rotating && worse ? 'harmful: primary URL rotates and the query is losing' : row.rotating ? 'watch: rotating but not losing' : 'stable split: leave it';
      else row.verdict = worse ? 'split and losing (check daily rotation)' : 'split, not losing';
    } else if (row.rotating !== undefined) row.verdict = row.rotating ? 'rotating (no trend data)' : 'stable split: leave it';
    flagged.push(row);
  }
  const rank = (v) => (v.startsWith('harmful') ? 0 : v.startsWith('split and losing') ? 1 : v.startsWith('watch') || v.startsWith('rotating') ? 2 : 3);
  return flagged.sort((a, b) => rank(a.verdict) - rank(b.verdict) || b.impressions - a.impressions);
}

// ---------- report ----------
function renderReport(res, meta) {
  const L = [];
  const top = meta.top;
  L.push(`# Search opportunities (${meta.window.start} -> ${meta.window.end})`, '');
  L.push(`- Property: ${meta.siteUrl}; previous window: ${meta.previous ? `${meta.previous.start} -> ${meta.previous.end}` : 'n/a'}; cannibalization window: ${meta.longWindow || 'current'}`);
  L.push(`- Brand queries ${meta.includeBrand ? 'included' : 'excluded'}${meta.excludeQuery ? `; queries matching \`${meta.excludeQuery}\` excluded` : ''}; CTR test: ${meta.ctrTest}`);
  L.push(`- Pages under an open change wave are marked "in test" and must not be changed until reviewed.`, '');
  L.push('## Suggested queue this week', '');
  const free = (rows) => rows.filter((r) => !r.inTest);
  const snippet = [...free(res.ctrGaps), ...free(res.zeroClick), ...free(res.rankUpCtrDown)];
  const seen = new Set();
  const titleQueue = snippet.filter((r) => r.page && !seen.has(r.page) && seen.add(r.page)).slice(0, 3);
  const rewriteQueue = free(res.weakPages).filter((r) => !seen.has(r.page)).slice(0, 2);
  L.push('Title/snippet changes (max 3):', '');
  L.push(mdTable([{ label: 'Page', value: (r) => shortUrl(r.page) }, { label: 'Why', value: (r) => (r.query ? `${r.query}: ${fmtInt(r.impressions)} impr., CTR ${fmtPct(r.ctr, 2)} @${fmtPos(r.position)}` : r.reason) }], titleQueue));
  L.push('Rewrites (max 2):', '');
  L.push(mdTable([{ label: 'Page', value: (r) => shortUrl(r.page) }, { label: 'Why', value: (r) => `${fmtInt(r.impressions)} impr. @${fmtPos(r.position)}, CTR ${fmtPct(r.ctr, 2)}, +${fmtInt(r.potentialClicks)} clicks if top 3` }], rewriteQueue));
  const qCols = [
    { label: 'Query', value: (r) => r.query },
    { label: 'Page', value: (r) => `${shortUrl(r.page)}${r.inTest ? ' (in test)' : ''}` },
    { label: 'Impr.', align: 'right', value: (r) => fmtInt(r.impressions) },
    { label: 'Clicks', align: 'right', value: (r) => fmtInt(r.clicks) },
    { label: 'CTR', align: 'right', value: (r) => fmtPct(r.ctr, 2) },
    { label: 'Pos', align: 'right', value: (r) => fmtPos(r.position) },
  ];
  L.push(`## Striking distance (${res.striking.length})`, '', mdTable([...qCols, { label: '+Clicks @3', align: 'right', value: (r) => fmtInt(r.potentialClicks) }], res.striking.slice(0, top)));
  L.push(`## Weak pages (${res.weakPages.length})`, '', mdTable([{ label: 'Page', value: (r) => `${shortUrl(r.page)}${r.inTest ? ' (in test)' : ''}` }, { label: 'Impr.', align: 'right', value: (r) => fmtInt(r.impressions) }, { label: 'Clicks', align: 'right', value: (r) => fmtInt(r.clicks) }, { label: 'CTR', align: 'right', value: (r) => fmtPct(r.ctr, 2) }, { label: 'Pos', align: 'right', value: (r) => fmtPos(r.position) }, { label: '+Clicks @3', align: 'right', value: (r) => fmtInt(r.potentialClicks) }], res.weakPages.slice(0, top)));
  L.push(`## CTR gaps (${res.ctrGaps.length})`, '', mdTable([...qCols, { label: 'Expected', align: 'right', value: (r) => fmtPct(r.expectedCtr, 2) }, { label: '+Clicks', align: 'right', value: (r) => fmtInt(r.potentialClicks) }], res.ctrGaps.slice(0, top)));
  L.push(`## Impressions but zero clicks (${res.zeroClick.length})`, '', mdTable([...qCols, { label: 'Hint', value: (r) => r.hint }], res.zeroClick.slice(0, top)));
  const chg = [
    { label: 'Key', value: (r) => (r.kind === 'page' ? shortUrl(r.key) : r.key) },
    { label: 'Clicks', align: 'right', value: (r) => `${fmtInt(r.clicksBefore)} -> ${fmtInt(r.clicks)}` },
    { label: 'Impr.', align: 'right', value: (r) => `${fmtInt(r.impressionsBefore)} -> ${fmtInt(r.impressions)}` },
    { label: 'Pos', align: 'right', value: (r) => `${fmtPos(r.positionBefore)} -> ${fmtPos(r.position)}` },
    { label: 'Why', value: (r) => `${r.reason}${r.inTest ? ' (in test)' : ''}` },
  ];
  if (meta.previous) {
    L.push(`## Rank up, CTR down (${res.rankUpCtrDown.length})`, '', '_Fix the title and the opening answer; do not just make the page longer._', '', mdTable(chg, res.rankUpCtrDown.slice(0, top)));
    L.push(`## Declining pages (${res.decliningPages.length})`, '', mdTable(chg, res.decliningPages.slice(0, top)));
    L.push(`## Declining queries (${res.decliningQueries.length})`, '', mdTable(chg, res.decliningQueries.slice(0, top)));
  }
  L.push(`## Cannibalization (${res.cannibalization.length})`, '', '_Only "harmful" needs action: strengthen the chosen page first, then re-angle the other page, merge + 301 last._', '');
  L.push(mdTable(
    [
      { label: 'Query', value: (r) => r.query },
      { label: 'Impr.', align: 'right', value: (r) => fmtInt(r.impressions) },
      { label: 'Pages (share @pos)', value: (r) => r.pages.map((p) => `${shortUrl(p.page)} ${fmtPct(p.share, 0)} @${fmtPos(p.position)}`).join('; ') },
      { label: 'Daily primary URL', value: (r) => (r.primaryDays ? `${r.primaryDays.map((p) => `${shortUrl(p.page)}: ${p.days}d`).join(', ')}; ${r.switches} switches; ${r.coRankDays}/${r.daysWithData} co-ranking days` : '-') },
      { label: 'Trend', value: (r) => (r.trend ? `pos ${fmtPos(r.trend.positionBefore)} -> ${fmtPos(r.trend.position)}, clicks ${fmtInt(r.trend.clicksBefore)} -> ${fmtInt(r.trend.clicks)}` : '-') },
      { label: 'Verdict', value: (r) => `${r.verdict}${r.inTest ? ' (in test)' : ''}` },
    ],
    res.cannibalization.slice(0, top),
  ));
  return L.join('\n');
}

function csvRows(rows) {
  return rows.map((r) => {
    const o = { ...r };
    if (Array.isArray(o.pages)) o.pages = o.pages.map((p) => `${p.page} ${(p.share * 100).toFixed(0)}% @${p.position.toFixed(1)}`).join(' | ');
    if (Array.isArray(o.primaryDays)) o.primaryDays = o.primaryDays.map((p) => `${p.page}:${p.days}`).join(' | ');
    if (o.trend && typeof o.trend === 'object') o.trend = `pos ${o.trend.positionBefore.toFixed(1)}->${o.trend.position.toFixed(1)} clicks ${o.trend.clicksBefore}->${o.trend.clicks}`;
    return o;
  });
}

function sliceRows(rows, start, end) {
  return rows.filter((r) => r.date >= start && r.date <= end);
}

function collapse(rows, dims) {
  return [...groupMetrics(rows, (r) => dims.map((d) => r[d]).join('\t'))].map(([k, m]) => {
    const parts = k.split('\t');
    const rec = {};
    dims.forEach((d, i) => {
      rec[d] = parts[i];
    });
    return { ...rec, ...m };
  });
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const isBrand = makeBrandMatcher(ws.brandTerms());
  let siteUrl = ws.config.gsc.siteUrl || '(offline)';
  let windows;
  let current;
  let previous = null;
  let longRange = null;

  if (flags.input) {
    const file = loadGscFile(path.resolve(flags.input));
    if (!['date', 'query', 'page'].every((d) => file.dimensions.includes(d))) throw new UserError('--input needs date, query and page dimensions', { hint: 'Export with gsc-export.mjs --dimensions date,query,page --days 120' });
    const dates = [...new Set(file.rows.map((r) => r.date))].sort();
    const end = flags.end || dates[dates.length - 1];
    current = { start: addDays(end, -(flags.days - 1)), end };
    previous = { start: addDays(current.start, -flags.days), end: addDays(current.start, -1) };
    longRange = { start: addDays(end, -(flags.cannibalDays - 1)), end };
    const short = { start: addDays(end, -13), end };
    const cur = sliceRows(file.rows, current.start, current.end);
    const prev = sliceRows(file.rows, previous.start, previous.end);
    windows = {
      current: { qp: collapse(cur, ['query', 'page']), pages: collapse(cur, ['page']), range: current },
      previous: prev.length ? { qp: collapse(prev, ['query', 'page']), pages: collapse(prev, ['page']), range: previous } : null,
      longQp: collapse(sliceRows(file.rows, longRange.start, longRange.end), ['query', 'page']),
      shortQp: collapse(sliceRows(file.rows, short.start, short.end), ['query', 'page']),
      dailyQp: sliceRows(file.rows, longRange.start, longRange.end),
    };
    if (!prev.length || dates[0] > previous.start) {
      if (prev.length) log(`Input starts ${dates[0]}, after the previous window start ${previous.start}: decliners and rank/CTR changes are skipped (export at least ${flags.days * 2} days).`);
      previous = null;
      windows.previous = null;
    }
    if (dates[0] > longRange.start) longRange = { start: dates[0], end };
  } else if (flags.currentInput) {
    const a = loadGscFile(path.resolve(flags.currentInput));
    current = { start: a.meta.startDate || '?', end: a.meta.endDate || '?' };
    windows = { current: { qp: a.rows, pages: [], range: current } };
    if (flags.previousInput) {
      const b = loadGscFile(path.resolve(flags.previousInput));
      previous = { start: b.meta.startDate || '?', end: b.meta.endDate || '?' };
      windows.previous = { qp: b.rows, pages: [], range: previous };
    }
  } else {
    const gsc = gscClient(ws, flags);
    siteUrl = gsc.siteUrl;
    const end = flags.end || (await gsc.latestFinalDate());
    current = { start: addDays(end, -(flags.days - 1)), end };
    previous = { start: addDays(current.start, -flags.days), end: addDays(current.start, -1) };
    longRange = { start: addDays(end, -(flags.cannibalDays - 1)), end };
    const short = { start: addDays(end, -13), end };
    const q = (r, dimensions, extra = {}) => gsc.query({ startDate: r.start, endDate: r.end, dimensions, type: 'web', dataState: 'final', ...extra }).then((x) => x.rows);
    log(`Fetching ${siteUrl}: current ${current.start}..${current.end}, previous ${previous.start}..${previous.end}, long ${longRange.start}..${longRange.end}`);
    const [curQp, curPages, prevQp, prevPages, longQp, shortQp] = await Promise.all([
      q(current, ['query', 'page']),
      q(current, ['page']),
      q(previous, ['query', 'page']),
      q(previous, ['page']),
      q(longRange, ['query', 'page']),
      q(short, ['query', 'page']),
    ]);
    windows = { current: { qp: curQp, pages: curPages, range: current }, previous: { qp: prevQp, pages: prevPages, range: previous }, longQp, shortQp };
    const prelim = cannibalization(windows, { cannibalShare: flags.cannibalShare, cannibalMinImpr: flags.cannibalMinImpr, cannibalQueryMin: flags.cannibalQueryMin, inTest: () => false }, { queries: new Map(), prevQueries: null, keepQuery: (r) => flags.includeBrand || !isBrand(r.query) });
    const candidates = prelim.map((r) => r.query).slice(0, 200);
    if (candidates.length) {
      log(`Daily rotation check for ${candidates.length} cannibalization candidates...`);
      const quote = (s) => s.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
      const daily = [];
      for (let i = 0; i < candidates.length; i += 40) {
        const chunk = candidates.slice(i, i + 40);
        daily.push(...(await q(longRange, ['date', 'query', 'page'], { dimensionFilterGroups: [{ filters: [{ dimension: 'query', operator: 'includingRegex', expression: `^(${chunk.map(quote).join('|')})$` }] }] })));
      }
      windows.dailyQp = daily;
    }
  }

  if (flags.excludeQuery) {
    const re = re2ToJs(flags.excludeQuery);
    const keep = (rows) => (rows ? rows.filter((r) => !re.test(r.query)) : rows);
    windows.current.qp = keep(windows.current.qp);
    if (windows.previous) windows.previous.qp = keep(windows.previous.qp);
    windows.longQp = keep(windows.longQp);
    windows.shortQp = keep(windows.shortQp);
    windows.dailyQp = keep(windows.dailyQp);
  }
  const waves = fs.existsSync(ws.path('logs', 'experiments.json')) ? loadWaves(ws).filter(isOpen) : [];
  const testUrls = new Set(waves.flatMap((w) => (w.urls || []).map((u) => normalizeUrl(u) || u)));
  const curve = flags.ctrCurve === 'step' ? DEFAULT_CTR_CURVE : loadCtrCurve(flags.ctrCurve, windows.current.qp, { isBrand });
  const res = findOpportunities(windows, {
    minPos: flags.minPos,
    maxPos: flags.maxPos,
    strikingMinImpr: flags.strikingMinImpr,
    weakPageMinImpr: flags.weakPageMinImpr,
    ctrMinImpr: flags.ctrMinImpr,
    ctrCurve: flags.ctrCurve,
    curve,
    ctrRatio: flags.ctrRatio,
    zeroClickMin: flags.zeroClickMin,
    dropPositions: flags.dropPositions,
    dropPct: flags.dropPct,
    cannibalShare: flags.cannibalShare,
    cannibalMinImpr: flags.cannibalMinImpr,
    cannibalQueryMin: flags.cannibalQueryMin,
    isBrand,
    includeBrand: flags.includeBrand,
    inTest: (u) => testUrls.has(normalizeUrl(u) || u),
  });
  const meta = {
    siteUrl,
    window: current,
    previous,
    longWindow: longRange ? `${longRange.start} -> ${longRange.end} (+ last 14 days)` : null,
    includeBrand: flags.includeBrand,
    excludeQuery: flags.excludeQuery || '',
    ctrTest: flags.ctrCurve === 'step' ? 'step thresholds 5% / 2.5% / 1% (pos 1-3 / 4-10 / 11-20)' : `CTR < ${flags.ctrRatio} x expected (${curve.source})`,
    top: flags.top,
    generatedAt: new Date().toISOString(),
  };
  const files = [];
  const sections = { striking: res.striking, 'weak-pages': res.weakPages, 'ctr-gaps': res.ctrGaps, 'zero-click': res.zeroClick, 'rank-up-ctr-down': res.rankUpCtrDown, 'declining-pages': res.decliningPages, 'declining-queries': res.decliningQueries, cannibalization: res.cannibalization };
  for (const [name, rows] of Object.entries(sections)) if (rows.length) files.push(writeCsvFile(ws.dataFile('gsc', `opportunities-${name}`, 'csv'), csvRows(rows)));
  files.push(writeJson(ws.dataFile('gsc', 'opportunities', 'json'), { meta, ...res }));
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-opportunities.md`), renderReport(res, meta));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ meta, ...res }, null, 2)}\n`);
    return 0;
  }
  out(`Opportunities for ${siteUrl} (${current.start} -> ${current.end})`);
  for (const [name, rows] of Object.entries(sections)) out(`  ${name.padEnd(18)} ${rows.length}${rows.length && rows[0].query ? `  e.g. ${rows[0].query}` : rows.length && rows[0].page ? `  e.g. ${shortUrl(rows[0].page)}` : ''}`);
  const harmful = res.cannibalization.filter((r) => r.verdict.startsWith('harmful')).length;
  if (harmful) out(`  -> ${harmful} harmful cannibalization case(s) need a decision`);
  out(`\nwrote ${md}`);
  for (const f of files) out(`wrote ${f}`);
  return 0;
}

runMain(import.meta.url, main);
