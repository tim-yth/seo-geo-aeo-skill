// Page facts shared by seo-diff and schema-validate: build-dir walking and file -> URL path mapping, visible FAQ
// detection, clean body text (no nav/aside/site header/footer/script/style/noscript) and the content signature of
// references/10 step 2.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tokenize, parseHtml, decodeEntities, robotsTokens } from './html.mjs';
import { parseSitemap } from './http.mjs';
import { normalizeUrl, bareHost } from './util.mjs';
import { compactKey } from './text.mjs';
import { faqQuestions, walkJsonLd, typesOf, literal, plainText, ARTICLE_TYPES, WEBPAGE_TYPES } from './schema-rules.mjs';

export { plainText };

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);
export const HTML_FILE_RE = /\.html?$/i;
export const ERROR_PAGE_RE = /^(404|410|500|50x|error)(\/index)?\.html?$/i;

/** All files under dir as sorted posix paths relative to dir (symlinks followed once, loops skipped). */
export function listFiles(dir) {
  const found = [];
  const seenDirs = new Set();
  const walk = (abs, rel) => {
    let real = abs;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(abs, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) walk(full, r);
      else if (isFile) found.push(r);
    }
  };
  walk(dir, '');
  return found.sort();
}

/** Build file -> URL path: a/index.html -> /a/, a.html -> /a.html (or /a with cleanUrls); percent-encoded. */
export function fileToUrlPath(rel, { cleanUrls = false } = {}) {
  let p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (/(^|\/)index\.html?$/i.test(p)) p = p.replace(/index\.html?$/i, '');
  else if (cleanUrls) p = p.replace(/\.html?$/i, '');
  p = p.replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23');
  return new URL(`/${p}`, 'http://x').pathname;
}

/** Path + query of a URL (or of a path), percent-encoded the way URL parsing does it. */
export function pathKey(input) {
  try {
    const u = new URL(String(input || '/'), 'http://x');
    return u.pathname + u.search;
  } catch {
    return String(input || '');
  }
}

function keyParts(key) {
  let p = String(key || '/');
  let search = '';
  const q = p.indexOf('?');
  if (q >= 0) {
    search = p.slice(q);
    p = p.slice(0, q);
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep encoded */
  }
  return { p, search };
}

/** Same page under another spelling: without .html, /index.html and the trailing slash (/x.html = /x = /x/), case kept. */
export function strictKey(key) {
  const { p, search } = keyParts(key);
  const s = p.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '').replace(/\/+$/, '');
  return (s || '/') + search;
}

/** Loose page identity: strictKey plus case-insensitive (/X.html = /x/). */
export function normKey(key) {
  const k = strictKey(key);
  const q = k.indexOf('?');
  return q >= 0 ? k.slice(0, q).toLowerCase() + k.slice(q) : k.toLowerCase();
}

const CACHE_PARAM_RE = /^(v|ver|version|cb|cachebust|cachebuster|cache|rev|_)$/i;

/** Absolute URL without fragment, tracking parameters and cache-busting parameters such as ?v=3. */
export function stripCacheParams(input) {
  const n = normalizeUrl(input, { stripTracking: true });
  if (!n) return String(input || '');
  try {
    const u = new URL(n);
    for (const k of [...u.searchParams.keys()]) if (CACHE_PARAM_RE.test(k)) u.searchParams.delete(k);
    const s = u.href;
    return !u.search && s.endsWith('?') ? s.slice(0, -1) : s;
  } catch {
    return n;
  }
}

/** Most common origin among absolute URLs (canonicals, og:url, sitemap locs), or ''. */
export function inferOrigin(urls) {
  const counts = new Map();
  for (const u of urls) {
    try {
      const o = new URL(u).origin;
      if (/^https?:/.test(o)) counts.set(o, (counts.get(o) || 0) + 1);
    } catch {
      /* skip */
    }
  }
  let best = '';
  let n = 0;
  for (const [o, c] of counts) if (c > n) [best, n] = [o, c];
  return best;
}

