#!/usr/bin/env node
// Cluster Search Console queries into topic families, map each to its dominant URL, flag clusters with
// no dedicated page and page-split risks, and merge the result into keyword-map.csv.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, log, writeJson, writeText, normalizeUrl } from './lib/util.mjs';
import { loadWorkspace, makeBrandMatcher } from './lib/config.mjs';
import { gscClient, loadGscFile } from './lib/gsc.mjs';
import { addDays } from './lib/dates.mjs';
import { normalizeText, compactKey, buildCjkVocabulary, topicTokens } from './lib/text.mjs';
import { readCsvFile, writeCsvFile } from './lib/csv.mjs';
import { fmtInt, fmtPct, fmtPos, mdTable, shortUrl } from './lib/format.mjs';

export const KEYWORD_MAP_COLUMNS = ['keyword', 'intent', 'cluster', 'target_url', 'current_url_ranking', 'position', 'impressions', 'clicks', 'status', 'notes'];

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  site: { type: 'string', placeholder: 'property', desc: 'Override gsc.siteUrl' },
  days: { type: 'int', desc: 'Window length (ends at the newest final day)', default: 90 },
  input: { type: 'string', placeholder: 'file', desc: 'Offline: gsc-export (or Search Console UI CSV) with query and page columns' },
  'page-regex': { type: 'string', placeholder: 'regex', desc: 'Only rows whose page matches (JS regex)' },
  'min-impressions': { type: 'int', desc: 'Ignore queries with fewer impressions', default: 1 },
  'max-queries': { type: 'int', desc: 'Cluster at most this many queries (by impressions)', default: 20000 },
  similarity: { type: 'number', desc: 'Weighted-Jaccard threshold to join a cluster (0-1)', default: 0.5 },
  'hub-regex': { type: 'string', placeholder: 'regex', desc: 'Paths treated as hubs/listing pages (default: the home page and pageGroups named home/hub/category/tag)' },
  'gap-min-impr': { type: 'int', desc: 'Flag clusters without a dedicated page from this many impressions', default: 100 },
  'map-min-impressions': { type: 'int', desc: 'Add cluster leaders with at least this many impressions to keyword-map.csv', default: 50 },
  'map-all': { type: 'boolean', desc: 'Add every query above --map-min-impressions (not just cluster leaders)' },
  'no-map': { type: 'boolean', desc: 'Do not touch keyword-map.csv' },
  top: { type: 'int', desc: 'Rows per Markdown section', default: 40 },
};

const HELP = formatHelp({
  usage: ['node scripts/query-clusters.mjs [--days 90]', 'node scripts/query-clusters.mjs --input data/gsc/<file>.json'],
  summary:
    'Normalizes queries (NFKC, case, punctuation, CJK spacing), strips brand terms, segments CJK with a vocabulary learned from your own ' +
    'queries, and groups queries that share informative tokens (IDF-weighted Jaccard). For each cluster: metrics, dominant URL and its share, ' +
    'ownership (dedicated / hub / split) and a "needs a dedicated page" flag. Per query: tier (head/body/tail), position bucket, intent guess ' +
    'and page-split risk (high/medium/low). Merges cluster leaders into keyword-map.csv without overwriting manual columns.',
  spec: SPEC,
  examples: ['node scripts/query-clusters.mjs', 'node scripts/query-clusters.mjs --input data/gsc/2026-11-01-query-page-90d.json --similarity 0.45', 'node scripts/query-clusters.mjs --map-all --map-min-impressions 200'],
  notes: [
    'Lexical clustering approximates intent; confirm important clusters by looking at the live SERP (same top results = same intent).',
    'keyword-map.csv: metrics (position, impressions, clicks, current_url_ranking) are refreshed; intent, cluster, target_url, status and notes are only filled when empty.',
  ],
});

