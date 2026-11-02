#!/usr/bin/env node
// Randomized page-group SEO split test: stratified, seeded assignment of similar pages into variant and control,
// D0 logging, and evaluation (difference-in-differences, page re-randomization, placebo, Google-update warnings).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, normalizeUrl, collectList, slugify, scriptCmd, ensureDir } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { gscClient, loadGscFile } from './lib/gsc.mjs';
import { readCsvFile } from './lib/csv.mjs';
import { addDays, diffDays, deployWindows, parseLocalDateTime, formatInTz, ymdInTz, GSC_TZ, isYmd, spanDays, gscDaysForLocalDate } from './lib/dates.mjs';
import { mulberry32 } from './lib/stats.mjs';
import { DEFAULT_CTR_CURVE } from './lib/metrics.mjs';
import { loadWaves, saveWaves, findWave, buildCheckpoints, normalizeUrls, findOverlaps, changesEntry, appendChangesLog } from './lib/experiments.mjs';
import { loadEvents, overlapEvents, describeOverlap, overlapAdvice, metricReliability } from './lib/events.mjs';
import { deriveWindow, computeComparison, placeboVerdict } from './gsc-compare.mjs';
import { mdTable, fmtInt, fmtNum, fmtPct, fmtPos, fmtSignedPct, textTable } from './lib/format.mjs';

const SUBCOMMANDS = ['assign', 'start', 'evaluate', 'list'];

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  site: { type: 'string', placeholder: 'property', desc: 'Override gsc.siteUrl (API mode)' },
  id: { type: 'string', desc: 'start/evaluate: split test id (ST-...)' },
  title: { type: 'string', desc: 'assign: what you will change (used in the id)' },
  'urls-file': { type: 'string', placeholder: 'file', desc: 'assign: candidate pages, one per line' },
  'page-group': { type: 'string', placeholder: 'name', desc: 'assign: all pages of a config.pageGroups group (from --input, else the newest crawl)' },
  input: { type: 'string', placeholder: 'file', desc: 'assign: GSC export with page (or date,page) for the pre-period; evaluate: export with date,page covering the windows (offline)' },
  days: { type: 'int', desc: 'assign: pre-period length for strata and balance (last N days of the input or the API)', default: 28 },
  seed: { type: 'int', desc: 'assign: random seed (default: today as YYYYMMDD); the seed used is stored' },
  'max-imbalance': { type: 'number', desc: 'assign: largest relative difference allowed in clicks, impressions, CTR and position', default: 0.1 },
  tries: { type: 'int', desc: 'assign: re-draws (seed+1, seed+2, ...) until balanced', default: 50 },
  'min-pages': { type: 'int', desc: 'assign: refuse when a group has fewer pages', default: 30 },
  'min-impressions': { type: 'int', desc: 'assign: refuse when a group has fewer pre-period impressions', default: 1000 },
  force: { type: 'boolean', desc: 'assign: accept small/unbalanced groups; start: record despite overlaps or a second start' },
  at: { type: 'string', placeholder: 'time', desc: 'start: deploy-complete time, "YYYY-MM-DD HH:MM" in site time zone or ISO with offset (default: now)' },
  date: { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'start: D0 date when the exact time is unknown' },
  checkpoints: { type: 'csv', placeholder: 'days', desc: 'start: acceptance offsets', default: ['14', '28'] },
  checkpoint: { type: 'string', placeholder: 'D+N', desc: 'evaluate: checkpoint (default: the latest one whose data is final)' },
  'no-placebo': { type: 'boolean', desc: 'evaluate: skip the placebo windows' },
  draws: { type: 'int', desc: 'evaluate: page re-randomization draws', default: 5000 },
  json: { type: 'boolean', desc: 'Print JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/split-test.mjs assign --page-group <name> --input <gsc page export> --title "..." [--seed N]',
    'node scripts/split-test.mjs assign --urls-file pages.txt --input <gsc export> --title "..."',
    'node scripts/split-test.mjs start --id <ST-id> --at "YYYY-MM-DD HH:MM"',
    'node scripts/split-test.mjs evaluate --id <ST-id> [--checkpoint D+28] [--input <gsc date,page export>]',
    'node scripts/split-test.mjs list',
  ],
  summary:
    'SEO split test on pages, not visitors (one URL has one Google ranking): many similar pages of one template are split at random into ' +
    'variant and control; only the variant pages get the change. assign: strata = pre-period impression quartiles (pages without data form ' +
    'their own stratum); inside each stratum pages are paired by traffic and each pair is split 50/50 with a seeded PRNG; the draw is repeated ' +
    '(seed+1, ...) until both groups match on clicks, impressions, CTR and position within --max-imbalance. Refuses groups under --min-pages ' +
    'or --min-impressions unless --force. Writes data/experiments/<id>-variant.txt, -control.txt, -assignment.json and a planned record in ' +
    'logs/experiments.json. start: records D0 (site time zone and PT), D+14/D+28 checkpoints and a logs/changes.md entry. evaluate: fixed ' +
    'windows around D0 (deploy days excluded), difference-in-differences of daily clicks (time permutation, as gsc-compare) plus a page ' +
    're-randomization p-value over the stored pairs, a placebo with both windows moved before D0, per-group tables, and warnings when a ' +
    'Google update or Search Console anomaly overlaps the windows. Writes data/experiments/<id>-<checkpoint>-evaluation.json and ' +
    'logs/reviews/<today>-split-test-<id>.md.',
  spec: SPEC,
  examples: [
    'node scripts/split-test.mjs assign --page-group products --input .seo-agent/data/gsc/2026-11-01-date-page-90d.json --title "Price in title"',
    'node scripts/split-test.mjs start --id ST-2026-11-02-price-in-title --at "2026-11-05 21:30"',
    'node scripts/split-test.mjs evaluate --id ST-2026-11-02-price-in-title --checkpoint D+28 --input .seo-agent/data/gsc/2026-12-08-date-page.json',
  ],
  notes: [
    'Change ONLY the variant URLs, all at once, and nothing else on either group until the last checkpoint is reviewed.',
    'Weekly time permutation cannot reach p < 0.05 at D+14 (6 orderings); the page re-randomization p can. D+14 = direction, D+28 = decision.',
    'A significant result with a flagged placebo or an overlapping Google update is not a win: wait, or rerun the test.',
    'Without --input, evaluate and assign query the Search Console API for the whole property; the API returns at most about 50,000 rows per day (sorted by clicks), so on very large sites export the test pages to a file and pass --input.',
    'Checkpoints before the last one are direction checks only: they never suggest keep or revert.',
  ],
});

