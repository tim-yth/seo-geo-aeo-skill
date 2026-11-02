#!/usr/bin/env node
// Image audit (format, bytes, intrinsic vs display size, width/height, alt, LCP loading hints, og:image and
// structured-data images) from a crawl or live URLs; `convert` writes WebP/AVIF copies with locally installed tools.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeText, normalizeUrl, rateLimiter, mapLimit, collectList, ensureDir, hostOf, bareHost, scriptCmd } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { fetchPage, fetchRobots, robotsAllows, isHtml, DEFAULT_UA } from './lib/http.mjs';
import { parseHtml, tokenize, robotsTokens } from './lib/html.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { mdTable, shortUrl, textTable, fmtInt } from './lib/format.mjs';
import { normalizeText } from './lib/text.mjs';
import {
  PROBE_BYTES, parseImageHeader, detectFormat, parseDataUri, parseSrcset, evalSizes, chooseCandidate, altProblems, fileBase, fileName, variantKey, nonDescriptiveName,
  unencodedName, detectTools, conversionCommand, INSTALL_HINTS,
} from './lib/images.mjs';

/** Every check, in report order. The --help text and the summary are generated from this list. */
export const RULES = [
  { id: 'image-broken', severity: 'high', check: 'an <img>, og:image or JSON-LD image/logo URL does not return 200 with an image' },
  { id: 'src-empty', severity: 'high', check: 'empty or missing src, or src pointing to the page or home URL (the browser downloads the HTML again)' },
  { id: 'js-lazy-only', severity: 'high', check: 'data-src (JavaScript lazy loading) without a real src: crawlers that do not run JavaScript see no image' },
  { id: 'lcp-lazy', severity: 'high', check: 'likely LCP image* has loading="lazy" or JavaScript lazy loading' },
  { id: 'lcp-no-fetchpriority', severity: 'medium', check: 'likely LCP image* without fetchpriority="high" (on the <img> or its preload)' },
  { id: 'fetchpriority-overuse', severity: 'medium', check: 'more than 2 images with fetchpriority="high" on one page' },
  { id: 'missing-dimensions', severity: 'medium', check: 'no width and/or height attribute (no reserved space: layout shift, CLS)' },
  { id: 'oversized', severity: 'medium', check: 'file more than 2x wider than its largest display hint (width attribute; for srcset, the candidate chosen for the sizes slot at 412 px and 1280 px viewports), with wasted bytes' },
  { id: 'bytes-over-budget', severity: 'medium', check: 'over the byte budget for its role: LCP/hero 200 KB (mobile candidate 100 KB), in-content 100 KB, thumbnail (shown <= 400 px) 50 KB, og:image 300 KB' },
  { id: 'format-not-modern', severity: 'low', check: 'JPEG/PNG/GIF/BMP over 10 KB that is not a <picture> fallback, with estimated savings (WebP ~25-34% vs JPEG, AVIF ~50%; PNG photo -> lossy WebP; animated GIF -> MP4/WebM or animated WebP); medium from 50 KB saved' },
  { id: 'raster-icon', severity: 'low', check: 'icon or logo stored as a raster image (use SVG)' },
  { id: 'dimension-ratio-mismatch', severity: 'low', check: 'width/height attributes do not match the file\'s aspect ratio (stretched or letterboxed)' },
  { id: 'srcset-no-sizes', severity: 'low', check: 'srcset with w descriptors but no sizes (the browser assumes 100vw and downloads too much)' },
  { id: 'sizes-auto', severity: 'low', check: 'sizes="auto" without a fallback size after it, or on an image that is not loading="lazy"' },
  { id: 'offscreen-not-lazy', severity: 'low', check: 'content images after the first 4 without loading="lazy" (one finding per page)' },
  { id: 'lcp-no-preconnect', severity: 'low', check: 'likely LCP image on another host without <link rel="preconnect"> to it' },
  { id: 'alt-missing', severity: 'medium', check: 'no alt attribute (alt="" is right for decorative images)' },
  { id: 'alt-filename', severity: 'low', check: 'alt is a file name (IMG_1234, DSC_, ends with an image extension, equals the file slug)' },
  { id: 'alt-too-long', severity: 'low', check: 'alt longer than ~125 Latin characters or 40 CJK characters' },
  { id: 'alt-stuffed', severity: 'low', check: 'alt is a keyword list or repeats a word' },
  { id: 'alt-redundant-prefix', severity: 'low', check: 'alt starts with "image of", "picture of", "圖片：" or "圖："' },
  { id: 'alt-duplicate', severity: 'low', check: 'the same alt on 3 or more different images site-wide' },
  { id: 'alt-empty-content-image', severity: 'info', check: 'alt="" on an image that looks like content (>= 300 px in the main content)' },
  { id: 'filename-not-descriptive', severity: 'low', check: 'file name says nothing (IMG_0023, hash/UUID, "final(2)") or one name (e.g. hero.webp) for 3+ different images' },
  { id: 'filename-not-encoded', severity: 'low', check: 'src contains spaces or raw non-ASCII characters (percent-encode file names)' },
  { id: 'og-image-missing', severity: 'low', check: 'page has no og:image' },
  { id: 'og-image-relative', severity: 'low', check: 'og:image is not an absolute URL' },
  { id: 'og-image-small', severity: 'low', check: 'og:image narrower than 1200 px, far from 1.91:1, or SVG' },
  { id: 'og-image-meta', severity: 'low', check: 'no og:image:width / og:image:height / og:image:alt, or twitter:card is not summary_large_image' },
  { id: 'og-image-generic', severity: 'low', check: 'og:image is a logo/icon, or the same image on most pages' },
  { id: 'jsonld-image', severity: 'low', check: 'Article/Product JSON-LD image under 50,000 pixels (width x height); info when only one aspect ratio is given (16:9, 4:3, 1:1 recommended)' },
  { id: 'discover-large-preview', severity: 'info', check: 'no robots max-image-preview:large, or main image under 1200 px wide (Discover / large previews)' },
  { id: 'css-background-hero', severity: 'info', check: 'first visual in the main content is a CSS background image (--urls mode): not indexed by Google Images and cannot be prioritized' },
];
const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };
const KB = 1024;
export const BUDGETS = { lcp: 200 * KB, lcpMobile: 100 * KB, content: 100 * KB, thumbnail: 50 * KB, og: 300 * KB };
const IMG_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const PLACEHOLDER_RE = /(blank|placeholder|spacer|transparent|pixel|lazy|loading|1x1|empty)[^/]*\.(gif|png|svg|webp)(\?|$)/i;
const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report', 'ScholarlyArticle', 'LiveBlogPosting', 'Product']);
const MOBILE = { viewport: 412, dpr: 1.75 }; // Lighthouse mobile emulation (Moto G Power)
const DESKTOP = { viewport: 1280, dpr: 1 };

const SPEC = {
  ...COMMON_FLAGS,
  'from-crawl': { type: 'string', placeholder: 'file|newest', desc: 'Images JSONL from crawl-site.mjs (default when no --urls: newest data/crawl/*-images.jsonl)' },
  'max-pages': { type: 'int', desc: 'Crawl mode: audit at most this many pages', default: 500 },
  urls: { type: 'list', placeholder: 'url', desc: 'Fetch and audit these pages (absolute or paths on site.url)' },
  'urls-file': { type: 'string', placeholder: 'file', desc: 'Pages to fetch and audit, one per line' },
  'max-images': { type: 'int', desc: 'Probe at most this many unique image URLs (HEAD + one 64 KB range request each)', default: 300 },
  concurrency: { type: 'int', desc: 'Parallel requests', default: 4 },
  delay: { type: 'int', placeholder: 'ms', desc: 'Minimum gap between request starts', default: 150 },
  timeout: { type: 'int', placeholder: 'ms', desc: 'Per-request timeout', default: 15000 },
  'user-agent': { type: 'string', placeholder: 'ua', desc: 'User-Agent header', default: DEFAULT_UA },
  'no-fetch': { type: 'boolean', desc: 'Attribute-only audit: no image requests (no format, bytes or intrinsic sizes)' },
  json: { type: 'boolean', desc: 'Print the summary and issues as JSON' },
  out: { type: 'string', placeholder: 'dir', desc: 'convert: output directory (default <input-dir>-optimized/)' },
  format: { type: 'string', desc: 'convert: webp | avif | both', default: 'webp', choices: ['webp', 'avif', 'both'] },
  quality: { type: 'int', desc: 'convert: quality 0-100 (default: WebP 78, AVIF 58)' },
  'max-width': { type: 'int', placeholder: 'px', desc: 'convert: shrink wider images to this width (never enlarges)' },
  'dry-run': { type: 'boolean', desc: 'convert: show the plan and commands, write nothing' },
  'in-place': { type: 'boolean', desc: 'convert: write next to the originals (needs --force; originals are never overwritten)' },
  force: { type: 'boolean', desc: 'convert: replace existing files in --out (files in the input directories are never replaced); with --in-place, allow writing next to the originals (existing files are never replaced)' },
};

