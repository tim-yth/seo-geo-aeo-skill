#!/usr/bin/env node
// SERP overlap: keywords whose top results share the same URLs serve the same intent. Compares serp-snapshot files
// pairwise, clusters keywords (soft or hard) and flags disagreements with query-clusters and keyword-map.csv.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, UserError, writeJson, writeText, normalizeUrl, scriptCmd } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { readCsvFile, writeCsvFile, findColumn } from './lib/csv.mjs';
import { compactKey } from './lib/text.mjs';
import { diffDays, isYmd } from './lib/dates.mjs';
import { mdTable, shortUrl, fmtInt, textTable } from './lib/format.mjs';

/** Published heuristic (shared top-10 URLs between two keywords); calibrate on your own data before relying on it. */
export const BANDS = [
  { name: 'same page', min: 7, advice: 'one page should serve both' },
  { name: 'same cluster', min: 4, advice: 'one page, or separate pages that interlink under one hub' },
  { name: 'interlink', min: 2, advice: 'related: interlink the pages' },
  { name: 'separate', min: 0, advice: 'separate intents' },
];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const SPEC = {
  ...COMMON_FLAGS,
  date: { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'Only snapshots saved on this date (default: the newest snapshot per keyword)' },
  files: { type: 'list', placeholder: 'file', desc: 'Snapshot JSON files to compare (instead of data/serp/)' },
  top: { type: 'int', desc: 'Compare the first N results of each SERP', default: 10 },
  'min-shared': { type: 'int', desc: 'Shared URLs that put two keywords in one intent cluster (k)', default: 3 },
  mode: { type: 'string', desc: 'soft = every member shares >= k with the cluster leader; hard = every pair shares >= k', default: 'soft', choices: ['soft', 'hard'] },
  'no-scale': { type: 'boolean', desc: 'Do not scale k down when a SERP has fewer than --top organic results' },
  'query-clusters': { type: 'string', placeholder: 'file', desc: 'query-clusters members CSV (default: newest data/gsc/*-query-cluster-members.csv)' },
  'keyword-map': { type: 'string', placeholder: 'file', desc: 'keyword-map.csv (default: the workspace copy)' },
  'max-age-days': { type: 'int', desc: 'Warn when the compared snapshots were taken more than N days apart', default: 7 },
  json: { type: 'boolean', desc: 'Print the clusters as JSON' },
};

const HELP = formatHelp({
  usage: ['node scripts/serp-overlap.mjs [--top 10] [--min-shared 3] [--mode soft|hard]', 'node scripts/serp-overlap.mjs --date 2026-11-02 --mode hard', 'node scripts/serp-overlap.mjs --files a.json --files b.json --files c.json'],
  summary:
    'Reads serp-snapshot.mjs files (newest per keyword in data/serp/), compares every pair of keywords by the normalized full URLs they share in ' +
    'the top N (tracking parameters, #fragments, trailing slashes and www. removed; domains alone never count) and their Jaccard index, and ' +
    'clusters keywords whose SERPs share >= k URLs: soft = each member shares >= k with the cluster leader (the keyword with the most impressions ' +
    'in query-clusters or keyword-map.csv), hard = every pair shares >= k. Each pair gets a band from a published heuristic (7-10 shared = same ' +
    'page, 4-6 = same cluster, 2-3 = interlink, 0-1 = separate; scaled when a SERP has fewer results). Flags: SERP says same intent but the ' +
    'text clusters differ (text-cluster-differs); same text cluster but different SERPs (serp-split); one SERP cluster mapped to different ' +
    'target URLs (target-conflict: consolidation candidate, references/08); one target URL for keywords from different SERP clusters ' +
    '(target-mixed-intents: split candidate). Writes data/serp/<today>-serp-clusters.csv, -serp-overlap.json (pairwise matrix) and ' +
    'logs/reviews/<today>-serp-overlap.md.',
  spec: SPEC,
  examples: ['node scripts/serp-snapshot.mjs --from-keyword-map --max-keywords 30 && node scripts/serp-overlap.mjs', 'node scripts/serp-overlap.mjs --min-shared 4 --mode hard'],
  notes: [
    'Brave is an independent index: its top 10 approximates, but does not equal, Google\'s. Check important clusters on Google by hand.',
    'The thresholds are a heuristic: calibrate k on pairs you already know (same page vs different pages) before acting on the bands.',
    'Low-volume SERPs churn week to week: clusters of keywords with few impressions are marked low confidence.',
    'A "top 10" often holds only 5-9 organic URLs; k and the bands are scaled to the shorter list unless --no-scale.',
  ],
});

