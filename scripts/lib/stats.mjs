// Statistics for before/after analysis: same-query CTR, difference-in-differences with a permutation
// p-value over daily values, days-in-top-10, and a seeded PRNG.
import { listDays } from './dates.mjs';
import { groupMetrics } from './metrics.mjs';
import { compactKey } from './text.mjs';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * CTR on the same queries in both windows (each with >= minImpr impressions in BOTH windows),
 * weighted by pre-window impressions. Removes query-mix effects from the raw CTR change.
 */
export function sameQueryCtr(preRows, postRows, { minImpr = 50, filter } = {}) {
  const keep = (r) => (filter ? filter(r) : true);
  const a = groupMetrics(preRows.filter(keep), (r) => r.query);
  const b = groupMetrics(postRows.filter(keep), (r) => r.query);
  let w = 0;
  let preSum = 0;
  let postSum = 0;
  let n = 0;
  for (const [q, x] of a) {
    const y = b.get(q);
    if (!y || x.impressions < minImpr || y.impressions < minImpr) continue;
    n++;
    w += x.impressions;
    preSum += x.impressions * x.ctr;
    postSum += x.impressions * y.ctr;
  }
  if (!w) return { queries: 0, minImpr, pre: null, post: null, delta: null };
  return { queries: n, minImpr, pre: preSum / w, post: postSum / w, delta: (postSum - preSum) / w };
}

