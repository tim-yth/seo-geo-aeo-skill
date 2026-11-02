#!/usr/bin/env node
// Fixed-window before/after comparison: groups, decomposition, same-query CTR, treatment-vs-control
// difference-in-differences with permutation p-values, placebo test, days-in-top-10 and slices.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, parseRangeArg, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, normalizeUrl, collectList, scriptCmd, slugify } from './lib/util.mjs';
import { loadWorkspace, makeBrandMatcher } from './lib/config.mjs';
import { gscClient, buildFilters, loadGscFile, re2ToJs, subtractRows } from './lib/gsc.mjs';
import { deployWindows, spanDays, addDays, diffDays, yoyWindow, assertYmd, finalDataReadyOn, gscToday, WEEKDAYS, weekday } from './lib/dates.mjs';
import { aggregate, groupMetrics, deltas, decomposeClicks, fixedSetComparison, loadCtrCurve } from './lib/metrics.mjs';
import { sameQueryCtr, diffInDiff, daysInTop10, didBinomial } from './lib/stats.mjs';
import { compactKey } from './lib/text.mjs';
import { loadWaves, findWave } from './lib/experiments.mjs';
import { loadEvents, overlapEvents, describeOverlap, overlapAdvice, metricReliability } from './lib/events.mjs';
import { fmtInt, fmtNum, fmtPct, fmtPos, fmtSigned, fmtSignedPct, fmtPp, mdTable, shortUrl } from './lib/format.mjs';

const SLICE_DIMS = ['searchAppearance', 'device', 'country'];

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  site: { type: 'string', placeholder: 'property', desc: 'Override gsc.siteUrl' },
  pre: { type: 'string', placeholder: 'start:end', desc: 'Pre window (PT dates)' },
  post: { type: 'string', placeholder: 'start:end', desc: 'Post window (PT dates)' },
  'deploy-date': { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'Deploy date (site time zone): builds equal windows excluding the deploy day; with --pre/--post it is checked instead' },
  window: { type: 'int', desc: 'Window length in days for --deploy-date / --wave', default: 28 },
  'no-align-weekday': { type: 'boolean', desc: 'Do not shift the pre window to match weekdays (only matters if window % 7 != 0)' },
  'exclude-extra-days': { type: 'int', desc: 'Also exclude N days after the deploy day (rollout/caching)', default: 0 },
  'allow-deploy-day': { type: 'boolean', desc: 'Allow explicit windows that contain the deploy day' },
  wave: { type: 'string', placeholder: 'id', desc: 'Use a wave from logs/experiments.json (date, URLs, guardrails)' },
  checkpoint: { type: 'string', placeholder: 'D+N', desc: "With --wave: use this checkpoint's window (e.g. D+14)" },
  urls: { type: 'csv', placeholder: 'url,...', desc: 'Treated URLs (control = rest of their page groups)' },
  'urls-file': { type: 'string', placeholder: 'file', desc: 'Treated URLs, one per line' },
  treatment: { type: 'string', placeholder: 'regex', desc: 'Treatment pages: JS regex on URL or path (enables difference-in-differences)' },
  control: { type: 'string', placeholder: 'regex', desc: 'Control pages: JS regex on URL or path (default: all other pages in scope)' },
  'placebo-shift': { type: 'string', placeholder: 'days|auto', desc: 'Placebo: rerun with both windows moved N days earlier; "auto" = window + excluded deploy days (the minimal clean shift)' },
  placebo: { type: 'boolean', desc: 'Same as --placebo-shift auto' },
  'exclude-query': { type: 'string', placeholder: 're2', desc: 'Remove anomalous queries (RE2/JS regex, "(?i)" allowed) from every total while keeping anonymized-query volume' },
  'control-min-impr': { type: 'int', desc: 'Control pages need at least this many pre-window impressions', default: 50 },
  'target-query': { type: 'list', placeholder: 'query', desc: 'Query for the days-in-top-10 table (guardrail queries are always included)' },
  by: { type: 'csv', placeholder: 'dims', desc: `Extra slices: ${SLICE_DIMS.join(', ')}` },
  'page-regex': { type: 'string', placeholder: 're2', desc: 'Restrict everything to pages matching this regex' },
  'query-group': { type: 'list', placeholder: 'name=regex', desc: 'Extra query group (JS regex, case-insensitive)' },
  'brand-term': { type: 'list', placeholder: 'term', desc: 'Extra brand term (adds to config brand terms)' },
  input: { type: 'string', placeholder: 'file', desc: 'Offline: one gsc-export file WITH a date dimension (e.g. date,query,page) covering both windows' },
  'pre-input': { type: 'string', placeholder: 'file', desc: 'Offline: gsc-export JSON/CSV for the pre window' },
  'post-input': { type: 'string', placeholder: 'file', desc: 'Offline: gsc-export JSON/CSV for the post window' },
  'data-state': { type: 'string', desc: 'final | all (all includes provisional days; a warning is printed)', default: 'final', choices: ['final', 'all'] },
  'allow-partial': { type: 'boolean', desc: 'If the post window is not final yet, compare only the days available (same length both sides)' },
  'no-fixed-set': { type: 'boolean', desc: 'Skip the query+page like-for-like analysis (saves API calls on big sites)' },
  'min-impressions': { type: 'int', desc: 'Min pre-window impressions for like-for-like pairs', default: 10 },
  'min-impr': { type: 'int', desc: 'Min impressions in BOTH windows for same-query CTR', default: 50 },
  'ctr-curve': { type: 'string', placeholder: 'default|site|file', desc: 'Expected-CTR curve used for the position effect', default: 'site' },
  yoy: { type: 'boolean', desc: 'Also compare the same windows one year earlier (seasonality check)' },
  top: { type: 'int', desc: 'Rows per movers table', default: 15 },
  label: { type: 'string', desc: 'Report label (default from wave/deploy date)' },
  json: { type: 'boolean', desc: 'Print the result JSON to stdout' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/gsc-compare.mjs --deploy-date YYYY-MM-DD [--window 28] [--urls u1,u2 | --treatment RE --control RE]',
    'node scripts/gsc-compare.mjs --pre A:B --post C:D [--deploy-date D]',
    'node scripts/gsc-compare.mjs --wave <id> [--checkpoint D+14] [--placebo]',
    'node scripts/gsc-compare.mjs --input date-query-page.json --deploy-date D     (offline)',
    'node scripts/gsc-compare.mjs     (no windows: last 28 final days vs the 28 days before)',
  ],
  summary:
    'Compares two fixed windows: site totals (plus same-query CTR), page groups, query groups (brand/non-brand, guardrails, custom), ' +
    'treatment vs control difference-in-differences with a permutation p-value over daily values, placebo test, days in top 10 for ' +
    'guardrail/target queries, like-for-like ranking of a fixed query+page set, slices (--by) and top movers. Click change is decomposed ' +
    'into impression, position and CTR-at-same-position effects. Writes JSON to data/gsc/ and Markdown to logs/reviews/.',
  spec: SPEC,
  examples: [
    'node scripts/gsc-compare.mjs --deploy-date 2026-10-01 --window 28 --yoy --by searchAppearance,device',
    'node scripts/gsc-compare.mjs --wave W-2026-10-01-title-rewrite --checkpoint D+28 --placebo --yoy --by searchAppearance',
    'node scripts/gsc-compare.mjs --deploy-date 2026-10-01 --window 28 --exclude-query "(?i)(otherbrand|viral phrase)"',
    'node scripts/gsc-compare.mjs --deploy-date 2026-10-01 --window 14 --treatment "^/guides/" --control "^/blog/"',
  ],
  notes: [
    'Search Console dates are Pacific Time; the deploy day is every PT day overlapping the deploy date in site.timezone, and it is always excluded.',
    'Windows that are not final yet are refused (use --allow-partial or --data-state all knowingly).',
    'Decomposition and DiD are model-based evidence, not proof. A placebo that shows a similar effect means a pre-existing trend.',
    'Query groups exclude anonymized queries, so they do not add up to page/site totals.',
  ],
});