/** URL identity for SERP comparison: host without www. + path without trailing slash + query without tracking. */
export function serpUrlKey(u) {
  const n = normalizeUrl(String(u || '').trim(), { stripTracking: true });
  if (!n) return String(u || '').trim();
  const x = new URL(n);
  let p = x.pathname.replace(/\/+$/, '');
  try {
    p = decodeURI(p);
  } catch {
    /* keep encoded */
  }
  return `${x.hostname.replace(/^www\./, '')}${x.port ? `:${x.port}` : ''}${p}${x.search}`;
}

/** Shared-URL threshold for a pair, scaled down when a SERP lists fewer than `top` results (never below 2). */
export function effectiveK(k, nA, nB, top, scale = true) {
  const n = Math.min(nA, nB);
  if (!scale || n >= top) return k;
  return Math.min(k, Math.max(2, Math.ceil((k * n) / top)));
}

/** Heuristic band for a pair; thresholds are for 10 results and scale with the shorter list (or with --top when not scaling). */
export function bandFor(shared, nA, nB, { scale = true, top = 10 } = {}) {
  const n = Math.min(nA, nB);
  if (!n) return { name: 'no data', advice: '' };
  const f = (scale ? Math.min(n, top) : top) / 10;
  for (const b of BANDS) if (b.min === 0 || shared >= Math.max(1, Math.ceil(b.min * f))) return b;
  return BANDS[BANDS.length - 1];
}

/** Pairwise shared counts and Jaccard. snapshots: [{keyword, urls:[keys]}]. */
export function overlapMatrix(snapshots, { k = 3, top = 10, scale = true } = {}) {
  const n = snapshots.length;
  const shared = Array.from({ length: n }, () => new Array(n).fill(0));
  const jac = Array.from({ length: n }, () => new Array(n).fill(0));
  const kEff = Array.from({ length: n }, () => new Array(n).fill(k));
  const sets = snapshots.map((s) => new Set(s.urls));
  for (let i = 0; i < n; i++) {
    shared[i][i] = sets[i].size;
    jac[i][i] = sets[i].size ? 1 : 0;
    for (let j = i + 1; j < n; j++) {
      let inter = 0;
      for (const u of sets[i]) if (sets[j].has(u)) inter++;
      const union = sets[i].size + sets[j].size - inter;
      shared[i][j] = shared[j][i] = inter;
      jac[i][j] = jac[j][i] = union ? inter / union : 0;
      kEff[i][j] = kEff[j][i] = effectiveK(k, sets[i].size, sets[j].size, top, scale);
    }
  }
  return { shared, jaccard: jac, kEff };
}

/**
 * Leader clustering over the edge graph (edge = shared >= kEff). `order` = indexes by priority (impressions desc).
 * soft: an unassigned keyword joins the first leader it shares >= k with; hard: it must share >= k with every member.
 */
export function clusterKeywords(matrix, order, mode = 'soft') {
  const edge = (a, b) => matrix.shared[a][b] >= matrix.kEff[a][b];
  const assigned = new Map();
  const clusters = [];
  for (const leader of order) {
    if (assigned.has(leader)) continue;
    const members = [leader];
    assigned.set(leader, clusters.length);
    for (const c of order) {
      if (assigned.has(c) || !edge(leader, c)) continue;
      if (mode === 'hard' && !members.every((m) => edge(m, c))) continue;
      members.push(c);
      assigned.set(c, clusters.length);
    }
    clusters.push({ id: clusters.length + 1, leader, members });
  }
  return clusters;
}

// ---------- inputs ----------
function snapshotDate(file, data) {
  const fromMeta = String((data.meta && data.meta.fetchedAt) || '').slice(0, 10);
  if (isYmd(fromMeta)) return fromMeta;
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(path.basename(file));
  return m ? m[1] : '';
}