/** One URL key for assignment, logging and evaluation (tracking parameters such as srsltid removed). */
const pageKey = (u) => normalizeUrl(u, { stripTracking: true }) || String(u || '');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rel = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));
const fmtP = (p) => (p === null || p === undefined || !Number.isFinite(p) ? '-' : p < 0.001 ? '< 0.001' : `= ${p.toFixed(3)}`);

/** Per-page metrics from GSC rows: Map(url -> {clicks, impressions, position}). */
export function pageMetrics(rows) {
  const acc = new Map();
  for (const r of rows) {
    if (!r.page) continue;
    const k = pageKey(r.page);
    const a = acc.get(k) || { clicks: 0, impressions: 0, pw: 0 };
    a.clicks += r.clicks || 0;
    a.impressions += r.impressions || 0;
    a.pw += (r.position || 0) * (r.impressions || 0);
    acc.set(k, a);
  }
  return new Map([...acc].map(([k, a]) => [k, { clicks: a.clicks, impressions: a.impressions, position: a.impressions ? a.pw / a.impressions : 0 }]));
}

function groupStats(urls, metrics) {
  let clicks = 0;
  let impressions = 0;
  let pw = 0;
  for (const u of urls) {
    const m = metrics.get(u);
    if (!m) continue;
    clicks += m.clicks;
    impressions += m.impressions;
    pw += m.position * m.impressions;
  }
  const n = urls.length || 1;
  return { pages: urls.length, clicks, impressions, clicksPerPage: clicks / n, impressionsPerPage: impressions / n, ctr: impressions ? clicks / impressions : 0, position: impressions ? pw / impressions : 0 };
}

/** Balance of two groups on per-page clicks/impressions, CTR and position (relative differences). */
export function balanceOf(variant, control, metrics) {
  const v = groupStats(variant, metrics);
  const c = groupStats(control, metrics);
  return { variant: v, control: c, imbalance: { clicks: rel(v.clicksPerPage, c.clicksPerPage), impressions: rel(v.impressionsPerPage, c.impressionsPerPage), ctr: rel(v.ctr, c.ctr), position: rel(v.position, c.position) } };
}

/** Impression quartiles (q1 = lowest .. q4 = highest) among pages with data; the rest are "none". */
export function strataOf(pages, metrics) {
  const imp = (u) => (metrics.get(u) || {}).impressions || 0;
  const withData = pages.filter((u) => imp(u) > 0).sort((a, b) => imp(a) - imp(b) || cmp(a, b));
  const map = new Map();
  withData.forEach((u, i) => map.set(u, `q${Math.min(4, Math.floor((4 * i) / withData.length) + 1)}`));
  for (const u of pages) if (!map.has(u)) map.set(u, 'none');
  return map;
}

/**
 * Seeded, stratified, pair-matched assignment. Inside each stratum pages are sorted by impressions and taken in
 * pairs; a coin flip (mulberry32) sends one page of each pair to the variant. Draws are repeated with seed+1, ...
 * until every imbalance <= maxImbalance (else the best draw is returned with ok=false).
 */
export function assignGroups(pages, metrics, { seed = 1, maxImbalance = 0.1, tries = 50 } = {}) {
  const list = [...new Set(pages)].sort();
  const stratum = strataOf(list, metrics);
  const imp = (u) => (metrics.get(u) || {}).impressions || 0;
  const clk = (u) => (metrics.get(u) || {}).clicks || 0;
  const names = ['q4', 'q3', 'q2', 'q1', 'none'];
  const byStratum = names.map((name) => [name, list.filter((u) => stratum.get(u) === name).sort((a, b) => imp(b) - imp(a) || clk(b) - clk(a) || cmp(a, b))]).filter(([, urls]) => urls.length);
  let best = null;
  for (let t = 0; t < Math.max(1, tries); t++) {
    const s = seed + t;
    const rand = mulberry32(s);
    const variant = [];
    const control = [];
    const pairs = [];
    for (const [, urls] of byStratum) {
      for (let i = 0; i < urls.length; i += 2) {
        if (i + 1 < urls.length) {
          const flip = rand() < 0.5;
          const [v, c] = flip ? [urls[i], urls[i + 1]] : [urls[i + 1], urls[i]];
          variant.push(v);
          control.push(c);
          pairs.push([v, c]);
        } else {
          const toVariant = variant.length < control.length || (variant.length === control.length && rand() < 0.5);
          (toVariant ? variant : control).push(urls[i]);
          pairs.push(toVariant ? [urls[i], null] : [null, urls[i]]);
        }
      }
    }
    const balance = balanceOf(variant, control, metrics);
    const worst = Math.max(...Object.values(balance.imbalance));
    if (!best || worst < best.worst) best = { seed: s, tries: t + 1, variant: variant.sort(), control: control.sort(), pairs, balance, worst };
    if (worst <= maxImbalance) break;
  }
  const strata = byStratum.map(([name, urls]) => ({
    name,
    pages: urls.length,
    variant: urls.filter((u) => best.variant.includes(u)).length,
    control: urls.filter((u) => best.control.includes(u)).length,
    impressions: name === 'none' ? '0' : `${fmtInt(urls.reduce((m, u) => Math.min(m, imp(u)), Infinity))}-${fmtInt(urls.reduce((m, u) => Math.max(m, imp(u)), 0))}`,
  }));
  return { ...best, ok: best.worst <= maxImbalance, strata, maxImbalance };
}

