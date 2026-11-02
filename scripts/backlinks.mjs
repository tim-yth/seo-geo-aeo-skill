#!/usr/bin/env node
// Backlinks: import Bing Webmaster, SEO-tool and Search Console Links exports into one table (anchor classes, referring domains,
// new/lost domains), re-check live outreach links monthly (writes back only link_checked_on/link_status/rel), and reclaim links to broken URLs.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeText, readJson, normalizeUrl, hostOf, bareHost, sameSite, mapLimit, rateLimiter, scriptCmd } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { readCsvFile, writeCsvFile, csvToRecords, findColumn } from './lib/csv.mjs';
import { fetchPage, fetchRobots, robotsAllows, collectSitemapUrls, discoverSitemaps, parseSitemap, isHtml, DEFAULT_UA } from './lib/http.mjs';
import { parseHtml, robotsTokens } from './lib/html.mjs';
import { compactKey, normalizeText } from './lib/text.mjs';
import { mdTable, fmtInt, fmtPct, shortUrl, textTable } from './lib/format.mjs';
import { notConfiguredMessage, PROVIDERS } from './lib/providers.mjs';
import { matchUrls, isHomeUrl, isHstsHop } from './lib/url-match.mjs';

export const BACKLINK_COLUMNS = ['source_url', 'source_domain', 'target_url', 'anchor', 'anchor_class', 'rel', 'first_seen', 'last_seen', 'sources'];
export const DOMAIN_COLUMNS = ['domain', 'links', 'targets', 'sample_anchors', 'first_seen', 'sources'];
export const LINK_STATUSES = ['live', 'removed', 'nofollow', 'page-noindex', 'page-404', 'page-error', 'redirected'];
/** Labels used in references/12 and the outreach tracking table (--labels zh). */
export const ZH_LABELS = { live: '仍在', removed: '已移除', nofollow: '改成 nofollow', 'page-noindex': '頁面 noindex', 'page-404': '頁面 404', 'page-error': '頁面錯誤', redirected: '頁面已轉址' };
const SOURCES = ['ahrefs', 'semrush', 'majestic', 'moz', 'gsc', 'bing', 'other'];

const SPEC = {
  ...COMMON_FLAGS,
  csv: { type: 'list', placeholder: 'file', desc: 'import: backlink export CSV (Ahrefs, Semrush, Majestic, Moz, Search Console Links, others)' },
  source: { type: 'list', placeholder: 'name', choices: SOURCES, desc: 'import: source of the matching --csv (same order; default: detected from the headers)' },
  bing: { type: 'string', placeholder: 'file', desc: 'import: bing-export links JSON/CSV (default: newest data/bing/*-links.json)' },
  'no-bing': { type: 'boolean', desc: 'import: do not read Bing Webmaster data' },
  provider: { type: 'string', placeholder: 'name', desc: 'import: paid API (dataforseo, ahrefs, semrush): not built in, prints how to export a CSV instead' },
  tracking: { type: 'string', placeholder: 'csv', desc: 'verify: outreach tracking table (default <workspace>/outreach-tracking.csv when present)' },
  'from-backlinks': { type: 'boolean', desc: 'verify: also check one link per referring domain from the newest backlinks.csv' },
  top: { type: 'int', desc: 'verify --from-backlinks: number of referring domains (most links first)', default: 20 },
  labels: { type: 'string', choices: ['auto', 'en', 'zh'], default: 'auto', desc: 'verify: link_status values written to the tracking table: en codes, the zh-TW labels of references/12, or auto (the labels already used in the table, else zh when site.language is zh-*)' },
  'dry-run': { type: 'boolean', desc: 'verify: do not modify the tracking table' },
  sitemap: { type: 'list', placeholder: 'url|file', desc: 'reclaim: live URLs of your site (default: newest crawl pages.csv, else your sitemap)' },
  limit: { type: 'int', desc: 'reclaim: max linked URLs of yours to check', default: 300 },
  concurrency: { type: 'int', desc: 'Parallel requests', default: 2 },
  delay: { type: 'int', placeholder: 'ms', desc: 'Gap between requests to the same host', default: 1500 },
  timeout: { type: 'int', placeholder: 'ms', desc: 'Per-request timeout', default: 20000 },
  json: { type: 'boolean', desc: 'Print the summary as JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/backlinks.mjs import [--csv export.csv --source ahrefs ...] [--bing data/bing/<date>-links.json | --no-bing]',
    'node scripts/backlinks.mjs verify [--tracking outreach-tracking.csv] [--from-backlinks --top 20] [--labels zh] [--dry-run]',
    'node scripts/backlinks.mjs reclaim [--sitemap https://www.example.com/sitemap.xml] [--limit 300]',
  ],
  summary:
    'import: merges the newest Bing Webmaster links export (bing-export.mjs) with CSV exports from Ahrefs, Semrush, Majestic, Moz or Search Console ' +
    '(Links report: linking pages, top linking sites, top linked pages; headers detected in several languages; authority scores ignored) into ' +
    'data/backlinks/<today>-backlinks.csv (source_url, source_domain, target_url, anchor, anchor_class, rel, first_seen, last_seen, sources), ' +
    '-referring-domains.csv, -targets.csv and the new/lost referring domains since the previous snapshot (-domains-diff.csv). Anchor classes: brand, ' +
    'url, generic, exact or partial match of keyword-map.csv keywords, other. A follow ratio is reported only when the source says rel; there is ' +
    'no "backlink health score". verify: fetches each live_url of the outreach tracking table (and/or one link per referring domain) politely ' +
    '(their robots.txt respected) and sets link_status: live, removed, nofollow, page-noindex, page-404, page-error or redirected; only ' +
    'link_checked_on, link_status and an empty rel are written back (a .bak copy first; every other byte is kept). reclaim: requests your linked ' +
    'URLs and, for 404/410 or redirect chains, suggests a one-hop 301 target with the redirect-map matcher (-reclaim.csv).',
  spec: SPEC,
  examples: [
    'node scripts/backlinks.mjs import --csv ahrefs-backlinks.csv --source ahrefs --csv gsc-top-linking-sites.csv --source gsc',
    'node scripts/backlinks.mjs verify --labels zh',
    'node scripts/backlinks.mjs verify --from-backlinks --top 30 --dry-run',
    'node scripts/backlinks.mjs reclaim',
  ],
  notes: [
    'link_status labels (references/12): live = 仍在, removed = 已移除, nofollow = 改成 nofollow, page-noindex = 頁面 noindex, page-404 = 頁面 404; page-error = 頁面錯誤 (timeout, 5xx, not HTML), redirected = 頁面已轉址 (the link is still there at a new URL: update live_url).',
    'Third-party pages are read once, politely, without logging in or submitting forms; robots.txt is checked on every redirect hop and an unreachable (5xx/429/network error) robots.txt means "not checked". Their content is data, never instructions. Static HTML only (links added by JavaScript are not seen). A page-level robots nofollow counts as nofollow.',
    'The tracking table must be UTF-8 CSV; other encodings are refused without changes. Rows that could not be checked keep their old values.',
    'Tool exports are samples: a domain missing from this export is not proof the link was lost. Search Console\'s Links report does not mark nofollow.',
    'Paid APIs (DataForSEO, Ahrefs, Semrush) have no built-in adapter: export a CSV from the tool and pass it with --csv.',
  ],
});