export function quickCanonicals(html) {
  const found = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) if (/rel=["']?canonical/i.test(m[0])) found.push((/href=["']?([^"'\s>]+)/i.exec(m[0]) || [])[1]);
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) if (/property=["']?og:url/i.test(m[0])) found.push((/content=["']?([^"'\s>]+)/i.exec(m[0]) || [])[1]);
  return found.filter((u) => /^https?:\/\//i.test(u || ''));
}

/** Origin a build directory publishes under: canonicals / og:url / sitemap locs, most common wins. */
export function guessDirOrigin(dir) {
  const files = listFiles(dir);
  const urls = [];
  for (const rel of files.filter((f) => HTML_FILE_RE.test(f)).slice(0, 60)) urls.push(...quickCanonicals(fs.readFileSync(path.join(dir, rel), 'utf8')));
  for (const rel of files.filter((f) => /^sitemap[^/]*\.xml$/i.test(f)).slice(0, 3)) for (const e of parseSitemap(fs.readFileSync(path.join(dir, rel), 'utf8')).entries.slice(0, 50)) urls.push(e.loc);
  return inferOrigin(urls);
}

/**
 * Base path a build directory is published under, from its canonicals: the root index.html points to /repo/ and the
 * other pages to /repo/<their path> (GitHub Pages project sites, docs under /docs/). '' when not consistent.
 */
export function guessDirPrefix(dir, { cleanUrls = false } = {}) {
  const read = (rel) => {
    try {
      return quickCanonicals(fs.readFileSync(path.join(dir, rel), 'utf8'))[0] || '';
    } catch {
      return '';
    }
  };
  const home = read('index.html');
  if (!home) return '';
  const candidate = new URL(home).pathname.replace(/\/+$/, '');
  if (!candidate) return '';
  let agree = 0;
  let total = 0;
  for (const rel of listFiles(dir).filter((f) => HTML_FILE_RE.test(f) && f !== 'index.html' && !ERROR_PAGE_RE.test(f)).slice(0, 25)) {
    const c = read(rel);
    if (!c) continue;
    total++;
    if (normKey(new URL(c).pathname) === normKey(`${candidate}${fileToUrlPath(rel, { cleanUrls })}`)) agree++;
  }
  return (total === 0 || (agree >= Math.min(3, total) && agree >= 0.8 * total)) ? candidate : '';
}

// ---------- body scan: clean text + visible FAQ ----------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption', 'form', 'hr', 'br', 'details', 'summary', 'address', 'fieldset', 'caption', 'option', 'label', 'button']);
const HEAD_OK = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'title', 'noscript', 'noframes', 'style', 'script', 'template', 'html', 'head']);
const SECTIONING = new Set(['section', 'article', 'main', 'aside', 'nav', 'header', 'footer']);
export const FAQ_HEADING_RE = /\b(faqs?|f\.a\.q\.?|frequently asked questions?|common questions|questions (?:and|&) answers|q\s*&\s*a)\b|常見問題|常见问题|問與答|问与答|問答集|よくある(?:ご)?質問|자주\s*묻는\s*질문|preguntas frecuentes|questions fréquentes|häufige fragen|perguntas frequentes|domande frequenti/i;
const KIND_PRIORITY = ['summary', 'dt', 'microdata', 'qclass', 'heading'];
const NOISE_CLASS_RE = /(^|[\s_-])(cta|call-to-action|banner|promo|newsletter|subscribe|signup|related|share|toc)([\s_-]|$)/i;
const isQuestion = (t) => /[?？]\s*$/.test(t);
const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+|\[email\s*protected\]/gi;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const joinText = (parts) => parts.join('').replace(/[ \t\f\r\u00a0\u2002\u2003\u2009]+/g, ' ').replace(/ *\n[\n ]*/g, '\n').trim();

