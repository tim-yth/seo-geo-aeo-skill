#!/usr/bin/env node
// Live SERP snapshots via the Brave Search API: top-N results per keyword, our rank, and which domains
// really compete across your keyword set.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, slugify, sleep, bareHost, hostOf } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { readCsvFile, writeCsvFile } from './lib/csv.mjs';
import { mdTable, shortUrl, fmtPct } from './lib/format.mjs';

// Tests may point this at a local mock with SEO_AGENT_BRAVE_ENDPOINT.
const DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const SPEC = {
  ...COMMON_FLAGS,
  keyword: { type: 'list', placeholder: 'kw', desc: 'Keyword to look up' },
  'from-keyword-map': { type: 'boolean', desc: 'Take keywords from keyword-map.csv (highest impressions first)' },
  'max-keywords': { type: 'int', desc: 'With --from-keyword-map: how many', default: 25 },
  status: { type: 'csv', desc: 'With --from-keyword-map: only rows with these status values' },
  top: { type: 'int', desc: 'Results per keyword (max 50)', default: 10 },
  country: { type: 'string', placeholder: 'cc', desc: 'Country code (default config serp.country, else ALL)' },
  lang: { type: 'string', desc: 'Brave search_lang, e.g. en, zh-hant, jp (default config serp.lang)' },
  delay: { type: 'int', placeholder: 'ms', desc: 'Gap between API calls (free plan allows about 1/second)', default: 1100 },
  json: { type: 'boolean', desc: 'Print the summary JSON' },
};

const HELP = formatHelp({
  usage: ['node scripts/serp-snapshot.mjs --keyword "pour over ratio" [--keyword ...] [--top 10]', 'node scripts/serp-snapshot.mjs --from-keyword-map --max-keywords 25'],
  summary:
    'Calls the Brave Web Search API for each keyword, stores the top-N results (rank, URL, domain, title, description) in ' +
    'data/serp/<today>-<keyword-slug>.json, marks where your site ranks, notes SERP features (FAQ, discussions, videos, news, infobox, ' +
    'local results) and summarizes which domains appear most across all keywords (data/serp/<today>-domains.csv, a Markdown report in ' +
    'logs/reviews/). Feed the files to competitor-snapshot.mjs --from-serp.',
  spec: SPEC,
  examples: ['node scripts/serp-snapshot.mjs --keyword "best burr grinder" --keyword "pour over ratio" --country US --lang en', 'node scripts/serp-snapshot.mjs --from-keyword-map --status new,tracked --top 20'],
  notes: [
    'Google SERP scraping is not supported: it violates Google\'s terms and gets blocked. Check Google itself manually (private window, phone and desktop) before decisions such as rollbacks.',
    'Brave runs its own independent index, so its positions approximate but do not equal Google\'s. If you also compare other engines, count Bing, Yahoo and DuckDuckGo as ONE source (they share the Bing index).',
    'API key: the env var named in config.serp.apiKeyEnv (default BRAVE_SEARCH_API_KEY). It is never printed or stored.',
  ],
});

/** Domain identity: host (incl. a non-default port) without www. */
const domainOf = (u) => {
  try {
    return bareHost(new URL(u).host);
  } catch {
    return bareHost(hostOf(u));
  }
};

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** File-name slug; always suffixed with a short hash so "ai 咖啡" / "AI 拿鐵" or "c++" / "c#" never collide. */
export function keywordSlug(keyword) {
  const hash = crypto.createHash('sha1').update(String(keyword).normalize('NFKC').trim().toLowerCase()).digest('hex');
  const s = slugify(keyword, 50);
  return s ? `${s}-${hash.slice(0, 6)}` : `kw-${hash.slice(0, 8)}`;
}

/** Normalize Brave responses (one or more pages) into ranked results; exported for tests. */
export function parseBrave(pages, { top, ourHost }) {
  const results = [];
  const features = { faq: false, discussions: false, videos: false, news: false, infobox: false, locations: false };
  for (const data of pages) {
    for (const k of Object.keys(features)) if (data[k] && (Array.isArray(data[k].results) ? data[k].results.length : true)) features[k] = true;
    for (const r of (data.web && data.web.results) || []) {
      if (results.length >= top) break;
      if (!r.url) continue;
      results.push({ rank: results.length + 1, url: r.url, domain: domainOf(r.url), title: stripTags(r.title), description: stripTags(r.description), age: r.page_age || r.age || '' });
    }
  }
  const mine = results.filter((r) => ourHost && r.domain === bareHost(ourHost));
  return { results, ours: { rank: mine.length ? mine[0].rank : null, urls: mine.map((r) => r.url) }, features };
}