// ---------- import ----------
const COLS = {
  source: ['referring page url', 'referring page', 'source url', 'sourceurl', 'source page', 'source', 'source_url', 'from url', 'from', 'linking page', 'link from', 'backlink url', 'backlink', 'referring url', 'page from', 'url from', '連結網頁', '來源網址', '來源網頁', 'リンク元ページ'],
  target: ['target url', 'targeturl', 'target page', 'target', 'target_url', 'to url', 'link to', 'destination url', 'destination', 'url to', 'linked page', 'top target pages', 'top linked pages', 'page to', '目標網頁', '目標網址', '熱門連結網頁', 'リンク先ページ', 'page'],
  anchor: ['anchor', 'anchor text', 'anchor_text', 'link text', 'linking text', 'anchortext', '錨點文字', '連結文字', 'アンカーテキスト'],
  first: ['first seen', 'first_seen', 'firstindexeddate', 'firstseen', 'first indexed', 'first found', 'date found', 'discovered', 'found date', 'first crawled'],
  last: ['last seen', 'last_seen', 'lastseendate', 'lastseen', 'last crawled', 'last checked', 'last check', '上次檢索'],
  domain: ['site', 'linking site', 'domain', 'referring domain', 'source domain', 'top linking sites', '熱門連結網站', '連結網站', 'ドメイン'],
  links: ['incoming links', 'links', 'linking pages', 'backlinks', 'external links', 'external_links', '外部連結', '連入連結', '連結網頁數'],
  domains: ['linking sites', 'referring domains', 'referring_domains', 'domains', '連結網站數'],
  rel: ['rel', 'link rel', 'link type', 'link attributes', 'attributes', 'type'],
};

/** Source tool guessed from export headers. */
export function detectSource(headers) {
  const h = headers.map((x) => String(x).toLowerCase().trim());
  const has = (re) => h.some((x) => re.test(x));
  if (has(/^referring page (url|title)$/) || has(/^domain rating$|^url rating$|^dr$|^ur$/)) return 'ahrefs';
  if (has(/^page ascore$|^source title$/)) return 'semrush';
  if (has(/flagnofollow|trustflow|citationflow/)) return 'majestic';
  if (has(/^(domain|page) authority$|^spam score$/)) return 'moz';
  if (has(/^linking pages?$|^top linking sites$|^top linked pages$|^linking text$|^incoming links$|^linking sites$|^target pages$|^連結網站|^熱門連結/)) return 'gsc';
  return 'other';
}

const truthy = (v) => /^(1|true|yes|y|x|nofollow|ugc|sponsored)$/i.test(String(v || '').trim());

/** rel from a row: separate nofollow/ugc/sponsored flag columns, a dofollow column, or a rel/link-type column. '' = unknown. */
export function relFromRow(r, headers) {
  const flagCols = ['nofollow', 'ugc', 'sponsored'].map((t) => [t, findColumn(headers, [t, `is ${t}`, `flag${t}`, `${t} link`])]).filter(([, c]) => c);
  if (flagCols.length) {
    const tokens = flagCols.filter(([, c]) => truthy(r[c])).map(([t]) => t);
    return tokens.length ? tokens.join(' ') : 'follow';
  }
  const doCol = findColumn(headers, ['dofollow', 'follow', 'is dofollow']);
  if (doCol && String(r[doCol] || '').trim()) return truthy(r[doCol]) || /^dofollow$/i.test(r[doCol]) ? 'follow' : 'nofollow';
  const relCol = findColumn(headers, COLS.rel);
  const v = relCol ? String(r[relCol] || '').toLowerCase() : '';
  if (!v.trim()) return '';
  const tokens = ['nofollow', 'ugc', 'sponsored'].filter((t) => v.includes(t));
  if (tokens.length) return tokens.join(' ');
  return /dofollow|follow|^text$|^href$/.test(v) ? 'follow' : '';
}

const dateOf = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s.slice(0, 20);
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const cleanText = (s, max = 300) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Rows from one CSV export. Returns {links: [{source_url, target_url, anchor, rel, first_seen, last_seen, source}], domains:
 * [{domain, links, source}], targets: [{target_url, external_links, referring_domains, source}], kind, skipped}.
 */