/**
 * One pass over the document. text = visible text outside nav/aside and the site header/footer (header/footer inside
 * main/article count as content; e-mail addresses masked so CDN obfuscation does not count as a change); fullText = all
 * visible text; h1 = H1 texts. faq = visible FAQ items inside the outermost element whose class/id contains "faq" (or
 * itemtype FAQPage), or after an "FAQ" heading until the next heading of the same level or the end of its section;
 * one item kind per block (summary > dt > microdata Question > class*=question > deeper headings; headings inside
 * answers ignored). {count, questions, detected, structural (found by markup, not by the heading heuristic)}.
 */
export function scanBody(html) {
  const textParts = [];
  const fullParts = [];
  const h1 = [];
  const tracked = []; // {name, depth, kind:'boiler'|'mainish'|'container'|'scope'|'answer'|'svg', id?, type?}
  const captures = []; // {kind, name, depth, buf, ctx, level}
  const items = [];
  let inHead = false;
  let sections = 0;
  let region = null;
  let regionSeq = 0;
  let containerSeq = 0;
  const count = (kind) => tracked.filter((t) => t.kind === kind).length;
  const outermost = (kind) => tracked.find((t) => t.kind === kind) || null;
  const innermost = (kind) => {
    for (let i = tracked.length - 1; i >= 0; i--) if (tracked[i].kind === kind) return tracked[i];
    return null;
  };
  const finish = (cap) => {
    const text = clean(cap.buf.join(''));
    const i = captures.indexOf(cap);
    if (i >= 0) captures.splice(i, 1);
    if (cap.kind === 'heading') {
      if (cap.level === 1 && text) h1.push(text);
      if (text && (FAQ_HEADING_RE.test(text) || cap.ctx.faqId) && !cap.ctx.boiler) {
        region = { id: `r${++regionSeq}`, level: cap.level, sections: cap.ctx.sections };
        return;
      }
    }
    if (text && !cap.ctx.boiler && !cap.ctx.inAnswer) items.push({ kind: cap.kind, text, level: cap.level || 0, ...cap.ctx });
  };
  const startCapture = (kind, name, level = 0, extra = {}) => {
    const container = outermost('container');
    captures.push({ kind, name, depth: 1, buf: [], level, ctx: { container: container ? container.id : '', region: region ? region.id : '', regionLevel: region ? region.level : 0, boiler: count('boiler') > 0, inAnswer: count('answer') > 0, sections, ...extra } });
  };
  for (const tok of tokenize(String(html || ''))) {
    if (tok.type === 'text') {
      if (inHead || count('svg')) continue;
      const t = decodeEntities(tok.text);
      fullParts.push(t);
      if (!count('boiler')) textParts.push(t);
      for (const c of captures) c.buf.push(t);
      continue;
    }
    if (tok.type === 'raw') continue;
    const name = tok.name;
    if (tok.type === 'close') {
      if (name === 'head') inHead = false;
      if (count('svg')) {
        if (name === 'svg') for (let i = tracked.length - 1; i >= 0; i--) if (tracked[i].kind === 'svg' && --tracked[i].depth <= 0) tracked.splice(i, 1);
        continue;
      }
      for (const c of captures.slice()) {
        if (c.name !== name) continue;
        c.depth--;
        if (c.depth <= 0) finish(c);
      }
      if (name === 'dl') for (const c of captures.slice()) if (c.kind === 'dt') finish(c);
      for (let i = tracked.length - 1; i >= 0; i--) {
        const t = tracked[i];
        if (t.name !== name) continue;
        t.depth--;
        if (t.depth <= 0) tracked.splice(i, 1);
      }
      if (SECTIONING.has(name) && sections > 0) {
        sections--;
        if (region && sections < region.sections) region = null;
      }
      if (BLOCK.has(name)) {
        textParts.push('\n');
        fullParts.push('\n');
      }
      continue;
    }
    // open tag
    const attrs = tok.attrs || {};
    if (name === 'head') inHead = true;
    else if (name === 'body' || (inHead && !HEAD_OK.has(name))) inHead = false;
    if (name === 'svg' && !tok.selfClosing) {
      const svg = innermost('svg');
      if (svg) svg.depth++;
      else tracked.push({ name, depth: 1, kind: 'svg' });
      continue;
    }
    if (count('svg')) continue;
    if (BLOCK.has(name)) {
      textParts.push('\n');
      fullParts.push('\n');
    }
    if (VOID.has(name) || tok.selfClosing) continue;
    if ((name === 'dt' || name === 'dd') && captures.some((c) => c.kind === 'dt')) for (const c of captures.slice()) if (c.kind === 'dt') finish(c);
    for (const t of tracked) if (t.name === name) t.depth++;
    for (const c of captures) if (c.name === name) c.depth++;
    const mainish = count('mainish') > 0;
    if (name === 'nav' || name === 'aside' || ((name === 'header' || name === 'footer') && !mainish)) {
      tracked.push({ name, depth: 1, kind: 'boiler' });
      region = null;
    }
    if (name === 'main' || name === 'article') tracked.push({ name, depth: 1, kind: 'mainish' });
    if (SECTIONING.has(name)) sections++;
    const cls = `${attrs.class || ''} ${attrs.id || ''}`;
    const itemtype = String(attrs.itemtype || '');
    const level = /^h[1-6]$/.test(name) ? Number(name[1]) : 0;
    if (!level && !['html', 'body', 'main'].includes(name) && (/faq/i.test(cls) || /FAQPage/.test(itemtype))) tracked.push({ name, depth: 1, kind: 'container', id: `c${++containerSeq}` });
    if (!level && (/answer/i.test(attrs.class || '') || NOISE_CLASS_RE.test(attrs.class || ''))) tracked.push({ name, depth: 1, kind: 'answer' });
    if ('itemscope' in attrs) tracked.push({ name, depth: 1, kind: 'scope', type: itemtype });
    if (level) {
      if (region && level <= region.level) region = null;
      startCapture('heading', name, level, { faqId: /faq/i.test(cls) });
    } else if (name === 'summary') startCapture('summary', name);
    else if (name === 'dt') startCapture('dt', name);
    else if (/question(?!s)/i.test(attrs.class || '') && !/answer/i.test(attrs.class || '') && !captures.some((c) => c.kind === 'qclass')) startCapture('qclass', name);
    if (attrs.itemprop === 'name') {
      const scope = innermost('scope');
      if (scope && /schema\.org\/Question/i.test(scope.type)) startCapture('microdata', name);
    }
  }
  for (const c of captures.slice()) finish(c);
  let text = joinText(textParts);
  if (text.includes('@') || text.includes('[email')) text = text.replace(EMAIL_RE, '[email]');
  // group FAQ items by block (outermost container, else heading region) and count one kind per block
  const groups = new Map();
  for (const it of items) {
    const key = it.container || it.region;
    if (!key) continue;
    if (it.kind === 'heading' && (FAQ_HEADING_RE.test(it.text) || it.faqId || (!it.container && it.level <= it.regionLevel))) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const questions = [];
  let structural = false;
  for (const list of groups.values()) {
    const kind = KIND_PRIORITY.find((k) => list.some((x) => x.kind === k));
    if (kind !== 'heading') structural = true;
    let chosen = list.filter((x) => x.kind === kind);
    if (kind === 'heading') {
      // FAQ headings are usually questions: take the level with the most questions (else the top level) and,
      // when most headings there are questions, drop the rest (a trailing CTA or topic heading)
      const levels = [...new Set(chosen.map((x) => x.level))].sort((a, b) => a - b);
      const asked = (lv) => chosen.filter((x) => x.level === lv && isQuestion(x.text)).length;
      const best = levels.reduce((b, lv) => (asked(lv) > asked(b) ? lv : b), levels[0]);
      chosen = chosen.filter((x) => x.level === best);
      const q = chosen.filter((x) => isQuestion(x.text));
      if (q.length >= 2 && q.length >= chosen.length / 2) chosen = q;
    }
    const seen = new Set();
    for (const x of chosen) {
      const k = compactKey(x.text);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      questions.push(x.text);
    }
  }
  let full = null;
  return {
    text,
    get fullText() {
      if (full === null) full = joinText(fullParts);
      return full;
    },
    h1,
    faq: { count: questions.length, questions, detected: questions.length > 0, structural },
  };
}

export const visibleFaq = (html) => scanBody(html).faq;
export const cleanBodyText = (html) => scanBody(html).text;

// ---------- facts ----------
const nonSpaceLength = (t) => {
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (!(c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x3000 || c === 0xfeff || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f)) n++;
  }
  return n;
};
const DATE_KEYS = new Set(['dateModified', 'datePublished', 'dateCreated', 'uploadDate', 'lastReviewed']);
const withoutDates = (v) => (Array.isArray(v) ? v.map(withoutDates) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !DATE_KEYS.has(k)).map(([k, x]) => [k, withoutDates(x)])) : v);

