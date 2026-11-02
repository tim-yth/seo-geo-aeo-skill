import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, makeWorkspace, runScript, editConfig, dataFile } from './harness.mjs';
import { loadGscFile } from '../lib/gsc.mjs';
import { deployWindows } from '../lib/dates.mjs';
import { DEFAULT_CTR_CURVE } from '../lib/metrics.mjs';
import { deriveWindow, computeComparison, pageMatcher, placeboVerdict } from '../gsc-compare.mjs';
import { findOpportunities } from '../gsc-opportunities.mjs';
import { clusterQueries, mergeKeywordMap, inferIntent } from '../query-clusters.mjs';
import { evaluateGuardrail } from '../guardrail.mjs';

const DAILY = path.join(FIXTURES, 'gsc-daily.json');
const file = loadGscFile(DAILY);
const windows = deployWindows('2026-09-29', 28, { siteTz: 'Asia/Taipei' });
const groupOf = (u) => (/\/guides\//.test(u) ? 'guides' : /\/blog\//.test(u) ? 'blog' : /\/tools\//.test(u) ? 'tools' : u.endsWith('.com/') ? 'home' : 'other');

function compare(extra = {}, range = windows) {
  const opts = { targetQueries: ['pour over', 'french press ratio'] };
  const pre = deriveWindow(file.rows, file.dimensions, range.pre, { ...opts, ...extra });
  const post = deriveWindow(file.rows, file.dimensions, range.post, { ...opts, ...extra });
  return computeComparison(pre, post, { pageGroupOf: groupOf, isBrand: (q) => /example/.test(q), hasBrand: true, guardrails: ['pour over'], targetQueries: ['french press ratio'], treatment: pageMatcher('^/guides/'), control: pageMatcher('^/blog/'), curve: DEFAULT_CTR_CURVE, controlMinImpr: 50 });
}

test('gsc-compare: windows exclude both PT deploy days', () => {
  assert.deepEqual(windows.excluded, ['2026-09-28', '2026-09-29']);
  assert.equal(windows.pre.end, '2026-09-27');
  assert.equal(windows.post.start, '2026-09-30');
});

test('gsc-compare: treatment beats control with a significant permutation p-value', () => {
  const r = compare();
  assert.ok(r.treated, 'treatment block');
  assert.ok(r.treated.did.clicks.netEffect > 0.5, `net effect ${r.treated.did.clicks.netEffect}`);
  assert.ok(r.treated.did.clicks.pValue < 0.05, `p ${r.treated.did.clicks.pValue}`);
  assert.match(r.treated.did.clicks.method, /exact permutation of weeks/);
  assert.equal(r.treated.sampleTooSmall, false);
  const dec = r.site.decomposition;
  assert.ok(Math.abs(dec.impressionEffect + dec.positionEffect + dec.ctrEffect - dec.total) < 1e-6);
  assert.ok(r.site.sameQueryCtr.queries > 5);
  assert.ok(r.queryGroups.some((g) => g.name === 'brand') && r.queryGroups.some((g) => g.name === 'guardrail: pour over'));
  assert.ok(r.pageGroups.find((g) => g.name === 'guides').delta.clicks > 0);
});

test('gsc-compare: days in top 10, boundary share, fixed set', () => {
  const r = compare();
  const fp = r.topTen.find((t) => t.query === 'french press ratio');
  assert.ok(fp.pre.top10Days <= 3, `pre ${fp.pre.top10Days}`);
  assert.ok(fp.post.top10Days >= 25, `post ${fp.post.top10Days}`);
  assert.ok(fp.post.boundaryShare !== null);
  assert.ok(r.fixedSet.paired > 10 && r.fixedSet.positionDelta < 0);
});

test('gsc-compare: placebo before the deploy is clean, a placebo inside the trend is flagged', () => {
  const real = compare();
  const shifted = (n) => ({ pre: { ...windows.pre, start: addDaysLocal(windows.pre.start, -n), end: addDaysLocal(windows.pre.end, -n) }, post: { ...windows.post, start: addDaysLocal(windows.post.start, -n), end: addDaysLocal(windows.post.end, -n) } });
  const clean = placeboVerdict(real, compare({}, shifted(30)));
  assert.equal(clean.flag, false, clean.note);
  const fake = { ...real, treated: { ...real.treated, did: { clicks: { netEffect: real.treated.did.clicks.netEffect * 0.8, pValue: 0.02 } } } };
  assert.equal(placeboVerdict(real, fake).flag, true);
});

test('gsc-compare: --exclude-query removes anomalous queries offline', () => {
  const base = compare();
  const r = compare({ excludeRe: /^coffee$/ });
  assert.ok(r.site.pre.impressions < base.site.pre.impressions);
  const all = (x) => x.queryGroups.find((g) => g.name === 'all named queries');
  assert.ok(all(r).pre.impressions < all(base).pre.impressions);
  assert.ok(!r.movers.queries.losers.concat(r.movers.queries.gainers).some((m) => m.key === 'coffee'));
});

test('gsc-compare CLI: offline input, report sections, refusal when a window contains the deploy day', async () => {
  const ws = makeWorkspace(['--page-group', 'guides=^/guides/', '--page-group', 'blog=^/blog/', '--brand-term', 'example coffee', '--guardrail', 'pour over|5']);
  const r = await runScript('gsc-compare.mjs', ['--workspace', ws, '--input', DAILY, '--deploy-date', '2026-09-29', '--window', '28', '--treatment', '^/guides/', '--control', '^/blog/', '--placebo', '--target-query', 'french press ratio']);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(fs.readdirSync(path.join(ws, 'logs', 'reviews')).map((f) => path.join(ws, 'logs', 'reviews', f)).find((f) => f.includes('compare')), 'utf8');
  for (const s of ['## Treatment vs control', 'Same-query CTR', '## Placebo test (deploy moved 30 days earlier)', '## Days in top 10', 'Boundary impr. share', '## Like-for-like ranking']) assert.ok(md.includes(s), `missing ${s}`);
  assert.ok(dataFile(ws, 'gsc', /compare-.*\.json$/));
  const bad = await runScript('gsc-compare.mjs', ['--workspace', ws, '--input', DAILY, '--pre', '2026-09-01:2026-09-28', '--post', '2026-09-29:2026-10-26', '--deploy-date', '2026-09-29']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /contains the deploy day/);
});

test('gsc-opportunities: every category from the fixture', () => {
  const end = '2026-10-26';
  const cur = file.rows.filter((r) => r.date >= '2026-09-29' && r.date <= end);
  const prev = file.rows.filter((r) => r.date >= '2026-09-01' && r.date <= '2026-09-28');
  const long = file.rows.filter((r) => r.date >= '2026-07-29' && r.date <= end);
  const short = file.rows.filter((r) => r.date >= '2026-10-13' && r.date <= end);
  const res = findOpportunities({ current: { qp: cur, pages: [] }, previous: { qp: prev, pages: [] }, longQp: long, shortQp: short, dailyQp: long }, { isBrand: (q) => /example/.test(q), inTest: (u) => u.includes('/guides/pour-over/') });
  assert.ok(res.striking.some((r) => r.query === 'best coffee grinder'));
  assert.ok(res.zeroClick.some((r) => r.query === 'best coffee 2019'));
  assert.ok(res.ctrGaps.some((r) => r.query === 'best coffee 2019'));
  assert.ok(res.rankUpCtrDown.some((r) => r.key === 'coffee'));
  assert.ok(res.decliningPages.some((r) => r.key.endsWith('/tools/ratio-calculator/')));
  const cb = res.cannibalization.find((r) => r.query === 'cold brew ratio');
  assert.ok(cb && cb.verdict.startsWith('harmful'), cb && cb.verdict);
  const po = res.cannibalization.find((r) => r.query === 'pour over ratio');
  assert.ok(po && /stable/.test(po.verdict) && po.inTest);
  assert.ok(!res.striking.some((r) => /example/.test(r.query)), 'brand excluded');
});

test('query-clusters: CJK + latin clustering, ownership, keyword-map merge keeps manual columns', () => {
  const res = clusterQueries(file.rows, { brandTerms: ['example coffee'], isHub: (u) => /\.com\/$/.test(u) });
  const zh = res.clusters.find((c) => c.topQueries.includes('手沖咖啡 比例'));
  assert.ok(zh.topQueries.includes('咖啡 比例'), 'CJK variants share a cluster');
  assert.ok(res.clusters.find((c) => c.label === '(brand)'));
  assert.equal(res.clusters.find((c) => c.label === 'coffee').owner, 'hub');
  assert.equal(res.clusters.find((c) => c.label === 'cold brew ratio').owner, 'split');
  assert.equal(inferIntent('burr vs blade grinder'), 'comparison');
  const existing = { headers: ['keyword', 'intent', 'cluster', 'target_url', 'current_url_ranking', 'position', 'impressions', 'clicks', 'status', 'notes', 'owner'], records: [{ keyword: 'pour over ratio', intent: 'commercial', cluster: 'my cluster', target_url: 'https://www.example.com/tools/ratio-calculator/', current_url_ranking: '', position: '', impressions: '', clicks: '', status: 'tracked', notes: 'keep me', owner: 'ana' }] };
  const merged = mergeKeywordMap(existing, res, { minImpressions: 100 });
  const row = merged.records.find((r) => r.keyword === 'pour over ratio');
  assert.equal(row.notes, 'keep me');
  assert.equal(row.intent, 'commercial');
  assert.equal(row.target_url, 'https://www.example.com/tools/ratio-calculator/');
  assert.equal(row.owner, 'ana');
  assert.ok(Number(row.impressions) > 0);
  assert.ok(merged.added > 3);
  assert.ok(merged.headers.includes('owner'));
});

test('guardrail: 7 calendar days of final data, unrounded baseline, warnings, back-calculation', () => {
  const day = (d, pos, impr = 100, clicks = 5) => ({ date: d, impressions: impr, clicks, position: pos });
  const base = Array.from({ length: 7 }, (_, i) => day(`2026-09-0${i + 1}`, 3.2849));
  const merged = [];
  for (let i = 0; i < 20; i++) {
    const d = addDaysLocal('2026-10-01', i);
    merged.push(day(d, i < 12 ? 3.3 : 5.2, d === '2026-10-16' ? 0 : 100, 3));
  }
  const g = { query: 'core', margin: 1, warnDays: 3, minShare: 0.9 };
  const ev = evaluateGuardrail(g, { merged: merged.filter((r) => r.impressions), exact: merged.filter((r) => r.impressions), baseline: base, clicks: merged, clickBaseline: base }, { latestFinal: '2026-10-14', today: '2026-10-21' });
  assert.ok(Math.abs(ev.baseline.position - 3.2849) < 1e-9);
  assert.ok(Math.abs(ev.stopLine - 4.2849) < 1e-9);
  assert.equal(ev.final7.start, '2026-10-08');
  assert.ok(ev.final7.position < ev.stopLine);
  assert.equal(ev.states.pause, false);
  assert.equal(ev.states.warning, true);
  assert.ok(ev.streak >= 3);
  assert.equal(ev.states.clickAlarm, true);
  const later = evaluateGuardrail(g, { merged: merged.filter((r) => r.impressions), exact: merged, baseline: base }, { latestFinal: '2026-10-20', today: '2026-10-21' });
  assert.equal(later.final7.days, 7, 'a zero-impression day still counts as one of the 7 calendar days');
  assert.ok(Math.abs(later.final7.position - 5.2) < 1e-9);
  assert.equal(later.states.pause, true);
  assert.ok(later.flip.length === 6 && later.flip.some((f) => !f.feasible));
});

test('guardrail CLI: offline input, report, --fail-on-breach exit code', async () => {
  const ws = makeWorkspace();
  editConfig(ws, (c) => {
    c.guardrails = [{ query: 'coffee ratio calculator', page: 'https://www.example.com/tools/ratio-calculator/', baseline: { start: '2026-09-08', end: '2026-09-14' } }];
  });
  const r = await runScript('guardrail.mjs', ['--workspace', ws, '--input', DAILY, '--latest-final', '2026-10-31']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROLLBACK CONSIDERATION|PAUSE/);
  assert.match(r.stdout, /numbers condition only/);
  const md = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.includes('guardrail'))), 'utf8');
  assert.match(md, /Final 7 days/);
  const strict = await runScript('guardrail.mjs', ['--workspace', ws, '--input', DAILY, '--latest-final', '2026-10-31', '--fail-on-breach']);
  assert.equal(strict.status, 2);
  const none = await runScript('guardrail.mjs', ['--workspace', makeWorkspace()]);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No guardrails configured/);
});

function addDaysLocal(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
