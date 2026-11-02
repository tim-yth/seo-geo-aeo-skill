import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, SCRIPTS_DIR, makeWorkspace, runScript, runScriptSync, startServer, tmpDir, dataFile } from './harness.mjs';
import { csvToRecords, parseCsv } from '../lib/csv.mjs';
import { matchUrls, urlParts, meaningfulSlug, sharedAffixes, stripAffixes, titleTokens, isHomeUrl } from '../lib/url-match.mjs';
import { MAP_COLUMNS, evaluateRedirect, isHstsHop, parseRedirectsFile, lintRedirects, ruleKey, mergeEntries } from '../redirect-map.mjs';

const M = path.join(FIXTURES, 'migration');
const readCsv = (file) => csvToRecords(fs.readFileSync(file, 'utf8')).records;
const byOld = (rows) => Object.fromEntries(rows.map((r) => [r.old_url, r]));

test('redirect-map: --help works without a workspace', () => {
  const r = runScriptSync('redirect-map.mjs', ['--help'], { cwd: tmpDir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /redirect-map\.mjs verify/);
  assert.match(r.stdout, /never the home page/);
});

test('redirect-map: url keys, slugs and title helpers', () => {
  assert.equal(urlParts('https://www.example.com/Guides/Pour-Over.html?utm_source=x').key, '/guides/pour-over');
  assert.equal(urlParts('https://www.example.com/blog/index.html').key, '/blog');
  assert.equal(urlParts('https://www.example.com//a//b/').key, '/a/b');
  assert.equal(urlParts('https://www.example.com/p?b=2&a=1&gclid=z').key, '/p?a=1&b=2');
  assert.equal(urlParts('https://www.example.com/blog/%E5%92%96%E5%95%A1/').slug, '咖啡');
  assert.ok(isHomeUrl('https://www.example.com/index.html') && isHomeUrl('https://www.example.com') && !isHomeUrl('https://www.example.com/?lang=en'));
  for (const s of ['index', '2019', 'en', 'zh-tw', 'p', 'amp']) assert.equal(meaningfulSlug(s), false, s);
  for (const s of ['best-burr-grinders', 'faq', '咖啡']) assert.equal(meaningfulSlug(s), true, s);
  const aff = sharedAffixes(['Pour over | Example Coffee', 'Cold brew | Example Coffee', 'Grinders - Example Coffee', 'About | Example Coffee', 'Contact']);
  assert.equal(stripAffixes('Cold brew | Example Coffee', aff), 'Cold brew');
  assert.equal(stripAffixes('Cold brew | Another', aff), 'Cold brew | Another');
  assert.deepEqual([...titleTokens('手沖咖啡 Guides')].sort(), ['guide', '咖啡', '手沖', '沖咖']);
});

test('redirect-map: matching tiers (exact, normalize, slug, title, content, manual; never the home page)', () => {
  const olds = [
    { url: 'https://www.example.com/', title: 'Home | Example' },
    { url: 'https://www.example.com/guides/pour-over.html', title: 'Pour over | Example' },
    { url: 'http://www.example.com/guides/pour-over.html', title: 'Pour over | Example' },
    { url: 'https://old.example.org/contact/' },
    { url: 'https://www.example.com/blog/2019/best-burr-grinders', title: 'Grinders we liked in 2019 | Example' },
    { url: 'https://www.example.com/blog/cold-brew-ratio', title: 'Cold brew ratio explained | Example' },
    { url: 'https://www.example.com/blog/kettle', title: 'Descale | Example', text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen' },
    { url: 'https://www.example.com/blog/landing', title: 'Example Coffee Lab | Example' },
    { url: 'https://www.example.com/blog/2020/sale', title: 'Spring sale | Example' },
  ];
  const news = [
    { url: 'https://www.example.com/', title: 'Example Coffee Lab | Example' },
    { url: 'https://www.example.com/guides/pour-over', title: 'Pour over | Example' },
    { url: 'https://www.example.com/contact/', title: 'Contact | Example' },
    { url: 'https://www.example.com/reviews/best-burr-grinders/', title: 'Best burr grinders | Example' },
    { url: 'https://www.example.com/guides/cold-brew/', title: 'Cold brew: the ratio explained | Example' },
    { url: 'https://www.example.com/guides/kettle-care/', title: 'Kettle care | Example', text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen' },
    { url: 'https://www.example.com/blog/', title: 'Blog | Example' },
  ];
  const r = matchUrls(olds, news);
  const m = Object.fromEntries(r.matches.map((x) => [x.old.url, x]));
  const check = (oldUrl, newUrl, method, type, confidence) => {
    const x = m[oldUrl];
    assert.ok(x, `no match for ${oldUrl}`);
    assert.deepEqual([x.new.url, x.method, x.type, x.confidence], [newUrl, method, type, confidence], oldUrl);
  };
  check('https://www.example.com/', 'https://www.example.com/', 'exact', 'unchanged', 4);
  check('https://www.example.com/guides/pour-over.html', 'https://www.example.com/guides/pour-over', 'normalized-path', 'normalize', 4);
  check('http://www.example.com/guides/pour-over.html', 'https://www.example.com/guides/pour-over', 'normalized-path', 'normalize', 4);
  check('https://old.example.org/contact/', 'https://www.example.com/contact/', 'exact', '1:1', 4);
  check('https://www.example.com/blog/2019/best-burr-grinders', 'https://www.example.com/reviews/best-burr-grinders/', 'slug', '1:1', 3);
  check('https://www.example.com/blog/cold-brew-ratio', 'https://www.example.com/guides/cold-brew/', 'title', '1:1', 2);
  check('https://www.example.com/blog/kettle', 'https://www.example.com/guides/kettle-care/', 'content', '1:1', 2);
  const un = Object.fromEntries(r.unmatched.map((u) => [u.old.url, u]));
  assert.ok(un['https://www.example.com/blog/landing'], 'a title equal to the home page title never maps to home');
  assert.ok(!un['https://www.example.com/blog/landing'].candidates.some((c) => isHomeUrl(c.url)), 'home is not even offered as a candidate');
  assert.equal(un['https://www.example.com/blog/2020/sale'].parentHint, 'https://www.example.com/blog/', 'parent section hint');
  assert.equal(un['https://www.example.com/blog/landing'].parentHint, 'https://www.example.com/blog/');

  const withBrand = matchUrls([{ url: 'https://www.example.com/hello', title: 'Example Coffee Lab | Example' }], [{ url: 'https://www.example.com/about/', title: 'About Example Coffee Lab | Example' }], { ignoreTerms: ['Example Coffee Lab'] });
  assert.equal(withBrand.matches.length, 0, 'brand words alone are no evidence');
  const without = matchUrls([{ url: 'https://www.example.com/hello', title: 'Example Coffee Lab | Example' }], [{ url: 'https://www.example.com/about/', title: 'About Example Coffee Lab | Example' }]);
  assert.equal(without.matches[0].method, 'title');

  const pool = matchUrls([{ url: 'https://a.example.com/x/guide-one', title: 'Brewing guide one' }, { url: 'https://a.example.com/y/guide-one', title: 'Brewing guide one' }], [{ url: 'https://b.example.com/x/guide-one', title: 'Brewing guide one' }]);
  assert.equal(pool.matches.length, 1, 'fuzzy tiers use each new URL once');
  assert.equal(pool.matches[0].old.url, 'https://a.example.com/x/guide-one', 'the same section wins the slug tie');
  const many = matchUrls([{ url: 'https://a.example.com/a/brew-guide-part-1', title: 'Brew guide part one' }, { url: 'https://a.example.com/a/brew-guide-part-2', title: 'Brew guide part two' }], [{ url: 'https://a.example.com/brew-guide/', title: 'Brew guide' }], { allowMany: true });
  assert.equal(many.matches.length, 2);
  assert.ok(many.matches.every((x) => x.type === 'consolidate'));
});

test('redirect-map map: CLI on fixtures writes the template columns, priorities and the manual list', () => {
  const ws = makeWorkspace(['--brand-term', 'Example Coffee Lab']);
  const r = runScriptSync('redirect-map.mjs', ['--workspace', ws, '--old', path.join(M, 'old-urls.txt'), '--old', path.join(M, 'old-gsc.json'), '--old-text', path.join(M, 'old-text.jsonl'), '--new', path.join(M, 'new-pages.csv'), '--new-text', path.join(M, 'new-text.jsonl')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Mapped 10 of 12 old URLs/);
  const mapFile = dataFile(ws, 'migration', /-redirect-map\.csv$/);
  const header = parseCsv(fs.readFileSync(mapFile, 'utf8'))[0];
  const template = parseCsv(fs.readFileSync(path.join(SCRIPTS_DIR, '..', 'templates', 'situational-redirect-map.csv'), 'utf8'))[0];
  assert.deepEqual(header, [...template, 'score'], 'columns = template + score');
  assert.deepEqual(MAP_COLUMNS, header);
  const rows = readCsv(mapFile);
  const o = byOld(rows);
  const e = (u) => o[`https://www.example.com${u}`];
  assert.deepEqual([e('/guides/pour-over.html').new_url, e('/guides/pour-over.html').type, e('/guides/pour-over.html').match_method, e('/guides/pour-over.html').confidence], ['https://www.example.com/guides/pour-over', 'normalize', 'normalized-path', '4']);
  assert.match(e('/guides/pour-over.html').notes, /not a retirement/);
  assert.deepEqual([e('/guides/pour-over.html').impr_16m, e('/guides/pour-over.html').clk_16m], ['2000', '50']);
  assert.equal(e('/Guides/French-Press/').type, 'normalize');
  assert.equal(e('/blog/index.html').new_url, 'https://www.example.com/blog/');
  assert.equal(e('/tools/brew-calculator').type, 'normalize', 'tracking parameters are stripped');
  assert.deepEqual([e('/').type, e('/').expected_status], ['unchanged', '200']);
  assert.equal(o['https://old-domain.example.org/contact/'].type, '1:1');
  assert.equal(e('/blog/2019/best-burr-grinders').match_method, 'slug');
  assert.equal(e('/blog/cold-brew-ratio-guide').match_method, 'title');
  assert.deepEqual([e('/blog/descaling-kettle').match_method, e('/blog/descaling-kettle').new_url], ['content', 'https://www.example.com/guides/kettle-maintenance/']);
  const cjk = rows.find((x) => x.old_url.includes('/blog/zh/'));
  assert.equal(cjk.match_method, 'title');
  assert.ok(decodeURI(cjk.new_url).endsWith('/guides/手沖咖啡/'));
  assert.equal(e('/welcome-old').match_method, 'manual');
  assert.equal(e('/welcome-old').new_url, '', 'never defaults to the home page');
  assert.ok(!rows.some((x) => x.new_url.includes('/drafts/') || x.new_url.includes('/reviews/spring-sale-2021/')), 'non-indexable and 404 pages are not targets');
  assert.equal(rows[0].old_url, 'https://www.example.com/guides/pour-over.html', 'sorted by clicks');
  const un = readCsv(dataFile(ws, 'migration', /-redirect-map-unmatched\.csv$/));
  assert.deepEqual(un.map((x) => x.old_url), ['https://www.example.com/welcome-old', 'https://www.example.com/blog/spring-sale-2021'], 'unmatched sorted by clicks');
  assert.equal(un[1].parent_hint, 'https://www.example.com/blog/');
  assert.match(un[0].suggestion, /has traffic or links/);

  const missing = runScriptSync('redirect-map.mjs', ['--workspace', ws, '--old', path.join(M, 'old-urls.txt')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /map needs --old and --new/);
  const bad = runScriptSync('redirect-map.mjs', ['frobnicate', '--workspace', ws]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown subcommand/);
});

test('redirect-map: merging sources keeps found_in and the larger metrics', () => {
  const merged = mergeEntries([[{ url: 'https://www.example.com/a?utm_source=x', found: 'sitemap' }], [{ url: 'https://www.example.com/a', found: 'gsc', clicks: 5, impressions: 50 }, { url: 'https://www.example.com/a', found: 'gsc', clicks: 2, impressions: 80, title: 'A' }]]);
  assert.equal(merged.length, 1);
  assert.deepEqual([[...merged[0].found].join('|'), merged[0].clicks, merged[0].impressions, merged[0].title], ['sitemap|gsc', 5, 80, 'A']);
});

test('redirect-map verify: rules on fetch results (HSTS hop, chains, temporary, home, retired)', () => {
  const ok = { chain: [{ url: 'https://o.example.com/a', status: 301, location: 'https://n.example.com/a' }], status: 200, finalUrl: 'https://n.example.com/a' };
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: 'https://n.example.com/a', type: '1:1' }, ok).result, 'pass');
  const hsts = { chain: [{ url: 'http://o.example.com/a', status: 301, location: 'https://o.example.com/a' }, { url: 'https://o.example.com/a', status: 301, location: 'https://n.example.com/a' }], status: 200, finalUrl: 'https://n.example.com/a' };
  assert.ok(isHstsHop(hsts.chain[0]));
  const h = evaluateRedirect({ old_url: 'http://o.example.com/a', new_url: 'https://n.example.com/a', type: '1:1' }, hsts);
  assert.equal(h.result, 'pass', h.issues.join());
  assert.equal(h.observed_status, '301>301>200');
  assert.equal(h.observed_hops, 2);
  const notHsts = { ...hsts, chain: [{ url: 'http://o.example.com/a', status: 301, location: 'https://n.example.com/x' }, { url: 'https://n.example.com/x', status: 301, location: 'https://n.example.com/a' }] };
  assert.equal(evaluateRedirect({ old_url: 'http://o.example.com/a', new_url: 'https://n.example.com/a' }, notHsts).result, 'fail');
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: 'https://n.example.com/a' }, { ...ok, chain: [{ ...ok.chain[0], status: 302 }] }).result, 'fail');
  const home = evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: '' }, { chain: [{ url: 'https://o.example.com/a', status: 301, location: 'https://n.example.com/' }], status: 200, finalUrl: 'https://n.example.com/' });
  assert.match(home.issues.join(), /home page/);
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', type: 'retire-410', expected_status: '410' }, { chain: [], status: 410, finalUrl: 'https://o.example.com/a' }).result, 'pass');
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', type: 'retire-410', expected_status: '410' }, { chain: [], status: 404, finalUrl: 'https://o.example.com/a' }).result, 'warn');
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', type: 'retire-404' }, { chain: [], status: 200, finalUrl: 'https://o.example.com/a' }).result, 'fail');
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: '' }, { chain: [], status: 404, finalUrl: 'https://o.example.com/a' }).result, 'pass', 'list mode: a retired URL is fine');
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: 'https://n.example.com/a' }, ok, { noindex: true }).result, 'fail');
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: 'https://n.example.com/a' }, ok, { canonical: '/a' }).result, 'pass', 'relative canonical to itself');
});