const INTENT_RULES = [
  ['comparison', /(\bvs\.?\b|\bversus\b|\bcompare|\bcomparison|\balternative|比較|差別|差異|差在哪|哪個好|哪个好|还是|還是)/i],
  ['informational', /(\bhow to\b|\bguide\b|\btutorial\b|\bsteps?\b|\btips\b|\bwhat is\b|\bmeaning\b|\bdefinition\b|怎麼|怎么|如何|教學|教学|指南|步驟|步骤|入門|入门|意思|意義|是什麼|是什么|方法)/i],
  ['consideration', /(\bbest\b|\btop \d+|\btop\b|\bworth it\b|\breview|\blegit\b|\baccurate\b|\bis it good\b|準嗎|准吗|有用嗎|值不值得|適合|适合|評價|评价|評測|评测|推薦|推荐|ptt|dcard)/i],
  ['question', /(\bcan\b|\bdoes\b|\bwill\b|\bshould\b|\bwhen\b|\bwhy\b|\bhow long\b|\?|？|會不會|会不会|多久|何時|何时|能不能|是不是|有沒有|有没有|嗎$|吗$)/i],
  ['commercial', /(\bbuy\b|\bprice|\bpricing\b|\bcost\b|\bcheap\b|\bdiscount\b|\bcoupon\b|\bfree\b|\bonline\b|\bnear me\b|\bdownload\b|\bservice\b|購買|购买|價格|价格|多少錢|多少钱|優惠|优惠|免費|免费|線上|线上|下載|下载|服務|服务)/i],
];

export function inferIntent(query, isBrand) {
  if (isBrand && isBrand(query)) return 'navigational';
  for (const [intent, re] of INTENT_RULES) if (re.test(query)) return intent;
  return 'informational';
}

const bucketOf = (p) => (!(p > 0) ? '' : p <= 3.5 ? '1-3' : p <= 10.5 ? '4-10' : p <= 20.5 ? '11-20' : '21+');

function pageSplitRisk(pages, impressions) {
  if (impressions < 10) return 'none';
  const effective = pages.filter((p) => p.impressions >= 5 || p.clicks > 0);
  if (effective.length < 2) return 'none';
  const total = effective.reduce((s, p) => s + p.impressions, 0);
  const topShare = total ? effective[0].impressions / total : 1;
  const second = effective[1];
  if ((second.clicks > 0 && topShare < 0.75) || (effective.length >= 3 && topShare < 0.8)) return 'high';
  if (second.impressions >= 5 || second.clicks > 0) return 'medium';
  return 'low';
}

