import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, makeWorkspace, runScriptSync, dataFile } from './harness.mjs';
import { csvToRecords } from '../lib/csv.mjs';
import { serpUrlKey, effectiveK, bandFor, overlapMatrix, clusterKeywords, analyzeOverlap } from '../serp-overlap.mjs';
import { compactKey } from '../lib/text.mjs';

const FX = path.join(FIXTURES, 'serp-overlap');
const snapshotFiles = fs.readdirSync(FX).filter((f) => f.endsWith('.json'));

function workspace() {
  const ws = makeWorkspace();
  fs.mkdirSync(path.join(ws, 'data', 'serp'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'data', 'gsc'), { recursive: true });
  for (const f of snapshotFiles) fs.copyFileSync(path.join(FX, f), path.join(ws, 'data', 'serp', f));
  fs.copyFileSync(path.join(FX, 'query-cluster-members.csv'), path.join(ws, 'data', 'gsc', '2026-11-01-query-cluster-members.csv'));
  fs.copyFileSync(path.join(FX, 'keyword-map.csv'), path.join(ws, 'keyword-map.csv'));
  return ws;
}

const clustersOf = (rows) => {
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.cluster_id)) byId.set(r.cluster_id, []);
    byId.get(r.cluster_id).push(r.keyword);
  }
  return [...byId.values()].map((m) => m.sort().join(' + ')).sort();
};

test('serp-overlap: --help works without a workspace', () => {
  const r = runScriptSync('serp-overlap.mjs', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /7-10 shared = same/);
  assert.match(r.stdout, /--mode/);
});

test('serp-overlap: URL normalization, scaled k, bands, soft vs hard clustering', () => {
  assert.equal(serpUrlKey('https://www.rival.com/pour-over-ratio/'), serpUrlKey('https://rival.com/pour-over-ratio?utm_source=newsletter#x'));
  assert.notEqual(serpUrlKey('https://rival.com/kettles'), serpUrlKey('https://rival.com/calculator'), 'same domain, different page');
  assert.equal(serpUrlKey('https://example.org/a?page=2'), 'example.org/a?page=2', 'meaningful query kept');
  assert.equal(effectiveK(3, 10, 10, 10), 3);
  assert.equal(effectiveK(3, 6, 10, 10), 2);
  assert.equal(effectiveK(3, 6, 10, 10, false), 3);
  assert.equal(effectiveK(3, 2, 10, 10), 2, 'never below 2');
  assert.equal(effectiveK(1, 5, 10, 10), 1, 'never above k');
  assert.equal(bandFor(5, 6, 10, { scale: false }).name, 'same cluster', '--no-scale keeps the 10-result bands');
  assert.equal(bandFor(7, 10, 10).name, 'same page');
  assert.equal(bandFor(5, 10, 10).name, 'same cluster');
  assert.equal(bandFor(3, 10, 10).name, 'interlink');
  assert.equal(bandFor(1, 10, 10).name, 'separate');
  assert.equal(bandFor(5, 6, 10).name, 'same page', 'bands scale with the shorter list');
  // a-b share 3, a-c share 3, b-c share 0: soft = {a,b,c}; hard = {a,b} + {c}
  const s = [
    { keyword: 'a', urls: ['1', '2', '3', '4', '5', '6'] },
    { keyword: 'b', urls: ['1', '2', '3', '9'] },
    { keyword: 'c', urls: ['4', '5', '6', '8'] },
  ];
  const m = overlapMatrix(s, { k: 3, top: 4 });
  assert.equal(m.shared[0][1], 3);
  assert.equal(m.shared[0][2], 3);
  assert.equal(m.shared[1][2], 0);
  assert.equal(m.jaccard[0][1], 3 / 7);
  assert.equal(clusterKeywords(m, [0, 1, 2], 'soft').length, 1);
  assert.deepEqual(clusterKeywords(m, [0, 1, 2], 'hard').map((c) => c.members), [[0, 1], [2]]);
});

function fixtureSnapshots() {
  const newest = new Map();
  for (const f of snapshotFiles.sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
    newest.set(compactKey(d.meta.keyword), { keyword: d.meta.keyword, key: compactKey(d.meta.keyword), date: f.slice(0, 10), results: d.results, file: f });
  }
  return [...newest.values()];
}

