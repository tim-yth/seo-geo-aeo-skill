#!/usr/bin/env node
// Polite technical SEO crawler: sitemaps + link discovery, per-page SEO fields, link graph and issues.
import fs from 'node:fs';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, writeJson, writeText, normalizeUrl, rateLimiter, sameSite, collectList, mapLimit, UserError } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { fetchPage, fetchRobots, robotsAllows, robotsDecision, discoverSitemaps, collectSitemapUrls, isHtml, DEFAULT_UA } from './lib/http.mjs';
import { parseHtml, robotsTokens, headDiagnostics } from './lib/html.mjs';
import { displayWidth, normalizeText } from './lib/text.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { mdTable, shortUrl, textTable } from './lib/format.mjs';

/** Googlebot reads the first 2 MB of an HTML URL, HTTP response headers included (PDF: 64 MB). */
export const GOOGLEBOT_FETCH_LIMIT = 2 * 1024 * 1024;

/** User-agent strings for --compare-ua (simulated from this machine; real bots are also verified by IP). */
export const UA_STRINGS = {
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/130.0.0.0 Safari/537.36',
  'oai-searchbot': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot',
  'chatgpt-user': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot',
  perplexitybot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  'perplexity-user': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  'claude-searchbot': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)',
  claudebot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
};
const ANSWER_AGENTS = new Set(['googlebot', 'bingbot', 'oai-searchbot', 'chatgpt-user', 'perplexitybot', 'perplexity-user', 'claude-searchbot']);
const DEFAULT_COMPARE_AGENTS = ['googlebot', 'bingbot', 'oai-searchbot', 'gptbot', 'perplexitybot', 'claudebot'];

/** robots.txt tokens for the decision matrix: search, AI search/user-triggered, training-only and control tokens. */
export const ROBOTS_TEST_AGENTS = ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'ChatGPT-User', 'GPTBot', 'PerplexityBot', 'Perplexity-User', 'Claude-SearchBot', 'Claude-User', 'ClaudeBot', 'Applebot', 'Google-Extended', 'Applebot-Extended', 'CCBot'];
const CONTROL_TOKENS = new Set(['google-extended', 'applebot-extended']);

const SPEC = {
  ...COMMON_FLAGS,
  start: { type: 'list', placeholder: 'url', desc: 'Start URL(s) for link discovery (default: site.url)' },
  sitemap: { type: 'list', placeholder: 'url', desc: 'Sitemap URL(s) (default: from robots.txt or /sitemap.xml)' },
  'urls-file': { type: 'string', placeholder: 'file', desc: 'Crawl exactly these URLs (one per line); implies --no-follow' },
  'no-sitemap': { type: 'boolean', desc: 'Do not read sitemaps' },
  'no-follow': { type: 'boolean', desc: 'Do not follow links (only start/sitemap/listed URLs)' },
  'follow-query': { type: 'boolean', desc: 'Also follow links that carry query strings' },
  'max-pages': { type: 'int', desc: 'Maximum URLs to fetch', default: 500 },
  'max-depth': { type: 'int', desc: 'Maximum link depth from the start URL', default: 10 },
  concurrency: { type: 'int', desc: 'Parallel requests', default: 4 },
  delay: { type: 'int', placeholder: 'ms', desc: 'Minimum gap between request starts', default: 250 },
  timeout: { type: 'int', placeholder: 'ms', desc: 'Per-request timeout', default: 20000 },
  'user-agent': { type: 'string', placeholder: 'ua', desc: 'User-Agent header (robots.txt rules are matched against it)', default: DEFAULT_UA },
  include: { type: 'string', placeholder: 'regex', desc: 'Only crawl paths matching this JS regex' },
  exclude: { type: 'string', placeholder: 'regex', desc: 'Skip paths matching this JS regex' },
  'include-subdomains': { type: 'boolean', desc: 'Treat subdomains as internal' },
  'ignore-robots': { type: 'boolean', desc: 'Crawl URLs disallowed by robots.txt (your own site only)' },
  'no-save-text': { type: 'boolean', desc: 'Do not write the page-text, JSON-LD and image JSONL files (the link graph is always written)' },
  name: { type: 'string', desc: 'Output name prefix', default: 'crawl' },
  'robots-ua': { type: 'csv', placeholder: 'tokens', desc: `User-agent tokens for the robots.txt decision matrix [default: ${ROBOTS_TEST_AGENTS.join(',')}]` },
  'robots-check': { type: 'list', placeholder: 'path', desc: 'No crawl: print which robots.txt line allows or blocks each path for every --robots-ua token' },
  'compare-ua': { type: 'boolean', desc: 'Also fetch a sample of URLs as a browser, Googlebot, Bingbot and AI bots and compare status and content (CDN/WAF blocking by user agent)' },
  'compare-ua-agents': { type: 'csv', placeholder: 'names', desc: `Agents for --compare-ua (${Object.keys(UA_STRINGS).filter((a) => a !== 'browser').join(', ')}) [default: ${DEFAULT_COMPARE_AGENTS.join(',')}]` },
  'compare-ua-max': { type: 'int', desc: 'URLs tested by --compare-ua (home first, then the most linked pages)', default: 10 },
  'canonical-check-max': { type: 'int', desc: 'Fetch up to N canonical targets that the crawl did not reach (status, redirect, noindex, language)', default: 50 },
};

const HELP = formatHelp({
  usage: ['node scripts/crawl-site.mjs [--max-pages 500] [--start URL] [--sitemap URL] [--compare-ua]', 'node scripts/crawl-site.mjs --robots-check /blog/post/ --robots-check "/search?q=x"   (no crawl)'],
  summary:
    'Crawls your site from its sitemaps and/or start URL (robots.txt-aware, rate-limited) and records per URL: status, redirect chain, ' +
    'canonical, robots meta + X-Robots-Tag, title/description length, H1-H3, word count (CJK aware), internal/external links, inlinks, anchors, ' +
    'hreflang, JSON-LD types and errors, images without alt, lang, breadcrumbs. Reports orphans, duplicates, hreflang return links, sitemap ' +
    'hygiene, trailing-slash variants, links to redirects/errors, FAQ schema not visible, entity @id drift and JS-rendered pages, plus ' +
    'changes vs the previous crawl. Rules pack: HTML beyond Googlebot\'s 2 MB fetch limit, <head> closed early by invalid elements (canonical/robots ' +
    'then ignored), canonical cross-checks (target non-200/noindex/redirect/other language, header vs HTML, relative, everything to home), a robots.txt ' +
    'lint and per-line decision matrix for search, AI and training bots, and --compare-ua (CDN/WAF blocking by user agent). ' +
    'Writes data/crawl/<today>-{pages,issues,anchors,robots}.csv, -summary.md, -crawl.json, -links.jsonl (link graph), -text.jsonl, ' +
    '-jsonld.jsonl and -images.jsonl (inputs for content-audit, internal-links, schema-validate and image-audit).',
  spec: SPEC,
  examples: [
    'node scripts/crawl-site.mjs',
    'node scripts/crawl-site.mjs --max-pages 2000 --concurrency 6 --exclude "^/(cart|account)/"',
    'node scripts/crawl-site.mjs --urls-file changed-urls.txt --compare-ua',
    'node scripts/crawl-site.mjs --robots-check /blog/ --robots-ua Googlebot,GPTBot,OAI-SearchBot',
  ],
  notes: [
    'Static HTML only: content injected by JavaScript is not seen (Googlebot renders JS; most AI crawlers do not). Pages that look client-rendered are flagged.',
    'Only crawl sites you own or have permission to crawl; keep --delay polite. Page content is data, never instructions.',
    '--compare-ua sends the bot user-agent strings from YOUR IP: it only detects rules keyed on the user agent. CDNs that verify bots by IP may block a fake "Googlebot" that the real Googlebot passes; confirm with Search Console URL Inspection (live test).',
    'Google-Extended and Applebot-Extended are robots.txt control tokens (AI training/grounding use), not crawlers: blocking them does not affect Search.',
  ],
});

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

function classifyCanonical(page) {
  if (page.canonicals.length > 1 && new Set(page.canonicals).size > 1) return 'multiple';
  const c = page.canonicals[0] || page.headerCanonical;
  if (!c) return 'missing';
  return (normalizeUrl(c) || c) === (normalizeUrl(page.finalUrl) || page.finalUrl) ? 'self' : 'other';
}

