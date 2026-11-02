import fs from 'node:fs';
import path from 'node:path';
import { test, assert, tmpDir, makeWorkspace, runScriptSync, editConfig } from './harness.mjs';
import { mulberry32 } from '../lib/stats.mjs';
import { addDays, listDays, weekday, deployWindows } from '../lib/dates.mjs';
import { loadEvents, overlapEvents } from '../lib/events.mjs';
import { assignGroups, strataOf, balanceOf, pageRandomization, evaluateSplit, pageMetrics } from '../split-test.mjs';

const O = 'https://www.example.com';
const TZ = 'Asia/Taipei';

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Synthetic Search Console date x page rows: skewed traffic, weekly pattern, noise; clicks x effect on variant pages from `effectFrom`. */
function synth({ pages = 80, start, end, variant = new Set(), effectFrom = null, effect = 1.4, trendOn = null }) {
  const rows = [];
  for (let i = 1; i <= pages; i++) {
    const page = `${O}/products/item-${i}/`;
    const r0 = mulberry32(i * 7919);
    const base = 8 + Math.floor(r0() * r0() * 300);
    const ctr = 0.02 + r0() * 0.04;
    const pos = 4 + r0() * 12;
    for (const d of listDays(start, end)) {
      const r = mulberry32(hash(`${page}|${d}`));
      const wk = [0.8, 1.05, 1.1, 1.1, 1.05, 1, 0.85][weekday(d)];
      const impressions = Math.round(base * wk * (0.85 + 0.3 * r()));
      let clicks = impressions * ctr * (0.8 + 0.4 * r());
      if (effectFrom && d >= effectFrom && variant.has(page)) clicks *= effect;
      if (trendOn && trendOn.has(page)) clicks *= 1 + 0.01 * (listDays(start, d).length - 1);
      clicks = Math.round(clicks);
      rows.push({ date: d, page, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: Math.round((pos + r() - 0.5) * 10) / 10 });
    }
  }
  return rows;
}

const writeExport = (file, rows) => {
  fs.writeFileSync(file, JSON.stringify({ meta: { dimensions: ['date', 'page'], startDate: rows[0].date, endDate: rows[rows.length - 1].date, dataState: 'final' }, rows }));
  return file;
};

