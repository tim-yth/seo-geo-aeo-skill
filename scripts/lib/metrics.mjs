// Search metrics: weighted aggregation, expected-CTR curves, click-change decomposition, like-for-like sets.
import fs from 'node:fs';
import { UserError } from './util.mjs';

export function newAgg() {
  return { clicks: 0, impressions: 0, posWeighted: 0, posImpr: 0, rows: 0 };
}

export function addRow(agg, r) {
  agg.clicks += r.clicks || 0;
  agg.impressions += r.impressions || 0;
  agg.rows += 1;
  if (r.position > 0 && r.impressions > 0) {
    agg.posWeighted += r.position * r.impressions;
    agg.posImpr += r.impressions;
  }
  return agg;
}

export function finalize(agg) {
  return {
    clicks: agg.clicks,
    impressions: agg.impressions,
    ctr: agg.impressions ? agg.clicks / agg.impressions : 0,
    position: agg.posImpr ? agg.posWeighted / agg.posImpr : 0,
    rows: agg.rows,
  };
}

export function aggregate(rows) {
  const a = newAgg();
  for (const r of rows) addRow(a, r);
  return finalize(a);
}

/** Map key -> finalized metrics. keyFn may return a string, null (skip) or an array of keys. */
export function groupMetrics(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    for (const k of [].concat(keyFn(r))) {
      if (k === null || k === undefined || k === '') continue;
      if (!map.has(k)) map.set(k, newAgg());
      addRow(map.get(k), r);
    }
  }
  return new Map([...map].map(([k, a]) => [k, finalize(a)]));
}

export function deltas(pre, post) {
  const pct = (a, b) => (a ? (b - a) / a : b ? null : 0);
  return {
    clicks: post.clicks - pre.clicks,
    clicksPct: pct(pre.clicks, post.clicks),
    impressions: post.impressions - pre.impressions,
    impressionsPct: pct(pre.impressions, post.impressions),
    ctr: post.ctr - pre.ctr,
    position: pre.position && post.position ? post.position - pre.position : null,
  };
}

// ---------- expected CTR ----------
// Conservative blend of public organic CTR studies (desktop+mobile, 2023-2025), lowered for AI
// Overviews/SERP features. Replace with a site-fitted curve (--ctr-curve site) whenever possible.
export const DEFAULT_CTR_CURVE = {
  source: 'default (blend of public CTR studies; approximate)',
  points: [
    [1, 0.25], [2, 0.14], [3, 0.095], [4, 0.068], [5, 0.051], [6, 0.039], [7, 0.031], [8, 0.025], [9, 0.021], [10, 0.018],
    [11, 0.012], [12, 0.0105], [13, 0.0095], [14, 0.0085], [15, 0.0075], [16, 0.007], [17, 0.0065], [18, 0.006], [19, 0.0055], [20, 0.005],
  ],
  tail: 0.003,
};

export function expectedCtr(position, curve = DEFAULT_CTR_CURVE) {
  const pts = curve.points;
  if (!(position > 0)) return curve.tail;
  if (position <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (position <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (position - x0)) / (x1 - x0);
    }
  }
  return curve.tail;
}

/** Pool-adjacent-violators: enforce a non-increasing sequence (weighted). */
function pava(values, weights) {
  const blocks = values.map((v, i) => ({ v, w: weights[i], n: 1 }));
  for (let i = 0; i < blocks.length - 1; ) {
    if (blocks[i].v < blocks[i + 1].v) {
      const a = blocks[i];
      const b = blocks[i + 1];
      const w = a.w + b.w;
      blocks.splice(i, 2, { v: w ? (a.v * a.w + b.v * b.w) / w : (a.v + b.v) / 2, w, n: a.n + b.n });
      if (i > 0) i--;
    } else i++;
  }
  return blocks.flatMap((b) => new Array(b.n).fill(b.v));
}

/**
 * Fit an expected-CTR curve from the site's own rows (impression-weighted CTR per rounded position,
 * monotone). Sparse positions borrow the default curve scaled to the site's level.
 */
export function fitCtrCurve(rows, { minBucketImpressions = 200, isBrand } = {}) {
  const buckets = Array.from({ length: 20 }, (_, i) => ({ pos: i + 1, clicks: 0, impressions: 0 }));
  for (const r of rows) {
    if (isBrand && r.query && isBrand(r.query)) continue;
    const p = Math.round(r.position);
    if (p < 1 || p > 20) continue;
    buckets[p - 1].clicks += r.clicks;
    buckets[p - 1].impressions += r.impressions;
  }
  const dense = buckets.filter((b) => b.impressions >= minBucketImpressions);
  if (dense.length < 3) return { ...DEFAULT_CTR_CURVE, source: `${DEFAULT_CTR_CURVE.source}; too little data to fit a site curve`, buckets };
  const ratios = dense.map((b) => b.clicks / b.impressions / expectedCtr(b.pos)).sort((a, b) => a - b);
  const scale = ratios[Math.floor(ratios.length / 2)] || 1;
  const values = buckets.map((b) => (b.impressions >= minBucketImpressions ? b.clicks / b.impressions : expectedCtr(b.pos) * scale));
  const weights = buckets.map((b) => (b.impressions >= minBucketImpressions ? b.impressions : minBucketImpressions / 4));
  const mono = pava(values, weights);
  return {
    source: `site-fitted from ${dense.length} positions with >= ${minBucketImpressions} impressions (scale vs default ${scale.toFixed(2)})`,
    points: buckets.map((b, i) => [b.pos, Math.max(mono[i], 0.0005)]),
    tail: Math.max(mono[19] * 0.6, 0.0005),
    buckets,
  };
}