/** Pure clustering over {query,page,clicks,impressions,position} rows; exported for tests. */
export function clusterQueries(rows, { brandTerms = [], similarity = 0.5, minImpressions = 1, maxQueries = 20000, isHub = () => false, gapMinImpr = 100 } = {}) {
  const isBrand = makeBrandMatcher(brandTerms);
  // strip whole brand terms only: a brand like "Example Coffee" must not remove "coffee" from every query
  const brandTokens = new Set(brandTerms.flatMap((t) => [compactKey(t), normalizeText(t)]).filter((t) => t.length >= 2));
  const byQuery = new Map();
  for (const r of rows) {
    const q = normalizeText(r.query);
    if (!q) continue;
    if (!byQuery.has(q)) byQuery.set(q, { query: q, raw: new Set(), clicks: 0, impressions: 0, pw: 0, pages: new Map() });
    const e = byQuery.get(q);
    e.raw.add(r.query);
    e.clicks += r.clicks;
    e.impressions += r.impressions;
    e.pw += (r.position || 0) * r.impressions;
    if (r.page) {
      const k = normalizeUrl(r.page, { stripTracking: false }) || r.page;
      const p = e.pages.get(k) || { page: k, clicks: 0, impressions: 0, pw: 0 };
      p.clicks += r.clicks;
      p.impressions += r.impressions;
      p.pw += (r.position || 0) * r.impressions;
      e.pages.set(k, p);
    }
  }
  // metrics for every query (before thresholds) so keyword-map rows are refreshed even if a query is not clustered
  const allMetrics = new Map();
  for (const e of byQuery.values()) {
    const top = [...e.pages.values()].sort((a, b) => b.impressions - a.impressions)[0];
    allMetrics.set(compactKey(e.query), { clicks: e.clicks, impressions: e.impressions, position: e.impressions ? e.pw / e.impressions : 0, topPage: top ? top.page : '' });
  }
  let entries = [...byQuery.values()].filter((e) => e.impressions >= minImpressions).sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
  const dropped = Math.max(0, entries.length - maxQueries);
  entries = entries.slice(0, maxQueries);
  let stripBrand = (q) => q;
  if (brandTerms.length) {
    const parts = [...brandTokens].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(parts.join('|'), 'g');
    stripBrand = (q) => q.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }
  const vocab = buildCjkVocabulary(entries.map((e) => stripBrand(e.query)));
  const totalImpr = entries.reduce((s, e) => s + e.impressions, 0);
  let cum = 0;
  for (const e of entries) {
    e.position = e.impressions ? e.pw / e.impressions : 0;
    e.ctr = e.impressions ? e.clicks / e.impressions : 0;
    e.brand = isBrand(e.query);
    e.tokens = topicTokens(stripBrand(e.query), { vocab, exclude: brandTokens });
    e.pageList = [...e.pages.values()].map((p) => ({ ...p, position: p.impressions ? p.pw / p.impressions : 0 })).sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
    e.risk = pageSplitRisk(e.pageList, e.impressions);
    cum += e.impressions;
    e.tier = cum - e.impressions < totalImpr * 0.5 ? 'head' : cum - e.impressions < totalImpr * 0.8 ? 'body' : 'tail';
    e.bucket = bucketOf(e.position);
    e.intent = inferIntent(e.query, isBrand);
  }
  const df = new Map();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) || 0) + 1);
  const N = entries.length;
  const weight = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
  const clusters = [];
  const index = new Map();
  const bySignature = new Map();
  const brandCluster = { id: 0, leader: null, tokens: [], members: [], brand: true };
  for (const e of entries) {
    if (e.brand && !e.tokens.length) {
      brandCluster.members.push(e);
      continue;
    }
    if (!e.tokens.length) e.tokens = [compactKey(e.query)];
    const sig = [...e.tokens].sort().join('|');
    if (bySignature.has(sig)) {
      bySignature.get(sig).members.push(e);
      continue;
    }
    let best = null;
    let bestSim = 0;
    const candidates = new Set();
    for (const t of e.tokens) for (const c of index.get(t) || []) candidates.add(c);
    for (const c of candidates) {
      const a = new Set(c.tokens);
      let inter = 0;
      let union = 0;
      for (const t of new Set([...c.tokens, ...e.tokens])) {
        const w = weight(t);
        union += w;
        if (a.has(t) && e.tokens.includes(t)) inter += w;
      }
      const sim = union ? inter / union : 0;
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= similarity) {
      best.members.push(e);
      bySignature.set(sig, best);
      continue;
    }
    const c = { id: clusters.length + 1, leader: e, tokens: e.tokens, members: [e] };
    clusters.push(c);
    bySignature.set(sig, c);
    for (const t of e.tokens) {
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(c);
    }
  }
  if (brandCluster.members.length) {
    brandCluster.leader = brandCluster.members[0];
    clusters.push(brandCluster);
  }
  const result = clusters.map((c) => {
    const pages = new Map();
    let clicks = 0;
    let impressions = 0;
    let pw = 0;
    for (const m of c.members) {
      clicks += m.clicks;
      impressions += m.impressions;
      pw += m.pw;
      for (const p of m.pageList) {
        const x = pages.get(p.page) || { page: p.page, clicks: 0, impressions: 0 };
        x.clicks += p.clicks;
        x.impressions += p.impressions;
        pages.set(p.page, x);
      }
    }
    const pageList = [...pages.values()].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    const pageImpr = pageList.reduce((s, p) => s + p.impressions, 0);
    const dominant = pageList[0] || null;
    const share = dominant && pageImpr ? dominant.impressions / pageImpr : 0;
    const meaningful = pageList.filter((p) => p.impressions >= 5 || p.clicks > 0).length;
    let owner = 'none';
    if (dominant) owner = isHub(dominant.page) ? 'hub' : share >= 0.6 ? 'dedicated' : 'split';
    const brand = Boolean(c.brand) || c.members.every((m) => m.brand);
    const label = c.brand ? '(brand)' : c.leader.query;
    for (const m of c.members) {
      m.clusterId = c.id;
      m.clusterLabel = label;
    }
    return {
      id: c.id,
      label,
      tokens: c.tokens,
      queries: c.members.length,
      topQueries: c.members.slice(0, 6).map((m) => m.query),
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      position: impressions ? pw / impressions : 0,
      dominantUrl: dominant ? dominant.page : '',
      dominantShare: share,
      pagesWithImpressions: meaningful,
      pages: pageList.slice(0, 5),
      owner,
      brand,
      needsPage: !brand && owner !== 'dedicated' && impressions >= gapMinImpr,
      intent: inferIntent(c.leader.query, isBrand),
    };
  });
  result.sort((a, b) => b.impressions - a.impressions);
  return { clusters: result, queries: entries, allMetrics, dropped, vocabularySize: vocab.size };
}