/** Pairs of a split test as URL pairs: experiments.json stores index pairs into splitTest.variant/control (-1 = none). */
export function storedPairs(st) {
  const v = (st && st.variant) || [];
  const c = (st && st.control) || [];
  return ((st && st.pairs) || []).map((p) => (typeof p[0] === 'number' || typeof p[1] === 'number' ? [p[0] >= 0 ? v[p[0]] || null : null, p[1] >= 0 ? c[p[1]] || null : null] : p));
}

/**
 * Page re-randomization test: statistic = log ratio of post/pre clicks (variant) minus the same for control
 * (+1 smoothing); the pairs are re-flipped `draws` times. Returns {stat, netEffect, pValue, draws}.
 */
export function pageRandomization(pairs, pre, post, { draws = 5000, seed = 11 } = {}) {
  const stat = (flipMask) => {
    let vPre = 0;
    let vPost = 0;
    let cPre = 0;
    let cPost = 0;
    pairs.forEach(([v, c], i) => {
      const [a, b] = flipMask && flipMask[i] ? [c, v] : [v, c];
      if (a) {
        vPre += pre.get(a) || 0;
        vPost += post.get(a) || 0;
      }
      if (b) {
        cPre += pre.get(b) || 0;
        cPost += post.get(b) || 0;
      }
    });
    return Math.log((vPost + 1) / (vPre + 1)) - Math.log((cPost + 1) / (cPre + 1));
  };
  const obs = stat(null);
  const rand = mulberry32(seed);
  let extreme = 0;
  const mask = new Array(pairs.length).fill(false);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < pairs.length; i++) mask[i] = pairs[i][0] && pairs[i][1] ? rand() < 0.5 : false;
    if (Math.abs(stat(mask)) >= Math.abs(obs) - 1e-12) extreme++;
  }
  return { stat: obs, netEffect: Math.exp(obs) - 1, pValue: (extreme + 1) / (draws + 1), draws };
}

// ---------- helpers ----------
function indexPairs(res) {
  const vi = new Map(res.variant.map((u, i) => [u, i]));
  const ci = new Map(res.control.map((u, i) => [u, i]));
  return res.pairs.map(([v, c]) => [v ? vi.get(v) : -1, c ? ci.get(c) : -1]);
}

function splitTests(waves) {
  return waves.filter((w) => w.type === 'split-test');
}

function experimentsDir(ws) {
  return ensureDir(ws.path('data', 'experiments'));
}

function uniqueId(waves, base) {
  let id = base;
  for (let i = 2; waves.some((w) => w.id === id); i++) id = `${base}-${i}`;
  return id;
}

function newestCrawlPages(ws) {
  const file = ws.listData('crawl', /-pages\.csv$/)[0];
  if (!file) return { urls: [], file: '' };
  const urls = readCsvFile(file).records.filter((r) => r.indexable === 'yes').map((r) => normalizeUrl(r.final_url || r.url) || r.url);
  return { urls: [...new Set(urls)], file };
}

async function preMetrics(ws, flags) {
  if (flags.input) {
    const file = loadGscFile(path.resolve(flags.input));
    if (!file.dimensions.includes('page')) throw new UserError('--input needs a page column (export with --dimensions page or date,page)');
    if (!file.rows.length) throw new UserError(`--input ${path.basename(flags.input)} has no rows`, { hint: 'Export a pre-period window that has data for the test pages.' });
    let rows = file.rows;
    let window = { start: file.meta.startDate || '', end: file.meta.endDate || '' };
    if (file.dimensions.includes('date')) {
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      const end = dates[dates.length - 1];
      const start = addDays(end, -(flags.days - 1));
      rows = rows.filter((r) => r.date >= start && r.date <= end);
      window = { start: start < dates[0] ? dates[0] : start, end };
    }
    return { metrics: pageMetrics(rows), pages: [...new Set(rows.map((r) => pageKey(r.page)))], source: path.basename(flags.input), window };
  }
  if (!ws.config.gsc.siteUrl) return { metrics: new Map(), pages: [], source: 'none', window: null };
  const gsc = gscClient(ws, flags);
  const end = await gsc.latestFinalDate();
  const start = addDays(end, -(flags.days - 1));
  log(`Fetching page metrics ${start}..${end}...`);
  const res = await gsc.query({ startDate: start, endDate: end, dimensions: ['page'], type: 'web', dataState: 'final' });
  return { metrics: pageMetrics(res.rows), pages: res.rows.map((r) => pageKey(r.page)), source: `Search Console API (${gsc.siteUrl})`, window: { start, end } };
}