/** Poisson z-score for a change in click rate (handles unequal window lengths). */
export const zScore = (a, b, ta = 1, tb = 1) => (a + b > 0 ? (b / tb - a / ta) / Math.sqrt(b / (tb * tb) + a / (ta * ta)) : 0);
const signal = (z) => (Math.abs(z) >= 2 ? `${z > 0 ? 'up' : 'down'} (z=${z.toFixed(1)})` : `noise (z=${z.toFixed(1)})`);
const pageKey = (r) => normalizeUrl(r.page, { stripTracking: false }) || r.page;

function readSignal(d) {
  if (d.clicks > 0 && d.impressions >= 0) return 'Growing: more clicks without losing impressions. Keep going; next focus on CTR and rank.';
  if (d.impressions > 0 && d.clicks <= 0) return 'Visibility up but clicks flat/down: work on titles/descriptions (snippet) and check SERP features.';
  if (d.impressions < 0) return 'Visibility down: check indexing, rankings and query demand before changing the content again.';
  return 'No material change: keep observing.';
}

function mainDriver(dec) {
  const parts = [
    ['impressions (demand/visibility)', dec.impressionEffect],
    ['position (ranking)', dec.positionEffect],
    ['CTR at same position (snippet/SERP)', dec.ctrEffect],
  ].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return Math.abs(parts[0][1]) < 1 ? 'none' : `${parts[0][0]} ${fmtSigned(parts[0][1])}`;
}

function group(name, kind, preRows, postRows, keyFn, curve, ranges, extra = {}) {
  const pre = aggregate(preRows);
  const post = aggregate(postRows);
  return {
    name,
    kind,
    pre,
    post,
    perDay: { pre: { clicks: pre.clicks / ranges.pre.days, impressions: pre.impressions / ranges.pre.days }, post: { clicks: post.clicks / ranges.post.days, impressions: post.impressions / ranges.post.days } },
    delta: deltas(pre, post),
    decomposition: decomposeClicks(preRows, postRows, keyFn, curve),
    z: zScore(pre.clicks, post.clicks, ranges.pre.days, ranges.post.days),
    ...extra,
  };
}

/** URL/path regex predicate. */
export function pageMatcher(re) {
  if (!re) return null;
  const rx = re instanceof RegExp ? re : new RegExp(re);
  return (r) => {
    if (rx.test(r.page)) return true;
    try {
      const u = new URL(r.page);
      return rx.test(u.pathname + u.search);
    } catch {
      return false;
    }
  };
}

/** Pure computation over two windows; exported for tests. */
export function computeComparison(pre, post, opts) {
  const {
    pageGroupOf = () => 'all',
    isBrand = () => false,
    hasBrand = false,
    guardrails = [],
    targetQueries = [],
    queryGroups = [],
    treatedUrls = null,
    treatment = null,
    control = null,
    curve,
    minImpressions = 10,
    minImpr = 50,
    controlMinImpr = 50,
    excludedFromControl = new Set(),
    top = 15,
  } = opts;
  const ranges = { pre: pre.range, post: post.range };
  const qpKey = (r) => `${r.query}\t${pageKey(r)}`;
  // Decompose on the finest rows available (query+page) to avoid mixing brand/non-brand positions on one page.
  const decomp = (keep) => (pre.qp && post.qp && pre.qp.length && post.qp.length ? decomposeClicks(pre.qp.filter(keep), post.qp.filter(keep), qpKey, curve) : null);
  const result = { windows: { pre: pre.range, post: post.range }, curve: curve.source, sameLength: pre.range.days === post.range.days };
  const preTotals = pre.totals || aggregate(pre.pages.length ? pre.pages : pre.queries);
  const postTotals = post.totals || aggregate(post.pages.length ? post.pages : post.queries);
  result.site = {
    pre: preTotals,
    post: postTotals,
    perDay: { pre: { clicks: preTotals.clicks / pre.range.days, impressions: preTotals.impressions / pre.range.days }, post: { clicks: postTotals.clicks / post.range.days, impressions: postTotals.impressions / post.range.days } },
    delta: deltas(preTotals, postTotals),
    z: zScore(preTotals.clicks, postTotals.clicks, pre.range.days, post.range.days),
    sameQueryCtr: pre.queries.length && post.queries.length ? sameQueryCtr(pre.queries, post.queries, { minImpr }) : null,
    sameQueryCtrSensitivity: pre.queries.length && post.queries.length && minImpr !== 25 ? sameQueryCtr(pre.queries, post.queries, { minImpr: 25 }) : null,
    decomposition: decomp(() => true) || (pre.pages.length ? decomposeClicks(pre.pages, post.pages, pageKey, curve) : decomposeClicks(pre.queries, post.queries, (r) => r.query, curve)),
  };
  result.site.decomposition.unattributed = result.site.delta.clicks - result.site.decomposition.total;
  result.site.decomposition.level = pre.qp && post.qp ? 'query+page' : pre.pages.length ? 'page' : 'query';
  if (!result.sameLength) {
    const s = result.site;
    s.perDayDelta = { clicksPct: s.perDay.pre.clicks ? s.perDay.post.clicks / s.perDay.pre.clicks - 1 : null, impressionsPct: s.perDay.pre.impressions ? s.perDay.post.impressions / s.perDay.pre.impressions - 1 : null };
  }
  result.site.read = readSignal(result.sameLength ? result.site.delta : { clicks: result.site.perDay.post.clicks - result.site.perDay.pre.clicks, impressions: result.site.perDay.post.impressions - result.site.perDay.pre.impressions });
  result.site.driver = mainDriver(result.site.decomposition);

  result.pageGroups = [];
  if (pre.pages.length || post.pages.length) {
    const names = new Set([...pre.pages, ...post.pages].map((r) => pageGroupOf(r.page)));
    for (const name of names) {
      const inGroup = (r) => pageGroupOf(r.page) === name;
      const d = decomp(inGroup);
      result.pageGroups.push(group(name, 'page-group', pre.pages.filter(inGroup), post.pages.filter(inGroup), pageKey, curve, ranges, d ? { decomposition: d } : {}));
    }
    result.pageGroups.sort((a, b) => b.pre.clicks + b.post.clicks - (a.pre.clicks + a.post.clicks));
  }

  result.queryGroups = [];
  if (pre.queries.length || post.queries.length) {
    const defs = [];
    if (hasBrand) {
      defs.push(['brand', 'brand', (r) => isBrand(r.query)]);
      defs.push(['non-brand', 'brand', (r) => !isBrand(r.query)]);
    }
    for (const g of guardrails) {
      const key = compactKey(g);
      defs.push([`guardrail: ${g}`, 'guardrail', (r) => compactKey(r.query) === key]);
    }
    for (const { name, re } of queryGroups) defs.push([name, 'custom', (r) => re.test(r.query)]);
    defs.push(['all named queries', 'all', () => true]);
    for (const [name, kind, test] of defs) {
      result.queryGroups.push(group(name, kind, pre.queries.filter(test), post.queries.filter(test), (r) => r.query, curve, ranges, { sameQueryCtr: sameQueryCtr(pre.queries, post.queries, { minImpr, filter: test }) }));
    }
  }

  // treatment vs control
  result.treated = null;
  let isTreat = treatment;
  let isCtrl = control;
  let treatLabel = 'treatment';
  let ctrlLabel = 'control';
  if (!isTreat && treatedUrls && treatedUrls.size) {
    isTreat = (r) => treatedUrls.has(pageKey(r));
    treatLabel = `treated URLs (${treatedUrls.size})`;
    if (!isCtrl) {
      const groups = new Set([...pre.pages, ...post.pages].filter(isTreat).map((r) => pageGroupOf(r.page)));
      isCtrl = (r) => !isTreat(r) && groups.has(pageGroupOf(r.page));
      ctrlLabel = `control (rest of: ${[...groups].join(', ') || '-'})`;
    }
  }
  if (isTreat && !isCtrl) {
    isCtrl = (r) => !isTreat(r);
    ctrlLabel = 'control (all other pages)';
  }
  if (isTreat && isCtrl) {
    // control pages: enough pre-window impressions and not touched by any other change wave
    const preImpr = new Map();
    for (const r of pre.pages) preImpr.set(pageKey(r), (preImpr.get(pageKey(r)) || 0) + r.impressions);
    const baseCtrl = isCtrl;
    isCtrl = (r) => baseCtrl(r) && (preImpr.get(pageKey(r)) || 0) >= controlMinImpr && !excludedFromControl.has(pageKey(r));
    ctrlLabel += `, >= ${controlMinImpr} pre impr.${excludedFromControl.size ? ', excluding other waves' : ''}`;
  }
  if (isTreat && (pre.pages.length || post.pages.length)) {
    const ctrlOnlyRow = (r) => isCtrl(r) && !isTreat(r);
    const dT = decomp(isTreat);
    const dC = decomp(ctrlOnlyRow);
    const tGroup = group(treatLabel, 'treated', pre.pages.filter(isTreat), post.pages.filter(isTreat), pageKey, curve, ranges, dT ? { decomposition: dT } : {});
    const cGroup = group(ctrlLabel, 'control', pre.pages.filter(ctrlOnlyRow), post.pages.filter(ctrlOnlyRow), pageKey, curve, ranges, dC ? { decomposition: dC } : {});
    const rel = (g, m) => (g.perDay.pre[m] ? g.perDay.post[m] / g.perDay.pre[m] - 1 : null);
    const net = (m) => (rel(tGroup, m) === null || rel(cGroup, m) === null ? null : (1 + rel(tGroup, m)) / (1 + rel(cGroup, m)) - 1);
    const did = {};
    if (pre.dailyPages && post.dailyPages) {
      const ctrlOnly = (r) => isCtrl(r) && !isTreat(r);
      did.clicks = diffInDiff(pre.dailyPages, post.dailyPages, pre.range, post.range, isTreat, ctrlOnly, { metric: 'clicks' });
      did.impressions = diffInDiff(pre.dailyPages, post.dailyPages, pre.range, post.range, isTreat, ctrlOnly, { metric: 'impressions' });
    }
    const binom = didBinomial(tGroup.pre.clicks, tGroup.post.clicks, cGroup.pre.clicks, cGroup.post.clicks, pre.range.days, post.range.days);
    result.treated = {
      treated: tGroup,
      control: cGroup,
      netClicksPct: net('clicks'),
      netImpressionsPct: net('impressions'),
      did: Object.keys(did).length ? did : null,
      binomial: binom,
      sampleTooSmall: tGroup.pre.clicks + tGroup.post.clicks < 10,
      urls: treatedUrls && treatedUrls.size
        ? [...treatedUrls].map((u) => {
          const a = aggregate(pre.pages.filter((r) => pageKey(r) === u));
          const b = aggregate(post.pages.filter((r) => pageKey(r) === u));
          return { url: u, pre: a, post: b, delta: deltas(a, b), z: zScore(a.clicks, b.clicks, pre.range.days, post.range.days), topQueries: pre.qp && post.qp ? topQueriesFor(u, pre.qp, post.qp) : [] };
        })
        : [],
    };
  }

  // days in top 10
  const tq = [...new Set([...guardrails, ...targetQueries].filter(Boolean))];
  result.topTen = null;
  if (tq.length && pre.dailyQueries && post.dailyQueries) {
    const a = daysInTop10(pre.dailyQueries, tq, pre.range);
    const b = daysInTop10(post.dailyQueries, tq, post.range);
    result.topTen = a.map((x, i) => ({ query: x.query, pre: x, post: b[i] }));
  }

  // slices
  result.slices = {};
  for (const dim of Object.keys(pre.slices || {})) {
    const pr = pre.slices[dim] || [];
    const po = (post.slices && post.slices[dim]) || [];
    const values = [...new Set([...pr, ...po].map((r) => r[dim]))];
    result.slices[dim] = values
      .map((v) => group(String(v), dim, pr.filter((r) => r[dim] === v), po.filter((r) => r[dim] === v), (r) => r[dim], curve, ranges))
      .sort((x, y) => y.pre.impressions + y.post.impressions - (x.pre.impressions + x.post.impressions));
  }

  result.fixedSet = pre.qp && post.qp && pre.qp.length && post.qp.length
    ? fixedSetComparison(pre.qp, post.qp, { minImpressions, preDays: pre.range.days, postDays: post.range.days, keyFn: (r) => `${r.query}\t${pageKey(r)}` })
    : null;

  const movers = (preRows, postRows, keyFn) => {
    const a = groupMetrics(preRows, keyFn);
    const b = groupMetrics(postRows, keyFn);
    const rows = [...new Set([...a.keys(), ...b.keys()])].map((k) => {
      const x = a.get(k) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      const y = b.get(k) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      return { key: k, pre: x, post: y, delta: deltas(x, y) };
    });
    return {
      losers: rows.filter((r) => r.delta.clicks < 0).sort((p, q) => p.delta.clicks - q.delta.clicks || p.delta.impressions - q.delta.impressions).slice(0, top),
      gainers: rows.filter((r) => r.delta.clicks > 0).sort((p, q) => q.delta.clicks - p.delta.clicks).slice(0, top),
    };
  };
  result.movers = {
    pages: pre.pages.length || post.pages.length ? movers(pre.pages, post.pages, pageKey) : null,
    queries: pre.queries.length || post.queries.length ? movers(pre.queries, post.queries, (r) => r.query) : null,
  };
  return result;
}

