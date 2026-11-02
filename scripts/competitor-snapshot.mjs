#!/usr/bin/env node
// Competitor page teardown: fetch competitor pages (sitemap sample, explicit URLs or SERP results), extract the
// same on-page features as for our page, and write a side-by-side comparison and a gap list.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, collectList, normalizeUrl, bareHost, hostOf, rateLimiter, mapLimit, slugify, readJson } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { fetchPage, fetchRobots, robotsAllows, discoverSitemaps, collectSitemapUrls, isHtml, DEFAULT_UA } from './lib/http.mjs';
import { parseHtml } from './lib/html.mjs';
import { topicTokens, buildCjkVocabulary, compactKey, textStats } from './lib/text.mjs';
import { readCsvFile, writeCsvFile } from './lib/csv.mjs';
import { mdTable, shortUrl, fmtInt, fmtPct } from './lib/format.mjs';

// Tests can point these at local mocks.
const RDAP_BASE = process.env.SEO_AGENT_RDAP_BASE || 'https://rdap.org/domain/';
const WAYBACK_BASE = process.env.SEO_AGENT_WAYBACK_BASE || 'https://archive.org/wayback/available';
const SOCIAL = /(^|\.)(facebook|fb|twitter|x|instagram|linkedin|pinterest|tiktok|youtube|youtu|line|threads|reddit|t)\.(com|me|be|co|net)$/i;
const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'PerplexityBot', 'ClaudeBot', 'Claude-SearchBot', 'Google-Extended'];

const SPEC = {
  ...COMMON_FLAGS,
  domain: { type: 'list', placeholder: 'domain', desc: 'Competitor domain (default: config competitors)' },
  match: { type: 'string', placeholder: 'regex', desc: 'Domain mode: only sitemap URLs matching this JS regex' },
  'max-per-domain': { type: 'int', desc: 'Domain mode: pages per domain (newest lastmod first)', default: 20 },
  urls: { type: 'csv', placeholder: 'url,...', desc: 'URL mode: competitor URLs (e.g. the top results for a keyword)' },
  'urls-file': { type: 'string', placeholder: 'file', desc: 'URL mode: competitor URLs, one per line' },
  'from-serp': { type: 'string', placeholder: 'file', desc: 'Use top URLs from a serp-snapshot keyword JSON or serp-summary JSON' },
  top: { type: 'int', desc: 'With --from-serp: how many results per keyword', default: 10 },
  keyword: { type: 'string', desc: 'Keyword the pages compete for (used for answer-first checks and to find our page in keyword-map.csv)' },
  ours: { type: 'string', placeholder: 'url', desc: 'Our page to compare against' },
  'ours-match': { type: 'string', placeholder: 'regex', desc: 'Domain mode: sample our own sitemap URLs matching this regex' },
  'domain-info': { type: 'boolean', desc: 'Look up RDAP registration date, Wayback first capture, llms.txt and AI-bot rules (default on in domain mode)' },
  'no-domain-info': { type: 'boolean', desc: 'Skip the domain lookups' },
  delay: { type: 'int', placeholder: 'ms', desc: 'Gap between requests to the same host', default: 1000 },
  concurrency: { type: 'int', desc: 'Hosts fetched in parallel', default: 2 },
  timeout: { type: 'int', placeholder: 'ms', desc: 'Per-request timeout', default: 20000 },
  'user-agent': { type: 'string', placeholder: 'ua', desc: 'User-Agent (robots.txt rules are matched against it)', default: DEFAULT_UA },
  label: { type: 'string', desc: 'Output label' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/competitor-snapshot.mjs [--domain rival.com] [--match "/blog/"] [--ours-match "/blog/"]',
    'node scripts/competitor-snapshot.mjs --keyword "pour over ratio" --urls u1,u2,u3 [--ours https://www.example.com/guide/]',
    'node scripts/competitor-snapshot.mjs --from-serp .seo-agent/data/serp/<date>-pour-over-ratio.json',
  ],
  summary:
    'Fetches competitor pages politely (their robots.txt is respected; disallowed URLs are skipped and reported) and extracts the same fields ' +
    'for them and for our page: title, description, H1-H3, length (CJK aware), answer-first intro, FAQ, tables, lists, TOC, author, ' +
    'breadcrumbs, schema types, tools/interactive elements, video, outbound citations and freshness signals. Writes a side-by-side table and ' +
    'a gap list (features most competitors have and we lack, missing subtopics from their headings, depth, freshness, citations). Domain ' +
    'mode adds section aggregates and domain facts (RDAP registration, Wayback first capture, llms.txt, AI-bot rules).',
  spec: SPEC,
  examples: [
    'node scripts/competitor-snapshot.mjs --match "/guides?/" --ours-match "^/guides/"',
    'node scripts/competitor-snapshot.mjs --keyword "best burr grinder" --urls-file top10.txt --ours https://www.example.com/blog/best-grinders/',
  ],
  notes: [
    'Only crawl what you need (default 20 pages per domain, 1 request/second per host). Static HTML only: JS-rendered content is not seen.',
    'Domain registration, first archive capture, publication, first indexing and ranking gains are five different events; do not mix them up.',
  ],
});