export function parseBacklinkCsv(text, { source = '' } = {}) {
  const { headers, records } = csvToRecords(text);
  const src = source || detectSource(headers);
  const col = (k) => findColumn(headers, COLS[k]);
  const sCol = col('source');
  const tCol = col('target');
  const res = { links: [], domains: [], targets: [], kind: '', source: src, skipped: 0 };
  if (sCol) {
    res.kind = 'links';
    const aCol = col('anchor');
    const fCol = col('first');
    const lCol = col('last');
    for (const r of records) {
      if (!/^https?:\/\//i.test(String(r[sCol] || '').trim())) {
        res.skipped++;
        continue;
      }
      res.links.push({ source_url: r[sCol].trim(), target_url: tCol ? String(r[tCol] || '').trim() : '', anchor: aCol ? cleanText(r[aCol]) : '', rel: relFromRow(r, headers), first_seen: fCol ? dateOf(r[fCol]) : '', last_seen: lCol ? dateOf(r[lCol]) : '', source: src });
    }
    return res;
  }
  const dCol = col('domain');
  const linksCol = col('links');
  const domainsCol = col('domains');
  if (dCol && !tCol) {
    res.kind = 'domains';
    for (const r of records) {
      const d = bareHost(String(r[dCol] || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
      if (d) res.domains.push({ domain: d, links: Number(String(r[linksCol] || '').replace(/[,\s]/g, '')) || 0, source: src });
    }
    return res;
  }
  if (tCol) {
    res.kind = 'targets';
    for (const r of records) {
      const t = String(r[tCol] || '').trim();
      if (/^https?:\/\//i.test(t)) res.targets.push({ target_url: t, external_links: Number(String(r[linksCol] || '').replace(/[,\s]/g, '')) || 0, referring_domains: Number(String(r[domainsCol] || '').replace(/[,\s]/g, '')) || 0, source: src });
    }
    return res;
  }
  res.kind = findColumn(headers, ['linking text', 'top linking text', 'anchor']) ? 'anchors-only' : 'unknown';
  return res;
}

/** Bing contract {meta, linkCounts:[{url,count}], links:[{target,source,anchor}]} or the -links.csv (target,source,anchor). */
export function parseBingLinks(file) {
  if (/\.json$/i.test(file)) {
    const data = readJson(file);
    if (!data || (!Array.isArray(data.links) && !Array.isArray(data.linkCounts))) throw new UserError(`${file}: not a bing-export links file (expected {meta, linkCounts, links})`);
    const fetched = data.meta && data.meta.fetchedAt ? dateOf(data.meta.fetchedAt) : '';
    return {
      links: (data.links || []).filter((l) => l && l.source).map((l) => ({ source_url: String(l.source), target_url: String(l.target || ''), anchor: cleanText(l.anchor), rel: '', first_seen: '', last_seen: fetched, source: 'bing' })),
      targets: (data.linkCounts || []).filter((l) => l && l.url).map((l) => ({ target_url: String(l.url), external_links: Number(l.count) || 0, referring_domains: 0, source: 'bing' })),
      domains: [],
    };
  }
  const { records } = readCsvFile(file);
  return { links: records.filter((r) => r.source).map((r) => ({ source_url: r.source, target_url: r.target || '', anchor: cleanText(r.anchor), rel: '', first_seen: '', last_seen: '', source: 'bing' })), targets: [], domains: [] };
}

const GENERIC_ANCHORS = new Set(['click here', 'here', 'this', 'this site', 'this website', 'this page', 'this article', 'this post', 'website', 'site', 'web site', 'link', 'read more', 'more', 'learn more', 'see more', 'source', 'visit', 'visit site', 'visit website', 'homepage', 'home page', 'home', 'go', 'details', 'more info', 'info', 'official site', 'official website', 'download', 'click', '點此', '點這裡', '點擊這裡', '這裡', '按此', '按這裡', '更多', '了解更多', '閱讀更多', '詳情', '網站', '官網', '連結', '來源', '此處', '点击这里', '这里', '更多信息', 'こちら', 'ここ', '詳細', 'aquí', 'hier', 'ici']);

/** brand | url | generic | exact | partial | other | empty. keywords from keyword-map.csv. */
export function anchorClass(anchor, { brandMatcher = () => false, keywords = [] } = {}) {
  const a = String(anchor || '').trim();
  if (!a) return 'empty';
  if (/^(https?:\/\/|www\.)\S+$/i.test(a) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(a)) return 'url';
  const norm = normalizeText(a);
  if (GENERIC_ANCHORS.has(norm)) return 'generic';
  if (brandMatcher(a)) return 'brand';
  const k = compactKey(a);
  const words = new Set(norm.split(' '));
  let partial = false;
  for (const kw of keywords) {
    const kk = compactKey(kw);
    if (kk.length < 2) continue;
    if (kk === k) return 'exact';
    const kwWords = normalizeText(kw).split(' ').filter(Boolean);
    if (k.includes(kk) || (kwWords.length > 1 && kwWords.every((w) => words.has(w)))) partial = true;
  }
  return partial ? 'partial' : 'other';
}

/** Merge raw link rows: one row per (source_url, target_url) on our site; returns {rows, dropped}. */
export function normalizeLinks(raw, { siteHost, origin = '', brandMatcher, keywords }) {
  const by = new Map();
  let foreign = 0;
  let internal = 0;
  for (const l of raw) {
    const src = normalizeUrl(l.source_url, { stripTracking: true });
    if (!src) continue;
    if (sameSite(src, siteHost, { includeSubdomains: true })) {
      internal++;
      continue;
    }
    const rawTarget = String(l.target_url || '').trim();
    const absTarget = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget) ? rawTarget : rawTarget.startsWith('/') && !rawTarget.startsWith('//') ? (origin ? new URL(rawTarget, origin).href : '') : `https://${rawTarget.replace(/^\/+/, '')}`;
    const tgt = rawTarget ? normalizeUrl(absTarget, { stripTracking: true }) : '';
    if (tgt === null) {
      foreign++;
      continue;
    }
    if (tgt && !sameSite(tgt, siteHost, { includeSubdomains: true })) {
      foreign++;
      continue;
    }
    const key = `${src}\t${tgt}`;
    const cur = by.get(key) || { source_url: src, source_domain: bareHost(hostOf(src)), target_url: tgt, anchor: '', rel: '', first_seen: '', last_seen: '', sources: new Set() };
    cur.sources.add(l.source);
    if (!cur.anchor && l.anchor) cur.anchor = l.anchor;
    if (!cur.rel && l.rel) cur.rel = l.rel;
    if (l.first_seen && (!cur.first_seen || l.first_seen < cur.first_seen)) cur.first_seen = l.first_seen;
    if (l.last_seen && l.last_seen > cur.last_seen) cur.last_seen = l.last_seen;
    by.set(key, cur);
  }
  const rows = [...by.values()].map((r) => ({ ...r, anchor_class: anchorClass(r.anchor, { brandMatcher, keywords }), sources: [...r.sources].sort().join('|') }));
  rows.sort((a, b) => String(a.source_domain).localeCompare(String(b.source_domain)) || a.source_url.localeCompare(b.source_url) || String(a.target_url).localeCompare(String(b.target_url)));
  return { rows, foreign, internal };
}

export function referringDomains(rows, domainRows = []) {
  const by = new Map();
  const get = (d) => {
    if (!by.has(d)) by.set(d, { domain: d, links: 0, targets: new Set(), anchors: new Map(), first_seen: '', sources: new Set(), reported: 0 });
    return by.get(d);
  };
  for (const r of rows) {
    const e = get(r.source_domain);
    e.links++;
    if (r.target_url) e.targets.add(r.target_url);
    if (r.anchor) e.anchors.set(r.anchor, (e.anchors.get(r.anchor) || 0) + 1);
    if (r.first_seen && (!e.first_seen || r.first_seen < e.first_seen)) e.first_seen = r.first_seen;
    for (const s of r.sources.split('|')) e.sources.add(s);
  }
  for (const d of domainRows) {
    const e = get(d.domain);
    e.reported = Math.max(e.reported, d.links || 0);
    e.sources.add(d.source);
  }
  return [...by.values()].map((e) => ({ domain: e.domain, links: Math.max(e.links, e.reported), targets: e.targets.size, sample_anchors: [...e.anchors].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a).join(' | '), first_seen: e.first_seen, sources: [...e.sources].sort().join('|') })).sort((a, b) => b.links - a.links || a.domain.localeCompare(b.domain));
}

export function targetTable(rows, targetRows, siteHost) {
  const by = new Map();
  const get = (u) => {
    if (!by.has(u)) by.set(u, { target_url: u, links: 0, domains: new Set(), reportedLinks: 0, reportedDomains: 0, sources: new Set() });
    return by.get(u);
  };
  for (const r of rows) {
    if (!r.target_url) continue;
    const e = get(r.target_url);
    e.links++;
    e.domains.add(r.source_domain);
    for (const s of r.sources.split('|')) e.sources.add(s);
  }
  for (const t of targetRows) {
    const u = normalizeUrl(t.target_url, { stripTracking: true });
    if (!u || !sameSite(u, siteHost, { includeSubdomains: true })) continue;
    const e = get(u);
    e.reportedLinks = Math.max(e.reportedLinks, t.external_links || 0);
    e.reportedDomains = Math.max(e.reportedDomains, t.referring_domains || 0);
    e.sources.add(t.source);
  }
  return [...by.values()].map((e) => ({ target_url: e.target_url, external_links: Math.max(e.links, e.reportedLinks), referring_domains: Math.max(e.domains.size, e.reportedDomains), sources: [...e.sources].sort().join('|') })).sort((a, b) => b.referring_domains - a.referring_domains || b.external_links - a.external_links || a.target_url.localeCompare(b.target_url));
}

function readKeywords(ws) {
  const f = ws.path('keyword-map.csv');
  if (!fs.existsSync(f)) return [];
  return readCsvFile(f).records.map((r) => String(r.keyword || '').trim()).filter(Boolean);
}

async function cmdImport(ws, flags) {
  if (flags.provider) throw notConfiguredMessage(String(flags.provider).toLowerCase(), { script: 'backlinks.mjs' });
  const siteHost = ws.host();
  const raw = [];
  const domainRows = [];
  const targetRows = [];
  const inputs = [];
  if (!flags.noBing) {
    const bingFile = flags.bing ? path.resolve(flags.bing) : ws.listData('bing', /-links\.json$/)[0] || ws.listData('bing', /-links\.csv$/)[0];
    if (flags.bing && !fs.existsSync(bingFile)) throw new UserError(`--bing file not found: ${flags.bing}`);
    if (bingFile) {
      const b = parseBingLinks(bingFile);
      raw.push(...b.links);
      targetRows.push(...b.targets);
      inputs.push({ file: path.basename(bingFile), source: 'bing', kind: 'links', rows: b.links.length + b.targets.length });
    }
  }
  flags.csv.forEach((f, i) => {
    const file = path.resolve(f);
    if (!fs.existsSync(file)) throw new UserError(`--csv file not found: ${f}`);
    const parsed = parseBacklinkCsv(fs.readFileSync(file, 'utf8'), { source: flags.source[i] || '' });
    if (parsed.kind === 'unknown' || parsed.kind === 'anchors-only') log(`${path.basename(file)}: ${parsed.kind === 'anchors-only' ? 'anchor-text-only export (no linking pages): skipped' : 'no linking-page, site or target column found: skipped'}`);
    raw.push(...parsed.links);
    domainRows.push(...parsed.domains);
    targetRows.push(...parsed.targets);
    inputs.push({ file: path.basename(file), source: parsed.source, kind: parsed.kind, rows: parsed.links.length + parsed.domains.length + parsed.targets.length });
  });
  if (!inputs.length) {
    throw new UserError('No backlink data to import', {
      hint: [`Export Bing Webmaster links: ${scriptCmd('bing-export.mjs')} (then rerun), or`, 'pass a CSV export: --csv ahrefs.csv --source ahrefs (Search Console: Links -> External links -> Export).', 'Paid APIs are not built in (--provider prints how to export instead).'],
    });
  }
  const brandMatcher = ws.brandMatcher();
  const keywords = readKeywords(ws);
  const { rows, foreign, internal } = normalizeLinks(raw, { siteHost, origin: ws.origin(), brandMatcher, keywords });
  const domains = referringDomains(rows, domainRows.filter((d) => !sameSite(`https://${d.domain}/`, siteHost, { includeSubdomains: true })));
  const targets = targetTable(rows, targetRows, siteHost);
  const today = ws.today();
  const prevFile = ws.listData('backlinks', /-referring-domains\.csv$/).find((f) => path.basename(f).slice(0, 10) < today);
  let diff = null;
  if (prevFile) {
    const prev = new Map(readCsvFile(prevFile).records.map((r) => [r.domain, Number(r.links) || 0]));
    const now = new Map(domains.map((d) => [d.domain, d.links]));
    diff = [...[...now].filter(([d]) => !prev.has(d)).map(([d, n]) => ({ domain: d, change: 'new', links_before: 0, links_now: n })), ...[...prev].filter(([d]) => !now.has(d)).map(([d, n]) => ({ domain: d, change: 'lost', links_before: n, links_now: 0 }))];
  }
  const written = [];
  written.push(writeCsvFile(ws.dataFile('backlinks', 'backlinks', 'csv'), rows, BACKLINK_COLUMNS));
  written.push(writeCsvFile(ws.dataFile('backlinks', 'referring-domains', 'csv'), domains, DOMAIN_COLUMNS));
  written.push(writeCsvFile(ws.dataFile('backlinks', 'targets', 'csv'), targets, ['target_url', 'external_links', 'referring_domains', 'sources']));
  if (diff) written.push(writeCsvFile(ws.dataFile('backlinks', 'domains-diff', 'csv'), diff, ['domain', 'change', 'links_before', 'links_now']));
  const classes = {};
  for (const r of rows) classes[r.anchor_class] = (classes[r.anchor_class] || 0) + 1;
  const withRel = rows.filter((r) => r.rel);
  const followed = withRel.filter((r) => r.rel === 'follow').length;
  const summary = { links: rows.length, referringDomains: domains.length, targets: targets.length, inputs, anchorClasses: classes, follow: withRel.length ? { known: withRel.length, followed, ratio: followed / withRel.length } : null, droppedForeignTargets: foreign, droppedInternal: internal, previous: prevFile ? path.basename(prevFile) : '', newDomains: diff ? diff.filter((d) => d.change === 'new').length : null, lostDomains: diff ? diff.filter((d) => d.change === 'lost').length : null };
  const md = renderImportReport(ws, summary, { domains, targets, diff });
  const mdPath = writeText(ws.path('logs', 'reviews', `${today}-backlinks.md`), md);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, files: [mdPath, ...written] }, null, 2)}\n`);
    return 0;
  }
  out(`Imported ${fmtInt(rows.length)} link(s) from ${fmtInt(domains.length)} referring domain(s) to ${fmtInt(targets.length)} page(s) (${inputs.map((x) => `${x.source}: ${x.kind}`).join(', ')}).`);
  out(`Anchors: ${Object.entries(classes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '-'}${summary.follow ? `; follow ratio ${fmtPct(summary.follow.ratio)} of ${summary.follow.known} links with a known rel` : '; rel unknown in these sources'}.`);
  if (diff) out(`Since ${summary.previous.slice(0, 10)}: ${summary.newDomains} new and ${summary.lostDomains} lost referring domain(s) (exports are samples: "lost" may just be unsampled).`);
  if (foreign) out(`Skipped ${foreign} link(s) to other sites.`);
  out('');
  for (const f of [mdPath, ...written]) out(`wrote ${f}`);
  return 0;
}

function renderImportReport(ws, s, { domains, targets, diff }) {
  const L = [`# Backlinks - ${ws.today()}`, ''];
  L.push(`- Sources: ${s.inputs.map((x) => `${x.file} (${x.source}, ${x.kind}, ${fmtInt(x.rows)} rows)`).join('; ')}`);
  L.push(`- ${fmtInt(s.links)} links from ${fmtInt(s.referringDomains)} referring domains to ${fmtInt(s.targets)} pages. Exports are samples (Search Console tables stop at 1,000 rows and do not mark nofollow).`);
  L.push(s.follow ? `- Follow ratio: ${fmtPct(s.follow.ratio)} of ${fmtInt(s.follow.known)} links whose source reports rel.` : '- Follow ratio: not reported (no source in this import says rel; check single links with verify).');
  if (s.previous) L.push(`- Since ${s.previous.slice(0, 10)}: ${s.newDomains} new, ${s.lostDomains} lost referring domains.`);
  L.push('', '## Anchor classes', '');
  L.push(mdTable([{ label: 'Class', key: 'k' }, { label: 'Links', key: 'n', align: 'right' }, { label: 'Share', align: 'right', value: (r) => fmtPct(r.n / (s.links || 1)) }], Object.entries(s.anchorClasses).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }))));
  L.push('_Classes describe the profile; there is no target mix and no "health score". Never buy or ask for exact-match anchors (Google spam policies)._', '');
  L.push('## Top referring domains', '');
  L.push(mdTable([{ label: 'Domain', key: 'domain' }, { label: 'Links', key: 'links', align: 'right' }, { label: 'Pages', key: 'targets', align: 'right' }, { label: 'Sample anchors', key: 'sample_anchors' }, { label: 'First seen', key: 'first_seen' }], domains.slice(0, 25)));
  L.push('## Most linked pages', '');
  L.push(mdTable([{ label: 'Page', value: (r) => shortUrl(r.target_url, ws.origin()) }, { label: 'Links', key: 'external_links', align: 'right' }, { label: 'Domains', key: 'referring_domains', align: 'right' }], targets.slice(0, 25)));
  if (diff && diff.length) {
    L.push('## New and lost referring domains', '');
    L.push(mdTable([{ label: 'Domain', key: 'domain' }, { label: 'Change', key: 'change' }, { label: 'Links before', key: 'links_before', align: 'right' }, { label: 'Links now', key: 'links_now', align: 'right' }], diff.slice(0, 50)));
  }
  L.push(`Next: ${scriptCmd('backlinks.mjs')} reclaim (links to broken pages) and verify (monthly check of outreach links).`);
  return `${L.join('\n')}\n`;
}

