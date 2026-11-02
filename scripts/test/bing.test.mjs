import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, makeWorkspace, runScript, runScriptSync, startServer, editConfig, dataFile } from './harness.mjs';
import { parseBingDate, convertDates, errorName } from '../lib/bing.mjs';
import { aggregateStats, decodeIssues, windowOf } from '../bing-export.mjs';
import { csvToRecords } from '../lib/csv.mjs';

const KEY = 'bing-test-key-4d5e6f7a8b';
const API = '/webmaster/api.svc/json';
const B = path.join(FIXTURES, 'bing');

/** WCF date for a Pacific-Time day (PDT offset, as Bing sends it). */
const wcf = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return `\\/Date(${Date.UTC(y, m - 1, d, 7)}-0700)\\/`;
};
const days = (start, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

/** Fixture JSON with {{DATE:YYYY-MM-DD}} placeholders turned into escaped WCF dates. */
const body = (name) => fs.readFileSync(path.join(B, name), 'utf8').replace(/"\{\{DATE:(\d{4}-\d{2}-\d{2})\}\}"/g, (_, d) => `"${wcf(d)}"`);

async function withBing(fn, { throttleOnce = false, failAbout = false } = {}) {
  const calls = [];
  let throttled = false;
  const json = (status, text) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: text });
  const guard = (url, handler) => {
    calls.push(url.pathname.split('/').pop() + url.search.replace(KEY, 'KEY'));
    if (url.searchParams.get('apikey') !== KEY) return json(400, '{"ErrorCode":3,"Message":"ERROR!!! InvalidApiKey"}');
    return handler(url);
  };
  const traffic = `{"d":[${days('2026-10-01', 28).map((d, i) => `{"__type":"RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api","Clicks":${i % 3},"Date":"${wcf(d)}","Impressions":${100 + i}}`).join(',')}]}`;
  const crawl = `{"d":[${days('2026-10-20', 10).map((d, i) => `{"AllOtherCodes":0,"BlockedByRobotsTxt":2,"Code2xx":120,"Code301":3,"Code302":0,"Code4xx":${i === 9 ? 4 : 1},"Code5xx":0,"ConnectionTimeout":0,"ContainsMalware":0,"CrawlErrors":${i % 2},"CrawledPages":${10 + i},"Date":"${wcf(d)}","DnsFailures":0,"InIndex":95,"InLinks":40}`).join(',')}]}`;
  const srv = await startServer({
    routes: {
      [`${API}/GetRankAndTrafficStats`]: (req, url) => guard(url, () => json(200, traffic)),
      [`${API}/GetQueryStats`]: (req, url) => guard(url, () => {
        if (throttleOnce && !throttled) {
          throttled = true;
          return json(400, '{"ErrorCode":4,"Message":"ERROR!!! ThrottleUser"}');
        }
        return json(200, body('query-stats.json'));
      }),
      [`${API}/GetPageStats`]: (req, url) => guard(url, () => json(200, body('page-stats.json'))),
      [`${API}/GetPageQueryStats`]: (req, url) => guard(url, (u) => (u.searchParams.get('page') === 'https://www.example.com/guides/pour-over/' ? json(200, body('query-stats.json')) : json(400, '{"ErrorCode":8,"Message":"ERROR!!! InvalidParameter"}'))),
      [`${API}/GetCrawlStats`]: (req, url) => guard(url, () => json(200, crawl)),
      [`${API}/GetCrawlIssues`]: (req, url) => guard(url, () => json(200, '{"d":[{"__type":"UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api","HttpCode":404,"InLinks":2,"Issues":4,"Url":"https://www.example.com/missing/"},{"HttpCode":200,"InLinks":0,"Issues":48,"Url":"https://www.example.com/bad/"}]}')),
      [`${API}/GetLinkCounts`]: (req, url) => guard(url, (u) => json(200, u.searchParams.get('page') === '0'
        ? '{"d":{"__type":"LinkCounts:#Microsoft.Bing.Webmaster.Api","Links":[{"Count":12,"Url":"https://www.example.com/"},{"Count":5,"Url":"https://www.example.com/guides/pour-over/"}],"TotalPages":2}}'
        : '{"d":{"Links":[{"Count":1,"Url":"https://www.example.com/about/"}],"TotalPages":2}}')),
      [`${API}/GetUrlLinks`]: (req, url) => guard(url, (u) => {
        const link = u.searchParams.get('link');
        if (link === 'https://www.example.com/') return json(200, u.searchParams.get('page') === '0' ? '{"d":{"Details":[{"AnchorText":"Example Coffee","Url":"https://blog.example.org/best-coffee"}],"TotalPages":2}}' : '{"d":{"Details":[{"AnchorText":"  home\\n page ","Url":"https://news.example.net/story"}],"TotalPages":2}}');
        if (link === 'https://www.example.com/about/' && failAbout) return json(400, '{"ErrorCode":7,"Message":"ERROR!!! InvalidUrl"}');
        return json(200, `{"d":{"Details":[{"AnchorText":"guide","Url":"https://forum.example.org/t/1?ref=${encodeURIComponent(link)}"}],"TotalPages":1}}`);
      }),
      [`${API}/GetKeywordStats`]: (req, url) => guard(url, (u) => (u.searchParams.has('siteUrl') ? json(400, '{"ErrorCode":8,"Message":"unexpected siteUrl"}') : json(200, `{"d":[{"BroadImpressions":900,"Date":"${wcf('2026-10-04')}","Impressions":300,"Query":"${u.searchParams.get('q')}"},{"BroadImpressions":950,"Date":"${wcf('2026-10-11')}","Impressions":320,"Query":"${u.searchParams.get('q')}"}]}`))),
      [`${API}/GetKeyword`]: (req, url) => guard(url, (u) => json(200, `{"d":{"BroadImpressions":4000,"Impressions":1200,"Query":"${u.searchParams.get('q')}"}}`)),
      [`${API}/GetRelatedKeywords`]: (req, url) => guard(url, () => json(200, '{"d":[{"BroadImpressions":100,"Impressions":40,"Query":"pour over ratio grams"},{"BroadImpressions":300,"Impressions":90,"Query":"coffee to water ratio"}]}')),
    },
  });
  try {
    const ws = makeWorkspace(['--bing-site', 'https://www.example.com/', '--page-group', 'guides=^/guides/']);
    await fn({ ws, env: { BING_WEBMASTER_API_KEY: KEY, SEO_AGENT_BING_ENDPOINT: `${srv.origin}${API}` }, calls });
  } finally {
    await srv.close();
  }
}

