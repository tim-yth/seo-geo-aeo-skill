import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, tmpDir, makeWorkspace, runScript, runScriptSync } from './harness.mjs';
import { toNumber, parseDateValue, inferDateOrder, classifyTable, normalizeTable, weeklyTrend, portfolioTodo, sniffDelimiter, parseDelimited, decodeText, compareImports } from '../ai-reports-import.mjs';
import { csvToRecords } from '../lib/csv.mjs';

const BING_DIR = path.join(FIXTURES, 'ai-reports', 'bing');

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Tiny zip writer (stored entries) for Search Console-like exports (same as regressions.test.mjs). */
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

const days = (start, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

/** Search Console Generative AI export with zh-TW headers (Search variant unless discover). */
function gscZip(file, start, n, { discover = false, perDay = (i) => 100 + i } = {}) {
  const entries = [
    ['日期.csv', `\uFEFF日期,曝光\n${days(start, n).map((d, i) => `${d},${perDay(i)}`).join('\n')}\n`],
    ['網頁.csv', '熱門網頁,曝光\nhttps://www.example.com/guides/pour-over/,"1,200"\nhttps://www.example.com/blog/cold-brew/,300\nhttps://www.example.com/,~\n'],
    ['國家.csv', '國家/地區,曝光\n台灣,900\n美國,600\n'],
    ['篩選器.csv', `篩選器,值\n搜尋類型,${discover ? 'Discover' : '網頁'}\n`],
  ];
  if (!discover) entries.splice(3, 0, ['裝置.csv', '裝置,曝光\n行動裝置,1000\n電腦,450\n平板電腦,50\n']);
  writeZip(file, entries);
  return file;
}

function aiWorkspace() {
  const ws = makeWorkspace(['--page-group', 'guides=^/guides/', '--page-group', 'blog=^/blog/', '--brand-term', 'example coffee']);
  fs.writeFileSync(path.join(ws, 'keyword-map.csv'), 'keyword,intent,cluster,target_url,current_url_ranking,position,impressions,clicks,status,notes\npour over ratio,informational,pour over,https://www.example.com/guides/pour-over/,,,,,tracked,\ncold brew,informational,cold brew,/blog/cold-brew/,,,,,tracked,\n');
  return ws;
}

const files = (ws, dir) => (fs.existsSync(path.join(ws, 'data', dir)) ? fs.readdirSync(path.join(ws, 'data', dir)).sort() : []);
const readOut = (ws, dir, re) => JSON.parse(fs.readFileSync(path.join(ws, 'data', dir, files(ws, dir).find((f) => re.test(f))), 'utf8'));

test('ai-reports-import: --help works without a workspace', () => {
  const r = runScriptSync('ai-reports-import.mjs', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /data\/gsc\/ai-features\/inbox/);
  assert.match(r.stdout, /not clicks, traffic or revenue/);
});

test('ai-reports-import: value normalization (numbers, percentages, dates, delimiters, encodings)', () => {
  assert.equal(toNumber('1,234', { integer: true }), 1234);
  assert.equal(toNumber('1.234', { integer: true }), 1234);
  assert.equal(toNumber('１２３'), 123);
  assert.equal(toNumber('12.5%'), 0.125);
  assert.equal(toNumber('12,5 %'), 0.125);
  assert.equal(toNumber('12,5'), 12.5);
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber('5.4K'), 5400);
  assert.equal(toNumber('~'), 0);
  assert.equal(toNumber('-'), 0);
  assert.equal(toNumber('abc'), null);
  for (const [v, want] of [['2026-10-01', '2026-10-01'], ['2026/10/01', '2026-10-01'], ['Oct 1, 2026', '2026-10-01'], ['October 1st, 2026', '2026-10-01'], ['1 Oct 2026', '2026-10-01'], ['10/1/2026', '2026-10-01'], ['6/6/2026 12:00:00 AM', '2026-06-06'], ['2026年10月1日', '2026-10-01'], ['2026. 10. 1.', '2026-10-01'], ['2026년 10월 1일', '2026-10-01'], ['1. Okt. 2026', '2026-10-01'], ['1 de octubre de 2026', '2026-10-01'], ['2026-10-01T00:00:00Z', '2026-10-01'], ['２０２６－１０－０１', '2026-10-01'], ['20261001', '2026-10-01']]) {
    assert.equal(parseDateValue(v), want, v);
  }
  assert.equal(parseDateValue('13/10/2026'), '2026-10-13', 'day > 12 implies day-first');
  assert.equal(parseDateValue('2/10/2026', 'dmy'), '2026-10-02');
  assert.equal(parseDateValue('2026-02-30'), null);
  assert.equal(inferDateOrder(['1/10/2026', '25/10/2026']), 'dmy');
  assert.equal(inferDateOrder(['10/1/2026', '10/25/2026']), 'mdy');
  assert.equal(sniffDelimiter('Date;Citations\n2026-10-01;3'), ';');
  assert.equal(sniffDelimiter('"a,b"\tc\n'), '\t');
  assert.deepEqual(parseDelimited('Page;Citations\n"https://e.com/a;b";"1.234"\n', ';'), [['Page', 'Citations'], ['https://e.com/a;b', '1.234']]);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('日期,曝光\n', 'utf16le')]);
  assert.equal(decodeText(utf16), '日期,曝光\n');
});