function topQueriesFor(url, preQp, postQp) {
  const a = groupMetrics(preQp.filter((r) => pageKey(r) === url), (r) => r.query);
  const b = groupMetrics(postQp.filter((r) => pageKey(r) === url), (r) => r.query);
  return [...new Set([...a.keys(), ...b.keys()])]
    .map((q) => ({ query: q, pre: a.get(q) || { clicks: 0, impressions: 0, position: 0 }, post: b.get(q) || { clicks: 0, impressions: 0, position: 0 } }))
    .sort((x, y) => y.pre.impressions + y.post.impressions - (x.pre.impressions + x.post.impressions))
    .slice(0, 8);
}

/** Placebo: does moving the deploy N days earlier produce a similar "effect"? */
export function placeboVerdict(real, placebo) {
  const pick = (r) => (r.treated && r.treated.did ? { value: r.treated.did.clicks.netEffect, p: r.treated.did.clicks.pValue, kind: 'treatment vs control net clicks' } : { value: r.sameLength || !r.site.perDayDelta ? r.site.delta.clicksPct : r.site.perDayDelta.clicksPct, p: null, z: r.site.z, kind: 'site clicks change' });
  const a = pick(real);
  const b = pick(placebo);
  if (a.value === null || b.value === null || a.value === undefined || b.value === undefined) return { flag: false, metric: a.kind, real: a.value, placebo: b.value, note: 'Placebo not computable (missing data).' };
  const sameSign = Math.sign(a.value) === Math.sign(b.value) && b.value !== 0;
  const similar = sameSign && Math.abs(b.value) >= 0.5 * Math.abs(a.value);
  const placeboSignificant = b.p !== null ? b.p < 0.1 : Math.abs(placebo.site.z) >= 2;
  // a "significant" placebo that is tiny next to the real effect is a minor drift, not an explanation of it
  const meaningful = Math.abs(b.value) >= 0.25 * Math.abs(a.value);
  const flag = similar || (sameSign && placeboSignificant && meaningful);
  const minor = !flag && sameSign && placeboSignificant;
  const pct = (x) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  return {
    flag,
    minor,
    metric: a.kind,
    real: a.value,
    placebo: b.value,
    placeboP: b.p,
    note: flag
      ? 'Placebo shows a similar effect: likely a pre-existing trend, NOT attributable to this change.'
      : minor
        ? `Placebo shows a small pre-existing drift (${pct(b.value)} vs ${pct(a.value)}): too small to explain the effect; read it as roughly ${pct((1 + a.value) / (1 + b.value) - 1)} net of the drift.`
        : 'Placebo shows no similar effect: the change is not explained by the pre-existing trend.',
  };
}