test('redirect-map verify: live checks against a local server, --fail-on-error exits 2', async () => {
  const page = (extra = '') => ({ status: 200, headers: { 'content-type': 'text/html' }, body: `<html><head><title>Page</title>${extra}</head><body><h1>Page</h1></body></html>` });
  const go = (status, location) => ({ status, headers: { location }, body: '' });
  const srv = await startServer({
    routes: {
      '/': page('<link rel="canonical" href="{{ORIGIN}}/">'),
      '/a': go(301, '/a-new'),
      '/a-new': page('<link rel="canonical" href="{{ORIGIN}}/a-new">'),
      '/chain': go(301, '/mid'),
      '/mid': go(301, '/end'),
      '/end': page(),
      '/temp': go(302, '/a-new'),
      '/loop1': go(301, '/loop2'),
      '/loop2': go(301, '/loop1'),
      '/old-post': go(301, '/'),
      '/dead': go(301, '/missing'),
      '/gone': { status: 410, body: 'gone' },
      '/noindex-src': go(301, '/noindex-page'),
      '/noindex-page': page('<meta name="robots" content="noindex">'),
      '/canon-src': go(301, '/canon-page'),
      '/canon-page': page('<link rel="canonical" href="{{ORIGIN}}/other">'),
      '/still': page(),
      '/same': page(),
      '/wrong': go(301, '/a-new'),
      '/perm308': go(308, '/a-new'),
      '/xrobots-src': go(301, '/xrobots'),
      '/xrobots': { status: 200, headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' }, body: '<html><head><title>X</title></head><body>x</body></html>' },
    },
  });
  try {
    const ws = makeWorkspace();
    const O = srv.origin;
    const rows = [
      ['/a', '/a-new', '1:1', '301', 'pass'],
      ['/chain', '/end', '1:1', '301', 'fail'],
      ['/temp', '/a-new', '1:1', '301', 'fail'],
      ['/loop1', '/loop2', '1:1', '301', 'fail'],
      ['/old-post', '/', '1:1', '301', 'fail'],
      ['/dead', '/missing', '1:1', '301', 'fail'],
      ['/gone', '', 'retire-410', '410', 'pass'],
      ['/noindex-src', '/noindex-page', '1:1', '301', 'fail'],
      ['/canon-src', '/canon-page', '1:1', '301', 'warn'],
      ['/still', '/a-new', '1:1', '301', 'fail'],
      ['/same', '/same', 'unchanged', '200', 'pass'],
      ['/wrong', '/b-new', '1:1', '301', 'fail'],
      ['/perm308', '/a-new', 'normalize', '301', 'pass'],
      ['/xrobots-src', '/xrobots', '1:1', '301', 'fail'],
    ];
    const csv = path.join(tmpDir(), 'map.csv');
    fs.writeFileSync(csv, `old_url,new_url,type,expected_status,owner,notes\n${rows.map(([a, b, t, s]) => `${O}${a},${b ? O + b : ''},${t},${s},web,"keep, this"`).join('\n')}\n`);
    const r = await runScript('redirect-map.mjs', ['verify', '--workspace', ws, '--map', csv, '--delay', '0', '--fail-on-error']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout, /Verified 14 redirect\(s\): 4 pass, 1 warn, 9 fail/);
    const outRows = readCsv(dataFile(ws, 'migration', /-redirect-verify\.csv$/));
    for (const [a, , , , want] of rows) {
      const row = outRows.find((x) => x.old_url === `${O}${a}`);
      assert.equal(row.verify_result, want, `${a}: ${row.verify_issues}`);
    }
    const get = (a) => outRows.find((x) => x.old_url === `${O}${a}`);
    assert.deepEqual([get('/a').observed_status, get('/a').observed_hops, get('/a').observed_final_url], ['301>200', '1', `${O}/a-new`]);
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(get('/a').tested_at));
    assert.equal(get('/a').owner, 'web', 'input columns are kept');
    assert.equal(get('/a').notes, 'keep, this');
    assert.match(get('/chain').verify_issues, /2 redirect hops/);
    assert.match(get('/temp').verify_issues, /temporary redirect 302/);
    assert.match(get('/loop1').verify_issues, /redirect loop/);
    assert.match(get('/old-post').verify_issues, /home page/);
    assert.match(get('/dead').verify_issues, /final status 404/);
    assert.match(get('/noindex-src').verify_issues, /noindex/);
    assert.match(get('/xrobots-src').verify_issues, /noindex/);
    assert.match(get('/canon-src').verify_issues, /canonical points to/);
    assert.match(get('/still').verify_issues, /still answers 200/);
    assert.match(get('/wrong').verify_issues, /expected .*\/b-new/);
    const list = path.join(tmpDir(), 'old.txt');
    fs.writeFileSync(list, `${O}/a\n${O}/gone\n${O}/old-post\n`);
    const r2 = await runScript('redirect-map.mjs', ['verify', '--workspace', ws, '--map', list, '--delay', '0', '--json']);
    assert.equal(r2.status, 0, 'no --fail-on-error: findings are not failures');
    const s = JSON.parse(r2.stdout);
    assert.deepEqual([s.pass, s.fail], [2, 1]);
    const none = runScriptSync('redirect-map.mjs', ['verify', '--workspace', makeWorkspace()]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /No mapping to verify/);
  } finally {
    await srv.close();
  }
});

