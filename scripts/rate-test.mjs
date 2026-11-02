#!/usr/bin/env node
// Small-sample rate tests for conversion/engagement ratios (GA4 events, sign-ups, CTR of a few pages).
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, UserError } from './lib/util.mjs';
import { readCsvFile, findColumn } from './lib/csv.mjs';
import { addDays, assertYmd, listDays } from './lib/dates.mjs';
import { fisherExact, twoProportionZ, wilsonInterval, didBinomial, sampleSizePerGroup, rollingPlacebo } from './lib/stats.mjs';
import { fmtPct, textTable } from './lib/format.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  before: { type: 'string', placeholder: 'k/n', desc: 'Successes/entrants before, e.g. 12/240' },
  after: { type: 'string', placeholder: 'k/n', desc: 'Successes/entrants after, e.g. 30/250' },
  'days-before': { type: 'int', desc: 'Complete days behind --before (sample gate)' },
  'days-after': { type: 'int', desc: 'Complete days behind --after (sample gate)' },
  daily: { type: 'string', placeholder: 'file.csv', desc: 'Daily CSV with date, entrants, successes columns' },
  'change-date': { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'With --daily: the change day (excluded from both windows)' },
  window: { type: 'int', desc: 'With --daily: days per window', default: 7 },
  'date-col': { type: 'string', desc: 'Column name for the date', default: 'date' },
  'entrants-col': { type: 'string', desc: 'Column name for entrants (denominator)', default: 'entrants' },
  'successes-col': { type: 'string', desc: 'Column name for successes (numerator)', default: 'successes' },
  treatment: { type: 'string', placeholder: 'T0/T1', desc: 'did: treatment clicks before/after' },
  control: { type: 'string', placeholder: 'C0/C1', desc: 'did: control clicks before/after' },
  days: { type: 'string', placeholder: 'n0/n1', desc: 'did: window days before/after', default: '28/28' },
  p1: { type: 'number', desc: 'power: current rate (0-1)' },
  p2: { type: 'number', desc: 'power: rate you want to detect (0-1)' },
  'per-week': { type: 'int', desc: 'power: entrants per week across both groups' },
  alpha: { type: 'number', desc: 'power: two-sided significance level', default: 0.05 },
  power: { type: 'number', desc: 'power: desired power', default: 0.8 },
  'min-days': { type: 'int', desc: 'Sample gate: complete days per side', default: 7 },
  'min-entrants': { type: 'int', desc: 'Sample gate: entrants per side', default: 30 },
  json: { type: 'boolean', desc: 'Print JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/rate-test.mjs --before 12/240 --after 30/250 --days-before 7 --days-after 7',
    'node scripts/rate-test.mjs --daily signups.csv --change-date 2026-10-07 --window 7',
    'node scripts/rate-test.mjs did --treatment 120/150 --control 900/950 --days 28/28',
    'node scripts/rate-test.mjs power --p1 0.47 --p2 0.55 --per-week 240',
  ],
  summary:
    'Compares two rates the honest way: two-sided Fisher exact test, two-proportion z test and Wilson 95% intervals, behind a sample gate ' +
    '(>= 7 complete days and >= 30 entrants per side, otherwise "keep observing"). With --daily it also builds a placebo distribution from ' +
    'every equal-length rolling window before the change. "did" is the hand difference-in-differences for page clicks without daily data ' +
    '(binomial test); "power" estimates how many entrants/weeks an A/B test needs.',
  spec: SPEC,
  examples: [
    'node scripts/rate-test.mjs --before 18/310 --after 31/298 --days-before 14 --days-after 14',
    'node scripts/rate-test.mjs --daily .seo-agent/data/ga4/2026-11-02-landing-signups.csv --change-date 2026-10-20 --window 7 --entrants-col sessions --successes-col keyEvents',
  ],
  notes: [
    'Verdicts: p < 0.05 (Fisher) = improved/worsened; ratio >= 1.5x or <= 0.67x with p < 0.10 = "changed (weak evidence)"; otherwise no detectable change.',
    'Do not chain overlapping interim results into a trend, and never pick a winner with single-digit counts per group.',
  ],
});

function parsePair(v, name) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(v || ''));
  if (!m) throw new UserError(`--${name} must look like k/n (e.g. 12/240), got "${v}"`);
  const a = Number(m[1]);
  const b = Number(m[2]);
  return [a, b];
}