// ---------- tracking CSV editing (byte-preserving) ----------
/** Tokenize CSV keeping raw offsets: [{cells:[{start, end, value}], end}] where end is the offset before the line break. */
export function tokenizeCsv(text) {
  const rows = [];
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const cells = [];
    for (;;) {
      const start = i;
      let value = '';
      if (text[i] === '"') {
        i++;
        for (;;) {
          if (i >= n) break;
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          value += text[i++];
        }
        while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') value += text[i++];
      } else {
        while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') value += text[i++];
      }
      cells.push({ start, end: i, value });
      if (text[i] === ',') {
        i++;
        continue;
      }
      break;
    }
    const end = i;
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else if (text[i] === '\n' || text[i] === '\r') i++;
    rows.push({ cells, end });
  }
  return rows;
}

const encodeCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Apply edits [{row, col, value}] to the raw text; everything else stays byte-identical. Missing trailing cells are appended. */
export function applyCsvEdits(text, rows, edits) {
  const byRow = new Map();
  for (const e of edits) {
    if (!byRow.has(e.row)) byRow.set(e.row, new Map());
    byRow.get(e.row).set(e.col, e.value);
  }
  const ops = [];
  for (const [ri, cols] of byRow) {
    const row = rows[ri];
    let maxMissing = -1;
    for (const [c, v] of cols) {
      const cell = row.cells[c];
      if (cell) ops.push({ at: cell.start, end: cell.end, text: encodeCell(v) });
      else maxMissing = Math.max(maxMissing, c);
    }
    if (maxMissing >= 0) {
      let s = '';
      for (let c = row.cells.length; c <= maxMissing; c++) s += `,${cols.has(c) ? encodeCell(cols.get(c)) : ''}`;
      ops.push({ at: row.end, end: row.end, text: s, append: true });
    }
  }
  // applied from the end; at one offset the append goes first so it stays to the right of an edited last cell
  ops.sort((a, b) => b.at - a.at || Number(Boolean(b.append)) - Number(Boolean(a.append)));
  let outText = text;
  for (const op of ops) outText = outText.slice(0, op.at) + op.text + outText.slice(op.end);
  return outText;
}

