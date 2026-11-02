// Internal link graph from crawl-site output: weighted PageRank (template links discounted), a 1-100 Link Score,
// click depth, inlinks by position, and phrase matching in body paragraphs for link suggestions.
import { normalizeUrl } from './util.mjs';
import { normalizeText } from './text.mjs';

/** Edge weights: contextual (body) link, template link (nav/header/footer/aside), link present on most pages. */
export const WEIGHTS = { body: 1, boiler: 0.5, sitewide: 0.3 };

const urlKey = (u) => normalizeUrl(u) || String(u || '');

/** Follow a redirect map (url -> target) to the final URL (max 10 hops). */
export function resolveRedirect(url, redirects) {
  let k = urlKey(url);
  for (let i = 0; i < 10 && redirects && redirects.has(k); i++) {
    const next = redirects.get(k);
    if (!next || next === k) break;
    k = next;
  }
  return k;
}

/**
 * Build the graph from links.jsonl records ({url, finalUrl, links:[{url, internal, text, boiler, nofollow}]}).
 * Nodes = crawled pages; one edge per source->target (deduped) with weight body 1.0 / template 0.5 / sitewide 0.3
 * (a target linked from more than `sitewideShare` of all pages in the same position). Links that are only
 * nofollow keep their share in the denominator but pass nothing ("evaporate", as in Screaming Frog's Link Score);
 * links to URLs outside the crawled graph are ignored. Redirecting targets count for their final URL.
 */
export function buildGraph(records, { redirects = new Map(), sitewideShare = 0.5, minPagesForSitewide = 4 } = {}) {
  const nodes = [];
  const index = new Map();
  for (const r of records) {
    const u = urlKey(r.finalUrl || r.url);
    if (!index.has(u)) {
      index.set(u, nodes.length);
      nodes.push(u);
    }
  }
  for (const r of records) if (r.url && !index.has(urlKey(r.url))) index.set(urlKey(r.url), index.get(urlKey(r.finalUrl || r.url)));
  const n = nodes.length;
  const pairs = Array.from({ length: n }, () => new Map());
  const linkTexts = Array.from({ length: n }, () => []);
  for (const r of records) {
    const from = index.get(urlKey(r.finalUrl || r.url));
    for (const l of r.links || []) {
      if (l.text && !l.boiler) linkTexts[from].push(l.text);
      if (!l.internal || !l.url) continue;
      const target = resolveRedirect(l.url, redirects);
      const to = index.get(target);
      if (to === undefined || to === from) continue;
      const e = pairs[from].get(to) || { to, followBody: false, followBoiler: false, nofollowBody: false, nofollowBoiler: false };
      if (l.nofollow) e[l.boiler ? 'nofollowBoiler' : 'nofollowBody'] = true;
      else e[l.boiler ? 'followBoiler' : 'followBody'] = true;
      pairs[from].set(to, e);
    }
  }
  const bodySources = new Array(n).fill(0);
  const boilerSources = new Array(n).fill(0);
  for (const m of pairs) {
    for (const e of m.values()) {
      if (e.followBody) bodySources[e.to]++;
      if (e.followBoiler) boilerSources[e.to]++;
    }
  }
  const sitewide = (count) => n >= minPagesForSitewide && count / n > sitewideShare;
  const out = [];
  const evap = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const edges = [];
    for (const e of pairs[i].values()) {
      if (e.followBody) edges.push({ to: e.to, weight: sitewide(bodySources[e.to]) ? WEIGHTS.sitewide : WEIGHTS.body, body: true });
      else if (e.followBoiler) edges.push({ to: e.to, weight: sitewide(boilerSources[e.to]) ? WEIGHTS.sitewide : WEIGHTS.boiler, body: false });
      else evap[i] += e.nofollowBody ? WEIGHTS.body : WEIGHTS.boiler;
    }
    out.push(edges);
  }
  return { nodes, index, out, evap, pairs, linkTexts, sitewideTargets: nodes.filter((_, i) => sitewide(bodySources[i]) || sitewide(boilerSources[i])) };
}

