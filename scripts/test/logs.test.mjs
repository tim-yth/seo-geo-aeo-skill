import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, assert, FIXTURES, makeWorkspace, runScript, runScriptSync, startServer, tmpDir, dataFile } from './harness.mjs';
import { loadWorkspace } from '../lib/config.mjs';
import { csvToRecords } from '../lib/csv.mjs';
import { classifyUa, canonicalIp, ipPrefix, isPrivateIp, sameIp, botByName, verifyClaims, loadIpLists, parseIpList, buildBlockList, dnsCheck, fixtureDnsResolver, BOTS, IP_LISTS } from '../lib/bots.mjs';
import { parseClfLine, parseClfTime, parseTimeValue, parseJsonRecord, detectFormat, mapFields, recordFromFields, pathKey, quantile, analyzeLogs, loadDeployWaves, collectLogFiles, recrawlTable } from '../log-analyze.mjs';

const L = path.join(FIXTURES, 'logs');
const LISTS = path.join(L, 'ip-lists');
const GB = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const VISITOR_IPS = ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13', '203.0.113.14', '2001:db8:ffff::5'];
const SPOOFER_IPS = ['203.0.113.77', '203.0.113.99'];
const WAVE = {
  id: 'W-2026-10-20-test',
  date: '2026-10-20',
  timezone: 'Asia/Taipei',
  deployedAt: { utc: '2026-10-20T02:00:00.000Z', local: '2026-10-20 10:00', pt: '2026-10-19 19:00', exact: true },
  type: 'seo-change',
  urls: ['https://www.example.com/guides/pour-over/', 'https://www.example.com/blog/best-grinders/', 'https://www.example.com/blog/never-crawled/'],
  status: 'live',
  checkpoints: [],
};

/** Copy the log fixtures into a folder (plus a gzipped rotated file) and return it. */
function logDir() {
  const dir = path.join(tmpDir('seo-logs-'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['access.log', 'cloudflare.jsonl', 'app.csv', 'common.log']) fs.copyFileSync(path.join(L, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'access.log.2.gz'), zlib.gzipSync(fs.readFileSync(path.join(L, 'access.log.2.txt'))));
  fs.writeFileSync(path.join(dir, '.hidden.log'), 'ignored\n');
  return dir;
}

function workspaceWithWave() {
  const ws = makeWorkspace(['--page-group', 'blog=^/blog/', '--page-group', 'guides=^/guides/']);
  fs.writeFileSync(path.join(ws, 'logs', 'experiments.json'), `${JSON.stringify([WAVE], null, 2)}\n`);
  return ws;
}

const readCsv = (file) => csvToRecords(fs.readFileSync(file, 'utf8')).records;

function allOutputText(ws) {
  const texts = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else texts.push(fs.readFileSync(f, 'utf8'));
    }
  };
  walk(path.join(ws, 'data'));
  walk(path.join(ws, 'logs', 'reviews'));
  return texts.join('\n');
}