/** Header row index (the first row with a live_url cell; rows above it are summaries) and column positions. */
export function trackingLayout(rows) {
  const norm = (v) => String(v || '').replace(/^\uFEFF/, '').trim().toLowerCase();
  const headerRow = rows.findIndex((r) => r.cells.some((c) => norm(c.value) === 'live_url'));
  if (headerRow < 0) return null;
  const cols = {};
  rows[headerRow].cells.forEach((c, i) => {
    const k = norm(c.value);
    if (k && cols[k] === undefined) cols[k] = i;
  });
  return { headerRow, cols };
}

// ---------- verify ----------
const looseKey = (u) => {
  try {
    const x = new URL(u);
    return `${bareHost(x.hostname)}${x.pathname.replace(/\/+$/, '').toLowerCase() || '/'}${x.search}`;
  } catch {
    return String(u || '');
  }
};

const isFollowed = (rel) => /^(followed|follow|dofollow)$/i.test(String(rel || '').trim());

/**
 * Judge a fetched third-party page. Returns {status, rel, linkFound, targetFound, noindex, redirected, finalUrl, httpStatus, detail}.
 * previousRel: the rel recorded earlier ("followed" -> now nofollow = status nofollow; unknown or already nofollow = live).
 */
export function judgeLinkPage(res, { ourHost, targetPage = '', liveUrl = '', previousRel = '' }) {
  const base = { rel: '', linkFound: false, targetFound: false, noindex: false, redirected: res.chain && res.chain.length > 0 && looseKey(res.finalUrl) !== looseKey(liveUrl), finalUrl: res.finalUrl || '', httpStatus: res.status || 0 };
  if (res.error) return { ...base, status: 'page-error', detail: res.error };
  if (res.status === 404 || res.status === 410) return { ...base, status: 'page-404', detail: `HTTP ${res.status}` };
  if (res.status !== 200) return { ...base, status: 'page-error', detail: `HTTP ${res.status}` };
  if (!isHtml(res)) return { ...base, status: 'page-error', detail: `not HTML (${res.headers['content-type'] || 'no content-type'})` };
  const p = parseHtml(res.body || '', res.finalUrl);
  const xr = robotsTokens(res.headers['x-robots-tag']);
  const noindex = p.robotsNoindex || xr.includes('noindex') || xr.includes('none');
  const pageNofollow = p.robotsNofollow || xr.includes('nofollow') || xr.includes('none');
  const ours = p.links.filter((l) => l.url && sameSite(l.url, ourHost, { includeSubdomains: true }));
  if (!ours.length) return { ...base, noindex, status: 'removed', detail: `no link to ${ourHost}` };
  const targeted = targetPage ? ours.filter((l) => looseKey(l.url) === looseKey(targetPage)) : [];
  const considered = targeted.length ? targeted : ours;
  const followed = !pageNofollow && considered.some((l) => !l.nofollow);
  const linkRel = [...new Set(considered.flatMap((l) => l.rel.split(/\s+/)).filter((t) => ['nofollow', 'ugc', 'sponsored'].includes(t)))].join(' ');
  const relTokens = followed ? 'followed' : linkRel || 'nofollow';
  const details = [];
  if (pageNofollow) details.push('the page sets robots nofollow for all its links');
  if (targetPage && !targeted.length) details.push(`target_page not linked; links to ${ours[0].url}`);
  let status = 'live';
  if (noindex) status = 'page-noindex';
  else if (!followed && isFollowed(previousRel)) status = 'nofollow';
  else if (base.redirected) status = 'redirected';
  if (base.redirected) details.push(`page moved to ${res.finalUrl}`);
  if (!followed && status !== 'nofollow') details.push(`link is ${relTokens}`);
  return { ...base, noindex, linkFound: true, targetFound: targeted.length > 0, rel: relTokens, status, detail: details.join('; ') };
}