test('split-test: --help works without a workspace', () => {
  const r = runScriptSync('split-test.mjs', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  for (const s of ['assign', 'start', 'evaluate', 'list', 'pages, not visitors']) assert.ok(r.stdout.includes(s), s);
  const bad = runScriptSync('split-test.mjs', ['split', '--workspace', makeWorkspace()]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /assign, start, evaluate, list/);
});

test('split-test: seeded, stratified assignment is deterministic and balanced', () => {
  const rows = synth({ pages: 81, start: '2026-06-01', end: '2026-06-28' });
  const metrics = pageMetrics(rows);
  const pages = [...metrics.keys(), `${O}/products/no-traffic-1/`, `${O}/products/no-traffic-2/`, `${O}/products/no-traffic-3/`];
  const a = assignGroups(pages, metrics, { seed: 42, maxImbalance: 0.1, tries: 50 });
  const b = assignGroups(pages, metrics, { seed: 42, maxImbalance: 0.1, tries: 50 });
  assert.deepEqual(a.variant, b.variant, 'same seed, same groups');
  const c = assignGroups(pages, metrics, { seed: 7, maxImbalance: 0.1, tries: 50 });
  assert.notDeepEqual(a.variant, c.variant, 'another seed, other groups');
  assert.equal(a.ok, true);
  assert.ok(Math.max(...Object.values(a.balance.imbalance)) <= 0.1);
  assert.equal(a.variant.length + a.control.length, pages.length);
  assert.ok(Math.abs(a.variant.length - a.control.length) <= 1);
  assert.ok(!a.variant.some((u) => a.control.includes(u)));
  const strata = strataOf(pages, metrics);
  assert.equal(strata.get(`${O}/products/no-traffic-1/`), 'none');
  for (const s of a.strata) assert.ok(Math.abs(s.variant - s.control) <= 1, `stratum ${s.name} split 50/50`);
  assert.deepEqual(a.strata.map((s) => s.name), ['q4', 'q3', 'q2', 'q1', 'none']);
  for (const [v, ctl] of a.pairs) if (v && ctl) assert.equal(strata.get(v), strata.get(ctl), 'pairs stay inside a stratum');
  const tight = assignGroups(pages, metrics, { seed: 42, maxImbalance: 0.0001, tries: 5 });
  assert.equal(tight.ok, false);
  assert.equal(tight.tries, 5);
  const bal = balanceOf([`${O}/x/`], [`${O}/y/`], new Map([[`${O}/x/`, { clicks: 10, impressions: 100, position: 5 }], [`${O}/y/`, { clicks: 5, impressions: 100, position: 5 }]]));
  assert.equal(bal.imbalance.clicks, 0.5);
  assert.equal(bal.imbalance.position, 0);
});

test('split-test: evaluation recovers a known variant effect; placebo, events and anomalies', () => {
  const d0 = '2026-08-10';
  const w = deployWindows(d0, 28, { siteTz: TZ });
  const preRows = synth({ start: '2026-05-01', end: addDays(d0, -2) });
  const asg = assignGroups([...pageMetrics(preRows.filter((r) => r.date >= w.pre.start)).keys()], pageMetrics(preRows.filter((r) => r.date >= w.pre.start)), { seed: 3 });
  const variant = new Set(asg.variant);
  const rows = synth({ start: '2026-05-01', end: addDays(d0, 40), variant, effectFrom: w.post.start, effect: 1.4 });
  const wave = { id: 'ST-test', type: 'split-test', date: d0, timezone: TZ, urls: asg.variant, splitTest: { control: asg.control, pairs: asg.pairs, seed: asg.seed } };
  const ev = evaluateSplit({ wave, rows, dims: ['date', 'page'], offset: 28, events: [], draws: 2000 });
  assert.equal(ev.groups.variant, 40);
  assert.ok(Math.abs(ev.randomization.netEffect - 0.4) < 0.08, `net effect ${ev.randomization.netEffect}`);
  assert.ok(ev.randomization.pValue < 0.01, `page p ${ev.randomization.pValue}`);
  assert.ok(ev.result.treated.did.clicks.pValue < 0.05, `DiD p ${ev.result.treated.did.clicks.pValue}`);
  assert.match(ev.result.treated.did.clicks.method, /permutation of weeks/);
  assert.equal(ev.placebo.verdict.flag, false, 'no effect before D0');
  assert.ok(ev.placebo.windows.post.end < w.excluded[0], 'placebo stays before the deploy');
  assert.equal(ev.verdict.call, 'keep');
  // no change at all: no detectable difference
  const flat = evaluateSplit({ wave, rows: synth({ start: '2026-05-01', end: addDays(d0, 40) }), dims: ['date', 'page'], offset: 28, events: [], draws: 2000 });
  assert.ok(flat.randomization.pValue > 0.05, `flat p ${flat.randomization.pValue}`);
  assert.equal(flat.verdict.call, 'iterate');
  // a pre-existing upward trend on the variant pages trips the placebo
  const trend = evaluateSplit({ wave, rows: synth({ start: '2026-05-01', end: addDays(d0, 40), trendOn: variant }), dims: ['date', 'page'], offset: 28, events: [], draws: 2000 });
  assert.equal(trend.placebo.verdict.flag, true);
  assert.notEqual(trend.verdict.call, 'keep');
  // a Google update inside the post window downgrades the verdict; a GSC impressions anomaly marks metrics unreliable
  const events = [
    { id: 'test-core', kind: 'core', title: 'Test core update', start: addDays(w.post.start, 5), end: addDays(w.post.start, 12), pattern: 'period', scope: 'search', severity: 'warn', verified: true, affects: [], bufferDays: 0, ongoing: false, origin: 'ledger', url: '' },
    { id: 'test-anomaly', kind: 'gsc-anomaly', title: 'Impressions logging issue', start: addDays(w.pre.start, 3), end: addDays(w.pre.start, 4), pattern: 'period', scope: 'search', severity: 'warn', verified: true, affects: ['impressions'], bufferDays: 0, ongoing: false, origin: 'ledger', url: '' },
  ];
  const hit = evaluateSplit({ wave, rows, dims: ['date', 'page'], offset: 28, events, draws: 500 });
  assert.ok(hit.warnings.some((x) => /Test core update/.test(x)));
  assert.equal(hit.verdict.call, 'inconclusive');
  assert.deepEqual(hit.unreliable.sort(), ['ctr', 'impressions', 'position']);
  // pages changed by another deployed wave inside the windows leave both groups; planned or never-started tests do not count
  const other = { id: 'W-other', type: 'seo-change', status: 'live', date: addDays(d0, 3), timezone: TZ, deployedAt: { local: `${addDays(d0, 3)} 10:00`, exact: true }, checkpoints: [], urls: [asg.variant[0], asg.control[0]] };
  const dropped = evaluateSplit({ wave, rows, dims: ['date', 'page'], offset: 28, events: [], draws: 200, otherWaves: [other] });
  assert.equal(dropped.groups.variant, 39);
  assert.equal(dropped.groups.control, 39);
  const abandoned = { id: 'ST-dup', type: 'split-test', status: 'abandoned', date: addDays(d0, -5), timezone: TZ, checkpoints: [], urls: asg.variant, splitTest: { control: asg.control } };
  const kept = evaluateSplit({ wave, rows, dims: ['date', 'page'], offset: 28, events: [], draws: 200, otherWaves: [abandoned] });
  assert.deepEqual([kept.groups.variant, kept.groups.control], [40, 40], 'a never-started test changed nothing');
  // ?srsltid= / utm_ variants of a page count as that page (one key for assignment and evaluation)
  const tagged = rows.map((x, i) => (i % 3 === 0 ? { ...x, page: `${x.page}?srsltid=AfmBOo${i % 7}` } : x));
  const evTagged = evaluateSplit({ wave, rows: tagged, dims: ['date', 'page'], offset: 28, events: [], draws: 500 });
  assert.deepEqual([evTagged.groups.variant, evTagged.groups.control], [40, 40]);
  assert.ok(Math.abs(evTagged.randomization.netEffect - ev.randomization.netEffect) < 1e-9, 'same estimate with tracking parameters');
  // D+14 of a D+14/D+28 test gives direction only, even when significant
  const interim = evaluateSplit({ wave: { ...wave, checkpoints: [{ offset: 14 }, { offset: 28 }] }, rows, dims: ['date', 'page'], offset: 14, events: [], draws: 500, placebo: false });
  assert.ok(interim.randomization.pValue < 0.05);
  assert.equal(interim.verdict.call, 'inconclusive');
  assert.match(interim.verdict.text, /Interim D\+14: .*decide at D\+28/);
  const r = pageRandomization([['a', 'b'], ['c', 'd']], new Map([['a', 10], ['b', 10], ['c', 10], ['d', 10]]), new Map([['a', 20], ['b', 10], ['c', 20], ['d', 10]]), { draws: 200 });
  assert.ok(r.netEffect > 0.8);
});

/** A D0 whose D+28 windows touch no event in the bundled ledger (keeps the CLI test independent of ledger updates). */
function quietD0() {
  const events = loadEvents(null);
  for (let d = '2022-03-07'; d < '2026-12-31'; d = addDays(d, 7)) {
    const w = deployWindows(d, 28, { siteTz: TZ });
    const spanStart = addDays(w.pre.start, -40);
    if (!overlapEvents(events, [{ name: 'all', start: spanStart, end: w.post.end }], { scopes: ['search', 'search-desktop', 'discover'] }).length) return d;
  }
  throw new Error('no quiet window in the ledger range');
}

test('split-test CLI: assign -> start -> evaluate, experiments.json record, refusals', () => {
  const ws = makeWorkspace(['--page-group', 'products=^/products/']);
  const dir = tmpDir('split-');
  const d0 = quietD0();
  const w = deployWindows(d0, 28, { siteTz: TZ });
  const preFile = writeExport(path.join(dir, 'pre.json'), synth({ start: addDays(d0, -80), end: addDays(d0, -2) }));
  const assign = runScriptSync('split-test.mjs', ['assign', '--workspace', ws, '--page-group', 'products', '--input', preFile, '--title', 'Price in product titles', '--seed', '42']);
  assert.equal(assign.status, 0, assign.stderr);
  assert.match(assign.stdout, /Created ST-\d{4}-\d{2}-\d{2}-price-in-product-titles: 40 variant \+ 40 control pages/);
  assert.match(assign.stdout, /change ONLY the 40 variant URLs/);
  const waves = JSON.parse(fs.readFileSync(path.join(ws, 'logs', 'experiments.json'), 'utf8'));
  const rec = waves.find((x) => x.type === 'split-test');
  assert.ok(rec, 'split-test record');
  assert.equal(rec.status, 'planned');
  assert.equal(rec.urls.length, 40);
  assert.equal(rec.control, 'split-test control group (40 URLs)');
  assert.ok(rec.splitTest.seed >= 42 && Array.isArray(rec.splitTest.strata) && rec.splitTest.balance && rec.splitTest.input.days === 28);
  assert.deepEqual(rec.checkpoints, []);
  assert.equal(rec.splitTest.pairs.length, 40, 'pairs stored with the record (index pairs)');
  assert.ok(rec.splitTest.pairs.every(([v, c]) => rec.splitTest.variant[v] && rec.splitTest.control[c]));
  const id = rec.id;
  for (const f of [`${id}-variant.txt`, `${id}-control.txt`, `${id}-assignment.json`]) assert.ok(fs.existsSync(path.join(ws, 'data', 'experiments', f)), f);
  const notStarted = runScriptSync('split-test.mjs', ['evaluate', '--workspace', ws, '--id', id, '--input', preFile]);
  assert.equal(notStarted.status, 1);
  assert.match(notStarted.stderr, /has not started/);
  const start = runScriptSync('split-test.mjs', ['start', '--workspace', ws, '--id', id, '--at', `${d0} 10:00`]);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /D\+14: .*D\+28: |D\+14/s);
  const live = JSON.parse(fs.readFileSync(path.join(ws, 'logs', 'experiments.json'), 'utf8')).find((x) => x.id === id);
  assert.equal(live.status, 'live');
  assert.equal(live.date, d0);
  assert.deepEqual(live.checkpoints.map((c) => c.label), ['D+14', 'D+28']);
  assert.match(live.deployedAt.pt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(fs.readFileSync(path.join(ws, 'logs', 'changes.md'), 'utf8').includes(id));
  assert.equal(runScriptSync('split-test.mjs', ['start', '--workspace', ws, '--id', id]).status, 1, 'second start refused');
  const ext = runScriptSync('log-change.mjs', ['add', '--workspace', ws, '--type', 'external-event', '--title', 'Viral forum thread', '--date', addDays(d0, 9)]);
  assert.equal(ext.status, 0, ext.stderr);
  const variant = new Set(fs.readFileSync(path.join(ws, 'data', 'experiments', `${id}-variant.txt`), 'utf8').trim().split('\n'));
  const fullFile = writeExport(path.join(dir, 'full.json'), synth({ start: addDays(d0, -80), end: addDays(d0, 40), variant, effectFrom: w.post.start, effect: 1.4 }));
  const ev = runScriptSync('split-test.mjs', ['evaluate', '--workspace', ws, '--id', id, '--checkpoint', 'D+28', '--input', fullFile, '--draws', '2000']);
  assert.equal(ev.status, 0, ev.stderr);
  assert.match(ev.stdout, /WARNING: Site event .*Viral forum thread/);
  assert.match(ev.stdout, /Verdict \(suggestion\): keep/);
  assert.match(ev.stdout, /log-change\.mjs checkpoint --wave .*\(suggested: keep\)/);
  const evalJson = JSON.parse(fs.readFileSync(path.join(ws, 'data', 'experiments', `${id}-D+28-evaluation.json`), 'utf8'));
  assert.ok(evalJson.randomization.pValue < 0.01);
  assert.ok(Math.abs(evalJson.randomization.netEffect - 0.4) < 0.08);
  assert.ok(evalJson.did.clicks.pValue < 0.05);
  assert.equal(evalJson.placebo.verdict.flag, false);
  const reviews = fs.readdirSync(path.join(ws, 'logs', 'reviews'));
  const md = fs.readFileSync(path.join(ws, 'logs', 'reviews', reviews.find((f) => f.includes(`split-test-${id}`))), 'utf8');
  for (const s of ['## Variant vs control', '## Placebo', 'page re-randomization p', 'Viral forum thread']) assert.ok(md.includes(s), s);
  const list = runScriptSync('split-test.mjs', ['list', '--workspace', ws]);
  assert.equal(list.status, 0);
  assert.match(list.stdout, new RegExp(`${id}\\s+live`));
  // refusals: too few pages, unknown group, no traffic data
  const small = path.join(dir, 'small.txt');
  fs.writeFileSync(small, Array.from({ length: 20 }, (_, i) => `/products/item-${i + 1}/`).join('\n'));
  const refused = runScriptSync('split-test.mjs', ['assign', '--workspace', ws, '--urls-file', small, '--input', preFile, '--title', 'Small']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /need >= 30 each/);
  const forced = runScriptSync('split-test.mjs', ['assign', '--workspace', ws, '--urls-file', small, '--input', preFile, '--title', 'Small', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /WARNING \(--force\)/);
  const unknown = runScriptSync('split-test.mjs', ['assign', '--workspace', ws, '--page-group', 'nope', '--input', preFile]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown page group "nope"/);
  editConfig(ws, (cfg) => {
    cfg.gsc.siteUrl = ''; // never fall through to the real Search Console API in tests
  });
  const noData = runScriptSync('split-test.mjs', ['assign', '--workspace', ws, '--urls-file', small, '--title', 'x']);
  assert.equal(noData.status, 1);
  assert.match(noData.stderr, /pre-period traffic data/);
});