test('ai-reports-import: table recognition by headers (zh-TW, ja, de, en) and portfolio to-do rules', () => {
  const t = (rows, name = 'x.csv') => ({ name, rows });
  assert.equal(classifyTable(t([['日期', '曝光']])).kind, 'dates');
  assert.equal(classifyTable(t([['上位のページ', '表示回数']])).kind, 'pages');
  assert.equal(classifyTable(t([['Land', 'Impressionen']])).kind, 'countries');
  assert.equal(classifyTable(t([['Device', 'Impressions']])).kind, 'devices');
  assert.equal(classifyTable(t([['Top pages', 'Clicks', 'Impressions', 'CTR', 'Position']])).kind, 'performance');
  const trend = classifyTable(t([['Date', 'Citations', 'Cited Pages']]));
  assert.deepEqual([trend.source, trend.kind], ['bing', 'trend']);
  assert.equal(classifyTable(t([['Grounding Query', 'Intent', 'Topic', 'Citations', 'Citation Share']])).kind, 'grounding');
  assert.equal(classifyTable(t([['Page', 'Citations']])).kind, 'pages');
  assert.equal(classifyTable(t([['Page', 'Citations']])).source, 'bing');
  assert.equal(classifyTable(t([['Intent', 'Citations']])).kind, 'intents');
  assert.equal(classifyTable(t([['Topic', 'Citation Share']])).kind, 'topics');
  assert.equal(classifyTable(t([['Topic', 'Topic Size', 'Sites Cited', 'Queries']])).kind, 'portfolio');
  assert.equal(classifyTable(t([['Query', 'Volume']], 'Opportunity Queries.csv')).kind, 'portfolio');
  assert.equal(classifyTable(t([['Foo', 'Bar']])).kind, 'unknown');
  const devices = { name: 'd.csv', rows: [['裝置', '曝光'], ['行動裝置', '10'], ['電腦', '5'], ['平板電腦', '1']] };
  assert.deepEqual(normalizeTable(devices, classifyTable(devices)).rows.map((r) => r.device), ['mobile', 'desktop', 'tablet']);
  const share = { name: 'q.csv', rows: [['Grounding Query', 'Citations', 'Citation Share'], ['a', '1,050', '3.2%'], ['b', '5', '']] };
  const n = normalizeTable(share, classifyTable(share)).rows;
  assert.deepEqual([n[0].citations, n[0].citationShare, n[1].citationShare], [1050, 0.032, null]);
  const todo = portfolioTodo([{ topic: 'A', sitesCited: 10, yours: '0' }, { topic: 'B', sitesCited: 10, yours: '25' }, { topic: 'C', sitesCited: 0, yours: '0' }, { query: 'q', opportunity: true }]);
  assert.deepEqual(todo.map((r) => r.topic || r.query), ['A', 'q']);
  const tr = weeklyTrend(days('2026-09-01', 58).map((d, i) => ({ date: d, citations: i < 30 ? 10 : 20 })), 'citations');
  assert.equal(tr.weeks.length, 8, 'leading partial week dropped');
  assert.equal(tr.weeks[7].end, '2026-10-28');
  assert.equal(tr.last4, 560);
  assert.equal(tr.prev4, 280);
  assert.equal(tr.change4, 1);
  assert.equal(tr.wow, 0);
  const weekly = weeklyTrend(['2026-09-07', '2026-09-14', '2026-09-21'].map((d) => ({ date: d, citations: 70 })), 'citations');
  assert.deepEqual([weekly.granularity, weekly.weeks.length, weekly.total], ['weekly', 0, 210], 'weekly exports are not read as daily');
  const hourly = weeklyTrend([...days('2026-09-01', 7), ...days('2026-09-01', 7)].map((d) => ({ date: d, citations: 1 })), 'citations');
  assert.equal(hourly.weeks[0].total, 14, 'rows of the same day add up');
  assert.throws(() => compareImports({ label: 'a', source: 'gsc', range: { days: 28 }, tables: {} }, { label: 'b', source: 'gsc', range: { days: 21 }, tables: {} }), /equal length/);
});