/** Weighted PageRank (damping 0.85, uniform teleport, dangling mass spread uniformly), iterated to convergence; sums to 1. */
export function pageRank(graph, { damping = 0.85, tol = 1e-10, maxIter = 300 } = {}) {
  const n = graph.nodes.length;
  if (!n) return { pr: [], iterations: 0 };
  let pr = new Float64Array(n).fill(1 / n);
  const outW = graph.out.map((edges, i) => edges.reduce((s, e) => s + e.weight, 0) + graph.evap[i]);
  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const next = new Float64Array(n).fill((1 - damping) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!outW[i]) {
        dangling += pr[i];
        continue;
      }
      const share = (damping * pr[i]) / outW[i];
      for (const e of graph.out[i]) next[e.to] += share * e.weight;
    }
    if (dangling) {
      const add = (damping * dangling) / n;
      for (let i = 0; i < n; i++) next[i] += add;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(next[i] - pr[i]);
    pr = next;
    if (diff < tol) break;
  }
  const sum = pr.reduce((s, x) => s + x, 0) || 1;
  return { pr: Array.from(pr, (x) => x / sum), iterations };
}

/** Link Score on a log scale over the given node indexes: lowest = 1, highest = 100 (like Screaming Frog's). */
export function linkScores(pr, indexes) {
  const vals = indexes.map((i) => pr[i]).filter((x) => x > 0);
  const scores = new Map();
  if (!vals.length) return scores;
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const lo = Math.log(min);
  const hi = Math.log(max);
  for (const i of indexes) scores.set(i, hi > lo ? 1 + (99 * (Math.log(pr[i]) - lo)) / (hi - lo) : 100);
  return scores;
}

/** Click depth from `start` over followable links (body and template); unreachable nodes are absent. */
export function clickDepth(graph, start) {
  const depth = new Map();
  if (start === undefined || start === null || start < 0) return depth;
  depth.set(start, 0);
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (const e of graph.out[i]) {
      if (depth.has(e.to)) continue;
      depth.set(e.to, depth.get(i) + 1);
      queue.push(e.to);
    }
  }
  return depth;
}

/** Inlink counts per node: {total, body, nav} = unique source pages with any / followable body / followable template links. */
export function inlinkCounts(graph) {
  const n = graph.nodes.length;
  const res = Array.from({ length: n }, () => ({ total: 0, body: 0, nav: 0 }));
  for (const m of graph.pairs) {
    for (const e of m.values()) {
      res[e.to].total++;
      if (e.followBody) res[e.to].body++;
      if (e.followBoiler) res[e.to].nav++;
    }
  }
  return res;
}

// ---------- phrase matching ----------

// CJK by Script_Extensions, so the long-vowel mark ー and iteration marks count as Japanese
const CJK_CLASS = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}';
const CJK_CHAR = new RegExp(`[${CJK_CLASS}]`, 'u');
const UNIT_TAIL = /^[\p{M}\uFF9E\uFF9F]$/u;
/** normalizeText plus Greek final-sigma folding (the same on phrases and page text). */
export const normalizeKey = (value) => normalizeText(value).replace(/ς/g, 'σ');

/** normalizeText with a map back to the source: {src, norm, start[], end[]} (start/end = source span of norm[j]). */
export function normalizeWithMap(text) {
  const src = String(text || '').normalize('NFC');
  let norm = '';
  const start = [];
  const end = [];
  let lastSpace = true;
  for (let i = 0; i < src.length;) {
    // one unit = a code point plus following combining marks / half-width voiced marks (ｶﾞ -> ガ under NFKC)
    let ch = String.fromCodePoint(src.codePointAt(i));
    for (let j = i + ch.length; j < src.length;) {
      const next = String.fromCodePoint(src.codePointAt(j));
      if (!UNIT_TAIL.test(next)) break;
      ch += next;
      j += next.length;
    }
    const t = ch.normalize('NFKC').toLowerCase().replace(/ς/g, 'σ').replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ');
    for (const c of t) {
      if (c === ' ') {
        if (lastSpace) continue;
        lastSpace = true;
      } else lastSpace = false;
      for (let k = 0; k < c.length; k++) {
        start.push(i);
        end.push(i + ch.length);
      }
      norm += c;
    }
    i += ch.length;
  }
  while (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    start.pop();
    end.pop();
  }
  return { src, norm, start, end };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c) && !CJK_CHAR.test(c);