test('redirect-map lint: chains, loops, duplicates, status codes, home targets, dead targets', () => {
  const rules = parseRedirectsFile(fs.readFileSync(path.join(M, '_redirects'), 'utf8'));
  assert.equal(rules.length, 12);
  assert.equal(rules.find((r) => r.from === '/no-code').explicit, false);
  assert.equal(rules.find((r) => r.from === '/blog/*').dynamic, true);
  assert.equal(ruleKey('/Foo', 'https://www.example.com'), '/Foo', 'paths are case-sensitive in _redirects');
  assert.equal(ruleKey('https://other.example.org/x', 'https://www.example.com'), 'abs:https://other.example.org/x');
  const findings = lintRedirects(rules, { liveKeys: new Set(['/new-b', '/target', '/x', '/articles/']), origin: 'https://www.example.com' });
  const has = (from, rule) => findings.some((f) => f.from === from && f.rule === rule);
  for (const [from, rule] of [['/old-a', 'chain'], ['/loop-x', 'loop'], ['/loop-y', 'loop'], ['/self', 'loop'], ['/no-code', 'no-status'], ['/temp', 'temporary'], ['/dup', 'duplicate-source'], ['/to-home', 'to-home'], ['/dup', 'target-not-live']]) assert.ok(has(from, rule), `${from} ${rule}`);
  assert.ok(!findings.some((f) => f.from === '/ok'), '308 to a live page is fine');
  assert.ok(!findings.some((f) => f.from === '/blog/*'), 'dynamic rules are not chased');
  const ws = makeWorkspace();
  const r = runScriptSync('redirect-map.mjs', ['lint', '--workspace', ws, '--redirects-file', path.join(M, '_redirects'), '--urls', path.join(M, 'live-urls.txt'), '--fail-on-error']);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /12 rule\(s\) in _redirects: 4 error\(s\)/);
  assert.ok(fs.existsSync(dataFile(ws, 'migration', /-redirects-lint\.csv$/)));
  const big = parseRedirectsFile(Array.from({ length: 2001 }, (_, i) => `/s${i} /t${i} 301`).join('\n'));
  assert.ok(lintRedirects(big).some((f) => f.rule === 'too-many-rules'));
});

