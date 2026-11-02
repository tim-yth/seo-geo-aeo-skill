#!/usr/bin/env node
// Structured-data validator: Google's per-type rules (required, recommended, one-of, value formats), retired types as
// info, the site-wide entity graph (@id, Organization, WebSite), FAQ/price/rating vs visible text, sameAs and assets.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, ensureDir, collectList, mapLimit, rateLimiter, normalizeUrl, hostOf, bareHost, sameSite } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { fetchPage, fetchRobots, robotsAllows, isHtml, DEFAULT_UA } from './lib/http.mjs';
import { parseHtml } from './lib/html.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { mdTable, shortUrl, textTable } from './lib/format.mjs';
import { compactKey, truncate } from './lib/text.mjs';
import { listFiles, fileToUrlPath, pathKey, normKey, guessDirOrigin, scanBody, HTML_FILE_RE, ERROR_PAGE_RE } from './lib/page-facts.mjs';
import {
  LAST_VERIFIED, POLICY_URL, ORGANIZATION_DOC, SCHEMA_VALIDATOR_URL, RICH_RESULTS_TEST_URL, ARTICLE_TYPES, ORGANIZATION_TYPES, LOCAL_BUSINESS_TYPES, PRODUCT_TYPES,
  SOFTWARE_TYPES, WEBPAGE_TYPES, REVIEW_TYPES, REFERENCE_PROPS, validateBlock, walkJsonLd, typesOf, isReference, idIndex, statusFor, values, literal, isAbsoluteUrl,
  numbersInText, jsonPath, ruleCatalog, isLinkOnlyProduct,
} from './lib/schema-rules.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  'from-crawl': { type: 'string', placeholder: 'file', desc: 'Read a crawl-site -jsonld.jsonl file (bare --from-crawl or no input = newest data/crawl/*-jsonld.jsonl); offline' },
  urls: { type: 'csv', placeholder: 'url', desc: 'Fetch these live pages (your site; other hosts follow their robots.txt)' },
  'urls-file': { type: 'string', placeholder: 'file', desc: 'Fetch the URLs listed in this file (one per line)' },
  'build-dir': { type: 'string', placeholder: 'dir', desc: 'Validate the built HTML files in this directory (offline)' },
  'base-url': { type: 'string', placeholder: 'url', desc: 'With --build-dir: production origin (default: site.url, else the origin the canonicals use)' },
  'clean-urls': { type: 'boolean', desc: 'With --build-dir: a.html is served as /a' },
  types: { type: 'csv', placeholder: 'types', desc: 'Only report these types and their subtypes (e.g. Product,Article); parse errors are always reported' },
  'fail-on': { type: 'string', choices: ['error', 'warning'], desc: 'Exit 2 when an issue at or above this severity exists' },
  'check-same-as': { type: 'boolean', desc: 'Fetch each unique sameAs URL once (robots.txt respected, >= 1 s between requests per host) and report broken profiles' },
  'max-same-as': { type: 'int', default: 25, desc: 'With --check-same-as: maximum URLs checked' },
  'check-assets': { type: 'boolean', desc: 'Fetch logo/image/thumbnailUrl URLs and check HTTP 200 + an image content type (--build-dir checks local files offline anyway)' },
  'max-assets': { type: 'int', default: 50, desc: 'With --check-assets: maximum URLs checked' },
  delay: { type: 'int', placeholder: 'ms', default: 300, desc: 'Gap between requests to your site (third-party hosts get at least 1000 ms)' },
  timeout: { type: 'int', placeholder: 'ms', default: 20000, desc: 'Per-request timeout' },
  'user-agent': { type: 'string', placeholder: 'ua', default: DEFAULT_UA, desc: 'User-Agent header for --urls, --check-same-as and --check-assets' },
  out: { type: 'string', placeholder: 'dir', desc: 'Output directory (default: workspace data/crawl; without a workspace ./schema-validate-out)' },
  name: { type: 'string', default: 'schema', desc: 'Output name prefix: <date>-<name>-issues.csv, -summary.json, -summary.md' },
  json: { type: 'boolean', desc: 'Print the summary JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/schema-validate.mjs [--from-crawl [file]] [--types Product,Article] [--fail-on error|warning]',
    'node scripts/schema-validate.mjs --build-dir dist [--base-url https://www.example.com] [--fail-on error]',
    'node scripts/schema-validate.mjs --urls https://www.example.com/,https://www.example.com/p/1 [--check-same-as] [--check-assets]',
  ],
  summary:
    'Validates JSON-LD against Google Search Central rules per type (Organization, LocalBusiness, WebSite, Article/NewsArticle/BlogPosting, ' +
    'Product with Offer/AggregateOffer/AggregateRating/Review, ProductGroup, BreadcrumbList, FAQPage, VideoObject, Event, SoftwareApplication, ' +
    `Course, Dataset, ProfilePage, ImageObject) plus schema.org sanity for DefinedTerm and Person (docs checked ${LAST_VERIFIED}). Value formats: ISO 8601 ` +
    'dates (time zone recommended on Article dates), absolute URLs, numeric prices, ISO 4217 currencies, availability values, rating ranges and ' +
    'counts. Retired or limited types (FAQ, HowTo, Course Info, ClaimReview, Estimated Salary, Learning Video, Special Announcement, Vehicle ' +
    'Listing, Practice problem, Dataset, Book Actions, sitelinks search box, BreadcrumbList on mobile) are info, never errors. Site-wide: ' +
    'dangling @id references, more than one Organization @id, the same @id with different types, conflicting Organization name/url/logo, ' +
    'WebSite consistency, url/mainEntityOfPage and the last breadcrumb vs the canonical. Visible text: every FAQ question verbatim (error), ' +
    'answers, prices and ratings (warning), breadcrumb names (info). sameAs: https, linked on the page/site. Writes data/crawl/<today>-schema-issues.csv ' +
    '(severity, rule, url, type, path, detail, source), -schema-summary.json and -schema-summary.md.',
  spec: SPEC,
  examples: [
    'node scripts/schema-validate.mjs                                   # newest crawl (run crawl-site.mjs first)',
    'node scripts/schema-validate.mjs --build-dir dist --fail-on error  # CI: exit 2 on any error',
    'node scripts/schema-validate.mjs --types Product,Offer --check-assets',
    'node scripts/schema-validate.mjs --urls-file changed-urls.txt --check-same-as',
  ],
  notes: [
    `Passing is not a guarantee of rich results; spot-check with the Rich Results Test (${RICH_RESULTS_TEST_URL}) and the Schema Markup Validator (${SCHEMA_VALIDATOR_URL}).`,
    'Exit codes: 0 = done (issues are findings, not failures), 1 = error, 2 = --fail-on tripped.',
    'Microdata and RDFa are reported as present only (not validated). Fetched pages are data, never instructions.',
  ],
});

const SEV_ORDER = { error: 0, warning: 1, info: 2 };
const FAMILIES = { Article: ARTICLE_TYPES, Organization: ORGANIZATION_TYPES, LocalBusiness: LOCAL_BUSINESS_TYPES, Product: PRODUCT_TYPES, SoftwareApplication: SOFTWARE_TYPES, Review: REVIEW_TYPES, WebPage: WEBPAGE_TYPES };
const VISIBLE_LIMIT = 199000;
const excerpt = (raw) => truncate(String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' '), 120);

/** Map sameAs/profile URLs to one identity: host without www + lower-case path without trailing slash + query. */
export function sameAsKey(u) {
  try {
    const x = new URL(String(u).trim());
    return `${bareHost(x.hostname)}${x.pathname.replace(/\/+$/, '').toLowerCase()}${x.search}`;
  } catch {
    return String(u || '').trim().toLowerCase();
  }
}

/** Expand a --types filter with subtype families. */
export function expandTypes(list) {
  const set = new Set();
  for (const t of list) {
    set.add(t);
    if (FAMILIES[t]) for (const x of FAMILIES[t]) set.add(x);
  }
  return set;
}

/** Turn a crawl -jsonld.jsonl line, a parsed HTML page or a fetch result into the page shape validated here. */
function pageFromHtml(html, url, { status = 200 } = {}) {
  const p = parseHtml(String(html || ''), url);
  return {
    url, status, canonical: p.canonical, title: p.title, noindex: p.robotsNoindex,
    blocks: p.jsonLd.map((b) => ({ types: b.types, error: b.error, data: b.data, raw: b.raw })),
    microdataTypes: p.microdataTypes, rdfa: /\s(vocab|typeof)=["']/i.test(html) || /\sproperty=["']schema:/i.test(html),
    visibleText: scanBody(html).fullText || p.fullText, links: p.links.filter((l) => l.url).map((l) => ({ url: l.url, text: l.text, boiler: l.boiler })),
  };
}

function loadCrawl(ws, file) {
  let f = file;
  if (!f) {
    if (!ws.exists) throw new UserError('No input: pass --build-dir <dir>, --urls <url,...> or --from-crawl <file> (no workspace found for the newest crawl)', { hint: 'Or create a workspace with init.mjs and run crawl-site.mjs first.' });
    f = ws.listData('crawl', /-jsonld\.jsonl$/)[0];
    if (!f) throw new UserError(`No crawl JSON-LD file in ${ws.path('data', 'crawl')}`, { hint: ['Run: node scripts/crawl-site.mjs (it writes data/crawl/<date>-crawl-jsonld.jsonl)', 'Or validate a build: --build-dir dist, or live pages: --urls <url>'] });
  } else f = ws.exists ? ws.resolveFile(f) : path.resolve(f);
  if (!fs.existsSync(f)) throw new UserError(`Crawl file not found: ${f}`);
  const pages = [];
  let bad = 0;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    pages.push({ url: r.finalUrl || r.url, status: r.status, canonical: r.canonical || '', title: r.title || '', noindex: Boolean(r.noindex), blocks: r.blocks || [], microdataTypes: r.microdataTypes || [], rdfa: false, visibleText: r.visibleText || '', links: r.links || [] });
  }
  if (bad) log(`Skipped ${bad} unreadable line(s) in ${f}`);
  const linksFile = f.replace(/-jsonld\.jsonl$/, '-links.jsonl');
  let siteLinks = null;
  let pageSet = new Set(pages.map((p) => p.url));
  if (linksFile !== f && fs.existsSync(linksFile)) {
    siteLinks = new Set();
    pageSet = new Set(pageSet);
    for (const line of fs.readFileSync(linksFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        pageSet.add(r.finalUrl || r.url);
        for (const l of r.links || []) if (l.url) siteLinks.add(sameAsKey(l.url));
      } catch {
        /* skip */
      }
    }
  }
  return { pages, source: f, mode: 'crawl', siteLinks, pageSet, linksFile: siteLinks ? linksFile : '' };
}

function loadBuild(dir, origin, cleanUrls, prefix = '') {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new UserError(`--build-dir not found: ${dir}`, { hint: 'Build the site first (e.g. npm run build) and pass the output directory.' });
  const files = listFiles(abs);
  const pages = [];
  for (const rel of files) {
    if (!HTML_FILE_RE.test(rel) || ERROR_PAGE_RE.test(rel)) continue;
    const url = `${origin}${prefix}${fileToUrlPath(rel, { cleanUrls })}`;
    pages.push({ ...pageFromHtml(fs.readFileSync(path.join(abs, rel), 'utf8'), url), file: rel });
  }
  const siteLinks = new Set();
  for (const p of pages) for (const l of p.links) siteLinks.add(sameAsKey(l.url));
  // a page's own canonical is a known page too (clean-URL hosts serve a.html as /a)
  const pageSet = new Set(pages.map((p) => p.url));
  for (const p of pages) if (p.canonical && normKey(pathKey(p.canonical)) === normKey(pathKey(p.url))) pageSet.add(normalizeUrl(p.canonical) || p.canonical);
  return { pages, source: abs, mode: 'build', siteLinks, pageSet, files: new Set(files), dir: abs, prefix };
}

async function loadUrls(urls, { siteHost, fetchOpts, delay }) {
  const pages = [];
  const skipped = [];
  const robotsCache = new Map();
  const limiters = new Map();
  const limiter = (host) => {
    if (!limiters.has(host)) limiters.set(host, rateLimiter(siteHost && sameSite(`https://${host}/`, siteHost) ? delay : Math.max(delay, 1000)));
    return limiters.get(host);
  };
  await mapLimit(urls, 2, async (u) => {
    let x;
    try {
      x = new URL(u);
    } catch {
      skipped.push({ url: u, why: 'not a valid URL' });
      return;
    }
    if (!siteHost || !sameSite(u, siteHost)) {
      if (!robotsCache.has(x.origin)) robotsCache.set(x.origin, await fetchRobots(x.origin, fetchOpts));
      const rob = robotsCache.get(x.origin);
      if (rob.robots && !robotsAllows(rob.robots, fetchOpts.userAgent, x.pathname + x.search)) {
        skipped.push({ url: u, why: 'disallowed by its robots.txt' });
        return;
      }
    }
    await limiter(x.hostname)();
    const res = await fetchSameHost(u, { ...fetchOpts, maxBytes: 5 * 1024 * 1024 });
    if (res.error || res.status !== 200 || !isHtml(res)) {
      pages.push({ url: u, status: res.status, fetchError: res.error || (res.status !== 200 ? `HTTP ${res.status}` : 'not HTML'), blocks: [], microdataTypes: [], links: [], visibleText: '' });
      return;
    }
    pages.push(pageFromHtml(res.body, res.finalUrl, { status: res.chain.length ? res.chain[0].status : 200 }));
  });
  return { pages, source: `${urls.length} URL(s)`, mode: 'urls', siteLinks: null, pageSet: new Set(pages.map((p) => p.url)), skipped };
}

/** GET following redirects only on the same host (a redirect elsewhere is reported, not followed). */
async function fetchSameHost(url, opts) {
  let current = url;
  for (let hop = 0; hop <= 10; hop++) {
    const res = await fetchPage(current, { ...opts, followRedirects: false });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      let next;
      try {
        next = new URL(res.headers.location, current);
      } catch {
        return { ...res, error: 'invalid redirect location', finalUrl: current };
      }
      if (next.host !== new URL(current).host) return { ...res, body: null, error: `redirects to another host (${next.host})`, finalUrl: next.href, chain: [{ url: current, status: res.status }] };
      current = next.href;
      continue;
    }
    return { ...res, finalUrl: current, chain: current === url ? [] : [{ url, status: 301 }] };
  }
  return { status: 0, error: 'more than 10 redirects', headers: {}, body: null, finalUrl: current, chain: [] };
}

