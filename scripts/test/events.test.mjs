import fs from 'node:fs';
import path from 'node:path';
import { test, assert, tmpDir, makeWorkspace, runScript, runScriptSync, startServer, editConfig, dataFile } from './harness.mjs';
import { loadLedger, loadEvents, overlapEvents, metricReliability, describeOverlap, incidentToEvent, EVENTS_FILE } from '../lib/events.mjs';
import { applyEventChecks, evaluateGuardrail } from '../guardrail.mjs';
import { eventOverlaps } from '../review-due.mjs';
import { isYmd, listDays } from '../lib/dates.mjs';

const OFFICIAL = /^https:\/\/(status\.search\.google\.com|support\.google\.com|developers\.google\.com)\//;

test('events: bundled ledger is well formed and every verified entry links to an official Google page', () => {
  const l = loadLedger();
  assert.ok(isYmd(l.lastVerified));
  const all = [...l.events, ...l.gscAnomalies, ...l.reportingChanges, ...l.unverified];
  const ids = new Set();
  for (const e of all) {
    assert.ok(e.id && !ids.has(e.id), `duplicate or missing id ${e.id}`);
    ids.add(e.id);
    assert.ok(isYmd(e.start), `${e.id} start`);
    if (e.end) assert.ok(isYmd(e.end) && e.end >= e.start, `${e.id} end`);
    if (e.verified !== false) assert.match(e.url, OFFICIAL, `${e.id} needs an official URL`);
  }
  const ranking = l.events.filter((e) => ['core', 'spam'].includes(e.kind));
  assert.ok(ranking.length >= 15, 'core and spam updates 2024-2026');
  assert.ok(ranking.every((e) => e.start >= '2024-01-01'));
  const march24 = l.events.find((e) => e.title === 'March 2024 core update');
  assert.deepEqual([march24.start, march24.end], ['2024-03-05', '2024-04-19']);
  const logging = l.gscAnomalies.find((e) => e.id === 'gsc-2025-05-13-impressions-logging');
  assert.deepEqual([logging.start, logging.end, logging.affects.join(',')], ['2025-05-13', '2026-04-27', 'impressions,ctr,position']);
  assert.ok(!logging.affects.includes('clicks'), 'clicks were not affected');
  assert.ok(l.unverified.every((e) => e.verified === false));
  assert.ok(fs.existsSync(EVENTS_FILE));
});

test('events: overlap rules (updates between windows count, anomalies only when touching a window, settling buffer)', () => {
  const ev = loadEvents(null, { today: '2026-11-01' });
  const between = overlapEvents(ev, [{ name: 'pre', start: '2026-05-01', end: '2026-05-14' }, { name: 'post', start: '2026-06-10', end: '2026-06-20' }]);
  const may = between.find((h) => h.event.title === 'May 2026 core update');
  assert.ok(may && may.between, 'an update between the windows still confounds the post window');
  const buffer = overlapEvents(ev, [{ name: 'pre', start: '2026-06-03', end: '2026-06-08' }, { name: 'post', start: '2026-06-09', end: '2026-06-12' }]);
  assert.ok(buffer.some((h) => h.event.title === 'May 2026 core update' && h.windows[0].name === 'pre'), '7 settling days after the official end');
  // anomaly entirely inside the excluded gap does not touch the data
  const gap = overlapEvents(ev, [{ name: 'pre', start: '2026-02-20', end: '2026-02-27' }, { name: 'post', start: '2026-03-02', end: '2026-03-09' }], { scopes: ['bulk-export'] });
  assert.equal(gap.length, 0);
  const rel = metricReliability(ev, [{ name: 'pre', start: '2026-04-01', end: '2026-04-14' }, { name: 'post', start: '2026-05-01', end: '2026-05-14' }]);
  assert.deepEqual(rel.unreliable.sort(), ['ctr', 'impressions', 'position']);
  assert.deepEqual(metricReliability(ev, [{ name: 'pre', start: '2026-05-01', end: '2026-05-14' }, { name: 'post', start: '2026-07-01', end: '2026-07-14' }]).unreliable, []);
  assert.match(describeOverlap(may), /May 2026 core update .* falls between the windows/);
  const ongoing = incidentToEvent({ id: 'abc', begin: '2026-11-01T16:00:00+00:00', end: null, external_desc: 'November 2026 core update', service_name: 'Ranking', uri: 'incidents/abc' });
  assert.deepEqual([ongoing.kind, ongoing.start, ongoing.end, ongoing.url], ['core', '2026-11-01', null, 'https://status.search.google.com/incidents/abc']);
});