test('serp-overlap: fixture clusters at k=3 and disagreement flags', () => {
  const members = new Map();
  for (const r of csvToRecords(fs.readFileSync(path.join(FX, 'query-cluster-members.csv'), 'utf8')).records) members.set(compactKey(r.query), { clusterId: r.cluster_id, cluster: r.cluster, impressions: Number(r.impressions) });
  const keywordMap = new Map();
  for (const r of csvToRecords(fs.readFileSync(path.join(FX, 'keyword-map.csv'), 'utf8')).records) keywordMap.set(compactKey(r.keyword), { target: new URL(r.target_url, 'https://www.example.com').href, cluster: r.cluster, impressions: Number(r.impressions) });
  const soft = analyzeOverlap(fixtureSnapshots(), { k: 3, mode: 'soft', members, keywordMap });
  const idx = (kw) => soft.items.findIndex((i) => i.keyword === kw);
  assert.equal(soft.matrix.shared[idx('pour over ratio')][idx('pour over coffee ratio')], 7, 'normalized full URLs');
  assert.equal(soft.matrix.shared[idx('pour over ratio')][idx('coffee to water ratio')], 3);
  assert.equal(soft.matrix.shared[idx('pour over ratio')][idx('pour over kettle')], 1, 'same domain on another page does not count');
  assert.deepEqual(clustersOf(soft.rows), ['best pour over kettle + gooseneck kettle + pour over kettle', 'coffee to water ratio + pour over coffee ratio + pour over ratio']);
  const row = (kw) => soft.rows.find((r) => r.keyword === kw);
  assert.equal(row('pour over coffee ratio').leader, 'pour over ratio', 'leader = most impressions');
  assert.equal(row('pour over coffee ratio').band, 'same page');
  assert.equal(row('gooseneck kettle').shared_with_leader, 2, 'joined with k scaled to its 6 results');
  assert.match(row('coffee to water ratio').flag, /text-cluster-differs/);
  assert.match(row('pour over kettle').flag, /serp-split/);
  assert.match(row('pour over kettle').flag, /target-mixed-intents/);
  assert.match(row('pour over coffee ratio').flag, /target-conflict/);
  assert.match(row('pour over coffee ratio').notes, /consolidation candidate/);
  assert.equal(row('gooseneck kettle').confidence, 'normal');
  const hard = analyzeOverlap(fixtureSnapshots(), { k: 3, mode: 'hard', members, keywordMap });
  assert.deepEqual(clustersOf(hard.rows), ['best pour over kettle + pour over kettle', 'coffee to water ratio', 'gooseneck kettle', 'pour over coffee ratio + pour over ratio']);
  const unscaled = analyzeOverlap(fixtureSnapshots(), { k: 3, mode: 'soft', scale: false, members, keywordMap });
  assert.ok(clustersOf(unscaled.rows).includes('gooseneck kettle'));
});

test('serp-overlap CLI: newest snapshot per keyword, outputs, warnings, errors', () => {
  const ws = workspace();
  const r = runScriptSync('serp-overlap.mjs', ['--workspace', ws]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /6 keyword\(s\) -> 2 SERP cluster\(s\)/);
  assert.match(r.stdout, /fewer than 10 results/);
  const csv = csvToRecords(fs.readFileSync(dataFile(ws, 'serp', /-serp-clusters\.csv$/), 'utf8'));
  assert.deepEqual(csv.headers.slice(0, 9), ['keyword', 'cluster_id', 'leader', 'size', 'shared_with_leader', 'jaccard_with_leader', 'text_cluster', 'target_url', 'flag']);
  assert.equal(csv.records.find((x) => x.keyword === 'pour over coffee ratio').jaccard_with_leader, '0.538');
  const json = JSON.parse(fs.readFileSync(dataFile(ws, 'serp', /-serp-overlap\.json$/), 'utf8'));
  assert.equal(json.keywords.length, 6);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) assert.equal(json.shared[i][j], json.shared[j][i]);
  assert.ok(!json.meta.files.some((f) => f.startsWith('2026-10-01')), 'older snapshot ignored');
  const md = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.endsWith('-serp-overlap.md'))), 'utf8');
  for (const s of ['Brave is not Google', 'calibrate', 'churn weekly', '5-9 URLs', '## Disagreements to review']) assert.ok(md.includes(s), s);
  const hard = runScriptSync('serp-overlap.mjs', ['--workspace', ws, '--mode', 'hard', '--json']);
  assert.equal(hard.status, 0, hard.stderr);
  assert.equal(new Set(JSON.parse(hard.stdout).clusters.map((c) => c.cluster_id)).size, 4);
  const old = runScriptSync('serp-overlap.mjs', ['--workspace', ws, '--date', '2026-10-01']);
  assert.equal(old.status, 1);
  assert.match(old.stderr, /at least 2 keywords/);
  assert.match(old.stderr, /serp-snapshot\.mjs/);
  const withNull = JSON.parse(fs.readFileSync(path.join(FX, snapshotFiles.find((f) => f.includes('gooseneck'))), 'utf8'));
  withNull.results.splice(1, 0, null);
  fs.writeFileSync(path.join(ws, 'data', 'serp', '2026-11-01-gooseneck-kettle-1b5613.json'), JSON.stringify(withNull));
  assert.equal(runScriptSync('serp-overlap.mjs', ['--workspace', ws]).status, 0, 'null result entries are skipped');
  const bad = runScriptSync('serp-overlap.mjs', ['--workspace', ws, '--mode', 'loose']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /soft, hard/);
});