/**
 * Regex for a phrase on normalized text: Latin words need whole-word boundaries; CJK characters match as a
 * substring and may be separated by a space (people type 手沖 咖啡 and 手沖咖啡).
 */
export function phraseRegex(phrase) {
  const norm = normalizeKey(phrase);
  if (!norm) return null;
  const chars = [...norm.replace(/\s+/g, ' ')];
  let body = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === ' ') {
      body += CJK_CHAR.test(chars[i - 1] || '') || CJK_CHAR.test(chars[i + 1] || '') ? ' ?' : ' ';
      continue;
    }
    body += escapeRe(c);
    const next = chars[i + 1];
    if (next && next !== ' ' && (CJK_CHAR.test(c) || CJK_CHAR.test(next))) body += ' ?';
  }
  const first = chars[0];
  const last = chars[chars.length - 1];
  // whole words for Latin edges; a CJK neighbour is a boundary ("使用ChatGPT寫作" contains "ChatGPT")
  const pre = isWordChar(first) ? `(?<!(?![${CJK_CLASS}])[\\p{L}\\p{N}])` : '';
  const post = isWordChar(last) ? `(?!(?![${CJK_CLASS}])[\\p{L}\\p{N}])` : '';
  return new RegExp(`${pre}${body}${post}`, 'gu');
}

/** Sentence around [start, end) of `src`, at most `max` characters (cut around the match when longer). */
export function sentenceAround(src, start, end, max = 160) {
  const cjkStop = /[。！？；\n]/;
  const latinStop = /[.!?;]/;
  let s = start;
  while (s > 0) {
    const c = src[s - 1];
    if (cjkStop.test(c) || (latinStop.test(c) && /\s/.test(src[s] || ' '))) break;
    s--;
  }
  let e = end;
  while (e < src.length) {
    const c = src[e++];
    if (cjkStop.test(c) || (latinStop.test(c) && /\s/.test(src[e] || ' '))) break;
  }
  const raw = src.slice(s, e);
  const sentence = raw.trim();
  if (sentence.length <= max) return sentence;
  const at = start - s - (raw.length - raw.trimStart().length);
  const room = max - 6;
  const left = Math.max(0, Math.min(at - Math.floor((room - (end - start)) / 2), sentence.length - room));
  return `${left > 0 ? '...' : ''}${sentence.slice(left, left + room).trim()}${left + room < sentence.length ? '...' : ''}`;
}

/** Cheap pre-filter for a phrase: its first CJK character or first Latin word must occur in the normalized text. */
function probeOf(key) {
  const k = String(key || '');
  const first = [...k][0] || '';
  if (CJK_CHAR.test(first)) return first;
  const run = new RegExp(`^[^\\s${CJK_CLASS}]+`, 'u').exec(k);
  return run ? run[0] : '';
}

/**
 * Mentions of phrases in paragraphs: [{paragraph, start, end, anchor, sentence, phrase}] where anchor is the exact
 * text as written. A match inside a longer matched phrase is dropped (the longer phrase wins), and so is a match
 * that lies inside the text of an existing body link on the page (whole-word match). phrases: [{key, re, ...extra}].
 */