const own = (u, hosts) => {
  try {
    return hosts.has(bareHost(new URL(u).hostname));
  } catch {
    return false;
  }
};

/**
 * Validate loaded pages. ctx = {mode, pageSet, siteLinks, siteHost, brand, files, dir, baseOrigin}. Returns
 * {issues, stats, status, graph, sameAs, assets}. Pure apart from reading build files for asset checks.
 */
export function validatePages(pages, ctx = {}) {
  const issues = [];
  const add = (severity, rule, url, type, p, detail, source) => issues.push({ severity, rule, url, type: type || '', path: p || '', detail, source: source || POLICY_URL });
  const now = ctx.now || Date.now();
  const hosts = new Set([...pages.map((p) => bareHost(hostOf(p.url))), ctx.siteHost && bareHost(ctx.siteHost)].filter(Boolean));
  const pageSet = ctx.pageSet || new Set(pages.map((p) => p.url));
  const pageKeys = new Map();
  for (const u of pageSet) {
    const k = normalizeUrl(u) || u;
    pageKeys.set(k, true);
    try {
      pageKeys.set(`norm:${bareHost(new URL(k).hostname)}${normKey(pathKey(k))}`, k);
    } catch {
      /* skip */
    }
  }
  const siteIndex = new Map();
  const typeStats = new Map();
  const statusHits = new Map();
  const sameAs = new Map();
  const orgNodes = [];
  const websiteNodes = [];
  const assets = new Map();
  let blocks = 0;
  let parseErrors = 0;
  let withData = 0;
  for (const page of pages) {
    page.index = idIndex(page.blocks);
    for (const [id, defs] of page.index.defined) for (const d of defs) {
      if (!siteIndex.has(id)) siteIndex.set(id, []);
      siteIndex.get(id).push({ ...d, url: page.url });
    }
  }
  for (const page of pages) {
    if (page.fetchError) {
      add('warning', 'fetch-failed', page.url, '', '', `Could not validate: ${page.fetchError}`);
      continue;
    }
    if (page.microdataTypes && page.microdataTypes.length) add('info', 'microdata-present', page.url, page.microdataTypes.join(','), '', `Microdata types ${page.microdataTypes.join(', ')} (presence only, not validated here; check them in the Rich Results Test)`, RICH_RESULTS_TEST_URL);
    if (page.rdfa) add('info', 'rdfa-present', page.url, '', '', 'RDFa markup present (presence only, not validated here)', RICH_RESULTS_TEST_URL);
    if (!page.blocks.length) continue;
    blocks += page.blocks.length;
    const multi = page.blocks.length > 1;
    page.blocks.forEach((b, i) => {
      if (!b.error) return;
      parseErrors++;
      add('error', 'jsonld-parse-error', page.url, '', multi ? `[block ${i + 1}]` : '', `JSON-LD does not parse: ${b.error}${b.raw ? `; starts with: ${excerpt(b.raw)}` : ''}`, SCHEMA_VALIDATOR_URL);
    });
    const parsed = page.blocks.filter((b) => !b.error && b.data);
    if (!parsed.length) continue;
    withData++;
    const visible = String(page.visibleText || '');
    const truncatedText = visible.length >= VISIBLE_LIMIT;
    if (truncatedText) add('info', 'visible-text-truncated', page.url, '', '', 'Visible text was cut at 200k characters by the crawler: visible-content checks skipped for this page');
    const pageCtx = { url: page.url, host: hostOf(page.url), now, ...(visible && !truncatedText ? { visibleText: visible, visibleKey: compactKey(visible), numbers: numbersInText(visible) } : {}) };
    const resolve = (id) => {
      const local = page.index.defined.get(id);
      if (local) return local[0].node;
      const site = siteIndex.get(id);
      return site ? site[0].node : null;
    };
    const canonical = normalizeUrl(page.canonical || page.url) || page.url;
    const linked = new Set((page.links || []).map((l) => sameAsKey(l.url)));
    let faqPages = 0;
    const incoming = new Map();
    for (const r of page.index.refs) {
      if (!r.parentProp) continue;
      if (!incoming.has(r.id)) incoming.set(r.id, new Set());
      incoming.get(r.id).add(r.parentProp);
    }
    page.blocks.forEach((b, i) => {
      if (b.error || !b.data) return;
      const label = multi ? `[block ${i + 1}]` : '';
      for (const issue of validateBlock(b.data, { page: pageCtx, resolve, blockLabel: label, incoming })) issues.push({ ...issue, url: page.url });
      walkJsonLd(b.data, (node, wctx) => {
        if (isReference(node)) return;
        const t = typesOf(node);
        const p = `${label ? `${label} ` : ''}${jsonPath(wctx.path)}`;
        const reference = !wctx.topLevel && wctx.parentProp && REFERENCE_PROPS.has(wctx.parentProp);
        for (const type of t) {
          if (!typeStats.has(type)) typeStats.set(type, { nodes: 0, pages: new Set() });
          typeStats.get(type).nodes++;
          typeStats.get(type).pages.add(page.url);
        }
        for (const s of statusFor(node)) {
          if (!statusHits.has(s.id)) statusHits.set(s.id, { rule: s, pages: new Set(), nodes: 0, types: new Set() });
          const h = statusHits.get(s.id);
          h.pages.add(page.url);
          h.nodes++;
          t.forEach((x) => h.types.add(x));
        }
        if (t.includes('FAQPage')) faqPages++;
        if (!reference && t.some((x) => ORGANIZATION_TYPES.has(x)) && !t.some((x) => LOCAL_BUSINESS_TYPES.has(x))) orgNodes.push({ node, url: page.url, path: p, id: typeof node['@id'] === 'string' ? node['@id'] : '' });
        if (!reference && t.includes('WebSite')) websiteNodes.push({ node, url: page.url, path: p });
        // rule 5: url / mainEntityOfPage of the page's own entity = canonical
        if (wctx.topLevel && !reference && !isLinkOnlyProduct(node) && t.some((x) => ARTICLE_TYPES.has(x) || (WEBPAGE_TYPES.has(x) && x !== 'FAQPage') || PRODUCT_TYPES.has(x))) {
          for (const prop of ['url', 'mainEntityOfPage']) {
            for (const { value, path: rel } of values(node, prop)) {
              const raw = value && typeof value === 'object' ? literal(value['@id'] || value.url) : literal(value);
              if (typeof raw !== 'string' || !isAbsoluteUrl(raw)) continue;
              const n = normalizeUrl(raw) || raw;
              if (n !== canonical) add('warning', 'url-not-canonical', page.url, t.join(','), `${p}${jsonPath(rel).slice(1)}`, `${prop} ${raw} differs from the canonical ${canonical} (canonical, og:url, JSON-LD url and the last breadcrumb must agree)`);
              checkInternal(page, raw, t, `${p}${jsonPath(rel).slice(1)}`);
            }
          }
        }
        if (t.includes('BreadcrumbList') && !reference) {
          const items = values(node, 'itemListElement');
          items.forEach(({ value, path: rel }, idx) => {
            if (!value || typeof value !== 'object') return;
            const item = value.item;
            const raw = item && typeof item === 'object' ? literal(item['@id'] || item.url) : literal(item);
            if (typeof raw !== 'string' || !isAbsoluteUrl(raw)) return;
            const where = `${p}${jsonPath([...rel, 'item']).slice(1)}`;
            checkInternal(page, raw, t, where);
            if (idx === items.length - 1 && (normalizeUrl(raw) || raw) !== canonical) add('warning', 'breadcrumb-last-not-canonical', page.url, 'BreadcrumbList', where, `Last breadcrumb ${raw} is not the canonical ${canonical}`);
          });
        }
        for (const { value, path: rel } of values(node, 'sameAs')) {
          const raw = String(literal(value) || '').trim();
          const where = `${p}${jsonPath(rel).slice(1)}`;
          if (!isAbsoluteUrl(raw)) {
            add('warning', 'same-as-invalid', page.url, t.join(','), where, `sameAs "${truncate(raw, 80)}" is not an absolute URL`, ORGANIZATION_DOC);
            continue;
          }
          if (/^http:/i.test(raw)) add('warning', 'same-as-not-https', page.url, t.join(','), where, `sameAs ${raw} uses http: link the https profile`, ORGANIZATION_DOC);
          const k = sameAsKey(raw);
          if (!sameAs.has(k)) sameAs.set(k, { url: raw, pages: new Set(), linkedOnPage: false, types: new Set() });
          const e = sameAs.get(k);
          e.pages.add(page.url);
          t.forEach((x) => e.types.add(x));
          if (linked.has(k)) e.linkedOnPage = true;
        }
        for (const prop of ['logo', 'image', 'thumbnailUrl']) {
          for (const { value } of values(node, prop)) {
            const raw = value && typeof value === 'object' ? literal(value.contentUrl || value.url) : literal(value);
            if (typeof raw === 'string' && isAbsoluteUrl(raw) && !assets.has(raw)) assets.set(raw, { url: raw, prop, page: page.url, type: t.join(',') });
          }
        }
      });
    });
    if (faqPages > 1) add('warning', 'faq-multiple', page.url, 'FAQPage', '', `${faqPages} FAQPage nodes on one page: keep one FAQPage per page`);
  }

  function checkInternal(page, raw, t, where) {
    if (!own(raw, hosts) || ctx.mode === 'urls') return;
    const n = normalizeUrl(raw) || raw;
    if (pageKeys.has(n)) return;
    let normHit = '';
    try {
      normHit = pageKeys.get(`norm:${bareHost(new URL(n).hostname)}${normKey(pathKey(n))}`) || '';
    } catch {
      /* skip */
    }
    if (normHit) add('warning', 'internal-url-variant', page.url, t.join(','), where, `${raw} is another form of ${normHit} (.html / trailing slash / case): use the canonical form`);
    else add(ctx.mode === 'build' ? 'warning' : 'info', 'internal-url-not-a-page', page.url, t.join(','), where, `${raw} is not a page ${ctx.mode === 'build' ? 'in the build' : 'in the crawl (the crawl may be partial)'}`);
  }

  // ---- entity graph ----
  const dangling = new Map();
  for (const page of pages) {
    for (const ref of (page.index && page.index.refs) || []) {
      if (page.index.defined.has(ref.id) || siteIndex.has(ref.id)) continue;
      if (!dangling.has(ref.id)) dangling.set(ref.id, { pages: new Set(), example: `${ref.block > 0 || page.blocks.length > 1 ? `[block ${ref.block + 1}] ` : ''}${jsonPath(ref.path)}`, prop: ref.parentProp });
      dangling.get(ref.id).pages.add(page.url);
    }
  }
  for (const [id, d] of dangling) {
    const docUrl = String(id).replace(/#.*$/, '');
    const defPageChecked = docUrl && (pageSet.has(docUrl) || pageSet.has(normalizeUrl(docUrl) || docUrl));
    const partial = ctx.mode === 'urls' && !defPageChecked;
    const first = [...d.pages][0];
    add(partial ? 'info' : 'warning', 'dangling-id', first, '', d.example, `@id ${id} is referenced${d.prop ? ` (${d.prop})` : ''} on ${d.pages.size} page(s) but defined on none of the ${pages.length} checked page(s)${partial ? '; the defining page was not checked' : ''}`, ORGANIZATION_DOC);
  }
  const idTypes = [];
  for (const [id, defs] of siteIndex) {
    const sigs = new Map();
    for (const d of defs) {
      if (!d.types.length) continue;
      const sig = d.types.slice().sort().join(',');
      if (!sigs.has(sig)) sigs.set(sig, d.url);
    }
    if (sigs.size > 1) {
      idTypes.push({ id, types: [...sigs.keys()] });
      add('warning', 'id-type-conflict', [...sigs.values()][1], [...sigs.keys()].join(' | '), '', `@id ${id} has different @type values across pages: ${[...sigs].map(([s, u]) => `${s} (${shortUrl(u)})`).join(' vs ')}`, ORGANIZATION_DOC);
    }
  }
  const siteBare = ctx.siteHost ? bareHost(ctx.siteHost) : '';
  const isOwnOrg = (n) => {
    const u = literal(n.url);
    if (typeof u !== 'string' || !isAbsoluteUrl(u)) return true;
    const h = bareHost(hostOf(u));
    return siteBare ? h === siteBare : hosts.has(h);
  };
  const ownOrgs = orgNodes.filter((o) => isOwnOrg(o.node));
  const orgIds = new Map();
  for (const o of ownOrgs) if (o.id) {
    if (!orgIds.has(o.id)) orgIds.set(o.id, new Set());
    orgIds.get(o.id).add(o.url);
  }
  if (orgIds.size > 1) add('warning', 'organization-multiple-ids', [...orgIds.values()][1].values().next().value, 'Organization', '', `One organization, two identities: ${orgIds.size} different Organization @id values (${[...orgIds.keys()].slice(0, 4).join(', ')}); use one @id site-wide and reference it`, ORGANIZATION_DOC);
  const noId = new Set(ownOrgs.filter((o) => !o.id).map((o) => o.url));
  if (noId.size > 1) add('info', 'organization-no-id', [...noId][0], 'Organization', '', `Organization without @id on ${noId.size} pages: give it one stable @id (e.g. https://www.example.com/#organization) and reference it`, ORGANIZATION_DOC);
  const orgFacts = { name: new Map(), url: new Map(), logo: new Map() };
  for (const o of ownOrgs) {
    const logo = values(o.node, 'logo').map((v) => (v.value && typeof v.value === 'object' ? literal(v.value.url || v.value.contentUrl) : literal(v.value)))[0];
    for (const [k, v] of [['name', literal(o.node.name)], ['url', literal(o.node.url)], ['logo', logo]]) {
      if (typeof v !== 'string' || !v.trim()) continue;
      const key = k === 'name' ? v.trim() : normalizeUrl(v) || v;
      if (!orgFacts[k].has(key)) orgFacts[k].set(key, o.url);
    }
  }
  for (const k of ['name', 'url', 'logo']) {
    if (orgFacts[k].size > 1) add('warning', 'organization-conflict', [...orgFacts[k].values()][1], 'Organization', '', `Organization ${k} differs across pages: ${[...orgFacts[k].keys()].slice(0, 4).map((x) => `"${truncate(x, 60)}"`).join(' vs ')}`, ORGANIZATION_DOC);
  }
  const brandName = ctx.brand && ctx.brand.officialName;
  if (brandName && orgFacts.name.size && !orgFacts.name.has(brandName)) add('warning', 'organization-name-mismatch', [...orgFacts.name.values()][0], 'Organization', '', `Organization name ${[...orgFacts.name.keys()].map((x) => `"${x}"`).join(', ')} differs from config brand.officialName "${brandName}" (one brand string everywhere)`, ORGANIZATION_DOC);
  const wsNames = new Map();
  const wsUrls = new Map();
  for (const w of websiteNodes) {
    const n = literal(w.node.name);
    const u = literal(w.node.url);
    if (typeof n === 'string' && n.trim() && !wsNames.has(n.trim())) wsNames.set(n.trim(), w.url);
    if (typeof u === 'string' && u.trim() && !wsUrls.has(normalizeUrl(u) || u)) wsUrls.set(normalizeUrl(u) || u, w.url);
  }
  if (wsNames.size > 1) add('warning', 'website-conflict', [...wsNames.values()][1], 'WebSite', '', `WebSite name differs across pages: ${[...wsNames.keys()].map((x) => `"${x}"`).join(' vs ')}`, 'https://developers.google.com/search/docs/appearance/site-names');
  if (wsUrls.size > 1) add('warning', 'website-conflict', [...wsUrls.values()][1], 'WebSite', '', `WebSite url differs across pages: ${[...wsUrls.keys()].join(' vs ')}`, 'https://developers.google.com/search/docs/appearance/site-names');
  const homes = pages.filter((p) => {
    try {
      return new URL(p.url).pathname === '/' && !p.fetchError;
    } catch {
      return false;
    }
  });
  if (websiteNodes.length && homes.length && !homes.some((h) => websiteNodes.some((w) => w.url === h.url))) add('warning', 'website-not-on-home', homes[0].url, 'WebSite', '', 'WebSite markup exists on other pages but not on the home page; site names are read from the home page', 'https://developers.google.com/search/docs/appearance/site-names');

  // ---- sameAs linked on the page / site ----
  const configSameAs = new Set(((ctx.brand && ctx.brand.sameAs) || []).map(sameAsKey));
  for (const [k, e] of sameAs) {
    if (e.linkedOnPage) continue;
    const onSite = ctx.siteLinks ? ctx.siteLinks.has(k) : null;
    const first = [...e.pages][0];
    if (onSite === false) add('warning', 'same-as-not-linked-on-site', first, [...e.types].join(','), '', `sameAs ${e.url} (declared on ${e.pages.size} page(s)) is not linked anywhere on the site: link official profiles visibly (footer or About) and keep only official ones`, ORGANIZATION_DOC);
    else add('info', 'same-as-not-linked', first, [...e.types].join(','), '', `sameAs ${e.url} is not linked on the page that declares it${onSite ? ' (it is linked elsewhere on the site)' : ''}: fine if your About page links it; confirm it is an official profile`, ORGANIZATION_DOC);
  }
  if (configSameAs.size && sameAs.size) {
    const extra = [...sameAs.keys()].filter((k) => !configSameAs.has(k));
    const missing = [...configSameAs].filter((k) => !sameAs.has(k));
    if (extra.length || missing.length) add('info', 'same-as-config-mismatch', '', '', '', `sameAs differs from config brand.sameAs: ${extra.length ? `not in config: ${extra.slice(0, 3).join(', ')}` : ''}${extra.length && missing.length ? '; ' : ''}${missing.length ? `not in markup: ${missing.slice(0, 3).join(', ')}` : ''}`, ORGANIZATION_DOC);
  }

  // ---- assets in a build: files must exist ----
  if (ctx.mode === 'build' && ctx.files) {
    for (const a of assets.values()) {
      if (!own(a.url, hosts)) continue;
      let rel = '';
      try {
        rel = decodeURIComponent(new URL(a.url).pathname).replace(/^\/+/, '');
      } catch {
        continue;
      }
      if (!ctx.files.has(rel) && !ctx.files.has(`${rel.replace(/\/$/, '')}/index.html`)) add('warning', 'asset-missing', a.page, a.type, a.prop, `${a.prop} ${a.url} is not a file in the build (it must exist and return 200 with an image content type)`, ORGANIZATION_DOC);
    }
  }

  // ---- retired / limited types: one info row per type ----
  const status = [];
  for (const [, h] of statusHits) {
    const examples = [...h.pages].slice(0, 3);
    status.push({ id: h.rule.id, label: h.rule.label, status: h.rule.status, since: h.rule.since, pages: h.pages.size, nodes: h.nodes, examples, docUrl: h.rule.docUrl, detail: h.rule.detail });
    add('info', h.rule.status === 'retired' ? 'retired-type' : 'limited-type', examples[0], [...h.types].join(','), '', `${h.rule.label} on ${h.pages.size} page(s): ${h.rule.status} since ${h.rule.since}. ${h.rule.detail}`, h.rule.docUrl);
  }
  const types = [...typeStats].map(([type, s]) => ({ type, nodes: s.nodes, pages: s.pages.size })).sort((a, b) => b.pages - a.pages || b.nodes - a.nodes || a.type.localeCompare(b.type));
  return {
    issues: issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.rule.localeCompare(b.rule) || String(a.url).localeCompare(String(b.url))),
    stats: { pages: pages.length, pagesWithJsonLd: withData, blocks, parseErrors },
    types,
    status,
    graph: { organizationIds: [...orgIds.keys()], websiteNames: [...wsNames.keys()], dangling: [...dangling.keys()], idTypeConflicts: idTypes },
    sameAs: [...sameAs.values()].map((e) => ({ url: e.url, pages: e.pages.size, linkedOnPage: e.linkedOnPage, linkedOnSite: ctx.siteLinks ? ctx.siteLinks.has(sameAsKey(e.url)) : null })),
    assets: [...assets.values()],
  };
}