/** Core comparison; exported for tests. */
export function compareRates({ k1, n1, k2, n2, days1 = null, days2 = null, minDays = 7, minEntrants = 30 }) {
  if (k1 > n1 || k2 > n2) throw new UserError('Successes cannot exceed entrants');
  const fisher = fisherExact(k1, n1, k2, n2);
  const z = twoProportionZ(k1, n1, k2, n2);
  const ci1 = wilsonInterval(k1, n1);
  const ci2 = wilsonInterval(k2, n2);
  const r1 = n1 ? k1 / n1 : 0;
  const r2 = n2 ? k2 / n2 : 0;
  const ratio = r1 ? r2 / r1 : null;
  const gate = [];
  if (days1 !== null && days1 < minDays) gate.push(`before has ${days1} complete days (< ${minDays})`);
  if (days2 !== null && days2 < minDays) gate.push(`after has ${days2} complete days (< ${minDays})`);
  if (n1 < minEntrants) gate.push(`before has ${n1} entrants (< ${minEntrants})`);
  if (n2 < minEntrants) gate.push(`after has ${n2} entrants (< ${minEntrants})`);
  let verdict;
  if (gate.length) verdict = 'insufficient sample: keep observing';
  else if (fisher < 0.05) verdict = r2 > r1 ? 'improved' : 'worsened';
  else if (ratio !== null && (ratio >= 1.5 || ratio <= 0.67) && fisher < 0.1) verdict = 'changed (weak evidence)';
  else verdict = 'no detectable change';
  return { before: { successes: k1, entrants: n1, rate: r1, ci95: [ci1.low, ci1.high] }, after: { successes: k2, entrants: n2, rate: r2, ci95: [ci2.low, ci2.high] }, ratio, diff: r2 - r1, fisherP: fisher, zTest: z, gate, verdict };
}