test('ai-reports-import: Search Console zip (zh-TW headers) from the inbox, AI share, events, duplicate skip', async () => {
  const ws = aiWorkspace();
  const inbox = path.join(ws, 'data', 'gsc', 'ai-features', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  gscZip(path.join(inbox, 'example.com-Performance-on-Search-2026-11-01.zip'), '2026-07-20', 56);
  const gscPages = path.join(tmpDir(), 'pages.json');
  fs.writeFileSync(gscPages, JSON.stringify({ meta: { dimensions: ['page'], startDate: '2026-07-20', endDate: '2026-09-13' }, rows: [{ page: 'https://www.example.com/guides/pour-over/', clicks: 90, impressions: 4000, ctr: 0.0225, position: 4.2 }, { page: 'https://www.example.com/blog/cold-brew/', clicks: 5, impressions: 600, ctr: 0.008, position: 9 }] }));
  const r = await runScript('ai-reports-import.mjs', ['--workspace', ws, '--gsc-pages', gscPages]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /imported Search Console Generative AI report \(search\) as "2026-07-20_2026-09-13"/);
  assert.match(r.stdout, /dates 56, pages 3, countries 2, devices 3/);
  assert.match(r.stdout, /note: Search Console data anomaly: Generative AI performance report \(Search\)/, 'genai-search anomaly 2026-08-13..17 overlaps');
  const out = files(ws, 'gsc/ai-features');
  for (const kind of ['dates', 'pages', 'countries', 'devices']) {
    assert.ok(out.some((f) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-2026-07-20_2026-09-13-${kind}\\.json$`).test(f)), `${kind}.json`);
    assert.ok(out.some((f) => new RegExp(`-2026-07-20_2026-09-13-${kind}\\.csv$`).test(f)), `${kind}.csv`);
  }
  const pages = readOut(ws, 'gsc/ai-features', /-pages\.json$/);
  assert.equal(pages.meta.source, 'gsc-generative-ai');
  assert.equal(pages.meta.kind, 'pages');
  assert.match(pages.meta.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pages.meta.file, 'example.com-Performance-on-Search-2026-11-01.zip');
  assert.deepEqual(pages.meta.dateRange, { start: '2026-07-20', end: '2026-09-13', days: 56 });
  assert.equal(pages.meta.label, '2026-07-20_2026-09-13');
  assert.deepEqual(pages.rows.map((x) => [x.impressions, x.group]), [[1200, 'guides'], [300, 'blog'], [0, 'home']], '"1,200" and "~" normalized; page groups');
  const devices = readOut(ws, 'gsc/ai-features', /-devices\.json$/);
  assert.equal(devices.rows[0].device, 'mobile');
  const index = JSON.parse(fs.readFileSync(path.join(ws, 'data', 'gsc', 'ai-features', 'imports.json'), 'utf8'));
  assert.equal(index.imports.length, 1);
  const report = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.endsWith('-ai-reports.md'))), 'utf8');
  for (const s of ['Evidence level: AI impressions/citations, not clicks or revenue', '| /guides/pour-over/ | guides | 1,200 | 30.0% | pour over ratio |', '| /blog/cold-brew/ | blog | 300 | 50.0% | cold brew |', 'chart (property-level) 7,140', 'Last 4 weeks', 'never add them', 'The newest days are provisional']) assert.ok(report.includes(s), `report misses: ${s}`);
  const again = await runScript('ai-reports-import.mjs', ['--workspace', ws]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /skipped example\.com-Performance-on-Search-2026-11-01\.zip: already imported as "2026-07-20_2026-09-13"/);
  assert.match(again.stdout, /GSC generative AI \(search\) 2026-07-20_2026-09-13/, 'analysis falls back to the latest import');
  const forced = await runScript('ai-reports-import.mjs', ['--workspace', ws, '--force', '--label', 'summer']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /as "summer"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'data', 'gsc', 'ai-features', 'imports.json'), 'utf8')).imports.length, 1, 'index entry replaced, not duplicated');
});

test('ai-reports-import: Discover variant, --compare of equal-length imports and refusal for unequal ones', async () => {
  const ws = aiWorkspace();
  const dir = tmpDir();
  const a = gscZip(path.join(dir, 'a.zip'), '2026-05-25', 56, { perDay: () => 100 });
  const b = gscZip(path.join(dir, 'b.zip'), '2026-07-20', 56, { perDay: () => 150 });
  const c = gscZip(path.join(dir, 'c.zip'), '2026-09-14', 28);
  const d = gscZip(path.join(dir, 'genai-discover.zip'), '2026-08-01', 28, { discover: true });
  const r = await runScript('ai-reports-import.mjs', ['--workspace', ws, a, b, c, d]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(discover\) as "2026-08-01_2026-08-28-discover"/);
  assert.match(r.stdout, /note: Search Console data anomaly: Discover \(and Generative AI in Discover\)/, 'discover-scope anomaly for the Discover variant');
  const cmp = await runScript('ai-reports-import.mjs', ['--workspace', ws, '--compare', '2026-05-25_2026-07-19:2026-07-20_2026-09-13']);
  assert.equal(cmp.status, 0, cmp.stderr);
  assert.match(cmp.stdout, /compare gsc dates: 5,600 -> 8,400 impressions \(\+50\.0%\)/);
  const report = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.endsWith('-ai-reports.md'))), 'utf8');
  assert.ok(report.includes('## Compare 2026-05-25_2026-07-19 -> 2026-07-20_2026-09-13'));
  const bad = await runScript('ai-reports-import.mjs', ['--workspace', ws, '--compare', '2026-05-25_2026-07-19:2026-09-14_2026-10-11']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Refusing to compare .* \(56 days\) with .* \(28 days\): periods must have equal length/);
  const unknown = await runScript('ai-reports-import.mjs', ['--workspace', ws, '--compare', 'nope:other']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Known imports: gsc:2026-05-25_2026-07-19/);
});

test('ai-reports-import: Bing AI Performance CSVs (trend, pages, grounding, portfolio), topics vs keyword-map, to-do', async () => {
  const ws = aiWorkspace();
  const r = await runScript('ai-reports-import.mjs', ['--workspace', ws, '--bing', BING_DIR]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /imported Bing Webmaster Tools AI Performance as "2026-09-01_2026-10-26" \(2026-09-01 -> 2026-10-26\)/);
  assert.match(r.stdout, /868 citations; 3 cited page\(s\); 5 grounding queries in 4 topic\(s\), 1 without a keyword-map entry; portfolio to-do 2/);
  const dir = 'bing/ai-performance';
  const out = files(ws, dir);
  for (const kind of ['trend', 'pages', 'grounding', 'portfolio']) assert.ok(out.some((f) => new RegExp(`-2026-09-01_2026-10-26-${kind}\\.json$`).test(f)), kind);
  const trend = readOut(ws, dir, /-trend\.json$/);
  assert.equal(trend.meta.source, 'bing-ai-performance');
  assert.deepEqual(trend.rows[0], { date: '2026-09-01', citations: 10, citedPages: 3 }, 'M/D/YYYY 12:00:00 AM dates and BOM handled');
  const pages = readOut(ws, dir, /-pages\.json$/);
  assert.equal(pages.rows[0].citations, 1234);
  assert.equal(pages.meta.dateRangeFrom, 'the date table of the same import');
  const grounding = readOut(ws, dir, /-grounding\.json$/);
  assert.deepEqual(grounding.rows.find((x) => x.query.startsWith('burr')), { query: 'burr grinder, best for pour over', citations: 1050, intent: 'Commercial', topic: 'Grinders', citationShare: 0.032 });
  const portfolio = readOut(ws, dir, /-portfolio\.json$/);
  assert.equal(portfolio.rows[0].topicSize, 5400);
  assert.equal(portfolio.rows[0].queries, 120, 'numeric Queries column is a count');
  const todo = csvToRecords(fs.readFileSync(path.join(ws, 'data', dir, out.find((f) => f.endsWith('-portfolio-todo.csv'))), 'utf8')).records;
  assert.deepEqual(todo.map((x) => x.topic), ['Cold brew', 'Espresso machines']);
  assert.equal(todo[0].keyword_map_match, 'cold brew');
  const report = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.endsWith('-ai-reports.md'))), 'utf8');
  for (const s of ['### Weekly citations', 'Last 4 weeks 504 vs the 4 before 364 (+38.5%)', '| pour over ratio | 2 | 200 | pour over ratio -> /guides/pour-over/ |', '"burr grinder best for pour over"', 'a citation is not a click']) assert.ok(report.includes(s), `report misses: ${s}`);
  const dup = await runScript('ai-reports-import.mjs', ['--workspace', ws, path.join(BING_DIR, 'www.example.com_AIPageStatsReport_11_1_2026.csv')]);
  assert.equal(dup.status, 0, dup.stderr);
  assert.match(dup.stdout, /skipped www\.example\.com_AIPageStatsReport_11_1_2026\.csv: already imported/);
  // re-importing one table under the same label does not mix in the older tables of that label
  const again = await runScript('ai-reports-import.mjs', ['--workspace', ws, '--force', '--bing', path.join(BING_DIR, 'www.example.com_AIPerformanceOverviewStats_11_1_2026.csv')]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Bing AI Performance 2026-09-01_2026-10-26: 868 citations\n/);
});

test('ai-reports-import: errors (xlsx, unknown layout, Performance export, nothing to import)', async () => {
  const ws = aiWorkspace();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'report.xlsx'), 'PK');
  const xlsx = await runScript('ai-reports-import.mjs', ['--workspace', ws, path.join(dir, 'report.xlsx')]);
  assert.equal(xlsx.status, 1);
  assert.match(xlsx.stderr, /spreadsheet; only CSV exports are read/);
  assert.match(xlsx.stderr, /save\/export it as CSV/);
  fs.writeFileSync(path.join(dir, 'odd.csv'), 'Foo,Bar\n1,2\n');
  const odd = await runScript('ai-reports-import.mjs', ['--workspace', ws, path.join(dir, 'odd.csv')]);
  assert.equal(odd.status, 1);
  assert.match(odd.stderr, /not a recognized Search Console Generative AI or Bing AI Performance export/);
  assert.match(odd.stderr, /Headers found: odd\.csv: Foo, Bar/);
  assert.match(odd.stderr, /Supported: Search Console Generative AI/);
  writeZip(path.join(dir, 'perf.zip'), [['Queries.csv', 'Top queries,Clicks,Impressions,CTR,Position\nq,1,10,10%,3\n'], ['Filters.csv', 'Filter,Value\nSearch type,Web\n']]);
  const perf = await runScript('ai-reports-import.mjs', ['--workspace', ws, path.join(dir, 'perf.zip')]);
  assert.equal(perf.status, 1);
  assert.match(perf.stderr, /regular Search Console Performance export/);
  fs.writeFileSync(path.join(dir, 'big5.csv'), Buffer.concat([Buffer.from('Page,Citations\nhttps://www.example.com/'), Buffer.from([0xb1, 0xc0, 0xc2, 0xcb]), Buffer.from(',3\n')]));
  const big5 = await runScript('ai-reports-import.mjs', ['--workspace', ws, path.join(dir, 'big5.csv')]);
  assert.equal(big5.status, 1);
  assert.match(big5.stderr, /big5\.csv: the file is not UTF-8 text/);
  const none = await runScript('ai-reports-import.mjs', ['--workspace', ws]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No exports found in the inboxes/);
  assert.match(none.stderr, /ai-performance\/inbox/);
  // a stray file in an inbox is skipped with a warning; the other exports still import
  const inbox = path.join(ws, 'data', 'bing', 'ai-performance', 'inbox');
  fs.copyFileSync(path.join(dir, 'report.xlsx'), path.join(inbox, 'report.xlsx'));
  fs.copyFileSync(path.join(BING_DIR, 'www.example.com_AIPageStatsReport_11_1_2026.csv'), path.join(inbox, 'pages.csv'));
  const mixed = await runScript('ai-reports-import.mjs', ['--workspace', ws]);
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.match(mixed.stdout, /warning: report\.xlsx \(inbox\) skipped: report\.xlsx is a spreadsheet/);
  assert.match(mixed.stdout, /imported Bing Webmaster Tools AI Performance as "export-2026-11-01"|imported Bing Webmaster Tools AI Performance as "import-[0-9a-f]{8}"/);
  assert.match(mixed.stdout, /period is unknown/);
});