// ---------- subcommands ----------
async function cmdAssign(ws, flags) {
  if (!flags.urlsFile && !flags.pageGroup) throw new UserError('assign needs --urls-file or --page-group', { hint: 'Pick one template (product, location or entity pages) with at least 60 similar pages.' });
  const origin = ws.siteUrl({ required: false }) ? ws.origin() : '';
  const pre = await preMetrics(ws, flags);
  let universe;
  let universeSource;
  if (flags.urlsFile) {
    universe = normalizeUrls(collectList([], flags.urlsFile), origin).map(pageKey);
    universeSource = path.basename(flags.urlsFile);
  } else {
    const groups = ws.config.pageGroups || {};
    if (!Object.prototype.hasOwnProperty.call(groups, flags.pageGroup) || flags.pageGroup.startsWith('_comment')) {
      throw new UserError(`Unknown page group "${flags.pageGroup}"`, { hint: `Defined: ${Object.keys(groups).filter((k) => !k.startsWith('_comment')).join(', ') || '(none)'}. Add one with init.mjs --page-group name=regex` });
    }
    let candidates = pre.pages;
    universeSource = pre.source;
    if (!flags.input) {
      const crawl = newestCrawlPages(ws);
      candidates = crawl.urls;
      universeSource = crawl.file ? path.basename(crawl.file) : 'none';
    }
    universe = [...new Set(candidates.filter((u) => ws.pageGroupOf(u) === flags.pageGroup))];
  }
  if (!universe.length) throw new UserError('No candidate pages found', { hint: flags.pageGroup ? 'Pass --input with a GSC page export, or crawl the site first (crawl-site.mjs).' : 'Check the URLs file.' });
  if (!pre.window && !flags.force) {
    throw new UserError('No pre-period traffic data: strata and balance need Search Console metrics', { hint: ['Pass --input <gsc export with page or date,page> or configure gsc.siteUrl and credentials.', 'Or --force to split without traffic data (not recommended).'] });
  }
  const seed = flags.seed ?? Number(ws.today().replace(/-/g, ''));
  const res = assignGroups(universe, pre.metrics, { seed, maxImbalance: flags.maxImbalance, tries: flags.tries });
  const problems = [];
  if (res.variant.length < flags.minPages || res.control.length < flags.minPages) problems.push(`groups of ${res.variant.length} and ${res.control.length} pages (need >= ${flags.minPages} each)`);
  if (res.balance.variant.impressions < flags.minImpressions || res.balance.control.impressions < flags.minImpressions) problems.push(`pre-period impressions ${fmtInt(res.balance.variant.impressions)} / ${fmtInt(res.balance.control.impressions)} (need >= ${fmtInt(flags.minImpressions)} per group)`);
  if (!res.ok) problems.push(`no draw in ${flags.tries} tries is balanced within ${fmtPct(flags.maxImbalance, 0)} (best: ${Object.entries(res.balance.imbalance).map(([k, v]) => `${k} ${fmtPct(v)}`).join(', ')})`);
  if (problems.length && !flags.force) {
    throw new UserError(`Split test not created: ${problems.join('; ')}`, {
      hint: [
        'Use a bigger page group (more similar pages), a longer --days window, or test a change on a single template with more traffic.',
        'If most pages show no traffic, check that the URLs match the Search Console page URLs exactly (protocol, www, trailing slash).',
        'Pass --force to create it anyway (results will be noisy).',
      ],
    });
  }
  const waves = loadWaves(ws);
  const title = flags.title || (flags.pageGroup ? `${flags.pageGroup} split test` : 'split test');
  const id = uniqueId(waves, `ST-${ws.today()}-${slugify(title, 40) || 'test'}`);
  const dir = experimentsDir(ws);
  const variantFile = writeText(path.join(dir, `${id}-variant.txt`), `${res.variant.join('\n')}\n`);
  const controlFile = writeText(path.join(dir, `${id}-control.txt`), `${res.control.join('\n')}\n`);
  const input = { source: pre.source, universe: universeSource, start: pre.window ? pre.window.start : '', end: pre.window ? pre.window.end : '', days: pre.window && pre.window.start ? spanDays(pre.window.start, pre.window.end) : 0 };
  const assignment = { id, seed: res.seed, requestedSeed: seed, tries: res.tries, balanced: res.ok, forced: Boolean(problems.length), problems, maxImbalance: flags.maxImbalance, strata: res.strata, balance: res.balance, pairs: res.pairs, variant: res.variant, control: res.control, input, createdAt: new Date().toISOString() };
  const assignmentFile = writeJson(path.join(dir, `${id}-assignment.json`), assignment);
  waves.push({
    id,
    type: 'split-test',
    status: 'planned',
    date: ws.today(),
    timezone: ws.timezone(),
    title,
    urls: res.variant,
    control: `split-test control group (${res.control.length} URLs)`,
    splitTest: { seed: res.seed, strata: res.strata, variant: res.variant, control: res.control, balance: res.balance, input, pairs: indexPairs(res) },
    checkpoints: [],
    createdAt: new Date().toISOString(),
  });
  saveWaves(ws, waves);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ id, ...assignment, files: { variant: variantFile, control: controlFile, assignment: assignmentFile } }, null, 2)}\n`);
    return 0;
  }
  out(`Created ${id}: ${res.variant.length} variant + ${res.control.length} control pages (seed ${res.seed}${res.tries > 1 ? ` after ${res.tries} draws` : ''}).`);
  for (const p of problems) out(`WARNING (--force): ${p}`);
  out(textTable(['stratum', 'impressions', 'pages', 'variant', 'control'], res.strata.map((s) => [s.name, s.impressions, s.pages, s.variant, s.control])));
  const b = res.balance;
  out(textTable(['pre-period', 'variant', 'control', 'difference'], [
    ['clicks/page', fmtNum(b.variant.clicksPerPage), fmtNum(b.control.clicksPerPage), fmtPct(b.imbalance.clicks)],
    ['impressions/page', fmtNum(b.variant.impressionsPerPage), fmtNum(b.control.impressionsPerPage), fmtPct(b.imbalance.impressions)],
    ['CTR', fmtPct(b.variant.ctr, 2), fmtPct(b.control.ctr, 2), fmtPct(b.imbalance.ctr)],
    ['position', fmtPos(b.variant.position), fmtPos(b.control.position), fmtPct(b.imbalance.position)],
  ]));
  out(`\nNext: change ONLY the ${res.variant.length} variant URLs, all in one deploy; leave the control pages alone. Then record D0:`);
  out(`  ${scriptCmd('split-test.mjs')} start --id ${id} --at "YYYY-MM-DD HH:MM"`);
  out(`\nwrote ${variantFile}\nwrote ${controlFile}\nwrote ${assignmentFile}\nwrote ${ws.path('logs', 'experiments.json')}`);
  return 0;
}

function cmdStart(ws, flags) {
  if (!flags.id) throw new UserError('start needs --id', { hint: `List split tests: ${scriptCmd('split-test.mjs')} list` });
  const waves = loadWaves(ws);
  const wave = findWave(waves, flags.id);
  if (wave.type !== 'split-test') throw new UserError(`${wave.id} is not a split test (type ${wave.type})`, { hint: 'Use log-change.mjs for other waves.' });
  if (wave.status !== 'planned' && !flags.force) throw new UserError(`${wave.id} was already started (D0 ${wave.deployedAt ? wave.deployedAt.local : wave.date})`, { hint: `Evaluate it: ${scriptCmd('split-test.mjs')} evaluate --id ${wave.id}` });
  const tz = ws.timezone();
  let instant;
  if (flags.at) instant = parseLocalDateTime(flags.at, tz);
  else if (flags.date) instant = parseLocalDateTime(flags.date, tz) + 12 * 3600000;
  else instant = Date.now();
  const date = flags.date && !flags.at ? flags.date : ymdInTz(new Date(instant), tz);
  if (!isYmd(date)) throw new UserError(`Invalid date "${date}"`);
  const offsets = flags.checkpoints.map(Number);
  if (!offsets.length || offsets.some((n) => !Number.isInteger(n) || n < 1)) throw new UserError('--checkpoints must be positive whole days, e.g. 14,28');
  const control = (wave.splitTest && wave.splitTest.control) || [];
  const overlaps = findOverlaps(waves, { ...wave, date, timezone: tz, urls: [...(wave.urls || []), ...control] });
  for (const o of overlaps) out(`WARNING: overlaps ${o.wave.id} (${o.wave.date}) on ${o.shared[0] === '(site-wide)' ? 'every URL (site-wide change)' : `${o.shared.length} URL(s)`}; its pending checkpoints ${o.pending.join(', ')} would be contaminated.`);
  if (overlaps.length && !flags.force) {
    throw new UserError('Not started: test pages overlap an unreviewed wave', { exitCode: 2, hint: ['Wait for that wave to be reviewed, or rebuild the test without those pages.', 'If the change is already live, re-run with --force (both waves can then only report an overall effect).'] });
  }
  wave.date = date;
  wave.timezone = tz;
  wave.deployedAt = { utc: new Date(instant).toISOString(), local: formatInTz(instant, tz), pt: formatInTz(instant, GSC_TZ), exact: Boolean(flags.at) || !flags.date };
  wave.status = 'live';
  wave.checkpoints = buildCheckpoints(date, { siteTz: tz, offsets });
  wave.overlaps = overlaps.map((o) => ({ wave: o.wave.id, shared: o.shared.length, pending: o.pending }));
  wave.notes = [wave.notes, `Control URLs: data/experiments/${wave.id}-control.txt (must not change). Variant URLs: data/experiments/${wave.id}-variant.txt.`].filter(Boolean).join(' ');
  wave.startedAt = new Date().toISOString();
  saveWaves(ws, waves);
  const file = appendChangesLog(ws, changesEntry(wave));
  out(`Started ${wave.id}: D0 ${wave.deployedAt.exact ? `${wave.deployedAt.local} ${tz} = ${wave.deployedAt.pt} PT` : `${date} ${tz} (time not recorded)`}`);
  for (const c of wave.checkpoints) out(`  ${c.label}: ${c.date}; windows pre ${c.pre.start}..${c.pre.end} / post ${c.post.start}..${c.post.end}; evaluate on or after ${c.reviewOn}`);
  out(`Change ONLY the ${(wave.urls || []).length} variant URLs; the ${control.length} control pages must stay as they are until ${wave.checkpoints[wave.checkpoints.length - 1].label} is reviewed.`);
  out(`Evaluate: ${scriptCmd('split-test.mjs')} evaluate --id ${wave.id} --checkpoint ${wave.checkpoints[wave.checkpoints.length - 1].label}`);
  out(`wrote ${file}\nwrote ${ws.path('logs', 'experiments.json')}`);
  return 0;
}

function cmdList(ws, flags) {
  const tests = splitTests(loadWaves(ws));
  if (flags.json) return void process.stdout.write(`${JSON.stringify(tests, null, 2)}\n`);
  if (!tests.length) return void out(`No split tests yet. Create one: ${scriptCmd('split-test.mjs')} assign --page-group <name> --input <gsc export> --title "..."`);
  out(textTable(['id', 'status', 'D0', 'variant', 'control', 'checkpoints'], tests.map((w) => [
    w.id,
    w.status,
    w.deployedAt ? w.deployedAt.local : '-',
    (w.urls || []).length,
    ((w.splitTest && w.splitTest.control) || []).length,
    (w.checkpoints || []).map((c) => `${c.label}:${c.review ? c.review.verdict : c.reviewOn}`).join(' ') || '-',
  ])));
  return 0;
}

function pickCheckpoint(wave, label, today) {
  const cps = wave.checkpoints || [];
  if (label) {
    const want = `D+${String(label).replace(/^D\+/i, '')}`;
    const cp = cps.find((c) => c.label === want);
    if (!cp) throw new UserError(`${wave.id} has no checkpoint ${want}`, { hint: `Available: ${cps.map((c) => c.label).join(', ')}` });
    return { cp, early: today < cp.reviewOn };
  }
  const due = cps.filter((c) => c.reviewOn <= today);
  return due.length ? { cp: due[due.length - 1], early: false } : { cp: cps[0], early: true };
}

async function evaluationRows(ws, flags, range) {
  if (flags.input) {
    const file = loadGscFile(path.resolve(flags.input));
    if (!file.dimensions.includes('date') || !file.dimensions.includes('page')) throw new UserError('--input must have date and page columns (export with --dimensions date,page)');
    return { rows: file.rows, dims: file.dimensions, source: path.basename(flags.input), meta: file.meta || {} };
  }
  const gsc = gscClient(ws, flags);
  const latest = await gsc.latestFinalDate();
  if (range.end > latest) throw new UserError(`The post window ends ${range.end} but final Search Console data only reaches ${latest} (PT)`, { hint: [`Re-run on or after the checkpoint's review date, or pass --input with an export that covers ${range.start}..${range.end}.`] });
  log(`Fetching date x page rows ${range.start}..${range.end}...`);
  const res = await gsc.query({ startDate: range.start, endDate: range.end, dimensions: ['date', 'page'], type: 'web', dataState: 'final' });
  return { rows: res.rows, dims: ['date', 'page'], source: `Search Console API (${gsc.siteUrl})`, meta: {} };
}