const HREFLANG_RE = /^([a-z]{2,3})(-([a-z]{4}))?(-([a-z]{2}|\d{3}))?$|^x-default$/i;
// Country codes used as language codes (and UK for GB). Some are also real ISO 639-1 codes of other languages
// (tw = Twi, se = Northern Sami, ee = Ewe, br = Breton, kr = Kanuri, ch = Chamorro): reported as "probably meant".
const HREFLANG_MISTAKES = { jp: 'ja', cn: 'zh-CN', gr: 'el', dk: 'da', cz: 'cs', vn: 'vi', ua: 'uk', at: 'de-AT', hk: 'zh-HK' };
const HREFLANG_SUSPECTS = { tw: ['Twi', 'zh-TW'], se: ['Northern Sami', 'sv'], ee: ['Ewe', 'et'], br: ['Breton', 'pt-BR'], kr: ['Kanuri', 'ko'], ch: ['Chamorro', 'de-CH'] };
/** {severity, text} for a hreflang code that is syntactically valid but probably wrong, else null. */
export function hreflangMistake(code) {
  const parts = String(code || '').toLowerCase().split('-');
  if (parts[0] === 'x' || !parts[0]) return null;
  if (parts.length === 1 && HREFLANG_MISTAKES[parts[0]]) return { severity: 'medium', text: `"${code}" is a country code, not a language: use "${HREFLANG_MISTAKES[parts[0]]}"` };
  if (parts.length === 1 && HREFLANG_SUSPECTS[parts[0]]) return { severity: 'low', text: `"${code}" is the language code for ${HREFLANG_SUSPECTS[parts[0]][0]}; if you meant the country, use "${HREFLANG_SUSPECTS[parts[0]][1]}"` };
  if (parts.length > 1 && parts[parts.length - 1] === 'uk') return { severity: 'medium', text: `"${code}": the region code for the United Kingdom is GB ("${parts.slice(0, -1).join('-')}-GB")` };
  return null;
}
// Link texts that say nothing about the target (Lighthouse link-text, plus Chinese equivalents it does not cover).
const GENERIC_ANCHOR_RE = /^(click here|here|read more|learn more|more|this page|this link|link|go|start|點此|點這裡|點我|按這裡|這裡|更多|閱讀更多|了解更多|看更多|詳情|點擊這裡|点此|点击这里|这里|阅读更多|了解更多信息|こちら|詳しくはこちら|もっと見る|여기|더보기)$/i;