/**
 * GET a third-party page, following redirects by hand so robots.txt is checked on every host (unreachable, 5xx or 429
 * robots.txt = do not fetch, RFC 9309) and requests to one host are spaced. Returns {res} or {skipped: reason}.
 */
export async function politeFetch(url, { robotsFor, waitFor, timeout = 20000, maxHops = 5 }) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      return { res: { url, finalUrl: current, status: 0, chain, headers: {}, body: null, error: 'invalid URL' } };
    }
    const robots = await robotsFor(u.origin);
    if (robots.unreachable) return { skipped: `robots.txt of ${u.host} is unreachable (${robots.unreachable}): not checked` };
    if (robots.robots && !robotsAllows(robots.robots, DEFAULT_UA, u.pathname + u.search)) return { skipped: `robots.txt of ${u.host} disallows this page for our user agent: not checked` };
    await waitFor(u.host);
    const res = await fetchPage(current, { timeoutMs: timeout, maxBytes: 5 * 1024 * 1024, followRedirects: false });
    if (res.error) return { res: { ...res, url, finalUrl: current, chain } };
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      let next;
      try {
        next = new URL(res.headers.location, current).href;
      } catch {
        return { res: { ...res, url, finalUrl: current, chain, error: 'invalid redirect location' } };
      }
      chain.push({ url: current, status: res.status, location: next });
      if (chain.some((c) => c.url === next)) return { res: { url, finalUrl: next, status: res.status, chain, headers: res.headers, body: null, error: 'redirect loop' } };
      current = next;
      continue;
    }
    return { res: { ...res, url, finalUrl: current, chain } };
  }
  return { res: { url, finalUrl: current, status: 0, chain, headers: {}, body: null, error: `more than ${maxHops} redirects` } };
}

async function checkLinks(items, { ourHost, delay, concurrency, timeout }) {
  const robotsCache = new Map();
  const limiters = new Map();
  const robotsFor = (origin) => {
    if (!robotsCache.has(origin)) {
      robotsCache.set(origin, fetchRobots(origin, { timeoutMs: timeout }).then((r) => ({ robots: r.robots, unreachable: r.error ? r.error : r.status >= 500 || r.status === 429 ? `HTTP ${r.status}` : '' })));
    }
    return robotsCache.get(origin);
  };
  const waitFor = (host) => {
    if (!limiters.has(host)) limiters.set(host, rateLimiter(delay));
    return limiters.get(host)();
  };
  return mapLimit(items, concurrency, async (item) => {
    const got = await politeFetch(item.liveUrl, { robotsFor, waitFor, timeout });
    if (got.skipped) return { ...item, skipped: got.skipped };
    return { ...item, result: judgeLinkPage(got.res, { ourHost, targetPage: item.targetPage, liveUrl: item.liveUrl, previousRel: item.previousRel }) };
  });
}