/** Evaluation for one checkpoint (pure apart from inputs); exported for tests. */
export function evaluateSplit({ wave, rows, dims, offset, events = [], placebo = true, draws = 5000, otherWaves = [] }) {
  const tz = wave.timezone || 'UTC';
  const w = deployWindows(wave.date, offset, { siteTz: tz });
  let variant = new Set(normalizeUrls(wave.urls || []).map(pageKey));
  let control = new Set(normalizeUrls((wave.splitTest && wave.splitTest.control) || []).map(pageKey));
  const warnings = [];
  const gap = diffDays(w.pre.end, w.post.start) - 1;
  const shift = w.post.days + Math.max(gap, w.excluded.length);
  const pPre = { start: addDays(w.pre.start, -shift), end: addDays(w.pre.end, -shift), days: w.pre.days };
  const pPost = { start: addDays(w.post.start, -shift), end: addDays(w.post.end, -shift), days: w.post.days };
  const spanStart = placebo ? pPre.start : w.pre.start;
  // other changes on test pages inside the windows contaminate both groups: drop those pages
  const dropped = new Set();
  for (const o of otherWaves) {
    // only changes that were deployed: planned or never-started split tests changed nothing
    if (o.id === wave.id || !o.date || o.status === 'planned' || (!o.deployedAt && !(o.checkpoints || []).length) || ['freeze', 'external-event'].includes(o.type)) continue;
    const days = gscDaysForLocalDate(o.date, o.timezone || tz);
    if (days[days.length - 1] < spanStart || days[0] > w.post.end) continue;
    if (o.siteWide) {
      warnings.push(`Wave ${o.id} (${o.date}) changed every page inside the windows: both groups are affected; read the result as relative only.`);
      continue;
    }
    for (const u of normalizeUrls(o.urls || []).map(pageKey)) if (variant.has(u) || control.has(u)) dropped.add(u);
  }
  if (dropped.size) {
    variant = new Set([...variant].filter((u) => !dropped.has(u)));
    control = new Set([...control].filter((u) => !dropped.has(u)));
    warnings.push(`${dropped.size} test page(s) were changed by another wave inside the windows and were left out of both groups.`);
  }
  // canonical page keys before windows, so ?srsltid= / utm_ variants count as their page in both groups
  const testRows = [];
  for (const r of rows) {
    const k = pageKey(r.page);
    if (variant.has(k) || control.has(k)) testRows.push(k === r.page ? r : { ...r, page: k });
  }
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  if (!dates.length || dates[0] > spanStart || dates[dates.length - 1] < w.post.end) warnings.push(`Input covers ${dates[0] || '?'} -> ${dates[dates.length - 1] || '?'} but the windows need ${spanStart} -> ${w.post.end}; missing days count as zero.`);
  const groupOf = (u) => (variant.has(pageKey(u)) ? 'variant' : 'control');
  const opts = { treatedUrls: variant, control: (r) => control.has(pageKey(r.page)), controlMinImpr: 0, excludedFromControl: new Set(), curve: DEFAULT_CTR_CURVE, pageGroupOf: groupOf, top: 10 };
  const pre = deriveWindow(testRows, dims, w.pre, {});
  const post = deriveWindow(testRows, dims, w.post, {});
  const result = computeComparison(pre, post, opts);
  const clicksBy = (win) => new Map(win.pages.map((p) => [pageKey(p.page), p.clicks]));
  const pairs = storedPairs(wave.splitTest).map(([v, c]) => [v && variant.has(pageKey(v)) ? pageKey(v) : null, c && control.has(pageKey(c)) ? pageKey(c) : null]).filter(([v, c]) => v || c);
  let pairList = pairs;
  if (!pairs.length) {
    const ctl = [...control];
    pairList = [...variant].map((v, i) => [v, ctl[i] || null]);
    warnings.push('The stored pairs were not found (old record or missing assignment file): the re-randomization test pairs pages arbitrarily and loses power.');
  }
  const randomization = pageRandomization(pairList, clicksBy(pre), clicksBy(post), { draws, seed: (wave.splitTest && wave.splitTest.seed) || 11 });
  let placeboRes = null;
  if (placebo) {
    const pr = computeComparison(deriveWindow(testRows, dims, pPre, {}), deriveWindow(testRows, dims, pPost, {}), opts);
    const v = placeboVerdict(result, pr);
    // A placebo that is "significant" but tiny next to the real effect is a minor trend, not an explanation of it.
    if (v.flag && Number.isFinite(v.real) && Number.isFinite(v.placebo) && Math.abs(v.placebo) < 0.25 * Math.abs(v.real)) {
      v.flag = false;
      v.minorTrend = true;
      v.note = `Placebo shows a small pre-existing gap (${fmtSignedPct(v.placebo)} vs ${fmtSignedPct(v.real)}): too small to explain the effect; read the effect as roughly ${fmtSignedPct((1 + v.real) / (1 + v.placebo) - 1)} net of it.`;
    }
    placeboRes = { shift, windows: { pre: pPre, post: pPost }, verdict: v };
    if (placeboRes.verdict.flag) warnings.push(placeboRes.verdict.note);
  }
  const windows = [{ name: 'pre', start: w.pre.start, end: w.pre.end }, { name: 'post', start: w.post.start, end: w.post.end }];
  const hits = overlapEvents(events, windows);
  const reliability = metricReliability(events, windows);
  for (const h of hits) warnings.push(describeOverlap(h));
  const unreliable = new Set(reliability.unreliable);
  if (unreliable.has('impressions')) for (const m of ['ctr', 'position']) unreliable.add(m);
  const t = result.treated;
  const did = t && t.did ? t.did.clicks : null;
  const rankingUpdate = hits.some((h) => ['core', 'spam', 'ranking-other'].includes(h.event.kind));
  let verdict;
  const p = randomization.pValue;
  const offsets = (wave.checkpoints || []).map((c) => c.offset).filter(Number.isFinite);
  const lastOffset = offsets.length ? Math.max(...offsets) : 28;
  const isFinal = offset >= lastOffset;
  if (!t || t.sampleTooSmall) verdict = { call: 'inconclusive', text: 'Sample too small (fewer than 10 clicks in the variant across both windows): keep observing or test on more pages.' };
  else if (unreliable.has('clicks')) verdict = { call: 'inconclusive', text: 'A Search Console data anomaly affects clicks in these windows: no conclusion from this checkpoint.' };
  else if (p < 0.05 && (placeboRes && placeboRes.verdict.flag)) verdict = { call: 'inconclusive', text: 'The groups differ, but the placebo shows a similar pre-existing gap: not attributable to the change.' };
  else if (p < 0.05 && rankingUpdate) verdict = { call: 'inconclusive', text: 'The groups differ, but a Google ranking update overlaps the windows: confirm at a later checkpoint outside the update.' };
  else if (p < 0.05 && !isFinal) verdict = { call: 'inconclusive', text: `Interim D+${offset}: variant ${randomization.netEffect > 0 ? 'ahead of' : 'behind'} control on clicks by ${fmtSignedPct(randomization.netEffect)} (page re-randomization p ${fmtP(p)}). Direction only: decide at D+${lastOffset}.` };
  else if (p < 0.05) verdict = { call: randomization.netEffect > 0 ? 'keep' : 'revert', text: `Variant ${randomization.netEffect > 0 ? 'beats' : 'trails'} control on clicks by ${fmtSignedPct(randomization.netEffect)} (page re-randomization p ${fmtP(p)}${did ? `; time-permutation DiD p ${fmtP(did.pValue)}` : ''}).` };
  else verdict = { call: isFinal ? 'iterate' : 'inconclusive', text: `No detectable difference (p ${fmtP(p)}): ${isFinal ? 'the change made no measurable difference; do not roll it out on this evidence' : `direction only at this checkpoint; decide at D+${lastOffset}`}.` };
  return { windows: { pre: w.pre, post: w.post, excluded: w.excluded }, groups: { variant: variant.size, control: control.size, dropped: [...dropped] }, result, randomization, placebo: placeboRes, events: hits.map((h) => ({ id: h.event.id, kind: h.event.kind, title: h.event.title, text: describeOverlap(h) })), advice: overlapAdvice(hits), unreliable: [...unreliable], warnings, verdict };
}