function looksClientRendered(html, parsed) {
  if (parsed.stats.wordEq >= 80) return false;
  return /<div[^>]+id=["'](root|app|__next|__nuxt|svelte|q-app)["'][^>]*>\s*<\/div>/i.test(html) || (parsed.stats.wordEq < 30 && /<script[^>]+src=/i.test(html));
}

/** Build issues from crawled records; exported for tests. */
export function analyzeCrawl(records, { sitemapUrls = new Map(), host, includeSubdomains = false, followed = true, complete = true, extraTargets = new Map() } = {}) {
  const issues = [];
  const add = (severity, rule, url, detail) => issues.push({ severity, rule, url, detail });
  const byUrl = new Map();
  for (const r of records) {
    byUrl.set(r.url, r);
    if (r.finalUrl && !byUrl.has(r.finalUrl)) byUrl.set(r.finalUrl, r);
  }
  const internal = (u) => sameSite(u, host, { includeSubdomains });
  // inlinks + anchors
  const inlinkSources = new Map();
  const anchors = new Map();
  for (const r of records) {
    if (!r.links) continue;
    const seen = new Set();
    for (const l of r.links) {
      if (!l.internal || !l.target) continue;
      const t = l.target;
      if (t === r.finalUrl || t === r.url) continue;
      if (!seen.has(t)) {
        seen.add(t);
        if (!inlinkSources.has(t)) inlinkSources.set(t, new Set());
        inlinkSources.get(t).add(r.url);
      }
      const key = `${normalizeText(l.text).slice(0, 80)}\t${t}`;
      anchors.set(key, (anchors.get(key) || 0) + 1);
    }
  }
  const inlinksOf = (u) => (inlinkSources.get(u) || new Set()).size;
  const anchorsByTarget = new Map();
  for (const [k, n] of anchors) {
    const [text, target] = k.split('\t');
    if (!anchorsByTarget.has(target)) anchorsByTarget.set(target, []);
    anchorsByTarget.get(target).push([text || '(no text)', n]);
  }
  for (const r of records) {
    r.inlinks = inlinksOf(r.url) + (r.finalUrl && r.finalUrl !== r.url ? inlinksOf(r.finalUrl) : 0);
    const a = [...(anchorsByTarget.get(r.url) || []), ...(r.finalUrl && r.finalUrl !== r.url ? anchorsByTarget.get(r.finalUrl) || [] : [])].sort((x, y) => y[1] - x[1]);
    r.topAnchors = a.slice(0, 5).map(([t, n]) => `${t} (${n})`).join('; ');
  }
  // per-page rules
  const ok = records.filter((r) => r.status === 200 && r.html);
  for (const r of records) {
    const inSitemap = sitemapUrls.has(r.url);
    if (r.blocked) {
      if (inSitemap) add('high', 'sitemap-blocked-by-robots', r.url, 'In a sitemap but disallowed by robots.txt');
      continue;
    }
    if (r.error) {
      add('high', 'fetch-failed', r.url, r.error);
      continue;
    }
    if (r.status >= 400) add(inSitemap || r.inlinks ? 'high' : 'medium', 'http-error', r.url, `HTTP ${r.status}${r.inlinks ? `, linked from ${r.inlinks} page(s)` : ''}`);
    if (r.redirects > 1) add('medium', 'redirect-chain', r.url, `${r.redirects} hops: ${r.chain}`);
    if (inSitemap) {
      if (r.redirects) add('high', 'sitemap-redirect', r.url, `Sitemap URL redirects to ${r.finalUrl}`);
      else if (r.status !== 200) add('high', 'sitemap-non-200', r.url, `Sitemap URL returns HTTP ${r.status}`);
      if (r.noindex) add('high', 'sitemap-noindex', r.url, 'Sitemap URL is noindex');
      if (r.canonicalStatus === 'other') add('medium', 'sitemap-non-canonical', r.url, `Canonical points to ${r.canonical}`);
    }
    if (r.redirects || !(r.status === 200 && r.html)) continue;
    if (r.metaRefresh) add('medium', 'meta-refresh', r.url, r.metaRefresh);
    if (r.canonicalStatus === 'multiple') add('high', 'canonical-multiple', r.url, `${r.canonicals.length} different canonical tags`);
    if (r.canonicalStatus === 'missing' && !r.noindex) add('low', 'canonical-missing', r.url, 'No rel=canonical');
    if (r.canonicalStatus === 'other') {
      const key = normalizeUrl(r.canonical) || r.canonical;
      const target = byUrl.get(key) || extraTargets.get(key);
      if (target && target.error) add('medium', 'canonical-target-unreachable', r.url, `Canonical ${r.canonical} could not be fetched: ${target.error}`);
      else if (target && (target.status !== 200 || target.redirects)) add('high', 'canonical-to-non-200', r.url, `Canonical ${r.canonical} -> HTTP ${target.status}${target.redirects ? ` (redirects to ${target.finalUrl})` : ''}`);
      else if (target && target.noindex) add('high', 'canonical-to-noindex', r.url, `Canonical ${r.canonical} is noindex`);
      else add('info', 'canonical-other', r.url, `Canonical points to ${r.canonical}`);
      const langOf = (x) => String(x || '').toLowerCase().split(/[-_]/)[0];
      const alt = (r.hreflang || []).find((h) => (normalizeUrl(h.href) || h.href) === key && h.lang !== 'x-default');
      if (alt && r.lang && langOf(alt.lang) !== langOf(r.lang)) add('high', 'canonical-cross-language', r.url, `Canonical points to the "${alt.lang}" alternate ${r.canonical}: each language version should canonicalize to itself and list the others with hreflang`);
      else if (target && target.lang && r.lang && langOf(target.lang) !== langOf(r.lang)) add('high', 'canonical-cross-language', r.url, `Canonical target ${r.canonical} is lang="${target.lang}" but this page is lang="${r.lang}"`);
      if (!internal(key)) add('medium', 'canonical-other-host', r.url, `Canonical points to another host: ${r.canonical}`);
      else {
        try {
          if (new URL(key).protocol !== new URL(r.finalUrl).protocol) add('medium', 'canonical-protocol', r.url, `Canonical uses ${new URL(key).protocol.replace(':', '')} but the page is served over ${new URL(r.finalUrl).protocol.replace(':', '')}: ${r.canonical}`);
        } catch {
          /* ignore */
        }
      }
      if (r.noindex) add('medium', 'noindex-and-canonical', r.url, 'noindex together with a cross-URL canonical sends mixed signals');
    }
    if (r.headerCanonical && r.canonicals && r.canonicals.length) {
      let hc = r.headerCanonical;
      try {
        hc = new URL(r.headerCanonical, r.finalUrl).href;
      } catch {
        /* keep */
      }
      if ((normalizeUrl(hc) || hc) !== (normalizeUrl(r.canonicals[0]) || r.canonicals[0])) add('high', 'canonical-header-mismatch', r.url, `HTTP Link header canonical ${hc} differs from the HTML canonical ${r.canonicals[0]}`);
    }
    if ((r.canonicalsRaw || []).some((raw) => raw && !/^https?:\/\//i.test(raw.trim()))) add('low', 'canonical-relative', r.url, `Relative canonical "${r.canonicalsRaw.find((raw) => raw && !/^https?:\/\//i.test(raw.trim()))}": use an absolute URL so a wrong <base>, host or protocol cannot change it`);
    if (r.over2mb) {
      const b = r.beyond2mb || {};
      const crit = [b.canonical && 'canonical', b.robots && 'robots meta', b.hreflang && `${b.hreflang} hreflang link(s)`, b.jsonLd && `${b.jsonLd} JSON-LD block(s)`, b.internalLinks && `${b.internalLinks} internal link(s)`].filter(Boolean);
      add(crit.length ? 'high' : 'medium', 'html-over-2mb', r.url, `${(r.bytes / 1048576).toFixed(2)} MB of HTML plus headers: Googlebot reads only the first 2 MB${crit.length ? `; past the cut: ${crit.join(', ')}` : '; move inline scripts, styles and base64 images out of the HTML'}`);
    }
    if (r.bodyTruncated) add('medium', 'html-truncated', r.url, `HTML larger than the crawler limit (${Math.round(r.bytes / 1048576)} MB read); later content was not analysed`);
    if (r.headClosedEarly) {
      const tags = [...new Set(r.headAfterClose || [])];
      const crit = tags.filter((t) => ['canonical', 'robots', 'hreflang'].includes(t));
      add(crit.length ? 'high' : tags.length ? 'medium' : 'low', 'head-closed-early', r.url, `${r.headClosedEarly} inside <head> ends the head early${tags.length ? `; parsed into <body> and ignored by Google: ${tags.join(', ')}` : ' (nothing SEO-critical follows it yet)'}`);
    }
    for (const t of [...new Set(r.seoInBody || [])]) add(t === 'description' ? 'low' : 'high', `${t}-in-body`, r.url, `${t === 'robots' ? 'robots meta' : t === 'hreflang' ? 'hreflang link' : t} is in <body>; Google only reads it in <head>`);
    if (r.noscriptInHead && r.noscriptInHead.length) add('info', 'noscript-in-head', r.url, `<noscript> in <head> contains <${r.noscriptInHead.join('>, <')}>: parsers without scripting end <head> there; keep it after the canonical and robots tags or move it to <body>`);
    if (r.noindex) add('info', 'noindex', r.url, `noindex via ${r.noindexSource}${r.inlinks ? `; ${r.inlinks} internal links point here` : ''}`);
    if (!r.title) add('high', 'title-missing', r.url, 'No <title>');
    else if (r.titleWidth > 65) add('low', 'title-too-long', r.url, `${r.titleLength} chars (width ${r.titleWidth}); may be truncated: ${r.title}`);
    else if (r.titleWidth < 15) add('low', 'title-too-short', r.url, r.title);
    if (!r.metaDescription && !r.noindex) add('medium', 'description-missing', r.url, 'No meta description');
    else if (r.descriptionWidth > 170) add('low', 'description-too-long', r.url, `${r.descriptionLength} chars (width ${r.descriptionWidth})`);
    if (!r.h1Count) add('medium', 'h1-missing', r.url, 'No <h1>');
    else if (r.h1Count > 1) add('low', 'h1-multiple', r.url, `${r.h1Count} H1s: ${r.h1}`);
    if (!r.lang) add('low', 'lang-missing', r.url, '<html> has no lang attribute');
    if (r.wordEq < 150 && !r.noindex) add('low', 'thin-content', r.url, `${r.wordEq} word-equivalents (${r.latinWords} words + ${r.cjkChars} CJK chars)`);
    if (r.clientRendered) add('medium', 'js-rendered', r.url, 'Static HTML has almost no content: crawlers that do not run JavaScript (most AI crawlers) see an empty page');
    if (r.jsonldErrors) add('high', 'jsonld-parse-error', r.url, r.jsonldErrorDetail);
    if (r.imagesMissingAlt) add('low', 'img-missing-alt', r.url, `${r.imagesMissingAlt} of ${r.images} images have no alt attribute`);
    if (r.faqNotVisible && r.faqNotVisible.length) add('medium', 'faq-schema-not-visible', r.url, `FAQ schema questions not found in visible text: ${r.faqNotVisible.slice(0, 3).join(' | ')}`);
    if (r.brokenFragments && r.brokenFragments.length) add('low', 'broken-fragment-link', r.url, `In-page link target missing: ${r.brokenFragments.slice(0, 5).join(', ')}`);
    const generic = (r.links || []).filter((l) => l.internal && !l.boiler && GENERIC_ANCHOR_RE.test(String(l.text || '').trim()));
    if (generic.length) add('low', 'anchor-generic', r.url, `${generic.length} body link(s) say only "${[...new Set(generic.map((l) => l.text.trim()))].slice(0, 3).join('", "')}": name the destination instead`);
    for (const l of r.links || []) {
      if (!l.internal || !l.target) continue;
      const t = byUrl.get(l.target);
      if (!t) continue;
      if (t.status >= 400 || (t.redirects && t.finalStatus >= 400)) add('high', 'internal-link-broken', r.url, `Links to ${l.target} (HTTP ${t.redirects ? `${t.status} -> ${t.finalStatus}` : t.status})`);
      else if (t.redirects && t.url === l.target) add('low', 'internal-link-to-redirect', r.url, `Links to ${l.target} which redirects to ${t.finalUrl}`);
    }
    // hreflang (ignored by Google on non-canonical duplicates, so only checked on canonical pages)
    if (r.hreflang && r.hreflang.length && r.canonicalStatus !== 'other') {
      const langs = r.hreflang.map((h) => h.lang);
      for (const h of r.hreflang) if (!HREFLANG_RE.test(h.lang)) add('medium', 'hreflang-invalid-code', r.url, `Invalid hreflang "${h.lang}"`);
      for (const h of r.hreflang) {
        const m = HREFLANG_RE.test(h.lang) ? hreflangMistake(h.lang) : null;
        if (m) add(m.severity, 'hreflang-code-mistake', r.url, m.text);
      }
      if (!r.hreflang.some((h) => (normalizeUrl(h.href) || h.href) === r.finalUrl)) add('low', 'hreflang-no-self', r.url, 'hreflang set does not include the page itself');
      if (!langs.includes('x-default')) add('info', 'hreflang-no-x-default', r.url, 'No x-default alternate');
      for (const h of r.hreflang) {
        const target = byUrl.get(normalizeUrl(h.href) || h.href);
        if (!target || target.url === r.url || target.finalUrl === r.finalUrl) continue;
        if (target.status !== 200 || target.redirects) add('medium', 'hreflang-target-non-200', r.url, `${h.lang} -> ${h.href} (HTTP ${target.status}${target.redirects ? ', redirects' : ''})`);
        else if (target.html && !(target.hreflang || []).some((x) => (normalizeUrl(x.href) || x.href) === r.finalUrl)) add('medium', 'hreflang-no-return', r.url, `${h.lang} -> ${h.href} does not link back`);
      }
    }
  }
  // orphans: only meaningful when every discovered URL was crawled (otherwise inlinks are unknown)
  if (followed && complete) {
    for (const [u] of sitemapUrls) {
      const r = byUrl.get(u);
      if (r && r.status === 200 && !r.noindex && !r.inlinks && (r.depth === null || r.depth > 0)) add('medium', 'orphan', u, 'In a sitemap but no internal links point to it (among crawled pages)');
    }
  }
  // canonical to the home page (common template bug)
  const isHome = (u) => {
    try {
      const x = new URL(u);
      return x.pathname === '/' && !x.search;
    } catch {
      return false;
    }
  };
  const nonHome = ok.filter((r) => !isHome(r.finalUrl || r.url));
  const toHome = nonHome.filter((r) => r.canonicalStatus === 'other' && isHome(normalizeUrl(r.canonical) || r.canonical) && internal(r.canonical));
  if (toHome.length >= 3 && toHome.length >= 0.3 * nonHome.length) add('high', 'canonical-all-to-home', '', `${toHome.length} of ${nonHome.length} pages canonicalize to the home page (template bug?): ${toHome.slice(0, 3).map((r) => shortUrl(r.url)).join(', ')}`);
  else for (const r of toHome) add('medium', 'canonical-to-home', r.url, 'Canonical points to the home page; only do this for true duplicates of the home page');
  // duplicates
  const dup = (field, rule, severity) => {
    const groups = new Map();
    for (const r of ok) {
      if (r.noindex || r.canonicalStatus === 'other' || !r[field]) continue;
      const k = r[field].trim().toLowerCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r.url);
    }
    for (const [k, urls] of groups) if (urls.length > 1) for (const u of urls) add(severity, rule, u, `Same ${field} on ${urls.length} pages: "${k.slice(0, 90)}" (${urls.filter((x) => x !== u).slice(0, 3).join(', ')})`);
  };
  dup('title', 'title-duplicate', 'medium');
  dup('metaDescription', 'description-duplicate', 'low');
  // trailing slash variants
  const variants = new Map();
  const seenUrls = new Set([...records.map((r) => r.url), ...[...sitemapUrls.keys()], ...records.flatMap((r) => (r.links || []).filter((l) => l.internal && l.target).map((l) => l.target))]);
  for (const u of seenUrls) {
    try {
      const x = new URL(u);
      if (x.pathname === '/') continue;
      const key = `${x.origin}${x.pathname.replace(/\/$/, '')}${x.search}`;
      if (!variants.has(key)) variants.set(key, new Set());
      variants.get(key).add(u);
    } catch {
      /* skip */
    }
  }
  for (const [, set] of variants) if (set.size > 1) add('low', 'trailing-slash-variants', [...set][0], `Both forms are used: ${[...set].join(' and ')}`);
  // entity @id drift
  const ids = new Map();
  for (const r of ok) for (const [type, id] of r.entityIds || []) {
    if (!ids.has(type)) ids.set(type, new Map());
    ids.get(type).set(id, (ids.get(type).get(id) || 0) + 1);
  }
  for (const [type, m] of ids) if (m.size > 1) add('medium', 'entity-id-drift', '', `${type} uses ${m.size} different @id values: ${[...m.keys()].slice(0, 4).join(', ')}`);
  // anchor split: same anchor text to different targets
  const anchorTargets = new Map();
  for (const [k, n] of anchors) {
    const [text, target] = k.split('\t');
    if (!text || text.length < 2) continue;
    if (!anchorTargets.has(text)) anchorTargets.set(text, new Map());
    anchorTargets.get(text).set(target, n);
  }
  for (const [text, m] of anchorTargets) {
    const arr = [...m].sort((a, b) => b[1] - a[1]);
    const total = arr.reduce((s, [, n]) => s + n, 0);
    if (arr.length >= 2 && total >= 20 && arr[1][1] / total >= 0.2) add('low', 'anchor-split', '', `Anchor "${text}" points to ${arr.length} URLs: ${arr.slice(0, 3).map(([t, n]) => `${shortUrl(t)} (${n})`).join(', ')}`);
  }
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rule.localeCompare(b.rule));
  const anchorRows = [...anchors].map(([k, n]) => ({ anchor: k.split('\t')[0], target: k.split('\t')[1], links: n })).sort((a, b) => b.links - a.links);
  return { issues, anchorRows };
}

function pageRecord(res, parsed, html, meta) {
  const xr = robotsTokens(res.headers['x-robots-tag']);
  const headerNoindex = xr.includes('noindex') || xr.includes('none');
  const linkHeader = res.headers.link || '';
  const headerCanonical = (/<([^>]+)>\s*;\s*rel="?canonical"?/i.exec(linkHeader) || [])[1] || '';
  const record = {
    ...meta,
    status: res.chain.length ? res.chain[0].status : res.status,
    finalStatus: res.status,
    finalUrl: normalizeUrl(res.finalUrl) || res.finalUrl,
    redirects: res.chain.length,
    chain: res.chain.map((c) => `${c.url} [${c.status}]`).concat(res.chain.length ? [`${res.finalUrl} [${res.status}]`] : []).join(' -> '),
    contentType: res.headers['content-type'] || '',
    lastModified: res.headers['last-modified'] || '',
    xRobotsTag: res.headers['x-robots-tag'] || '',
    responseMs: res.timeMs,
    bytes: res.bytes,
    headerBytes: responseHeaderBytes(res),
    bodyTruncated: Boolean(res.truncated),
    html: Boolean(parsed),
    error: res.error || '',
  };
  record.over2mb = record.bytes + record.headerBytes > GOOGLEBOT_FETCH_LIMIT;
  if (!parsed) return record;
  const fullTextNorm = normalizeText(parsed.fullText);
  const faqQuestions = parsed.jsonLd.flatMap((b) => {
    const walk = (n) => (Array.isArray(n) ? n.flatMap(walk) : n && typeof n === 'object' ? ([].concat(n['@type'] || []).includes('Question') && n.name ? [String(n.name)] : Object.values(n).flatMap(walk)) : []);
    return b.data ? walk(b.data) : [];
  });
  const entityIds = parsed.jsonLd.flatMap((b) => {
    const found = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      const types = [].concat(n['@type'] || []);
      if (n['@id'] && types.some((t) => ['Organization', 'WebSite', 'Person', 'LocalBusiness', 'Corporation'].includes(t))) found.push([types[0], n['@id']]);
      Object.values(n).forEach(walk);
    };
    if (b.data) walk(b.data);
    return found;
  });
  const noindex = parsed.robotsNoindex || headerNoindex;
  Object.assign(record, {
    title: parsed.title,
    titleLength: [...parsed.title].length,
    titleWidth: displayWidth(parsed.title),
    titleCount: parsed.titleCount,
    metaDescription: parsed.metaDescription,
    descriptionLength: [...parsed.metaDescription].length,
    descriptionWidth: displayWidth(parsed.metaDescription),
    canonicals: parsed.canonicals,
    canonical: parsed.canonical || headerCanonical,
    headerCanonical,
    robotsMeta: parsed.robots.join(','),
    noindex,
    noindexSource: parsed.robotsNoindex ? 'meta robots' : headerNoindex ? 'X-Robots-Tag' : '',
    metaRefresh: parsed.metaRefresh,
    lang: parsed.lang,
    h1Count: parsed.h1.length,
    h1: parsed.h1.join(' | '),
    h2: parsed.headings.filter((h) => h.level === 2).map((h) => h.text),
    h3: parsed.headings.filter((h) => h.level === 3).map((h) => h.text),
    wordEq: parsed.stats.wordEq,
    latinWords: parsed.stats.latinWords,
    cjkChars: parsed.stats.cjkChars,
    hreflang: parsed.hreflang.map((h) => ({ lang: h.lang, href: normalizeUrl(h.href) || h.href })),
    jsonldTypes: parsed.jsonLdTypes,
    jsonldErrors: parsed.jsonLdErrors.length,
    jsonldErrorDetail: parsed.jsonLdErrors.join('; '),
    breadcrumb: parsed.jsonLdTypes.includes('BreadcrumbList') || /aria-label=["']breadcrumb/i.test(html),
    images: parsed.images.length,
    imagesMissingAlt: parsed.images.filter((i) => i.alt === null).length,
    faqNotVisible: faqQuestions.filter((q) => !fullTextNorm.includes(normalizeText(q))).slice(0, 10),
    brokenFragments: parsed.brokenFragments || [],
    entityIds,
    clientRendered: looksClientRendered(html, parsed),
    datePublished: parsed.dates.published,
    dateModified: parsed.dates.modified,
  });
  record.canonicalStatus = classifyCanonical({ ...record, canonicals: parsed.canonicals, finalUrl: record.finalUrl });
  record.canonicalsRaw = parsed.canonicalsRaw;
  record.lang = parsed.lang;
  const hd = headDiagnostics(html);
  record.headClosedEarly = hd.closedEarly ? (hd.closedEarly.tag === '#text' ? `text "${hd.closedEarly.text}"` : `<${hd.closedEarly.tag}>`) : '';
  record.headAfterClose = hd.afterClose.map((x) => x.tag);
  record.seoInBody = hd.inBody.map((x) => x.tag);
  record.noscriptInHead = hd.noscriptInHead;
  if (record.over2mb) record.beyond2mb = beyondFetchLimit(html, parsed, GOOGLEBOT_FETCH_LIMIT - record.headerBytes);
  return record;
}

/** Approximate size of the HTTP response headers (status line + "name: value\r\n"). */
export function responseHeaderBytes(res) {
  let n = 17;
  for (const [k, v] of Object.entries(res.headers || {})) n += k.length + String(v).length + 4;
  return n;
}

/** Which SEO-critical parts of the HTML start after `limitBytes` (UTF-8 bytes of the decoded document). */
export function beyondFetchLimit(html, parsed, limitBytes) {
  const src = String(html || '');
  if (Buffer.byteLength(src) <= limitBytes) return { cutChar: src.length, canonical: 0, robots: 0, hreflang: 0, jsonLd: 0, internalLinks: 0 };
  let lo = 0;
  let hi = src.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(src.slice(0, mid)) <= limitBytes) lo = mid;
    else hi = mid - 1;
  }
  const cut = lo;
  const after = (arr) => arr.filter((p) => typeof p === 'number' && p >= cut).length;
  return {
    cutChar: cut,
    canonical: after(parsed.canonicalPos || []),
    robots: after(parsed.robotsPos || []),
    hreflang: after((parsed.hreflang || []).map((h) => h.pos)),
    jsonLd: after((parsed.jsonLd || []).map((b) => b.pos)),
    internalLinks: (parsed.links || []).filter((l) => l.pos >= cut && l.url && (() => {
      try {
        return sameSite(l.url, new URL(parsed.url).hostname);
      } catch {
        return false;
      }
    })()).length,
  };
}