/** Fetch sameAs URLs politely: robots.txt per host, >= 1 s gap per host. Returns issues. */
async function checkSameAs(entries, { fetchOpts, max }) {
  const issues = [];
  const byHost = new Map();
  for (const e of entries.slice(0, max)) {
    const h = hostOf(e.url);
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(e);
  }
  await mapLimit([...byHost], 3, async ([host, list]) => {
    const origin = new URL(list[0].url).origin;
    const rob = await fetchRobots(origin, fetchOpts);
    const wait = rateLimiter(1000);
    for (const e of list) {
      const u = new URL(e.url);
      if (rob.robots && !robotsAllows(rob.robots, fetchOpts.userAgent, u.pathname + u.search)) {
        issues.push({ severity: 'info', rule: 'same-as-unverified', url: e.url, type: '', path: '', detail: `${host} robots.txt disallows fetching ${e.url}; not checked`, source: ORGANIZATION_DOC });
        continue;
      }
      await wait();
      const res = await fetchPage(e.url, { ...fetchOpts, maxBytes: 256 * 1024 });
      e.check = res.error ? res.error : `HTTP ${res.status}`;
      if (res.error && !res.status) issues.push({ severity: 'warning', rule: 'same-as-unreachable', url: e.url, type: '', path: '', detail: `sameAs ${e.url} could not be fetched: ${res.error}`, source: ORGANIZATION_DOC });
      else if (res.status === 404 || res.status === 410 || res.status >= 500) issues.push({ severity: 'warning', rule: 'same-as-unreachable', url: e.url, type: '', path: '', detail: `sameAs ${e.url} returns HTTP ${res.status}${res.chain.length ? ` after ${res.chain.length} redirect(s)` : ''}: remove or fix the profile link`, source: ORGANIZATION_DOC });
      else if (res.status >= 400 || res.error) issues.push({ severity: 'info', rule: 'same-as-unverified', url: e.url, type: '', path: '', detail: `sameAs ${e.url} answered HTTP ${res.status || 0} (login wall or bot protection); check it in a browser`, source: ORGANIZATION_DOC });
    }
  });
  return issues;
}