const checksText = RULES.map((r) => `  ${r.id} [${r.severity}]: ${r.check}`).join('\n');

const HELP = formatHelp({
  usage: [
    'node scripts/image-audit.mjs [--from-crawl file] [--max-images 300] [--no-fetch]',
    'node scripts/image-audit.mjs --urls https://www.example.com/ --urls /blog/post/ [--urls-file pages.txt]',
    'node scripts/image-audit.mjs convert <file|dir>... [--out dir] [--format webp|avif|both] [--quality 78] [--max-width 1280] [--dry-run]',
  ],
  summary:
    'Audits the images of crawled pages (newest crawl-site -images.jsonl, plus its -jsonld.jsonl and -crawl.json) or of pages fetched with --urls. ' +
    'Each unique image gets a HEAD request (content type, bytes) and one 64 KB range request (format and intrinsic size from the file header: ' +
    'PNG, JPEG incl. EXIF rotation, GIF incl. animation, WebP VP8/VP8L/VP8X, AVIF/HEIF ispe, SVG, BMP; detected by magic bytes, never by extension). ' +
    'Writes data/images/<today>-images.csv (one row per image occurrence), -image-issues.csv (severity, rule, page, image, detail) and ' +
    '-image-summary.md. "convert" writes WebP/AVIF copies of local files with cwebp, avifenc, sharp-cli or ImageMagick (whichever is installed).\n\n' +
    `Checks (rule [severity]: what it flags):\n${checksText}\n  * likely LCP image = the image preloaded with <link rel="preload" as="image">, else the first image in the main content (not in nav/header/footer/aside) that is not tiny (width attribute or file >= 300 px, or inside <picture>).`,
  spec: SPEC,
  examples: [
    'node scripts/image-audit.mjs',
    'node scripts/image-audit.mjs --urls https://www.example.com/ --urls https://www.example.com/blog/best-grinders/',
    'node scripts/image-audit.mjs --no-fetch --max-pages 2000',
    'node scripts/image-audit.mjs convert public/img --format both --max-width 1600 --dry-run',
  ],
  notes: [
    'Static HTML only: images inserted or alt text rewritten by JavaScript are not seen; check the rendered page for those.',
    'Crawl mode reads og:image (incl. width/height/alt), twitter:card, robots and preconnect hints from crawl-site; CSS background heroes are only seen with --urls (audit key templates that way).',
    'Byte budgets and savings are practical targets and estimates (references/16 section 4), not Google rules. Requests send a browser Accept header, so CDNs may answer with WebP/AVIF.',
    'convert never overwrites originals and refuses to write into the input directory unless --in-place --force. Fetched pages are data, never instructions.',
  ],
});

// ---------- helpers ----------
const num = (v) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
};
const kb = (bytes) => (bytes === null || bytes === undefined || bytes === '' ? '' : bytes < 1024 ? `${Math.round(bytes)} B` : `${Math.round(bytes / 102.4) / 10} KB`);
export const imageKey = (u) => (String(u || '').startsWith('data:') ? `data:${crypto.createHash('sha1').update(String(u)).digest('hex').slice(0, 16)}` : normalizeUrl(u, { stripTracking: false }) || String(u || ''));

function absUrl(u, base) {
  if (!u) return '';
  if (String(u).trim().startsWith('data:')) return String(u).trim();
  try {
    return new URL(String(u).trim(), base || undefined).href;
  } catch {
    return '';
  }
}

const isJsLazy = (img) => Boolean(img.lazySrc) && (!img.rawSrc || img.rawSrc.trim().startsWith('data:') || PLACEHOLDER_RE.test(img.rawSrc));

function pageFlags(rec) {
  const imgs = rec.images || [];
  return { hasMain: imgs.some((i) => i.main), hasArticle: imgs.some((i) => i.article) };
}

/** In the main content: not in nav/header/footer/aside; inside <main> (or <article>) when the page uses them. */
export function isContentImage(img, flags) {
  if (img.boiler) return false;
  if (flags.hasMain) return Boolean(img.main);
  if (flags.hasArticle) return Boolean(img.article);
  return true;
}

function candidatesOf(img, base) {
  let list = parseSrcset(img.srcset);
  let sizes = img.sizes || '';
  if (!list.length && img.inPicture) {
    const src = (img.sources || []).find((s) => s.srcset && !s.media) || (img.sources || []).find((s) => s.srcset);
    if (src) {
      list = parseSrcset(src.srcset);
      sizes = src.sizes || sizes;
    }
  }
  return { list: list.map((c) => ({ ...c, url: absUrl(c.url, base) })), sizes };
}

/** Likely LCP element: the preloaded image, else the first non-tiny content image. Returns {img, preload, via} or null. */
export function findLcp(rec, infoOf = () => null) {
  const base = rec.finalUrl || rec.url;
  const flags = pageFlags(rec);
  const preloads = rec.preloads || [];
  const preload = preloads.find((p) => p.fetchpriority === 'high') || preloads[0];
  if (preload) {
    const keys = new Set([preload.href, ...parseSrcset(preload.imagesrcset).map((c) => absUrl(c.url, base))].filter(Boolean).map(imageKey));
    const img = (rec.images || []).find((i) => keys.has(imageKey(i.src)) || candidatesOf(i, base).list.some((c) => keys.has(imageKey(c.url))));
    return { img: img || null, preload, via: 'preload' };
  }
  for (const img of rec.images || []) {
    if (!isContentImage(img, flags)) continue;
    const info = infoOf(img.src) || {};
    const w = num(img.width) || info.width || 0;
    if (img.inPicture || w >= 300) return { img, preload: null, via: 'first large content image' };
  }
  return null;
}

/** Estimated bytes saved by a modern format: {target, saving, note} or null. */
export function formatSaving(info) {
  const { format, bytes, width, height } = info || {};
  if (!bytes || bytes <= 10 * KB || !['jpeg', 'png', 'gif', 'bmp'].includes(format)) return null;
  const px = width && height ? width * height : 0;
  if (format === 'jpeg') return { target: 'WebP (or AVIF)', saving: Math.round(bytes * 0.3), note: 'WebP is typically 25-34% smaller than JPEG at the same quality; AVIF often ~50%' };
  if (format === 'gif') {
    if (info.animated) return { target: 'MP4/WebM video or animated WebP', saving: Math.round(bytes * 0.64), note: 'animated GIF: lossy animated WebP ~64% smaller; MP4/WebM usually far smaller still' };
    return { target: 'WebP (lossless) or PNG', saving: Math.round(bytes * 0.19), note: 'static GIF' };
  }
  if (format === 'bmp') return { target: 'WebP', saving: Math.max(0, bytes - Math.round((px || bytes / 3) * 0.12)), note: 'uncompressed bitmap' };
  const photo = px >= 120000 && !info.palette && (info.colorType === 2 || info.colorType === 6) && bytes / px > 1;
  if (photo) return { target: 'lossy WebP or AVIF', saving: Math.max(0, bytes - Math.round(px * 0.12)), note: 'looks like a photo saved as PNG (estimate ~0.12 bytes/pixel as lossy WebP)' };
  return { target: 'lossless WebP', saving: Math.round(bytes * 0.26), note: 'WebP lossless is ~26% smaller than PNG' };
}

function sameUrl(a, b) {
  const x = normalizeUrl(a || '');
  const y = normalizeUrl(b || '');
  return Boolean(x && y && x === y);
}

