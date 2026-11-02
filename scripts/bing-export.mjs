#!/usr/bin/env node
// Bing Webmaster Tools exports (traffic, queries, pages, page queries, crawl, inbound links, keyword research) via
// the official JSON API. ChatGPT search and Copilot lean on the Bing index, so Bing is tracked separately from Google.
import fs from 'node:fs';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, normalizeUrl } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { addDays, spanDays } from './lib/dates.mjs';
import { fmtInt, fmtPct, textTable, shortUrl } from './lib/format.mjs';
import { bingClient, BING_ENDPOINT } from './lib/bing.mjs';
import { countryCode } from './lib/geo.mjs';

const SUBCOMMANDS = ['traffic', 'queries', 'pages', 'page-queries', 'crawl', 'links', 'keywords', 'all'];

const SPEC = {
  ...COMMON_FLAGS,
  site: { type: 'string', placeholder: 'url', desc: 'Bing site URL (default: config bing.siteUrl, else site.url)' },
  page: { type: 'string', placeholder: 'url', desc: 'page-queries: the page URL' },
  days: { type: 'int', desc: 'Window for totals and top lists, ending at the newest date Bing returned (raw history is kept in the JSON)', default: 90 },
  'max-pages': { type: 'int', desc: 'links: pages to read from each paged list (GetLinkCounts / GetUrlLinks)', default: 10 },
  'max-targets': { type: 'int', desc: 'links: fetch linking pages + anchors for this many of your most-linked URLs', default: 25 },
  keyword: { type: 'list', placeholder: 'kw', desc: 'keywords: keyword to look up' },
  'keywords-file': { type: 'string', placeholder: 'file', desc: 'keywords: file with one keyword per line' },
  country: { type: 'string', placeholder: 'cc', desc: 'keywords: country, 2-letter (default: serp.country / site.country)' },
  language: { type: 'string', placeholder: 'xx-XX', desc: 'keywords: language such as en-US or zh-TW (default: site.language + country)' },
  'no-related': { type: 'boolean', desc: 'keywords: skip related keywords' },
  delay: { type: 'int', placeholder: 'ms', desc: 'Pause between API calls', default: 500 },
  top: { type: 'int', desc: 'Rows printed per list', default: 10 },
  'retry-ms': { type: 'int', desc: 'Base backoff when throttled', default: 5000, hidden: true },
  json: { type: 'boolean', desc: 'Print the summary as JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/bing-export.mjs <traffic|queries|pages|crawl|links|all> [--days 90]',
    'node scripts/bing-export.mjs page-queries --page https://www.example.com/guide/',
    'node scripts/bing-export.mjs keywords --keyword "pour over ratio" [--country us --language en-US]',
  ],
  summary:
    'Read-only exports from the Bing Webmaster Tools API: traffic (GetRankAndTrafficStats, daily clicks and impressions), queries and pages ' +
    '(GetQueryStats / GetPageStats, weekly buckets, aggregated over --days with impression-weighted positions), page-queries (GetPageQueryStats), ' +
    'crawl (GetCrawlStats daily + GetCrawlIssues), links (GetLinkCounts + GetUrlLinks: your most-linked URLs, linking pages and anchors) and ' +
    'keywords (GetKeywordStats weekly history, GetKeyword for the window, GetRelatedKeywords). "all" = traffic, queries, pages, crawl and links. ' +
    'Writes data/bing/<today>-<name>.json and .csv; data/bing/<today>-links.json = {meta, linkCounts:[{url,count}], links:[{target,source,anchor}]}.',
  spec: SPEC,
  examples: [
    'node scripts/bing-export.mjs all',
    'node scripts/bing-export.mjs queries --days 28 --top 20',
    'node scripts/bing-export.mjs links --max-targets 50',
    'node scripts/bing-export.mjs keywords --keywords-file seeds.txt --country tw --language zh-TW',
  ],
  notes: [
    'API key: Bing Webmaster Tools -> Settings -> API access -> API Key; export it in the env var named by config bing.apiKeyEnv (default BING_WEBMASTER_API_KEY). It is never printed or stored; URLs in errors show apikey=<redacted>.',
    'The site must be added and verified in the same Bing account as the key. Bing returns its whole retained history (no date parameters); query/page stats come in weekly buckets.',
    'Keyword impressions are Bing search demand on Bing only (strict Impressions vs BroadImpressions): use them as relative demand, never as Google search volume.',
    'Crawl columns other than CrawledPages/CrawlErrors are running snapshots: read the latest value, do not sum days. AI Performance (Copilot citations) has no API: export it from the UI and use ai-reports-import.mjs.',
  ],
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null); // -1 = no position