test('bing-export: --help works without a workspace', () => {
  for (const args of [['--help'], []]) {
    const r = runScriptSync('bing-export.mjs', args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /bing-export\.mjs <traffic\|queries\|pages\|crawl\|links\|all>/);
  }
});

test('bing-export: /Date()/ parsing, error names, weekly aggregation and crawl issue flags', () => {
  assert.deepEqual(parseBingDate('/Date(1316156400000-0700)/'), { iso: '2011-09-16T07:00:00.000Z', ymd: '2011-09-16' });
  assert.equal(parseBingDate('/Date(1716015600000)/').ymd, '2024-05-18');
  assert.equal(parseBingDate('/Date(1730707200000+0100)/').ymd, '2024-11-04');
  assert.equal(parseBingDate('/Date(-62135596800000)/'), null, 'DateTime.MinValue');
  assert.deepEqual(convertDates({ __type: 'X', Date: '/Date(1316156400000-0700)/', Items: [{ LastCrawled: '/Date(1316156400000-0700)/' }] }), { Date: '2011-09-16', Items: [{ LastCrawled: '2011-09-16T07:00:00.000Z' }] });
  assert.equal(errorName(3), 'InvalidApiKey');
  assert.equal(errorName('', 'ERROR!!! ThrottleHost'), 'ThrottleHost');
  assert.equal(errorName(17), 'ThrottleIP');
  const rows = [
    { date: '2026-10-03', query: 'a', impressions: 100, clicks: 10, avgImpressionPosition: 2, avgClickPosition: 2 },
    { date: '2026-10-10', query: 'a', impressions: 300, clicks: 0, avgImpressionPosition: 4, avgClickPosition: -1 },
    { date: '2026-08-01', query: 'a', impressions: 999, clicks: 99, avgImpressionPosition: 9, avgClickPosition: 9 },
  ];
  const w = windowOf(rows, 28);
  assert.deepEqual(w, { start: '2026-09-13', end: '2026-10-10', days: 28 });
  assert.deepEqual(windowOf(rows.slice(0, 2), 90), { start: '2026-10-03', end: '2026-10-10', days: 8, clamped: true });
  const [a] = aggregateStats(rows, 'query', w);
  assert.deepEqual([a.impressions, a.clicks, a.avgImpressionPosition, a.avgClickPosition, a.buckets], [400, 10, 3.5, 2, 2], '-1 click position ignored; old bucket outside the window');
  assert.deepEqual(decodeIssues(48), ['BlockedByRobotsTxt', 'ContainsMalware']);
  assert.deepEqual(decodeIssues(0), []);
});