export function loadSnapshots(ws, flags) {
  const files = flags.files.length
    ? flags.files.map((f) => path.resolve(f))
    : ws.listData('serp', /\.json$/).filter((f) => !/-(serp-summary|serp-overlap)\.json$/.test(f) && (!flags.date || path.basename(f).startsWith(`${flags.date}-`)));
  const byKey = new Map();
  const skipped = [];
  for (const f of files) {
    if (!fs.existsSync(f)) throw new UserError(`Snapshot not found: ${f}`);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      skipped.push(path.basename(f));
      continue;
    }
    if (!data || !data.meta || !data.meta.keyword || !Array.isArray(data.results)) continue;
    const key = compactKey(data.meta.keyword);
    const date = snapshotDate(f, data);
    const prev = byKey.get(key);
    if (prev && (prev.date > date || (prev.date === date && prev.fetchedAt >= String(data.meta.fetchedAt || '')))) continue;
    const results = data.results.filter((r) => r && r.url).sort((a, b) => (a.rank || 0) - (b.rank || 0));
    byKey.set(key, { keyword: data.meta.keyword, key, file: f, date, fetchedAt: String(data.meta.fetchedAt || ''), provider: data.meta.provider || '', country: data.meta.country || '', lang: data.meta.lang || '', results, ourRank: data.ours ? data.ours.rank : null });
  }
  return { snapshots: [...byKey.values()].sort((a, b) => cmp(a.keyword, b.keyword)), skipped };
}

function readMembers(file) {
  const map = new Map();
  if (!file || !fs.existsSync(file)) return map;
  const { headers, records } = readCsvFile(file);
  const q = findColumn(headers, ['query', 'keyword']);
  for (const r of records) {
    if (!r[q]) continue;
    map.set(compactKey(r[q]), { clusterId: String(r.cluster_id || ''), cluster: String(r.cluster || ''), impressions: Number(r.impressions) || 0 });
  }
  return map;
}

function readKeywordMapFile(file, origin) {
  const map = new Map();
  if (!file || !fs.existsSync(file)) return map;
  for (const r of readCsvFile(file).records) {
    if (!r.keyword) continue;
    let target = String(r.target_url || '').trim();
    if (target) {
      try {
        target = normalizeUrl(new URL(target, origin || undefined).href) || target;
      } catch {
        /* keep as written */
      }
    }
    map.set(compactKey(r.keyword), { target, cluster: String(r.cluster || '').trim(), impressions: Number(r.impressions) || 0 });
  }
  return map;
}