export function findMentions(paragraphs, phrases, { linkTexts = [] } = {}) {
  const found = [];
  const linkRes = [...new Set(linkTexts.map((t) => normalizeKey(t)).filter((t) => [...t].length >= 2))].map((t) => ({ text: t, re: phraseRegex(t) })).filter((x) => x.re);
  for (const ph of phrases) if (ph.probe === undefined) ph.probe = probeOf(normalizeKey(ph.key));
  (paragraphs || []).forEach((para, pIndex) => {
    const m = normalizeWithMap(para);
    if (!m.norm) return;
    const spans = [];
    for (const ph of phrases) {
      if (ph.probe && !m.norm.includes(ph.probe)) continue;
      ph.re.lastIndex = 0;
      for (const hit of m.norm.matchAll(ph.re)) {
        const s = hit.index;
        const e = s + hit[0].length;
        if (e <= s) continue;
        spans.push({ s, e, ph });
      }
    }
    if (!spans.length) return;
    const linked = [];
    for (const { text, re } of linkRes) {
      re.lastIndex = 0;
      for (const hit of m.norm.matchAll(re)) linked.push([hit.index, hit.index + hit[0].length, text]);
    }
    for (const a of spans) {
      if (spans.some((b) => b !== a && b.s <= a.s && b.e >= a.e && b.e - b.s > a.e - a.s)) continue;
      if (linked.some(([ls, le]) => ls <= a.s && a.e <= le)) continue;
      // a body link text that overlaps the mention may be this very occurrence: never nest links
      const partial = linked.find(([ls, le]) => a.s < le && a.e > ls);
      const start = m.start[a.s];
      const end = m.end[a.e - 1];
      found.push({ paragraph: pIndex, start, end, anchor: m.src.slice(start, end), sentence: sentenceAround(m.src, start, end), phrase: a.ph, ...(partial ? { overlapsLink: partial[2] } : {}) });
    }
  });
  return found.sort((x, y) => x.paragraph - y.paragraph || x.start - y.start);
}

/**
 * Pick suggestions: candidates sorted by score; at most one per source->target pair; batches of `batchSize`
 * where a source appears at most `maxPerSource` times and a target at most `maxPerTarget` times. The anchor of
 * each pick is the least-used variant for that target among the mentions in the chosen paragraph.
 * candidates: [{source, target, score, mentions:[{anchor, phrase:{key}, paragraph, sentence}], ...}]
 */
export function batchSuggestions(candidates, { maxPerSource = 3, maxPerTarget = 10, batchSize = 30, maxBatches = 5, minScore = 0 } = {}) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = candidates.filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score || cmp(a.source, b.source) || cmp(a.target, b.target));
  const seenPairs = new Set();
  const batches = [];
  const anchorUse = new Map();
  const picked = [];
  for (const c of sorted) {
    const pair = `${c.source}\t${c.target}`;
    if (seenPairs.has(pair)) continue;
    let b = 0;
    for (; b < maxBatches; b++) {
      if (!batches[b]) batches[b] = { size: 0, sources: new Map(), targets: new Map() };
      const B = batches[b];
      if (B.size < batchSize && (B.sources.get(c.source) || 0) < maxPerSource && (B.targets.get(c.target) || 0) < maxPerTarget) break;
    }
    if (b >= maxBatches) continue;
    const B = batches[b];
    B.size++;
    B.sources.set(c.source, (B.sources.get(c.source) || 0) + 1);
    B.targets.set(c.target, (B.targets.get(c.target) || 0) + 1);
    seenPairs.add(pair);
    const firstPara = c.mentions.reduce((m, x) => Math.min(m, x.paragraph), Infinity);
    const options = c.mentions.filter((m) => m.paragraph === firstPara);
    const use = anchorUse.get(c.target) || new Map();
    const choice = options.slice().sort((x, y) => (use.get(x.phrase.key) || 0) - (use.get(y.phrase.key) || 0) || x.start - y.start)[0];
    use.set(choice.phrase.key, (use.get(choice.phrase.key) || 0) + 1);
    anchorUse.set(c.target, use);
    picked.push({ ...c, mention: choice, batch: `B${b + 1}` });
  }
  return picked.sort((a, b) => Number(a.batch.slice(1)) - Number(b.batch.slice(1)) || b.score - a.score);
}