/** Fetch asset URLs (logo/image/thumbnail): HTTP 200 with an image content type. */
async function checkAssets(assets, { fetchOpts, max, siteHost, delay }) {
  const issues = [];
  const robotsCache = new Map();
  const limiters = new Map();
  await mapLimit(assets.slice(0, max), 3, async (a) => {
    const u = new URL(a.url);
    const ownHost = siteHost && sameSite(a.url, siteHost);
    if (!ownHost) {
      if (!robotsCache.has(u.origin)) robotsCache.set(u.origin, await fetchRobots(u.origin, fetchOpts));
      const rob = robotsCache.get(u.origin);
      if (rob.robots && !robotsAllows(rob.robots, fetchOpts.userAgent, u.pathname + u.search)) return;
    }
    if (!limiters.has(u.host)) limiters.set(u.host, rateLimiter(ownHost ? delay : Math.max(delay, 1000)));
    await limiters.get(u.host)();
    let res = await fetchSameHost(a.url, { ...fetchOpts, method: 'HEAD' });
    if ((res.error && !/another host/.test(res.error)) || [403, 405, 501].includes(res.status)) res = await fetchSameHost(a.url, { ...fetchOpts, maxBytes: 64 * 1024, decode: false });
    if (/another host/.test(res.error || '')) return;
    const type = String(res.headers['content-type'] || '');
    if (res.error || res.status !== 200) issues.push({ severity: 'warning', rule: 'asset-unreachable', url: a.page, type: a.type, path: a.prop, detail: `${a.prop} ${a.url} returns ${res.error || `HTTP ${res.status}`}`, source: ORGANIZATION_DOC });
    else if (!/^image\//i.test(type)) issues.push({ severity: 'warning', rule: 'asset-not-image', url: a.page, type: a.type, path: a.prop, detail: `${a.prop} ${a.url} is served as "${type || 'no content-type'}", not an image`, source: ORGANIZATION_DOC });
  });
  return issues;
}

function renderMarkdown({ result, issues, meta, today }) {
  const L = [`# Structured data validation - ${today}`, ''];
  const c = meta.counts;
  L.push(`Source: ${meta.source} (${meta.mode}). Pages: ${result.stats.pages}, with JSON-LD: ${result.stats.pagesWithJsonLd}, blocks: ${result.stats.blocks}, parse errors: ${result.stats.parseErrors}.`, '');
  L.push(`**${c.error} errors, ${c.warning} warnings, ${c.info} info.**`, '');
  L.push(`_Passing is not a guarantee of rich results; spot-check with the [Rich Results Test](${RICH_RESULTS_TEST_URL}) and the [Schema Markup Validator](${SCHEMA_VALIDATOR_URL}). Rules checked against Google's documentation on ${LAST_VERIFIED}._`, '');
  const byRule = new Map();
  for (const i of issues) {
    const k = `${i.severity}|${i.rule}`;
    if (!byRule.has(k)) byRule.set(k, { severity: i.severity, rule: i.rule, n: 0, ex: i });
    byRule.get(k).n++;
  }
  const rows = [...byRule.values()].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.n - a.n);
  L.push('## Issues by rule', '', mdTable([{ label: 'Severity', key: 'severity' }, { label: 'Rule', key: 'rule' }, { label: 'Count', key: 'n', align: 'right' }, { label: 'Example', value: (r) => `${r.ex.url ? `${shortUrl(r.ex.url)} ` : ''}${r.ex.type ? `[${r.ex.type}] ` : ''}${truncate(r.ex.detail, 140)}` }], rows, { empty: 'No issues.' }));
  const errs = issues.filter((i) => i.severity === 'error');
  if (errs.length) L.push('## Errors', '', mdTable([{ label: 'URL', value: (i) => shortUrl(i.url) }, { label: 'Type', key: 'type' }, { label: 'Path', key: 'path' }, { label: 'Detail', value: (i) => truncate(i.detail, 160) }], errs.slice(0, 150)));
  if (result.status.length) L.push('## Retired or limited types on this site', '', mdTable([{ label: 'Type', key: 'label' }, { label: 'Status', key: 'status' }, { label: 'Since', key: 'since' }, { label: 'Pages', key: 'pages', align: 'right' }, { label: 'What to do', value: (s) => truncate(s.detail, 160) }, { label: 'Source', key: 'docUrl' }], result.status));
  L.push('## Entity graph', '');
  L.push(`- Organization @id: ${result.graph.organizationIds.length ? result.graph.organizationIds.join(', ') : '(none)'}${result.graph.organizationIds.length > 1 ? ' - more than one: one organization, two identities' : ''}`);
  L.push(`- WebSite name: ${result.graph.websiteNames.join(' | ') || '(none)'}`);
  L.push(`- Dangling @id references: ${result.graph.dangling.length ? result.graph.dangling.slice(0, 10).join(', ') : 'none'}`);
  L.push(`- Same @id with different types: ${result.graph.idTypeConflicts.length ? result.graph.idTypeConflicts.map((x) => x.id).join(', ') : 'none'}`, '');
  if (result.sameAs.length) L.push('## sameAs', '', mdTable([{ label: 'Profile', key: 'url' }, { label: 'Declared on', key: 'pages', align: 'right' }, { label: 'Linked on that page', value: (s) => (s.linkedOnPage ? 'yes' : 'no') }, { label: 'Linked on the site', value: (s) => (s.linkedOnSite === null ? 'unknown' : s.linkedOnSite ? 'yes' : 'no') }], result.sameAs));
  L.push('## Types found', '', mdTable([{ label: 'Type', key: 'type' }, { label: 'Pages', key: 'pages', align: 'right' }, { label: 'Nodes', key: 'nodes', align: 'right' }], result.types.slice(0, 40), { empty: 'No JSON-LD found.' }));
  L.push('## Rules used', '', mdTable([{ label: 'Type', key: 'id' }, { label: 'Required', value: (r) => r.required.join(', ') || '-' }, { label: 'One of', value: (r) => r.oneOf.map((g) => g.join(' | ')).join('; ') || '-' }, { label: 'Doc', key: 'docUrl' }, { label: 'Doc updated', key: 'docUpdated' }, { label: 'Checked', key: 'lastVerified' }], ruleCatalog()));
  return `${L.join('\n')}\n`;
}

