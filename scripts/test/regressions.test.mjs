// Regression tests for issues found in code review.
import fs from 'node:fs';
import path from 'node:path';
import { test, assert, tmpDir, makeWorkspace, runScript, runScriptSync, startServer, editConfig, dataFile, FIXTURES } from './harness.mjs';
import { loadWorkspace } from '../lib/config.mjs';
import { parseHtml } from '../lib/html.mjs';
import { findOverlaps, buildCheckpoints } from '../lib/experiments.mjs';
import { evaluateGuardrail } from '../guardrail.mjs';
import { clusterQueries, mergeKeywordMap } from '../query-clusters.mjs';
import { csvToRecords, toCsv } from '../lib/csv.mjs';
import { placeboVerdict } from '../gsc-compare.mjs';

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Tiny zip writer (stored entries) for building Search Console-like exports. */
function writeZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}

test('regression: secrets resolve inside the workspace before its parent; repo paths prefer the project', () => {
  const root = tmpDir();
  const parent = path.join(root, '.seo-agent');
  const child = path.join(parent, 'example.com');
  fs.mkdirSync(path.join(parent, 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(child, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'secrets', 'indexnow.key'), 'parent-key');
  fs.writeFileSync(path.join(child, 'secrets', 'indexnow.key'), 'child-key');
  fs.writeFileSync(path.join(child, 'config.json'), '{"site":{"url":"https://example.com/"}}');
  const ws = loadWorkspace({ workspace: child });
  assert.equal(fs.readFileSync(ws.resolveFile('secrets/indexnow.key'), 'utf8'), 'child-key');
  assert.equal(fs.readFileSync(ws.resolveFile('.seo-agent/secrets/indexnow.key'), 'utf8'), 'child-key');
  fs.mkdirSync(path.join(parent, 'site'), { recursive: true });
  assert.equal(ws.resolveFile('site', { prefer: 'project' }), path.join(parent, 'site'));
});

test('regression: malformed percent-encoding never crashes the HTML parser; og:updated_time is a modified date', () => {
  const p = parseHtml('<html><head><meta property="og:updated_time" content="2026-10-01T00:00:00Z"></head><body><h2 id="x">X</h2><a href="#100%-natural">jump</a><a href="#x">x</a></body></html>', 'https://e.com/');
  assert.equal(p.dates.modified, '2026-10-01T00:00:00Z');
  assert.equal(p.tocLinks, 1);
});

test('regression: overlaps include site-wide waves and compare on the Pacific-Time calendar', () => {
  const tz = 'Asia/Taipei';
  const wave = { id: 'W1', date: '2026-10-01', timezone: tz, status: 'live', urls: ['https://e.com/a'], checkpoints: buildCheckpoints('2026-10-01', { siteTz: tz, offsets: [28] }) };
  const postEnd = wave.checkpoints[0].post.end;
  // a Taipei-morning deploy one local day after the PT post end still touches the last PT day of the window
  const nextLocal = new Date(`${postEnd}T00:00:00Z`);
  nextLocal.setUTCDate(nextLocal.getUTCDate() + 1);
  const cand = { id: 'W2', date: nextLocal.toISOString().slice(0, 10), timezone: tz, urls: ['https://e.com/a'] };
  assert.equal(findOverlaps([wave], cand).length, 1, 'PT comparison catches the boundary day');
  assert.equal(findOverlaps([wave], { id: 'W3', date: '2026-10-10', timezone: tz, urls: [], siteWide: true }).length, 1, 'site-wide change overlaps');
  assert.equal(findOverlaps([{ ...wave, siteWide: true, urls: [] }], { id: 'W4', date: '2026-10-10', timezone: tz, urls: ['https://e.com/zzz'] }).length, 1);
  const r = runScriptSync('log-change.mjs', ['add', '--workspace', makeWorkspace(), '--title', 'Template', '--site-wide', '--date', '2026-10-01']);
  assert.equal(r.status, 0, r.stderr);
});

test('regression: guardrail click baseline divides by the configured baseline span', () => {
  const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'];
  const base = days.slice(0, 5).map((d) => ({ date: d, clicks: 14, impressions: 100, position: 3 }));
  const finalDays = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  const fin = finalDays.slice(0, 5).map((d) => ({ date: d, clicks: 14, impressions: 100, position: 3 }));
  const ev = evaluateGuardrail({ query: 'q', baseline: { start: days[0], end: days[6] } }, { merged: fin, exact: fin, baseline: base, clicks: fin, clickBaseline: base }, { latestFinal: '2026-10-07', today: '2026-10-09' });
  assert.ok(Math.abs(ev.clickBaseline - 10) < 1e-9);
  assert.equal(ev.states.clickAlarm, false, 'identical weeks must not raise the click alarm');
});

test('regression: keyword-map metrics refresh for queries filtered out of clustering', () => {
  const rows = [{ query: 'big query', page: 'https://e.com/a', clicks: 10, impressions: 500, position: 4 }, { query: 'tiny query', page: 'https://e.com/b', clicks: 1, impressions: 3, position: 9 }];
  const res = clusterQueries(rows, { minImpressions: 10 });
  const merged = mergeKeywordMap({ headers: ['keyword', 'impressions'], records: [{ keyword: 'tiny query', impressions: '99' }] }, res, { minImpressions: 1000 });
  assert.equal(merged.records[0].impressions, '3');
});

test('regression: coverage-diff merges the issue tables of a Search Console zip, not the chart', async () => {
  const ws = makeWorkspace();
  const dir = tmpDir();
  const chart = (n) => `Date,Not indexed,Indexed\n${Array.from({ length: n }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')},10,20`).join('\n')}\n`;
  writeZip(path.join(dir, 'old.zip'), [['Chart.csv', chart(20)], ['Critical issues.csv', 'Reason,Source,Validation,Pages\nPage with redirect,Website,N/A,40\nNot found (404),Website,N/A,5\n'], ['Non-critical issues.csv', 'Reason,Source,Validation,Pages\nCrawled - currently not indexed,Google systems,N/A,7\n'], ['Metadata.csv', 'Property,Value\nSearch type,Web\n']]);
  writeZip(path.join(dir, 'new.zip'), [['Chart.csv', chart(25)], ['Critical issues.csv', 'Reason,Source,Validation,Pages\nPage with redirect,Website,N/A,90\nNot found (404),Website,N/A,5\n'], ['Non-critical issues.csv', 'Reason,Source,Validation,Pages\nCrawled - currently not indexed,Google systems,N/A,3\n']]);
  const r = await runScript('indexing.mjs', ['coverage-diff', path.join(dir, 'old.zip'), path.join(dir, 'new.zip'), '--workspace', ws]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Page with redirect\s+40\s+90\s+\+50/);
  assert.ok(!/2026-08-01/.test(r.stdout), 'chart rows are not compared');
});

test('regression: gsc-compare offline CSV files without meta use their dates or require --pre/--post', async () => {
  const ws = makeWorkspace();
  const dir = tmpDir();
  const mk = (start, n) => ['date,query,page,clicks,impressions,ctr,position', ...Array.from({ length: n }, (_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return `${d.toISOString().slice(0, 10)},q,https://www.example.com/a,5,100,0.05,4`;
  })].join('\n');
  fs.writeFileSync(path.join(dir, 'pre.csv'), mk('2026-09-01', 28));
  fs.writeFileSync(path.join(dir, 'post.csv'), mk('2026-10-01', 14));
  const r = await runScript('gsc-compare.mjs', ['--workspace', ws, '--pre-input', path.join(dir, 'pre.csv'), '--post-input', path.join(dir, 'post.csv'), '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.result.windows.pre.days, 28);
  assert.equal(j.result.windows.post.days, 14);
  assert.ok(j.meta.warnings.some((w) => /differ in length/.test(w)));
  assert.ok(Math.abs(j.result.site.perDay.pre.clicks - j.result.site.perDay.post.clicks) < 1e-9, 'same daily rate');
  fs.writeFileSync(path.join(dir, 'nodate.csv'), 'query,clicks,impressions,ctr,position\nq,5,100,0.05,4\n');
  const bad = await runScript('gsc-compare.mjs', ['--workspace', ws, '--pre-input', path.join(dir, 'nodate.csv'), '--post-input', path.join(dir, 'nodate.csv')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Cannot tell which dates/);
});

test('regression: content-audit never overwrites a manual wave value', async () => {
  const ws = makeWorkspace();
  const wavesFile = path.join(ws, 'logs', 'experiments.json');
  fs.writeFileSync(wavesFile, JSON.stringify([{ id: 'W-new', date: '2026-10-20', timezone: 'Asia/Taipei', status: 'live', type: 'seo-change', urls: ['https://www.example.com/blog/pour-over-guide/'], checkpoints: [] }]));
  const inv = path.join(ws, 'content-inventory.csv');
  fs.writeFileSync(inv, 'url,wave,notes\nhttps://www.example.com/blog/pour-over-guide/,manual: shipped with W-old,\n');
  const r = await runScript('content-audit.mjs', ['--workspace', ws, '--glob', path.join(FIXTURES, 'content', 'pour-over-guide.md'), '--url-template', 'https://www.example.com/blog/{slug}/']);
  assert.equal(r.status, 0, r.stderr);
  const row = csvToRecords(fs.readFileSync(inv, 'utf8')).records.find((x) => x.url.endsWith('/pour-over-guide/'));
  assert.equal(row.wave, 'manual: shipped with W-old');
});

test('regression: check-resources survives relative <loc> values in a sitemap', async () => {
  const srv = await startServer({ routes: { '/robots.txt': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\nSitemap: {{ORIGIN}}/sitemap.xml\n' }, '/sitemap.xml': { status: 200, headers: { 'content-type': 'application/xml' }, body: '<urlset><url><loc>/relative/page</loc></url><url><loc>{{ORIGIN}}/ok</loc></url></urlset>' }, '/': { status: 200, body: '<html><head><title>Home page title</title></head><body><h1>Hi</h1></body></html>' } } });
  try {
    const ws = makeWorkspace();
    editConfig(ws, (c) => {
      c.site.url = `${srv.origin}/`;
    });
    const r = await runScript('check-resources.mjs', ['--workspace', ws, '--json', '--skip', 'gsc,ga4,bing,credentials,llms_txt']);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout).items.find((i) => i.id === 'sitemaps');
    assert.equal(s.status, 'error');
    assert.match(s.detail, /invalid\/relative/);
  } finally {
    await srv.close();
  }
});

test('regression: gsc-opportunities skips decliners when the input does not cover the previous window', async () => {
  const ws = makeWorkspace();
  const file = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'gsc-daily.json'), 'utf8'));
  file.rows = file.rows.filter((r) => r.date >= '2026-10-01');
  file.meta.startDate = '2026-10-01';
  const f = path.join(tmpDir(), 'short.json');
  fs.writeFileSync(f, JSON.stringify(file));
  const r = await runScript('gsc-opportunities.mjs', ['--workspace', ws, '--input', f, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.meta.previous, null);
  assert.equal(j.decliningPages.length, 0);
  assert.ok(dataFile(ws, 'gsc', /opportunities\.json$/));
});

test('regression: site-level placebo (no treatment/control) works for equal and unequal windows', () => {
  const site = (pct, perDay) => ({ sameLength: !perDay, site: { delta: { clicksPct: pct }, perDayDelta: perDay ? { clicksPct: perDay } : undefined, z: 3 }, treated: null });
  assert.equal(placeboVerdict(site(-0.2), site(-0.18)).flag, true);
  assert.equal(placeboVerdict(site(-0.2), site(0.01)).flag, false);
  assert.equal(placeboVerdict(site(-0.2, -0.3), site(0.05, 0.02)).flag, false);
});

test('regression: split-test control pages count as touched; review-due points split tests to split-test evaluate', () => {
  const tz = 'Asia/Taipei';
  const st = { id: 'ST-1', type: 'split-test', date: '2026-10-01', timezone: tz, status: 'live', urls: ['https://e.com/v1'], splitTest: { control: ['https://e.com/c1'] }, checkpoints: buildCheckpoints('2026-10-01', { siteTz: tz, offsets: [14, 28] }) };
  assert.equal(findOverlaps([st], { id: 'W2', date: '2026-10-10', timezone: tz, urls: ['https://e.com/c1'] }).length, 1, 'changing a control page contaminates the test');
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, 'logs', 'experiments.json'), JSON.stringify([st]));
  const r = runScriptSync('review-due.mjs', ['--workspace', ws]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /split-test\.mjs evaluate --id ST-1 --checkpoint D\+14/);
  assert.ok(!/gsc-compare\.mjs --wave ST-1/.test(r.stdout));
});

test('regression: CSV cells that look like spreadsheet formulas are neutralized and read back unchanged', () => {
  const rows = [{ anchor: '=HYPERLINK("http://evil.example","x")', delta: '-2.36', pct: '+15%', at: '@SUM(A1)', n: -3 }];
  const text = toCsv(rows);
  assert.match(text, /"'=HYPERLINK/);
  assert.match(text, /,-2\.36,\+15%,'@SUM\(A1\),-3/);
  assert.deepEqual(csvToRecords(text).records[0], { anchor: rows[0].anchor, delta: '-2.36', pct: '+15%', at: '@SUM(A1)', n: '-3' });
});

test('regression: parseHtml keeps body text and H1 when <body> (or <html>/<head>) is omitted', () => {
  const p = parseHtml('<!doctype html><title>Grinder guide</title><meta name="description" content="d"><h1>Burr grinders</h1><p>Conical burrs keep the grind even.</p>', 'https://e.com/');
  assert.deepEqual(p.h1, ['Burr grinders']);
  assert.match(p.fullText, /Conical burrs keep the grind even/);
  assert.equal(p.metaDescription, 'd', 'head elements before the first body element still count');
});