/** Bot challenge / block page signals in a response (empty string = none). */
export function challengeSignal(res) {
  const h = res.headers || {};
  if (h['cf-mitigated']) return `cf-mitigated: ${h['cf-mitigated']}`;
  if (res.status === 402) return 'HTTP 402 (payment required / pay per crawl)';
  const body = String(res.body || '').slice(0, 30000);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body) || [])[1] || '';
  if (/^\s*(just a moment|attention required|access denied|please wait|security checkpoint|verifying you are human|are you a robot|request blocked|forbidden)/i.test(title)) return `challenge page ("${title.trim().slice(0, 40)}")`;
  if ([403, 429, 503].includes(res.status) && /(cf-chl-|challenge-platform|_cf_chl_opt|captcha-delivery|px-captcha|vercel-challenge|ddos-guard|incapsula|akamai)/i.test(body)) return `HTTP ${res.status} with a bot-challenge script`;
  return '';
}

/** Compare one agent's response with the browser baseline; exported for tests. */
export function compareUaResponse(base, res) {
  const title = (r) => normalizeText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(r.body || '')) || [])[1] || '');
  const challenge = challengeSignal(res);
  if (res.error) return { verdict: 'error', detail: res.error, challenge };
  if (challenge) return { verdict: 'challenge', detail: challenge, challenge };
  if (res.status >= 400 && base.status < 400) return { verdict: 'blocked', detail: `HTTP ${res.status} (browser: ${base.status})`, challenge };
  if ((normalizeUrl(res.finalUrl) || res.finalUrl) !== (normalizeUrl(base.finalUrl) || base.finalUrl)) return { verdict: 'redirect-differs', detail: `ends at ${res.finalUrl} (browser: ${base.finalUrl})`, challenge };
  if (res.status !== base.status) return { verdict: 'status-differs', detail: `HTTP ${res.status} (browser: ${base.status})`, challenge };
  const a = base.bytes || 0;
  const b = res.bytes || 0;
  if (Math.max(a, b) > 2000 && Math.abs(a - b) / Math.max(a, b) > 0.5) return { verdict: 'content-differs', detail: `${b} bytes vs ${a} for the browser`, challenge };
  if (title(base) && title(res) !== title(base)) return { verdict: 'content-differs', detail: 'different <title>', challenge };
  return { verdict: 'ok', detail: '', challenge };
}