/** Upsert into keyword-map rows without touching manual columns. Returns {headers, records, added, updated}. */
export function mergeKeywordMap(existing, clusterResult, { minImpressions = 50, all = false, refreshMissing = true } = {}) {
  const headers = [...existing.headers];
  for (const c of KEYWORD_MAP_COLUMNS) if (!headers.includes(c)) headers.push(c);
  const records = existing.records.map((r) => ({ ...r }));
  const byKey = new Map(records.map((r) => [compactKey(r.keyword), r]));
  const queryByKey = new Map(clusterResult.queries.map((q) => [compactKey(q.query), q]));
  const clusterById = new Map(clusterResult.clusters.map((c) => [c.id, c]));
  let added = 0;
  let updated = 0;
  const fillEmpty = (rec, col, value) => {
    if ((rec[col] === undefined || rec[col] === '') && value !== undefined && value !== '') rec[col] = value;
  };
  const allMetrics = clusterResult.allMetrics || new Map();
  for (const rec of records) {
    const key = compactKey(rec.keyword);
    const q = queryByKey.get(key);
    const m = allMetrics.get(key);
    if (q) {
      rec.current_url_ranking = q.pageList[0] ? q.pageList[0].page : '';
      rec.position = q.position ? q.position.toFixed(1) : '';
      rec.impressions = String(q.impressions);
      rec.clicks = String(q.clicks);
      fillEmpty(rec, 'intent', q.intent);
      fillEmpty(rec, 'cluster', q.clusterLabel);
      updated++;
    } else if (m) {
      rec.current_url_ranking = m.topPage;
      rec.position = m.position ? m.position.toFixed(1) : '';
      rec.impressions = String(m.impressions);
      rec.clicks = String(m.clicks);
      updated++;
    } else if (refreshMissing && rec.impressions !== undefined && rec.impressions !== '') {
      rec.current_url_ranking = '';
      rec.position = '';
      rec.impressions = '0';
      rec.clicks = '0';
    }
  }
  const candidates = all ? clusterResult.queries.filter((q) => q.impressions >= minImpressions) : clusterResult.clusters.filter((c) => c.impressions >= minImpressions && !c.brand).map((c) => clusterResult.queries.find((q) => q.clusterId === c.id && q.query === c.label)).filter(Boolean);
  for (const q of candidates) {
    const key = compactKey(q.query);
    if (byKey.has(key)) continue;
    const c = clusterById.get(q.clusterId);
    const rec = Object.fromEntries(headers.map((h) => [h, '']));
    Object.assign(rec, {
      keyword: q.query,
      intent: q.intent,
      cluster: q.clusterLabel,
      target_url: c && c.owner === 'dedicated' ? c.dominantUrl : '',
      current_url_ranking: q.pageList[0] ? q.pageList[0].page : '',
      position: q.position ? q.position.toFixed(1) : '',
      impressions: String(q.impressions),
      clicks: String(q.clicks),
      status: 'new',
    });
    records.push(rec);
    byKey.set(key, rec);
    added++;
  }
  return { headers, records, added, updated };
}

