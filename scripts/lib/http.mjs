// HTTP fetching (manual redirects, charset decoding, size/time limits), robots.txt and sitemaps.
import zlib from 'node:zlib';
import { normalizeUrl } from './util.mjs';

export const DEFAULT_UA = 'Mozilla/5.0 (compatible; seo-geo-aeo-agent/1.0; +https://github.com/topics/seo-agent)';

function describeFetchError(e, timeoutMs) {
  if (!e) return 'unknown error';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return `timeout after ${Math.round(timeoutMs / 1000)}s`;
  const code = (e.cause && (e.cause.code || e.cause.errno)) || e.code;
  const map = {
    ENOTFOUND: 'DNS lookup failed (host not found)',
    EAI_AGAIN: 'DNS lookup timed out',
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset',
    ETIMEDOUT: 'connection timed out',
    CERT_HAS_EXPIRED: 'TLS certificate expired',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate chain incomplete',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
  };
  if (code && map[code]) return map[code];
  return `${code ? `${code}: ` : ''}${(e.cause && e.cause.message) || e.message}`;
}

function sniffCharset(buf, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (meta) return meta[1].toLowerCase();
  const xml = /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head);
  if (xml) return xml[1].toLowerCase();
  return 'utf-8';
}

export function decodeBody(buf, contentType) {
  let data = buf;
  if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = zlib.gunzipSync(data);
    } catch {
      /* leave as is */
    }
  }
  const charset = sniffCharset(data, contentType);
  try {
    return new TextDecoder(charset === 'utf8' ? 'utf-8' : charset).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

async function readLimited(res, maxBytes) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      const keep = value.byteLength - (total - maxBytes);
      if (keep > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, keep));
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return { buf: Buffer.concat(chunks), truncated };
}

/**
 * Fetch a URL following redirects manually so the chain is visible.
 * Returns { url, finalUrl, status, chain:[{url,status,location}], headers, body, bytes, truncated, timeMs, error }.
 */