test('redirect-map map: --fetch-titles reads missing titles politely (robots.txt respected)', async () => {
  const page = (title) => ({ status: 200, headers: { 'content-type': 'text/html' }, body: `<html><head><title>${title} | Example Coffee</title></head><body><h1>${title}</h1></body></html>` });
  const srv = await startServer({
    routes: {
      '/robots.txt': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private/\n' },
      '/old/cold-brew-notes': page('Cold brew ratio and steeping time'),
      '/private/grind-notes': page('Grind size chart'),
      '/new/brewing/cold-brew/': page('Cold brew: ratio and steeping time'),
      '/new/brewing/grind-size/': page('Grind size chart'),
      '/new/about/': page('About'),
    },
  });
  try {
    const ws = makeWorkspace();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'old.txt'), `${srv.origin}/old/cold-brew-notes\n${srv.origin}/private/grind-notes\n`);
    fs.writeFileSync(path.join(dir, 'new.txt'), `${srv.origin}/new/brewing/cold-brew/\n${srv.origin}/new/brewing/grind-size/\n${srv.origin}/new/about/\n`);
    const r = await runScript('redirect-map.mjs', ['--workspace', ws, '--old', path.join(dir, 'old.txt'), '--new', path.join(dir, 'new.txt'), '--fetch-titles', '--delay', '0']);
    assert.equal(r.status, 0, r.stderr);
    const rows = readCsv(dataFile(ws, 'migration', /-redirect-map\.csv$/));
    const o = byOld(rows);
    assert.deepEqual([o[`${srv.origin}/old/cold-brew-notes`].new_url, o[`${srv.origin}/old/cold-brew-notes`].match_method], [`${srv.origin}/new/brewing/cold-brew/`, 'title']);
    assert.equal(o[`${srv.origin}/private/grind-notes`].match_method, 'manual', 'disallowed page was not fetched, so no title evidence');
  } finally {
    await srv.close();
  }
});