async function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('log-analyze: --help works without a workspace', () => {
  const r = runScriptSync('log-analyze.mjs', ['--help'], { cwd: tmpDir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node scripts\/log-analyze\.mjs/);
  assert.match(r.stdout, /--verify <value>/);
});

test('log-analyze: parsers for combined (vhost, escapes), Cloudflare, nested JSON and CSV', () => {
  const a = parseClfLine(`192.0.2.10 - - [01/Oct/2026:08:00:00 +0800] "GET /a?b=1 HTTP/1.1" 200 120 "-" "${GB}"`);
  assert.equal(a.ip, '192.0.2.10');
  assert.equal(a.time, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(a.path, '/a?b=1');
  assert.equal(a.status, 200);
  assert.equal(classifyUa(a.ua).name, 'Googlebot');
  const v = parseClfLine('www.example.com:443 2001:db8::7 - - [22/Oct/2026:11:00:00 +0000] "GET http://www.example.com/x/ HTTP/1.1" 404 - "-" "say \\"hi\\" \\x22bot\\x22"');
  assert.equal(v.ip, '2001:db8::7');
  assert.equal(v.host, 'www.example.com');
  assert.equal(v.path, '/x/');
  assert.equal(v.status, 404);
  assert.equal(v.ua, 'say "hi" "bot"');
  const common = parseClfLine('203.0.113.14 - - [03/Oct/2026:09:00:00 +0000] "GET /old/ HTTP/1.0" 200 512');
  assert.equal(common.hasUa, false);
  assert.equal(parseClfLine('not a log line'), null);
  assert.equal(parseClfTime('03/Oct/2026:09:00:00 -0700'), Date.parse('2026-10-03T16:00:00Z'));
  for (const [input, iso] of [[1792540800000000000, '2026-10-21T00:00:00.000Z'], ['1792540800000000', '2026-10-21T00:00:00.000Z'], [1792540800000, '2026-10-21T00:00:00.000Z'], ['1792540800.5', '2026-10-21T00:00:00.500Z'], ['2026-10-21T08:00:00+08:00', '2026-10-21T00:00:00.000Z'], ['2026-10-21 00:00:00', '2026-10-21T00:00:00.000Z']]) {
    assert.equal(new Date(parseTimeValue(input)).toISOString(), iso, String(input));
  }
  const cf = parseJsonRecord({ ClientIP: '2001:db8:4801:10::abcd', ClientRequestHost: 'WWW.example.com', ClientRequestMethod: 'GET', ClientRequestURI: '/p?q=1', EdgeResponseStatus: 301, ClientRequestUserAgent: GB, EdgeStartTimestamp: 1792540800000000000 });
  assert.deepEqual([cf.ip, cf.host, cf.path, cf.status, cf.method], ['2001:db8:4801:10::abcd', 'www.example.com', '/p?q=1', 301, 'GET']);
  const gcp = parseJsonRecord({ timestamp: '2026-10-21T00:00:00Z', httpRequest: { remoteIp: '192.0.2.5', requestUrl: 'https://www.example.com/q?x=1', status: 200, userAgent: 'bingbot/2.0', requestMethod: 'GET' } });
  assert.deepEqual([gcp.ip, gcp.path, gcp.host, gcp.status], ['192.0.2.5', '/q?x=1', 'www.example.com', 200]);
  const nginx = parseJsonRecord({ remote_addr: '192.0.2.6', time_iso8601: '2026-10-21T08:00:00+08:00', request: 'GET /n HTTP/2.0', status: '200', http_user_agent: 'GPTBot/1.3', request_time: '0.123' });
  assert.equal(nginx.path, '/n');
  assert.equal(nginx.time, Date.parse('2026-10-21T00:00:00Z'), 'request_time (a duration) is not taken as the timestamp');
  const map = mapFields(['timestamp', 'client_ip', 'method', 'path', 'status', 'user_agent', 'host']);
  const row = ['2026-10-20T08:00:00Z', '192.0.2.130', 'GET', '/g/', '200', 'Applebot/0.1', 'www.example.com'];
  const idx = new Map(['timestamp', 'client_ip', 'method', 'path', 'status', 'user_agent', 'host'].map((h, i) => [h, i]));
  const rec = recordFromFields((k) => row[idx.get(k)], map);
  assert.deepEqual([rec.ip, rec.path, rec.status, rec.ua], ['192.0.2.130', '/g/', 200, 'Applebot/0.1']);
  assert.equal(detectFormat(fs.readFileSync(path.join(L, 'access.log'), 'utf8').split('\n')), 'combined');
  assert.equal(detectFormat(fs.readFileSync(path.join(L, 'common.log'), 'utf8').split('\n')), 'common');
  assert.equal(detectFormat(fs.readFileSync(path.join(L, 'cloudflare.jsonl'), 'utf8').split('\n')), 'cloudflare-json');
  assert.equal(detectFormat(['{"ip":"192.0.2.1","ua":"x","path":"/"}']), 'json');
  assert.equal(detectFormat(fs.readFileSync(path.join(L, 'app.csv'), 'utf8').split('\n')), 'csv');
  assert.equal(detectFormat(['[', '{"ip":"192.0.2.1"}']), 'json-array');
  assert.equal(detectFormat(['hello world']), '');
  assert.equal(pathKey('https://www.example.com/caf%C3%A9/?utm_source=x'), pathKey('/café/'));
  assert.equal(pathKey('/x?b=1&utm_medium=y'), '/x?b=1');
  assert.equal(pathKey('/x?b=1', { stripQuery: true }), '/x');
  assert.equal(quantile([3, 24], 0.5), 13.5);
  assert.ok(Math.abs(quantile([3, 24], 0.9) - 21.9) < 1e-9);
  assert.equal(quantile([], 0.5), null);
});

test('log-analyze: bot catalog order, control tokens and IP helpers', () => {
  const cases = [
    ['Googlebot-Image/1.0', 'Googlebot-Image'],
    [GB, 'Googlebot'],
    ['Mozilla/5.0 (compatible; Google-Extended)', 'Google-Extended'],
    ['Mozilla/5.0 (Applebot-Extended/0.1)', 'Applebot-Extended'],
    ['Mozilla/5.0 (Macintosh) Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', 'Applebot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', 'ChatGPT-User'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot', 'GPTBot'],
    ['Mozilla/5.0 (compatible; Claude-SearchBot/1.0)', 'Claude-SearchBot'],
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://www.anthropic.com/claudebot)', 'ClaudeBot'],
    ['Mozilla/5.0 (compatible; Perplexity-User/1.0)', 'Perplexity-User'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0)', 'PerplexityBot'],
    ['Mozilla/5.0 (compatible; Google-InspectionTool/1.0)', 'Google-InspectionTool'],
    ['AdsBot-Google (+http://www.google.com/adsbot.html)', 'AdsBot-Google'],
    ['python-requests/2.32.3', 'Other automated clients'],
  ];
  for (const [ua, name] of cases) assert.equal((classifyUa(ua) || {}).name, name, ua);
  assert.equal(classifyUa('Mozilla/5.0 (Linux; Android 12; Cubot P40 Build/SP1A) Chrome/130.0.0.0 Mobile Safari/537.36'), null, 'phone model "Cubot" is not a bot');
  assert.equal(classifyUa(''), null);
  for (const b of BOTS) {
    assert.ok(['search', 'ai-search', 'ai-user', 'ai-training', 'other-bot', 'control-token'].includes(b.category), b.name);
    for (const id of b.lists) assert.ok(IP_LISTS[id], `${b.name}: unknown list ${id}`);
    assert.equal(b.lastVerified, '2026-11-02');
  }
  for (const u of Object.values(IP_LISTS).map((l) => l.url)) assert.ok(!/goog\.json|\/search\/apis\/ipranges\//.test(u), `never use ${u}`);
  assert.deepEqual(canonicalIp('::ffff:192.0.2.1'), { ip: '192.0.2.1', family: 4 });
  assert.deepEqual(canonicalIp('[2001:DB8::1]:443'), { ip: '2001:db8::1', family: 6 });
  assert.deepEqual(canonicalIp('192.0.2.9:8080'), { ip: '192.0.2.9', family: 4 });
  assert.deepEqual(canonicalIp('192.0.2.9, 10.0.0.1'), { ip: '192.0.2.9', family: 4 });
  assert.equal(canonicalIp('crawl.example.net'), null);
  assert.equal(ipPrefix('203.0.113.77'), '203.0.113.0/24');
  assert.equal(ipPrefix('2001:db8:4801:10::abcd'), '2001:db8:4801::/48');
  assert.ok(sameIp('2001:db8:4801:10::abcd', '2001:DB8:4801:10:0:0:0:ABCD'));
  assert.ok(isPrivateIp('10.1.2.3') && isPrivateIp('fd00::1') && !isPrivateIp('192.0.2.1'));
});

test('log-analyze: IP-list verification (spoofed, stale Bing list, control token, private IP)', async () => {
  const list = (id, prefixes) => {
    const parsed = parseIpList({ creationTime: '2026-10-30T00:00:00Z', prefixes });
    return { id, creationTime: parsed.creationTime, sha256: 'a'.repeat(64), prefixes: parsed.prefixes, blockList: buildBlockList(parsed.prefixes), error: '' };
  };
  const lists = new Map([
    ['google-common', list('google-common', [{ ipv4Prefix: '192.0.2.0/25' }, { ipv6Prefix: '2001:db8:4801:10::/64' }])],
    ['bingbot', list('bingbot', [{ ipv4Prefix: '198.51.100.0/28' }])],
  ]);
  const claims = [
    { bot: botByName('Googlebot'), ip: '192.0.2.12' },
    { bot: botByName('Googlebot'), ip: '2001:db8:4801:10::abcd' },
    { bot: botByName('Googlebot'), ip: '203.0.113.77' },
    { bot: botByName('Google-Extended'), ip: '192.0.2.12' },
    { bot: botByName('Bingbot'), ip: '198.51.100.200' },
    { bot: botByName('Bingbot'), ip: '198.51.100.2' },
    { bot: botByName('Googlebot'), ip: '10.0.0.8' },
    { bot: botByName('GPTBot'), ip: '198.51.100.65' },
    { bot: botByName('Bytespider'), ip: '198.51.100.70' },
  ];
  const r = await verifyClaims(claims, { mode: 'ranges', lists });
  const st = (bot, ip) => r.get(`${bot}|${ip}`);
  assert.equal(st('Googlebot', '192.0.2.12').status, 'verified');
  assert.match(st('Googlebot', '192.0.2.12').version, /^google-common@2026-10-30T00:00:00Z#a{12}$/);
  assert.equal(st('Googlebot', '2001:db8:4801:10::abcd').status, 'verified');
  assert.equal(st('Googlebot', '203.0.113.77').status, 'spoofed');
  assert.equal(st('Google-Extended', '192.0.2.12').status, 'spoofed', 'control tokens never fetch, even from a Google IP');
  assert.equal(st('Bingbot', '198.51.100.200').status, 'unverifiable', 'stale Bing list is not proof of spoofing');
  assert.equal(st('Bingbot', '198.51.100.2').status, 'verified');
  assert.equal(st('Googlebot', '10.0.0.8').status, 'unverifiable');
  assert.match(st('GPTBot', '198.51.100.65').detail, /unavailable/);
  assert.equal(st('Bytespider', '198.51.100.70').status, 'unverifiable');
  const none = await verifyClaims(claims, { mode: 'none', lists });
  assert.equal(none.get('Googlebot|192.0.2.12').status, 'unverifiable');
  assert.equal(none.get('Google-Extended|192.0.2.12').status, 'spoofed');
});

test('log-analyze: reverse + forward DNS check with an injected resolver (cached per IP)', async () => {
  const calls = { reverse: 0, forward: 0 };
  const base = fixtureDnsResolver(path.join(L, 'dns.json'));
  const resolver = {
    reverse: (ip) => {
      calls.reverse++;
      return base.reverse(ip);
    },
    forward: (h) => {
      calls.forward++;
      return base.forward(h);
    },
  };
  const cache = new Map();
  assert.deepEqual(await dnsCheck('198.51.100.200', ['search.msn.com'], resolver, { cache }), { ok: true, host: 'msnbot-198-51-100-200.search.msn.com', reason: '' });
  assert.equal((await dnsCheck('203.0.113.77', ['googlebot.com'], resolver, { cache })).reason, 'wrong-domain', 'look-alike PTR under another domain');
  assert.equal((await dnsCheck('203.0.113.50', ['googlebot.com'], resolver, { cache })).reason, 'no-ptr');
  assert.equal((await dnsCheck('2001:db8:4801:10::abcd', ['googlebot.com'], resolver, { cache })).ok, true, 'IPv6 forward answer in another notation');
  const mismatch = fixtureDnsResolver({ ptr: { '192.0.2.11': ['crawl-192-0-2-11.googlebot.com'] }, forward: { 'crawl-192-0-2-11.googlebot.com': ['192.0.2.99'] } });
  assert.equal((await dnsCheck('192.0.2.11', ['googlebot.com'], mismatch)).reason, 'forward-mismatch');
  const other = fixtureDnsResolver({ ptr: { '192.0.2.40': ['rate-limited-proxy-192-0-2-40.google.com'] }, forward: { 'rate-limited-proxy-192-0-2-40.google.com': ['192.0.2.40'] } });
  const o = await dnsCheck('192.0.2.40', ['googlebot.com'], other, { otherDomains: ['google.com'] });
  assert.equal(o.other, true, 'a google.com host is Google but not Googlebot');
  const before = calls.reverse;
  await dnsCheck('198.51.100.200', ['search.msn.com'], resolver, { cache });
  assert.equal(calls.reverse, before, 'reverse lookups are cached per IP');

  const ws = loadWorkspace({ workspace: workspaceWithWave() });
  const dir = logDir();
  calls.reverse = 0;
  const res = await withEnv({ SEO_AGENT_BOT_LISTS_DIR: LISTS }, () => analyzeLogs(ws, { inputs: [dir], verify: 'dns', sitemaps: [path.join(L, 'sitemap.xml')], dnsDelay: 0 }, { resolver, log: () => {} }));
  const bots = Object.fromEntries(res.summary.bots.map((b) => [b.bot, b]));
  assert.equal(bots.Bingbot.verified_hits, 1, 'Bingbot verified by reverse DNS');
  assert.equal(bots.Bingbot.verified_by, 'rdns');
  assert.equal(bots.Googlebot.spoofed_hits, 2);
  assert.equal(bots.Googlebot.verified_hits, 14);
  assert.equal(bots.GPTBot.verified_hits, 2, 'dns mode falls back to the IP list for bots without published reverse-DNS domains');
  const uniqueIps = new Set(['198.51.100.200', '192.0.2.10', '192.0.2.11', '192.0.2.12', '192.0.2.13', '2001:db8:4801:10::abcd', '203.0.113.77', '192.0.2.14', '192.0.2.130', '192.0.2.193']);
  assert.ok(calls.reverse <= uniqueIps.size, `one reverse lookup per IP (got ${calls.reverse})`);
});

test('log-analyze: IP lists are downloaded once, cached 24 h, versioned and usable offline', async () => {
  let hits = 0;
  const body = '{"creationTime":"2026-10-30T15:46:20.000000","prefixes":[{"ipv4Prefix":"192.0.2.0/25"},{"ipv6Prefix":"2001:db8:4801:10::/64"},{"bogus":1}]}';
  const srv = await startServer({ routes: { '/lists/google-common.json': () => { hits++; return { status: 200, headers: { 'content-type': 'application/json' }, body }; } } });
  try {
    const cacheDir = path.join(tmpDir(), 'ip-ranges');
    await withEnv({ SEO_AGENT_BOT_LISTS_ENDPOINT: `${srv.origin}/lists`, SEO_AGENT_BOT_LISTS_DIR: undefined }, async () => {
      const a = await loadIpLists(['google-common', 'openai-gptbot'], { cacheDir });
      assert.equal(hits, 1);
      const g = a.get('google-common');
      assert.equal(g.source, 'network');
      assert.equal(g.prefixes.length, 2, 'malformed prefixes are skipped');
      assert.ok(g.blockList.check('192.0.2.77', 'ipv4'));
      assert.match(a.get('openai-gptbot').error, /HTTP 404/);
      const b = await loadIpLists(['google-common'], { cacheDir });
      assert.equal(hits, 1, 'second run within 24 h uses the cache');
      assert.equal(b.get('google-common').source, 'cache');
      const c = await loadIpLists(['google-common'], { cacheDir, now: Date.now() + 25 * 3600000 });
      assert.equal(hits, 2, 'stale cache is refreshed');
      assert.equal(c.get('google-common').source, 'network');
      const ledger = fs.readFileSync(path.join(cacheDir, 'versions.csv'), 'utf8').trim().split('\n');
      assert.equal(ledger.length, 2, 'same version recorded once');
      assert.match(ledger[1], /^google-common,2026-10-30T15:46:20\.000000,[0-9a-f]{64},/);
      assert.equal(fs.readdirSync(path.join(cacheDir, 'archive')).length, 1);
      const off = await loadIpLists(['google-common', 'anthropic'], { cacheDir, offline: true, now: Date.now() + 99 * 3600000 });
      assert.equal(off.get('google-common').stale, true);
      assert.match(off.get('anthropic').error, /offline/);
      assert.equal(hits, 2, 'offline never touches the network');
    });
  } finally {
    await srv.close();
  }
});

test('log-analyze: end-to-end on combined + Cloudflare JSON + CSV + gz logs (tables, recrawl, coverage, privacy)', async () => {
  const ws = workspaceWithWave();
  const dir = logDir();
  const env = { SEO_AGENT_BOT_LISTS_DIR: LISTS };
  const r = await runScript('log-analyze.mjs', ['--workspace', ws, '--input', dir, '--sitemap', path.join(L, 'sitemap.xml')], { env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Parsed 36 requests from 5 file\(s\)/);
  assert.match(r.stdout, /Recrawl W-2026-10-20-test: 2\/3 changed URL\(s\) fetched after D0, median 13\.5 h, P90 21\.9 h/);
  assert.match(r.stderr, /1 line\(s\) could not be parsed \(contents not shown\)/);
  assert.ok(!r.stderr.includes('not an access log line'), 'unparsed lines are never echoed');
  assert.match(r.stderr, /common log format has no user agent/);

  const bots = Object.fromEntries(readCsv(dataFile(ws, 'bots', /-bots\.csv$/)).map((b) => [b.bot, b]));
  assert.deepEqual([bots.Googlebot.claimed_hits, bots.Googlebot.verified_hits, bots.Googlebot.spoofed_hits], ['16', '14', '2']);
  assert.equal(bots.Googlebot.robots_txt_fetches, '1');
  assert.match(bots.Googlebot.list_versions, /^google-common@2026-10-30T15:46:20\.000000#[0-9a-f]{12}$/);
  assert.equal(bots['Google-Extended'].spoofed_hits, '1');
  assert.equal(bots['Claude-SearchBot'].spoofed_hits, '1');
  assert.equal(bots.Bingbot.unverifiable_hits, '1');
  for (const b of ['OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot', 'Perplexity-User', 'Applebot', 'CCBot', 'Googlebot-Image']) assert.equal(bots[b].verified_hits, '1', b);
  assert.equal(bots.GPTBot.share_4xx, '0.5');

  const daily = readCsv(dataFile(ws, 'bots', /-bots-daily\.csv$/));
  assert.ok(daily.some((d) => d.date === '2026-10-01' && d.bot === 'Googlebot' && d.page_group === 'home' && d.status_class === '2xx' && d.verified_hits === '1'));
  assert.ok(daily.some((d) => d.date === '2026-10-13' && d.bot === 'Googlebot' && d.page_group === 'other' && d.status_class === '5xx' && d.verified_hits === '1'));
  assert.ok(daily.some((d) => d.date === '2026-10-20' && d.bot === 'Googlebot' && d.page_group === 'blog' && d.verified_hits === '0' && d.claimed_hits === '1'), 'spoofed hit counted as claimed only');

  const waste = readCsv(dataFile(ws, 'bots', /-bots-waste\.csv$/));
  assert.deepEqual(waste.map((w) => `${w.path} ${w.status} ${w.reason}`).sort(), ['/api/feed 503 server-error', '/blog/missing/ 404 client-error', '/blog/old-post 301 redirect', '/shop/?sort=price 200 parameter']);
  assert.ok(!waste.some((w) => w.path === '/wp-login.php'), 'spoofed hits are not waste');

  const recrawl = readCsv(dataFile(ws, 'bots', /-bots-recrawl\.csv$/));
  const waveRow = recrawl.find((x) => x.row_type === 'wave');
  assert.deepEqual([waveRow.changed_urls, waveRow.recrawled_urls, waveRow.median_hours, waveRow.p90_hours], ['3', '2', '13.5', '21.9']);
  const urlRow = (u) => recrawl.find((x) => x.row_type === 'url' && x.url.endsWith(u));
  assert.equal(urlRow('/guides/pour-over/').latency_hours, '3', 'first fetch AFTER D0, not the earlier one');
  assert.equal(urlRow('/blog/best-grinders/').latency_hours, '24');
  assert.equal(urlRow('/blog/never-crawled/').latency_hours, '', 'a spoofed Googlebot fetch does not count as a recrawl');

  const cov = readCsv(dataFile(ws, 'bots', /-bots-coverage\.csv$/));
  const c = (u) => cov.find((x) => x.url === u);
  assert.equal(c('https://www.example.com/about/').fetched_within_30d, 'no');
  assert.equal(c('https://www.example.com/blog/never-crawled/').fetched_within_30d, 'no');
  assert.equal(c('https://www.example.com/guides/pour-over/').fetched_within_30d, 'yes');
  assert.equal(c('https://www.example.com/guides/pour-over/').hits_last_30d, '5', 'IPv6 Cloudflare fetch included');
  assert.ok(cov.some((x) => x.in_sitemap === 'no' && x.url === '/about/team/'), 'fetched but not in the sitemap');

  const spoofed = readCsv(dataFile(ws, 'bots', /-bots-spoofed\.csv$/));
  const gs = spoofed.find((s) => s.claimed_bot === 'Googlebot');
  assert.deepEqual([gs.ip_prefix, gs.hits, gs.distinct_ips], ['203.0.113.0/24', '2', '1']);
  assert.ok(!gs.sample_paths.includes('redirect_to'), 'query strings are stripped from spoofer samples');

  const md = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.endsWith('-log-analyze.md'))), 'utf8');
  for (const s of ['## Bots', '## Googlebot crawl waste', '## Coverage', '## First verified Googlebot fetch after each deploy', '## AI crawlers (verified only)', 'leading indicator', 'Origin server logs miss requests answered from a CDN cache', 'UA-only counts overstate AI bots']) assert.ok(md.includes(s), s);

  const text = allOutputText(ws);
  for (const ip of [...VISITOR_IPS, ...SPOOFER_IPS]) assert.ok(!text.includes(ip), `IP ${ip} leaked into outputs`);
  for (const secret of ['jane%40example.org', '/account/settings', 'session=abc123', 'not an access log line', 'Firefox/131.0']) assert.ok(!text.includes(secret), `${secret} leaked`);
});

test('log-analyze: --verify both via $SEO_AGENT_DNS_FIXTURE, --host and --since/--until filters', async () => {
  const ws = workspaceWithWave();
  const dir = logDir();
  const env = { SEO_AGENT_BOT_LISTS_DIR: LISTS, SEO_AGENT_DNS_FIXTURE: path.join(L, 'dns.json') };
  const r = await runScript('log-analyze.mjs', ['--workspace', ws, '--input', dir, '--verify', 'both', '--host', 'www.example.com', '--since', '2026-10-15', '--until', '2026-10-21', '--json'], { env });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  const bots = Object.fromEntries(s.bots.map((b) => [b.bot, b]));
  assert.equal(bots.Bingbot.verified_hits, 1, 'reverse DNS confirms Bingbot outside its stale list');
  assert.equal(bots.Bingbot.verified_by, 'rdns');
  assert.equal(bots.Googlebot.spoofed_hits, 2);
  assert.ok(!bots['Googlebot-Image'], '--host drops static.example.com');
  assert.equal(s.meta.otherHost, 1);
  assert.equal(s.meta.start, '2026-10-15 18:00');
  assert.ok(s.meta.end <= '2026-10-21 23:59');
  assert.ok(s.meta.outsideWindow > 0);
  const text = `${allOutputText(ws)}\n${r.stdout}\n${r.stderr}`;
  for (const ip of [...VISITOR_IPS, ...SPOOFER_IPS]) assert.ok(!text.includes(ip), `IP ${ip} leaked with DNS verification`);
  assert.ok(!text.includes('attacker.example') && !/crawl-\d+-\d+-\d+-\d+/.test(text), 'reverse-DNS host names (which encode IPs) are never written');
});

test('log-analyze: errors and edge cases (no input, unknown format, offline + dns, offline without cache)', async () => {
  const ws = makeWorkspace();
  const none = runScriptSync('log-analyze.mjs', ['--workspace', ws]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No log input/);
  assert.match(none.stderr, /--input <file\|dir>/);
  const missing = runScriptSync('log-analyze.mjs', ['--workspace', ws, '--input', path.join(tmpDir(), 'nope.log')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Log input not found/);
  const weird = path.join(tmpDir(), 'weird.log');
  fs.writeFileSync(weird, 'hello world\nfoo bar\n');
  const w = runScriptSync('log-analyze.mjs', ['--workspace', ws, '--input', weird]);
  assert.equal(w.status, 1);
  assert.match(w.stderr, /Could not detect the log format of weird\.log/);
  assert.match(w.stderr, /--format/);
  const offDns = runScriptSync('log-analyze.mjs', ['--workspace', ws, '--input', path.join(L, 'access.log'), '--offline', '--verify', 'dns']);
  assert.equal(offDns.status, 1);
  assert.match(offDns.stderr, /needs the network/);
  const bad = runScriptSync('log-analyze.mjs', ['--workspace', ws, '--input', path.join(L, 'access.log'), '--format', 'xml']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be one of/);
  const off = runScriptSync('log-analyze.mjs', ['--workspace', ws, '--input', path.join(L, 'access.log'), '--offline', '--json'], { env: { SEO_AGENT_BOT_LISTS_DIR: '' } });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /IP lists unavailable: .*google-common \(offline and no cached copy\).*run once without --offline/);
  const s = JSON.parse(off.stdout);
  assert.equal(s.bots.find((b) => b.bot === 'Googlebot').unverifiable_hits, 14);
  assert.equal(s.bots.find((b) => b.bot === 'Google-Extended').spoofed_hits, 1, 'control tokens are spoofed even without lists');
  const corrupt = path.join(tmpDir(), 'broken.log.gz');
  fs.writeFileSync(corrupt, 'not gzip at all');
  const gz = runScriptSync('log-analyze.mjs', ['--workspace', ws, '--input', corrupt, '--format', 'combined', '--verify', 'none']);
  assert.equal(gz.status, 1);
  assert.match(gz.stderr, /broken\.log\.gz: not a valid gzip file|incorrect header/);
});

test('log-analyze: deploy waves from experiments.json or a CSV, proxy-IP warning', async () => {
  const ws = loadWorkspace({ workspace: workspaceWithWave() });
  const waves = loadDeployWaves(ws);
  assert.equal(waves.length, 1);
  assert.equal(waves[0].d0, Date.parse('2026-10-20T02:00:00Z'));
  const csv = path.join(tmpDir(), 'deploys.csv');
  fs.writeFileSync(csv, 'wave,d0,url\nW1,2026-10-20 10:00,https://www.example.com/a/\nW1,2026-10-20 10:00,https://www.example.com/b/\n');
  const fromCsv = loadDeployWaves(ws, csv);
  assert.equal(fromCsv[0].urls.length, 2);
  assert.equal(fromCsv[0].d0, Date.parse('2026-10-20T02:00:00Z'), 'CSV D0 is read in the site time zone (Asia/Taipei)');
  const dir = tmpDir();
  const lines = Array.from({ length: 4 }, (_, i) => `10.0.0.${i + 1} - - [20/Oct/2026:0${i}:00:00 +0000] "GET /p${i} HTTP/1.1" 200 10 "-" "${GB}"`);
  fs.writeFileSync(path.join(dir, 'proxy.log'), `${lines.join('\n')}\n`);
  const res = await withEnv({ SEO_AGENT_BOT_LISTS_DIR: LISTS }, () => analyzeLogs(ws, { inputs: [dir], verify: 'ranges' }, { log: () => {} }));
  assert.equal(res.summary.bots[0].unverifiable_hits, 4);
  const md = fs.readFileSync(res.files[0], 'utf8');
  assert.match(md, /WARNING: 4 bot requests come from private\/proxy addresses/);
});

test('log-analyze: X-Forwarded-For, Compute Engine host names, IPv6 CCBot and private hops', async () => {
  assert.deepEqual(canonicalIp('192.0.2.12, 203.0.113.77'), { ip: '203.0.113.77', family: 4 }, 'the client-supplied left part of X-Forwarded-For is not trusted');
  assert.deepEqual(canonicalIp('203.0.113.9, 10.0.0.2, 172.16.0.5'), { ip: '203.0.113.9', family: 4 }, 'private proxy hops are skipped');
  const list = (id, prefixes) => {
    const parsed = parseIpList({ creationTime: '2026-10-30T00:00:00Z', prefixes });
    return { id, creationTime: parsed.creationTime, sha256: 'b'.repeat(64), prefixes: parsed.prefixes, blockList: buildBlockList(parsed.prefixes), error: '' };
  };
  const lists = new Map([['google-common', list('google-common', [{ ipv4Prefix: '192.0.2.0/25' }])], ['ccbot', list('ccbot', [{ ipv6Prefix: '2001:db8:365:8000::/56' }])], ['google-user-triggered', list('google-user-triggered', [{ ipv4Prefix: '198.51.100.0/28' }])]]);
  const resolver = fixtureDnsResolver({
    ptr: { '203.0.113.80': ['80.113.0.203.bc.googleusercontent.com'], '203.0.113.81': ['81.113.0.203.bc.googleusercontent.com'], '192.0.2.40': ['rate-limited-proxy-192-0-2-40.google.com'] },
    forward: { '80.113.0.203.bc.googleusercontent.com': ['203.0.113.80'], '81.113.0.203.bc.googleusercontent.com': ['203.0.113.81'], 'rate-limited-proxy-192-0-2-40.google.com': ['192.0.2.40'] },
  });
  const claims = [
    { bot: botByName('Googlebot'), ip: '203.0.113.80' },
    { bot: botByName('Google user-triggered fetcher'), ip: '203.0.113.81' },
    { bot: botByName('CCBot'), ip: '2001:db8:365:8000::9' },
    { bot: botByName('Googlebot'), ip: '192.0.2.40' },
  ];
  for (const mode of ['dns', 'both']) {
    const r = await verifyClaims(claims, { mode, lists, resolver, dnsDelayMs: 0 });
    assert.equal(r.get('Googlebot|203.0.113.80').status, 'spoofed', `${mode}: a Compute Engine VM is not Google`);
    assert.equal(r.get('Google user-triggered fetcher|203.0.113.81').status, 'spoofed', `${mode}: user-triggered fetchers are verified by their list only`);
    assert.equal(r.get('CCBot|2001:db8:365:8000::9').status, 'verified', `${mode}: CCBot has no IPv6 reverse DNS; the list decides`);
    for (const v of r.values()) assert.ok(!/googleusercontent|google\.com\b.*\d|\d+\.\d+\.\d+\.\d+/.test(v.detail), `no host names or IPs in details: ${v.detail}`);
  }
  const xff = (first) => parseClfLine(`${first} - - [20/Oct/2026:05:00:00 +0000] "GET /a HTTP/1.1" 200 1 "-" "${GB}"`).ip;
  assert.equal(xff('192.0.2.12, 203.0.113.77'), '192.0.2.12, 203.0.113.77', 'combined lines keep the whole X-Forwarded-For list');
  assert.equal(xff('192.0.2.12,203.0.113.77,10.0.0.1'), '192.0.2.12,203.0.113.77,10.0.0.1');
  const v = await verifyClaims([
    { bot: botByName('Googlebot'), ip: xff('192.0.2.12, 203.0.113.77') },
    { bot: botByName('Googlebot'), ip: '192.0.2.12, 198.51.100.250' },
    { bot: botByName('Googlebot'), ip: '192.0.2.12, 10.0.0.1' },
    { bot: botByName('Googlebot'), ip: '203.0.113.77, 10.0.0.1' },
  ], { mode: 'ranges', lists });
  assert.equal(v.get('Googlebot|192.0.2.12, 203.0.113.77').status, 'unverifiable', 'a forged left address never verifies');
  assert.match(v.get('Googlebot|192.0.2.12, 198.51.100.250').detail, /several public addresses/, 'a CDN hop is not reported as spoofing');
  assert.equal(v.get('Googlebot|192.0.2.12, 10.0.0.1').status, 'verified', 'private proxy hops are skipped');
  assert.equal(v.get('Googlebot|203.0.113.77, 10.0.0.1').status, 'spoofed');
  const dnsOnly = await verifyClaims([claims[3]], { mode: 'dns', lists, resolver, dnsDelayMs: 0 });
  assert.equal(dnsOnly.get('Googlebot|192.0.2.40').status, 'unverifiable', 'dns mode: a google.com host is Google but not Googlebot');
  const both = await verifyClaims([claims[3]], { mode: 'both', lists, resolver, dnsDelayMs: 0 });
  assert.equal(both.get('Googlebot|192.0.2.40').status, 'verified', 'in the Googlebot list');
});

test('log-analyze: folder scans skip error logs and unknown files, include rotated names', async () => {
  const dir = tmpDir();
  const line = `192.0.2.12 - - [20/Oct/2026:05:00:00 +0000] "GET /a HTTP/1.1" 200 10 "-" "${GB}"\n`;
  for (const f of ['access.log', 'access.log-20261101', 'access_log', 'access.log.3', 'site.log-20261030.gz']) fs.writeFileSync(path.join(dir, f), f.endsWith('.gz') ? zlib.gzipSync(line) : line);
  fs.writeFileSync(path.join(dir, 'error.log'), '2026/10/20 05:00:00 [error] 123#0: *1 open() "/x" failed\n');
  fs.writeFileSync(path.join(dir, 'README.txt'), 'Notes about these logs\nnothing to parse here\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# not a log\n');
  const names = collectLogFiles([dir]).map((f) => path.basename(f.file)).sort();
  assert.deepEqual(names, ['README.txt', 'access.log', 'access.log-20261101', 'access.log.3', 'access_log', 'site.log-20261030.gz']);
  const ws = loadWorkspace({ workspace: makeWorkspace() });
  const warnings = [];
  const res = await withEnv({ SEO_AGENT_BOT_LISTS_DIR: LISTS }, () => analyzeLogs(ws, { inputs: [dir] }, { log: (m) => warnings.push(m) }));
  assert.equal(res.summary.meta.files.length, 5);
  assert.equal(res.summary.bots.find((b) => b.bot === 'Googlebot').verified_hits, 5);
  assert.ok(warnings.some((w) => /README\.txt: not a recognized log format; skipped/.test(w)));
  await assert.rejects(() => analyzeLogs(ws, { inputs: [path.join(dir, 'README.txt')] }, { log: () => {} }), /Could not detect the log format of README\.txt/, 'an explicitly named file still fails loudly');
});

test('log-analyze: recrawl counts the first 200 after D0 only', () => {
  const d0 = Date.parse('2026-10-20T00:00:00Z');
  const f = { t: [d0 - 3600000, d0 + 3600000, d0 + 5 * 3600000], s: [200, 503, 200] };
  const r = recrawlTable([{ id: 'W1', d0, exact: true, urls: ['https://www.example.com/a'] }], new Map([[pathKey('https://www.example.com/a'), f]]), { tz: 'UTC', minT: d0 - 86400000, maxT: d0 + 86400000 });
  const row = r.rows.find((x) => x.row_type === 'url');
  assert.equal(row.latency_hours, 5);
  assert.match(row.note, /503/);
  const only = recrawlTable([{ id: 'W2', d0, exact: false, urls: ['https://www.example.com/a'] }], new Map([[pathKey('https://www.example.com/a'), { t: [d0 + 3600000], s: [404] }]]), { tz: 'UTC', minT: d0 - 86400000, maxT: d0 + 86400000 });
  assert.equal(only.summary[0].recrawled, 0, 'a 404 fetch is not a recrawl of the changed page');
  assert.match(only.summary[0].note, /D0 time not recorded/);
});