async function cmdVerify(ws, flags) {
  const ourHost = ws.host();
  const today = ws.today();
  const items = [];
  let tracking = null;
  const trackingFile = flags.tracking ? path.resolve(flags.tracking) : fs.existsSync(ws.path('outreach-tracking.csv')) ? ws.path('outreach-tracking.csv') : '';
  if (flags.tracking && !fs.existsSync(trackingFile)) throw new UserError(`Tracking table not found: ${flags.tracking}`);
  if (trackingFile) {
    const raw = fs.readFileSync(trackingFile);
    const text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) throw new UserError(`${path.basename(trackingFile)} is not UTF-8 text`, { hint: ['Save the table as "CSV UTF-8" (spreadsheets in some locales save Big5/Shift-JIS by default), then run again.', 'Nothing was changed.'] });
    const rows = tokenizeCsv(text);
    const layout = trackingLayout(rows);
    if (!layout) throw new UserError(`${path.basename(trackingFile)}: no live_url column`, { hint: ['Use the columns of the tracking table in templates/outreach-emails.md (追蹤表欄位).', 'Save it as comma-separated UTF-8 CSV (spreadsheets in some locales export ";"-separated files).'] });
    const missing = ['link_checked_on', 'link_status'].filter((c) => layout.cols[c] === undefined);
    tracking = { file: trackingFile, text, rows, layout, missing };
    const cell = (r, name) => (layout.cols[name] === undefined ? '' : String((r.cells[layout.cols[name]] || {}).value || '').trim());
    rows.forEach((r, idx) => {
      if (idx <= layout.headerRow) return;
      const live = cell(r, 'live_url');
      if (!/^https?:\/\//i.test(live)) return;
      items.push({ origin: 'tracking', row: idx, id: cell(r, 'id'), liveUrl: live, targetPage: cell(r, 'target_page'), previousRel: cell(r, 'rel') });
    });
    const existing = rows.filter((r, idx) => idx > layout.headerRow).map((r) => cell(r, 'link_status')).filter(Boolean);
    tracking.zhLabels = existing.some((v) => Object.values(ZH_LABELS).includes(v)) ? true : existing.some((v) => LINK_STATUSES.includes(v)) ? false : null;
  }
  if (flags.fromBacklinks) {
    const bl = ws.listData('backlinks', /-backlinks\.csv$/)[0];
    if (!bl) throw new UserError('No backlinks.csv yet', { hint: `Run ${scriptCmd('backlinks.mjs')} import first.` });
    const byDomain = new Map();
    for (const r of readCsvFile(bl).records) {
      if (!r.source_url) continue;
      if (!byDomain.has(r.source_domain)) byDomain.set(r.source_domain, []);
      byDomain.get(r.source_domain).push(r);
    }
    const domains = [...byDomain].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, flags.top);
    for (const [, links] of domains) {
      const pick = links.find((l) => l.rel === 'follow') || links.find((l) => l.anchor) || links[0];
      items.push({ origin: 'backlinks', row: -1, id: '', liveUrl: pick.source_url, targetPage: pick.target_url, previousRel: pick.rel });
    }
  }
  if (!items.length) {
    throw new UserError(trackingFile ? `${path.basename(trackingFile)} has no live_url values to check` : 'Nothing to verify', {
      hint: ['Pass --tracking <outreach-tracking.csv> (columns from templates/outreach-emails.md) or keep it at <workspace>/outreach-tracking.csv,', `and/or --from-backlinks after ${scriptCmd('backlinks.mjs')} import.`],
    });
  }
  log(`Checking ${items.length} linking page(s) (robots.txt respected, ${flags.delay}ms between requests to one host)...`);
  const checked = await checkLinks(items, { ourHost, delay: flags.delay, concurrency: flags.concurrency, timeout: flags.timeout });
  const useZh = flags.labels === 'zh' || (flags.labels === 'auto' && (tracking && tracking.zhLabels !== null ? tracking.zhLabels : /^zh/i.test(ws.config.site.language || '')));
  const label = (s) => (useZh ? ZH_LABELS[s] || s : s);
  const verifyRows = checked.map((c) => ({
    id: c.id, origin: c.origin, live_url: c.liveUrl, target_page: c.targetPage, final_url: c.result ? c.result.finalUrl : '', http_status: c.result ? c.result.httpStatus : '', link_found: c.result ? (c.result.linkFound ? 'yes' : 'no') : '', target_found: c.result && c.targetPage ? (c.result.targetFound ? 'yes' : 'no') : '', rel: c.result ? c.result.rel : '',
    noindex: c.result ? (c.result.noindex ? 'yes' : 'no') : '', link_status: c.result ? c.result.status : 'not-checked', label_zh: c.result ? ZH_LABELS[c.result.status] : '', detail: c.result ? c.result.detail : c.skipped, checked_on: today,
  }));
  const verifyFile = writeCsvFile(ws.dataFile('backlinks', 'verify', 'csv'), verifyRows, ['id', 'origin', 'live_url', 'target_page', 'final_url', 'http_status', 'link_found', 'target_found', 'rel', 'noindex', 'link_status', 'label_zh', 'detail', 'checked_on']);
  const written = [verifyFile];
  let updated = 0;
  if (tracking) {
    const edits = [];
    for (const c of checked) {
      if (c.origin !== 'tracking' || !c.result) continue;
      const { cols } = tracking.layout;
      if (tracking.missing.length) continue;
      edits.push({ row: c.row, col: cols.link_checked_on, value: today }, { row: c.row, col: cols.link_status, value: label(c.result.status) });
      if (cols.rel !== undefined && !c.previousRel && c.result.rel) edits.push({ row: c.row, col: cols.rel, value: c.result.rel });
      updated++;
    }
    if (tracking.missing.length) log(`${path.basename(tracking.file)} has no ${tracking.missing.join(' / ')} column: results are only in ${path.basename(verifyFile)}. Add the column(s) from templates/outreach-emails.md to get write-back.`);
    else if (edits.length && !flags.dryRun) {
      fs.copyFileSync(tracking.file, `${tracking.file}.bak`);
      const tmp = `${tracking.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, applyCsvEdits(tracking.text, tracking.rows, edits));
      fs.renameSync(tmp, tracking.file);
      written.push(tracking.file, `${tracking.file}.bak`);
    }
  }
  const counts = {};
  for (const r of verifyRows) counts[r.link_status] = (counts[r.link_status] || 0) + 1;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ checked: verifyRows.length, counts, updated: flags.dryRun ? 0 : updated, rows: verifyRows, files: written }, null, 2)}\n`);
    return 0;
  }
  out(`Checked ${verifyRows.length} link(s): ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  const problems = verifyRows.filter((r) => !['live'].includes(r.link_status));
  if (problems.length) out(textTable(['live_url', 'status', 'detail'], problems.slice(0, 20).map((r) => [shortUrl(r.live_url), r.link_status, String(r.detail || '').slice(0, 90)])));
  if (tracking && !tracking.missing.length) out(flags.dryRun ? `Dry run: ${path.basename(tracking.file)} not modified.` : `Updated link_checked_on/link_status for ${updated} row(s) in ${path.basename(tracking.file)} (backup: ${path.basename(tracking.file)}.bak).`);
  out('');
  for (const f of written) out(`wrote ${f}`);
  return 0;
}

// ---------- reclaim ----------
async function liveUrlsOfSite(ws, flags) {
  if (flags.sitemap.length) {
    const urls = [];
    for (const v of flags.sitemap) {
      if (/^https?:\/\//i.test(v)) urls.push(...(await collectSitemapUrls([v], { maxSitemaps: 200, maxUrls: 200000 })).urls.map((u) => ({ url: u.loc })));
      else {
        if (!fs.existsSync(path.resolve(v))) throw new UserError(`--sitemap file not found: ${v}`);
        const text = fs.readFileSync(path.resolve(v), 'utf8');
        if (/\.csv$/i.test(v)) {
          const { headers, records } = csvToRecords(text);
          const col = findColumn(headers, ['url', 'loc', 'address']);
          urls.push(...records.filter((r) => (!r.status || r.status === '200') && (!r.indexable || r.indexable === 'yes')).map((r) => ({ url: r[col], title: r.title || '', h1: (r.h1 || '').split(' | ')[0] })));
        } else {
          const parsed = parseSitemap(text);
          urls.push(...(parsed.type === 'unknown' ? text.split(/\r?\n/).filter((l) => /^https?:\/\//.test(l.trim())).map((l) => ({ url: l.trim() })) : parsed.entries.map((e) => ({ url: e.loc }))));
        }
      }
    }
    return { urls, source: flags.sitemap.join(', ') };
  }
  const pages = ws.listData('crawl', /-pages\.csv$/)[0];
  if (pages) {
    const { records } = readCsvFile(pages);
    return { urls: records.filter((r) => r.status === '200' && r.indexable === 'yes').map((r) => ({ url: r.url, title: r.title || '', h1: (r.h1 || '').split(' | ')[0] })), source: path.basename(pages) };
  }
  const origin = ws.origin();
  const robots = await fetchRobots(origin, { timeoutMs: flags.timeout });
  const sms = await discoverSitemaps(origin, robots.robots, { timeoutMs: flags.timeout });
  if (!sms.length) throw new UserError('No list of live URLs for suggestions', { hint: [`Run ${scriptCmd('crawl-site.mjs')} first, or pass --sitemap <url|file>.`] });
  return { urls: (await collectSitemapUrls(sms, { maxSitemaps: 200, maxUrls: 200000 })).urls.map((u) => ({ url: u.loc })), source: sms.join(', ') };
}

async function cmdReclaim(ws, flags) {
  const bl = ws.listData('backlinks', /-backlinks\.csv$/)[0];
  const tg = ws.listData('backlinks', /-targets\.csv$/)[0];
  if (!bl && !tg) throw new UserError('No imported backlinks yet', { hint: [`Run ${scriptCmd('backlinks.mjs')} import first (Bing export and/or --csv exports).`] });
  const siteHost = ws.host();
  const linkRows = bl ? readCsvFile(bl).records : [];
  const targets = new Map();
  if (tg) for (const r of readCsvFile(tg).records) targets.set(r.target_url, { links: Number(r.external_links) || 0, domains: Number(r.referring_domains) || 0, anchors: new Map() });
  const perTarget = new Map();
  for (const r of linkRows) {
    if (!r.target_url) continue;
    const p = perTarget.get(r.target_url) || { links: 0, domains: new Set(), anchors: new Map() };
    p.links++;
    p.domains.add(r.source_domain);
    if (r.anchor && !['generic', 'url', 'empty'].includes(r.anchor_class)) p.anchors.set(r.anchor, (p.anchors.get(r.anchor) || 0) + 1);
    perTarget.set(r.target_url, p);
  }
  for (const [u, p] of perTarget) {
    const e = targets.get(u) || { links: 0, domains: 0, anchors: new Map() };
    targets.set(u, { links: Math.max(e.links, p.links), domains: Math.max(e.domains, p.domains.size), anchors: p.anchors });
  }
  const list = [...targets].filter(([u]) => sameSite(u, siteHost, { includeSubdomains: true })).sort((a, b) => b[1].domains - a[1].domains || b[1].links - a[1].links).slice(0, flags.limit);
  if (!list.length) throw new UserError(`No linked URLs on ${siteHost} in the imported backlinks`);
  log(`Checking ${list.length} linked URL(s) on ${siteHost}...`);
  const wait = rateLimiter(Math.min(flags.delay, 300));
  const results = await mapLimit(list, Math.max(flags.concurrency, 4), async ([url, e]) => {
    await wait();
    const res = await fetchPage(url, { timeoutMs: flags.timeout, method: 'GET', maxBytes: 1024 * 1024 });
    return { url, e, res };
  });
  const broken = [];
  const rows = [];
  for (const { url, e, res } of results) {
    const hops = res.chain.length;
    const effectiveHops = hops === 2 && isHstsHop(res.chain[0]) ? 1 : hops;
    let status = '';
    if (res.error) status = res.error === 'redirect loop' ? 'redirect-loop' : 'error';
    else if (res.status === 404 || res.status === 410) status = String(res.status);
    else if (hops && res.status === 200 && !isHomeUrl(url) && isHomeUrl(res.finalUrl)) status = 'redirects-to-home';
    else if (effectiveHops >= 2 && res.status === 200) status = 'redirect-chain';
    else if (res.status >= 500) status = `${res.status}`;
    if (!status) continue;
    const anchors = [...e.anchors].sort((a, b) => b[1] - a[1]).map(([a]) => a);
    const row = { our_url: url, status, external_links: e.links, referring_domains: e.domains, suggested_target: '', match_method: '', confidence: '', hops, final_url: res.finalUrl, anchors: anchors.slice(0, 3).join(' | '), note: '' };
    if (status === 'redirect-chain') {
      row.suggested_target = res.finalUrl;
      row.match_method = 'final-url';
      row.confidence = 4;
      row.note = `${hops} hops: point ${shortUrl(url)} straight at the final page`;
    } else if (['404', '410', 'redirect-loop', 'redirects-to-home'].includes(status)) broken.push({ row, entry: { url, title: anchors[0] || '', h1: anchors[1] || '' } });
    else row.note = 'server error: fix the page itself';
    rows.push(row);
  }
  let liveSource = '';
  if (broken.length) {
    const live = await liveUrlsOfSite(ws, flags);
    liveSource = live.source;
    const brokenKeys = new Set(broken.map((b) => normalizeUrl(b.row.our_url)));
    const result = matchUrls(broken.map((b) => b.entry), live.urls.filter((u) => !brokenKeys.has(normalizeUrl(u.url))), { allowMany: true, ignoreTerms: ws.brandTerms() });
    const byOld = new Map(result.matches.map((m) => [m.old.url, m]));
    const unByOld = new Map(result.unmatched.map((u) => [u.old.url, u]));
    for (const b of broken) {
      const key = normalizeUrl(b.row.our_url, { stripTracking: true });
      const m = byOld.get(key);
      if (m) {
        b.row.suggested_target = m.new.url;
        b.row.match_method = m.method;
        b.row.confidence = m.confidence;
        b.row.note = `${b.row.status === 'redirects-to-home' ? 'the home page is a soft 404 for these links; ' : ''}301 in one hop; ${m.reason}`;
      } else {
        const u = unByOld.get(key);
        b.row.match_method = 'manual';
        b.row.note = `no close match: keep ${b.row.status === '410' ? '410' : '404'} or recreate the page; never the home page${u && u.parentHint ? `; parent section ${u.parentHint}` : ''}`;
      }
    }
  }
  rows.sort((a, b) => b.referring_domains - a.referring_domains || b.external_links - a.external_links || a.our_url.localeCompare(b.our_url));
  const file = writeCsvFile(ws.dataFile('backlinks', 'reclaim', 'csv'), rows, ['our_url', 'status', 'external_links', 'referring_domains', 'suggested_target', 'match_method', 'confidence', 'hops', 'final_url', 'anchors', 'note']);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ checked: list.length, problems: rows.length, liveSource, rows, file }, null, 2)}\n`);
    return 0;
  }
  out(`Checked ${list.length} linked URL(s): ${rows.filter((r) => /^(404|410|redirect-loop)$/.test(r.status)).length} broken, ${rows.filter((r) => r.status === 'redirect-chain').length} redirect chain(s), ${rows.filter((r) => r.status === 'redirects-to-home').length} redirected to the home page, ${rows.filter((r) => /^5|error/.test(r.status)).length} error(s).`);
  if (rows.length) out(textTable(['our URL', 'status', 'domains', 'suggested target', 'method'], rows.slice(0, 15).map((r) => [shortUrl(r.our_url), r.status, r.referring_domains, r.suggested_target ? shortUrl(r.suggested_target) : '-', r.match_method])));
  if (rows.length) out(`These are site changes: add the 301s in one hop, log them with ${scriptCmd('log-change.mjs')} add and add them to your redirect regression tests (references/12 step 3b).`);
  out('');
  out(`wrote ${file}`);
  return 0;
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const cmd = positionals[0] || 'import';
  if (!['import', 'verify', 'reclaim'].includes(cmd)) throw new UserError(`Unknown subcommand "${cmd}"`, { hint: 'Use import, verify or reclaim (see --help).' });
  if (flags.provider && !PROVIDERS[String(flags.provider).toLowerCase()]) throw new UserError(`Unknown provider "${flags.provider}"`, { hint: `Known optional data providers: ${Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].kind === 'data').join(', ')}. Export a CSV from your tool and use --csv instead.` });
  const ws = loadWorkspace(flags);
  if (cmd === 'verify') return cmdVerify(ws, flags);
  if (cmd === 'reclaim') return cmdReclaim(ws, flags);
  return cmdImport(ws, flags);
}

runMain(import.meta.url, main);