function renderEvaluation(ev, meta) {
  const L = [];
  const t = ev.result.treated;
  L.push(`# Split test ${meta.id} - ${meta.checkpoint} (${meta.today})`, '');
  L.push(`- ${meta.title}; D0 ${meta.d0} (${meta.tz}); data: ${meta.source}`);
  L.push(`- Windows (PT): pre ${ev.windows.pre.start} -> ${ev.windows.pre.end}, post ${ev.windows.post.start} -> ${ev.windows.post.end}; excluded deploy day(s) ${ev.windows.excluded.join(', ')}`);
  L.push(`- Groups: ${ev.groups.variant} variant, ${ev.groups.control} control pages${ev.groups.dropped.length ? ` (${ev.groups.dropped.length} dropped: changed by another wave)` : ''}`);
  if (meta.early) L.push(`- EARLY: this checkpoint's data is final on ${meta.reviewOn}; numbers may still change.`);
  L.push('');
  if (ev.warnings.length || ev.advice.length) {
    L.push('## Warnings', '');
    for (const w of ev.warnings) L.push(`- WARNING: ${w}`);
    for (const a of ev.advice) L.push(`- ${a}`);
    if (ev.unreliable.length) L.push(`- Not comparable across these windows: ${ev.unreliable.join(', ')} (judge on the remaining metrics).`);
    L.push('');
  }
  L.push('## Verdict (suggestion)', '', `**${ev.verdict.call}** - ${ev.verdict.text}`, '');
  if (t) {
    const nc = (m) => (ev.unreliable.includes(m) ? ' (not comparable)' : '');
    const row = (label, g) => ({ label, clicks: `${fmtNum(g.perDay.pre.clicks)} -> ${fmtNum(g.perDay.post.clicks)} (${fmtSignedPct(g.delta.clicksPct)})`, impressions: `${fmtNum(g.perDay.pre.impressions)} -> ${fmtNum(g.perDay.post.impressions)} (${fmtSignedPct(g.delta.impressionsPct)})${nc('impressions')}`, ctr: `${fmtPct(g.pre.ctr, 2)} -> ${fmtPct(g.post.ctr, 2)}${nc('ctr')}`, position: `${fmtPos(g.pre.position)} -> ${fmtPos(g.post.position)}${nc('position')}` });
    L.push('## Variant vs control', '');
    L.push(mdTable([{ label: 'Group', key: 'label' }, { label: 'Clicks/day pre -> post', align: 'right', key: 'clicks' }, { label: 'Impressions/day pre -> post', align: 'right', key: 'impressions' }, { label: 'CTR', align: 'right', key: 'ctr' }, { label: 'Position (+ = worse)', align: 'right', key: 'position' }], [row('variant', t.treated), row('control', t.control)]));
    const r = ev.randomization;
    L.push(`- Net effect on clicks (variant vs control, ratio of post/pre ratios): ${fmtSignedPct(r.netEffect)}; page re-randomization p ${fmtP(r.pValue)} (${fmtInt(r.draws)} re-draws of the matched pairs).`);
    if (t.did) for (const m of ['clicks', 'impressions']) L.push(`- Difference-in-differences of daily ${m}: variant ${fmtSignedPct(t.did[m].treatmentChange)} vs control ${fmtSignedPct(t.did[m].controlChange)}; net ${fmtSignedPct(t.did[m].netEffect)}, p ${fmtP(t.did[m].pValue)} (${t.did[m].method})${m === 'impressions' && ev.unreliable.includes('impressions') ? ' - not comparable' : ''}.`);
    if (t.sampleTooSmall) L.push('- **Sample too small**: fewer than 10 variant clicks across both windows.');
    L.push('');
  }
  if (ev.placebo) {
    const v = ev.placebo.verdict;
    L.push(`## Placebo (both windows moved ${ev.placebo.shift} days earlier, before D0)`, '');
    L.push(`${v.metric}: real ${fmtSignedPct(v.real)} vs placebo ${fmtSignedPct(v.placebo)}${v.placeboP !== null && v.placeboP !== undefined ? ` (placebo p ${fmtP(v.placeboP)})` : ''}. **${v.flag ? 'FLAG' : 'OK'}**: ${v.note}`, '');
  }
  L.push('## How to read this', '');
  L.push('- Pages were randomized, so the page re-randomization p-value is the primary test; the daily DiD (gsc-compare method) is a second view of the same effect.');
  L.push('- D+14 = direction, D+28 = decision. A flagged placebo or an overlapping Google update means: do not credit the change yet.');
  L.push('- Placebo: both windows moved before D0. A same-direction placebo of at least half the effect (or a significant one) is a FLAG; a significant placebo under a quarter of the effect is reported as a minor trend.');
  L.push(`- Record the decision: \`${scriptCmd('log-change.mjs')} checkpoint --wave ${meta.id} --checkpoint ${meta.checkpoint} --verdict <keep|iterate|revert|inconclusive> --report <this file>\`.`);
  L.push('- keep: roll the change out to the control pages as a new wave; revert: undo it on the variant pages (log-change add --type rollback).', '');
  return L.join('\n');
}