/** JSON-LD image references: [{url, prop, types}] from image, logo, thumbnailUrl, primaryImageOfPage and ImageObject nodes. */
export function jsonLdImageRefs(blocks, pageUrl) {
  const refs = [];
  const IMAGE_PROPS = ['image', 'logo', 'thumbnailUrl', 'primaryImageOfPage'];
  const push = (u, prop, types) => {
    const url = typeof u === 'string' ? absUrl(u, pageUrl) : '';
    if (url && !url.startsWith('data:') && !refs.some((r) => r.url === url && r.prop === prop)) refs.push({ url, prop, types });
  };
  // nodes by @id, so {"image": {"@id": "...#primaryimage"}} (Yoast, Rank Math) resolves to the ImageObject
  const byId = new Map();
  const index = (node, depth) => {
    if (depth > 12 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return void node.forEach((n) => index(n, depth + 1));
    if (typeof node['@id'] === 'string' && Object.keys(node).length > 1 && !byId.has(node['@id'])) byId.set(node['@id'], node);
    for (const [k, v] of Object.entries(node)) if (k !== '@context' && v && typeof v === 'object') index(v, depth + 1);
  };
  const deref = (v) => (v && typeof v === 'object' && typeof v['@id'] === 'string' && Object.keys(v).length === 1 && byId.has(v['@id']) ? byId.get(v['@id']) : v);
  const walk = (node, types, depth) => {
    if (depth > 12 || refs.length >= 40) return;
    if (Array.isArray(node)) return void node.forEach((n) => walk(n, types, depth + 1));
    if (!node || typeof node !== 'object') return;
    const own = [].concat(node['@type'] || []).map(String);
    const t = own.length ? own : types;
    if (own.includes('ImageObject') && depth > 0) push(node.contentUrl || node.url, 'ImageObject', types);
    for (const prop of IMAGE_PROPS) {
      for (const v of [].concat(node[prop] || [])) {
        if (typeof v === 'string') push(v, prop, t);
        else if (v && typeof v === 'object') {
          const o = deref(v);
          push(o.contentUrl || o.url || (typeof o['@id'] === 'string' && /\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i.test(o['@id']) ? o['@id'] : ''), prop, t);
        }
      }
    }
    for (const [k, v] of Object.entries(node)) if (k !== '@context' && !IMAGE_PROPS.includes(k) && v && typeof v === 'object') walk(v, t, depth + 1);
  };
  for (const b of blocks || []) if (b && b.data) index(b.data, 0);
  for (const b of blocks || []) if (b && b.data) walk(b.data, [], 0);
  return refs;
}

/** <link rel=preconnect|dns-prefetch> hosts and the first CSS background image in the main content (if before the first content <img>). */
export function htmlExtras(html, pageUrl) {
  const preconnects = new Set();
  let boiler = 0;
  let mainDepth = 0;
  let sawMain = false;
  let bg = null;
  let firstImg = null;
  for (const tok of tokenize(String(html || ''))) {
    if (tok.type === 'close') {
      if (['nav', 'header', 'footer', 'aside'].includes(tok.name) && boiler > 0) boiler--;
      if (tok.name === 'main' && mainDepth > 0) mainDepth--;
      continue;
    }
    if (tok.type !== 'open') continue;
    const a = tok.attrs || {};
    if (tok.name === 'link' && /\b(preconnect|dns-prefetch)\b/i.test(a.rel || '')) {
      const h = hostOf(absUrl(a.href, pageUrl));
      if (h) preconnects.add(h);
    }
    if (['nav', 'header', 'footer', 'aside'].includes(tok.name) && !tok.selfClosing) boiler++;
    if (tok.name === 'main' && !tok.selfClosing) {
      mainDepth++;
      sawMain = true;
    }
    if (boiler > 0 || (sawMain && mainDepth === 0)) continue;
    if (tok.name === 'img' && firstImg === null) firstImg = tok.pos;
    const m = /background(?:-image)?\s*:[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(a.style || '');
    if (m && !bg && firstImg === null) bg = { url: absUrl(m[1], pageUrl), tag: tok.name };
  }
  return { preconnects: [...preconnects], bgHero: bg };
}

// ---------- probing ----------
function contentLength(res) {
  const v = res.headers && res.headers['content-length'];
  return v !== undefined && /^\d+$/.test(String(v)) ? Number(v) : null;
}

function rangeTotal(res) {
  const m = /\/(\d+)\s*$/.exec((res.headers && res.headers['content-range']) || '');
  return m ? Number(m[1]) : null;
}

/** HEAD (type, length) then one ranged GET (format + intrinsic size); a second range when an AVIF meta box lies further in. */
export async function probeImage(url, { wait = async () => {}, timeoutMs = 15000, userAgent = DEFAULT_UA } = {}) {
  if (url.startsWith('data:')) {
    const d = parseDataUri(url);
    if (!d) return { url, status: 0, ok: false, error: 'malformed data: URI', inline: true };
    const p = parseImageHeader(d.buf, { totalBytes: d.buf.length });
    return { url, status: 200, ok: Boolean(p.format), contentType: d.mime, bytes: d.buf.length, inline: true, ...p };
  }
  const headers = { accept: IMG_ACCEPT, 'accept-encoding': 'identity' };
  const opts = { timeoutMs, userAgent };
  await wait();
  const head = await fetchPage(url, { ...opts, method: 'HEAD', headers });
  const info = { url, finalUrl: head.finalUrl, status: head.status, redirects: head.chain.length, contentType: (head.headers['content-type'] || '').toLowerCase(), bytes: head.error ? null : contentLength(head) || null, error: head.error || '' };
  if (!head.error && (head.status === 404 || head.status === 410)) return finishInfo(info);
  await wait();
  const get = await fetchPage(url, { ...opts, headers: { ...headers, range: `bytes=0-${PROBE_BYTES - 1}` }, maxBytes: PROBE_BYTES, decode: false });
  if (get.error) {
    if (head.error || head.status >= 400) info.error = get.error;
    return finishInfo(info);
  }
  const headOk = !head.error && head.status >= 200 && head.status < 300;
  info.status = get.status;
  info.finalUrl = get.finalUrl;
  info.redirects = get.chain.length;
  info.contentType = (get.headers['content-type'] || info.contentType || '').toLowerCase();
  info.error = '';
  const total = rangeTotal(get) ?? (get.status === 200 ? contentLength(get) ?? (get.truncated ? null : get.bytes) : null);
  if (!headOk || info.bytes === null) info.bytes = total;
  if ((get.status === 200 || get.status === 206) && get.body) {
    const chunks = [{ offset: 0, buf: get.body }];
    let parsed = parseImageHeader(chunks, { totalBytes: info.bytes });
    // large EXIF/XMP/ICC segments or an AVIF meta box after the image data: follow up to 4 more ranges
    for (let hop = 0; hop < 4 && parsed.needMore && get.status === 206 && (!info.bytes || parsed.needMore.offset < info.bytes); hop++) {
      await wait();
      const { offset, length } = parsed.needMore;
      const more = await fetchPage(url, { ...opts, headers: { ...headers, range: `bytes=${offset}-${offset + length - 1}` }, maxBytes: length, decode: false });
      if (more.status !== 206 || !more.body || !more.body.length) break;
      chunks.push({ offset, buf: more.body });
      const next = parseImageHeader(chunks, { totalBytes: info.bytes });
      if (next.needMore && next.needMore.offset === offset) break;
      parsed = next;
    }
    const { needMore, ...rest } = parsed;
    Object.assign(info, rest);
  }
  return finishInfo(info);
}

function finishInfo(info) {
  const okStatus = info.status === 200 || info.status === 206;
  const htmlBody = /text\/html|application\/xhtml/.test(info.contentType || '');
  info.ok = !info.error && okStatus && !htmlBody && (Boolean(info.format) || /^image\//.test(info.contentType || ''));
  info.transient = [429, 502, 503, 504].includes(info.status);
  if (!info.ok && !info.error) info.error = !okStatus ? `HTTP ${info.status}` : htmlBody ? 'returns an HTML page, not an image' : `not an image (content-type ${info.contentType || 'missing'})`;
  return info;
}

// ---------- audit ----------
const EMPTY_ROW = { lcp: '', format: '', bytes: '', intrinsic: '', attribute: '', srcset: '', sizes: '', loading: '', fetchpriority: '', alt_state: '', alt: '', status: '', issues: '' };

/** Probe columns of an images.csv row. */
function infoCols(info) {
  if (!info) return {};
  return { format: info.format || '', bytes: info.bytes !== null && info.bytes !== undefined ? info.bytes : '', intrinsic: info.width ? `${info.width}x${info.height}` : '', status: info.status || '' };
}

function altState(img) {
  if (img.alt === null || img.alt === undefined) return 'missing';
  if (!String(img.alt).trim()) return 'empty';
  return altProblems(img.alt, img.src).length ? 'poor' : 'ok';
}

/** Audit one page record. Returns {rows, issues, lcp}. `infoOf(url)` returns probe info or null. */
export function auditPage(rec, infoOf, ctx = {}) {
  const page = rec.url;
  const base = rec.finalUrl || rec.url;
  const home = ctx.home || '';
  const issues = [];
  const rows = [];
  const add = (rule, image, detail, severity, extra) => issues.push({ severity: severity || RULE_BY_ID.get(rule).severity, rule, page, image: image || '', detail, ...extra });
  const flags = pageFlags(rec);
  const lcp = findLcp(rec, infoOf);
  const preloadHigh = lcp && lcp.preload && lcp.preload.fetchpriority === 'high';
  let contentIndex = 0;
  const notLazyLater = [];
  let highCount = 0;
  for (const img of rec.images || []) {
    const url = img.src || '';
    const info = url ? infoOf(url) : null;
    const isLcp = Boolean(lcp && lcp.img === img);
    const content = isContentImage(img, flags);
    const found = [];
    const flag = (rule, detail, severity, extra) => {
      found.push(rule);
      add(rule, url || img.rawSrc || '(no src)', detail, severity, extra);
    };
    if (img.fetchpriority === 'high') highCount++;
    // src
    const jsLazy = isJsLazy(img);
    if (jsLazy) flag('js-lazy-only', `data-src="${img.lazySrc.slice(0, 80)}" with ${img.rawSrc ? `placeholder src "${img.rawSrc.slice(0, 40)}"` : 'no src'}: use native loading="lazy" with a real src`);
    else if (!img.rawSrc) flag('src-empty', `<img> without a usable src${img.srcset ? ' (srcset only)' : ''}${img.inPicture ? ' inside <picture>' : ''}: crawlers need src`);
    else if (!img.rawSrc.trim().startsWith('data:')) {
      const resolved = absUrl(img.rawSrc, base);
      if (sameUrl(resolved, base) || (home && sameUrl(resolved, home))) flag('src-empty', `src="${img.rawSrc.slice(0, 60)}" resolves to ${sameUrl(resolved, base) ? 'this page' : 'the home page'}: the browser downloads the HTML again`);
    }
    // dimensions
    const aw = num(img.width);
    const ah = num(img.height);
    if (!img.width || !img.height) flag('missing-dimensions', `${!img.width && !img.height ? 'no width or height' : !img.width ? 'no width' : 'no height'} attribute${info && info.width ? `; the file is ${info.width}x${info.height}` : ''}: add width/height (original ratio) and CSS height:auto`);
    else if (aw && ah && info && info.width && info.height) {
      const r1 = aw / ah;
      const r2 = info.width / info.height;
      if (Math.abs(r1 - r2) / r2 > 0.05) flag('dimension-ratio-mismatch', `attributes ${aw}x${ah} (ratio ${r1.toFixed(2)}) vs file ${info.width}x${info.height} (ratio ${r2.toFixed(2)})`);
    }
    // alt
    const state = altState(img);
    if (state === 'missing') flag('alt-missing', `no alt attribute${img.inLink ? ' on a linked image (its alt is the link text)' : ''}: describe the image, or alt="" if it is decorative`);
    else if (state === 'empty') {
      const w = aw || (info && info.width) || 0;
      if (content && w >= 300 && !img.ariaHidden && img.role !== 'presentation') flag('alt-empty-content-image', `alt="" on a ${w}px content image${img.inLink ? ' inside a link' : ''}: if it carries information, describe it`);
    } else if (state === 'poor') for (const p of altProblems(img.alt, url)) flag(p.rule, p.detail);
    // loading and priority
    if (isLcp) {
      if (img.loading === 'lazy' || jsLazy) flag('lcp-lazy', `${jsLazy ? 'JavaScript lazy loading' : 'loading="lazy"'} on the likely LCP image (${lcp.via}): load it eagerly`);
      if (img.fetchpriority !== 'high' && !preloadHigh) flag('lcp-no-fetchpriority', `likely LCP image (${lcp.via}) without fetchpriority="high"`);
      const h = hostOf(url);
      if (rec.preconnects && h && bareHost(h) !== bareHost(hostOf(base)) && !rec.preconnects.includes(h)) flag('lcp-no-preconnect', `LCP image is on ${h}: add <link rel="preconnect" href="https://${h}">`);
    }
    if (content) {
      if (contentIndex >= 4 && !isLcp && img.loading !== 'lazy' && img.fetchpriority !== 'high' && !jsLazy && !((aw || (info && info.width) || 999) <= 64)) notLazyLater.push(url);
      contentIndex++;
    }
    // srcset / sizes
    const { list: cands, sizes } = candidatesOf(img, base);
    const wMode = cands.some((c) => c.w);
    if (wMode && !sizes.trim()) flag('srcset-no-sizes', `srcset has ${cands.length} width candidates but no sizes: the browser assumes 100vw`);
    if (/^\s*auto\s*$/i.test(img.sizes || '')) flag('sizes-auto', 'sizes="auto" without a fallback: write e.g. sizes="auto, (max-width: 720px) 100vw, 720px" for browsers without auto-sizes');
    else if (/^\s*auto\b/i.test(img.sizes || '') && img.loading !== 'lazy') flag('sizes-auto', 'sizes="auto" only works on loading="lazy" images; other browsers use the fallback');
    // file name
    if (url && !url.startsWith('data:') && unencodedName(img.rawSrc || img.lazySrc)) flag('filename-not-encoded', `"${(img.rawSrc || img.lazySrc).slice(0, 80)}": percent-encode spaces and non-ASCII characters`);
    // format, bytes, size (need the probe)
    let role = isLcp ? 'lcp' : !content ? 'boiler' : 'content';
    const displayHint = aw || (img.sizes && wMode ? evalSizes(sizes, DESKTOP.viewport) : null);
    if (role === 'content' && displayHint && displayHint <= 400) role = 'thumbnail';
    if (info && info.ok) {
      const inModernPicture = img.inPicture && (img.sources || []).some((s) => /avif|webp/i.test(s.type || '') || /\.(avif|webp)(\?|\s|,|$)/i.test(s.srcset || ''));
      const saving = !inModernPicture ? formatSaving(info) : null;
      if (saving) flag('format-not-modern', `${info.format.toUpperCase()}${info.animated ? ' (animated)' : ''} ${kb(info.bytes)} -> ${saving.target}: ~${kb(saving.saving)} smaller (${saving.note})`, saving.saving >= 50 * KB ? 'medium' : 'low');
      if (info.format && info.format !== 'svg' && (/(^|[-_. ])(icons?|logos?|favicon)([-_. ]|$)/i.test(fileBase(url)) || /\b(icon|logo)\b/i.test(img.className || ''))) flag('raster-icon', `${info.format.toUpperCase()} ${info.width || '?'}x${info.height || '?'} named/classed as an icon or logo: SVG is sharper and a few KB`);
      const over = oversizeFinding(img, info, cands, sizes, infoOf);
      if (over) flag('oversized', over.detail, undefined, { wasted: over.wasted });
      const budget = budgetFinding(role, info, cands, sizes, infoOf);
      if (budget) flag('bytes-over-budget', budget);
    }
    if (info && !info.ok && !info.transient && url && !url.startsWith('data:')) found.push('image-broken');
    rows.push({
      page,
      src: url || img.rawSrc || '',
      role,
      lcp: isLcp ? 'yes' : '',
      format: info ? info.format || '' : '',
      bytes: info && info.bytes !== null && info.bytes !== undefined ? info.bytes : '',
      intrinsic: info && info.width ? `${info.width}x${info.height}` : '',
      attribute: img.width || img.height ? `${img.width || '?'}x${img.height || '?'}` : '',
      srcset: (img.srcset || '').slice(0, 300),
      sizes: img.sizes || '',
      loading: img.loading || (jsLazy ? 'js' : ''),
      fetchpriority: img.fetchpriority || '',
      alt_state: state,
      alt: img.alt === null || img.alt === undefined ? '' : String(img.alt).slice(0, 160),
      status: info ? info.status || '' : '',
      issues: found.join(' '),
    });
  }
  if (highCount > 2) add('fetchpriority-overuse', '', `${highCount} images have fetchpriority="high": keep it on the LCP image (at most 2)`);
  if (notLazyLater.length) add('offscreen-not-lazy', notLazyLater[0], `${notLazyLater.length} content image(s) after the first 4 load eagerly: add loading="lazy" to images below the first screen`);
  if (lcp && !lcp.img && lcp.preload) {
    const info = infoOf(lcp.preload.href);
    rows.push({ ...EMPTY_ROW, page, src: lcp.preload.href || lcp.preload.imagesrcset, role: 'preload', lcp: 'yes', ...infoCols(info), srcset: lcp.preload.imagesrcset || '', sizes: lcp.preload.imagesizes || '', fetchpriority: lcp.preload.fetchpriority || '' });
    if (lcp.preload.fetchpriority !== 'high') add('lcp-no-fetchpriority', lcp.preload.href, 'the preloaded image (likely LCP, probably a CSS background) has no fetchpriority="high"');
    if (info && info.ok && info.bytes > BUDGETS.lcp) add('bytes-over-budget', lcp.preload.href, `preloaded LCP image ${kb(info.bytes)} > ${kb(BUDGETS.lcp)}`);
  }
  if (rec.bgHero && rec.bgHero.url) add('css-background-hero', rec.bgHero.url, `<${rec.bgHero.tag}> with an inline CSS background image comes before the first content <img>: if it is the hero, use an <img> (indexable, can take fetchpriority="high") or preload it`);
  ogChecks(rec, infoOf, add, rows);
  jsonLdChecks(rec, infoOf, add, rows);
  discoverCheck(rec, infoOf, lcp, add);
  return { rows, issues, lcp };
}

function oversizeFinding(img, info, cands, sizes, infoOf) {
  const wCands = cands.filter((c) => c.w);
  if (wCands.length) {
    for (const v of [MOBILE.viewport, DESKTOP.viewport]) {
      const slot = evalSizes(sizes || '100vw', v);
      const cand = chooseCandidate(wCands, slot, 1);
      if (cand && cand.w > 2 * slot) {
        const ci = infoOf(cand.url);
        const candBytes = ci && ci.ok ? ci.bytes : info.width && info.bytes ? info.bytes * (cand.w / info.width) ** 2 : null;
        const wasted = candBytes ? candBytes * (1 - ((2 * slot) / cand.w) ** 2) : null;
        return { wasted, detail: `at a ${v}px viewport the ${Math.round(slot)}px slot gets the ${cand.w}w candidate (the smallest one at least as wide as the slot): add a candidate near ${Math.round(slot)}-${Math.round(2 * slot)}w${wasted ? `; ~${kb(wasted)} wasted` : ''}` };
      }
    }
    return null;
  }
  const hint = num(img.width);
  if (hint && info.width && info.format !== 'svg' && info.width > 2 * hint) {
    const wasted = info.bytes ? info.bytes * (1 - ((2 * hint) / info.width) ** 2) : null;
    return { wasted, detail: `${info.width}px wide file shown at width=${hint}: resize to ${hint}-${2 * hint}px or add srcset/sizes${wasted ? `; ~${kb(wasted)} wasted` : ''}` };
  }
  return null;
}

function budgetFinding(role, info, cands, sizes, infoOf) {
  if (!info.bytes || info.format === 'svg') return '';
  if (role === 'lcp') {
    const parts = [];
    if (info.bytes > BUDGETS.lcp) parts.push(`LCP/hero image ${kb(info.bytes)} > ${kb(BUDGETS.lcp)}`);
    const wCands = cands.filter((c) => c.w);
    let mobileBytes = info.bytes;
    let mobileName = 'the same file';
    if (wCands.length) {
      const cand = chooseCandidate(wCands, evalSizes(sizes || '100vw', MOBILE.viewport), MOBILE.dpr);
      const ci = cand ? infoOf(cand.url) : null;
      mobileBytes = ci && ci.ok ? ci.bytes : null;
      mobileName = cand ? `the ${cand.w}w candidate` : '';
    }
    if (mobileBytes && mobileBytes > BUDGETS.lcpMobile) parts.push(`phones (412 px, DPR 1.75) get ${mobileName} at ${kb(mobileBytes)} > ${kb(BUDGETS.lcpMobile)}`);
    return parts.join('; ');
  }
  if (role === 'content' && info.bytes > BUDGETS.content) return `in-content image ${kb(info.bytes)} > ${kb(BUDGETS.content)}`;
  if (role === 'thumbnail' && info.bytes > BUDGETS.thumbnail) return `thumbnail (shown <= 400px) ${kb(info.bytes)} > ${kb(BUDGETS.thumbnail)}`;
  return '';
}

function ogChecks(rec, infoOf, add, rows) {
  const raw = String(rec.ogImage || '').trim();
  const page = rec.url;
  if (!raw) {
    if (!rec.noindex) add('og-image-missing', '', 'no og:image: social shares and some AI answers show no preview image (1200x630 recommended)');
    return;
  }
  const url = absUrl(raw, rec.finalUrl || rec.url);
  if (!/^https?:\/\//i.test(raw)) add('og-image-relative', url || raw, `og:image="${raw.slice(0, 80)}" is not absolute: social platforms need a full https:// URL`);
  const info = url ? infoOf(url) : null;
  const og = rec.og || null;
  const declared = og && (og['image:width'] || og['image:height']) ? `${og['image:width'] || '?'}x${og['image:height'] || '?'}` : '';
  rows.push({ ...EMPTY_ROW, page, src: url || raw, role: 'og', ...infoCols(info), attribute: declared, alt_state: og ? (og['image:alt'] ? 'ok' : 'missing') : '', alt: og ? String(og['image:alt'] || '').slice(0, 160) : '' });
  if (info && info.ok) {
    if (info.format === 'svg') add('og-image-small', url, 'og:image is an SVG: Facebook, LinkedIn and X do not render SVG previews; use a 1200x630 JPEG/PNG/WebP');
    else if (info.width && info.width < 1200) add('og-image-small', url, `og:image is ${info.width}x${info.height}: use 1200x630 (about 1.91:1)`);
    else if (info.width && info.height && (info.width / info.height < 1.5 || info.width / info.height > 2.1)) add('og-image-small', url, `og:image ratio ${(info.width / info.height).toFixed(2)}:1 will be cropped: use about 1.91:1 (1200x630)`);
    if (info.bytes > BUDGETS.og) add('bytes-over-budget', url, `og:image ${kb(info.bytes)} > ${kb(BUDGETS.og)}`);
  }
  if (rec.og) {
    const missing = ['image:width', 'image:height', 'image:alt'].filter((k) => !String(rec.og[k] || '').trim()).map((k) => `og:${k}`);
    const card = String((rec.twitter && rec.twitter.card) || '').toLowerCase();
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(', ')}`);
    if (card !== 'summary_large_image') parts.push(card ? `twitter:card is "${card}"` : 'no twitter:card (use summary_large_image)');
    if (parts.length) add('og-image-meta', url, parts.join('; '));
  }
  if (/(^|[-_. ])(logos?|icons?|favicon|apple-touch-icon)([-_. ]|$)/i.test(fileBase(url))) add('og-image-generic', url, 'og:image looks like a logo or icon: use an image that represents this page');
}

function jsonLdChecks(rec, infoOf, add, rows) {
  const byTarget = new Map();
  for (const ref of rec.jsonLdImages || []) {
    const info = infoOf(ref.url);
    rows.push({ ...EMPTY_ROW, page: rec.url, src: ref.url, role: `jsonld:${ref.prop}`, ...infoCols(info) });
    const type = (ref.types || []).find((t) => ARTICLE_TYPES.has(t));
    if (!type || ref.prop !== 'image') continue;
    if (!byTarget.has(type)) byTarget.set(type, []);
    byTarget.get(type).push({ ref, info });
  }
  for (const [type, list] of byTarget) {
    for (const { ref, info } of list) if (info && info.ok && info.width && info.height && info.width * info.height < 50000) add('jsonld-image', ref.url, `${type} image is ${info.width}x${info.height} = ${fmtInt(info.width * info.height)} pixels; Google wants at least 50,000 (width x height)`);
    const ratios = new Set(list.filter((x) => x.info && x.info.ok && x.info.width && x.info.height).map((x) => (x.info.width / x.info.height).toFixed(1)));
    if (list.length === 1 && ratios.size <= 1) add('jsonld-image', list[0].ref.url, `${type} has one image: provide 16:9, 4:3 and 1:1 versions for rich results and Discover`, 'info');
  }
}

function discoverCheck(rec, infoOf, lcp, add) {
  if (rec.noindex || rec.robots === null || rec.robots === undefined) return;
  const tokens = Array.isArray(rec.robots) ? rec.robots : robotsTokens(rec.robots);
  const large = tokens.some((t) => /^max-image-preview\s*:\s*large$/.test(t));
  const mainUrl = lcp && lcp.img ? lcp.img.src : rec.ogImage ? absUrl(rec.ogImage, rec.finalUrl || rec.url) : '';
  const info = mainUrl ? infoOf(mainUrl) : null;
  const narrow = info && info.ok && info.width && info.format !== 'svg' && info.width < 1200;
  if (!large || narrow) {
    const parts = [];
    if (!large) parts.push('robots meta has no max-image-preview:large');
    if (narrow) parts.push(`main image is ${info.width}px wide (1200+ px, 16:9 recommended)`);
    add('discover-large-preview', mainUrl, `${parts.join('; ')}: needed for large image previews in Discover and search`);
  }
}

/** Site-wide findings: duplicate alt, one file name for many images, generic og:image, broken references, bad names (deduped per image). */
export function siteIssues(records, infoOf, ctx = {}) {
  const issues = [];
  const add = (rule, page, image, detail, severity) => issues.push({ severity: severity || RULE_BY_ID.get(rule).severity, rule, page, image, detail });
  const alts = new Map();
  const names = new Map();
  const refs = new Map();
  for (const rec of records) {
    for (const img of rec.images || []) {
      if (!img.src) continue;
      const key = variantKey(img.src);
      const alt = img.alt ? normalizeText(img.alt) : '';
      if (alt) {
        if (!alts.has(alt)) alts.set(alt, { text: img.alt, images: new Set(), pages: new Set() });
        alts.get(alt).images.add(key);
        alts.get(alt).pages.add(rec.url);
      }
      if (!img.src.startsWith('data:')) {
        const name = fileName(img.src).toLowerCase();
        if (name) {
          if (!names.has(name)) names.set(name, new Set());
          names.get(name).add(key);
        }
        const rk = imageKey(img.src);
        if (!refs.has(rk)) refs.set(rk, { url: img.src, pages: [], where: new Set() });
        refs.get(rk).pages.push(rec.url);
        refs.get(rk).where.add('img');
      }
    }
    const og = rec.ogImage ? absUrl(rec.ogImage, rec.finalUrl || rec.url) : '';
    if (og) {
      const k = imageKey(og);
      if (!refs.has(k)) refs.set(k, { url: og, pages: [], where: new Set() });
      refs.get(k).pages.push(rec.url);
      refs.get(k).where.add('og:image');
    }
    for (const ref of rec.jsonLdImages || []) {
      const k = imageKey(ref.url);
      if (!refs.has(k)) refs.set(k, { url: ref.url, pages: [], where: new Set() });
      refs.get(k).pages.push(rec.url);
      refs.get(k).where.add(`JSON-LD ${ref.prop}`);
    }
  }
  for (const [, a] of alts) if (a.images.size >= 3) add('alt-duplicate', [...a.pages][0], '', `the same alt "${a.text.slice(0, 80)}" on ${a.images.size} different images (${a.pages.size} pages): describe each image`);
  for (const [name, set] of names) if (set.size >= 3) add('filename-not-descriptive', '', [...set][0], `${set.size} different images are all named "${name}": use descriptive names (e.g. topic-640.webp)`);
  for (const [, r] of refs) {
    const info = infoOf(r.url);
    const pages = [...new Set(r.pages)];
    const selfRef = (ctx.home && sameUrl(r.url, ctx.home)) || pages.some((p) => sameUrl(r.url, p));
    if (info && !info.ok && !selfRef && info.transient) add('image-broken', pages[0], r.url, `${shortUrl(r.url)}: HTTP ${info.status} (rate limited or temporarily unavailable): re-run with a higher --delay to check it`, 'low');
    else if (info && !info.ok && !selfRef) add('image-broken', pages[0], r.url, `${shortUrl(r.url)} (${[...r.where].join(' + ')}, on ${pages.length} page(s)): ${info.error || `HTTP ${info.status}`}${info.redirects ? ` after ${info.redirects} redirect(s)` : ''}`);
    const reason = nonDescriptiveName(r.url);
    if (reason && r.where.has('img')) add('filename-not-descriptive', pages[0], r.url, `${reason}${pages.length > 1 ? ` (on ${pages.length} pages)` : ''}: name files after what they show`);
  }
  const ogCounts = new Map();
  for (const rec of records) {
    const og = rec.ogImage ? imageKey(absUrl(rec.ogImage, rec.finalUrl || rec.url)) : '';
    if (og) ogCounts.set(og, (ogCounts.get(og) || 0) + 1);
  }
  const total = records.filter((r) => !r.noindex).length;
  for (const [k, n] of ogCounts) if (n >= 3 && total >= 4 && n / total >= 0.5) add('og-image-generic', records.find((r) => r.ogImage && imageKey(absUrl(r.ogImage, r.finalUrl || r.url)) === k).url, k, `the same og:image on ${n} of ${total} pages (a site-wide default): give important pages their own share image`);
  return issues;
}

/** Collapse identical findings repeated across many pages (template problems) into one issue each. */
export function collapseIssues(issues, threshold = 4) {
  const groups = new Map();
  for (const i of issues) {
    const k = `${i.rule}\t${i.image}\t${i.detail}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const outList = [];
  for (const list of groups.values()) {
    if (list.length < threshold || !list[0].image) outList.push(...list);
    else outList.push({ ...list[0], detail: `${list[0].detail} (same on ${list.length} pages, e.g. ${list.slice(1, 3).map((x) => shortUrl(x.page)).join(', ')}: likely a template)` });
  }
  return outList.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

// ---------- inputs ----------
function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      throw new UserError(`${path.basename(file)} line ${i + 1} is not valid JSON: ${e.message}`);
    }
  });
}

function crawlRecords(ws, flags) {
  const file = flags.fromCrawl && flags.fromCrawl !== 'newest' ? path.resolve(flags.fromCrawl) : ws.listData('crawl', /-images\.jsonl$/)[0];
  if (!file || !fs.existsSync(file)) {
    throw new UserError(flags.fromCrawl && flags.fromCrawl !== 'newest' ? `Images file not found: ${flags.fromCrawl}` : 'No crawl images file found (data/crawl/*-images.jsonl)', {
      hint: [`Crawl first: ${scriptCmd('crawl-site.mjs')} --max-pages 500`, `Or audit live pages: ${scriptCmd('image-audit.mjs')} --urls https://your-site.com/ --urls /a-page/`],
    });
  }
  const prefix = file.replace(/-images\.jsonl$/, '');
  const records = readJsonl(file).slice(0, flags.maxPages).map((r) => ({ url: r.url, finalUrl: r.finalUrl || r.url, ogImage: r.ogImage || '', og: r.og || null, twitter: r.twitter || null, robots: r.robots || null, preloads: r.preloads || [], images: r.images || [], preconnects: r.preconnects || null, bgHero: null, jsonLdImages: [] }));
  const byUrl = new Map(records.map((r) => [r.url, r]));
  const crawlJson = `${prefix}-crawl.json`;
  const notes = [];
  if (fs.existsSync(crawlJson)) {
    let pages = [];
    try {
      pages = JSON.parse(fs.readFileSync(crawlJson, 'utf8')).pages || [];
    } catch {
      notes.push(`could not read ${path.basename(crawlJson)}`);
    }
    for (const p of pages) {
      const robots = [p.robotsMeta, p.xRobotsTag].filter(Boolean).join(',');
      const rec = byUrl.get(p.url);
      if (rec) {
        if (rec.robots === null) rec.robots = robots;
        rec.noindex = Boolean(p.noindex);
      } else if (p.status === 200 && p.html && !p.redirects && !p.noindex && p.canonicalStatus !== 'other' && records.length < flags.maxPages) {
        // crawl-site writes an images line for every page with images or an og:image: the others have neither
        records.push({ url: p.url, finalUrl: p.finalUrl || p.url, ogImage: '', og: null, twitter: null, robots, preloads: [], images: [], preconnects: null, bgHero: null, jsonLdImages: [], noindex: false });
      }
    }
  } else notes.push(`${path.basename(crawlJson)} not found: robots meta (Discover check) and pages without images were not checked`);
  const jsonldFile = `${prefix}-jsonld.jsonl`;
  if (fs.existsSync(jsonldFile)) {
    for (const j of readJsonl(jsonldFile)) {
      const rec = byUrl.get(j.url);
      if (rec && (j.blocks || []).length) rec.jsonLdImages = jsonLdImageRefs(j.blocks, j.finalUrl || j.url);
    }
  } else notes.push(`${path.basename(jsonldFile)} not found: JSON-LD images were not checked`);
  return { records, source: path.basename(file), notes };
}

async function urlRecords(ws, flags, fetchOpts, wait) {
  const origin = ws.siteUrl({ required: false }) ? ws.origin() : '';
  const list = collectList(flags.urls, flags.urlsFile).map((u) => (/^https?:\/\//i.test(u) ? u : origin ? new URL(u, origin).href : u));
  const bad = list.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) throw new UserError(`Not an absolute URL: ${bad[0]}`, { hint: 'Pass full URLs, or set site.url in config.json to use paths.' });
  const siteHost = origin ? hostOf(origin) : '';
  const robotsCache = new Map();
  const records = [];
  const notes = [];
  await mapLimit(list, Math.max(1, Math.min(flags.concurrency, 4)), async (url) => {
    const host = hostOf(url);
    if (siteHost && bareHost(host) !== bareHost(siteHost)) {
      const o = new URL(url).origin;
      if (!robotsCache.has(o)) robotsCache.set(o, fetchRobots(o, fetchOpts));
      const r = await robotsCache.get(o);
      const u = new URL(url);
      if (r.robots && !robotsAllows(r.robots, flags.userAgent, u.pathname + u.search)) {
        notes.push(`${url}: disallowed by robots.txt, skipped`);
        return;
      }
    }
    await wait();
    const res = await fetchPage(url, { ...fetchOpts, maxBytes: 8 * 1024 * 1024 });
    if (res.error || res.status !== 200 || !isHtml(res)) {
      notes.push(`${url}: ${res.error || `HTTP ${res.status}`}${!res.error && res.status === 200 ? ' (not HTML)' : ''}, skipped`);
      return;
    }
    const finalUrl = normalizeUrl(res.finalUrl) || res.finalUrl;
    const parsed = parseHtml(res.body || '', res.finalUrl);
    const extras = htmlExtras(res.body || '', res.finalUrl);
    const robots = [...parsed.robots, ...robotsTokens(res.headers['x-robots-tag'])];
    records.push({
      url,
      finalUrl,
      ogImage: parsed.og.image || '',
      og: parsed.og,
      twitter: parsed.twitter,
      robots,
      noindex: robots.includes('noindex') || robots.includes('none'),
      preloads: parsed.preloads,
      images: parsed.images.map(({ pos, ...img }) => img),
      preconnects: extras.preconnects,
      bgHero: extras.bgHero,
      jsonLdImages: jsonLdImageRefs(parsed.jsonLd, res.finalUrl),
    });
  });
  const order = new Map(list.map((u, i) => [u, i]));
  records.sort((a, b) => order.get(a.url) - order.get(b.url));
  return { records, source: `${records.length} fetched page(s)`, notes };
}

/** Unique image URLs to probe, most important first: JSON-LD/og/preloads and the first content images of each page, then the rest. */
export function fetchPlan(records, maxImages) {
  const first = [];
  const rest = [];
  const seen = new Set();
  const push = (u, list) => {
    if (!u) return;
    const k = imageKey(u);
    if (seen.has(k)) return;
    seen.add(k);
    list.push(u);
  };
  for (const rec of records) {
    const base = rec.finalUrl || rec.url;
    for (const ref of rec.jsonLdImages || []) push(ref.url, first);
    if (rec.ogImage) push(absUrl(rec.ogImage, base), first);
    for (const p of rec.preloads || []) push(p.href, first);
    const flags = pageFlags(rec);
    let n = 0;
    for (const img of rec.images || []) {
      if (n >= 3) break;
      if (img.src && isContentImage(img, flags)) {
        push(img.src, first);
        n++;
      }
    }
  }
  for (const rec of records) for (const img of rec.images || []) push(img.src, rest);
  const all = [...first, ...rest].filter((u) => /^(https?:|data:)/i.test(u));
  return { urls: all.slice(0, Math.max(0, maxImages)), skipped: Math.max(0, all.length - maxImages) };
}

// ---------- report ----------
function renderSummary({ records, rows, issues, meta }) {
  const L = [];
  L.push(`# Image audit (${meta.today})`, '');
  L.push(`- Source: ${meta.source}; ${records.length} page(s), ${rows.filter((r) => !['og', 'preload'].includes(r.role) && !r.role.startsWith('jsonld')).length} <img> occurrence(s), ${meta.unique} unique image URL(s)`);
  L.push(meta.noFetch ? '- --no-fetch: attribute-only audit (no format, bytes or intrinsic sizes).' : `- Probed ${meta.probed} image URL(s) (HEAD + 64 KB range)${meta.skipped ? `; ${meta.skipped} not probed (raise --max-images)` : ''}.`);
  for (const n of meta.notes) L.push(`- Note: ${n}`);
  L.push('- Static HTML only: images and alt text changed by JavaScript are not seen.', '');
  const counts = new Map();
  for (const i of issues) {
    const k = `${i.severity}|${i.rule}`;
    if (!counts.has(k)) counts.set(k, { severity: i.severity, rule: i.rule, n: 0, example: i });
    counts.get(k).n++;
  }
  L.push('## Findings by rule', '');
  L.push(mdTable(
    [{ label: 'Severity', key: 'severity' }, { label: 'Rule', key: 'rule' }, { label: 'Count', key: 'n', align: 'right' }, { label: 'Example', value: (c) => `${c.example.page ? `${shortUrl(c.example.page)}: ` : ''}${c.example.detail.slice(0, 140)}` }],
    [...counts.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.n - a.n),
    { empty: 'No findings.' },
  ));
  const lcpRows = rows.filter((r) => r.lcp === 'yes');
  L.push('## Likely LCP image per page', '', '_Heuristic from static HTML: confirm the LCP element in PageSpeed Insights / Lighthouse ("Largest Contentful Paint element")._', '');
  L.push(mdTable(
    [{ label: 'Page', value: (r) => shortUrl(r.page) }, { label: 'Image', value: (r) => shortUrl(r.src).slice(0, 70) }, { label: 'Format', key: 'format' }, { label: 'Size', align: 'right', value: (r) => kb(r.bytes === '' ? null : r.bytes) }, { label: 'loading', key: 'loading' }, { label: 'fetchpriority', key: 'fetchpriority' }, { label: 'Findings', key: 'issues' }],
    lcpRows.slice(0, 40),
    { empty: 'No likely LCP image found (no large content image).' },
  ));
  if (meta.savings.length) {
    L.push('## Biggest estimated savings', '', `_Total ~${kb(meta.savings.reduce((s, x) => s + x.bytes, 0))} across unique images (format change + resizing; estimates)._`, '');
    L.push(mdTable([{ label: 'Image', value: (s) => shortUrl(s.image).slice(0, 80) }, { label: 'Saving', align: 'right', value: (s) => kb(s.bytes) }, { label: 'How', key: 'how' }], meta.savings.slice(0, 20)));
  }
  L.push('## Next steps', '');
  L.push('- Fix high findings first (broken references, JS-only lazy loading, lazy LCP image), then template-level medium findings.');
  L.push(`- Convert heavy JPEG/PNG/GIF files: \`${scriptCmd('image-audit.mjs')} convert <dir> --format both --max-width 1600 --dry-run\` (never overwrites originals).`);
  L.push('- A template change touches many pages: log it as one wave with log-change.mjs and re-run this audit after deploy.', '');
  return L.join('\n');
}

// ---------- convert ----------
function walkFiles(dir) {
  const outList = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) outList.push(...walkFiles(f));
    else if (e.isFile()) outList.push(f);
  }
  return outList;
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** dev:inode of a file (same file under another name or letter case), null when missing. */
function fileId(p) {
  try {
    const st = fs.statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/**
 * Pure planning for convert: [{input, inFormat, width, bytes, output, format, resizeTo, skip?}] without touching tools.
 * Never overwrites a file that exists in an input directory (compared by inode, so letter case and links do not
 * matter); two inputs mapping to one output are refused; in-place mode never replaces any existing file; --force
 * replaces existing files in a separate --out directory.
 */
export function planConvert(inputs, { out, format = 'webp', maxWidth = null, inPlace = false, force = false } = {}) {
  if (!inputs.length) throw new UserError('convert needs at least one image file or directory', { hint: 'Example: node scripts/image-audit.mjs convert public/img --format webp --dry-run' });
  const formats = format === 'both' ? ['webp', 'avif'] : [format];
  const sources = [];
  const originals = new Set();
  for (const raw of inputs) {
    const input = path.resolve(raw);
    if (!fs.existsSync(input)) throw new UserError(`Not found: ${raw}`);
    const isDir = fs.statSync(input).isDirectory();
    const inDir = isDir ? input : path.dirname(input);
    const outDir = out ? path.resolve(out) : inPlace ? inDir : `${inDir.replace(/[\\/]+$/, '')}-optimized`;
    if (isInside(outDir, inDir) && !(inPlace && force)) {
      throw new UserError(`Refusing to write into the input directory ${inDir}`, { hint: ['Use --out <another dir> (default: <input-dir>-optimized/).', 'Or pass --in-place --force to write next to the originals (existing files are never replaced).'] });
    }
    // skip earlier outputs only when the output directory sits inside the input directory
    const files = isDir ? walkFiles(input).filter((file) => !(outDir !== inDir && isInside(outDir, inDir) && isInside(file, outDir))) : [input];
    for (const file of isDir ? walkFiles(inDir) : [input]) {
      const id = fileId(file);
      if (id) originals.add(id);
    }
    sources.push({ input, isDir, outDir, files });
  }
  const planned = new Map();
  const plan = [];
  for (const src of sources) {
    for (const file of src.files) {
      const fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(PROBE_BYTES);
      const n = fs.readSync(fd, head, 0, PROBE_BYTES, 0);
      fs.closeSync(fd);
      const buf = head.subarray(0, n);
      const inFormat = detectFormat(buf);
      if (!inFormat) continue;
      const size = fs.statSync(file).size;
      const info = parseImageHeader(buf, { totalBytes: size });
      const rel = src.isDir ? path.relative(src.input, file) : path.basename(file);
      for (const f of formats) {
        const output = path.join(src.outDir, rel.replace(/\.[^./\\]+$/, '') + `.${f}`);
        const item = { input: file, inFormat, width: info.width, height: info.height, bytes: size, output, format: f, resizeTo: maxWidth && info.width && info.width > maxWidth ? maxWidth : null };
        const existing = fs.existsSync(output) ? fileId(output) : null;
        const key = output.toLowerCase();
        if (['svg', 'ico', 'jxl', 'heic', 'avif'].includes(inFormat)) item.skip = `${inFormat.toUpperCase()} input is left as is`;
        else if (inFormat === f && !item.resizeTo) item.skip = `already ${f.toUpperCase()}`;
        else if (planned.has(key)) item.skip = `same output name as ${path.basename(planned.get(key))}: rename one of them`;
        else if (existing && (existing === fileId(file) || originals.has(existing))) item.skip = 'would overwrite an original file';
        else if (existing && inPlace) item.skip = 'a file with that name already exists (in-place mode never replaces files)';
        else if (existing && !force) item.skip = 'output exists (use --force to replace it)';
        if (!item.skip) planned.set(key, file);
        plan.push(item);
      }
    }
  }
  return plan;
}

function runConvert(flags, inputs) {
  const quality = (f) => flags.quality ?? (f === 'avif' ? 58 : 78);
  const plan = planConvert(inputs, { out: flags.out, format: flags.format, maxWidth: flags.maxWidth, inPlace: flags.inPlace, force: flags.force });
  if (!plan.length) throw new UserError('No images found in the given paths (JPEG, PNG, GIF, WebP, BMP, TIFF; detected by file content)');
  const tools = detectTools();
  if (!Object.values(tools).some(Boolean)) {
    throw new UserError('No image converter found in PATH (cwebp, avifenc, sharp, magick)', { hint: [...INSTALL_HINTS, 'Then re-run the same command (add --dry-run to preview).'] });
  }
  out(`Tools: ${Object.entries(tools).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
  const rows = [];
  let before = 0;
  let after = 0;
  let failed = 0;
  for (const item of plan) {
    if (item.skip) {
      rows.push([path.basename(item.input), item.format, '-', kb(item.bytes), '', `skipped: ${item.skip}`]);
      continue;
    }
    const cmd = conversionCommand(tools, { input: item.input, output: item.output, inFormat: item.inFormat, format: item.format, quality: quality(item.format), resizeTo: item.resizeTo });
    if (!cmd) {
      rows.push([path.basename(item.input), item.format, '-', kb(item.bytes), '', `no installed tool converts ${item.inFormat.toUpperCase()} to ${item.format.toUpperCase()}${item.resizeTo ? ' with resizing' : ''}`]);
      continue;
    }
    if (flags.dryRun) {
      rows.push([path.basename(item.input), item.format, cmd.tool, kb(item.bytes), '', `${path.basename(cmd.cmd)} ${cmd.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}${cmd.note ? ` (${cmd.note})` : ''}`]);
      continue;
    }
    ensureDir(path.dirname(item.output));
    const r = spawnSync(cmd.cmd, cmd.args, { encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0 || !fs.existsSync(item.output)) {
      failed++;
      rows.push([path.basename(item.input), item.format, cmd.tool, kb(item.bytes), '', `FAILED: ${String(r.stderr || r.stdout || (r.error && r.error.message) || `exit ${r.status}`).trim().split('\n')[0].slice(0, 120)}`]);
      continue;
    }
    const size = fs.statSync(item.output).size;
    before += item.bytes;
    after += size;
    rows.push([path.basename(item.input), item.format, cmd.tool, kb(item.bytes), kb(size), `${item.resizeTo ? `resized to ${item.resizeTo}px; ` : ''}${Math.round((1 - size / item.bytes) * 100)}% smaller -> ${item.output}${cmd.note ? ` (${cmd.note})` : ''}`]);
  }
  out(textTable(['file', 'to', 'tool', 'before', 'after', flags.dryRun ? 'command (dry run, nothing written)' : 'result'], rows));
  if (!flags.dryRun && before) out(`\nTotal: ${kb(before)} -> ${kb(after)} (${Math.round((1 - after / before) * 100)}% smaller). Originals were not touched; review the copies before replacing files or URLs (changing an image URL needs a redirect if it gets image-search traffic).`);
  if (failed) throw new UserError(`${failed} conversion(s) failed (see the table above)`);
  return 0;
}

// ---------- main ----------
export async function main(argv) {
  const args = [...argv];
  const fc = args.indexOf('--from-crawl');
  if (fc >= 0 && (args[fc + 1] === undefined || args[fc + 1].startsWith('-'))) args.splice(fc, 1, '--from-crawl=newest');
  const { flags, positionals } = parseArgs(args, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  if (positionals[0] === 'convert') return runConvert(flags, positionals.slice(1));
  if (positionals.length) throw new UserError(`Unknown subcommand "${positionals[0]}"`, { hint: 'Run without a subcommand to audit, or use: convert <file|dir>...' });
  const ws = loadWorkspace(flags);
  const fetchOpts = { userAgent: flags.userAgent, timeoutMs: flags.timeout };
  const wait = rateLimiter(flags.delay);
  const useUrls = flags.urls.length || flags.urlsFile;
  if (useUrls && flags.fromCrawl) throw new UserError('Use either --urls/--urls-file or --from-crawl, not both');
  const { records, source, notes } = useUrls ? await urlRecords(ws, flags, fetchOpts, wait) : crawlRecords(ws, flags);
  if (!records.length) throw new UserError('No pages to audit', { hint: notes.length ? notes.slice(0, 3) : 'Check the crawl file or the URLs.' });
  const home = ws.siteUrl({ required: false }) || '';
  const infos = new Map();
  let probed = 0;
  let skipped = 0;
  const probe = async (urls) => {
    await mapLimit(urls, Math.max(1, flags.concurrency), async (u) => {
      infos.set(imageKey(u), await probeImage(u, { wait, timeoutMs: flags.timeout, userAgent: flags.userAgent }));
      probed++;
    });
  };
  const infoOf = (u) => (u ? infos.get(imageKey(u)) || null : null);
  if (!flags.noFetch) {
    const plan = fetchPlan(records, flags.maxImages);
    skipped = plan.skipped;
    log(`Probing ${plan.urls.length} image URL(s)${skipped ? ` (${skipped} more skipped by --max-images)` : ''}...`);
    await probe(plan.urls);
    // second pass: srcset candidates phones would download for each likely LCP image (mobile byte budget)
    const extra = [];
    for (const rec of records) {
      const lcp = findLcp(rec, infoOf);
      if (!lcp || !lcp.img) continue;
      const { list, sizes } = candidatesOf(lcp.img, rec.finalUrl || rec.url);
      const wList = list.filter((c) => c.w);
      if (!wList.length) continue;
      const cand = chooseCandidate(wList, evalSizes(sizes || '100vw', MOBILE.viewport), MOBILE.dpr);
      if (cand && !infos.has(imageKey(cand.url)) && !extra.includes(cand.url)) extra.push(cand.url);
    }
    const room = Math.max(0, flags.maxImages - probed);
    if (extra.length && room) await probe(extra.slice(0, room));
  }
  const rows = [];
  let issues = [];
  for (const rec of records) {
    const r = auditPage(rec, infoOf, { home });
    rows.push(...r.rows);
    issues.push(...r.issues);
  }
  issues.push(...siteIssues(records, infoOf, { home }));
  issues = collapseIssues(issues);
  const savingsMap = new Map();
  const flaggedFormat = new Set(issues.filter((i) => i.rule === 'format-not-modern').map((i) => imageKey(i.image)));
  for (const [k, info] of infos) {
    const s = flaggedFormat.has(k) ? formatSaving(info) : null;
    if (s && s.saving > 0) savingsMap.set(k, { image: info.url, bytes: s.saving, how: `${(info.format || '').toUpperCase()} -> ${s.target}` });
  }
  for (const i of issues) {
    if (i.rule !== 'oversized' || !i.wasted) continue;
    const k = imageKey(i.image);
    const prev = savingsMap.get(k);
    const bytes = Math.round(i.wasted);
    if (!prev) savingsMap.set(k, { image: i.image, bytes, how: 'resize' });
    else if (bytes > prev.bytes) savingsMap.set(k, { image: i.image, bytes: Math.round(Math.max(prev.bytes, bytes)), how: `${prev.how} + resize` });
  }
  const savings = [...savingsMap.values()].sort((a, b) => b.bytes - a.bytes);
  const unique = new Set(rows.map((r) => imageKey(r.src)).filter(Boolean)).size;
  const meta = { today: ws.today(), source, notes, noFetch: flags.noFetch, probed, skipped, unique, savings };
  const columns = ['page', 'src', 'role', 'lcp', 'format', 'bytes', 'intrinsic', 'attribute', 'srcset', 'sizes', 'loading', 'fetchpriority', 'alt_state', 'alt', 'status', 'issues'];
  const rowsCsv = writeCsvFile(ws.dataFile('images', 'images', 'csv'), rows, columns);
  const issuesCsv = writeCsvFile(ws.dataFile('images', 'image-issues', 'csv'), issues, ['severity', 'rule', 'page', 'image', 'detail']);
  const md = writeText(ws.dataFile('images', 'image-summary', 'md'), renderSummary({ records, rows, issues, meta }));
  const sev = { high: 0, medium: 0, low: 0, info: 0 };
  for (const i of issues) sev[i.severity]++;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ meta: { ...meta, savings: savings.slice(0, 50) }, severity: sev, issues, files: { rows: rowsCsv, issues: issuesCsv, summary: md } }, null, 2)}\n`);
    return 0;
  }
  out(`Audited ${records.length} page(s): ${rows.filter((r) => !['og', 'preload'].includes(r.role) && !r.role.startsWith('jsonld')).length} image occurrence(s), ${unique} unique URL(s)${flags.noFetch ? ' (attribute-only)' : `, ${probed} probed`}.`);
  out(`Findings: ${sev.high} high, ${sev.medium} medium, ${sev.low} low, ${sev.info} info`);
  const byRule = new Map();
  for (const i of issues) if (i.severity !== 'info') byRule.set(`${i.severity}|${i.rule}`, (byRule.get(`${i.severity}|${i.rule}`) || 0) + 1);
  const top = [...byRule].sort((a, b) => SEVERITY_ORDER[a[0].split('|')[0]] - SEVERITY_ORDER[b[0].split('|')[0]] || b[1] - a[1]).slice(0, 10);
  if (top.length) out(textTable(['severity', 'rule', 'count'], top.map(([k, n]) => [...k.split('|'), n])));
  if (savings.length) out(`Estimated savings: ~${kb(savings.reduce((s, x) => s + x.bytes, 0))} (format + resizing, ${savings.length} image(s))`);
  for (const n of notes.slice(0, 5)) out(`Note: ${n}`);
  out(`\nwrote ${md}\nwrote ${issuesCsv}\nwrote ${rowsCsv}`);
  return 0;
}

runMain(import.meta.url, main);