// ---------- report ----------
function groupColumns(perDay, { sameQuery = false } = {}) {
  const cols = [
    { label: 'Group', value: (g) => g.name },
    perDay
      ? { label: 'Clicks/day pre -> post', align: 'right', value: (g) => `${fmtNum(g.perDay.pre.clicks)} -> ${fmtNum(g.perDay.post.clicks)}` }
      : { label: 'Clicks pre -> post', align: 'right', value: (g) => `${fmtInt(g.pre.clicks)} -> ${fmtInt(g.post.clicks)}` },
    { label: 'Δ clicks', align: 'right', value: (g) => `${fmtSigned(g.delta.clicks)} (${fmtSignedPct(g.delta.clicksPct)})` },
    perDay
      ? { label: 'Impr./day pre -> post', align: 'right', value: (g) => `${fmtNum(g.perDay.pre.impressions)} -> ${fmtNum(g.perDay.post.impressions)}` }
      : { label: 'Impr. pre -> post', align: 'right', value: (g) => `${fmtInt(g.pre.impressions)} -> ${fmtInt(g.post.impressions)} (${fmtSignedPct(g.delta.impressionsPct)})` },
    { label: 'CTR', align: 'right', value: (g) => `${fmtPct(g.pre.ctr, 2)} -> ${fmtPct(g.post.ctr, 2)}` },
    sameQuery ? { label: 'Same-query CTR', align: 'right', value: (g) => (g.sameQueryCtr && g.sameQueryCtr.queries ? `${fmtPct(g.sameQueryCtr.pre, 2)} -> ${fmtPct(g.sameQueryCtr.post, 2)} (n=${g.sameQueryCtr.queries})` : '-') } : null,
    { label: 'Pos (+ = worse)', align: 'right', value: (g) => `${fmtPos(g.pre.position)} -> ${fmtPos(g.post.position)}` },
    { label: 'Impr. eff.', align: 'right', value: (g) => fmtSigned(g.decomposition.impressionEffect) },
    { label: 'Pos. eff.', align: 'right', value: (g) => fmtSigned(g.decomposition.positionEffect) },
    { label: 'CTR eff.', align: 'right', value: (g) => fmtSigned(g.decomposition.ctrEffect) },
    { label: 'Signal', value: (g) => signal(g.z) },
  ];
  return cols.filter(Boolean);
}