function renderReport(res, meta) {
  const L = [];
  const top = meta.top;
  L.push(`# Query clusters (${meta.range})`, '');
  L.push(`- Source: ${meta.source}; ${res.queries.length} queries, ${res.clusters.length} clusters, CJK vocabulary ${res.vocabularySize} words${res.dropped ? `; ${res.dropped} low-impression queries skipped` : ''}`);
  L.push(`- Similarity threshold ${meta.similarity}; ownership: dedicated = one non-hub URL holds >= 60% of the cluster's impressions.`, '');
  L.push('## Clusters without a dedicated page', '', '_Decide one target URL per cluster (strengthen an existing page before creating a new one)._', '');
  const cCols = [
    { label: 'Cluster', value: (c) => c.label },
    { label: 'Queries', align: 'right', value: (c) => c.queries },
    { label: 'Impr.', align: 'right', value: (c) => fmtInt(c.impressions) },
    { label: 'Clicks', align: 'right', value: (c) => fmtInt(c.clicks) },
    { label: 'Pos', align: 'right', value: (c) => fmtPos(c.position) },
    { label: 'Dominant URL (share)', value: (c) => `${shortUrl(c.dominantUrl)} (${fmtPct(c.dominantShare, 0)})` },
    { label: 'Owner', value: (c) => c.owner },
    { label: 'Intent', value: (c) => c.intent },
    { label: 'Sample queries', value: (c) => c.topQueries.slice(0, 4).join(' / ') },
  ];
  L.push(mdTable(cCols, res.clusters.filter((c) => c.needsPage).slice(0, top)));
  L.push('## Largest clusters', '', mdTable(cCols, res.clusters.slice(0, top)));
  const risky = res.queries.filter((q) => q.risk === 'high' || q.risk === 'medium').sort((a, b) => (a.risk === b.risk ? b.impressions - a.impressions : a.risk === 'high' ? -1 : 1));
  L.push('## Page-split risk (per query)', '', '_high: second page has clicks and the top page holds < 75%, or >= 3 pages and < 80%. Re-check after indexing clean-ups before changing content._', '');
  L.push(mdTable(
    [
      { label: 'Risk', value: (q) => q.risk },
      { label: 'Query', value: (q) => q.query },
      { label: 'Impr.', align: 'right', value: (q) => fmtInt(q.impressions) },
      { label: 'Pos', align: 'right', value: (q) => fmtPos(q.position) },
      { label: 'Pages (clicks/impr.)', value: (q) => q.pageList.slice(0, 3).map((p) => `${shortUrl(p.page)} (${p.clicks}/${p.impressions})`).join('; ') },
    ],
    risky.slice(0, top),
  ));
  if (meta.map) {
    L.push('## keyword-map.csv', '', `${meta.map.added} keywords added, ${meta.map.updated} refreshed. Manual columns were not overwritten.`);
    if (meta.mismatches.length) {
      L.push('', 'Target URL differs from the URL that actually ranks:', '');
      L.push(mdTable([{ label: 'Keyword', key: 'keyword' }, { label: 'Target', value: (r) => shortUrl(r.target_url) }, { label: 'Ranking now', value: (r) => shortUrl(r.current_url_ranking) }, { label: 'Pos', key: 'position', align: 'right' }], meta.mismatches.slice(0, top)));
    }
  }
  return L.join('\n');
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  let rows;
  let source;
  let range = '';
  if (flags.input) {
    const file = loadGscFile(path.resolve(flags.input));
    rows = file.rows;
    source = path.basename(flags.input);
    range = file.meta.startDate ? `${file.meta.startDate} -> ${file.meta.endDate}` : 'input file';
    if (!file.dimensions.includes('query')) throw new Error('Input has no query column');
  } else {
    const gsc = gscClient(ws, flags);
    const end = await gsc.latestFinalDate();
    const start = addDays(end, -(flags.days - 1));
    log(`Fetching query+page rows ${start}..${end}...`);
    rows = (await gsc.query({ startDate: start, endDate: end, dimensions: ['query', 'page'], type: 'web', dataState: 'final' })).rows;
    source = `Search Console API (${gsc.siteUrl})`;
    range = `${start} -> ${end}`;
  }
  if (flags.pageRegex) {
    const re = new RegExp(flags.pageRegex);
    rows = rows.filter((r) => !r.page || re.test(r.page));
  }
  const groups = ws.pageGroups().filter((g) => /^(home|hub|hubs|category|categories|tag|tags|index)$/i.test(g.name));
  const hubRe = flags.hubRegex ? new RegExp(flags.hubRegex) : null;
  const isHub = (url) => {
    let p = url;
    try {
      p = new URL(url).pathname;
    } catch {
      /* path */
    }
    if (p === '/' || p === '') return true;
    if (hubRe) return hubRe.test(p);
    return groups.some((g) => g.re.test(p));
  };
  const res = clusterQueries(rows, { brandTerms: ws.brandTerms(), similarity: flags.similarity, minImpressions: flags.minImpressions, maxQueries: flags.maxQueries, isHub, gapMinImpr: flags.gapMinImpr });

  const files = [];
  files.push(writeCsvFile(ws.dataFile('gsc', 'query-clusters', 'csv'), res.clusters.map((c) => ({
    cluster_id: c.id, label: c.label, queries: c.queries, clicks: c.clicks, impressions: c.impressions, ctr: c.ctr.toFixed(4), position: c.position.toFixed(2),
    dominant_url: c.dominantUrl, dominant_share: c.dominantShare.toFixed(3), pages_with_impressions: c.pagesWithImpressions, owner: c.owner, needs_page: c.needsPage ? 'yes' : '', brand: c.brand ? 'yes' : '', intent: c.intent, tokens: c.tokens.join(' '), top_queries: c.topQueries.join(' | '),
  }))));
  files.push(writeCsvFile(ws.dataFile('gsc', 'query-cluster-members', 'csv'), res.queries.map((q) => ({
    query: q.query, cluster_id: q.clusterId, cluster: q.clusterLabel, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr.toFixed(4), position: q.position.toFixed(2), tier: q.tier, bucket: q.bucket, intent: q.intent, brand: q.brand ? 'yes' : '', risk: q.risk,
    primary_page: q.pageList[0] ? q.pageList[0].page : '', primary_share: q.pageList.length ? (q.pageList[0].impressions / q.pageList.reduce((s, p) => s + p.impressions, 0)).toFixed(3) : '', pages: q.pageList.slice(0, 4).map((p) => `${p.page} (${p.clicks}/${p.impressions})`).join(' | '),
  }))));
  files.push(writeJson(ws.dataFile('gsc', 'query-clusters', 'json'), { meta: { source, range, similarity: flags.similarity }, clusters: res.clusters }));

  let mapInfo = null;
  let mismatches = [];
  if (!flags.noMap) {
    const mapPath = ws.path('keyword-map.csv');
    const existing = fs.existsSync(mapPath) ? readCsvFile(mapPath) : { headers: KEYWORD_MAP_COLUMNS, records: [] };
    const merged = mergeKeywordMap(existing, res, { minImpressions: flags.mapMinImpressions, all: flags.mapAll, refreshMissing: !flags.pageRegex });
    writeCsvFile(mapPath, merged.records, merged.headers);
    mapInfo = { added: merged.added, updated: merged.updated, path: mapPath };
    mismatches = merged.records.filter((r) => r.target_url && r.current_url_ranking && (normalizeUrl(r.target_url) || r.target_url) !== (normalizeUrl(r.current_url_ranking) || r.current_url_ranking));
  }
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-query-clusters.md`), renderReport(res, { source, range, similarity: flags.similarity, top: flags.top, map: mapInfo, mismatches }));
  out(`${res.queries.length} queries -> ${res.clusters.length} clusters (${range})`);
  out(`  without a dedicated page: ${res.clusters.filter((c) => c.needsPage).length}; page-split risk high: ${res.queries.filter((q) => q.risk === 'high').length}, medium: ${res.queries.filter((q) => q.risk === 'medium').length}`);
  for (const c of res.clusters.slice(0, 5)) out(`  ${c.label.slice(0, 40).padEnd(40)} ${String(c.queries).padStart(4)} q  ${fmtInt(c.impressions).padStart(8)} impr  ${c.owner}`);
  if (mapInfo) out(`keyword-map.csv: +${mapInfo.added} new, ${mapInfo.updated} refreshed${mismatches.length ? `, ${mismatches.length} target/ranking URL mismatches` : ''}`);
  out(`\nwrote ${md}`);
  for (const f of files) out(`wrote ${f}`);
  return 0;
}

runMain(import.meta.url, main);