/** Full analysis; exported for tests. */
export function analyzeOverlap(snapshots, { top = 10, k = 3, mode = 'soft', scale = true, members = new Map(), keywordMap = new Map() } = {}) {
  const band = (shared, nA, nB) => bandFor(shared, nA, nB, { scale, top });
  const items = snapshots.map((s) => {
    const urls = [];
    for (const r of s.results) {
      if (urls.length >= top) break;
      const key = serpUrlKey(r.url);
      if (!urls.includes(key)) urls.push(key);
    }
    const mem = members.get(s.key || compactKey(s.keyword));
    const km = keywordMap.get(s.key || compactKey(s.keyword));
    const impressions = mem && mem.impressions ? mem.impressions : km && km.impressions ? km.impressions : null;
    const textCluster = mem && mem.clusterId ? `${mem.clusterId}${mem.cluster ? ` (${mem.cluster})` : ''}` : km && km.cluster ? `map: ${km.cluster}` : '';
    return { ...s, urls, impressions, textCluster, target: km ? km.target : '' };
  });
  const matrix = overlapMatrix(items, { k, top, scale });
  const degree = items.map((_, i) => items.reduce((n, __, j) => n + (i !== j && matrix.shared[i][j] >= matrix.kEff[i][j] ? 1 : 0), 0));
  const order = items.map((_, i) => i).sort((a, b) => (items[b].impressions || 0) - (items[a].impressions || 0) || degree[b] - degree[a] || cmp(items[a].keyword, items[b].keyword));
  const clusters = clusterKeywords(matrix, order, mode);
  const clusterOf = new Map();
  for (const c of clusters) for (const m of c.members) clusterOf.set(m, c);
  const flags = items.map(() => []);
  const addFlag = (i, id, text) => {
    if (!flags[i].some((f) => f.id === id)) flags[i].push({ id, text });
  };
  const describe = (i, j) => `${matrix.shared[i][j]} shared, ${band(matrix.shared[i][j], items[i].urls.length, items[j].urls.length).name}`;
  // 1 + 3: inside each SERP cluster
  for (const c of clusters) {
    if (c.members.length < 2) continue;
    const L = c.leader;
    for (const m of c.members) {
      if (m === L) continue;
      const pairBand = band(matrix.shared[L][m], items[L].urls.length, items[m].urls.length);
      if (items[m].textCluster && items[L].textCluster && items[m].textCluster !== items[L].textCluster) {
        const advice = pairBand.name === 'same page' ? 'one page should serve both' : pairBand.name === 'same cluster' ? 'serve both from one page, or interlinked pages under one hub' : 'related intent: interlink the pages; merge only if Google shows the same results';
        addFlag(m, 'text-cluster-differs', `SERP groups it with "${items[L].keyword}" (${describe(L, m)}) but the text clusters differ: ${advice}`);
      }
      const tL = items[L].target;
      const tM = items[m].target;
      if (tM && tL && tM !== tL) {
        addFlag(m, 'target-conflict', `same SERP cluster as "${items[L].keyword}" (${describe(L, m)}) but mapped to ${shortUrl(tM)} instead of ${shortUrl(tL)}: ${pairBand.name === 'same page' ? 'consolidation candidate (references/08)' : 'consolidate, or interlink and differentiate the pages'}`);
      }
    }
  }
  // 2: same text cluster, different SERP clusters
  const byText = new Map();
  items.forEach((it, i) => {
    if (!it.textCluster) return;
    if (!byText.has(it.textCluster)) byText.set(it.textCluster, []);
    byText.get(it.textCluster).push(i);
  });
  for (const list of byText.values()) {
    if (list.length < 2) continue;
    const main = list.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    for (const i of list) {
      if (clusterOf.get(i) === clusterOf.get(main)) continue;
      addFlag(i, 'serp-split', `same text cluster as "${items[main].keyword}" but the SERPs differ (${describe(main, i)}): split candidate, it may need its own page or section`);
    }
  }
  // 4: one target URL for keywords from different SERP clusters
  const byTarget = new Map();
  items.forEach((it, i) => {
    if (!it.target) return;
    if (!byTarget.has(it.target)) byTarget.set(it.target, []);
    byTarget.get(it.target).push(i);
  });
  for (const [target, list] of byTarget) {
    if (list.length < 2) continue;
    const main = list.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    for (const i of list) {
      if (clusterOf.get(i) === clusterOf.get(main)) continue;
      addFlag(i, 'target-mixed-intents', `${shortUrl(target)} also targets "${items[main].keyword}" but the SERPs differ (${describe(main, i)}): split candidate`);
    }
  }
  const rows = items.map((it, i) => {
    const c = clusterOf.get(i);
    const L = c.leader;
    const rowBand = i === L ? null : band(matrix.shared[L][i], it.urls.length, items[L].urls.length);
    const lowConfidence = (it.impressions !== null && it.impressions < 100) || it.urls.length < 5;
    return {
      keyword: it.keyword,
      cluster_id: c.id,
      leader: items[L].keyword,
      size: c.members.length,
      shared_with_leader: i === L ? '' : matrix.shared[L][i],
      jaccard_with_leader: i === L ? '' : Math.round(matrix.jaccard[L][i] * 1000) / 1000,
      text_cluster: it.textCluster,
      target_url: it.target,
      flag: flags[i].map((f) => f.id).join(' '),
      band: rowBand ? rowBand.name : 'leader',
      impressions: it.impressions === null ? '' : it.impressions,
      results: it.urls.length,
      confidence: lowConfidence ? 'low' : 'normal',
      snapshot_date: it.date,
      notes: flags[i].map((f) => f.text).join(' | '),
    };
  });
  rows.sort((a, b) => a.cluster_id - b.cluster_id || (a.band === 'leader' ? -1 : b.band === 'leader' ? 1 : (b.shared_with_leader || 0) - (a.shared_with_leader || 0)));
  return { items, matrix, clusters, rows, order, band };
}

