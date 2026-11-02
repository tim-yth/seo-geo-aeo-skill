// Lightweight HTML tokenizer + SEO field extractor (no DOM, no dependencies).
import { textStats } from './text.mjs';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae',
  trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb', middot: '\u00b7', bull: '\u2022',
  times: '\u00d7', divide: '\u00f7', deg: '\u00b0', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
  cent: '\u00a2', sect: '\u00a7', para: '\u00b6', shy: '\u00ad', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', zwj: '\u200d', zwnj: '\u200c', eacute: '\u00e9', egrave: '\u00e8', aacute: '\u00e1',
  agrave: '\u00e0', oacute: '\u00f3', uacute: '\u00fa', iacute: '\u00ed', ntilde: '\u00f1', ccedil: '\u00e7',
  uuml: '\u00fc', ouml: '\u00f6', auml: '\u00e4', szlig: '\u00df', larr: '\u2190', rarr: '\u2192',
};

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[e] ?? NAMED[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'xmp', 'iframe', 'noembed', 'noframes']);
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/** Yields {type:'open',name,attrs,selfClosing,pos} | {type:'close',name,pos} | {type:'text',text,pos} | {type:'raw',name,text,pos} (pos = character offset). */
export function* tokenize(html) {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      yield { type: 'text', text: html.slice(i), pos: i };
      return;
    }
    if (lt > i) yield { type: 'text', text: html.slice(i, lt), pos: i };
    const next = html.charCodeAt(lt + 1);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (next === 47 /* / */) {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)[^>]*>/.exec(html.slice(lt, lt + 256));
      if (m) {
        yield { type: 'close', name: m[1].toLowerCase(), pos: lt };
        i = lt + m[0].length;
      } else {
        yield { type: 'text', text: '<' };
        i = lt + 1;
      }
      continue;
    }
    const nm = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 128));
    if (!nm) {
      yield { type: 'text', text: '<' };
      i = lt + 1;
      continue;
    }
    const name = nm[1].toLowerCase();
    let j = lt + nm[0].length;
    const attrs = {};
    let selfClosing = false;
    while (j < n) {
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      const c = html[j];
      if (c === '>') {
        j++;
        break;
      }
      if (c === '/' && html[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      if (c === '/') {
        j++;
        continue;
      }
      let k = j;
      while (k < n) {
        const cc = html.charCodeAt(k);
        if (isSpace(cc) || cc === 61 /* = */ || cc === 62 /* > */ || (cc === 47 && html[k + 1] === '>')) break;
        k++;
      }
      const an = html.slice(j, k).toLowerCase();
      j = k;
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      let av = '';
      if (html[j] === '=') {
        j++;
        while (j < n && isSpace(html.charCodeAt(j))) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          av = html.slice(j + 1, e === -1 ? n : e);
          j = e === -1 ? n : e + 1;
        } else {
          let e = j;
          while (e < n && !isSpace(html.charCodeAt(e)) && html[e] !== '>') e++;
          av = html.slice(j, e);
          j = e;
        }
      }
      if (an && !(an in attrs)) attrs[an] = decodeEntities(av);
      if (k === j && !an) j++;
    }
    yield { type: 'open', name, attrs, selfClosing, pos: lt };
    i = j;
    if (RAW_TEXT.has(name) && !selfClosing) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'ig');
      closeRe.lastIndex = i;
      const m = closeRe.exec(html);
      const end = m ? m.index : n;
      yield { type: 'raw', name, attrs, text: html.slice(i, end), pos: i };
      if (m) {
        yield { type: 'close', name, pos: m.index };
        i = m.index + m[0].length;
      } else i = n;
    }
  }
}

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'tr',
  'td', 'th', 'thead', 'tbody', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption', 'form', 'hr', 'br',
  'details', 'summary', 'address', 'fieldset', 'caption', 'option', 'label',
]);
const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'blockquote', 'pre', 'form', 'hr', 'figure', 'details', 'dl', 'main']);
const BOILER = new Set(['nav', 'header', 'footer', 'aside']);

function resolveHref(href, base) {
  if (!href) return null;
  const h = href.trim();
  if (!h || /^(javascript|mailto|tel|sms|data|about|blob):/i.test(h)) return null;
  try {
    return new URL(h, base || undefined).href;
  } catch {
    return null;
  }
}