export function renderReport(r, meta) {
  const L = [];
  const s = r.site;
  const perDay = !r.sameLength;
  const unreliable = new Set(meta.unreliableMetrics || []);
  const flag = (m) => (unreliable.has(m) ? ' [UNRELIABLE: Search Console data anomaly]' : '');
  L.push(`# GSC comparison: ${meta.label}`, '');
  L.push(`- Property: ${meta.siteUrl}`);
  L.push(`- Pre: ${r.windows.pre.start} -> ${r.windows.pre.end} (${r.windows.pre.days} days, starts ${WEEKDAYS[weekday(r.windows.pre.start)]})`);
  L.push(`- Post: ${r.windows.post.start} -> ${r.windows.post.end} (${r.windows.post.days} days, starts ${WEEKDAYS[weekday(r.windows.post.start)]})`);
  if (meta.excluded && meta.excluded.length) L.push(`- Excluded deploy day(s) (PT): ${meta.excluded.join(', ')}`);
  if (meta.partial) L.push(`- PARTIAL: post window not final yet; both windows truncated to ${r.windows.post.days} days.`);
  L.push(`- Data: ${meta.dataState}${meta.offline ? ' (offline files; totals are sums of exported rows)' : ''}; dates are Pacific Time; generated ${meta.generatedAt}`);
  if (meta.scope) L.push(`- Scope: ${meta.scope}`);
  if (meta.excludedQueries) L.push(`- Excluded queries matching \`${meta.excludedQueries.pattern}\`: pre ${fmtInt(meta.excludedQueries.pre.clicks)} clicks / ${fmtInt(meta.excludedQueries.pre.impressions)} impr., post ${fmtInt(meta.excludedQueries.post.clicks)} / ${fmtInt(meta.excludedQueries.post.impressions)} removed from all totals (anonymized-query volume kept).`);
  L.push(`- Expected-CTR curve: ${r.curve}`, '');
  if (meta.warnings && meta.warnings.length) {
    L.push('## Warnings', '');
    for (const w of meta.warnings) L.push(`- ${w}`);
    L.push('');
  }
  if (meta.events && meta.events.length) {
    L.push('## External events and data anomalies in or between the windows', '');
    for (const e of meta.events) L.push(`- ${e.severity === 'warn' ? '**WARNING**' : e.severity === 'note' ? 'Note (unverified)' : 'Info'}: ${e.text}`);
    if (unreliable.size) L.push('', `**Not comparable across these windows: ${[...unreliable].join(', ')}.** Read the change from clicks (and treatment vs control on clicks) only.`);
    for (const a of meta.eventAdvice || []) L.push('', `_${a}_`);
    L.push('');
  }
  L.push('## Site', '');
  const rows = [
    { m: 'Clicks', a: fmtInt(s.pre.clicks), b: fmtInt(s.post.clicks), d: `${fmtSigned(s.delta.clicks)} (${fmtSignedPct(s.delta.clicksPct)}) ${signal(s.z)}` },
    { m: `Impressions${flag('impressions')}`, a: fmtInt(s.pre.impressions), b: fmtInt(s.post.impressions), d: `${fmtSigned(s.delta.impressions)} (${fmtSignedPct(s.delta.impressionsPct)})` },
  ];
  if (perDay) {
    rows.push({ m: 'Clicks per day', a: fmtNum(s.perDay.pre.clicks), b: fmtNum(s.perDay.post.clicks), d: fmtSignedPct(s.perDayDelta.clicksPct) });
    rows.push({ m: `Impressions per day${flag('impressions')}`, a: fmtNum(s.perDay.pre.impressions), b: fmtNum(s.perDay.post.impressions), d: fmtSignedPct(s.perDayDelta.impressionsPct) });
  }
  rows.push({ m: `CTR (raw)${flag('ctr')}`, a: fmtPct(s.pre.ctr, 2), b: fmtPct(s.post.ctr, 2), d: fmtPp(s.delta.ctr) });
  if (s.sameQueryCtr && s.sameQueryCtr.queries) {
    rows.push({ m: `Same-query CTR (${s.sameQueryCtr.queries} queries with >= ${s.sameQueryCtr.minImpr} impr. in both windows, weighted by pre impressions)${flag('ctr')}`, a: fmtPct(s.sameQueryCtr.pre, 2), b: fmtPct(s.sameQueryCtr.post, 2), d: fmtPp(s.sameQueryCtr.delta) });
  }
  if (s.sameQueryCtrSensitivity && s.sameQueryCtrSensitivity.queries) {
    const x = s.sameQueryCtrSensitivity;
    rows.push({ m: `Same-query CTR, sensitivity (>= ${x.minImpr} impr., ${x.queries} queries)`, a: fmtPct(x.pre, 2), b: fmtPct(x.post, 2), d: fmtPp(x.delta) });
  }
  rows.push({ m: `Avg position (impression-weighted, + = worse)${flag('position')}`, a: fmtPos(s.pre.position), b: fmtPos(s.post.position), d: s.delta.position === null ? '-' : fmtSigned(s.delta.position, 2) });
  L.push(mdTable([{ label: 'Metric', key: 'm' }, { label: 'Pre', key: 'a', align: 'right' }, { label: 'Post', key: 'b', align: 'right' }, { label: 'Change', key: 'd', align: 'right' }], rows));
  if (perDay) L.push('_Windows differ in length: compare the per-day rows, not the totals._', '');
  L.push('Click change decomposition:', '');
  L.push(mdTable(
    [{ label: 'Effect', key: 'e' }, { label: 'Clicks', key: 'v', align: 'right' }],
    [
      { e: 'Impressions (demand / visibility)', v: fmtSigned(s.decomposition.impressionEffect) },
      { e: 'Position (ranking, via CTR curve)', v: fmtSigned(s.decomposition.positionEffect) },
      { e: 'CTR at same position (snippet, SERP features, intent)', v: fmtSigned(s.decomposition.ctrEffect) },
      { e: `Subtotal (${s.decomposition.level} rows)`, v: fmtSigned(s.decomposition.total) },
      { e: 'Not attributable (anonymized queries / by-page vs by-property counting)', v: fmtSigned(s.decomposition.unattributed) },
    ],
  ));
  if (s.decomposition.level !== 'query+page') L.push(`_Decomposed on ${s.decomposition.level} rows, which mixes queries ranking at different positions (e.g. brand + generic on one page) and can exaggerate opposite position/CTR effects. Run without --no-fixed-set for query+page attribution._`, '');
  if (unreliable.size) L.push('_The impression, position and CTR effects above rest on unreliable impressions/positions; only the total click change is trustworthy._', '');
  L.push(`Read: ${s.read} Main driver: ${s.driver}.`, '');
  if (meta.yoy) {
    L.push('## Seasonality check (same windows, 364 days earlier)', '');
    if (meta.yoy.unreliableMetrics && meta.yoy.unreliableMetrics.length) L.push(`_Last year's windows touch a Search Console data anomaly: compare clicks only (${meta.yoy.unreliableMetrics.join(', ')} unreliable)._`, '');
    L.push(`Last year: clicks ${fmtInt(meta.yoy.pre.clicks)} -> ${fmtInt(meta.yoy.post.clicks)} (${fmtSignedPct(meta.yoy.delta.clicksPct)}), impressions ${fmtInt(meta.yoy.pre.impressions)} -> ${fmtInt(meta.yoy.post.impressions)} (${fmtSignedPct(meta.yoy.delta.impressionsPct)}).`);
    L.push('If last year moved the same way between the same windows, the change is likely seasonal.', '');
  }
  if (r.treated) {
    const t = r.treated;
    L.push('## Treatment vs control (difference-in-differences)', '');
    L.push(mdTable(groupColumns(true), [t.treated, t.control]));
    L.push(`Net change vs control (per-day ratio of ratios): clicks ${fmtSignedPct(t.netClicksPct)}, impressions ${fmtSignedPct(t.netImpressionsPct)}.`);
    if (t.did) {
      for (const m of ['clicks', 'impressions']) {
        const d = t.did[m];
        L.push(`- ${m}: treatment ${fmtSignedPct(d.treatmentChange)} vs control ${fmtSignedPct(d.controlChange)}; net effect (daily log-ratio) ${fmtSignedPct(d.netEffect)}, p = ${d.pValue.toFixed(3)} (${d.method})${d.pValue < 0.05 ? ' -> unlikely to be noise' : ' -> could be noise'}`);
      }
      L.push('');
    } else if (t.binomial && t.binomial.pValue !== null) {
      L.push(`- No daily data: hand DiD on totals: net effect ${fmtSignedPct(t.binomial.netEffect)}, two-sided binomial p = ${t.binomial.pValue.toFixed(3)} (k = treatment post clicks, n = pre + post, p0 = n1*r_c/(n0 + n1*r_c)).`, '');
    } else L.push('_No daily data and not enough clicks for a p-value._', '');
    if (t.sampleTooSmall) L.push('**Sample too small**: treatment has fewer than 10 clicks across both windows; do not conclude.', '');
    if (t.urls.length) {
      L.push(mdTable(
        [
          { label: 'URL', value: (u) => shortUrl(u.url) },
          { label: 'Clicks', align: 'right', value: (u) => `${fmtInt(u.pre.clicks)} -> ${fmtInt(u.post.clicks)}` },
          { label: 'Impr.', align: 'right', value: (u) => `${fmtInt(u.pre.impressions)} -> ${fmtInt(u.post.impressions)}` },
          { label: 'CTR', align: 'right', value: (u) => `${fmtPct(u.pre.ctr, 2)} -> ${fmtPct(u.post.ctr, 2)}` },
          { label: 'Pos', align: 'right', value: (u) => `${fmtPos(u.pre.position)} -> ${fmtPos(u.post.position)}` },
          { label: 'Signal', value: (u) => signal(u.z) },
          { label: 'Top queries (impr pre->post @pos)', value: (u) => u.topQueries.slice(0, 4).map((q) => `${q.query} ${fmtInt(q.pre.impressions)}->${fmtInt(q.post.impressions)} @${fmtPos(q.post.position || q.pre.position)}`).join('; ') },
        ],
        t.urls,
      ));
    }
  }
  if (meta.placebo) {
    const p = meta.placebo;
    L.push(`## Placebo test (deploy moved ${p.shift} days earlier)`, '');
    L.push(`Placebo windows: ${p.windows.pre.start} -> ${p.windows.pre.end} vs ${p.windows.post.start} -> ${p.windows.post.end}.`);
    L.push(`${p.verdict.metric}: real ${fmtSignedPct(p.verdict.real)} vs placebo ${fmtSignedPct(p.verdict.placebo)}${p.verdict.placeboP !== null && p.verdict.placeboP !== undefined ? ` (placebo p = ${p.verdict.placeboP.toFixed(3)})` : ''}.`);
    L.push(`**${p.verdict.flag ? 'FLAG' : 'OK'}**: ${p.verdict.note}`);
    if (p.overlapsDeploy) L.push(`- Note: the placebo post window overlaps the real deploy; use --placebo-shift ${p.minimalShift} (window + excluded deploy days) or more, or simply --placebo.`);
    L.push('');
  }
  if (r.topTen && r.topTen.length) {
    L.push('## Days in top 10 (position <= 10.5 with >= 5 impressions)', '', '_A falling boundary share (impressions while ranking 8.5-10.5) often precedes dropping off page 1._', '');
    L.push(mdTable(
      [
        { label: 'Query', value: (x) => x.query },
        { label: 'Pre', align: 'right', value: (x) => `${x.pre.top10Days}/${x.pre.days}` },
        { label: 'Post', align: 'right', value: (x) => `${x.post.top10Days}/${x.post.days}` },
        { label: 'Impr./day', align: 'right', value: (x) => `${fmtNum(x.pre.impressionsPerDay)} -> ${fmtNum(x.post.impressionsPerDay)}` },
        { label: 'Pos', align: 'right', value: (x) => `${fmtPos(x.pre.position)} -> ${fmtPos(x.post.position)}` },
        { label: 'Boundary impr. share (pos 8.5-10.5)', align: 'right', value: (x) => `${fmtPct(x.pre.boundaryShare, 1)} -> ${fmtPct(x.post.boundaryShare, 1)}` },
      ],
      r.topTen,
    ));
  }
  if (r.pageGroups.length) L.push('## Page groups', '', mdTable(groupColumns(perDay), r.pageGroups));
  if (r.queryGroups.length) L.push('## Query groups', '', '_Named queries only (Google omits anonymized queries)._', '', mdTable(groupColumns(perDay, { sameQuery: true }), r.queryGroups));
  for (const [dim, groups] of Object.entries(r.slices || {})) L.push(`## Slice: ${dim}`, '', mdTable(groupColumns(perDay), groups));
  if (r.fixedSet) {
    const f = r.fixedSet;
    L.push('## Like-for-like ranking (fixed query+page set)', '');
    L.push(`Pairs with >= ${f.minImpressions} pre-window impressions: ${f.paired} still ranking, ${f.lost} disappeared (${f.lostImprPerDay.toFixed(1)} impressions/day lost).`);
    L.push(`Impression-weighted position change: ${f.positionDelta === null ? '-' : fmtSigned(f.positionDelta, 2)} (+ = worse). Impressions/day on kept pairs: ${f.preImprPerDay.toFixed(1)} -> ${f.postImprPerDay.toFixed(1)}.`, '');
    L.push(mdTable(
      [
        { label: 'Pre position', key: 'name' },
        { label: 'Pairs', key: 'pairs', align: 'right' },
        { label: 'Δ position', align: 'right', value: (b) => (b.positionDelta === null ? '-' : fmtSigned(b.positionDelta, 2)) },
        { label: 'Impr./day pre -> post', align: 'right', value: (b) => `${b.preImprPerDay.toFixed(1)} -> ${b.postImprPerDay.toFixed(1)}` },
      ],
      f.buckets,
    ));
  }
  const moverTable = (title, m, fmtKey) => {
    if (!m) return;
    const cols = [
      { label: 'Key', value: (x) => fmtKey(x.key) },
      { label: 'Clicks', align: 'right', value: (x) => `${fmtInt(x.pre.clicks)} -> ${fmtInt(x.post.clicks)} (${fmtSigned(x.delta.clicks)})` },
      { label: 'Impr.', align: 'right', value: (x) => `${fmtInt(x.pre.impressions)} -> ${fmtInt(x.post.impressions)}` },
      { label: 'Pos', align: 'right', value: (x) => `${fmtPos(x.pre.position)} -> ${fmtPos(x.post.position)}` },
    ];
    L.push(`## ${title}: biggest losers`, '', mdTable(cols, m.losers));
    L.push(`## ${title}: biggest gainers`, '', mdTable(cols, m.gainers));
  };
  moverTable('Pages', r.movers.pages, (k) => shortUrl(k));
  moverTable('Queries', r.movers.queries, (k) => k);
  L.push('## How to read this', '');
  L.push('- Signal: Poisson z-score on clicks; |z| < 2 is within normal noise for these volumes.');
  L.push('- Raw CTR mixes in new/lost queries; same-query CTR holds the query set fixed, so it isolates snippet/SERP effects.');
  L.push('- Impression effect = demand or new/lost rankings; position effect = ranking moves; CTR effect = same position, different click-through.');
  L.push('- Credit a change only if treatment beats control (p < 0.05), the placebo is clean and the seasonality check does not show the same pattern.');
  L.push('- Do not ship another change to the same URLs until the last acceptance checkpoint is reviewed.', '');
  return L.join('\n');
}