async function cmdEvaluate(ws, flags) {
  if (!flags.id) throw new UserError('evaluate needs --id', { hint: `List split tests: ${scriptCmd('split-test.mjs')} list` });
  const waves = loadWaves(ws);
  const wave = findWave(waves, flags.id);
  if (wave.type !== 'split-test') throw new UserError(`${wave.id} is not a split test`);
  if (!(wave.checkpoints || []).length) throw new UserError(`${wave.id} has not started yet (no D0)`, { hint: `After deploying the change to the variant pages: ${scriptCmd('split-test.mjs')} start --id ${wave.id} --at "YYYY-MM-DD HH:MM"` });
  const today = ws.today();
  const { cp, early } = pickCheckpoint(wave, flags.checkpoint, today);
  // pairs: experiments.json (index pairs), else the assignment file (URL pairs)
  const assignmentFile = ws.path('data', 'experiments', `${wave.id}-assignment.json`);
  if (!(wave.splitTest && (wave.splitTest.pairs || []).length) && fs.existsSync(assignmentFile)) {
    try {
      wave.splitTest = { ...(wave.splitTest || {}), pairs: JSON.parse(fs.readFileSync(assignmentFile, 'utf8')).pairs || [] };
    } catch {
      /* evaluate without pairs */
    }
  }
  const w = deployWindows(wave.date, cp.offset, { siteTz: wave.timezone || ws.timezone() });
  const gap = diffDays(w.pre.end, w.post.start) - 1;
  const shift = w.post.days + Math.max(gap, w.excluded.length);
  const start = flags.noPlacebo ? w.pre.start : addDays(w.pre.start, -shift);
  const data = await evaluationRows(ws, flags, { start, end: w.post.end });
  const events = loadEvents(ws, { today });
  const ev = evaluateSplit({ wave, rows: data.rows, dims: data.dims, offset: cp.offset, events, placebo: !flags.noPlacebo, draws: flags.draws, otherWaves: waves });
  if (early) ev.warnings.unshift(`${cp.label} data is final on ${cp.reviewOn} (today ${today}): this is a preview.`);
  const meta = { id: wave.id, title: wave.title, checkpoint: cp.label, today, d0: wave.deployedAt ? wave.deployedAt.local : wave.date, tz: wave.timezone, source: data.source, early, reviewOn: cp.reviewOn };
  const t = ev.result.treated;
  const evaluation = {
    meta,
    windows: ev.windows,
    groups: ev.groups,
    verdict: ev.verdict,
    randomization: ev.randomization,
    did: t ? t.did : null,
    binomial: t ? t.binomial : null,
    variant: t ? t.treated : null,
    control: t ? t.control : null,
    placebo: ev.placebo,
    events: ev.events,
    unreliable: ev.unreliable,
    warnings: ev.warnings,
    generatedAt: new Date().toISOString(),
  };
  const jsonFile = writeJson(path.join(experimentsDir(ws), `${wave.id}-${cp.label}-evaluation.json`), evaluation);
  const md = writeText(ws.path('logs', 'reviews', `${today}-split-test-${wave.id}.md`), renderEvaluation(ev, meta));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ meta, verdict: ev.verdict, randomization: ev.randomization, did: evaluation.did, placebo: ev.placebo, events: ev.events, unreliable: ev.unreliable, warnings: ev.warnings, files: { json: jsonFile, report: md } }, null, 2)}\n`);
    return 0;
  }
  out(`${wave.id} ${cp.label}: pre ${ev.windows.pre.start}..${ev.windows.pre.end} vs post ${ev.windows.post.start}..${ev.windows.post.end} (${ev.groups.variant} variant / ${ev.groups.control} control pages)`);
  for (const wl of ev.warnings) out(`WARNING: ${wl}`);
  if (t) {
    out(`Clicks/day: variant ${fmtNum(t.treated.perDay.pre.clicks)} -> ${fmtNum(t.treated.perDay.post.clicks)}, control ${fmtNum(t.control.perDay.pre.clicks)} -> ${fmtNum(t.control.perDay.post.clicks)}`);
    out(`Net effect ${fmtSignedPct(ev.randomization.netEffect)} (page re-randomization p ${fmtP(ev.randomization.pValue)}${t.did ? `; daily DiD ${fmtSignedPct(t.did.clicks.netEffect)}, p ${fmtP(t.did.clicks.pValue)}` : ''})`);
  }
  if (ev.placebo) out(`Placebo (-${ev.placebo.shift}d): ${ev.placebo.verdict.flag ? 'FLAG' : 'ok'}`);
  out(`Verdict (suggestion): ${ev.verdict.call} - ${ev.verdict.text}`);
  out(`\nwrote ${md}\nwrote ${jsonFile}`);
  out(`Record the decision: ${scriptCmd('log-change.mjs')} checkpoint --wave ${wave.id} --checkpoint ${cp.label} --verdict <keep|iterate|revert|inconclusive> --report ${md}   (suggested: ${ev.verdict.call})`);
  return 0;
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const cmd = positionals[0];
  if (!SUBCOMMANDS.includes(cmd)) throw new UserError(cmd ? `Unknown subcommand "${cmd}"` : 'Missing subcommand', { hint: `Use one of: ${SUBCOMMANDS.join(', ')} (see --help)` });
  const ws = loadWorkspace(flags);
  if (cmd === 'assign') return cmdAssign(ws, flags);
  if (cmd === 'start') return cmdStart(ws, flags);
  if (cmd === 'evaluate') return cmdEvaluate(ws, flags);
  return cmdList(ws, flags);
}


runMain(import.meta.url, main);