test('redirect-map: review fixes (relative new_url, temporary HSTS hop, 404 rules in lint, noindex targets, missing --backlinks)', () => {
  const res = (final) => ({ chain: [{ url: 'https://o.example.com/a', status: 301, location: `https://o.example.com${final}` }], status: 200, finalUrl: `https://o.example.com${final}` });
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: '/b' }, res('/zzz')).result, 'fail', 'relative new_url is resolved against old_url');
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: '/b' }, res('/b')).result, 'pass');
  assert.equal(evaluateRedirect({ old_url: 'https://o.example.com/a', new_url: 'http://[bad' }, res('/b')).result, 'fail');
  const hsts302 = { chain: [{ url: 'http://o.example.com/a', status: 302, location: 'https://o.example.com/a' }, { url: 'https://o.example.com/a', status: 301, location: 'https://n.example.com/a' }], status: 200, finalUrl: 'https://n.example.com/a' };
  assert.match(evaluateRedirect({ old_url: 'http://o.example.com/a', new_url: 'https://n.example.com/a' }, hsts302).issues.join(), /temporary redirect 302 on the http->https hop/);
  const rules = parseRedirectsFile('/a /b 301\n/b /404.html 404\n/c /gone 410\n');
  const findings = lintRedirects(rules, { liveKeys: new Set(['/x']), origin: 'https://www.example.com' });
  assert.ok(!findings.some((f) => f.rule === 'chain'), 'a 404 rule ends the chain');
  assert.ok(findings.some((f) => f.from === '/a' && f.rule === 'to-retired'), 'a redirect into a retired path is an error');
  assert.ok(!findings.some((f) => f.from === '/b' || f.from === '/c'), 'error-page rules are not redirects');
  const ws = makeWorkspace();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'old.txt'), 'https://www.example.com/blog/hidden-page\n');
  fs.writeFileSync(path.join(dir, 'new-text.jsonl'), `${JSON.stringify({ url: 'https://www.example.com/guides/hidden-page/', status: 200, noindex: true, title: 'Hidden', text: 'x' })}\n${JSON.stringify({ url: 'https://www.example.com/guides/other/', status: 200, noindex: false, title: 'Other', text: 'y' })}\n`);
  const r = runScriptSync('redirect-map.mjs', ['--workspace', ws, '--old', path.join(dir, 'old.txt'), '--new', path.join(dir, 'new-text.jsonl')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readCsv(dataFile(ws, 'migration', /-redirect-map\.csv$/))[0].match_method, 'manual', 'a noindex page is never a redirect target');
  const missing = runScriptSync('redirect-map.mjs', ['--workspace', ws, '--old', path.join(dir, 'old.txt'), '--new', path.join(dir, 'new-text.jsonl'), '--backlinks', path.join(dir, 'typo.csv')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--backlinks file not found/);
});

test('redirect-map verify: X-Robots-Tag noindex on a non-HTML target fails', async () => {
  const srv = await startServer({
    routes: {
      '/old.pdf': { status: 301, headers: { location: '/new.pdf' }, body: '' },
      '/new.pdf': { status: 200, headers: { 'content-type': 'application/pdf', 'x-robots-tag': 'noindex' }, body: '%PDF-1.4' },
    },
  });
  try {
    const ws = makeWorkspace();
    const csv = path.join(tmpDir(), 'map.csv');
    fs.writeFileSync(csv, `old_url,new_url,type,expected_status\n${srv.origin}/old.pdf,${srv.origin}/new.pdf,1:1,301\n`);
    const r = await runScript('redirect-map.mjs', ['verify', '--workspace', ws, '--map', csv, '--delay', '0']);
    assert.equal(r.status, 0, r.stderr);
    const row = readCsv(dataFile(ws, 'migration', /-redirect-verify\.csv$/))[0];
    assert.equal(row.verify_result, 'fail');
    assert.match(row.verify_issues, /noindex/);
  } finally {
    await srv.close();
  }
});