function collectTypes(node, types, info) {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, types, info);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const t = node['@type'];
  for (const type of [].concat(t || [])) if (typeof type === 'string') types.add(type.replace(/^https?:\/\/schema\.org\//, ''));
  if (node.datePublished && !info.datePublished) info.datePublished = String(node.datePublished);
  if (node.dateModified && !info.dateModified) info.dateModified = String(node.dateModified);
  if (node.author && !info.author) info.author = true;
  if ([].concat(t || []).includes('FAQPage')) info.faqQuestions += [].concat(node.mainEntity || []).length;
  for (const [k, v] of Object.entries(node)) if (k !== '@context' && v && typeof v === 'object') collectTypes(v, types, info);
}

export function parseJsonLd(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim();
  const types = new Set();
  const info = { datePublished: '', dateModified: '', author: false, faqQuestions: 0 };
  if (!text) return { data: null, error: 'empty JSON-LD block', types: [], info };
  try {
    const data = JSON.parse(text);
    collectTypes(data, types, info);
    return { data, error: '', types: [...types], info };
  } catch (e) {
    return { data: null, error: e.message.slice(0, 160), types: [], info };
  }
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Extract SEO-relevant fields from an HTML document. */
export function parseHtml(html, pageUrl = '') {
  const res = {
    url: pageUrl,
    lang: '',
    base: '',
    title: '',
    titleCount: 0,
    metaDescription: '',
    metaDescriptionCount: 0,
    canonicals: [],
    robots: [],
    metaRefresh: '',
    viewport: '',
    charset: '',
    meta: {},
    og: {},
    twitter: {},
    verification: { google: [], bing: [], yandex: [] },
    hreflang: [],
    headings: [],
    links: [],
    images: [],
    preloads: [],
    preconnects: [],
    jsonLd: [],
    jsonLdTypes: [],
    microdataTypes: [],
    scripts: [],
    inlineScripts: [],
    iframes: [],
    times: [],
    paragraphs: [],
    blocks: [],
    counts: { tables: 0, lists: 0, listItems: 0, forms: 0, inputs: 0, selects: 0, textareas: 0, buttons: 0, canvases: 0, videos: 0, audios: 0, iframes: 0, details: 0, figures: 0, blockquotes: 0, pre: 0 },
    dates: { published: '', modified: '' },
    hasMain: false,
    hasArticle: false,
    canonicalsRaw: [],
    canonicalPos: [],
    robotsPos: [],
  };
  let base = pageUrl;
  const ids = new Set();
  let svgDepth = 0;
  let pictureDepth = 0;
  let pictureSources = [];
  let boilerDepth = 0;
  let mainDepth = 0;
  let articleDepth = 0;
  let inBody = false;
  let headDone = false;
  let heading = null;
  let anchor = null;
  let para = null;
  let inlineScriptBytes = 0;
  const buf = { full: [], clean: [], main: [], article: [] };
  const microdata = new Set();
  let jsonLdAuthor = false;
  let faqQuestions = 0;

  const appendText = (raw) => {
    if (svgDepth > 0) return;
    const text = decodeEntities(raw);
    if (heading) heading.buf.push(text);
    if (anchor) anchor.buf.push(text);
    if (para) para.buf.push(text);
    buf.full.push(text);
    if (boilerDepth === 0) {
      buf.clean.push(text);
      if (mainDepth > 0) buf.main.push(text);
      if (articleDepth > 0) buf.article.push(text);
    }
  };
  const breakText = () => appendText('\n');
  const closePara = () => {
    if (!para) return;
    const text = clean(para.buf.join(''));
    if (text) {
      res.paragraphs.push({ text, boiler: para.boiler, main: para.main, article: para.article });
      res.blocks.push({ type: 'p', text, boiler: para.boiler, main: para.main, article: para.article });
    }
    para = null;
  };
  const closeHeading = () => {
    if (!heading) return;
    const htext = clean(heading.buf.join(''));
    res.headings.push({ level: heading.level, text: htext, boiler: heading.boiler, id: heading.id });
    res.blocks.push({ type: 'h', level: heading.level, text: htext, boiler: heading.boiler, main: heading.main, article: heading.article });
    heading = null;
  };
  const closeAnchor = () => {
    if (!anchor) return;
    const href = anchor.attrs.href;
    const url = resolveHref(href, base);
    const rel = (anchor.attrs.rel || '').toLowerCase();
    res.links.push({
      href: href || '',
      url,
      text: clean(anchor.buf.join('')) || clean(anchor.attrs['aria-label'] || anchor.attrs.title || ''),
      rel,
      nofollow: /\b(nofollow|ugc|sponsored)\b/.test(rel),
      boiler: anchor.boiler,
      fragmentOnly: Boolean(href && href.trim().startsWith('#')),
      pos: anchor.pos,
    });
    anchor = null;
  };

  for (const tok of tokenize(String(html || ''))) {
    if (tok.type === 'text') {
      if (inBody || headDone || !res.title) appendText(tok.text);
      continue;
    }
    if (tok.type === 'raw') {
      if (tok.name === 'title') {
        if (svgDepth === 0) {
          res.titleCount++;
          if (!res.title) res.title = clean(decodeEntities(tok.text));
        }
      } else if (tok.name === 'script') {
        const type = (tok.attrs.type || '').toLowerCase();
        if (type === 'application/ld+json') {
          const parsed = parseJsonLd(tok.text);
          res.jsonLd.push({ types: parsed.types, error: parsed.error, data: parsed.data, pos: tok.pos, ...(parsed.error ? { raw: tok.text.slice(0, 2000) } : {}) });
          if (parsed.info.datePublished && !res.dates.published) res.dates.published = parsed.info.datePublished;
          if (parsed.info.dateModified && !res.dates.modified) res.dates.modified = parsed.info.dateModified;
          if (parsed.info.author) jsonLdAuthor = true;
          faqQuestions += parsed.info.faqQuestions;
        } else if (!tok.attrs.src && inlineScriptBytes < 400000) {
          inlineScriptBytes += tok.text.length;
          res.inlineScripts.push({ type, text: tok.text.slice(0, 100000), attrs: tok.attrs });
        }
      } else if (tok.name === 'textarea') {
        res.counts.textareas++;
      }
      continue;
    }
    if (tok.type === 'close') {
      const name = tok.name;
      if (name === 'head') headDone = true;
      if (name === 'svg' && svgDepth > 0) svgDepth--;
      else if (name === 'picture' && pictureDepth > 0) {
        pictureDepth--;
        if (!pictureDepth) pictureSources = [];
      } else if (BOILER.has(name) && boilerDepth > 0) {
        closePara();
        boilerDepth--;
      } else if (name === 'main' && mainDepth > 0) mainDepth--;
      else if (name === 'article' && articleDepth > 0) articleDepth--;
      if (/^h[1-6]$/.test(name)) closeHeading();
      if (name === 'a') closeAnchor();
      if (name === 'p') closePara();
      if (BLOCK.has(name)) breakText();
      continue;
    }
    // open tag
    const { name, attrs } = tok;
    // <body> may be omitted: the first element that cannot live in <head> starts the body
    if (!inBody && !HEAD_OK.has(name)) inBody = true;
    if (name === 'svg' && !tok.selfClosing) {
      svgDepth++;
      continue;
    }
    if (svgDepth > 0) continue;
    if (attrs.id) ids.add(attrs.id);
    if (attrs.itemtype) for (const t of attrs.itemtype.split(/\s+/)) if (t) microdata.add(t.replace(/^https?:\/\/schema\.org\//, ''));
    if (CLOSES_P.has(name)) closePara();
    if (BLOCK.has(name)) breakText();
    switch (name) {
      case 'html':
        res.lang = (attrs.lang || attrs['xml:lang'] || '').trim();
        break;
      case 'body':
        inBody = true;
        break;
      case 'base':
        if (attrs.href && !res.base) {
          res.base = resolveHref(attrs.href, pageUrl) || '';
          if (res.base) base = res.base;
        }
        break;
      case 'meta': {
        const key = (attrs.name || attrs.property || attrs['http-equiv'] || attrs.itemprop || '').toLowerCase().trim();
        const content = attrs.content ?? '';
        if (attrs.charset) res.charset = attrs.charset;
        if (!key) break;
        if (!(key in res.meta)) res.meta[key] = content;
        if (key === 'description') {
          res.metaDescriptionCount++;
          if (!res.metaDescription) res.metaDescription = clean(content);
        } else if (key === 'robots' || key === 'googlebot') {
          res.robots.push(...content.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
          res.robotsPos.push(tok.pos);
        } else if (key === 'viewport') res.viewport = content;
        else if (key === 'refresh') res.metaRefresh = content;
        else if (key === 'content-language' && !res.lang) res.lang = content;
        else if (key === 'content-type' && !res.charset) res.charset = (/charset=([^;]+)/i.exec(content) || [])[1] || '';
        else if (key === 'google-site-verification') res.verification.google.push(content);
        else if (key === 'msvalidate.01') res.verification.bing.push(content);
        else if (key === 'yandex-verification') res.verification.yandex.push(content);
        else if (key === 'og:updated_time' || key === 'article:modified_time') {
          if (!res.dates.modified) res.dates.modified = content;
          if (key.startsWith('og:') && !('updated_time' in res.og)) res.og.updated_time = content;
        } else if (key.startsWith('og:')) {
          if (!(key.slice(3) in res.og)) res.og[key.slice(3)] = content;
        } else if (key.startsWith('twitter:')) {
          if (!(key.slice(8) in res.twitter)) res.twitter[key.slice(8)] = content;
        } else if (key === 'article:published_time' && !res.dates.published) res.dates.published = content;
        break;
      }
      case 'link': {
        const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
        const href = resolveHref(attrs.href, base);
        if (rel.includes('canonical')) {
          res.canonicals.push(href || attrs.href || '');
          res.canonicalsRaw.push(attrs.href || '');
          res.canonicalPos.push(tok.pos);
        }
        if (rel.includes('alternate') && attrs.hreflang) res.hreflang.push({ lang: attrs.hreflang.trim(), href: href || attrs.href || '', pos: tok.pos });
        if ((rel.includes('preconnect') || rel.includes('dns-prefetch')) && href) {
          try {
            const h = new URL(href).hostname.toLowerCase();
            if (h && !res.preconnects.includes(h)) res.preconnects.push(h);
          } catch {
            /* ignore */
          }
        }
        if (rel.includes('preload') && (attrs.as || '').toLowerCase() === 'image') {
          res.preloads.push({ href: resolveHref(attrs.href || '', base) || attrs.href || '', imagesrcset: attrs.imagesrcset || '', imagesizes: attrs.imagesizes || '', fetchpriority: (attrs.fetchpriority || '').toLowerCase(), media: attrs.media || '' });
        }
        break;
      }
      case 'a':
        closeAnchor();
        anchor = { attrs, buf: [], boiler: boilerDepth > 0, pos: tok.pos };
        break;
      case 'picture':
        if (!tok.selfClosing) {
          pictureDepth++;
          pictureSources = [];
        }
        break;
      case 'source':
        if (pictureDepth > 0) pictureSources.push({ srcset: attrs.srcset || attrs['data-srcset'] || '', type: (attrs.type || '').toLowerCase(), media: attrs.media || '', sizes: attrs.sizes || '' });
        break;
      case 'img':
        res.images.push({
          src: resolveHref(attrs.src || attrs['data-src'] || attrs['data-lazy-src'] || '', base) || attrs.src || '',
          rawSrc: attrs.src || '',
          lazySrc: attrs['data-src'] || attrs['data-lazy-src'] || '',
          alt: 'alt' in attrs ? attrs.alt : null,
          loading: (attrs.loading || '').toLowerCase(),
          width: attrs.width || '',
          height: attrs.height || '',
          srcset: attrs.srcset || attrs['data-srcset'] || '',
          sizes: attrs.sizes || '',
          fetchpriority: (attrs.fetchpriority || '').toLowerCase(),
          decoding: (attrs.decoding || '').toLowerCase(),
          role: (attrs.role || '').toLowerCase(),
          ariaHidden: String(attrs['aria-hidden'] || '').toLowerCase() === 'true',
          title: attrs.title || '',
          className: attrs.class || '',
          style: attrs.style || '',
          inPicture: pictureDepth > 0,
          sources: pictureDepth > 0 ? pictureSources.slice() : [],
          inBody,
          main: mainDepth > 0,
          article: articleDepth > 0,
          inLink: Boolean(anchor),
          index: res.images.length,
          pos: tok.pos,
          boiler: boilerDepth > 0,
        });
        if (anchor && 'alt' in attrs && attrs.alt) anchor.buf.push(` ${attrs.alt} `);
        break;
      case 'script':
        if (attrs.src) res.scripts.push({ src: resolveHref(attrs.src, base) || attrs.src, type: (attrs.type || '').toLowerCase(), attrs });
        break;
      case 'iframe':
        res.counts.iframes++;
        res.iframes.push(resolveHref(attrs.src || attrs['data-src'] || '', base) || attrs.src || '');
        break;
      case 'p':
        para = { buf: [], boiler: boilerDepth > 0, main: mainDepth > 0, article: articleDepth > 0 };
        break;
      case 'time':
        if (attrs.datetime) res.times.push(attrs.datetime);
        break;
      case 'table':
        res.counts.tables++;
        break;
      case 'ul':
      case 'ol':
        res.counts.lists++;
        break;
      case 'li':
        res.counts.listItems++;
        break;
      case 'form':
        res.counts.forms++;
        break;
      case 'input':
        if ((attrs.type || 'text').toLowerCase() !== 'hidden') res.counts.inputs++;
        break;
      case 'select':
        res.counts.selects++;
        break;
      case 'button':
        res.counts.buttons++;
        break;
      case 'canvas':
        res.counts.canvases++;
        break;
      case 'video':
        res.counts.videos++;
        break;
      case 'audio':
        res.counts.audios++;
        break;
      case 'details':
        res.counts.details++;
        break;
      case 'figure':
        res.counts.figures++;
        break;
      case 'blockquote':
        res.counts.blockquotes++;
        break;
      case 'pre':
        res.counts.pre++;
        break;
      case 'main':
        if (!tok.selfClosing) mainDepth++;
        res.hasMain = true;
        break;
      case 'article':
        if (!tok.selfClosing) articleDepth++;
        res.hasArticle = true;
        break;
      default:
        break;
    }
    if (BOILER.has(name) && !tok.selfClosing) boilerDepth++;
    if (/^h[1-6]$/.test(name)) {
      closeHeading();
      heading = { level: Number(name[1]), buf: [], boiler: boilerDepth > 0, id: attrs.id || '', main: mainDepth > 0, article: articleDepth > 0 };
    }
  }
  closeAnchor();
  closeHeading();
  closePara();

  const join = (parts) =>
    parts
      .join('')
      .replace(/[ \t\f\r\u00a0\u2002\u2003\u2009]+/g, ' ')
      .replace(/ *\n[\n ]*/g, '\n')
      .trim();
  const mainText = join(buf.main);
  const articleText = join(buf.article);
  const cleanText = join(buf.clean);
  res.fullText = join(buf.full);
  res.text = mainText.length >= 100 ? mainText : articleText.length >= 100 ? articleText : cleanText;
  res.contentSource = res.text === mainText && mainText ? 'main' : res.text === articleText && articleText ? 'article' : 'body';
  res.stats = textStats(res.text);
  res.canonical = res.canonicals[0] || '';
  res.h1 = res.headings.filter((h) => h.level === 1).map((h) => h.text);
  res.jsonLdTypes = [...new Set(res.jsonLd.flatMap((b) => b.types))];
  res.jsonLdErrors = res.jsonLd.filter((b) => b.error).map((b) => b.error);
  res.microdataTypes = [...microdata];
  res.hasAuthorMarkup = jsonLdAuthor || 'author' in res.meta || res.links.some((l) => /\bauthor\b/.test(l.rel));
  res.faqQuestions = faqQuestions;
  res.robotsNoindex = res.robots.includes('noindex') || res.robots.includes('none');
  res.robotsNofollow = res.robots.includes('nofollow') || res.robots.includes('none');
  const safeDecode = (x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  };
  res.tocLinks = res.links.filter((l) => l.fragmentOnly && (ids.has(l.href.trim().slice(1)) || ids.has(safeDecode(l.href.trim().slice(1))))).length;
  // in-page anchors whose target id does not exist ("#" and "#top" are conventional and skipped)
  res.brokenFragments = [...new Set(res.links.filter((l) => l.fragmentOnly).map((l) => l.href.trim()).filter((h) => h.length > 1 && !/^#(top|main|content)$/i.test(h) && !ids.has(h.slice(1)) && !ids.has(safeDecode(h.slice(1)))))];
  const pick = (source) => res.paragraphs.filter((p) => !p.boiler && (source === 'main' ? p.main : source === 'article' ? p.article : true));
  res.contentParagraphs = pick(res.contentSource).map((p) => p.text);
  res.contentHeadings = res.headings.filter((h) => !h.boiler);
  res.contentBlocks = res.blocks
    .filter((b) => !b.boiler && (b.type === 'h' || res.contentSource === 'body' || (res.contentSource === 'main' ? b.main : b.article)))
    .map((b) => (b.type === 'h' ? { type: 'h', level: b.level, text: b.text } : { type: 'p', text: b.text }));
  return res;
}

/** Split a robots directive string (meta or X-Robots-Tag) into lower-case tokens. */
export function robotsTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[,;]/)
    .map((s) => s.replace(/^[a-z0-9_-]+\s*:\s*(?=(noindex|nofollow|none|all|index|follow|noarchive|nosnippet|max-|unavailable_after))/, '').trim())
    .filter(Boolean);
}

export function isInternal(url, host) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return h === String(host || '').toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
}

// Elements the HTML parser keeps inside <head>; any other start tag (or visible text) ends <head> early, and
// everything after it (canonical, robots meta, hreflang) is parsed into <body>, where Google ignores it.
const HEAD_OK = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'title', 'noscript', 'noframes', 'style', 'script', 'template', 'html', 'head']);

function seoTagOf(tok) {
  if (tok.type !== 'open') return null;
  const a = tok.attrs || {};
  if (tok.name === 'link') {
    const rel = String(a.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical')) return 'canonical';
    if (rel.includes('alternate') && a.hreflang) return 'hreflang';
    return null;
  }
  if (tok.name === 'meta') {
    const key = String(a.name || a.property || '').toLowerCase();
    if (key === 'robots' || key === 'googlebot' || key === 'bingbot') return 'robots';
    if (key === 'description') return 'description';
    return null;
  }
  if (tok.name === 'title') return 'title';
  return null;
}

/**
 * Where <head> really ends. Returns { closedEarly: {tag, pos} | null, afterClose: [{tag, pos}] (SEO tags the author
 * put in <head> that a parser moves to <body>), inBody: [{tag, pos}] (SEO tags after </head> or <body>),
 * noscriptInHead: [tag names inside <noscript> in head that only scripting-disabled parsers choke on] }.
 */
export function headDiagnostics(html) {
  const src = String(html || '');
  let state = 'before'; // before -> head -> closed (implicitly) -> body
  let closedEarly = null;
  const afterClose = [];
  const inBody = [];
  const noscriptInHead = [];
  for (const tok of tokenize(src)) {
    if (tok.type === 'text') {
      // whitespace is fine; visible text starts <body> (before or inside <head>)
      if ((state === 'before' || state === 'head') && /[^\s\ufeff]/.test(tok.text)) {
        closedEarly = { tag: '#text', pos: tok.pos, text: tok.text.trim().slice(0, 40) };
        state = 'closed';
      }
      continue;
    }
    if (tok.type === 'raw') {
      if (tok.name === 'noscript' && (state === 'head' || state === 'before')) {
        for (const m of tok.text.matchAll(/<([a-z][a-z0-9-]*)/gi)) {
          const t = m[1].toLowerCase();
          if (!['link', 'meta', 'style'].includes(t)) noscriptInHead.push(t);
        }
      }
      continue;
    }
    if (tok.type === 'close') {
      if (tok.name === 'head') {
        if (state === 'closed') state = 'body';
        else if (state === 'head' || state === 'before') state = 'body';
      }
      continue;
    }
    const name = tok.name;
    const seo = seoTagOf(tok);
    if (state === 'body') {
      if (seo && seo !== 'title') inBody.push({ tag: seo, pos: tok.pos });
      continue;
    }
    if (name === 'body') {
      state = 'body';
      continue;
    }
    if (name === 'html') continue;
    if (name === 'head') {
      if (state === 'before') state = 'head';
      continue;
    }
    if (HEAD_OK.has(name)) {
      if (state === 'before') state = 'head';
      if (state === 'closed' && seo) afterClose.push({ tag: seo, pos: tok.pos });
      continue;
    }
    // any other element ends <head>
    if (state === 'before' || state === 'head') {
      closedEarly = { tag: name, pos: tok.pos };
      state = 'closed';
    }
  }
  return { closedEarly, afterClose, inBody, noscriptInHead: [...new Set(noscriptInHead)] };
}