/** The --days window ending at the newest date in rows, clamped to the oldest date Bing returned. */
export function windowOf(rows, days) {
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  if (!dates.length) return null;
  const end = dates[dates.length - 1];
  const start = addDays(end, -(days - 1));
  return start < dates[0] ? { start: dates[0], end, days: spanDays(dates[0], end), clamped: true } : { start, end, days };
}

/** QueryStats rows (weekly buckets) -> per key totals with impression-weighted positions (-1 = no position). */
export function aggregateStats(rows, keyField, window) {
  const map = new Map();
  for (const r of rows) {
    if (window && r.date && (r.date < window.start || r.date > window.end)) continue;
    const key = r[keyField];
    if (!key) continue;
    const e = map.get(key) || { [keyField]: key, clicks: 0, impressions: 0, impPosW: 0, impPosN: 0, clickPosW: 0, clickPosN: 0, buckets: 0, first: '', last: '' };
    e.clicks += num(r.clicks);
    e.impressions += num(r.impressions);
    const ip = pos(r.avgImpressionPosition);
    if (ip !== null && num(r.impressions) > 0) {
      e.impPosW += ip * num(r.impressions);
      e.impPosN += num(r.impressions);
    }
    const cp = pos(r.avgClickPosition);
    if (cp !== null && num(r.clicks) > 0) {
      e.clickPosW += cp * num(r.clicks);
      e.clickPosN += num(r.clicks);
    }
    e.buckets++;
    if (r.date && (!e.first || r.date < e.first)) e.first = r.date;
    if (r.date && (!e.last || r.date > e.last)) e.last = r.date;
    map.set(key, e);
  }
  return [...map.values()]
    .map((e) => ({ [keyField]: e[keyField], clicks: e.clicks, impressions: e.impressions, ctr: e.impressions ? e.clicks / e.impressions : 0, avgImpressionPosition: e.impPosN ? e.impPosW / e.impPosN : null, avgClickPosition: e.clickPosN ? e.clickPosW / e.clickPosN : null, buckets: e.buckets, firstDate: e.first, lastDate: e.last }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
}

const statRow = (r, keyName = 'query') => ({ date: r.Date || '', [keyName]: r.Query || '', impressions: num(r.Impressions), clicks: num(r.Clicks), avgImpressionPosition: r.AvgImpressionPosition ?? null, avgClickPosition: r.AvgClickPosition ?? null });

// GetCrawlIssues "Issues" is a flags bitmask.
const ISSUE_FLAGS = [[1, 'Code301'], [2, 'Code302'], [4, 'Code4xx'], [8, 'Code5xx'], [16, 'BlockedByRobotsTxt'], [32, 'ContainsMalware'], [64, 'ImportantUrlBlockedByRobotsTxt'], [128, 'DnsErrors'], [256, 'TimeOutErrors']];
export function decodeIssues(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return value.split(/[\s,]+/).filter(Boolean);
  const n = Number(value) || 0;
  return ISSUE_FLAGS.filter(([bit]) => n & bit).map(([, name]) => name);
}

/** Default keyword market: 2-letter lowercase country and xx-XX language. */
export function keywordMarket(ws, flags) {
  const cfg = ws.config;
  const country = (countryCode(flags.country || (cfg.serp && cfg.serp.country) || cfg.site.country) || 'us').toLowerCase();
  let language = flags.language || cfg.site.language || 'en';
  if (/^[a-z]{2}$/i.test(language)) language = `${language.toLowerCase()}-${country.toUpperCase()}`;
  return { country, language };
}

function siteOf(ws, flags) {
  const raw = String(flags.site || (ws.config.bing && ws.config.bing.siteUrl) || ws.siteUrl()).trim();
  try {
    return new URL(raw).href;
  } catch {
    throw new UserError(`Bing site URL "${raw}" is not a valid absolute URL`, { hint: 'Set bing.siteUrl to the site as added in Bing Webmaster Tools, e.g. https://www.example.com/' });
  }
}

// ---------- exports ----------
async function exportTraffic(api, ws, flags, ctx) {
  const d = await api.call('GetRankAndTrafficStats');
  const rows = (Array.isArray(d) ? d : []).map((r) => ({ date: r.Date || '', clicks: num(r.Clicks), impressions: num(r.Impressions) })).filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const w = windowOf(rows, flags.days);
  const inWin = rows.filter((r) => w && r.date >= w.start);
  const totals = { clicks: inWin.reduce((s, r) => s + r.clicks, 0), impressions: inWin.reduce((s, r) => s + r.impressions, 0) };
  totals.ctr = totals.impressions ? totals.clicks / totals.impressions : 0;
  const meta = { ...ctx.meta, method: 'GetRankAndTrafficStats', window: w, rows: rows.length };
  const files = [writeJson(ws.dataFile('bing', 'traffic', 'json'), { meta, totals, rows }), writeCsvFile(ws.dataFile('bing', 'traffic', 'csv'), rows, ['date', 'clicks', 'impressions'])];
  return { name: 'traffic', files, summary: { window: w, ...totals, days: rows.length }, lines: [`traffic: ${w ? `${w.start} -> ${w.end}` : 'no data'}: ${fmtInt(totals.clicks)} clicks, ${fmtInt(totals.impressions)} impressions, CTR ${fmtPct(totals.ctr, 2)} (${rows.length} days of history)`] };
}

async function exportStats(api, ws, flags, ctx, { name, method, keyName, params = {}, label }) {
  const d = await api.call(method, params);
  const rows = (Array.isArray(d) ? d : []).map((r) => statRow(r, keyName));
  const w = windowOf(rows, flags.days);
  const agg = aggregateStats(rows, keyName, w);
  const meta = { ...ctx.meta, method, ...params, window: w, rows: rows.length, note: 'Bing returns weekly buckets; positions are impression-weighted over the window (-1 = no position).' };
  const files = [
    writeJson(ws.dataFile('bing', name, 'json'), { meta, totals: agg, rows }),
    writeCsvFile(ws.dataFile('bing', name, 'csv'), agg.map((a) => ({ ...a, ctr: Number(a.ctr.toFixed(4)), avgImpressionPosition: a.avgImpressionPosition === null ? '' : Number(a.avgImpressionPosition.toFixed(1)), avgClickPosition: a.avgClickPosition === null ? '' : Number(a.avgClickPosition.toFixed(1)) })), [keyName, 'clicks', 'impressions', 'ctr', 'avgImpressionPosition', 'avgClickPosition', 'buckets', 'firstDate', 'lastDate']),
  ];
  const origin = ctx.origin;
  const top = agg.slice(0, flags.top);
  const lines = [`${label}: ${agg.length} ${keyName === 'page' ? 'pages' : 'queries'} in ${w ? `${w.start} -> ${w.end}` : 'no data'}`];
  if (top.length) {
    lines.push(textTable([keyName, 'clicks', 'impr.', 'pos.'], top.map((a) => [keyName === 'page' ? shortUrl(a.page, origin) : a[keyName], fmtInt(a.clicks), fmtInt(a.impressions), a.avgImpressionPosition === null ? '-' : a.avgImpressionPosition.toFixed(1)])).split('\n').map((l) => `  ${l}`).join('\n'));
  }
  return { name, files, summary: { window: w, items: agg.length, top: top.map((a) => ({ key: a[keyName], clicks: a.clicks, impressions: a.impressions })) }, lines };
}

async function exportCrawl(api, ws, flags, ctx) {
  const d = await api.call('GetCrawlStats');
  const stats = (Array.isArray(d) ? d : []).map((r) => ({
    date: r.Date || '', crawledPages: num(r.CrawledPages), crawlErrors: num(r.CrawlErrors), inIndex: num(r.InIndex), inLinks: num(r.InLinks), code2xx: num(r.Code2xx), code301: num(r.Code301), code302: num(r.Code302),
    code4xx: num(r.Code4xx), code5xx: num(r.Code5xx), allOtherCodes: num(r.AllOtherCodes), blockedByRobotsTxt: num(r.BlockedByRobotsTxt), containsMalware: num(r.ContainsMalware), connectionTimeout: num(r.ConnectionTimeout), dnsFailures: num(r.DnsFailures),
  })).filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  let issues = [];
  let issuesNote = '';
  try {
    const di = await api.call('GetCrawlIssues');
    issues = (Array.isArray(di) ? di : []).map((r) => ({ url: r.Url || '', httpCode: r.HttpCode ?? '', inLinks: num(r.InLinks), issues: decodeIssues(r.Issues) }));
  } catch (e) {
    if (e.bingError === 'InvalidApiKey') throw e;
    issuesNote = `GetCrawlIssues skipped: ${e.message}`;
  }
  const w = windowOf(stats, Math.min(flags.days, 7));
  const last7 = stats.filter((r) => w && r.date >= w.start);
  const latest = stats[stats.length - 1] || null;
  const byIssue = new Map();
  for (const i of issues) for (const t of i.issues) byIssue.set(t, (byIssue.get(t) || 0) + 1);
  const meta = { ...ctx.meta, methods: ['GetCrawlStats', 'GetCrawlIssues'], rows: stats.length, issues: issues.length, note: 'CrawledPages and CrawlErrors are daily counts; the other columns are running snapshots (read the latest value).', issuesNote };
  const files = [writeJson(ws.dataFile('bing', 'crawl', 'json'), { meta, latest, issueCounts: Object.fromEntries(byIssue), stats, issues }), writeCsvFile(ws.dataFile('bing', 'crawl', 'csv'), stats)];
  const lines = [];
  if (latest) {
    lines.push(`crawl: last 7 days ${fmtInt(last7.reduce((s, r) => s + r.crawledPages, 0))} pages crawled, ${fmtInt(last7.reduce((s, r) => s + r.crawlErrors, 0))} crawl errors; latest snapshot ${latest.date}: in index ${fmtInt(latest.inIndex)}, 4xx ${fmtInt(latest.code4xx)}, 5xx ${fmtInt(latest.code5xx)}, blocked by robots.txt ${fmtInt(latest.blockedByRobotsTxt)}, malware ${fmtInt(latest.containsMalware)}`);
  } else lines.push('crawl: no crawl stats returned (new or unverified site?)');
  if (issues.length) lines.push(`crawl issues: ${issues.length} URL(s): ${[...byIssue].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (issuesNote) lines.push(`note: ${issuesNote}`);
  return { name: 'crawl', files, summary: { latest, last7: { crawledPages: last7.reduce((s, r) => s + r.crawledPages, 0), crawlErrors: last7.reduce((s, r) => s + r.crawlErrors, 0) }, issues: issues.length, issueCounts: Object.fromEntries(byIssue) }, lines };
}

/** Read a paged list (page = 0..TotalPages-1, capped at maxPages). */
async function paged(api, method, params, listKey, maxPages) {
  const items = [];
  let total = null;
  for (let page = 0; page < maxPages; page++) {
    const d = await api.call(method, { ...params, page });
    const list = d && Array.isArray(d[listKey]) ? d[listKey] : [];
    items.push(...list);
    total = d && Number.isFinite(Number(d.TotalPages)) ? Number(d.TotalPages) : total;
    if (!list.length || total === null || page + 1 >= total) break;
  }
  return { items, totalPages: total, truncated: total !== null && total > maxPages };
}

async function exportLinks(api, ws, flags, ctx) {
  const counts = await paged(api, 'GetLinkCounts', {}, 'Links', Math.max(1, flags.maxPages));
  const linkCounts = counts.items.map((l) => ({ url: l.Url || '', count: num(l.Count) })).filter((l) => l.url).sort((a, b) => b.count - a.count);
  const links = [];
  const notes = [];
  if (counts.truncated) notes.push(`GetLinkCounts has ${counts.totalPages} pages; read ${flags.maxPages} (--max-pages).`);
  let failedTargets = 0;
  for (const target of linkCounts.slice(0, Math.max(0, flags.maxTargets))) {
    let det;
    try {
      det = await paged(api, 'GetUrlLinks', { link: target.url }, 'Details', Math.max(1, flags.maxPages));
    } catch (e) {
      // one bad target must not cost the whole export; a bad key or blocked account stops everything
      if (!(e instanceof UserError) || ['InvalidApiKey', 'UserBlocked', 'NotAuthorized'].includes(e.bingError) || /network error|timeout/.test(e.message)) throw e;
      failedTargets++;
      notes.push(`${target.url}: linking pages skipped (${e.message.replace(/^Bing API GetUrlLinks: /, '')}).`);
      continue;
    }
    for (const l of det.items) if (l && l.Url) links.push({ target: target.url, source: l.Url, anchor: String(l.AnchorText || '').replace(/\s+/g, ' ').trim() });
    if (det.truncated) notes.push(`${target.url}: ${det.totalPages} pages of linking URLs; read ${flags.maxPages}.`);
  }
  if (failedTargets) notes.unshift(`${failedTargets} target URL(s) failed in GetUrlLinks; the file has the others.`);
  if (linkCounts.length > flags.maxTargets) notes.push(`Linking pages fetched for the top ${flags.maxTargets} of ${linkCounts.length} URLs (--max-targets).`);
  // contract read by backlinks.mjs: exactly {meta: {siteUrl, fetchedAt, source}, linkCounts: [{url, count}], links: [{target, source, anchor}]}
  const meta = { siteUrl: ctx.meta.siteUrl, fetchedAt: ctx.meta.fetchedAt, source: 'bing-webmaster' };
  const files = [writeJson(ws.dataFile('bing', 'links', 'json'), { meta, linkCounts, links }), writeCsvFile(ws.dataFile('bing', 'links', 'csv'), links, ['target', 'source', 'anchor'])];
  const domains = new Set(links.map((l) => {
    try {
      return new URL(l.source).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }).filter(Boolean));
  const lines = linkCounts.length
    ? [`links: ${linkCounts.length} linked URL(s), ${fmtInt(linkCounts.reduce((s, l) => s + l.count, 0))} inbound links counted; ${links.length} linking page(s) from ${domains.size} domain(s) fetched for the top ${Math.min(flags.maxTargets, linkCounts.length)}`]
    : ['links: Bing returned no link counts (common for small or new sites; also check the Backlinks report in the Bing Webmaster UI).'];
  for (const n of notes.slice(0, 8)) lines.push(`note: ${n}`);
  if (notes.length > 8) lines.push(`note: ... ${notes.length - 8} more`);
  return { name: 'links', files, summary: { linkedUrls: linkCounts.length, links: links.length, domains: domains.size, top: linkCounts.slice(0, flags.top) }, lines };
}

async function exportKeywords(api, ws, flags, ctx) {
  const keywords = flags.keyword.map((k) => k.trim()).filter(Boolean);
  if (flags.keywordsFile) {
    const file = ws.resolveFile(flags.keywordsFile);
    if (!fs.existsSync(file)) throw new UserError(`Keywords file not found: ${file}`);
    keywords.push(...fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  }
  const list = [...new Set(keywords)];
  if (!list.length) throw new UserError('keywords needs --keyword (repeatable) or --keywords-file', { hint: 'Example: node scripts/bing-export.mjs keywords --keyword "pour over ratio" --country us --language en-US' });
  const { country, language } = keywordMarket(ws, flags);
  const end = addDays(ws.today(), -1);
  const start = addDays(end, -(flags.days - 1));
  const results = [];
  for (const q of list) {
    const params = { q, country, language };
    const stats = await api.call('GetKeywordStats', params, { siteParam: false });
    const window = await api.call('GetKeyword', { ...params, startDate: start, endDate: end }, { siteParam: false });
    let related = [];
    if (!flags.noRelated) {
      try {
        const r = await api.call('GetRelatedKeywords', { ...params, startDate: start, endDate: end }, { siteParam: false });
        related = (Array.isArray(r) ? r : []).map((x) => ({ query: x.Query || '', impressions: num(x.Impressions), broadImpressions: num(x.BroadImpressions) })).filter((x) => x.query).sort((a, b) => b.impressions - a.impressions);
      } catch (e) {
        if (e.bingError === 'InvalidApiKey') throw e;
        log(`  related keywords for "${q}" skipped: ${e.message}`);
      }
    }
    const weekly = (Array.isArray(stats) ? stats : []).map((x) => ({ date: x.Date || '', impressions: num(x.Impressions), broadImpressions: num(x.BroadImpressions) })).sort((a, b) => (a.date < b.date ? -1 : 1));
    results.push({ keyword: q, impressions: num(window && window.Impressions), broadImpressions: num(window && window.BroadImpressions), weekly, related });
  }
  const meta = { ...ctx.meta, methods: ['GetKeywordStats', 'GetKeyword', 'GetRelatedKeywords'], country, language, window: { start, end, days: flags.days }, note: 'Bing relative demand on Bing only (Impressions = strict match, BroadImpressions = broad match); not Google search volume.' };
  const rows = results.map((r) => ({ keyword: r.keyword, impressions: r.impressions, broad_impressions: r.broadImpressions, weeks: r.weekly.length, last_week: r.weekly.length ? r.weekly[r.weekly.length - 1].impressions : '', related_top: r.related.slice(0, 5).map((x) => x.query).join(' | '), related_count: r.related.length }));
  const files = [writeJson(ws.dataFile('bing', 'keywords', 'json'), { meta, keywords: results }), writeCsvFile(ws.dataFile('bing', 'keywords', 'csv'), rows)];
  const lines = [`keywords (${country}, ${language}, ${start} -> ${end}): Bing relative demand only, not Google volume`, textTable(['keyword', 'impr.', 'broad', 'related'], rows.map((r) => [r.keyword, fmtInt(r.impressions), fmtInt(r.broad_impressions), String(r.related_count)])).split('\n').map((l) => `  ${l}`).join('\n')];
  return { name: 'keywords', files, summary: { country, language, keywords: rows }, lines };
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help || !positionals.length) return void process.stdout.write(HELP);
  const cmd = positionals[0];
  if (!SUBCOMMANDS.includes(cmd)) throw new UserError(`Unknown subcommand "${cmd}"`, { hint: `Use one of: ${SUBCOMMANDS.join(', ')}` });
  if (flags.days < 1) throw new UserError('--days must be >= 1');
  flags.top = Math.max(0, flags.top);
  const ws = loadWorkspace(flags);
  const envName = (ws.config.bing && ws.config.bing.apiKeyEnv) || 'BING_WEBMASTER_API_KEY';
  const apiKey = process.env[envName];
  if (!apiKey) {
    throw new UserError(`$${envName} is not set`, {
      hint: ['Bing Webmaster Tools -> Settings -> API access -> API Key -> Generate API Key (add and verify the site first; Import from Google Search Console is fastest).', `export ${envName}=<key>  (keep it out of files and config.json)`],
    });
  }
  const siteUrl = siteOf(ws, flags);
  if (cmd === 'page-queries' && !flags.page) throw new UserError('page-queries needs --page <url>');
  const endpoint = process.env.SEO_AGENT_BING_ENDPOINT || BING_ENDPOINT;
  const api = bingClient({ apiKey, siteUrl, endpoint, ws, apiKeyEnv: envName, delayMs: Math.max(0, flags.delay), retryMs: flags.retryMs });
  const ctx = { meta: { siteUrl, fetchedAt: new Date().toISOString(), source: 'bing-webmaster' }, origin: (() => {
    try {
      return new URL(siteUrl).origin;
    } catch {
      return '';
    }
  })() };
  const jobs = {
    traffic: () => exportTraffic(api, ws, flags, ctx),
    queries: () => exportStats(api, ws, flags, ctx, { name: 'queries', method: 'GetQueryStats', keyName: 'query', label: 'top queries' }),
    pages: () => exportStats(api, ws, flags, ctx, { name: 'pages', method: 'GetPageStats', keyName: 'page', label: 'top pages' }),
    'page-queries': () => exportStats(api, ws, flags, ctx, { name: 'page-queries', method: 'GetPageQueryStats', keyName: 'query', params: { page: normalizeUrl(flags.page, { base: siteUrl, stripTracking: false }) || flags.page }, label: `queries for ${flags.page}` }),
    crawl: () => exportCrawl(api, ws, flags, ctx),
    links: () => exportLinks(api, ws, flags, ctx),
    keywords: () => exportKeywords(api, ws, flags, ctx),
  };
  const order = cmd === 'all' ? ['traffic', 'queries', 'pages', 'crawl', 'links'] : [cmd];
  const results = [];
  const failures = [];
  for (const name of order) {
    log(`Bing ${name} (${siteUrl})...`);
    try {
      results.push(await jobs[name]());
    } catch (e) {
      // a bad key or an unknown site fails every call: stop; other errors only skip this export in "all"
      if (cmd !== 'all' || !(e instanceof UserError) || ['InvalidApiKey', 'NotAuthorized', 'UserBlocked', 'InvalidUrl'].includes(e.bingError) || /network error|timeout/.test(e.message)) throw e;
      failures.push({ name, error: e.message, hint: e.hint });
      log(`  ${name} skipped: ${e.message}`);
    }
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ siteUrl, calls: api.calls(), results: results.map((r) => ({ name: r.name, files: r.files, summary: r.summary })), failures }, null, 2)}\n`);
    return failures.length && !results.length ? 1 : 0;
  }
  out(`Bing Webmaster ${siteUrl} (${api.calls()} API call(s))`);
  for (const r of results) for (const l of r.lines) out(l);
  for (const f of failures) out(`skipped ${f.name}: ${f.error}${f.hint ? ` (${[].concat(f.hint)[0]})` : ''}`);
  out('');
  for (const r of results) for (const f of r.files) out(`wrote ${f}`);
  return failures.length && !results.length ? 1 : 0;
}

runMain(import.meta.url, main);