function renderReport(res, meta) {
  const L = [];
  const { rows, items, matrix } = res;
  L.push(`# SERP overlap (${meta.today})`, '');
  L.push(`- ${items.length} keyword(s) from ${meta.providers.join(', ') || 'serp-snapshot'} snapshots (${meta.dates.join(', ')}); country ${meta.countries.join(', ') || '-'}, language ${meta.langs.join(', ') || '-'}`);
  L.push(`- Top ${meta.top}; k = ${meta.k} shared URLs (${meta.scale ? 'scaled down for SERPs with fewer results, never below 2' : 'not scaled'}); mode ${meta.mode} (${meta.mode === 'soft' ? 'every member shares >= k with the leader' : 'every pair shares >= k'}); leader = most impressions`);
  L.push(`- Text clusters: ${meta.membersFile ? path.basename(meta.membersFile) : 'none (run query-clusters.mjs)'}; targets: ${meta.mapFile ? 'keyword-map.csv' : 'none'}`);
  for (const w of meta.warnings) L.push(`- WARNING: ${w}`);
  L.push('');
  L.push('_Caveats: Brave is not Google (check important clusters on Google by hand); the thresholds are a published heuristic to calibrate on pairs you already understand; low-volume SERPs churn weekly (low confidence); organic results in a "top 10" are often 5-9 URLs, so k and the bands are scaled to the shorter list._', '');
  L.push('## Clusters', '');
  L.push(mdTable(
    [
      { label: 'Cluster', align: 'right', key: 'cluster_id' },
      { label: 'Keyword', value: (r) => (r.band === 'leader' ? `**${r.keyword}**` : r.keyword) },
      { label: 'Shared with leader', align: 'right', value: (r) => (r.band === 'leader' ? 'leader' : `${r.shared_with_leader} (J ${Number(r.jaccard_with_leader).toFixed(2)})`) },
      { label: 'Band', key: 'band' },
      { label: 'Impr.', align: 'right', value: (r) => (r.impressions === '' ? '-' : fmtInt(r.impressions)) },
      { label: 'Text cluster', key: 'text_cluster' },
      { label: 'Target', value: (r) => shortUrl(r.target_url) },
      { label: 'Flag', key: 'flag' },
      { label: 'Conf.', key: 'confidence' },
    ],
    rows.filter((r) => r.size > 1).slice(0, 200),
    { empty: 'No two keywords share enough URLs: every keyword is its own intent.' },
  ));
  const singles = rows.filter((r) => r.size === 1);
  if (singles.length) L.push(`Keywords with their own SERP (no partner at k): ${singles.map((r) => r.keyword).join(', ')}`, '');
  const flagged = rows.filter((r) => r.flag);
  L.push('## Disagreements to review', '');
  L.push(mdTable([{ label: 'Keyword', key: 'keyword' }, { label: 'Flag', key: 'flag' }, { label: 'What it means', key: 'notes' }], flagged, { empty: 'None.' }));
  const pairs = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (matrix.shared[i][j] > 0) pairs.push({ a: items[i].keyword, b: items[j].keyword, shared: matrix.shared[i][j], jaccard: matrix.jaccard[i][j], band: res.band(matrix.shared[i][j], items[i].urls.length, items[j].urls.length), k: matrix.kEff[i][j] });
  pairs.sort((x, y) => y.shared - x.shared || y.jaccard - x.jaccard);
  L.push('## Pairs sharing URLs', '');
  L.push(mdTable([{ label: 'Keyword A', key: 'a' }, { label: 'Keyword B', key: 'b' }, { label: 'Shared', align: 'right', key: 'shared' }, { label: 'Jaccard', align: 'right', value: (p) => p.jaccard.toFixed(2) }, { label: 'k used', align: 'right', key: 'k' }, { label: 'Band (heuristic)', value: (p) => `${p.band.name}: ${p.band.advice}` }], pairs.slice(0, 60), { empty: 'No pair shares a URL.' }));
  L.push('## Bands (heuristic, calibrate on your data)', '');
  for (const b of BANDS) L.push(`- ${b.name === 'separate' ? '0-1' : b.name === 'interlink' ? '2-3' : b.name === 'same cluster' ? '4-6' : '7-10'} shared of 10: ${b.name} - ${b.advice}`);
  L.push('', 'Next: for target-conflict pairs, read both pages and the live Google SERP before consolidating (references/08); for serp-split and target-mixed-intents, check which page Google ranks for each keyword before splitting.', '');
  return L.join('\n');
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  if (flags.date && !isYmd(flags.date)) throw new UserError(`Invalid --date "${flags.date}" (expected YYYY-MM-DD)`);
  if (flags.top < 2 || flags.minShared < 1) throw new UserError('--top must be >= 2 and --min-shared >= 1');
  const ws = loadWorkspace(flags);
  const { snapshots, skipped } = loadSnapshots(ws, flags);
  if (snapshots.length < 2) {
    throw new UserError(`Need SERP snapshots for at least 2 keywords (found ${snapshots.length}${flags.date ? ` on ${flags.date}` : ''})`, {
      hint: [`Take snapshots: ${scriptCmd('serp-snapshot.mjs')} --from-keyword-map --max-keywords 30`, 'Or pass --files <snapshot.json> (repeatable).'],
    });
  }
  const membersFile = flags.queryClusters ? path.resolve(flags.queryClusters) : ws.listData('gsc', /-query-cluster-members\.csv$/)[0] || '';
  if (flags.queryClusters && !fs.existsSync(membersFile)) throw new UserError(`Query clusters file not found: ${flags.queryClusters}`);
  const mapFile = flags.keywordMap ? path.resolve(flags.keywordMap) : ws.path('keyword-map.csv');
  if (flags.keywordMap && !fs.existsSync(mapFile)) throw new UserError(`Keyword map not found: ${flags.keywordMap}`);
  const origin = ws.siteUrl({ required: false }) ? ws.origin() : '';
  const res = analyzeOverlap(snapshots, { top: flags.top, k: flags.minShared, mode: flags.mode, scale: !flags.noScale, members: readMembers(membersFile), keywordMap: readKeywordMapFile(mapFile, origin) });
  const warnings = [];
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const dates = uniq(snapshots.map((s) => s.date)).sort();
  if (dates.length > 1 && diffDays(dates[0], dates[dates.length - 1]) > flags.maxAgeDays) warnings.push(`snapshots span ${dates[0]} -> ${dates[dates.length - 1]}: SERPs move week to week; re-snapshot the keywords together for a fair comparison`);
  for (const [label, key] of [['country', 'country'], ['language', 'lang'], ['provider', 'provider']]) {
    const vals = uniq(snapshots.map((s) => s[key]));
    if (vals.length > 1) warnings.push(`snapshots mix ${label}s (${vals.join(', ')}): compare like with like`);
  }
  if (skipped.length) warnings.push(`unreadable snapshot file(s) skipped: ${skipped.slice(0, 5).join(', ')}`);
  const thin = res.items.filter((i) => i.urls.length < flags.top);
  if (thin.length) warnings.push(`${thin.length} SERP(s) have fewer than ${flags.top} results (${thin.slice(0, 3).map((i) => `${i.keyword}: ${i.urls.length}`).join(', ')})${flags.noScale ? '' : '; k scaled down for their pairs'}`);
  const meta = { today: ws.today(), top: flags.top, k: flags.minShared, mode: flags.mode, scale: !flags.noScale, membersFile, mapFile: fs.existsSync(mapFile) ? mapFile : '', warnings, dates, countries: uniq(snapshots.map((s) => s.country)), langs: uniq(snapshots.map((s) => s.lang)), providers: uniq(snapshots.map((s) => s.provider)) };
  const columns = ['keyword', 'cluster_id', 'leader', 'size', 'shared_with_leader', 'jaccard_with_leader', 'text_cluster', 'target_url', 'flag', 'band', 'impressions', 'results', 'confidence', 'snapshot_date', 'notes'];
  const csv = writeCsvFile(ws.dataFile('serp', 'serp-clusters', 'csv'), res.rows, columns);
  const json = writeJson(ws.dataFile('serp', 'serp-overlap', 'json'), {
    meta: { generatedAt: new Date().toISOString(), top: flags.top, minShared: flags.minShared, mode: flags.mode, scaled: !flags.noScale, warnings, files: snapshots.map((s) => path.basename(s.file)) },
    keywords: res.items.map((i) => ({ keyword: i.keyword, date: i.date, results: i.urls.length, impressions: i.impressions, textCluster: i.textCluster, target: i.target })),
    shared: res.matrix.shared,
    jaccard: res.matrix.jaccard.map((r) => r.map((x) => Math.round(x * 1000) / 1000)),
    k: res.matrix.kEff,
    clusters: res.clusters.map((c) => ({ id: c.id, leader: res.items[c.leader].keyword, members: c.members.map((m) => res.items[m].keyword) })),
  });
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-serp-overlap.md`), renderReport(res, meta));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ meta, clusters: res.rows, files: { csv, json, report: md } }, null, 2)}\n`);
    return 0;
  }
  const multi = res.clusters.filter((c) => c.members.length > 1);
  out(`${res.items.length} keyword(s) -> ${res.clusters.length} SERP cluster(s) (${multi.length} with 2+ keywords), k = ${flags.minShared}, ${flags.mode} mode, top ${flags.top}.`);
  for (const w of warnings) out(`WARNING: ${w}`);
  if (multi.length) out(textTable(['cluster', 'leader', 'members'], multi.slice(0, 10).map((c) => [c.id, res.items[c.leader].keyword, c.members.length])));
  const flagged = res.rows.filter((r) => r.flag);
  const counts = {};
  for (const r of flagged) for (const f of r.flag.split(' ')) counts[f] = (counts[f] || 0) + 1;
  out(`Flags: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  out('Brave approximates Google; thresholds are heuristics to calibrate on your own data.');
  out(`\nwrote ${md}\nwrote ${csv}\nwrote ${json}`);
  return 0;
}

runMain(import.meta.url, main);