function robotsCell(d) {
  if (d.allowed) return d.rule ? `allow (L${d.rule.line})` : 'allow';
  return `BLOCK L${d.rule.line} ${d.rule.path}`;
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const origin = ws.origin();
  const host = ws.host();
  const fetchOpts = { userAgent: flags.userAgent, timeoutMs: flags.timeout };
  const include = flags.include ? new RegExp(flags.include) : null;
  const exclude = flags.exclude ? new RegExp(flags.exclude) : null;
  const listed = flags.urlsFile ? collectList([], flags.urlsFile) : [];
  const follow = !flags.noFollow && !listed.length;
  const robotsRes = await fetchRobots(origin, fetchOpts);
  const robots = robotsRes.robots;
  const robotsAgents = flags.robotsUa.length ? flags.robotsUa : ROBOTS_TEST_AGENTS;

  if (flags.robotsCheck.length) {
    if (!robots) throw new UserError(`Could not read ${origin}/robots.txt (${robotsRes.error || `HTTP ${robotsRes.status}`})`);
    out(`${origin}/robots.txt (HTTP ${robotsRes.status}${robotsRes.status >= 400 && robotsRes.status < 500 ? ': treated as allow-all' : ''})`);
    for (const i of robots.issues || []) out(`  lint L${i.line}: ${i.detail}`);
    const rows = [];
    for (const raw of flags.robotsCheck) {
      let p = raw;
      try {
        const u = new URL(raw, origin);
        p = u.pathname + u.search;
      } catch {
        /* keep */
      }
      for (const agent of robotsAgents) {
        const d = robotsDecision(robots, agent, p);
        rows.push([p, agent, d.allowed ? 'allow' : 'BLOCK', d.rule ? `L${d.rule.line}: ${d.rule.allow ? 'Allow' : 'Disallow'}: ${d.rule.path}` : '(no matching rule)', d.agents.join(',') || '(no group)', CONTROL_TOKENS.has(agent.toLowerCase()) ? 'control token, not a crawler' : '']);
      }
    }
    out(textTable(['path', 'user-agent', 'result', 'deciding line', 'group', 'note'], rows));
    return 0;
  }

  const internal = (u) => sameSite(u, host, { includeSubdomains: flags.includeSubdomains });
  const inScope = (u) => {
    if (!internal(u)) return false;
    let p = u;
    try {
      const x = new URL(u);
      p = x.pathname + x.search;
    } catch {
      return false;
    }
    if (include && !include.test(p)) return false;
    if (exclude && exclude.test(p)) return false;
    return true;
  };

  let sitemapUrls = new Map();
  let sitemapInfo = [];
  if (!flags.noSitemap && !listed.length) {
    const sms = flags.sitemap.length ? flags.sitemap : await discoverSitemaps(origin, robots, fetchOpts);
    if (sms.length) {
      log(`Reading ${sms.length} sitemap(s)...`);
      const col = await collectSitemapUrls(sms, { fetchOpts, maxSitemaps: 200, maxUrls: 200000 });
      sitemapInfo = col.sitemaps;
      for (const u of col.urls) sitemapUrls.set(normalizeUrl(u.loc) || u.loc, u);
    } else log('No sitemap found; crawling by links only.');
  }

  const starts = (flags.start.length ? flags.start : [ws.siteUrl()]).map((u) => normalizeUrl(u) || u);
  const queue = [];
  const queued = new Set();
  const enqueue = (url, depth, source) => {
    const u = normalizeUrl(url);
    if (!u || queued.has(u) || !inScope(u)) return;
    queued.add(u);
    queue.push({ url: u, depth, source });
  };
  if (listed.length) listed.forEach((u) => enqueue(u, null, 'list'));
  else {
    starts.forEach((u) => enqueue(u, 0, 'start'));
    for (const u of sitemapUrls.keys()) enqueue(u, null, 'sitemap');
  }

  const records = [];
  const textOut = [];
  const linksOut = [];
  const jsonldOut = [];
  const imagesOut = [];
  const wait = rateLimiter(flags.delay);
  let next = 0;
  let fetched = 0;
  const started = Date.now();
  const worker = async () => {
    while (fetched < flags.maxPages) {
      // prefer start/sitemap/list items, then discovered links by depth
      if (next >= queue.length) {
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const item = queue[next++];
      let p = '/';
      try {
        const x = new URL(item.url);
        p = x.pathname + x.search;
      } catch {
        /* keep */
      }
      if (!flags.ignoreRobots && robots && !robotsAllows(robots, flags.userAgent, p)) {
        records.push({ url: item.url, depth: item.depth, source: item.source, blocked: true, status: 0, finalUrl: item.url, redirects: 0, html: false, inSitemap: sitemapUrls.has(item.url) });
        continue;
      }
      fetched++;
      active++;
      await wait();
      const res = await fetchPage(item.url, { ...fetchOpts, maxBytes: 8 * 1024 * 1024 });
      active--;
      const finalUrl = normalizeUrl(res.finalUrl) || res.finalUrl;
      if (res.chain.length && internal(res.finalUrl)) enqueue(finalUrl, item.depth === null ? null : item.depth, 'redirect-target');
      const htmlOk = !res.error && !res.chain.length && res.status === 200 && isHtml(res) && internal(res.finalUrl);
      const parsed = htmlOk ? parseHtml(res.body || '', res.finalUrl) : null;
      const rec = pageRecord(res, parsed, htmlOk ? res.body : '', { url: item.url, depth: item.depth, source: item.source, inSitemap: sitemapUrls.has(item.url), sitemapLastmod: sitemapUrls.has(item.url) ? sitemapUrls.get(item.url).lastmod : '' });
      if (parsed) {
        const links = [];
        let internalCount = 0;
        let externalCount = 0;
        for (const l of parsed.links) {
          if (!l.url || l.fragmentOnly) continue;
          const isInt = internal(l.url);
          if (isInt) internalCount++;
          else externalCount++;
          const target = isInt ? normalizeUrl(l.url) : null;
          links.push({ target, url: isInt ? target : l.url, internal: isInt, text: l.text, nofollow: l.nofollow, boiler: l.boiler, rel: l.rel });
          if (follow && isInt && target && !l.nofollow) {
            const hasQuery = target.includes('?');
            const nextDepth = (item.depth === null ? 1 : item.depth + 1);
            if ((!hasQuery || flags.followQuery) && nextDepth <= flags.maxDepth) enqueue(target, nextDepth, 'link');
          }
        }
        rec.links = links;
        rec.internalLinks = internalCount;
        rec.externalLinks = externalCount;
        linksOut.push({ url: item.url, finalUrl, depth: item.depth, links: links.map((l) => ({ url: l.url, internal: l.internal, text: l.text.slice(0, 200), boiler: l.boiler, nofollow: l.nofollow, rel: l.rel })) });
        if (!flags.noSaveText) {
          textOut.push(JSON.stringify({ url: item.url, finalUrl, status: res.status, title: parsed.title, description: parsed.metaDescription, canonical: rec.canonical, lang: parsed.lang, noindex: rec.noindex, h1: parsed.h1, headings: parsed.contentHeadings.map((h) => ({ level: h.level, text: h.text })), paragraphs: parsed.contentParagraphs, blocks: parsed.contentBlocks, text: parsed.text, links: links.filter((l) => l.internal && !l.boiler).map((l) => ({ url: l.target, text: l.text })), datePublished: parsed.dates.published, dateModified: parsed.dates.modified, jsonldTypes: parsed.jsonLdTypes, faqQuestions: parsed.faqQuestions, tables: parsed.counts.tables, lists: parsed.counts.lists }));
          const structured = parsed.jsonLd.length > 0 || parsed.microdataTypes.length > 0;
          jsonldOut.push(JSON.stringify({
            url: item.url, finalUrl, status: res.status, lang: parsed.lang, title: parsed.title, canonical: rec.canonical, noindex: rec.noindex, h1: parsed.h1,
            blocks: parsed.jsonLd.map((b) => ({ types: b.types, error: b.error, data: b.data, ...(b.raw ? { raw: b.raw } : {}) })),
            microdataTypes: parsed.microdataTypes,
            visibleText: structured ? parsed.fullText.slice(0, 200000) : '',
            links: structured ? parsed.links.filter((l) => l.url).map((l) => ({ url: l.url, text: l.text.slice(0, 120), boiler: l.boiler })) : [],
          }));
          if (parsed.images.length || parsed.og.image) {
            imagesOut.push(JSON.stringify({ url: item.url, finalUrl, noindex: rec.noindex, ogImage: parsed.og.image || '', og: parsed.og, twitter: parsed.twitter, robots: [...parsed.robots, ...robotsTokens(res.headers['x-robots-tag'])], preconnects: parsed.preconnects, preloads: parsed.preloads, images: parsed.images.map(({ pos, ...img }) => img) }));
          }
        }
      }
      records.push(rec);
      if (fetched % 25 === 0) log(`  ${fetched} fetched, ${queue.length - next} queued (${Math.round((Date.now() - started) / 1000)}s)`);
    }
  };
  let active = 0;
  log(`Crawling ${origin} (max ${flags.maxPages} pages, ${flags.concurrency} parallel, ${flags.delay}ms gap${follow ? ', following links' : ''})...`);
  await Promise.all(Array.from({ length: flags.concurrency }, worker));
  const notFetched = queue.length - next;

  // canonical targets the crawl did not reach
  const crawledKeys = new Set(records.flatMap((r) => [r.url, r.finalUrl]));
  const canonicalTargets = [...new Set(records.filter((r) => r.canonicalStatus === 'other' && r.canonical).map((r) => normalizeUrl(r.canonical) || r.canonical))].filter((u) => /^https?:/i.test(u) && !crawledKeys.has(u) && internal(u));
  const extraTargets = new Map();
  if (canonicalTargets.length && flags.canonicalCheckMax > 0) {
    log(`Checking ${Math.min(canonicalTargets.length, flags.canonicalCheckMax)} canonical target(s) outside the crawl...`);
    await mapLimit(canonicalTargets.slice(0, flags.canonicalCheckMax), flags.concurrency, async (u) => {
      await wait();
      const res = await fetchPage(u, { ...fetchOpts, maxBytes: 3 * 1024 * 1024 });
      const ok = !res.error && !res.chain.length && res.status === 200 && isHtml(res);
      const parsed = ok ? parseHtml(res.body || '', res.finalUrl) : null;
      const xr = robotsTokens(res.headers['x-robots-tag']);
      extraTargets.set(u, { url: u, status: res.chain.length ? res.chain[0].status : res.status, finalUrl: res.finalUrl, redirects: res.chain.length, noindex: Boolean(parsed && parsed.robotsNoindex) || xr.includes('noindex') || xr.includes('none'), lang: parsed ? parsed.lang : '', error: res.error || '' });
    });
  }

  const { issues, anchorRows } = analyzeCrawl(records, { sitemapUrls, host, includeSubdomains: flags.includeSubdomains, followed: follow, complete: notFetched === 0, extraTargets });
  for (const sm of sitemapInfo) if (sm.error) issues.unshift({ severity: 'high', rule: 'sitemap-error', url: sm.url, detail: sm.error });
  if (robotsRes.status >= 500 || robotsRes.error) issues.unshift({ severity: 'high', rule: 'robots-unreachable', url: `${origin}/robots.txt`, detail: robotsRes.error || `HTTP ${robotsRes.status}` });
  for (const i of (robots && robots.issues) || []) issues.push({ severity: i.severity, rule: i.rule, url: `${origin}/robots.txt`, detail: i.detail });

  // robots.txt decision matrix per user agent
  const robotsRows = [];
  const robotsSummary = [];
  if (robots && robotsRes.status === 200) {
    const urls = [...new Set([...records.filter((r) => !r.error).map((r) => r.url), ...sitemapUrls.keys()])].slice(0, 20000);
    const indexableish = new Set([...sitemapUrls.keys(), ...records.filter((r) => r.status === 200 && r.html && !r.noindex).map((r) => r.url)]);
    const perAgent = new Map(robotsAgents.map((a) => [a, { blocked: 0, blockedIndexable: 0, lines: new Map() }]));
    for (const u of urls) {
      let p = '/';
      try {
        const x = new URL(u);
        p = x.pathname + x.search;
      } catch {
        continue;
      }
      const row = { url: u };
      for (const agent of robotsAgents) {
        const d = robotsDecision(robots, agent, p);
        row[agent] = robotsCell(d);
        if (!d.allowed) {
          const st = perAgent.get(agent);
          st.blocked++;
          // the generic "*" group is already covered by sitemap-blocked-by-robots; report agent-specific groups
          if (indexableish.has(u) && !d.agents.includes('*')) st.blockedIndexable++;
          const k = `L${d.rule.line} ${d.rule.allow ? 'Allow' : 'Disallow'}: ${d.rule.path}`;
          st.lines.set(k, (st.lines.get(k) || 0) + 1);
        }
      }
      robotsRows.push(row);
    }
    for (const [agent, st] of perAgent) {
      const lines = [...st.lines].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      robotsSummary.push({ agent, blocked: st.blocked, blockedIndexable: st.blockedIndexable, of: urls.length, lines });
      // blockedIndexable counts only URLs blocked by a group naming this agent (not the generic "*" group)
      if (!st.blockedIndexable) continue;
      const token = agent.toLowerCase();
      const control = CONTROL_TOKENS.has(token);
      const search = /^(googlebot|bingbot)$/.test(token);
      const answer = /^(oai-searchbot|chatgpt-user|perplexitybot|perplexity-user|claude-searchbot|claude-user|applebot|duckassistbot)$/.test(token);
      const severity = search ? 'high' : answer ? 'medium' : 'info';
      const why = control ? ' (control token, not a crawler: affects AI training/grounding use only, not Search)' : search || answer ? '' : ' (training crawler: a policy choice, it does not remove you from AI answers)';
      issues.push({ severity, rule: 'robots-blocks-agent', url: `${origin}/robots.txt`, detail: `${agent} is blocked on ${st.blockedIndexable} indexable URL(s) by ${lines.slice(0, 2).join('; ')}${why}` });
    }
  }

  // same URLs as different user agents (CDN/WAF blocking)
  const uaRows = [];
  if (flags.compareUa) {
    const agents = (flags.compareUaAgents.length ? flags.compareUaAgents : DEFAULT_COMPARE_AGENTS).map((a) => a.toLowerCase());
    for (const a of agents) if (!UA_STRINGS[a] || a === 'browser') throw new UserError(`Unknown --compare-ua-agents "${a}" (use: ${Object.keys(UA_STRINGS).filter((x) => x !== 'browser').join(', ')})`);
    const home = normalizeUrl(ws.siteUrl()) || ws.siteUrl();
    const pool = records.filter((r) => r.status === 200 && r.html && !r.redirects).sort((a, b) => (b.inlinks || 0) - (a.inlinks || 0)).map((r) => r.url);
    const sample = [...new Set([home, ...pool])].slice(0, Math.max(1, flags.compareUaMax));
    log(`Comparing ${sample.length} URL(s) as browser + ${agents.join(', ')} (user agent simulated from this machine)...`);
    for (const u of sample) {
      await wait();
      const base = await fetchPage(u, { ...fetchOpts, userAgent: UA_STRINGS.browser, maxBytes: 3 * 1024 * 1024 });
      uaRows.push({ url: u, agent: 'browser', status: base.status, final_url: base.finalUrl, bytes: base.bytes, verdict: base.error ? 'error' : 'baseline', detail: base.error || '', robots: '' });
      let path = '/';
      try {
        const x = new URL(u);
        path = x.pathname + x.search;
      } catch {
        /* keep */
      }
      for (const agent of agents) {
        await wait();
        const res = await fetchPage(u, { ...fetchOpts, userAgent: UA_STRINGS[agent], maxBytes: 3 * 1024 * 1024 });
        const cmp = compareUaResponse(base, res);
        const token = ROBOTS_TEST_AGENTS.find((t) => t.toLowerCase() === agent) || agent;
        const rd = robots ? robotsDecision(robots, token, path) : { allowed: true, rule: null };
        uaRows.push({ url: u, agent, status: res.status, final_url: res.finalUrl, bytes: res.bytes, verdict: cmp.verdict, detail: cmp.detail, robots: robotsCell(rd) });
        if (cmp.verdict !== 'ok' && !base.error && base.status < 400) {
          const answerBot = ANSWER_AGENTS.has(agent);
          const sev = ['blocked', 'challenge'].includes(cmp.verdict) ? (answerBot ? 'high' : 'info') : 'medium';
          issues.push({ severity: sev, rule: ['blocked', 'challenge', 'error'].includes(cmp.verdict) ? 'ua-blocked' : 'ua-response-differs', url: u, detail: `${agent}: ${cmp.verdict} - ${cmp.detail}${rd.allowed ? '' : ' (robots.txt also blocks it)'}${answerBot ? '' : ' (training crawler: may be intended)'}; simulated user agent from this IP, confirm before acting` });
        }
      }
    }
  }
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rule.localeCompare(b.rule));

  // changes vs previous crawl
  const prevFile = ws.listData('crawl', /-crawl\.json$/).find((f) => !f.includes(`${ws.today()}-${flags.name}-crawl.json`));
  let changes = null;
  if (prevFile) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
      const prevMap = new Map((prev.pages || []).map((p) => [p.url, p]));
      const curMap = new Map(records.map((p) => [p.url, p]));
      const fields = ['status', 'title', 'canonical', 'noindex', 'h1', 'metaDescription', 'finalUrl'];
      const changed = [];
      for (const [u, p] of curMap) {
        const q = prevMap.get(u);
        if (!q) continue;
        for (const f of fields) if (String(p[f] ?? '') !== String(q[f] ?? '')) changed.push({ url: u, field: f, before: String(q[f] ?? ''), after: String(p[f] ?? '') });
      }
      changes = { previous: prevFile, added: [...curMap.keys()].filter((u) => !prevMap.has(u)).length, removed: [...prevMap.keys()].filter((u) => !curMap.has(u)).length, changed };
    } catch {
      changes = null;
    }
  }

  const prefix = flags.name;
  const pagesCsv = writeCsvFile(ws.dataFile('crawl', `${prefix}-pages`, 'csv'), records.map((r) => ({
    url: r.url, final_url: r.finalUrl, status: r.blocked ? 'blocked-by-robots' : r.error ? `error: ${r.error}` : r.status, redirects: r.redirects, redirect_chain: r.chain || '', in_sitemap: r.inSitemap ? 'yes' : '', depth: r.depth ?? '', indexable: r.status === 200 && r.html && !r.noindex && r.canonicalStatus !== 'other' ? 'yes' : 'no',
    canonical: r.canonical || '', canonical_status: r.canonicalStatus || '', robots_meta: r.robotsMeta || '', x_robots_tag: r.xRobotsTag || '', title: r.title || '', title_length: r.titleLength ?? '', title_width: r.titleWidth ?? '',
    meta_description: r.metaDescription || '', description_length: r.descriptionLength ?? '', h1_count: r.h1Count ?? '', h1: r.h1 || '', h2: (r.h2 || []).slice(0, 12).join(' | '), h3: (r.h3 || []).slice(0, 12).join(' | '),
    word_eq: r.wordEq ?? '', latin_words: r.latinWords ?? '', cjk_chars: r.cjkChars ?? '', internal_links: r.internalLinks ?? '', external_links: r.externalLinks ?? '', inlinks: r.inlinks ?? '', top_anchors: r.topAnchors || '',
    hreflang: (r.hreflang || []).map((h) => `${h.lang}=${h.href}`).join(' | '), jsonld_types: (r.jsonldTypes || []).join(' '), jsonld_errors: r.jsonldErrors ?? '', breadcrumb: r.breadcrumb ? 'yes' : '', images: r.images ?? '', images_missing_alt: r.imagesMissingAlt ?? '',
    lang: r.lang || '', client_rendered: r.clientRendered ? 'yes' : '', date_published: r.datePublished || '', date_modified: r.dateModified || '', sitemap_lastmod: r.sitemapLastmod || '', last_modified_header: r.lastModified || '', response_ms: r.responseMs ?? '', bytes: r.bytes ?? '',
    head_closed_early: r.headClosedEarly || '', over_2mb: r.over2mb ? 'yes' : '',
  })));
  const issuesCsv = writeCsvFile(ws.dataFile('crawl', `${prefix}-issues`, 'csv'), issues, ['severity', 'rule', 'url', 'detail']);
  const anchorsCsv = writeCsvFile(ws.dataFile('crawl', `${prefix}-anchors`, 'csv'), anchorRows, ['anchor', 'target', 'links']);
  const jsonPath = writeJson(ws.dataFile('crawl', `${prefix}-crawl`, 'json'), {
    meta: { origin, startedAt: new Date(started).toISOString(), durationSec: Math.round((Date.now() - started) / 1000), fetched, notFetched, maxPages: flags.maxPages, userAgent: flags.userAgent, robots: robotsRes.status, sitemaps: sitemapInfo, sitemapUrls: sitemapUrls.size, followed: follow, canonicalTargetsChecked: extraTargets.size },
    pages: records.map(({ links, ...rest }) => ({ ...rest, internalLinkTargets: (links || []).filter((l) => l.internal).length })),
    canonicalTargets: [...extraTargets.values()],
  });
  const linksPath = linksOut.length ? writeText(ws.dataFile('crawl', `${prefix}-links`, 'jsonl'), `${linksOut.map((l) => JSON.stringify(l)).join('\n')}\n`) : '';
  let textPath = '';
  let jsonldPath = '';
  let imagesPath = '';
  if (!flags.noSaveText && textOut.length) textPath = writeText(ws.dataFile('crawl', `${prefix}-text`, 'jsonl'), `${textOut.join('\n')}\n`);
  if (!flags.noSaveText && jsonldOut.length) jsonldPath = writeText(ws.dataFile('crawl', `${prefix}-jsonld`, 'jsonl'), `${jsonldOut.join('\n')}\n`);
  if (!flags.noSaveText && imagesOut.length) imagesPath = writeText(ws.dataFile('crawl', `${prefix}-images`, 'jsonl'), `${imagesOut.join('\n')}\n`);
  const robotsCsv = robotsRows.length ? writeCsvFile(ws.dataFile('crawl', `${prefix}-robots`, 'csv'), robotsRows, ['url', ...robotsAgents]) : '';
  const uaCsv = uaRows.length ? writeCsvFile(ws.dataFile('crawl', `${prefix}-ua-compare`, 'csv'), uaRows, ['url', 'agent', 'status', 'final_url', 'bytes', 'verdict', 'detail', 'robots']) : '';

  const counts = {};
  for (const i of issues) counts[`${i.severity}|${i.rule}`] = (counts[`${i.severity}|${i.rule}`] || 0) + 1;
  const statusCounts = {};
  for (const r of records) {
    const k = r.blocked ? 'blocked' : r.error ? 'error' : String(r.status);
    statusCounts[k] = (statusCounts[k] || 0) + 1;
  }
  const L = [];
  L.push(`# Crawl summary: ${origin} (${ws.today()})`, '');
  L.push(`- Fetched ${fetched} URLs in ${Math.round((Date.now() - started) / 1000)}s${notFetched > 0 ? `; ${notFetched} more discovered but not fetched (raise --max-pages)` : ''}`);
  L.push(`- Sitemaps: ${sitemapInfo.length} file(s), ${sitemapUrls.size} URLs; robots.txt HTTP ${robotsRes.status || robotsRes.error}`);
  L.push(`- Status codes: ${Object.entries(statusCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  L.push(`- Indexable 200 pages: ${records.filter((r) => r.status === 200 && r.html && !r.noindex && r.canonicalStatus !== 'other').length}; noindex: ${records.filter((r) => r.noindex).length}; client-rendered: ${records.filter((r) => r.clientRendered).length}`);
  L.push('- Static HTML only: anything injected by JavaScript is not visible here.');
  if (notFetched > 0 && follow) L.push('- Orphan check skipped: the crawl stopped before covering every discovered URL (raise --max-pages).');
  L.push('');
  L.push('## Issues by rule', '');
  L.push(mdTable([{ label: 'Severity', key: 's' }, { label: 'Rule', key: 'r' }, { label: 'Count', key: 'n', align: 'right' }, { label: 'Example', key: 'e' }], Object.entries(counts).map(([k, n]) => {
    const [s, r] = k.split('|');
    const ex = issues.find((i) => i.severity === s && i.rule === r);
    return { s, r, n, e: `${ex.url ? `${shortUrl(ex.url, origin)}: ` : ''}${ex.detail.slice(0, 110)}` };
  }).sort((a, b) => SEVERITY_ORDER[a.s] - SEVERITY_ORDER[b.s] || b.n - a.n)));
  const orphans = issues.filter((i) => i.rule === 'orphan');
  if (orphans.length) L.push('## Orphan pages (in sitemap, no internal links)', '', ...orphans.slice(0, 30).map((o) => `- ${o.url}`), '');
  if (robotsSummary.length) {
    L.push('## robots.txt decisions by user agent', '', '_Google-Extended and Applebot-Extended are control tokens (AI training/grounding use), not crawlers. Full matrix: -robots.csv._', '');
    L.push(mdTable([{ label: 'User agent', key: 'agent' }, { label: 'Blocked URLs', align: 'right', value: (x) => `${x.blocked}/${x.of}` }, { label: 'Indexable blocked by its own group', align: 'right', key: 'blockedIndexable' }, { label: 'Deciding lines', value: (x) => x.lines.slice(0, 3).join('; ') || '-' }], robotsSummary));
  }
  if (uaRows.length) {
    L.push('## Same URLs as different user agents', '', '_User-agent strings sent from this machine: only rules keyed on the user agent are detected. CDNs that verify bots by IP can block a fake Googlebot that the real one passes; confirm with Search Console URL Inspection (live test) or the bot\'s own tools._', '');
    L.push(mdTable([{ label: 'URL', value: (r) => shortUrl(r.url, origin) }, { label: 'Agent', key: 'agent' }, { label: 'Status', key: 'status', align: 'right' }, { label: 'Bytes', key: 'bytes', align: 'right' }, { label: 'Verdict', key: 'verdict' }, { label: 'Detail', key: 'detail' }, { label: 'robots.txt', key: 'robots' }], uaRows.filter((r) => r.verdict !== 'ok').slice(0, 60), { empty: 'Every agent got the same response as the browser.' }));
  }
  if (changes) {
    L.push(`## Changes since previous crawl (${changes.previous.split('/').pop()})`, '', `${changes.added} new URLs, ${changes.removed} URLs no longer crawled, ${changes.changed.length} field changes.`, '');
    L.push(mdTable([{ label: 'URL', value: (c) => shortUrl(c.url, origin) }, { label: 'Field', key: 'field' }, { label: 'Before', value: (c) => c.before.slice(0, 80) }, { label: 'After', value: (c) => c.after.slice(0, 80) }], changes.changed.slice(0, 50)));
  }
  const summaryPath = writeText(ws.dataFile('crawl', `${prefix}-summary`, 'md'), L.join('\n'));

  out(`Crawled ${fetched} URLs from ${origin} (${Object.entries(statusCounts).map(([k, v]) => `${k}:${v}`).join(' ')})`);
  const sev = { high: 0, medium: 0, low: 0, info: 0 };
  for (const i of issues) sev[i.severity]++;
  out(`Issues: ${sev.high} high, ${sev.medium} medium, ${sev.low} low, ${sev.info} info`);
  const topRules = Object.entries(counts).filter(([k]) => !k.startsWith('info')).sort((a, b) => SEVERITY_ORDER[a[0].split('|')[0]] - SEVERITY_ORDER[b[0].split('|')[0]] || b[1] - a[1]).slice(0, 10);
  if (topRules.length) out(textTable(['severity', 'rule', 'count'], topRules.map(([k, n]) => [...k.split('|'), n])));
  if (uaRows.length) out(`User-agent comparison: ${uaRows.filter((r) => !['ok', 'baseline'].includes(r.verdict)).length} of ${uaRows.filter((r) => r.agent !== 'browser').length} bot fetches differ from the browser (simulated UA from this IP).`);
  if (notFetched > 0) out(`Note: ${notFetched} discovered URLs were not fetched (limit --max-pages ${flags.maxPages}).`);
  out('');
  for (const f of [summaryPath, pagesCsv, issuesCsv, anchorsCsv, jsonPath, linksPath, textPath, jsonldPath, imagesPath, robotsCsv, uaCsv].filter(Boolean)) out(`wrote ${f}`);
  return 0;
}

runMain(import.meta.url, main);