/**
 * sha256 over title, description, meta robots, canonical, JSON-LD (re-serialized without its date fields, so a
 * date-only bump is not a content change), visible body text, body link hrefs and image src+alt.
 */
export function contentSignature(f) {
  return crypto.createHash('sha256').update(JSON.stringify([f.title || '', f.description || '', f.robots || '', f.canonical || '', f.jsonldSig || f.jsonldText || [], f.bodyText || '', f.bodyLinks || [], f.images || []])).digest('hex');
}

/** "0; url=/new/" -> {delay, url} (absolute) or null. */
export function parseRefresh(content, base) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?([^'"]+)['"]?)?\s*$/i.exec(String(content || ''));
  if (!m || !m[2]) return null;
  try {
    return { delay: Number(m[1]), url: new URL(m[2].trim(), base).href };
  } catch {
    return null;
  }
}

/**
 * datePublished/dateModified of the page's own entity: the top-level node whose url/@id/mainEntityOfPage is the
 * page, else the first top-level Article, else the first top-level WebPage; nested items (lists) never count.
 */
export function pageDates(blocks, pageUrls) {
  const urls = new Set(pageUrls.filter(Boolean).map((u) => normalizeUrl(u) || u));
  const own = [];
  const articles = [];
  const pages = [];
  for (const b of blocks || []) {
    if (!b || b.error || !b.data) continue;
    walkJsonLd(b.data, (node, ctx) => {
      if (!ctx.topLevel) return;
      const t = typesOf(node);
      if (!t.length) return;
      const ids = ['url', '@id', 'mainEntityOfPage'].map((k) => {
        const v = node[k] && typeof node[k] === 'object' ? node[k]['@id'] || node[k].url : node[k];
        return typeof literal(v) === 'string' ? normalizeUrl(literal(v)) || '' : '';
      });
      if (ids.some((u) => u && urls.has(u))) own.push(node);
      if (t.some((x) => ARTICLE_TYPES.has(x))) articles.push(node);
      else if (t.some((x) => WEBPAGE_TYPES.has(x))) pages.push(node);
    });
  }
  const pick = (k) => {
    for (const list of [own, articles, pages]) for (const n of list) if (typeof literal(n[k]) === 'string' && literal(n[k]).trim()) return literal(n[k]).trim();
    return '';
  };
  return { published: pick('datePublished'), modified: pick('dateModified') };
}

/**
 * SEO facts of one HTML page. opts: {headers (lower-case names), status, hosts (extra own host names),
 * keepSearchText (keep title/meta/alt/JSON-LD/visible text for residual searches)}.
 */
export function extractFacts(html, url, { headers = {}, status = 200, hosts = [], keepSearchText = false } = {}) {
  const p = parseHtml(String(html || ''), url);
  const scan = scanBody(html);
  const xr = robotsTokens(headers['x-robots-tag'] || '');
  const headerNoindex = xr.includes('noindex') || xr.includes('none');
  const hostKey = (u) => {
    try {
      return bareHost(new URL(u).host);
    } catch {
      return '';
    }
  };
  const own = new Set([hostKey(url), ...hosts].filter(Boolean).map(bareHost));
  const isOwn = (u) => own.has(hostKey(u));
  const blocks = p.jsonLd.map((b) => ({ types: b.types, error: b.error, data: b.data, raw: b.raw }));
  const faq = faqQuestions(blocks);
  const fullKey = faq.questions.length ? compactKey(scan.fullText) : '';
  const links = [];
  const bodyLinks = [];
  for (const l of p.links) {
    if (!l.url || l.fragmentOnly || !isOwn(l.url)) continue;
    const u = stripCacheParams(l.url);
    links.push(u);
    if (!l.boiler) bodyLinks.push(u);
  }
  const images = p.images.filter((i) => !i.boiler && i.src).map((i) => `${stripCacheParams(i.src)} ${i.alt ?? ''}`.trim());
  const canonical = p.canonical ? normalizeUrl(p.canonical, { stripTracking: false }) || p.canonical : '';
  const ld = pageDates(blocks, [url, canonical]);
  const facts = {
    url,
    status,
    title: p.title,
    description: p.metaDescription,
    h1: scan.h1,
    lang: p.lang,
    robots: p.robots.join(','),
    metaNoindex: p.robotsNoindex,
    headerNoindex,
    noindex: p.robotsNoindex || headerNoindex,
    noindexSource: p.robotsNoindex ? 'meta robots' : headerNoindex ? 'X-Robots-Tag' : '',
    canonical,
    canonicalRaw: p.canonicalsRaw[0] || '',
    canonicalCount: new Set(p.canonicals).size,
    hreflang: p.hreflang.map((h) => ({ lang: h.lang.toLowerCase(), href: normalizeUrl(h.href, { stripTracking: false }) || h.href })),
    ogUrl: p.og.url || '',
    ogTitle: p.og.title || '',
    jsonldBlocks: blocks.length,
    jsonldErrors: blocks.filter((b) => b.error).map((b) => b.error),
    jsonldTypes: p.jsonLdTypes,
    jsonldText: blocks.map((b) => (b.error ? `!${String(b.raw || '').trim()}` : JSON.stringify(b.data))),
    jsonldSig: blocks.map((b) => (b.error ? `!${String(b.raw || '').trim()}` : JSON.stringify(withoutDates(b.data)))),
    faq: {
      schemaCount: faq.questions.length,
      faqPages: faq.faqPages,
      questions: faq.questions.map((q) => q.name),
      notVisible: faq.questions.filter((q) => q.name && !fullKey.includes(compactKey(plainText(q.name)))).map((q) => q.name),
      visible: scan.faq,
    },
    datePublished: ld.published || p.meta['article:published_time'] || '',
    dateModified: ld.modified || p.meta['article:modified_time'] || p.og.updated_time || '',
    refresh: p.metaRefresh ? parseRefresh(p.metaRefresh, url) : null,
    bodyText: scan.text,
    bodyLength: nonSpaceLength(scan.text),
    bodyHash: crypto.createHash('sha256').update(scan.text).digest('hex'),
    links,
    bodyLinks,
    images,
    microdataTypes: p.microdataTypes,
  };
  facts.signature = contentSignature(facts);
  if (keepSearchText) facts.searchText = [p.title, p.metaDescription, ...Object.values(p.og), ...Object.values(p.twitter), ...p.images.map((i) => i.alt || ''), scan.fullText, ...facts.jsonldText].join('\n');
  return facts;
}