test('events: workspace refresh (mock dashboard) and logged external events are merged', async () => {
  const srv = await startServer({ routes: { '/incidents.json': { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'NEW1', begin: '2026-10-28T16:00:00+00:00', end: null, external_desc: 'October 2026 core update', service_name: 'Ranking', uri: 'incidents/NEW1' }]) } } });
  try {
    const ws = makeWorkspace();
    const env = { SEO_AGENT_STATUS_ENDPOINT: `${srv.origin}/incidents.json` };
    const r = await runScript('search-events.mjs', ['refresh', '--workspace', ws], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 new/);
    assert.equal(runScriptSync('log-change.mjs', ['add', '--workspace', ws, '--type', 'external-event', '--title', 'Viral mention', '--date', '2026-10-10', '--until', '2026-10-12']).status, 0);
    const list = JSON.parse(runScriptSync('search-events.mjs', ['list', '--workspace', ws, '--json', '--since', '2026-10-01']).stdout);
    assert.ok(list.some((e) => e.title === 'October 2026 core update' && e.ongoing));
    const site = list.find((e) => e.kind === 'site');
    assert.equal(site.title, 'Viral mention');
    assert.equal(site.severity, 'warn');
    const check = runScriptSync('search-events.mjs', ['check', '--workspace', ws, '--pre', '2026-10-01:2026-10-07', '--post', '2026-10-15:2026-10-21', '--fail-on-overlap']);
    assert.equal(check.status, 2, 'the logged site event between the windows trips the gate');
    assert.match(check.stdout, /Site event .*Viral mention/);
    const clean = runScriptSync('search-events.mjs', ['check', '--pre', '2026-07-01:2026-07-07', '--post', '2026-07-08:2026-07-14', '--fail-on-overlap']);
    assert.equal(clean.status, 0, clean.stdout);
    // deploying during the (mock) ongoing update warns
    const add = runScriptSync('log-change.mjs', ['add', '--workspace', ws, '--title', 'New titles', '--urls', '/a/', '--date', '2026-10-30']);
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /WARNING: Google October 2026 core update is rolling out/);
  } finally {
    await srv.close();
  }
});

test('events: gsc-compare marks impressions/CTR/position unreliable across the Search Console logging error', async () => {
  const ws = makeWorkspace();
  const dir = tmpDir();
  const rows = ['date,query,page,clicks,impressions,ctr,position'];
  for (const d of listDays('2026-04-01', '2026-05-31')) rows.push(`${d},coffee ratio,https://www.example.com/a,10,${d <= '2026-04-27' ? 400 : 200},0.03,${d <= '2026-04-27' ? 9 : 6}`);
  fs.writeFileSync(path.join(dir, 'daily.csv'), `${rows.join('\n')}\n`);
  const r = await runScript('gsc-compare.mjs', ['--workspace', ws, '--input', path.join(dir, 'daily.csv'), '--pre', '2026-04-10:2026-04-23', '--post', '2026-05-08:2026-05-21', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.meta.unreliableMetrics.sort(), ['ctr', 'impressions', 'position']);
  assert.ok(j.meta.events.some((e) => e.id === 'gsc-2025-05-13-impressions-logging' && e.severity === 'warn'));
  assert.ok(j.meta.events.some((e) => e.title === 'May 2026 core update'), 'the update between the windows is reported');
  const md = fs.readFileSync(j.files.markdown, 'utf8');
  assert.match(md, /## External events and data anomalies/);
  assert.match(md, /Impressions \[UNRELIABLE: Search Console data anomaly\]/);
  assert.match(md, /Not comparable across these windows: impressions, ctr, position/);
});

test('events: guardrail disables position thresholds when the baseline sits in the logging error; review-due warns per checkpoint', () => {
  const days = (s, n) => listDays(s, new Date(Date.parse(`${s}T00:00:00Z`) + (n - 1) * 86400000).toISOString().slice(0, 10));
  const base = days('2026-04-01', 7).map((d) => ({ date: d, clicks: 10, impressions: 200, position: 3 }));
  const fin = days('2026-10-20', 7).map((d) => ({ date: d, clicks: 10, impressions: 100, position: 5 }));
  const ev = loadEvents(null, { today: '2026-11-01' });
  const g = { query: 'q', baseline: { start: '2026-04-01', end: '2026-04-07' } };
  const res = evaluateGuardrail(g, { merged: fin, exact: fin, baseline: base, clicks: fin, clickBaseline: base }, { latestFinal: '2026-10-26', today: '2026-10-29' });
  assert.equal(res.states.pause, true);
  applyEventChecks(g, res, ev);
  assert.equal(res.states.pause, false);
  assert.equal(res.states.suppressed.pause, true);
  assert.ok(res.states.positionUnreliable);
  assert.ok(res.states.warningReasons.some((x) => /position thresholds disabled/.test(x)));
  // an explicit stop line only needs a clean final window
  const g2 = { query: 'q', maxPosition: 4, baseline: { start: '2026-04-01', end: '2026-04-07' } };
  const res2 = evaluateGuardrail(g2, { merged: fin, exact: fin, baseline: base, clicks: fin, clickBaseline: base }, { latestFinal: '2026-10-26', today: '2026-10-29' });
  applyEventChecks(g2, res2, ev);
  assert.equal(res2.states.pause, true, 'final window is outside the anomaly');
  const hits = eventOverlaps([{ wave: 'W1', checkpoint: 'D+14', pre: { start: '2026-09-10', end: '2026-09-23' }, post: { start: '2026-09-25', end: '2026-10-08' } }], ev);
  assert.ok(hits.some((h) => h.event.title === 'September 2026 spam update' && h.items[0].wave === 'W1'));
});