/** Domain frequency across keyword snapshots; exported for tests. */
export function domainFrequency(snapshots, ourHost) {
  const map = new Map();
  for (const s of snapshots) {
    const seen = new Set();
    for (const r of s.results) {
      const d = map.get(r.domain) || { domain: r.domain, keywords: 0, ranks: [], urls: [] };
      if (!seen.has(r.domain)) {
        d.keywords++;
        d.ranks.push(r.rank);
        seen.add(r.domain);
      }
      if (d.urls.length < 3 && !d.urls.includes(r.url)) d.urls.push(r.url);
      map.set(r.domain, d);
    }
  }
  return [...map.values()]
    .map((d) => ({ domain: d.domain, ours: d.domain === bareHost(ourHost || ''), keywords: d.keywords, share: snapshots.length ? d.keywords / snapshots.length : 0, avgRank: d.ranks.reduce((a, b) => a + b, 0) / d.ranks.length, bestRank: Math.min(...d.ranks), sampleUrls: d.urls }))
    .sort((a, b) => b.keywords - a.keywords || a.avgRank - b.avgRank);
}

async function braveSearch(endpoint, key, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(`${endpoint}?${new URLSearchParams(params)}`, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      if (attempt < 3) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new UserError(`Brave API unreachable (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
    }
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    if (res.status === 429 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const detail = (() => {
      try {
        const j = JSON.parse(body);
        return (j.error && (j.error.detail || j.error.code)) || '';
      } catch {
        return '';
      }
    })();
    const hint = res.status === 401 || res.status === 403
      ? ['The API key was rejected or your plan does not include Web Search. Check the key at https://api-dashboard.search.brave.com/ and the env var name in config.serp.apiKeyEnv.']
      : res.status === 422
        ? ['Invalid parameters: country must be a 2-letter code (or ALL), search_lang a Brave language code (en, zh-hant, zh-hans, jp, ko, ...).']
        : res.status === 429
          ? ['Rate limited: raise --delay or upgrade the plan; monthly quota may be exhausted.']
          : [];
    throw new UserError(`Brave API HTTP ${res.status}${detail ? `: ${detail}` : ''}`, { hint });
  }
  throw new UserError('Brave API failed after retries');
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const serp = ws.config.serp || {};
  if (serp.provider && serp.provider !== 'brave') throw new UserError(`serp.provider "${serp.provider}" is not supported (only brave)`);
  const envName = serp.apiKeyEnv || 'BRAVE_SEARCH_API_KEY';
  const key = process.env[envName];
  if (!key) {
    throw new UserError(`$${envName} is not set`, {
      hint: ['Create an account at https://api-dashboard.search.brave.com/ and subscribe to a Search plan (a free tier exists).', 'API Keys -> Add API key.', `export ${envName}=<key>  (keep it out of files and config.json)`],
    });
  }
  let keywords = [...flags.keyword];
  if (flags.fromKeywordMap) {
    const file = ws.path('keyword-map.csv');
    if (!fs.existsSync(file)) throw new UserError('keyword-map.csv not found in the workspace');
    const rows = readCsvFile(file).records.filter((r) => r.keyword && (!flags.status.length || flags.status.includes(r.status)));
    rows.sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0));
    keywords.push(...rows.slice(0, flags.maxKeywords).map((r) => r.keyword));
  }
  keywords = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  if (!keywords.length) throw new UserError('No keywords: pass --keyword (repeatable) or --from-keyword-map');
  const top = Math.min(Math.max(flags.top, 1), 50);
  const country = (flags.country || serp.country || 'ALL').toUpperCase();
  const lang = flags.lang || serp.lang || '';
  const endpoint = process.env.SEO_AGENT_BRAVE_ENDPOINT || DEFAULT_ENDPOINT;
  const ourHost = domainOf(ws.siteUrl());
  const snapshots = [];
  const files = [];
  for (const [i, kw] of keywords.entries()) {
    const pages = [];
    for (let offset = 0; offset * 20 < top && offset <= 9; offset++) {
      if (i || offset) await sleep(flags.delay);
      const params = { q: kw, count: String(Math.min(20, top)), offset: String(offset), country, safesearch: 'moderate' };
      if (lang) params.search_lang = lang;
      const data = await braveSearch(endpoint, key, params);
      pages.push(data);
      const got = ((data.web && data.web.results) || []).length;
      if (got < Math.min(20, top)) break;
    }
    const parsed = parseBrave(pages, { top, ourHost });
    const snap = { meta: { keyword: kw, provider: 'brave', country, lang, top, fetchedAt: new Date().toISOString() }, ...parsed };
    snapshots.push(snap);
    files.push(writeJson(ws.dataFile('serp', keywordSlug(kw), 'json'), snap));
    log(`  ${kw}: ${parsed.results.length} results; ours ${parsed.ours.rank ? `#${parsed.ours.rank}` : 'not in top ' + top}`);
  }
  const domains = domainFrequency(snapshots, ourHost);
  const domainsCsv = writeCsvFile(ws.dataFile('serp', 'domains', 'csv'), domains.map((d) => ({ domain: d.domain, ours: d.ours ? 'yes' : '', keywords: d.keywords, share_of_keywords: d.share.toFixed(3), avg_rank: d.avgRank.toFixed(1), best_rank: d.bestRank, sample_urls: d.sampleUrls.join(' | ') })));
  const summary = { meta: { provider: 'brave', country, lang, top, keywords: keywords.length, fetchedAt: new Date().toISOString() }, keywords: snapshots.map((s, i) => ({ keyword: s.meta.keyword, file: files[i], ourRank: s.ours.rank, ourUrls: s.ours.urls, features: s.features })), domains };
  const summaryPath = writeJson(ws.dataFile('serp', 'serp-summary', 'json'), summary);
  const L = [`# SERP snapshot (Brave, ${country}${lang ? `, ${lang}` : ''}, top ${top}) - ${ws.today()}`, '', '_Brave has an independent index: positions approximate Google, they do not equal it. Check Google manually before decisions._', ''];
  L.push('## Our positions', '', mdTable([{ label: 'Keyword', value: (s) => s.meta.keyword }, { label: 'Our rank', align: 'right', value: (s) => s.ours.rank || '-' }, { label: 'Our URL', value: (s) => (s.ours.urls[0] ? shortUrl(s.ours.urls[0]) : '') }, { label: 'Top result', value: (s) => (s.results[0] ? `${s.results[0].domain}` : '') }, { label: 'SERP features', value: (s) => Object.entries(s.features).filter(([, v]) => v).map(([k]) => k).join(', ') }], snapshots));
  L.push('## Domains competing across the keyword set', '', mdTable([{ label: 'Domain', value: (d) => `${d.domain}${d.ours ? ' (us)' : ''}` }, { label: 'Keywords', align: 'right', key: 'keywords' }, { label: 'Share', align: 'right', value: (d) => fmtPct(d.share, 0) }, { label: 'Avg rank', align: 'right', value: (d) => d.avgRank.toFixed(1) }, { label: 'Best', align: 'right', key: 'bestRank' }], domains.slice(0, 25)));
  const absent = snapshots.filter((s) => !s.ours.rank).map((s) => s.meta.keyword);
  if (absent.length) L.push(`## Not in our top ${top}`, '', ...absent.map((k) => `- ${k}`), '');
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-serp-snapshot.md`), L.join('\n'));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  out(`${snapshots.length} keyword(s) on Brave (${country}${lang ? `/${lang}` : ''}); we rank in the top ${top} for ${snapshots.length - absent.length}.`);
  out(`Top competing domains: ${domains.filter((d) => !d.ours).slice(0, 5).map((d) => `${d.domain} (${d.keywords})`).join(', ') || '-'}`);
  out(`\nwrote ${md}\nwrote ${summaryPath}\nwrote ${domainsCsv}`);
  for (const f of files) out(`wrote ${f}`);
  return 0;
}

runMain(import.meta.url, main);