// ---------- data ----------
function byKeys(rows, dims) {
  return [...groupMetrics(rows, (r) => dims.map((d) => r[d]).join('\t'))].map(([k, m]) => {
    const parts = k.split('\t');
    const rec = {};
    dims.forEach((d, i) => {
      rec[d] = parts[i];
    });
    return { ...rec, ...m };
  });
}

/** Build a window from flat rows (offline). */
export function deriveWindow(rows, dims, range, { pageRe, targetQueries = [], excludeRe = null } = {}) {
  const has = (d) => dims.includes(d);
  let scoped = pageRe && has('page') ? rows.filter((r) => pageRe.test(r.page)) : rows;
  if (has('date') && range.start !== '?') scoped = scoped.filter((r) => r.date >= range.start && r.date <= range.end);
  let excluded = null;
  if (excludeRe && has('query')) {
    excluded = aggregate(scoped.filter((r) => excludeRe.test(r.query)));
    scoped = scoped.filter((r) => !excludeRe.test(r.query));
  }
  const keys = new Set(targetQueries.map(compactKey));
  return {
    range,
    totals: aggregate(scoped),
    pages: has('page') ? byKeys(scoped, ['page']) : [],
    queries: has('query') ? byKeys(scoped, ['query']) : [],
    qp: has('query') && has('page') ? byKeys(scoped, ['query', 'page']) : null,
    dailyPages: has('date') && has('page') ? byKeys(scoped, ['date', 'page']) : null,
    dailyQueries: has('date') && has('query') ? byKeys(scoped.filter((r) => !keys.size || keys.has(compactKey(r.query))), ['date', 'query']) : null,
    slices: Object.fromEntries(SLICE_DIMS.filter(has).map((d) => [d, byKeys(scoped, [d])])),
    excluded,
  };
}

const re2Quote = (s) => s.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');

async function fetchWindow(gsc, range, { dataState, filters, wantFixedSet, wantDaily, targetQueries, sliceDims, excludeQuery }) {
  const base = { startDate: range.start, endDate: range.end, type: 'web', dataState, dimensionFilterGroups: filters };
  const q = (dimensions, extraFilters) => gsc.query({ ...base, dimensions, ...(extraFilters ? { dimensionFilterGroups: extraFilters } : {}) });
  log(`  ${range.start} -> ${range.end}`);
  const tqFilter = targetQueries.length
    ? [{ groupType: 'and', filters: [...(filters[0] ? filters[0].filters : []), { dimension: 'query', operator: 'includingRegex', expression: `^(${targetQueries.map((t) => re2Quote(t.toLowerCase())).join('|')})$` }] }]
    : null;
  const [totals, pages, queries, qp, dailyPages, dailyQueries, ...slices] = await Promise.all([
    q([]),
    q(['page']),
    q(['query']),
    wantFixedSet ? q(['query', 'page']) : null,
    wantDaily ? q(['date', 'page']) : null,
    tqFilter ? q(['date', 'query'], tqFilter) : null,
    ...sliceDims.map((d) => q([d])),
  ]);
  const win = {
    range,
    totals: aggregate(totals.rows),
    pages: pages.rows,
    queries: queries.rows,
    qp: qp ? qp.rows : null,
    dailyPages: dailyPages ? dailyPages.rows : null,
    dailyQueries: dailyQueries ? dailyQueries.rows : null,
    slices: Object.fromEntries(sliceDims.map((d, i) => [d, slices[i].rows])),
    excluded: null,
  };
  if (excludeQuery) {
    // subtract only the anomalous queries; page/site totals keep their anonymized-query volume
    const exFilter = [{ groupType: 'and', filters: [...(filters[0] ? filters[0].filters : []), { dimension: 'query', operator: 'includingRegex', expression: excludeQuery }] }];
    const [exQp, exDaily] = await Promise.all([q(['query', 'page'], exFilter), wantDaily ? q(['date', 'query', 'page'], exFilter) : null]);
    const re = re2ToJs(excludeQuery);
    const ex = aggregate(exQp.rows);
    win.excluded = ex;
    const t = win.totals;
    const imp = Math.max(0, t.impressions - ex.impressions);
    const pw = t.position * t.impressions - ex.position * ex.impressions;
    win.totals = { ...t, clicks: Math.max(0, t.clicks - ex.clicks), impressions: imp, ctr: imp ? Math.max(0, t.clicks - ex.clicks) / imp : 0, position: imp && pw > 0 ? pw / imp : t.position };
    win.pages = subtractRows(win.pages, exQp.rows, ['page']);
    win.queries = win.queries.filter((r) => !re.test(r.query));
    if (win.qp) win.qp = win.qp.filter((r) => !re.test(r.query));
    if (win.dailyPages && exDaily) win.dailyPages = subtractRows(win.dailyPages, exDaily.rows, ['date', 'page']);
    if (win.dailyQueries) win.dailyQueries = win.dailyQueries.filter((r) => !re.test(r.query));
  }
  return win;
}

function shiftRange(r, days) {
  return { start: addDays(r.start, -days), end: addDays(r.end, -days), days: r.days };
}