test('bing-export: all (traffic, queries, pages, crawl, links) against a mock API, with paging and the links.json contract', async () => {
  await withBing(async ({ ws, env, calls }) => {
    const r = await runScript('bing-export.mjs', ['all', '--workspace', ws, '--delay', '0', '--retry-ms', '1', '--days', '28'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /traffic: 2026-10-01 -> 2026-10-28: 27 clicks, 3,178 impressions/);
    assert.match(r.stdout, /top queries: 2 queries/);
    assert.match(r.stdout, /pour over ratio\s+12\s+250\s+3\.4/);
    assert.match(r.stdout, /\/guides\/pour-over\//, 'pages shown relative to the site');
    assert.match(r.stdout, /crawl: last 7 days 112 pages crawled, 4 crawl errors; latest snapshot 2026-10-29: in index 95, 4xx 4/);
    assert.match(r.stdout, /crawl issues: 2 URL\(s\): Code4xx 1, BlockedByRobotsTxt 1, ContainsMalware 1/);
    assert.match(r.stdout, /links: 3 linked URL\(s\), 18 inbound links counted; 4 linking page\(s\) from 3 domain\(s\)/);
    const links = JSON.parse(fs.readFileSync(dataFile(ws, 'bing', /-links\.json$/), 'utf8'));
    assert.deepEqual(Object.keys(links), ['meta', 'linkCounts', 'links']);
    assert.deepEqual(Object.keys(links.meta), ['siteUrl', 'fetchedAt', 'source']);
    assert.equal(links.meta.siteUrl, 'https://www.example.com/');
    assert.equal(links.meta.source, 'bing-webmaster');
    assert.ok(!Number.isNaN(Date.parse(links.meta.fetchedAt)));
    assert.deepEqual(links.linkCounts, [{ url: 'https://www.example.com/', count: 12 }, { url: 'https://www.example.com/guides/pour-over/', count: 5 }, { url: 'https://www.example.com/about/', count: 1 }], 'second page of GetLinkCounts read');
    assert.deepEqual(links.links[0], { target: 'https://www.example.com/', source: 'https://blog.example.org/best-coffee', anchor: 'Example Coffee' });
    assert.ok(links.links.some((l) => l.source === 'https://news.example.net/story' && l.anchor === 'home page'), 'second page of GetUrlLinks read; anchor whitespace collapsed');
    assert.equal(links.links.length, 4);
    const csv = fs.readFileSync(dataFile(ws, 'bing', /-links\.csv$/), 'utf8');
    assert.ok(csv.startsWith('target,source,anchor\n'));
    assert.equal(csvToRecords(csv).records.length, 4);
    const traffic = JSON.parse(fs.readFileSync(dataFile(ws, 'bing', /-traffic\.json$/), 'utf8'));
    assert.equal(traffic.rows[0].date, '2026-10-01', '/Date(...-0700)/ converted with its offset');
    const pages = JSON.parse(fs.readFileSync(dataFile(ws, 'bing', /-pages\.json$/), 'utf8'));
    assert.equal(pages.totals[0].page, 'https://www.example.com/guides/pour-over/', 'GetPageStats Query field holds the page URL');
    const crawl = JSON.parse(fs.readFileSync(dataFile(ws, 'bing', /-crawl\.json$/), 'utf8'));
    assert.deepEqual(crawl.issues[0], { url: 'https://www.example.com/missing/', httpCode: 404, inLinks: 2, issues: ['Code4xx'] });
    for (const n of ['traffic', 'queries', 'pages', 'crawl']) assert.ok(dataFile(ws, 'bing', new RegExp(`-${n}\\.csv$`)), `${n}.csv`);
    assert.ok(calls.every((c) => !c.includes(KEY)));
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
    const pq = await runScript('bing-export.mjs', ['page-queries', '--workspace', ws, '--page', '/guides/pour-over/', '--delay', '0'], { env });
    assert.equal(pq.status, 0, pq.stderr);
    assert.match(pq.stdout, /queries for \/guides\/pour-over\/: 2 queries/);
    assert.ok(dataFile(ws, 'bing', /-page-queries\.json$/));
  });
});

test('bing-export: throttling (HTTP 400 ErrorCode 4) is retried; a bad key fails with a redacted URL and setup steps', async () => {
  await withBing(async ({ ws, env }) => {
    const ok = await runScript('bing-export.mjs', ['queries', '--workspace', ws, '--delay', '0', '--retry-ms', '1'], { env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /top queries: 2 queries/);
    const bad = await runScript('bing-export.mjs', ['traffic', '--workspace', ws, '--delay', '0'], { env: { ...env, BING_WEBMASTER_API_KEY: 'wrong-key-123456' } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Bing API GetRankAndTrafficStats: HTTP 400 InvalidApiKey/);
    assert.match(bad.stderr, /Settings -> API access -> API Key/);
    assert.match(bad.stderr, /apikey=<redacted>/);
    assert.ok(!bad.stderr.includes('wrong-key-123456'), 'key redacted in errors');
    const missing = await runScript('bing-export.mjs', ['traffic', '--workspace', ws], { env: { ...env, BING_WEBMASTER_API_KEY: '' } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /\$BING_WEBMASTER_API_KEY is not set/);
    editConfig(ws, (c) => {
      c.bing.apiKeyEnv = 'MY_BING_KEY';
    });
    const renamed = await runScript('bing-export.mjs', ['traffic', '--workspace', ws, '--delay', '0'], { env: { ...env, BING_WEBMASTER_API_KEY: '', MY_BING_KEY: KEY } });
    assert.equal(renamed.status, 0, renamed.stderr);
    const unknown = runScriptSync('bing-export.mjs', ['backlinks', '--workspace', ws]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown subcommand/);
  }, { throttleOnce: true });
});

test('bing-export: one failing GetUrlLinks target does not lose the links export', async () => {
  await withBing(async ({ ws, env }) => {
    const r = await runScript('bing-export.mjs', ['links', '--workspace', ws, '--delay', '0'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /note: 1 target URL\(s\) failed in GetUrlLinks/);
    assert.match(r.stdout, /about\/: linking pages skipped \(HTTP 400 InvalidUrl\)/);
    const links = JSON.parse(fs.readFileSync(dataFile(ws, 'bing', /-links\.json$/), 'utf8'));
    assert.deepEqual(Object.keys(links.meta), ['siteUrl', 'fetchedAt', 'source']);
    assert.equal(links.linkCounts.length, 3);
    assert.equal(links.links.length, 3, 'the other targets are kept');
  }, { failAbout: true });
});

test('bing-export: keywords (stats, window and related; relative demand only)', async () => {
  await withBing(async ({ ws, env, calls }) => {
    const r = await runScript('bing-export.mjs', ['keywords', '--workspace', ws, '--keyword', 'pour over ratio', '--country', 'US', '--language', 'en-US', '--delay', '0'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Bing relative demand only, not Google volume/);
    assert.match(r.stdout, /pour over ratio\s+1,200\s+4,000\s+2/);
    assert.ok(calls.some((c) => c.startsWith('GetKeywordStats?') && c.includes('country=us') && c.includes('language=en-US')), 'country sent lowercase');
    const data = JSON.parse(fs.readFileSync(dataFile(ws, 'bing', /-keywords\.json$/), 'utf8'));
    assert.equal(data.keywords[0].weekly[1].date, '2026-10-11');
    assert.equal(data.keywords[0].related[0].query, 'coffee to water ratio');
    assert.match(data.meta.note, /not Google search volume/);
    const none = runScriptSync('bing-export.mjs', ['keywords', '--workspace', ws], { env });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /needs --keyword/);
  });
});
