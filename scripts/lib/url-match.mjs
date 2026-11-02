// URL matching for migrations and link reclaim: exact path, normalized path, slug, title/H1 and body-text tiers.
// Never maps to the home page unless the old URL is a home page itself.
import { normalizeUrl } from './util.mjs';
import { normalizeText, rawTokens, stemLatin, isStopword, shingleSet, jaccard, minhashSignature, lshCandidatePairs } from './text.mjs';

export const MATCH_METHODS = ['exact', 'normalized-path', 'slug', 'title', 'content', 'manual'];

const TRACKING = /^(utm_[a-z]+|gclid|dclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|srsltid|yclid|ref|ref_src)$/i;
const INDEX_FILE = /\/(index|default)\.(html?|php|aspx?|jsp)$/i;
const EXTENSION = /\.(html?|php|aspx?|jsp)$/i;
const GENERIC_SLUGS = new Set(['', 'index', 'default', 'home', 'main', 'page', 'pages', 'amp', 'post', 'posts', 'article', 'articles', 'item', 'view', 'detail', 'details', 'new', 'old', 'all', 'list']);

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Path, query and keys used by every tier. Returns null for non-HTTP input. */
export function urlParts(input) {
  const url = normalizeUrl(String(input || '').trim(), { stripTracking: true });
  if (!url) return null;
  const u = new URL(url);
  const pathname = u.pathname || '/';
  const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  let p = safeDecode(pathname).toLowerCase().replace(/\/{2,}/g, '/');
  p = p.replace(INDEX_FILE, '/').replace(EXTENSION, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const segments = p.split('/').filter(Boolean);
  const slug = segments.length ? segments[segments.length - 1] : '';
  return {
    url,
    protocol: u.protocol,
    host: u.hostname.toLowerCase(),
    pathname,
    exactKey: `${pathname}${u.search}`,
    key: `${p || '/'}${query ? `?${query}` : ''}`,
    path: p || '/',
    segments,
    slug,
    section: segments.length > 1 ? segments[0] : '',
    isHome: (p === '/' || p === '') && !query,
  };
}

export const isHomeUrl = (url) => Boolean((urlParts(url) || {}).isHome);

/** http -> https on the same host and path (the HSTS first hop, allowed before one real redirect). */
export function isHstsHop(hop) {
  try {
    const a = new URL(hop.url);
    const b = new URL(hop.location);
    return a.protocol === 'http:' && b.protocol === 'https:' && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/** A slug carries meaning (not "index", a number, a date or a language code). */
export function meaningfulSlug(slug) {
  const s = String(slug || '');
  if (GENERIC_SLUGS.has(s)) return false;
  if (/^\d+$/.test(s) || /^[a-z]{2}(-[a-z]{2,4})?$/i.test(s)) return false;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/u.test(s) || s.replace(/[^a-z0-9]/gi, '').length >= 3;
}

const SEPARATORS = /\s+[|｜\-–—·•:：»]\s+|\s*[|｜]\s*/;

/** Title prefixes/suffixes shared by >= 30% (and >= 3) of the titles in a set, e.g. " | Example Coffee". */
export function sharedAffixes(titles) {
  const suffix = new Map();
  const prefix = new Map();
  let n = 0;
  for (const t of titles) {
    const parts = String(t || '').split(SEPARATORS).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    n++;
    const last = normalizeText(parts[parts.length - 1]);
    const first = normalizeText(parts[0]);
    suffix.set(last, (suffix.get(last) || 0) + 1);
    prefix.set(first, (prefix.get(first) || 0) + 1);
  }
  const min = Math.max(3, Math.ceil(n * 0.3));
  const pick = (m) => new Set([...m].filter(([k, c]) => k && c >= min).map(([k]) => k));
  return { suffixes: pick(suffix), prefixes: pick(prefix) };
}

export function stripAffixes(title, affixes) {
  const parts = String(title || '').split(SEPARATORS).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 || !affixes) return String(title || '').trim();
  const n = parts.length;
  if (affixes.suffixes.has(normalizeText(parts[parts.length - 1]))) parts.pop();
  if (parts.length > 1 && affixes.prefixes.has(normalizeText(parts[0]))) parts.shift();
  return parts.length === n ? String(title).trim() : parts.join(' ');
}

/** Latin words (stemmed, no stopwords) + CJK character bigrams. */
export function titleTokens(text) {
  const out = new Set();
  for (const tok of rawTokens(text)) {
    if (tok.cjk) {
      const s = tok.text;
      if (s.length === 1) out.add(s);
      for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
    } else if (!isStopword(tok.text) && !/^\d{1,2}$/.test(tok.text)) out.add(stemLatin(tok.text));
  }
  return out;
}

/** Best of title/H1 cross similarities (Jaccard of title tokens). */
function textSim(a, b) {
  let best = 0;
  for (const x of a.titleSets) for (const y of b.titleSets) if (x.size && y.size) best = Math.max(best, jaccard(x, y));
  return best;
}

function prepare(entries, affixes, ignore) {
  const seen = new Map();
  for (const e of entries) {
    const parts = urlParts(e.url);
    if (!parts || seen.has(parts.url)) continue;
    const titles = [stripAffixes(e.title, affixes), stripAffixes(e.h1, affixes)].filter(Boolean);
    const titleSets = titles.map((t) => new Set([...titleTokens(t)].filter((tok) => !ignore.has(tok)))).filter((s) => s.size);
    seen.set(parts.url, { ...e, ...parts, titleSets, text: e.text || '' });
  }
  return [...seen.values()];
}

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * Match old URLs to new URLs. entries: [{url, title?, h1?, text?, ...}]. Tiers run in order over all old URLs and each new URL is
 * used once by the fuzzy tiers (unless allowMany). ignoreTerms: brand names whose words carry no topic signal in titles. Returns {matches: [{old, new, method, confidence, score, type, reason, notes}], unmatched:
 * [{old, candidates: [{url, method, score}], parentHint}]}. Old/new entries are returned as given (plus parsed parts).
 */
export function matchUrls(oldEntries, newEntries, opts = {}) {
  const { allowMany = false, strongTitle = 0.6, weakTitle = 0.35, strongContent = 0.5, weakContent = 0.3, margin = 0.1, maxPairs = 250000, ignoreTerms = [] } = opts;
  const ignore = new Set(ignoreTerms.flatMap((t) => [...titleTokens(t)]));
  const olds = prepare(oldEntries, sharedAffixes(oldEntries.map((e) => e.title)), ignore);
  const news = prepare(newEntries, sharedAffixes(newEntries.map((e) => e.title)), ignore);
  const taken = new Set();
  const result = new Map();
  const free = (j) => allowMany || !taken.has(j);
  const homeOk = (o, n) => !n.isHome || o.isHome;
  const assign = (i, j, method, score, confidence, extra = {}) => {
    result.set(i, { method, score: round(score), confidence, j, ...extra });
    if (!allowMany) taken.add(j);
  };
  const index = (keyFn) => {
    const m = new Map();
    news.forEach((n, j) => {
      const k = keyFn(n);
      if (k === null || k === undefined) return;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(j);
    });
    return m;
  };
  // Deterministic tiers may send several variants of one old page (http/https, www, .html) to the same new URL.
  const bestDeterministic = (o, js) => js.slice().sort((a, b) => Number(news[b].host === o.host) - Number(news[a].host === o.host) || Number(free(b)) - Number(free(a)))[0];

  // 1 + 2: exact and normalized path (confidence 4)
  for (const [tier, keyFn] of [['exact', (x) => x.exactKey], ['normalized-path', (x) => x.key]]) {
    const idx = index(keyFn);
    olds.forEach((o, i) => {
      if (result.has(i)) return;
      const j = bestDeterministic(o, idx.get(keyFn(o)) || []);
      if (j === undefined || !homeOk(o, news[j])) return;
      result.set(i, { method: tier, score: 1, confidence: 4, j });
      taken.add(j);
    });
  }

  // 3: same meaningful last segment; prefer the same section, then the more similar title
  const bySlug = index((n) => (meaningfulSlug(n.slug) ? n.slug : null));
  const slugPairs = [];
  olds.forEach((o, i) => {
    if (result.has(i) || !meaningfulSlug(o.slug)) return;
    const cands = (bySlug.get(o.slug) || []).filter((j) => homeOk(o, news[j]));
    const scored = cands.map((j) => ({ j, s: 0.8 + (news[j].section && news[j].section === o.section ? 0.1 : 0) + 0.1 * textSim(o, news[j]) })).sort((a, b) => b.s - a.s);
    const ambiguous = scored.length > 1 && Math.abs(scored[0].s - scored[1].s) < 1e-9;
    for (const c of scored) slugPairs.push({ i, j: c.j, s: c.s, ambiguous });
  });
  greedy(slugPairs, (p) => {
    if (result.has(p.i) || !free(p.j)) return;
    assign(p.i, p.j, 'slug', p.s, p.ambiguous ? 2 : 3, { notes: p.ambiguous ? 'ambiguous: several new URLs share this slug' : '' });
  });

  // 4: title/H1 similarity via an inverted token index
  const df = new Map();
  news.forEach((n) => {
    for (const tok of new Set(n.titleSets.flatMap((s) => [...s]))) df.set(tok, (df.get(tok) || 0) + 1);
  });
  const tooCommon = Math.max(50, Math.ceil(news.length * 0.1));
  const tokIndex = new Map();
  news.forEach((n, j) => {
    for (const tok of new Set(n.titleSets.flatMap((s) => [...s]))) {
      if (df.get(tok) > tooCommon) continue;
      if (!tokIndex.has(tok)) tokIndex.set(tok, []);
      tokIndex.get(tok).push(j);
    }
  });
  const titleScores = new Map();
  const titlePairs = [];
  olds.forEach((o, i) => {
    if (!o.titleSets.length || result.has(i)) return;
    const cands = new Set();
    for (const s of o.titleSets) for (const tok of s) for (const j of tokIndex.get(tok) || []) cands.add(j);
    const scored = [...cands].filter((j) => homeOk(o, news[j])).map((j) => ({ j, s: textSim(o, news[j]) })).filter((c) => c.s > 0).sort((a, b) => b.s - a.s);
    titleScores.set(i, scored.slice(0, 5));
    scored.filter((c) => c.s >= weakTitle).forEach((c) => titlePairs.push({ i, j: c.j, s: c.s, runnerUp: (scored.find((x) => x.j !== c.j) || { s: 0 }).s }));
  });
  greedy(titlePairs, (p) => {
    if (result.has(p.i) || !free(p.j)) return;
    const strong = p.s >= strongTitle && p.s - p.runnerUp >= margin;
    assign(p.i, p.j, 'title', p.s, strong ? 2 : 1, { notes: strong ? '' : 'weak title match: check by hand' });
  });

  // 5: body text similarity (shingles; LSH candidates for large sets)
  const contentScores = new Map();
  const oldText = olds.map((o, i) => (o.text && !result.has(i) ? { i, set: shingleSet(o.text) } : null)).filter(Boolean);
  const newText = news.map((n, j) => (n.text ? { j, set: shingleSet(n.text) } : null)).filter(Boolean);
  if (oldText.length && newText.length) {
    const pairs = [];
    if (oldText.length * newText.length <= maxPairs) {
      for (const a of oldText) for (const b of newText) pairs.push([a, b]);
    } else {
      const sigs = [...oldText, ...newText].map((x) => minhashSignature(x.set));
      for (const [x, y] of lshCandidatePairs(sigs)) {
        const [lo, hi] = x < y ? [x, y] : [y, x];
        if (lo < oldText.length && hi >= oldText.length) pairs.push([oldText[lo], newText[hi - oldText.length]]);
      }
    }
    const contentPairs = [];
    for (const [a, b] of pairs) {
      if (!homeOk(olds[a.i], news[b.j])) continue;
      const s = jaccard(a.set, b.set);
      if (s <= 0) continue;
      if (!contentScores.has(a.i)) contentScores.set(a.i, []);
      contentScores.get(a.i).push({ j: b.j, s });
      if (s >= weakContent) contentPairs.push({ i: a.i, j: b.j, s });
    }
    for (const list of contentScores.values()) list.sort((x, y) => y.s - x.s);
    greedy(contentPairs, (p) => {
      if (result.has(p.i) || !free(p.j)) return;
      const runnerUp = ((contentScores.get(p.i) || []).find((x) => x.j !== p.j) || { s: 0 }).s;
      const strong = p.s >= strongContent && p.s - runnerUp >= margin;
      assign(p.i, p.j, 'content', p.s, strong ? 2 : 1, { notes: strong ? '' : 'weak content match: check by hand' });
    });
  }

  // Results: types, consolidation, manual list with losing candidates and a parent-section hint
  const targets = new Map();
  for (const r of result.values()) targets.set(r.j, (targets.get(r.j) || 0) + 1);
  const matchedTarget = new Map([...result].map(([i, r]) => [olds[i].key, news[r.j]]));
  const newByKey = new Map(news.map((n) => [n.key, n]));
  const matches = [];
  const unmatched = [];
  olds.forEach((o, i) => {
    const r = result.get(i);
    if (r) {
      const n = news[r.j];
      let type = '1:1';
      if (r.method === 'exact' && n.url === o.url) type = 'unchanged';
      else if (['exact', 'normalized-path'].includes(r.method) && n.host === o.host) type = 'normalize';
      else if (!['exact', 'normalized-path'].includes(r.method) && targets.get(r.j) > 1) type = 'consolidate';
      matches.push({ old: o, new: n, method: r.method, confidence: r.confidence, score: r.score, type, reason: reasonText(r, o, n, type), notes: r.notes || '' });
      return;
    }
    const cand = new Map();
    const add = (j, method, s) => {
      if (!homeOk(o, news[j])) return;
      const prev = cand.get(j);
      if (!prev || s > prev.score) cand.set(j, { url: news[j].url, method, score: round(s) });
    };
    for (const c of titleScores.get(i) || []) add(c.j, 'title', c.s);
    for (const c of (contentScores.get(i) || []).slice(0, 5)) add(c.j, 'content', c.s);
    if (meaningfulSlug(o.slug)) for (const j of bySlug.get(o.slug) || []) add(j, 'slug', 0.8);
    unmatched.push({ old: o, candidates: [...cand.values()].sort((a, b) => b.score - a.score).slice(0, 3), parentHint: parentHint(o, matchedTarget, newByKey) });
  });
  return { matches, unmatched };
}

/** Assign best pairs first: higher score, then the order old URLs were given in. */
function greedy(pairs, fn) {
  pairs.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  for (const p of pairs) fn(p);
}

function reasonText(r, o, n, type) {
  if (type === 'unchanged') return 'URL unchanged: no redirect needed';
  if (r.method === 'exact') return 'same path on the new host';
  if (type === 'normalize') return 'same page, only the URL form differs (protocol, case, trailing slash, .html, index file, tracking parameters): not a retirement';
  if (r.method === 'normalized-path') return 'same path after normalization on the new host';
  if (r.method === 'slug') return `same slug "${safeDecode(o.slug)}"${n.section && n.section === o.section ? ' in the same section' : ''}`;
  if (r.method === 'title') return `title/H1 similarity ${r.score}`;
  return `body text similarity ${r.score}`;
}

/** New URL for the closest old parent path (its own mapping first, then the same path on the new site); never the home page. */
export function parentHint(o, matchedTarget, newByKey) {
  for (let k = o.segments.length - 1; k >= 1; k--) {
    const parentKey = `/${o.segments.slice(0, k).join('/')}`;
    const target = matchedTarget.get(parentKey) || newByKey.get(parentKey);
    if (target && !target.isHome) return target.url;
  }
  return '';
}