function dailySeries(rows, days, test, metric) {
  const map = new Map(days.map((d) => [d, 0]));
  for (const r of rows) {
    if (!map.has(r.date) || !test(r)) continue;
    map.set(r.date, map.get(r.date) + (r[metric] || 0));
  }
  return days.map((d) => map.get(d));
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function combinations(n, k) {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

function* kSubsets(n, k) {
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx;
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * Difference-in-differences on daily values. Statistic: mean over post days of log((T+1)/(C+1)) minus
 * the same over pre days; net effect = exp(stat) - 1 (treatment change relative to control).
 * p-value: permutation of the pre/post labels (whole weeks when both windows are >= 14 days and whole
 * weeks, to respect weekly seasonality; exact enumeration when feasible).
 */
export function diffInDiff(preRows, postRows, preRange, postRange, isTreatment, isControl, { metric = 'clicks', iterations = 10000, seed = 7 } = {}) {
  const preDays = listDays(preRange.start, preRange.end);
  const postDays = listDays(postRange.start, postRange.end);
  const tPre = dailySeries(preRows, preDays, isTreatment, metric);
  const cPre = dailySeries(preRows, preDays, isControl, metric);
  const tPost = dailySeries(postRows, postDays, isTreatment, metric);
  const cPost = dailySeries(postRows, postDays, isControl, metric);
  const sum = (xs) => xs.reduce((s, x) => s + x, 0);
  const totals = { treatmentPre: sum(tPre), treatmentPost: sum(tPost), controlPre: sum(cPre), controlPost: sum(cPost) };
  const perDay = (xs, n) => (n ? sum(xs) / n : 0);
  const chg = (a, b) => (a ? b / a - 1 : null);
  const treatmentChange = chg(perDay(tPre, preDays.length), perDay(tPost, postDays.length));
  const controlChange = chg(perDay(cPre, preDays.length), perDay(cPost, postDays.length));
  const d = (t, c) => t.map((x, i) => Math.log((x + 1) / (c[i] + 1)));
  const dPre = d(tPre, cPre);
  const dPost = d(tPost, cPost);
  const stat = mean(dPost) - mean(dPre);
  const weekly = preDays.length >= 14 && postDays.length >= 14 && preDays.length % 7 === 0 && postDays.length % 7 === 0;
  const units = [];
  const unitSize = weekly ? 7 : 1;
  for (let i = 0; i < dPre.length; i += unitSize) units.push({ vals: dPre.slice(i, i + unitSize) });
  const nPreUnits = units.length;
  for (let i = 0; i < dPost.length; i += unitSize) units.push({ vals: dPost.slice(i, i + unitSize) });
  const n = units.length;
  const k = n - nPreUnits;
  const statFor = (postIdx) => {
    const inPost = new Set(postIdx);
    const a = [];
    const b = [];
    units.forEach((u, i) => (inPost.has(i) ? b : a).push(...u.vals));
    return mean(b) - mean(a);
  };
  let extreme = 0;
  let total = 0;
  const obs = Math.abs(stat) - 1e-12;
  const exact = combinations(n, k) <= 20000;
  if (exact) {
    for (const subset of kSubsets(n, k)) {
      total++;
      if (Math.abs(statFor(subset)) >= obs) extreme++;
    }
  } else {
    const rand = mulberry32(seed);
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let it = 0; it < iterations; it++) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      total++;
      if (Math.abs(statFor(idx.slice(0, k))) >= obs) extreme++;
    }
  }
  return {
    metric,
    totals,
    treatmentChange,
    controlChange,
    netEffect: Math.exp(stat) - 1,
    logStat: stat,
    pValue: exact ? extreme / total : (extreme + 1) / (total + 1),
    method: `${exact ? 'exact' : `${iterations}-draw`} permutation of ${weekly ? 'weeks' : 'days'} (${n} units)`,
    days: { pre: preDays.length, post: postDays.length },
  };
}

/** Per query: days with position <= maxPos and impressions >= minImpr (needs date+query rows). */
export function daysInTop10(rows, queries, range, { maxPos = 10.5, minImpr = 5 } = {}) {
  const days = listDays(range.start, range.end);
  return queries.map((q) => {
    const key = compactKey(q);
    const byDay = groupMetrics(rows.filter((r) => compactKey(r.query) === key), (r) => r.date);
    let top10 = 0;
    let impressions = 0;
    let posW = 0;
    let boundary = 0;
    for (const d of days) {
      const m = byDay.get(d);
      if (!m) continue;
      impressions += m.impressions;
      posW += m.position * m.impressions;
      if (m.position > 0 && m.position <= maxPos && m.impressions >= minImpr) top10++;
      if (m.position >= 8.5 && m.position <= 10.5) boundary += m.impressions;
    }
    return {
      query: q,
      days: days.length,
      top10Days: top10,
      impressionsPerDay: impressions / days.length,
      position: impressions ? posW / impressions : null,
      // share of impressions on days whose average position sat on the page-1 edge (8.5-10.5)
      boundaryShare: impressions ? boundary / impressions : null,
    };
  });
}

// ---------- rate tests ----------
const LOG_FACT_CACHE = [0];
function logFact(n) {
  for (let i = LOG_FACT_CACHE.length; i <= n; i++) LOG_FACT_CACHE[i] = LOG_FACT_CACHE[i - 1] + Math.log(i);
  return LOG_FACT_CACHE[n];
}
const logChoose = (n, k) => logFact(n) - logFact(k) - logFact(n - k);

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
export function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Inverse standard normal (Acklam's approximation). */
export function normalQuantile(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Two-sided Fisher exact test for successes a/n1 vs b/n2. */
export function fisherExact(a, n1, b, n2) {
  const k = a + b;
  const N = n1 + n2;
  const lo = Math.max(0, k - n2);
  const hi = Math.min(k, n1);
  const logP = (x) => logChoose(n1, x) + logChoose(n2, k - x) - logChoose(N, k);
  const observed = logP(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logP(x);
    if (lp <= observed + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/** Two-proportion z test (pooled), two-sided. */
export function twoProportionZ(a, n1, b, n2) {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const p1 = a / n1;
  const p2 = b / n2;
  const pooled = (a + b) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: 1 };
  const z = (p2 - p1) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** Wilson score interval (default 95%). */
export function wilsonInterval(successes, n, confidence = 0.95) {
  if (!n) return { low: 0, high: 0, rate: 0 };
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { rate: p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** Exact two-sided binomial test P(X as or less likely than k | n, p0). */
export function binomialTwoSided(k, n, p0) {
  if (!n) return 1;
  if (p0 <= 0) return k === 0 ? 1 : 0;
  if (p0 >= 1) return k === n ? 1 : 0;
  const logPmf = (x) => logChoose(n, x) + x * Math.log(p0) + (n - x) * Math.log(1 - p0);
  const observed = logPmf(k);
  let p = 0;
  for (let x = 0; x <= n; x++) {
    const lp = logPmf(x);
    if (lp <= observed + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/**
 * Hand DiD without daily data: T0,T1 treatment clicks; C0,C1 control clicks; n0,n1 window days.
 * Net effect = [(T1/n1)/(T0/n0)] / r_c - 1 with r_c = (C1/n1)/(C0/n0); p = binomial(k=T1, n=T0+T1, p0=n1*r_c/(n0+n1*r_c)).
 */
export function didBinomial(T0, T1, C0, C1, n0, n1) {
  if (!T0 || !C0 || !C1) return { netEffect: null, pValue: null };
  const rc = C1 / n1 / (C0 / n0);
  const netEffect = T1 / n1 / (T0 / n0) / rc - 1;
  const p0 = (n1 * rc) / (n0 + n1 * rc);
  return { netEffect, pValue: binomialTwoSided(T1, T0 + T1, p0), rc };
}

/** Sample size per group to detect p1 -> p2 (two-sided alpha, power). */
export function sampleSizePerGroup(p1, p2, { alpha = 0.05, power = 0.8 } = {}) {
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const pbar = (p1 + p2) / 2;
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num * num) / ((p2 - p1) * (p2 - p1)));
}

/**
 * Rolling-window placebo: rates of every equal-length window fully before the change. Returns the range and
 * the empirical share of windows at least as extreme (same direction) as the observed post-change rate.
 */
export function rollingPlacebo(daily, changeDate, windowDays, observedRate, baselineRate) {
  const before = daily.filter((d) => d.date < changeDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  const rates = [];
  for (let i = 0; i + windowDays <= before.length; i++) {
    const slice = before.slice(i, i + windowDays);
    const n = slice.reduce((s, d) => s + d.entrants, 0);
    const k = slice.reduce((s, d) => s + d.successes, 0);
    if (n) rates.push(k / n);
  }
  if (!rates.length) return null;
  const up = observedRate >= baselineRate;
  const extreme = rates.filter((r) => (up ? r >= observedRate : r <= observedRate)).length;
  return { windows: rates.length, min: Math.min(...rates), max: Math.max(...rates), extreme, empiricalP: (extreme + 1) / (rates.length + 1) };
}