export async function main(argv) {
  const args = argv.map((a, i) => (a === '--from-crawl' && (i + 1 >= argv.length || argv[i + 1].startsWith('-')) ? '--from-crawl=' : a));
  const { flags, positionals } = parseArgs(args, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags, { requireConfig: false });
  const siteUrl = ws.exists ? ws.siteUrl({ required: false }) : '';
  const siteHost = siteUrl ? hostOf(siteUrl) : '';
  const fetchOpts = { userAgent: flags.userAgent, timeoutMs: flags.timeout };
  const urlList = collectList([...flags.urls, ...positionals], flags.urlsFile);
  const inputs = [flags.buildDir && 'build', urlList.length && 'urls', flags.fromCrawl !== undefined && 'crawl'].filter(Boolean);
  if (inputs.length > 1) throw new UserError(`Use one input at a time (got ${inputs.join(' + ')})`);
  let loaded;
  if (flags.buildDir) {
    let base = null;
    if (flags.baseUrl) {
      try {
        base = new URL(flags.baseUrl);
        if (!/^https?:$/.test(base.protocol)) throw new Error('scheme');
      } catch {
        throw new UserError(`--base-url "${flags.baseUrl}" must be an absolute URL such as https://www.example.com or https://www.example.com/docs/`);
      }
    }
    const origin = base ? base.origin : siteUrl ? new URL(siteUrl).origin : guessDirOrigin(path.resolve(flags.buildDir)) || 'https://www.example.invalid';
    loaded = loadBuild(flags.buildDir, origin, flags.cleanUrls, base ? base.pathname.replace(/\/+$/, '') : '');
  } else if (urlList.length) {
    log(`Fetching ${urlList.length} page(s) ...`);
    loaded = await loadUrls(urlList, { siteHost, fetchOpts, delay: flags.delay });
  } else loaded = loadCrawl(ws, flags.fromCrawl || '');
  if (!loaded.pages.length) throw new UserError(`No pages to validate in ${loaded.source}`);
  const result = validatePages(loaded.pages, { mode: loaded.mode, pageSet: loaded.pageSet, siteLinks: loaded.siteLinks, siteHost, brand: ws.exists ? ws.config.brand : null, files: loaded.files });
  let issues = result.issues;
  for (const s of loaded.skipped || []) issues.push({ severity: 'info', rule: 'skipped', url: s.url, type: '', path: '', detail: `Not fetched: ${s.why}`, source: POLICY_URL });
  if (flags.checkSameAs) {
    const list = result.sameAs.filter((s) => isAbsoluteUrl(s.url));
    log(`Checking ${Math.min(list.length, flags.maxSameAs)} sameAs URL(s) ...`);
    issues = issues.concat(await checkSameAs(list, { fetchOpts, max: flags.maxSameAs }));
  }
  if (flags.checkAssets) {
    log(`Checking ${Math.min(result.assets.length, flags.maxAssets)} logo/image URL(s) ...`);
    issues = issues.concat(await checkAssets(result.assets, { fetchOpts, max: flags.maxAssets, siteHost, delay: flags.delay }));
  }
  if (flags.types.length) {
    const want = expandTypes(flags.types);
    issues = issues.filter((i) => i.rule === 'jsonld-parse-error' || String(i.type).split(',').some((t) => want.has(t.trim())));
  }
  issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.rule.localeCompare(b.rule) || String(a.url).localeCompare(String(b.url)));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const today = ws.today();
  const outDir = flags.out ? path.resolve(flags.out) : ws.exists ? '' : path.resolve('schema-validate-out');
  const file = (suffix, ext) => (outDir ? path.join(ensureDir(outDir), `${today}-${flags.name}-${suffix}.${ext}`) : ws.dataFile('crawl', `${flags.name}-${suffix}`, ext));
  const meta = { source: loaded.source, mode: loaded.mode, generatedAt: new Date().toISOString(), rulesVerified: LAST_VERIFIED, types: flags.types, failOn: flags.failOn || '', counts, linksFile: loaded.linksFile || '' };
  const csvPath = writeCsvFile(file('issues', 'csv'), issues, ['severity', 'rule', 'url', 'type', 'path', 'detail', 'source']);
  const byRule = {};
  for (const i of issues) byRule[`${i.severity}|${i.rule}`] = (byRule[`${i.severity}|${i.rule}`] || 0) + 1;
  const summary = { meta, stats: result.stats, counts, byRule: Object.entries(byRule).map(([k, n]) => ({ severity: k.split('|')[0], rule: k.split('|')[1], count: n })).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count), types: result.types, status: result.status, graph: result.graph, sameAs: result.sameAs, rules: ruleCatalog() };
  const jsonPath = writeJson(file('summary', 'json'), summary);
  const mdPath = writeText(file('summary', 'md'), renderMarkdown({ result, issues, meta, today }));
  const tripped = flags.failOn === 'error' ? counts.error > 0 : flags.failOn === 'warning' ? counts.error + counts.warning > 0 : false;
  if (flags.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    out(`Validated ${result.stats.pages} page(s) (${result.stats.pagesWithJsonLd} with JSON-LD, ${result.stats.blocks} block(s), ${result.stats.parseErrors} parse error(s)) from ${loaded.source}`);
    out(`Issues: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`);
    const top = summary.byRule.slice(0, 14).map((r) => [r.severity, r.rule, r.count]);
    if (top.length) out(textTable(['severity', 'rule', 'count'], top));
    if (result.types.length) out(`Top types: ${result.types.slice(0, 8).map((t) => `${t.type} (${t.pages} page${t.pages === 1 ? '' : 's'})`).join(', ')}`);
    if (result.status.length) out(`Retired/limited: ${result.status.map((s) => `${s.label} on ${s.pages} page(s) (${s.status} since ${s.since})`).join('; ')}`);
    out(`Note: passing is not a guarantee of rich results; spot-check with the Rich Results Test (${RICH_RESULTS_TEST_URL}) / Schema Markup Validator (${SCHEMA_VALIDATOR_URL}).`);
    if (tripped) out(`Gate: FAILED (--fail-on ${flags.failOn})`);
    out('');
    for (const f of [mdPath, csvPath, jsonPath]) out(`wrote ${f}`);
  }
  return tripped ? 2 : 0;
}

runMain(import.meta.url, main);