function overlaps(range, days) {
  return days.some((d) => d >= range.start && d <= range.end);
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const siteTz = ws.timezone();
  const brandTerms = [...ws.brandTerms(), ...flags.brandTerm];
  const isBrand = makeBrandMatcher(brandTerms);
  for (const d of flags.by) if (!SLICE_DIMS.includes(d)) throw new UserError(`--by "${d}" is not supported`, { hint: `Use: ${SLICE_DIMS.join(', ')}` });
  const queryGroups = [
    ...Object.entries(ws.config.queryGroups || {}).map(([name, re]) => ({ name, re: new RegExp(re, 'i') })),
    ...flags.queryGroup.map((g) => {
      const eq = g.indexOf('=');
      if (eq < 1) throw new UserError(`--query-group "${g}" must look like name=regex`);
      return { name: g.slice(0, eq), re: new RegExp(g.slice(eq + 1), 'i') };
    }),
  ];
  let guardrails = ws.guardrails().map((g) => g.query);
  let treated = collectList(flags.urls, flags.urlsFile);
  let pre;
  let post;
  let excluded = [];
  let label = flags.label;
  let wave = null;
  let checkpointLabel = '';
  const warnings = [];

  if (flags.wave) {
    wave = findWave(loadWaves(ws), flags.wave);
    const offset = flags.checkpoint ? Number(String(flags.checkpoint).replace(/^D\+/i, '')) : flags.window;
    if (!Number.isInteger(offset) || offset < 1) throw new UserError(`Invalid --checkpoint "${flags.checkpoint}" (use D+7, D+14, ...)`);
    ({ pre, post, excluded } = deployWindows(wave.date, offset, { siteTz: wave.timezone || siteTz, alignWeekday: !flags.noAlignWeekday, excludeExtraDays: flags.excludeExtraDays }));
    if (!treated.length) treated = wave.urls || [];
    guardrails = [...new Set([...guardrails, ...(wave.guardrails || [])])];
    checkpointLabel = `D+${offset}`;
    label = label || `${wave.id}-${checkpointLabel}`;
  } else if (flags.pre && flags.post) {
    const a = parseRangeArg(flags.pre, 'pre');
    const b = parseRangeArg(flags.post, 'post');
    pre = { ...a, days: spanDays(a.start, a.end) };
    post = { ...b, days: spanDays(b.start, b.end) };
    if (pre.days !== post.days) warnings.push(`Windows differ in length (${pre.days} vs ${post.days} days): use the per-day figures.`);
    if ((pre.days % 7 !== 0 || post.days % 7 !== 0) && weekday(pre.start) !== weekday(post.start)) warnings.push('Windows are not weekday-aligned; weekly seasonality may bias the result.');
    if (flags.deployDate) {
      assertYmd(flags.deployDate, '--deploy-date');
      excluded = deployWindows(flags.deployDate, 1, { siteTz }).excluded;
      const bad = [pre, post].filter((r) => overlaps(r, excluded));
      if (bad.length && !flags.allowDeployDay) {
        throw new UserError(`A window contains the deploy day (${excluded.join(', ')} PT)`, { hint: ['Use --deploy-date with --window to build clean windows, or move the windows.', 'Pass --allow-deploy-day only if you know why.'] });
      }
      if (bad.length) warnings.push(`A window contains the deploy day (${excluded.join(', ')} PT).`);
    }
    label = label || `${pre.start}_vs_${post.start}`;
  } else if (flags.deployDate) {
    assertYmd(flags.deployDate, '--deploy-date');
    const w = deployWindows(flags.deployDate, flags.window, { siteTz, alignWeekday: !flags.noAlignWeekday, excludeExtraDays: flags.excludeExtraDays });
    ({ pre, post, excluded } = w);
    if (w.shift) log(`Pre window shifted back ${w.shift} day(s) so both windows start on a ${WEEKDAYS[weekday(post.start)]}.`);
    label = label || `deploy-${flags.deployDate}-w${flags.window}`;
  }
  const rolling = !pre && !(flags.preInput && flags.postInput);
  if (flags.input && (flags.preInput || flags.postInput)) throw new UserError('Use either --input or --pre-input/--post-input, not both');
  if (rolling && flags.input) throw new UserError('--input needs windows: add --deploy-date, --pre/--post or --wave');

  const treatedSet = treated.length ? new Set(treated.map((u) => normalizeUrl(/^https?:/i.test(u) ? u : new URL(u, ws.origin()).href, { stripTracking: true }))) : null;
  const treatment = flags.treatment ? pageMatcher(flags.treatment) : null;
  const control = flags.control ? pageMatcher(flags.control) : null;
  if (flags.control && !flags.treatment && !treatedSet) throw new UserError('--control needs --treatment (or --urls/--wave)');
  const wantDaily = Boolean(treatment || treatedSet);
  const targetQueries = [...new Set([...guardrails, ...flags.targetQuery])];
  const pageRe = flags.pageRegex ? new RegExp(flags.pageRegex) : null;
  const excludeRe = flags.excludeQuery ? re2ToJs(flags.excludeQuery) : null;
  let preData;
  let postData;
  let partial = false;
  let offline = false;
  let siteUrl = ws.config.gsc.siteUrl || '(offline)';
  let yoy = null;
  let fetcher = null;

  if (flags.input) {
    offline = true;
    const file = loadGscFile(path.resolve(flags.input));
    if (!file.dimensions.includes('date')) throw new UserError('--input must contain a date dimension (export with --dimensions date,query,page)');
    const dates = file.rows.map((r) => r.date).sort();
    if (dates.length && (pre.start < dates[0] || post.end > dates[dates.length - 1])) warnings.push(`Input covers ${dates[0]} -> ${dates[dates.length - 1]}; windows outside it count as zero.`);
    const meta0 = file.meta || {};
    if (meta0.dataState && meta0.dataState !== 'final') warnings.push(`Input was exported with dataState=${meta0.dataState}: the newest days may be provisional.`);
    if (meta0.fetchedAt && post && new Date(meta0.fetchedAt).getTime() < Date.parse(`${addDays(post.end, 2)}T00:00:00Z`)) warnings.push(`Input was exported at ${meta0.fetchedAt}, less than 2 days after the post window ends (${post.end}); re-export once the data is final.`);
    fetcher = async (range) => deriveWindow(file.rows, file.dimensions, range, { pageRe, targetQueries, excludeRe });
  } else if (flags.preInput || flags.postInput) {
    if (!(flags.preInput && flags.postInput)) throw new UserError('--pre-input and --post-input must be used together');
    offline = true;
    const load = (f, explicit) => {
      const file = loadGscFile(path.resolve(f));
      const m = file.meta || {};
      let range = null;
      if (explicit) range = explicit;
      else if (m.startDate && m.endDate) range = { start: m.startDate, end: m.endDate, days: spanDays(m.startDate, m.endDate) };
      else if (file.dimensions.includes('date')) {
        const dates = file.rows.map((r) => r.date).filter(Boolean).sort();
        if (dates.length) range = { start: dates[0], end: dates[dates.length - 1], days: spanDays(dates[0], dates[dates.length - 1]) };
      }
      if (!range) throw new UserError(`Cannot tell which dates ${path.basename(f)} covers (no gsc-export meta and no date column)`, { hint: 'Pass the windows explicitly: --pre YYYY-MM-DD:YYYY-MM-DD --post YYYY-MM-DD:YYYY-MM-DD, or export with gsc-export.mjs (JSON keeps the dates).' });
      return deriveWindow(file.rows, file.dimensions, range, { pageRe, targetQueries, excludeRe });
    };
    preData = load(flags.preInput, pre || null);
    postData = load(flags.postInput, post || null);
    if (preData.range.days !== postData.range.days) warnings.push(`Windows differ in length (${preData.range.days} vs ${postData.range.days} days): use the per-day figures.`);
    label = label || `${preData.range.start}_vs_${postData.range.start}`;
  } else {
    const gsc = gscClient(ws, flags);
    siteUrl = gsc.siteUrl;
    if (rolling) {
      const latest = flags.dataState === 'final' ? await gsc.latestFinalDate() : addDays(gscToday(), -1);
      post = { start: addDays(latest, -(flags.window - 1)), end: latest, days: flags.window };
      pre = { start: addDays(post.start, -flags.window), end: addDays(post.start, -1), days: flags.window };
      label = label || `rolling-${flags.window}d`;
      log(`No windows given: comparing the last ${flags.window} final days with the ${flags.window} days before.`);
    }
    if (flags.dataState === 'final') {
      const latest = await gsc.latestFinalDate();
      if (post.end > latest) {
        const available = diffDays(post.start, latest) + 1;
        if (!flags.allowPartial || available < 1) {
          throw new UserError(`Post window ends ${post.end} but final Search Console data only reaches ${latest} (PT)`, {
            hint: [`Re-run on or after ${finalDataReadyOn(post.end, siteTz)} (${siteTz}).`, available >= 1 ? `Or pass --allow-partial to compare the first ${available} day(s) of each window now.` : 'The post window has no final data yet.', 'Or pass --data-state all to include provisional data (may still change).'],
          });
        }
        partial = true;
        post = { start: post.start, end: latest, days: available };
        pre = { start: pre.start, end: addDays(pre.start, available - 1), days: available };
        warnings.push(`Post window not final yet: compared only ${available} day(s) per window.`);
      }
    } else warnings.push('data-state=all: the newest days are provisional and may still change.');
    const filters = buildFilters({ pageRegex: flags.pageRegex });
    const opts = { dataState: flags.dataState, filters, wantFixedSet: !flags.noFixedSet, wantDaily, targetQueries, sliceDims: flags.by, excludeQuery: flags.excludeQuery };
    fetcher = (range) => fetchWindow(gsc, range, opts);
    log(`Fetching ${siteUrl}...`);
    if (flags.yoy) {
      const ly = await Promise.all([yoyWindow(pre), yoyWindow(post)].map((r) => gsc.query({ startDate: r.start, endDate: r.end, dimensions: [], type: 'web', dataState: 'final', dimensionFilterGroups: filters })));
      const a = aggregate(ly[0].rows);
      const b = aggregate(ly[1].rows);
      yoy = { pre: a, post: b, delta: deltas(a, b) };
    }
  }
  if (fetcher) {
    preData = await fetcher(pre);
    postData = await fetcher(post);
  }

  // other deploys inside the windows
  if (fs.existsSync(ws.path('logs', 'experiments.json'))) {
    for (const w of loadWaves(ws)) {
      if (wave && w.id === wave.id) continue;
      if (w.type === 'external-event' || w.status === 'planned') continue; // external events: see the events check below; planned = not deployed
      const days = deployWindows(w.date, 1, { siteTz: w.timezone || siteTz }).excluded;
      for (const [name, r] of [['pre', preData.range], ['post', postData.range]]) {
        if (r.start !== '?' && overlaps(r, days)) warnings.push(`Wave ${w.id} was deployed on ${w.date}, inside the ${name} window${treated.some((u) => (w.urls || []).includes(u)) ? ' on the SAME URLs' : ''}; results mix both changes.`);
      }
    }
  }

  // Google updates, Search Console anomalies and logged external events overlapping the windows
  const allEvents = loadEvents(ws, { today: gscToday() });
  const evWindows = [{ name: 'pre', ...preData.range }, { name: 'post', ...postData.range }];
  const appearance = flags.by.includes('searchAppearance');
  const evHits = overlapEvents(allEvents, evWindows, { appearance });
  const reliability = metricReliability(allEvents, evWindows, { appearance });
  const eventWarnings = evHits.filter((h) => h.event.severity === 'warn').map(describeOverlap);
  if (reliability.unreliable.length) eventWarnings.push(`Search Console data anomaly: ${reliability.unreliable.join(', ')} are not comparable across these windows; judge on clicks only.`);
  if (yoy) {
    const yoyWindows = [{ name: 'pre (last year)', ...yoyWindow(preData.range) }, { name: 'post (last year)', ...yoyWindow(postData.range) }];
    yoy.unreliableMetrics = metricReliability(allEvents, yoyWindows).unreliable;
  }

  const curveRows = preData.qp || preData.queries;
  const curve = loadCtrCurve(flags.ctrCurve, curveRows, { isBrand });
  const otherWaveUrls = new Set();
  if (fs.existsSync(ws.path('logs', 'experiments.json'))) {
    for (const w of loadWaves(ws)) if (!wave || w.id !== wave.id) for (const u of w.urls || []) otherWaveUrls.add(normalizeUrl(u) || u);
  }
  const compareOpts = {
    controlMinImpr: flags.controlMinImpr,
    excludedFromControl: otherWaveUrls,
    pageGroupOf: (u) => ws.pageGroupOf(u),
    isBrand,
    hasBrand: brandTerms.length > 0,
    guardrails,
    targetQueries: flags.targetQuery,
    queryGroups,
    treatedUrls: treatedSet,
    treatment,
    control,
    curve,
    minImpressions: flags.minImpressions,
    minImpr: flags.minImpr,
    top: flags.top,
  };
  const result = computeComparison(preData, postData, compareOpts);

  let placebo = null;
  const gap = diffDays(preData.range.end, postData.range.start) - 1;
  const minimalShift = postData.range.days + Math.max(gap, excluded.length);
  if (flags.placeboShift || flags.placebo) {
    if (!fetcher) throw new UserError('--placebo-shift needs API access or --input (with a date dimension)');
    const raw = flags.placebo || String(flags.placeboShift).toLowerCase() === 'auto' ? minimalShift : Number(flags.placeboShift);
    if (!Number.isInteger(raw) || raw < 1) throw new UserError(`--placebo-shift must be a positive whole number or "auto" (got "${flags.placeboShift}")`);
    const pPre = shiftRange(preData.range, raw);
    const pPost = shiftRange(postData.range, raw);
    log(`Placebo windows (shift ${raw} days): ${pPre.start}..${pPre.end} vs ${pPost.start}..${pPost.end}`);
    const pr = computeComparison(await fetcher(pPre), await fetcher(pPost), compareOpts);
    const firstPostDay = excluded.length ? excluded[0] : postData.range.start;
    placebo = { shift: raw, minimalShift, windows: { pre: pPre, post: pPost }, verdict: placeboVerdict(result, pr), overlapsDeploy: pPost.end >= firstPostDay };
    if (placebo.overlapsDeploy) warnings.push(`Placebo post window overlaps the real deploy: use --placebo-shift ${minimalShift} or more (or --placebo).`);
    const pHits = overlapEvents(allEvents, [{ name: 'placebo pre', ...pPre }, { name: 'placebo post', ...pPost }], { kinds: ['core', 'spam', 'ranking-other', 'site'] });
    if (pHits.length) warnings.push(`Placebo windows overlap ${pHits.map((h) => h.event.title).join('; ')}: a placebo "effect" there may be the update, not a trend.`);
    if (placebo.verdict.flag) warnings.push(placebo.verdict.note);
  }

  const meta = {
    label,
    siteUrl,
    excludedQueries: flags.excludeQuery ? { pattern: flags.excludeQuery, pre: preData.excluded || { clicks: 0, impressions: 0 }, post: postData.excluded || { clicks: 0, impressions: 0 } } : null,
    dataState: flags.dataState,
    offline,
    partial,
    excluded,
    yoy,
    placebo,
    warnings,
    events: evHits.map((h) => ({ id: h.event.id, kind: h.event.kind, title: h.event.title, start: h.event.start, end: h.event.end, severity: h.event.severity, affects: h.event.affects || [], windows: h.windows, between: h.between, url: h.event.url, text: describeOverlap(h) })),
    eventAdvice: overlapAdvice(evHits),
    unreliableMetrics: reliability.unreliable,
    wave: wave ? wave.id : null,
    checkpoint: checkpointLabel || null,
    scope: flags.pageRegex ? `pages matching ${flags.pageRegex}` : '',
    generatedAt: new Date().toISOString(),
  };
  const fileLabel = slugify(label, 80) || 'compare';
  const jsonPath = writeJson(ws.dataFile('gsc', `compare-${fileLabel}`, 'json'), { meta, result });
  const mdPath = writeText(ws.path('logs', 'reviews', `${ws.today()}-compare-${fileLabel}.md`), renderReport(result, meta));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ meta, result, files: { json: jsonPath, markdown: mdPath } }, null, 2)}\n`);
    return 0;
  }
  const s = result.site;
  out(`${label}: pre ${result.windows.pre.start}..${result.windows.pre.end} vs post ${result.windows.post.start}..${result.windows.post.end}${partial ? ' (PARTIAL)' : ''}`);
  for (const w of [...warnings, ...eventWarnings]) out(`WARNING: ${w}`);
  out(`Clicks ${fmtInt(s.pre.clicks)} -> ${fmtInt(s.post.clicks)} (${fmtSignedPct(s.delta.clicksPct)}, ${signal(s.z)}); impressions ${fmtSignedPct(s.delta.impressionsPct)}; CTR ${fmtPp(s.delta.ctr)}${s.sameQueryCtr && s.sameQueryCtr.queries ? ` (same-query ${fmtPp(s.sameQueryCtr.delta)})` : ''}; position ${s.delta.position === null ? '-' : fmtSigned(s.delta.position, 2)}`);
  out(`Decomposition (${s.decomposition.level} rows): impressions ${fmtSigned(s.decomposition.impressionEffect)}, position ${fmtSigned(s.decomposition.positionEffect)}, CTR ${fmtSigned(s.decomposition.ctrEffect)}${reliability.unreliable.length ? ' (UNRELIABLE: impressions/positions affected by a Search Console anomaly)' : ''}`);
  for (const h of evHits.filter((x) => x.event.severity !== 'warn')) out(`${h.event.severity === 'note' ? 'NOTE (unverified)' : 'INFO'}: ${describeOverlap(h)}`);
  if (result.treated) {
    const t = result.treated;
    out(`Treatment vs control: net clicks ${fmtSignedPct(t.netClicksPct)}${t.did ? `, DiD p = ${t.did.clicks.pValue.toFixed(3)}` : ''}`);
  }
  if (placebo) out(`Placebo (-${placebo.shift}d): ${placebo.verdict.flag ? 'FLAG' : 'ok'} - ${placebo.verdict.note}`);
  if (result.fixedSet && result.fixedSet.positionDelta !== null) out(`Like-for-like position change: ${fmtSigned(result.fixedSet.positionDelta, 2)} over ${result.fixedSet.paired} query+page pairs (${result.fixedSet.lost} lost)`);
  out(`Read: ${s.read}`);
  out(`\nwrote ${mdPath}\nwrote ${jsonPath}`);
  if (wave) {
    const verdict = checkpointLabel === 'D+7' ? '--verdict inconclusive --notes "<risk and direction only>"' : '--verdict <keep|iterate|revert|inconclusive>';
    out(`\nRecord the review: ${scriptCmd('log-change.mjs')} checkpoint --wave ${wave.id} --checkpoint ${checkpointLabel} ${verdict} --report ${mdPath}`);
  }
  return 0;
}

runMain(import.meta.url, main);