/** Site identity: host incl. port, without www. */
const siteKey = (u) => {
  try {
    return bareHost(new URL(u).host);
  } catch {
    return bareHost(u);
  }
};

const median = (xs) => {
  const a = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const QUESTION = /[?？]\s*$|^(how|what|why|when|which|who|can|does|is|are|should|如何|怎麼|怎么|什麼|什么|為什麼|为什么|哪|是否|能不能)/i;
const FAQ_HEADING = /(faq|frequently asked|common questions|常見問題|常见问题|q\s*&\s*a|問與答|よくある質問|자주 묻는)/i;
const TOOL_WORDS = /(calculator|converter|generator|quiz|checker|tool|estimator|planner|計算|換算|產生器|生成器|測驗|测验|檢查|工具|試算)/i;

/** Feature extraction for one fetched page; exported for tests. */
export function pageFeatures(res, html, { keyword = '', sitemapLastmod = '' } = {}) {
  const p = parseHtml(html || '', res.finalUrl || res.url);
  const host = siteKey(res.finalUrl || res.url);
  const firstPara = (p.contentBlocks.find((b) => b.type === 'p' && b.text.length > 20) || {}).text || p.contentParagraphs[0] || '';
  const firstStats = textStats(firstPara);
  const tokens = topicTokens(`${keyword} ${p.title}`.trim());
  const firstKey = compactKey(firstPara);
  const contentHeadings = p.contentHeadings;
  const externalLinks = p.links.filter((l) => l.url && siteKey(l.url) !== host && !l.boiler);
  const citations = externalLinks.filter((l) => !SOCIAL.test(hostOf(l.url))).length;
  const videos = p.counts.videos + p.iframes.filter((s) => /youtube|youtu\.be|vimeo|wistia|loom/i.test(s)).length;
  const interactive = (p.counts.forms > 0 && p.counts.inputs > 0) || p.counts.selects > 0 || p.counts.canvases > 0 || /<input[^>]+type=["']?(range|number)/i.test(html || '') || contentHeadings.some((h) => TOOL_WORDS.test(h.text));
  const questionHeadings = contentHeadings.filter((h) => h.level >= 2 && QUESTION.test(h.text.trim())).length;
  const modified = p.dates.modified || p.dates.published || p.times[0] || res.headers?.['last-modified'] || sitemapLastmod || '';
  return {
    url: res.url,
    finalUrl: res.finalUrl,
    status: res.status,
    domain: host,
    title: p.title,
    titleLength: [...p.title].length,
    description: p.metaDescription,
    h1: p.h1.join(' | '),
    h2: contentHeadings.filter((h) => h.level === 2).map((h) => h.text),
    h3: contentHeadings.filter((h) => h.level === 3).map((h) => h.text),
    wordEq: p.stats.wordEq,
    cjkChars: p.stats.cjkChars,
    latinWords: p.stats.latinWords,
    firstParagraphWordEq: firstStats.wordEq,
    answerFirst: Boolean(firstPara) && firstStats.wordEq <= 60 && tokens.some((t) => firstKey.includes(compactKey(t))),
    faq: p.jsonLdTypes.includes('FAQPage') || p.counts.details >= 2 || questionHeadings >= 3 || contentHeadings.some((h) => FAQ_HEADING.test(h.text)),
    tables: p.counts.tables,
    lists: p.counts.lists > 0 && p.counts.listItems >= 3,
    images: p.images.length,
    videos,
    interactive,
    schemaTypes: p.jsonLdTypes,
    author: p.hasAuthorMarkup || /\b(by|written by|author)\b\s+[A-Z]|作者|撰文/.test(p.text.slice(0, 600)),
    toc: p.tocLinks >= 3,
    breadcrumb: p.jsonLdTypes.includes('BreadcrumbList') || /aria-label=["']breadcrumb/i.test(html || ''),
    internalLinks: p.links.filter((l) => l.url && siteKey(l.url) === host).length,
    externalLinks: externalLinks.length,
    citations,
    modified,
    lang: p.lang,
    jsRendered: p.stats.wordEq < 50 && /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(html || ''),
  };
}

const BOOL_FEATURES = [
  ['answerFirst', 'Short direct answer in the first paragraph'],
  ['faq', 'FAQ block / question headings'],
  ['tables', 'Comparison or data table'],
  ['lists', 'Lists (steps, specs)'],
  ['toc', 'Table of contents'],
  ['author', 'Named author'],
  ['breadcrumb', 'Breadcrumbs'],
  ['interactive', 'Tool / calculator / interactive element'],
  ['videos', 'Video'],
  ['dated', 'Visible publish/update date'],
];

/** Gap list: what most competitors have that our page lacks; exported for tests. */
export function gapList(ours, competitors, { now = Date.now() } = {}) {
  const gaps = [];
  if (!ours || !competitors.length) return gaps;
  const has = (p, k) => (k === 'tables' || k === 'videos' ? p[k] > 0 : k === 'dated' ? Boolean(p.modified) : Boolean(p[k]));
  for (const [k, label] of BOOL_FEATURES) {
    const share = competitors.filter((c) => has(c, k)).length / competitors.length;
    if (share >= 0.5 && !has(ours, k)) gaps.push({ type: 'feature', item: label, detail: `${Math.round(share * 100)}% of competitors have it` });
  }
  const typeCount = new Map();
  for (const c of competitors) for (const t of new Set(c.schemaTypes)) typeCount.set(t, (typeCount.get(t) || 0) + 1);
  for (const [t, n] of typeCount) if (n / competitors.length >= 0.5 && !ours.schemaTypes.includes(t)) gaps.push({ type: 'schema', item: t, detail: `${n}/${competitors.length} competitors use ${t}` });
  const medWords = median(competitors.map((c) => c.wordEq));
  if (medWords && ours.wordEq < 0.7 * medWords) gaps.push({ type: 'depth', item: 'Content depth', detail: `ours ${ours.wordEq} word-equivalents vs competitor median ${Math.round(medWords)}` });
  const medH2 = median(competitors.map((c) => c.h2.length));
  if (medH2 !== null && ours.h2.length < medH2 - 2) gaps.push({ type: 'structure', item: 'Sections (H2)', detail: `ours ${ours.h2.length} vs median ${medH2}` });
  const heads = competitors.map((c) => [...c.h2, ...c.h3]);
  const vocab = buildCjkVocabulary(heads.flat(), { minDf: 2 });
  const tokenDocs = new Map();
  const examples = new Map();
  heads.forEach((list) => {
    const seen = new Set();
    for (const h of list) {
      for (const t of topicTokens(h, { vocab })) {
        if (t.length < 2 || seen.has(t)) continue;
        seen.add(t);
        tokenDocs.set(t, (tokenDocs.get(t) || 0) + 1);
        if (!examples.has(t)) examples.set(t, h);
      }
    }
  });
  const ourText = compactKey([ours.title, ours.h1, ...ours.h2, ...ours.h3, ours.description, ours.text || ''].join(' '));
  const minDocs = Math.max(2, Math.ceil(competitors.length * 0.4));
  const missing = [...tokenDocs].filter(([t, n]) => n >= minDocs && !ourText.includes(compactKey(t))).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [t, n] of missing) gaps.push({ type: 'subtopic', item: t, detail: `in ${n} competitors' headings, e.g. "${examples.get(t)}"` });
  const fresh = (p) => p.modified && Number.isFinite(Date.parse(p.modified)) && now - Date.parse(p.modified) < 180 * 86400000;
  if (competitors.filter(fresh).length / competitors.length >= 0.5 && !fresh(ours)) gaps.push({ type: 'freshness', item: 'Recent update', detail: `most competitors were updated in the last 180 days; ours: ${ours.modified || 'no date'}` });
  const medCit = median(competitors.map((c) => c.citations));
  if (medCit !== null && medCit >= 3 && ours.citations === 0) gaps.push({ type: 'citations', item: 'Outbound citations', detail: `competitor median ${medCit}, ours 0` });
  return gaps;
}

async function domainInfo(target, fetchOpts) {
  const origin = /^https?:\/\//.test(target) ? new URL(target).origin : `https://${target}`;
  const domain = bareHost(new URL(origin).hostname);
  const info = { domain: siteKey(origin), registered: '', firstCapture: '', llmsTxt: false, aiBots: {} };
  try {
    const r = await fetch(`${RDAP_BASE}${encodeURIComponent(domain)}`, { headers: { accept: 'application/rdap+json, application/json' }, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const j = await r.json();
      const ev = (j.events || []).find((e) => /registration/i.test(e.eventAction));
      if (ev) info.registered = String(ev.eventDate).slice(0, 10);
    }
  } catch {
    /* optional */
  }
  try {
    const r = await fetch(`${WAYBACK_BASE}?url=${encodeURIComponent(domain)}&timestamp=19960101`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const j = await r.json();
      const ts = j.archived_snapshots && j.archived_snapshots.closest && j.archived_snapshots.closest.timestamp;
      if (ts) info.firstCapture = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    }
  } catch {
    /* optional */
  }
  const llms = await fetchPage(`${origin}/llms.txt`, { ...fetchOpts, maxBytes: 200000 });
  info.llmsTxt = llms.status === 200 && !/<html/i.test(String(llms.body || '').slice(0, 300));
  const robots = await fetchRobots(origin, fetchOpts);
  for (const b of AI_BOTS) info.aiBots[b] = robots.robots ? robotsAllows(robots.robots, b, '/') : true;
  return info;
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const ourHost = siteKey(ws.siteUrl());
  const fetchOpts = { userAgent: flags.userAgent, timeoutMs: flags.timeout };
  let keyword = flags.keyword || '';
  let oursUrl = flags.ours || '';
  let mode = 'urls';
  let targets = [];
  const domainSet = new Set();
  const lastmods = new Map();

  if (flags.fromSerp) {
    mode = 'serp';
    const data = readJson(path.resolve(flags.fromSerp));
    const snaps = data.results ? [data] : (data.keywords || []).map((k) => (k.file && fs.existsSync(k.file) ? readJson(k.file) : null)).filter(Boolean);
    if (!snaps.length) throw new UserError(`${flags.fromSerp} is not a serp-snapshot keyword or summary file`);
    if (!keyword && snaps.length === 1) keyword = snaps[0].meta.keyword;
    if (!oursUrl && snaps.length === 1 && snaps[0].ours && snaps[0].ours.urls[0]) oursUrl = snaps[0].ours.urls[0];
    for (const s of snaps) for (const r of s.results.slice(0, flags.top)) if (siteKey(r.url) !== ourHost) targets.push(r.url);
  } else if (flags.urls.length || flags.urlsFile) {
    targets = collectList(flags.urls, flags.urlsFile);
  } else {
    mode = 'domain';
    const domains = (flags.domain.length ? flags.domain : (ws.config.competitors || []).map((c) => c.domain)).map((d) => String(d).trim()).filter(Boolean);
    if (!domains.length) throw new UserError('No competitors: pass --domain, --urls, --from-serp or add config.competitors', { hint: 'init.mjs --competitor rival.com (repeatable)' });
    const match = flags.match ? new RegExp(flags.match) : null;
    for (const raw of domains) {
      let origin = /^https?:\/\//.test(raw) ? new URL(raw).origin : `https://${raw.replace(/\/.*$/, '')}`;
      const d = siteKey(origin);
      domainSet.add(origin);
      const home = await fetchPage(origin, fetchOpts);
      if (home.finalUrl) origin = new URL(home.finalUrl).origin;
      const robots = await fetchRobots(origin, fetchOpts);
      const maps = await discoverSitemaps(origin, robots.robots, fetchOpts);
      if (!maps.length) {
        log(`${d}: no sitemap found; using the home page only`);
        targets.push(origin + '/');
        continue;
      }
      const col = await collectSitemapUrls(maps, { fetchOpts, maxSitemaps: 15, maxUrls: 20000, filter: (u) => !match || match.test(u) });
      const picked = col.urls.sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || '')).slice(0, flags.maxPerDomain);
      for (const u of picked) {
        targets.push(u.loc);
        lastmods.set(u.loc, u.lastmod);
      }
      log(`${d}: ${col.urls.length} sitemap URLs${match ? ` matching ${flags.match}` : ''}; sampling ${picked.length}`);
    }
  }
  if (!oursUrl && keyword && fs.existsSync(ws.path('keyword-map.csv'))) {
    const row = readCsvFile(ws.path('keyword-map.csv')).records.find((r) => compactKey(r.keyword) === compactKey(keyword));
    if (row) oursUrl = row.target_url || row.current_url_ranking || '';
  }
  const ourTargets = [];
  if (oursUrl) ourTargets.push(/^https?:/i.test(oursUrl) ? oursUrl : new URL(oursUrl, ws.origin()).href);
  if (flags.oursMatch && mode === 'domain') {
    const re = new RegExp(flags.oursMatch);
    const robots = await fetchRobots(ws.origin(), fetchOpts);
    const maps = await discoverSitemaps(ws.origin(), robots.robots, fetchOpts);
    const col = maps.length ? await collectSitemapUrls(maps, { fetchOpts, maxUrls: 20000, filter: (u) => re.test(new URL(u).pathname) }) : { urls: [] };
    ourTargets.push(...col.urls.slice(0, flags.maxPerDomain).map((u) => u.loc));
  }
  targets = [...new Set(targets.map((u) => normalizeUrl(u) || u))].filter((u) => siteKey(u) !== ourHost);
  if (!targets.length) throw new UserError('No competitor URLs to fetch');

  // fetch, grouped per host for politeness
  const byHost = new Map();
  for (const u of [...targets, ...ourTargets]) {
    const h = new URL(u).host;
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(u);
  }
  const pages = [];
  const skipped = [];
  await mapLimit([...byHost.entries()], flags.concurrency, async ([host, list]) => {
    const origin = new URL(list[0]).origin;
    const robots = await fetchRobots(origin, fetchOpts);
    const wait = rateLimiter(flags.delay);
    for (const u of list) {
      const p = new URL(u);
      if (robots.robots && !robotsAllows(robots.robots, flags.userAgent, p.pathname + p.search)) {
        skipped.push({ url: u, reason: 'disallowed by robots.txt' });
        continue;
      }
      await wait();
      const res = await fetchPage(u, fetchOpts);
      if (res.error || res.status !== 200 || !isHtml(res)) {
        skipped.push({ url: u, reason: res.error || `HTTP ${res.status}` });
        continue;
      }
      const f = pageFeatures(res, res.body, { keyword, sitemapLastmod: lastmods.get(u) || '' });
      f.role = siteKey(`http://${host}/`) === ourHost ? 'ours' : 'competitor';
      f.text = parseHtml(res.body, res.finalUrl).text.slice(0, 20000);
      pages.push(f);
    }
  });
  const ours = pages.filter((p) => p.role === 'ours');
  const comps = pages.filter((p) => p.role === 'competitor');
  log(`Fetched ${comps.length} competitor page(s), ${ours.length} of ours; skipped ${skipped.length}`);
  let infos = [];
  const wantInfo = !flags.noDomainInfo && (flags.domainInfo || mode === 'domain');
  if (wantInfo) {
    const domains = [...new Set([...domainSet, ...comps.map((c) => new URL(c.finalUrl || c.url).origin)])].slice(0, 15);
    infos = await mapLimit(domains, 2, (d) => domainInfo(d, fetchOpts));
  }
  const ourPage = ours[0] || null;
  const gaps = ourPage ? gapList(ourPage, comps) : [];
  const label = slugify(flags.label || keyword || (mode === 'domain' ? [...domainSet].map((o) => siteKey(o)).join('-') : 'urls'), 50) || 'urls';

  const csvRows = pages.map((p) => ({
    role: p.role, url: p.url, domain: p.domain, status: p.status, title: p.title, title_length: p.titleLength, description: p.description, h1: p.h1, h2_count: p.h2.length, h3_count: p.h3.length,
    word_eq: p.wordEq, first_paragraph_word_eq: p.firstParagraphWordEq, answer_first: p.answerFirst ? 'yes' : '', faq: p.faq ? 'yes' : '', tables: p.tables, lists: p.lists ? 'yes' : '', toc: p.toc ? 'yes' : '', author: p.author ? 'yes' : '', breadcrumb: p.breadcrumb ? 'yes' : '',
    interactive: p.interactive ? 'yes' : '', images: p.images, videos: p.videos, schema_types: p.schemaTypes.join(' '), internal_links: p.internalLinks, external_links: p.externalLinks, citations: p.citations, modified: p.modified, lang: p.lang, js_rendered: p.jsRendered ? 'yes' : '', h2: p.h2.slice(0, 15).join(' | '),
  }));
  const files = [writeCsvFile(ws.dataFile('competitors', `${label}-pages`, 'csv'), csvRows)];
  files.push(writeJson(ws.dataFile('competitors', `${label}-compare`, 'json'), { meta: { mode, keyword, ours: ourPage ? ourPage.url : null, generatedAt: new Date().toISOString() }, pages: pages.map(({ text, ...rest }) => rest), gaps, skipped, domains: infos }));

  const L = [`# Competitor snapshot: ${keyword || label} (${ws.today()})`, ''];
  L.push(`- Mode: ${mode}; ${comps.length} competitor page(s)${ourPage ? `; ours: ${ourPage.url}` : '; no page of ours to compare (pass --ours or --keyword with keyword-map.csv)'}`);
  if (skipped.length) L.push(`- Skipped ${skipped.length}: ${skipped.slice(0, 5).map((s) => `${shortUrl(s.url)} (${s.reason})`).join('; ')}`);
  L.push('- Static HTML only; JS-rendered content is not visible.', '');
  const shown = [...(ourPage ? [ourPage] : []), ...comps.slice(0, 8)];
  if (shown.length) {
    const yes = (v) => (v ? 'yes' : '-');
    const rows = [
      ['Title length', (p) => p.titleLength],
      ['Words (equivalent)', (p) => fmtInt(p.wordEq)],
      ['First paragraph words', (p) => p.firstParagraphWordEq],
      ['Answer first', (p) => yes(p.answerFirst)],
      ['H2 / H3', (p) => `${p.h2.length} / ${p.h3.length}`],
      ['FAQ', (p) => yes(p.faq)],
      ['Tables', (p) => p.tables || '-'],
      ['Lists', (p) => yes(p.lists)],
      ['TOC', (p) => yes(p.toc)],
      ['Author', (p) => yes(p.author)],
      ['Breadcrumbs', (p) => yes(p.breadcrumb)],
      ['Tool / interactive', (p) => yes(p.interactive)],
      ['Video', (p) => p.videos || '-'],
      ['Schema types', (p) => p.schemaTypes.slice(0, 5).join(', ') || '-'],
      ['Citations (outbound)', (p) => p.citations],
      ['Updated', (p) => String(p.modified || '-').slice(0, 10)],
    ];
    const cols = [{ label: 'Feature', value: (r) => r[0] }, ...shown.map((p, i) => ({ label: `${p.role === 'ours' ? 'OURS ' : ''}${shortUrl(p.url).slice(0, 40)}`, value: (r) => r[1](shown[i]) }))];
    L.push('## Side by side', '', mdTable(cols, rows));
  }
  if (ourPage) {
    L.push('## Gap list', '', mdTable([{ label: 'Type', key: 'type' }, { label: 'Gap', key: 'item' }, { label: 'Evidence', key: 'detail' }], gaps, { empty: 'No clear gaps against these competitors.' }));
  }
  if (mode === 'domain') {
    const doms = [...new Set(comps.map((c) => c.domain))];
    L.push('## Section aggregates', '', mdTable(
      [
        { label: 'Domain', value: (d) => d },
        { label: 'Pages', align: 'right', value: (d) => comps.filter((c) => c.domain === d).length },
        { label: 'Median words', align: 'right', value: (d) => fmtInt(median(comps.filter((c) => c.domain === d).map((c) => c.wordEq))) },
        { label: 'FAQ', align: 'right', value: (d) => fmtPct(comps.filter((c) => c.domain === d && c.faq).length / Math.max(1, comps.filter((c) => c.domain === d).length), 0) },
        { label: 'Tables', align: 'right', value: (d) => fmtPct(comps.filter((c) => c.domain === d && c.tables > 0).length / Math.max(1, comps.filter((c) => c.domain === d).length), 0) },
        { label: 'Newest update', value: (d) => comps.filter((c) => c.domain === d).map((c) => String(c.modified).slice(0, 10)).sort().pop() || '-' },
      ],
      doms,
    ));
  }
  if (infos.length) {
    L.push('## Domain facts', '', mdTable([{ label: 'Domain', key: 'domain' }, { label: 'Registered (RDAP)', value: (i) => i.registered || '-' }, { label: 'First archive capture', value: (i) => i.firstCapture || '-' }, { label: 'llms.txt', value: (i) => (i.llmsTxt ? 'yes' : '-') }, { label: 'AI bots blocked', value: (i) => Object.entries(i.aiBots).filter(([, ok]) => !ok).map(([b]) => b).join(', ') || 'none' }], infos));
  }
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-competitors-${label}.md`), L.join('\n'));
  out(`Competitor snapshot (${mode}): ${comps.length} competitor page(s)${ourPage ? ` vs ${shortUrl(ourPage.url)}` : ''}; ${gaps.length} gap(s); ${skipped.length} skipped`);
  for (const g of gaps.slice(0, 8)) out(`  [${g.type}] ${g.item}: ${g.detail}`);
  out(`\nwrote ${md}`);
  for (const f of files) out(`wrote ${f}`);
  return 0;
}

runMain(import.meta.url, main);