function loadDaily(file, flags) {
  const { headers, records } = readCsvFile(path.resolve(file));
  const dc = findColumn(headers, [flags.dateCol, 'date', 'day']);
  const ec = findColumn(headers, [flags.entrantsCol, 'entrants', 'sessions', 'users', 'visitors']);
  const sc = findColumn(headers, [flags.successesCol, 'successes', 'conversions', 'keyEvents', 'events']);
  if (!dc || !ec || !sc) throw new UserError(`${file} needs date, entrants and successes columns (found: ${headers.join(', ')})`, { hint: 'Name them with --date-col, --entrants-col and --successes-col.' });
  const normDate = (v) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v);
  return records.map((r) => ({ date: normDate(String(r[dc]).trim()), entrants: Number(r[ec]) || 0, successes: Number(r[sc]) || 0 })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const mode = positionals[0] || 'compare';
  let result;
  if (mode === 'power') {
    if (!(flags.p1 > 0 && flags.p1 < 1 && flags.p2 > 0 && flags.p2 < 1) || flags.p1 === flags.p2) throw new UserError('power needs --p1 and --p2 between 0 and 1 (and different)');
    const n = sampleSizePerGroup(flags.p1, flags.p2, { alpha: flags.alpha, power: flags.power });
    result = { mode, p1: flags.p1, p2: flags.p2, alpha: flags.alpha, power: flags.power, perGroup: n, total: 2 * n, weeks: flags.perWeek ? Math.ceil((2 * n) / flags.perWeek) : null };
    if (flags.json) return void process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    out(`To detect ${fmtPct(flags.p1)} -> ${fmtPct(flags.p2)} (alpha ${flags.alpha}, power ${flags.power}): ${n} entrants per group (${2 * n} total).`);
    if (result.weeks) out(`At ${flags.perWeek} entrants/week that is about ${result.weeks} week(s). Decide the duration before starting and do not stop early on a lucky day.`);
    return 0;
  }
  if (mode === 'did') {
    const [t0, t1] = parsePair(flags.treatment, 'treatment');
    const [c0, c1] = parsePair(flags.control, 'control');
    const [n0, n1] = parsePair(flags.days, 'days');
    const d = didBinomial(t0, t1, c0, c1, n0, n1);
    result = { mode, treatment: [t0, t1], control: [c0, c1], days: [n0, n1], ...d, sampleTooSmall: t0 + t1 < 10 };
    if (flags.json) return void process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    out(`Control multiplier r_c = ${d.rc === undefined ? '-' : d.rc.toFixed(3)}; net effect ${d.netEffect === null ? '-' : `${(d.netEffect * 100).toFixed(1)}%`}; two-sided binomial p = ${d.pValue === null ? '-' : d.pValue.toFixed(4)}`);
    if (result.sampleTooSmall) out('Sample too small: fewer than 10 treatment clicks across both windows.');
    return 0;
  }
  if (mode !== 'compare') throw new UserError(`Unknown mode "${mode}"`, { hint: 'Use compare (default), did or power.' });

  let k1;
  let n1;
  let k2;
  let n2;
  let days1 = flags.daysBefore ?? null;
  let days2 = flags.daysAfter ?? null;
  let placebo = null;
  let windows = null;
  if (flags.daily) {
    if (!flags.changeDate) throw new UserError('--daily needs --change-date');
    assertYmd(flags.changeDate, '--change-date');
    const daily = loadDaily(flags.daily, flags);
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const beforeDays = listDays(addDays(flags.changeDate, -flags.window), addDays(flags.changeDate, -1));
    const afterDays = listDays(addDays(flags.changeDate, 1), addDays(flags.changeDate, flags.window));
    const sum = (days, f) => days.reduce((s, d) => s + (byDate.get(d) ? byDate.get(d)[f] : 0), 0);
    k1 = sum(beforeDays, 'successes');
    n1 = sum(beforeDays, 'entrants');
    k2 = sum(afterDays, 'successes');
    n2 = sum(afterDays, 'entrants');
    days1 = beforeDays.filter((d) => byDate.has(d)).length;
    days2 = afterDays.filter((d) => byDate.has(d)).length;
    windows = { before: [beforeDays[0], beforeDays[beforeDays.length - 1]], after: [afterDays[0], afterDays[afterDays.length - 1]], excluded: flags.changeDate };
    placebo = rollingPlacebo(daily.filter((d) => d.date < flags.changeDate), flags.changeDate, flags.window, n2 ? k2 / n2 : 0, n1 ? k1 / n1 : 0);
  } else {
    [k1, n1] = parsePair(flags.before, 'before');
    [k2, n2] = parsePair(flags.after, 'after');
  }
  result = { mode, windows, ...compareRates({ k1, n1, k2, n2, days1, days2, minDays: flags.minDays, minEntrants: flags.minEntrants }), placebo };
  if (placebo && placebo.empiricalP >= 0.1 && result.verdict !== 'insufficient sample: keep observing') result.placeboNote = `The after-rate is within normal pre-change variation (${placebo.extreme}/${placebo.windows} earlier windows were at least as extreme).`;
  if (flags.json) return void process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (windows) out(`Before ${windows.before[0]}..${windows.before[1]} vs after ${windows.after[0]}..${windows.after[1]} (change day ${windows.excluded} excluded)`);
  out(textTable(['', 'successes', 'entrants', 'rate', '95% CI (Wilson)'], [
    ['before', k1, n1, fmtPct(result.before.rate, 2), `${fmtPct(result.before.ci95[0], 2)} - ${fmtPct(result.before.ci95[1], 2)}`],
    ['after', k2, n2, fmtPct(result.after.rate, 2), `${fmtPct(result.after.ci95[0], 2)} - ${fmtPct(result.after.ci95[1], 2)}`],
  ]));
  out(`Ratio ${result.ratio === null ? '-' : `${result.ratio.toFixed(2)}x`}; Fisher exact p = ${result.fisherP.toFixed(4)}; z = ${result.zTest.z.toFixed(2)} (p = ${result.zTest.p.toFixed(4)})`);
  if (placebo) out(`Rolling-window placebo: ${placebo.windows} earlier ${flags.window}-day windows ranged ${fmtPct(placebo.min, 1)} - ${fmtPct(placebo.max, 1)}; ${placebo.extreme} at least as extreme (empirical p = ${placebo.empiricalP.toFixed(2)})`);
  if (result.gate.length) out(`Sample gate: ${result.gate.join('; ')}`);
  out(`Verdict: ${result.verdict}${result.placeboNote ? `. ${result.placeboNote}` : ''}`);
  return 0;
}

runMain(import.meta.url, main);