/** --ctr-curve: "default" | "site" | path to JSON ({points:[[pos,ctr],...]} or {"1":0.3,...}). */
export function loadCtrCurve(spec, rows, opts = {}) {
  if (!spec || spec === 'default') return DEFAULT_CTR_CURVE;
  if (spec === 'site') return fitCtrCurve(rows, opts);
  if (!fs.existsSync(spec)) throw new UserError(`CTR curve file not found: ${spec}`, { hint: 'Use --ctr-curve default, --ctr-curve site, or a JSON file like {"points":[[1,0.3],[2,0.15]]}' });
  const data = JSON.parse(fs.readFileSync(spec, 'utf8'));
  const points = Array.isArray(data.points)
    ? data.points.map(([p, c]) => [Number(p), Number(c)])
    : Object.entries(data).filter(([k]) => /^\d+$/.test(k)).map(([p, c]) => [Number(p), Number(c)]);
  points.sort((a, b) => a[0] - b[0]);
  if (points.length < 2 || points.some(([p, c]) => !(p > 0) || !(c >= 0 && c <= 1))) throw new UserError(`Invalid CTR curve in ${spec}`);
  return { source: `custom (${spec})`, points, tail: Number(data.tail) || points[points.length - 1][1] * 0.6 };
}

// ---------- decomposition ----------
/**
 * Attribute the click change between two windows to: impressions (demand/visibility),
 * position (ranking, via the CTR curve ratio) and CTR-at-same-position (snippet/SERP features).
 * Computed per row key and summed; rows present in only one window count as impression effect.
 * The three parts always add up to the total click change.
 */
export function decomposeClicks(preRows, postRows, keyFn, curve = DEFAULT_CTR_CURVE) {
  const pre = groupMetrics(preRows, keyFn);
  const post = groupMetrics(postRows, keyFn);
  const outRes = { impressionEffect: 0, positionEffect: 0, ctrEffect: 0, total: 0 };
  for (const key of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(key);
    const b = post.get(key);
    if (a && b && a.impressions > 0 && b.impressions > 0) {
      const ctr0 = a.clicks / a.impressions;
      const e0 = expectedCtr(a.position, curve);
      const e1 = expectedCtr(b.position, curve);
      const ratio = e0 > 0 ? e1 / e0 : 1;
      outRes.impressionEffect += (b.impressions - a.impressions) * ctr0;
      outRes.positionEffect += b.impressions * ctr0 * (ratio - 1);
      outRes.ctrEffect += b.clicks - b.impressions * ctr0 * ratio;
    } else if (a) {
      outRes.impressionEffect -= a.clicks;
    } else if (b) {
      outRes.impressionEffect += b.clicks;
    }
  }
  outRes.total = outRes.impressionEffect + outRes.positionEffect + outRes.ctrEffect;
  return outRes;
}

// ---------- like-for-like ----------
const BUCKETS = [
  ['1-3', 0, 3.5],
  ['4-6', 3.5, 6.5],
  ['7-10', 6.5, 10.5],
  ['11-20', 10.5, 20.5],
  ['21+', 20.5, Infinity],
];

/**
 * Fixed set of (query, page) pairs with >= minImpressions in the pre window: impression-weighted
 * position change for pairs still present, plus pairs that disappeared. Removes demand/mix effects.
 */
export function fixedSetComparison(preRows, postRows, { minImpressions = 10, preDays = 1, postDays = 1, keyFn = (r) => `${r.query}\t${r.page}` } = {}) {
  const pre = groupMetrics(preRows, keyFn);
  const post = groupMetrics(postRows, keyFn);
  let weight = 0;
  let weightedDelta = 0;
  let paired = 0;
  let lost = 0;
  let lostImprPerDay = 0;
  let preImprPerDay = 0;
  let postImprPerDay = 0;
  const buckets = new Map(BUCKETS.map(([name]) => [name, { name, pairs: 0, weight: 0, weightedDelta: 0, preImprPerDay: 0, postImprPerDay: 0 }]));
  for (const [key, a] of pre) {
    if (a.impressions < minImpressions || !(a.position > 0)) continue;
    const b = post.get(key);
    if (!b || !(b.position > 0)) {
      lost++;
      lostImprPerDay += a.impressions / preDays;
      continue;
    }
    paired++;
    weight += a.impressions;
    weightedDelta += a.impressions * (b.position - a.position);
    preImprPerDay += a.impressions / preDays;
    postImprPerDay += b.impressions / postDays;
    const bucket = BUCKETS.find(([, lo, hi]) => a.position > lo && a.position <= hi) || BUCKETS[BUCKETS.length - 1];
    const x = buckets.get(bucket[0]);
    x.pairs++;
    x.weight += a.impressions;
    x.weightedDelta += a.impressions * (b.position - a.position);
    x.preImprPerDay += a.impressions / preDays;
    x.postImprPerDay += b.impressions / postDays;
  }
  return {
    minImpressions,
    paired,
    lost,
    lostImprPerDay,
    positionDelta: weight ? weightedDelta / weight : null,
    preImprPerDay,
    postImprPerDay,
    buckets: [...buckets.values()]
      .filter((x) => x.pairs)
      .map((x) => ({ name: x.name, pairs: x.pairs, positionDelta: x.weight ? x.weightedDelta / x.weight : null, preImprPerDay: x.preImprPerDay, postImprPerDay: x.postImprPerDay })),
  };
}