export async function fetchPage(url, opts = {}) {
  const { userAgent = DEFAULT_UA, timeoutMs = 20000, maxRedirects = 10, method = 'GET', headers = {}, maxBytes = 10 * 1024 * 1024, followRedirects = true, decode = true } = opts;
  const chain = [];
  const started = Date.now();
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res;
    try {
      res = await fetch(current, {
        method,
        redirect: 'manual',
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': opts.acceptLanguage || 'en;q=0.8,*;q=0.5', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { url, finalUrl: current, status: 0, chain, headers: {}, body: null, bytes: 0, truncated: false, timeMs: Date.now() - started, error: describeFetchError(e, timeoutMs) };
    }
    const hdrs = {};
    res.headers.forEach((v, k) => {
      hdrs[k.toLowerCase()] = v;
    });
    if (followRedirects && res.status >= 300 && res.status < 400 && hdrs.location) {
      let next;
      try {
        next = new URL(hdrs.location, current).href;
      } catch {
        return { url, finalUrl: current, status: res.status, chain, headers: hdrs, body: null, bytes: 0, truncated: false, timeMs: Date.now() - started, error: `invalid redirect location "${hdrs.location}"` };
      }
      chain.push({ url: current, status: res.status, location: next });
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      if (chain.some((c) => c.url === next)) {
        return { url, finalUrl: next, status: res.status, chain, headers: hdrs, body: null, bytes: 0, truncated: false, timeMs: Date.now() - started, error: 'redirect loop' };
      }
      current = next;
      continue;
    }
    let body = null;
    let bytes = 0;
    let truncated = false;
    if (method !== 'HEAD') {
      try {
        const r = await readLimited(res, maxBytes);
        bytes = r.buf.length;
        truncated = r.truncated;
        body = decode ? decodeBody(r.buf, hdrs['content-type']) : r.buf;
      } catch (e) {
        return { url, finalUrl: current, status: res.status, chain, headers: hdrs, body: null, bytes, truncated, timeMs: Date.now() - started, error: `body read failed: ${describeFetchError(e, timeoutMs)}` };
      }
    }
    return { url, finalUrl: current, status: res.status, chain, headers: hdrs, body, bytes, truncated, timeMs: Date.now() - started, error: '' };
  }
  return { url, finalUrl: current, status: 0, chain, headers: {}, body: null, bytes: 0, truncated: false, timeMs: Date.now() - started, error: `more than ${maxRedirects} redirects` };
}

export const isHtml = (res) => /text\/html|application\/xhtml/i.test(res.headers?.['content-type'] || '') || (!res.headers?.['content-type'] && /^\s*</.test(res.body || ''));

// ---------- robots.txt ----------
const ROBOTS_FIELDS = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay']);
const ROBOTS_OTHER_KNOWN = new Map([
  ['host', 'Yandex-only directive; ignored by Google and Bing'],
  ['clean-param', 'Yandex-only directive; ignored by Google and Bing'],
  ['noindex', 'not supported in robots.txt (Google dropped it in 2019); use meta robots or X-Robots-Tag'],
  ['content-signal', 'content-usage signal (not a crawl rule); crawlers decide whether to honor it'],
  ['request-rate', 'non-standard; ignored by Google'],
  ['visit-time', 'non-standard; ignored by Google'],
]);

/**
 * Parse robots.txt keeping line numbers. Returns { groups:[{agents, rules:[{allow,path,line}], crawlDelay, line}],
 * sitemaps:[url], sitemapLines:[{url,line}], issues:[{line, severity, rule, detail}] } (issues = Lighthouse-style lint).
 */
export function parseRobotsTxt(text) {
  const groups = [];
  const sitemaps = [];
  const sitemapLines = [];
  const issues = [];
  let current = null;
  let lastWasAgent = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (Buffer.byteLength(src) > 500 * 1024) issues.push({ line: 0, severity: 'medium', rule: 'robots-too-large', detail: `robots.txt is ${Math.round(Buffer.byteLength(src) / 1024)} KiB; Google ignores everything after 500 KiB` });
  src.split(/\r?\n/).forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    const idx = line.indexOf(':');
    if (idx < 0) {
      issues.push({ line: lineNo, severity: 'low', rule: 'robots-syntax', detail: `Line ${lineNo} has no "field: value" separator: "${line.slice(0, 60)}"` });
      return;
    }
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null, line: lineNo };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (field === 'sitemap') {
      if (value) {
        sitemaps.push(value);
        sitemapLines.push({ url: value, line: lineNo });
        if (!/^https?:\/\//i.test(value)) issues.push({ line: lineNo, severity: 'medium', rule: 'robots-sitemap-relative', detail: `Sitemap must be an absolute URL (line ${lineNo}: "${value}")` });
      }
      return;
    }
    if (!ROBOTS_FIELDS.has(field)) {
      const known = ROBOTS_OTHER_KNOWN.get(field);
      issues.push({ line: lineNo, severity: known ? 'info' : 'low', rule: 'robots-unknown-directive', detail: `Line ${lineNo}: "${field}"${known ? ` - ${known}` : ' is not a robots.txt directive (typo?)'}` });
      return;
    }
    if (!current) {
      issues.push({ line: lineNo, severity: 'medium', rule: 'robots-rule-before-user-agent', detail: `Line ${lineNo}: "${field}" appears before any User-agent line and is ignored` });
      return;
    }
    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ allow: field === 'allow', path: value, line: lineNo });
      if (value && !/^[/*]/.test(value)) issues.push({ line: lineNo, severity: 'medium', rule: 'robots-pattern', detail: `Line ${lineNo}: pattern "${value}" should start with "/" or "*"` });
      if (value.includes('$') && value.indexOf('$') !== value.length - 1) issues.push({ line: lineNo, severity: 'medium', rule: 'robots-pattern', detail: `Line ${lineNo}: "$" is only meaningful at the end of a pattern ("${value}")` });
    } else if (field === 'crawl-delay') {
      current.crawlDelay = Number(value) || null;
      issues.push({ line: lineNo, severity: 'info', rule: 'robots-crawl-delay', detail: `Line ${lineNo}: Crawl-delay is ignored by Googlebot (Bing and others honor it)` });
    }
  });
  return { groups, sitemaps, sitemapLines, issues };
}

function groupsFor(robots, userAgent) {
  const ua = String(userAgent || '*').toLowerCase();
  let bestLen = -1;
  let matched = [];
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a === '*' || !a) continue;
      if (ua.includes(a)) {
        if (a.length > bestLen) {
          bestLen = a.length;
          matched = [g];
        } else if (a.length === bestLen && !matched.includes(g)) matched.push(g);
      }
    }
  }
  if (matched.length) return matched;
  return robots.groups.filter((g) => g.agents.includes('*'));
}

function ruleToRegex(p) {
  let re = '';
  for (const c of p) re += c === '*' ? '.*' : c === '$' ? '$' : c.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${re}`);
}

/**
 * Google-style evaluation with the deciding line: most specific (longest) matching rule wins; ties go to allow.
 * Returns { allowed, rule: {allow, path, line} | null, agents: [group user-agent tokens used] }.
 */
export function robotsDecision(robots, userAgent, pathAndQuery) {
  if (!robots) return { allowed: true, rule: null, agents: [] };
  const groups = groupsFor(robots, userAgent);
  let best = null;
  let target = pathAndQuery;
  try {
    target = decodeURI(pathAndQuery);
  } catch {
    /* keep raw */
  }
  for (const g of groups) {
    for (const rule of g.rules) {
      if (!rule.path) continue;
      const re = ruleToRegex(rule.path);
      if (!re.test(pathAndQuery) && !re.test(target)) continue;
      const len = rule.path.length;
      if (!best || len > best.len || (len === best.len && rule.allow && !best.rule.allow)) best = { len, rule };
    }
  }
  return { allowed: best ? best.rule.allow : true, rule: best ? best.rule : null, agents: [...new Set(groups.flatMap((g) => g.agents))] };
}

/** Google-style evaluation: most specific (longest) matching rule wins; ties go to allow. */
export function robotsAllows(robots, userAgent, pathAndQuery) {
  return robotsDecision(robots, userAgent, pathAndQuery).allowed;
}

export function robotsCrawlDelay(robots, userAgent) {
  const g = groupsFor(robots || { groups: [] }, userAgent);
  return g.map((x) => x.crawlDelay).find((v) => v) || null;
}

export async function fetchRobots(origin, opts = {}) {
  const res = await fetchPage(`${origin}/robots.txt`, { ...opts, timeoutMs: opts.timeoutMs || 15000 });
  if (res.error) return { status: 0, error: res.error, robots: null, text: '' };
  if (res.status >= 400) return { status: res.status, error: '', robots: parseRobotsTxt(''), text: '' };
  if (res.status !== 200) return { status: res.status, error: `unexpected HTTP ${res.status}`, robots: parseRobotsTxt(''), text: '' };
  return { status: 200, error: '', robots: parseRobotsTxt(res.body), text: res.body };
}

// ---------- sitemaps ----------
const xmlDecode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

function tagValue(block, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block) || new RegExp(`<\\w+:${tag}>([\\s\\S]*?)</\\w+:${tag}>`, 'i').exec(block.replace(/<image:[\s\S]*?<\/image:image>/gi, '').replace(/<video:[\s\S]*?<\/video:video>/gi, ''));
  return m ? xmlDecode(m[1]) : '';
}

export function parseSitemap(text) {
  const src = String(text || '');
  if (/<sitemapindex[\s>]/i.test(src)) {
    const entries = [];
    for (const m of src.matchAll(/<(?:\w+:)?sitemap[\s>]([\s\S]*?)<\/(?:\w+:)?sitemap>/gi)) {
      const loc = tagValue(m[1], 'loc');
      if (loc) entries.push({ loc, lastmod: tagValue(m[1], 'lastmod') });
    }
    return { type: 'index', entries };
  }
  if (/<urlset[\s>]/i.test(src)) {
    const entries = [];
    for (const m of src.matchAll(/<(?:\w+:)?url[\s>]([\s\S]*?)<\/(?:\w+:)?url>/gi)) {
      const loc = tagValue(m[1], 'loc');
      if (!loc) continue;
      const alternates = [...m[1].matchAll(/<xhtml:link[^>]*hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["']/gi)].map((a) => ({ lang: a[1], href: xmlDecode(a[2]) }));
      entries.push({ loc, lastmod: tagValue(m[1], 'lastmod'), alternates });
    }
    return { type: 'urlset', entries };
  }
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => /^https?:\/\//i.test(l))) return { type: 'text', entries: lines.map((loc) => ({ loc, lastmod: '' })) };
  return { type: 'unknown', entries: [] };
}

/**
 * Fetch sitemaps (following indexes) and return unique URL entries.
 * Returns { urls:[{loc,lastmod,sitemap,alternates}], sitemaps:[{url,status,type,count,error}] }.
 */
export async function collectSitemapUrls(startUrls, { fetchOpts = {}, maxSitemaps = 50, maxUrls = 100000, filter } = {}) {
  const queue = [...new Set(startUrls)];
  const seenSitemaps = new Set();
  const sitemaps = [];
  const urls = new Map();
  while (queue.length && seenSitemaps.size < maxSitemaps && urls.size < maxUrls) {
    const sm = queue.shift();
    if (seenSitemaps.has(sm)) continue;
    seenSitemaps.add(sm);
    const res = await fetchPage(sm, { ...fetchOpts, maxBytes: 60 * 1024 * 1024 });
    if (res.error || res.status !== 200) {
      sitemaps.push({ url: sm, status: res.status, type: '', count: 0, error: res.error || `HTTP ${res.status}`, redirected: res.chain.length > 0 });
      continue;
    }
    const parsed = parseSitemap(res.body);
    sitemaps.push({ url: sm, status: res.status, type: parsed.type, count: parsed.entries.length, error: parsed.type === 'unknown' ? 'not a sitemap (no <urlset> or <sitemapindex>)' : '', redirected: res.chain.length > 0, finalUrl: res.finalUrl });
    if (parsed.type === 'index') {
      for (const e of parsed.entries) if (!seenSitemaps.has(e.loc)) queue.push(e.loc);
      continue;
    }
    for (const e of parsed.entries) {
      if (urls.size >= maxUrls) break;
      const loc = normalizeUrl(e.loc, { stripTracking: false }) || e.loc;
      if (filter && !filter(loc)) continue;
      if (!urls.has(loc)) urls.set(loc, { loc, lastmod: e.lastmod || '', sitemap: sm, alternates: e.alternates || [] });
    }
  }
  return { urls: [...urls.values()], sitemaps, truncated: urls.size >= maxUrls || queue.length > 0 };
}

/** Sitemaps from robots.txt, else common default locations that respond with a sitemap. */
export async function discoverSitemaps(origin, robots, fetchOpts = {}) {
  if (robots && robots.sitemaps && robots.sitemaps.length) return [...new Set(robots.sitemaps)];
  const found = [];
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap-index.xml']) {
    const res = await fetchPage(`${origin}${p}`, { ...fetchOpts, timeoutMs: 15000 });
    if (res.status === 200 && !res.error && parseSitemap(res.body).type !== 'unknown') {
      found.push(res.finalUrl);
      break;
    }
  }
  return found;
}
