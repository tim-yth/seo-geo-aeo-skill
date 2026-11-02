import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, assert, FIXTURES, tmpDir, makeWorkspace, runScript, runScriptSync, startServer, editConfig, dataFile } from './harness.mjs';
import { csvToRecords } from '../lib/csv.mjs';
import { similarity, addedSuffix, parseRedirects, matchRedirect, parseHeaderRules, loadRetired, BLOCK_RULES } from '../seo-diff.mjs';
import { scanBody, fileToUrlPath, normKey, strictKey, pathKey, stripCacheParams, extractFacts, contentSignature, guessDirPrefix } from '../lib/page-facts.mjs';

const F = path.join(FIXTURES, 'seo-diff');
const BEFORE = path.join(F, 'before');
const AFTER = path.join(F, 'after');
const FIXTURE_ARGS = ['--before', BEFORE, '--after', AFTER, '--retired', path.join(F, 'retired.txt'), '--protect-url', '/guides/pour-over/', '--protect-path', 'about/index.html'];
const O = 'https://www.example.com';

const outputs = (dir, suffix) => {
  const f = fs.readdirSync(dir).find((x) => x.endsWith(suffix));
  return f ? path.join(dir, f) : null;
};
const changes = (file) => csvToRecords(fs.readFileSync(file, 'utf8')).records;
const has = (rows, severity, rule, url = '') => rows.some((r) => r.severity === severity && r.rule === rule && (!url || r.url === (url.startsWith('http') ? url : `${O}${url}`)));

function writeSite(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const mini = (key, { title = 'Guide', robots = '', body = '<p>Steady pours give an even extraction and a sweet cup.</p>' } = {}) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><link rel="canonical" href="${O}${key}">${robots ? `<meta name="robots" content="${robots}">` : ''}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

test('seo-diff: --help works without a workspace', () => {
  const r = runScriptSync('seo-diff.mjs', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node scripts\/seo-diff\.mjs/);
  assert.match(r.stdout, /--fail-on/);
  assert.match(r.stdout, /CI step/);
});

test('seo-diff: pure helpers (similarity, suffix, redirects, headers, retired list)', () => {
  assert.equal(similarity('Pour over guide', 'Pour over guide'), 1);
  assert.ok(similarity('Pour over guide | Example', 'Pour over ratio guide | Example') > 0.7);
  assert.ok(similarity('Tea brewing basics', 'How to brew loose-leaf tea') < 0.7);
  assert.equal(addedSuffix('Steaming milk', 'Steaming milk | Example Coffee Lab'), '| Example Coffee Lab');
  assert.equal(addedSuffix('Steaming milk - Old', 'Steaming milk | Example Coffee Lab'), '| Example Coffee Lab');
  assert.equal(addedSuffix('Tea basics', 'How to brew tea'), '');
  const rules = parseRedirects('# comment\n/old/ /new/ 301\n/blog/* /news/:splat 301\n/p/:id /products/:id 308\n/gone/ /410.html 410\n/* /index.html 200\n', '_redirects');
  assert.equal(rules.length, 5);
  assert.equal(matchRedirect(rules, '/old').to, '/new/');
  assert.equal(matchRedirect(rules, '/blog/a/b/').to, '/news/a/b/');
  assert.equal(matchRedirect(rules, '/p/42').to, '/products/42');
  assert.equal(matchRedirect(rules, '/gone/').kind, 'gone');
  assert.equal(matchRedirect(rules, '/anything').kind, 'rewrite');
  const vercel = parseRedirects(JSON.stringify({ redirects: [{ source: '/docs/:path*', destination: '/guide/:path*', permanent: true }, { source: '/x', destination: '/y', statusCode: 302 }] }), 'vercel.json');
  assert.equal(matchRedirect(vercel, '/docs/a/b').to, '/guide/a/b');
  assert.equal(matchRedirect(vercel, '/docs').to, '/guide/');
  assert.equal(matchRedirect(vercel, '/x').status, 302);
  const toml = parseRedirects('[build]\ncommand = "x"\n[[redirects]]\nfrom = "/a"\nto = "/b"\nstatus = 301\n', 'netlify.toml');
  assert.equal(matchRedirect(toml, '/a/').to, '/b');
  const csv = parseRedirects('old_url,new_url,status\nhttps://www.example.com/c/,/d/,301\n', 'map.csv');
  assert.equal(matchRedirect(csv, '/c/').to, '/d/');
  assert.equal(matchRedirect(rules.slice(0, 1), '/elsewhere/'), null);
  const headers = parseHeaderRules('/private/*\n  X-Robots-Tag: noindex\n/*\n  Cache-Control: max-age=0\n');
  assert.ok(headers[0].re.test('/private/a'));
  assert.equal(headers[0].headers['x-robots-tag'], 'noindex');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'retired.txt'), '# batch\n/a/\nhttps://www.example.com/b.html\nc\n');
  assert.deepEqual([...loadRetired(path.join(dir, 'retired.txt'))].sort(), ['/a', '/b', '/c']);
  fs.writeFileSync(path.join(dir, 'retired.csv'), 'url,reason\n/x/,merged\n');
  assert.deepEqual([...loadRetired(path.join(dir, 'retired.csv'))], ['/x']);
  for (const rule of ['new-noindex', 'canonical-retargeted', 'page-removed', 'sitemap-dropped', 'protected-file-changed', 'faq-not-visible', 'robots-disallow-added']) assert.ok(BLOCK_RULES[rule]);
});

test('seo-diff: page facts (URL mapping, normalization, visible FAQ, body text, signature)', () => {
  assert.equal(fileToUrlPath('index.html'), '/');
  assert.equal(fileToUrlPath('guides/a/index.html'), '/guides/a/');
  assert.equal(fileToUrlPath('guides/a.html'), '/guides/a.html');
  assert.equal(fileToUrlPath('guides/a.html', { cleanUrls: true }), '/guides/a');
  for (const k of ['/x.html', '/x', '/x/', '/x/index.html', '/X/']) assert.equal(normKey(k), '/x');
  assert.equal(strictKey('/X/'), '/X');
  assert.equal(fileToUrlPath('a?b.html'), '/a%3Fb.html');
  const sub = writeSite(tmpDir(), { 'index.html': mini('/repo/'), 'a/index.html': mini('/repo/a/'), 'b/index.html': mini('/repo/b/'), 'c/index.html': mini('/repo/c/') });
  assert.equal(guessDirPrefix(sub), '/repo');
  const lang = writeSite(tmpDir(), { 'index.html': mini('/en/'), 'en/index.html': mini('/en/'), 'en/a/index.html': mini('/en/a/'), 'en/b/index.html': mini('/en/b/') });
  assert.equal(guessDirPrefix(lang), '', 'a language home page is not a base path');
  assert.equal(pathKey('https://www.example.com/a/?q=1#f'), '/a/?q=1');
  assert.equal(stripCacheParams('https://www.example.com/a/?v=3&utm_source=x&page=2#top'), 'https://www.example.com/a/?page=2');
  const faqHeading = scanBody('<body><nav>Menu</nav><main><h1>Guide</h1><p>Intro.</p><h2>FAQ</h2><h3>What grind?</h3><p>Medium.</p><h3>How hot?</h3><p>93C.</p><h2>Next</h2><h3>Other</h3></main><footer><h3>Contact</h3></footer></body>');
  assert.equal(faqHeading.faq.count, 2);
  assert.ok(!faqHeading.text.includes('Menu') && !faqHeading.text.includes('Contact') && faqHeading.text.includes('Intro.'));
  assert.equal(scanBody('<section class="faq"><h2>常見問題</h2><details><summary>水溫幾度？</summary>九十三度</details><details><summary>比例多少？</summary>一比十六</details></section>').faq.count, 2);
  assert.equal(scanBody('<main><h2>Questions and answers</h2><dl><dt>One?<dd>A<dt>Two?<dd>B</dl></main>').faq.count, 2);
  assert.equal(scanBody('<main><article><header><h1>Title</h1></header><p>Body</p></article></main>').text, 'Title\nBody');
  assert.equal(scanBody('<main><h2>About</h2><h3>Not a question</h3></main>').faq.detected, false);
  const qs = ['How hot?', 'How long?', 'How fine?'];
  const layouts = {
    wpBody: `<body class="page-template-faq"><main><h1>Brewing FAQ</h1><p>Intro.</p><h2>Water</h2><h3>${qs[0]}</h3><p>A</p><h3>${qs[1]}</h3><p>A</p><h2>Time</h2><h3>${qs[2]}</h3><p>A</p></main></body>`,
    cta: `<main><h2>FAQ</h2>${qs.map((q) => `<h3>${q}</h3><p>A.</p>`).join('')}<div class="cta"><h3>Ready to brew?</h3></div></main>`,
    idFaq: `<main><h2 id="faq-brewing">Brewing questions</h2>${qs.map((q) => `<h3>${q}</h3><p>A.</p>`).join('')}</main>`,
    answerH4: `<main><div class="faq-list">${qs.map((q) => `<div class="faq-item"><h3>${q}</h3><div class="faq-answer"><h4>Tip</h4><p>A.</p></div></div>`).join('')}</div></main>`,
  };
  for (const [name, html] of Object.entries(layouts)) assert.equal(scanBody(html).faq.count, 3, name);
  assert.equal(scanBody(layouts.answerH4).faq.structural, false, 'a count from headings only is flagged as a heuristic');
  const html = (body) => `<html><head><title>T</title><link rel="canonical" href="/a/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Is it shown?","acceptedAnswer":{"@type":"Answer","text":"Yes."}}]}</script></head><body><header><a href="/">Home</a></header><main>${body}<img src="/i.png?v=2" alt="pic"></main></body></html>`;
  const a = extractFacts(html('<h2>FAQ</h2><h3>Is it shown?</h3><p>Yes.</p>'), `${O}/a/`);
  assert.equal(a.canonical, `${O}/a/`);
  assert.deepEqual(a.faq.notVisible, []);
  assert.equal(a.faq.visible.count, 1);
  assert.deepEqual(a.images, [`${O}/i.png pic`]);
  const b = extractFacts(html('<p>No FAQ here.</p>'), `${O}/a/`);
  assert.deepEqual(b.faq.notVisible, ['Is it shown?']);
  assert.notEqual(a.signature, b.signature);
  assert.equal(contentSignature(a), a.signature);
  const nav = extractFacts(html('<h2>FAQ</h2><h3>Is it shown?</h3><p>Yes.</p>').replace('<a href="/">Home</a>', '<a href="/">Start</a>'), `${O}/a/`);
  assert.equal(nav.signature, a.signature, 'site header/nav changes do not move the content signature');
});

test('seo-diff: fixtures trip every BLOCK rule; a .html normalization is not a removal', async () => {
  const out = tmpDir();
  const r = await runScript('seo-diff.mjs', [...FIXTURE_ARGS, '--out', out]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /Gate: FAILED/);
  const rows = changes(outputs(out, '-changes.csv'));
  for (const [rule, url] of [
    ['new-noindex', '/guides/french-press/'],
    ['canonical-retargeted', '/guides/aeropress/'],
    ['page-removed', '/guides/moka-pot/'],
    ['sitemap-dropped', '/guides/brew-ratio/'],
    ['sitemap-count-drop', '/'],
    ['protected-file-changed', '/about/'],
    ['protected-page-changed', '/guides/pour-over/'],
    ['jsonld-removed', '/guides/decaf/'],
    ['jsonld-parse-error', '/guides/grinders/'],
    ['faq-not-visible', '/guides/kettles/'],
    ['faq-count-mismatch', '/guides/syphon/'],
    ['date-regressed', '/guides/water/'],
    ['date-regressed', '/guides/scales/'],
    ['title-empty', '/guides/filters/'],
    ['hreflang-reciprocity', '/guides/pour-over/'],
    ['robots-disallow-added', '/guides/private-notes/'],
  ]) assert.ok(has(rows, 'block', rule, url), `missing BLOCK ${rule} ${url}`);
  for (const rule of Object.keys(BLOCK_RULES)) assert.ok(rows.some((x) => x.rule === rule && x.severity === 'block'), `BLOCK rule never fired: ${rule}`);
  // the incident: /guides/cold-brew.html -> /guides/cold-brew/ is a normalization, never a removal or a sitemap drop
  assert.ok(!rows.some((x) => x.url.includes('cold-brew') && (x.severity === 'block' || x.rule === 'page-removed')));
  assert.ok(has(rows, 'info', 'url-normalized', '/guides/cold-brew.html'));
  assert.ok(has(rows, 'info', 'redirected', '/guides/old-grinder/'));
  assert.ok(has(rows, 'info', 'retired', '/guides/instant/'));
  assert.ok(has(rows, 'warn', 'redirect-target-missing', '/guides/percolator/'));
  assert.ok(rows.find((x) => x.rule === 'page-removed').detail.includes('SPA rewrite'), 'a catch-all rewrite is a soft 404, not coverage');
  // warnings
  for (const [rule, url] of [
    ['faq-count-off-by-one', '/guides/milk/'],
    ['body-shrank', '/guides/espresso/'],
    ['lastmod-without-content-change', '/guides/storage/'],
    ['inlinks-halved', '/guides/pour-over/'],
    ['hreflang-changed', '/en/guides/pour-over/'],
    ['title-changed', '/guides/tea/'],
    ['title-ledger-stale', '/guides/tea/'],
  ]) assert.ok(has(rows, 'warn', rule, url), `missing WARN ${rule} ${url}`);
  for (const rule of ['title-suffix-added', 'title-ledger-new-contains-old', 'title-ledger-shared-old-title']) assert.ok(has(rows, 'warn', rule), `missing WARN ${rule}`);
  assert.match(rows.find((x) => x.rule === 'title-suffix-added').detail, /5 of 21 titles/);
  assert.match(rows.find((x) => x.rule === 'inlinks-halved').detail, /protected page/);
  assert.ok(!rows.some((x) => x.rule === 'title-changed' && x.url.endsWith('/guides/milk/')), 'suffix pages are reported once, by title-suffix-added');
  // outputs
  const report = JSON.parse(fs.readFileSync(outputs(out, '-seo-diff.json'), 'utf8'));
  assert.equal(report.meta.gate, 'fail');
  assert.equal(report.counts.block, rows.filter((x) => x.severity === 'block').length);
  assert.deepEqual(report.urls.normalized, [['/guides/cold-brew.html', '/guides/cold-brew/']]);
  const changed = fs.readFileSync(outputs(out, '-changed-urls.txt'), 'utf8').trim().split('\n');
  for (const u of ['/guides/french-press/', '/guides/moka-pot/', '/guides/syphon/', '/guides/cold-brew/']) assert.ok(changed.includes(`${O}${u}`), `changed-urls lacks ${u}`);
  assert.ok(!changed.includes(`${O}/guides/storage/`), 'unchanged page not in changed-urls');
  const ledger = csvToRecords(fs.readFileSync(outputs(out, '-title-ledger.csv'), 'utf8')).records;
  const tea = ledger.find((x) => x.url === `${O}/guides/tea/`);
  assert.equal(tea.stale_files, '3');
  assert.match(tea.stale_examples, /llms\.txt/);
  assert.equal(ledger.find((x) => x.url === `${O}/guides/roast/`).shared_old_title, 'yes');
  const md = fs.readFileSync(outputs(out, '-seo-diff.md'), 'utf8');
  assert.ok(md.includes('## Blocking') && md.includes('## Lost internal links to protected pages') && md.includes('## Title ledger'));
});

test('seo-diff: workspace config (protect, inventory, guardrails), --allow and --record-allowed', async () => {
  const ws = makeWorkspace();
  editConfig(ws, (c) => {
    c.protect = { paths: ['about/index.html'], urls: [] };
    c.guardrails = [{ query: 'pour over', page: `${O}/guides/pour-over/` }];
  });
  fs.writeFileSync(path.join(ws, 'content-inventory.csv'), `url,title,protected\n${O}/guides/pour-over/,Pour over guide,yes\n${O}/guides/tea/,Tea,\n`);
  const r = await runScript('seo-diff.mjs', ['--workspace', ws, '--before', BEFORE, '--after', AFTER, '--retired', path.join(F, 'retired.txt'), '--allow', 'new-noindex=French press guide leaves the index on purpose', '--record-allowed']);
  assert.equal(r.status, 2, r.stderr);
  const rows = changes(dataFile(ws, 'diff', /-seo-diff-changes\.csv$/));
  assert.ok(has(rows, 'allowed', 'new-noindex', '/guides/french-press/'));
  assert.match(rows.find((x) => x.rule === 'new-noindex').detail, /allowed: French press guide leaves the index on purpose/);
  assert.ok(has(rows, 'block', 'protected-page-changed', '/guides/pour-over/'), 'content-inventory protected=yes');
  assert.ok(has(rows, 'block', 'protected-file-changed', '/about/'), 'config protect.paths');
  assert.ok(dataFile(ws, 'diff', /-seo-diff\.json$/) && dataFile(ws, 'diff', /-changed-urls\.txt$/) && dataFile(ws, 'diff', /-title-ledger\.csv$/));
  assert.ok(fs.readdirSync(path.join(ws, 'logs', 'reviews')).some((f) => f.endsWith('-seo-diff.md')));
  const log = fs.readFileSync(path.join(ws, 'logs', 'changes.md'), 'utf8');
  assert.match(log, /seo-diff allowed changes/);
  assert.match(log, /Allowed new-noindex \(1 item\(s\)\): French press guide leaves the index on purpose/);
});

test('seo-diff: exit codes, --allow downgrade and --fail-on warn on a small site', async () => {
  const base = tmpDir();
  const before = writeSite(path.join(base, 'before'), { 'index.html': mini('/', { title: 'Home' }), 'a/index.html': mini('/a/', { title: 'Grind size guide' }), 'b/index.html': mini('/b/', { title: 'Water guide' }), _redirects: '/old-a/ /a/ 301\n' });
  const same = writeSite(path.join(base, 'same'), { 'index.html': mini('/', { title: 'Home' }), 'a/index.html': mini('/a/', { title: 'Grind size guide' }), 'b/index.html': mini('/b/', { title: 'Water guide' }) });
  const noindex = writeSite(path.join(base, 'noindex'), { 'index.html': mini('/', { title: 'Home' }), 'a/index.html': mini('/a/', { title: 'Grind size guide', robots: 'noindex' }), 'b/index.html': mini('/b/', { title: 'Water guide' }) });
  const retitled = writeSite(path.join(base, 'retitled'), { 'index.html': mini('/', { title: 'Home' }), 'a/index.html': mini('/a/', { title: 'Burr settings explained' }), 'b/index.html': mini('/b/', { title: 'Water guide' }) });
  const clean = writeSite(path.join(base, 'clean'), { 'index.html': mini('/', { title: 'Home' }), 'a.html': mini('/a', { title: 'Grind size guide' }), 'b.html': mini('/b', { title: 'Water guide' }) });
  const run = (after, extra = []) => runScript('seo-diff.mjs', ['--before', before, '--after', after, '--out', path.join(base, 'out'), ...extra]);
  let r = await run(same);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BLOCK 0 {2}WARN 1/);
  assert.ok(changes(outputs(path.join(base, 'out'), '-changes.csv')).some((x) => x.rule === 'redirect-removed' && x.url === `${O}/old-a/`), 'a redirect that disappeared is reported');
  fs.writeFileSync(path.join(same, '_redirects'), '/old-a/ /a/ 301\n');
  r = await run(same);
  assert.match(r.stdout, /BLOCK 0 {2}WARN 0/);
  r = await run(noindex);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCK new-noindex/);
  r = await run(noindex, ['--allow', 'new-noindex=moving thin pages out of the index']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ALLOWED 1/);
  r = await run(retitled);
  assert.equal(r.status, 0, 'a substantial title change only warns');
  r = await run(retitled, ['--fail-on', 'warn']);
  assert.equal(r.status, 2);
  r = await run(clean, ['--clean-urls']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /2 normalized/);
  r = await run(clean);
  assert.equal(r.status, 0, 'a.html vs a/ is still a normalization without --clean-urls');
  r = await run(same, ['--allow', 'no-such-rule=x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown rule "no-such-rule"/);
  r = await run(same, ['--allow', 'new-noindex']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs <rule>=<reason>/);
});

test('seo-diff: errors are actionable', () => {
  let r = runScriptSync('seo-diff.mjs', ['--after', AFTER]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--before is required/);
  r = runScriptSync('seo-diff.mjs', ['--before', path.join(tmpDir(), 'missing'), '--after', AFTER, '--out', tmpDir()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--before directory not found/);
  r = runScriptSync('seo-diff.mjs', ['--before', BEFORE, '--after', 'git:HEAD:dist']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only supported for --before/);
});

test('seo-diff: live before side from a local server (sitemap read from the live origin, never the production host)', async () => {
  const srv = await startServer({ rootDir: BEFORE });
  try {
    const out = tmpDir();
    const r = await runScript('seo-diff.mjs', [...FIXTURE_ARGS.map((a) => (a === BEFORE ? srv.origin : a)), '--out', out, '--delay', '0']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout, /\(26 pages\)/);
    const rows = changes(outputs(out, '-changes.csv'));
    for (const [rule, url] of [['page-removed', '/guides/moka-pot/'], ['new-noindex', '/guides/french-press/'], ['sitemap-dropped', '/guides/brew-ratio/'], ['robots-disallow-added', '/guides/private-notes/'], ['protected-page-changed', '/about/']]) assert.ok(has(rows, 'block', rule, url), `live: missing ${rule}`);
    assert.ok(has(rows, 'info', 'url-normalized', '/guides/cold-brew.html'));
    assert.ok(!rows.some((x) => x.url.includes('127.0.0.1')), 'reports use the production origin');
  } finally {
    await srv.close();
  }
});

test('seo-diff: --before git:<ref>:<dir> exports the committed build', async () => {
  if (spawnSync('git', ['--version']).status !== 0 || spawnSync('tar', ['--version']).status !== 0) return;
  const repo = tmpDir('seo-git-');
  const git = (...a) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  writeSite(path.join(repo, 'site'), { 'index.html': mini('/', { title: 'Home' }), 'a/index.html': mini('/a/', { title: 'Grind size guide' }) });
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('commit', '-q', '-m', 'site').status, 0);
  fs.writeFileSync(path.join(repo, 'site', 'a', 'index.html'), mini('/a/', { title: 'Grind size guide', robots: 'noindex' }));
  const r = await runScript('seo-diff.mjs', ['--before', 'git:HEAD:site', '--after', 'site', '--out', path.join(repo, 'out')], { cwd: repo });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /BLOCK new-noindex/);
  const bad = await runScript('seo-diff.mjs', ['--before', 'git:no-such-ref:site', '--after', 'site', '--out', path.join(repo, 'out')], { cwd: repo });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /git archive no-such-ref/);
});

// ---------- regressions from review: each scenario is a tiny before/after pair ----------
const page2 = (key, { title = 'Guide', head = '', body = '<p>Steady pours give an even extraction and a sweet cup.</p>', prefix = '' } = {}) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><link rel="canonical" href="${O}${prefix}${key}">${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const ldTag = (o) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...o })}</script>`;
const smap = (keys, lastmod = '') => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${keys.map((k) => `<url><loc>${O}${k}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`).join('')}</urlset>`;
async function gate(beforeFiles, afterFiles, args = [], { before, after } = {}) {
  const base = tmpDir();
  const b = before || writeSite(path.join(base, 'b'), beforeFiles);
  const a = after || writeSite(path.join(base, 'a'), afterFiles);
  const r = await runScript('seo-diff.mjs', ['--before', b, '--after', a, '--out', path.join(base, 'out'), '--delay', '0', ...args]);
  const csv = fs.existsSync(path.join(base, 'out')) ? outputs(path.join(base, 'out'), '-changes.csv') : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, rows: csv ? changes(csv) : [] };
}
const rule = (rows, severity, name, url = '') => rows.find((x) => x.severity === severity && x.rule === name && (!url || x.url === `${O}${url}`));

test('seo-diff: redirect coverage (re-spelling rules, catch-alls, case-only changes)', async () => {
  // a normalization rule (/:slug/ -> /:slug) must not count as cover for a deleted page or a sitemap drop
  let g = await gate(
    { 'index.html': page2('/'), 'about/index.html': page2('/about/', { title: 'About' }), 'team/index.html': page2('/team/', { title: 'Team' }), 'sitemap.xml': smap(['/', '/about/', '/team/']) },
    { 'index.html': page2('/'), 'team/index.html': page2('/team/', { title: 'Team' }), 'sitemap.xml': smap(['/']), _redirects: '/:slug.html /:slug 301\n/:slug/ /:slug 301\n' },
  );
  assert.equal(g.status, 2, g.stdout);
  assert.match(rule(g.rows, 'block', 'page-removed', '/about/').detail, /only re-spells the same URL/);
  assert.ok(rule(g.rows, 'block', 'sitemap-dropped', '/team/'));
  // a catch-all to the home page or an SPA section fallback is a soft 404, not cover
  g = await gate(
    { 'index.html': page2('/'), 'a/index.html': page2('/a/', { title: 'A' }), 'docs/x/index.html': page2('/docs/x/', { title: 'X' }) },
    { 'index.html': page2('/'), _redirects: '/docs/* /docs/index.html 200\n/* / 301\n' },
  );
  assert.match(rule(g.rows, 'block', 'page-removed', '/a/').detail, /home page/);
  assert.match(rule(g.rows, 'block', 'page-removed', '/docs/x/').detail, /catch-all\/SPA rewrite/);
  // a wildcard redirect to one fixed page covers, with a warning
  g = await gate({ 'index.html': page2('/'), 'old/a/index.html': page2('/old/a/', { title: 'Old A' }), 'hub/index.html': page2('/hub/', { title: 'Hub' }) }, { 'index.html': page2('/'), 'hub/index.html': page2('/hub/', { title: 'Hub' }), _redirects: '/old/* /hub/ 301\n' });
  assert.equal(g.status, 0, g.stdout);
  assert.ok(rule(g.rows, 'warn', 'redirect-catch-all', '/old/a/'));
  // case-only change: normalized (never "removed") but warned, unless a redirect covers the old spelling
  g = await gate({ 'index.html': page2('/'), 'Guides/Pour/index.html': page2('/Guides/Pour/', { title: 'Pour' }) }, { 'index.html': page2('/'), 'guides/pour/index.html': page2('/guides/pour/', { title: 'Pour' }) });
  assert.equal(g.status, 0, g.stdout);
  assert.ok(rule(g.rows, 'info', 'url-normalized', '/Guides/Pour/'));
  assert.ok(rule(g.rows, 'warn', 'url-case-changed', '/Guides/Pour/'));
  g = await gate({ 'index.html': page2('/'), 'Guides/Pour/index.html': page2('/Guides/Pour/', { title: 'Pour' }) }, { 'index.html': page2('/'), 'guides/pour/index.html': page2('/guides/pour/', { title: 'Pour' }), _redirects: '/Guides/Pour/ /guides/pour/ 301\n' });
  assert.ok(!rule(g.rows, 'warn', 'url-case-changed'));
  // --retired takes the first word of a line
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'retired.txt'), '/a/ merged into /hub/\n');
  assert.deepEqual([...loadRetired(path.join(dir, 'retired.txt'))], ['/a']);
});

test('seo-diff: live after side follows redirects within the site only and checks where they end', async () => {
  let otherHits = 0;
  const other = await startServer({ routes: { '/x/': () => { otherHits++; return { status: 200, body: '<html><head><title>Other</title></head><body>other</body></html>' }; } } });
  const live = await startServer({
    routes: {
      '/': { status: 200, body: page2('/') },
      '/old/': { status: 301, headers: { location: '/gone/' }, body: '' },
      '/moved/': { status: 301, headers: { location: `${other.origin}/x/` }, body: '' },
      '/b.html': { status: 301, headers: { location: '/b' }, body: '' },
      '/b': { status: 200, body: page2('/b', { title: 'B', head: '<meta name="robots" content="noindex">' }) },
    },
  });
  try {
    const base = tmpDir();
    const before = writeSite(path.join(base, 'b'), { 'index.html': page2('/'), 'old/index.html': page2('/old/', { title: 'Old' }), 'moved/index.html': page2('/moved/', { title: 'Moved' }), 'b.html': page2('/b', { title: 'B' }) });
    const g = await gate(null, null, ['--base-url', O], { before, after: live.origin });
    assert.match(rule(g.rows, 'block', 'page-removed', '/old/').detail, /ends at HTTP 404/);
    assert.match(rule(g.rows, 'info', 'redirected', '/moved/').detail, /another host: not checked/);
    assert.equal(otherHits, 0, 'never fetches a host the user did not name');
    assert.ok(rule(g.rows, 'block', 'new-noindex', '/b'), 'the page behind a same-site .html redirect is compared');
  } finally {
    await live.close();
    await other.close();
  }
});

test('seo-diff: FAQ, dates, e-mail obfuscation and sitemap entries from real templates', async () => {
  const faqGraph = (qs) => ldTag({ '@graph': [{ '@type': 'FAQPage', '@id': `${O}/f/#faq`, mainEntity: qs.map((q, i) => ({ '@id': `${O}/f/#q${i}` })) }, ...qs.map((q, i) => ({ '@type': 'Question', '@id': `${O}/f/#q${i}`, name: q, acceptedAnswer: { '@type': 'Answer', text: 'Yes.' } }))] });
  const faqBody = '<section class="faq"><h2>FAQ</h2><details><summary>Is it visible?</summary>Yes.</details></section>';
  // Yoast-style @id references are resolved: a hidden question is caught
  let g = await gate({ 'index.html': page2('/'), 'f/index.html': page2('/f/', { head: faqGraph(['Is it visible?']), body: faqBody }) }, { 'index.html': page2('/'), 'f/index.html': page2('/f/', { head: faqGraph(['Is it visible?', 'Hidden question?']), body: faqBody }) });
  assert.match(rule(g.rows, 'block', 'faq-not-visible', '/f/').detail, /Hidden question/);
  // new pages: body-less HTML, entity-encoded names and an FAQ followed by a "related" section are all read correctly
  const bodyless = `<!doctype html><html><head><title>No body</title><link rel="canonical" href="${O}/nb/">${ldTag({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'What&#8217;s the best grind &amp; ratio?', acceptedAnswer: { '@type': 'Answer', text: 'Medium.' } }] })}</head><h1>No body</h1><h2>FAQ</h2><h3>What’s the best grind &amp; ratio?</h3><p>Medium.</p>`;
  const related = page2('/rel/', { head: ldTag({ '@type': 'FAQPage', mainEntity: ['One?', 'Two?'].map((q) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: 'A.' } })) }), body: '<section><h2>FAQ</h2><h3>One?</h3><p>A.</p><h3>Two?</h3><p>A.</p></section><section><h3>Related article one</h3><h3>Related article two</h3></section>' });
  g = await gate({ 'index.html': page2('/') }, { 'index.html': page2('/'), 'nb/index.html': bodyless, 'rel/index.html': related });
  assert.ok(!g.rows.some((x) => ['faq-not-visible', 'faq-count-mismatch', 'h1-changed'].includes(x.rule)), JSON.stringify(g.rows.filter((x) => x.severity !== 'info')));
  // dates come from the page's own entity, not from list items; CDN e-mail obfuscation is not a body change
  const list = (dates) => page2('/list/', { head: ldTag({ '@type': 'CollectionPage', url: `${O}/list/`, mainEntity: { '@type': 'ItemList', itemListElement: dates.map((d, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'BlogPosting', headline: `Post ${i}`, dateModified: d } })) } }) });
  g = await gate(
    { 'index.html': page2('/'), 'list/index.html': list(['2026-10-05', '2026-09-01']), 'contact/index.html': page2('/contact/', { body: '<p>Write to hello@example.com any time.</p>' }) },
    { 'index.html': page2('/'), 'list/index.html': list(['2026-09-01', '2026-10-05']), 'contact/index.html': page2('/contact/', { body: '<p>Write to <a href="/cdn-cgi/l/email-protection">[email&#160;protected]</a> any time.</p>' }) },
    ['--protect-url', '/contact/'],
  );
  assert.ok(!rule(g.rows, 'block', 'date-regressed'), 'list item order is not a date regression');
  assert.ok(!rule(g.rows, 'block', 'protected-page-changed'), 'e-mail obfuscation is masked');
  // a date-only bump (JSON-LD dateModified mirrors lastmod) is not a content change
  const art = (d) => page2('/p/', { head: ldTag({ '@type': 'Article', headline: 'P', dateModified: d }) });
  g = await gate({ 'index.html': page2('/'), 'p/index.html': art('2026-10-01'), 'sitemap.xml': smap(['/', '/p/'], '2026-10-01') }, { 'index.html': page2('/'), 'p/index.html': art('2026-10-20'), 'sitemap.xml': smap(['/', '/p/'], '2026-10-20') });
  assert.ok(rule(g.rows, 'warn', 'lastmod-without-content-change', '/p/'));
  // new sitemap URLs must be indexable self-canonical pages in their canonical spelling
  g = await gate(
    { 'index.html': page2('/'), 'sitemap.xml': smap(['/']) },
    { 'index.html': page2('/'), 'new/index.html': page2('/new/'), 'ni/index.html': page2('/ni/', { head: '<meta name="robots" content="noindex">' }), 'sitemap.xml': smap(['/', '/new.html', '/ni/', '/missing/']) },
  );
  for (const k of ['/new.html', '/ni/', '/missing/']) assert.ok(rule(g.rows, 'warn', 'sitemap-entry-invalid', k), `sitemap entry ${k}`);
  // an x-default pointing at a language selector without return links only warns
  const hl = (key, self) => `<link rel="alternate" hreflang="${self}" href="${O}${key}"><link rel="alternate" hreflang="${self === 'en' ? 'fr' : 'en'}" href="${O}${self === 'en' ? '/fr/' : '/en/'}"><link rel="alternate" hreflang="x-default" href="${O}/choose/">`;
  g = await gate({ 'index.html': page2('/') }, { 'index.html': page2('/'), 'en/index.html': page2('/en/', { head: hl('/en/', 'en') }), 'fr/index.html': page2('/fr/', { head: hl('/fr/', 'fr') }), 'choose/index.html': page2('/choose/') });
  assert.ok(rule(g.rows, 'warn', 'hreflang-reciprocity', '/en/'));
  assert.ok(!rule(g.rows, 'block', 'hreflang-reciprocity'));
});

test('seo-diff: sub-path builds, preview hosts and conditional header rules', async () => {
  // a build served under /docs/: --base-url carries the path
  const P = '/docs';
  let g = await gate(
    { 'index.html': page2('/', { prefix: P }), 'a/index.html': page2('/a/', { prefix: P, title: 'A' }), 'b/index.html': page2('/b/', { prefix: P, title: 'B' }) },
    { 'index.html': page2('/', { prefix: P }), 'a/index.html': page2('/a/', { prefix: P, title: 'A', head: '<meta name="robots" content="noindex">' }), 'b/index.html': page2('/b/', { prefix: P, title: 'B' }) },
    ['--base-url', `${O}/docs/`],
  );
  assert.ok(rule(g.rows, 'block', 'new-noindex', '/docs/a/'), JSON.stringify(g.rows));
  assert.ok(!g.rows.some((x) => x.rule === 'canonical-retargeted' || x.rule === 'page-removed'));
  // vercel.json header rules limited by has/missing do not apply to every request
  g = await gate({ 'index.html': page2('/'), 'a/index.html': page2('/a/', { title: 'A' }) }, { 'index.html': page2('/'), 'a/index.html': page2('/a/', { title: 'A' }), 'vercel.json': JSON.stringify({ headers: [{ source: '/(.*)', has: [{ type: 'host', value: 'staging.example.com' }], headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] }] }) });
  assert.equal(g.status, 0, JSON.stringify(g.rows));
  // _headers without conditions does count
  g = await gate({ 'index.html': page2('/'), 'a/index.html': page2('/a/', { title: 'A' }) }, { 'index.html': page2('/'), 'a/index.html': page2('/a/', { title: 'A' }), _headers: '/a/*\n  X-Robots-Tag: noindex\n' });
  assert.match(rule(g.rows, 'block', 'new-noindex', '/a/').detail, /X-Robots-Tag/);
  // a preview host sends X-Robots-Tag: noindex everywhere: ignored, but meta robots noindex still blocks
  const preview = await startServer({
    routes: {
      '/': { status: 200, headers: { 'x-robots-tag': 'noindex' }, body: page2('/') },
      '/a/': { status: 200, headers: { 'x-robots-tag': 'noindex' }, body: page2('/a/', { title: 'A' }) },
      '/b/': { status: 200, headers: { 'x-robots-tag': 'noindex' }, body: page2('/b/', { title: 'B', head: '<meta name="robots" content="noindex">' }) },
    },
  });
  try {
    const base = tmpDir();
    const before = writeSite(path.join(base, 'b'), { 'index.html': page2('/'), 'a/index.html': page2('/a/', { title: 'A' }), 'b/index.html': page2('/b/', { title: 'B' }) });
    g = await gate(null, null, [], { before, after: preview.origin });
    assert.ok(rule(g.rows, 'info', 'preview-noindex-ignored'));
    assert.ok(!rule(g.rows, 'block', 'new-noindex', '/a/'));
    assert.ok(rule(g.rows, 'block', 'new-noindex', '/b/'));
  } finally {
    await preview.close();
  }
});

test('seo-diff: an explicit rewrite route (edge worker / SPA language prefix) warns; a catch-all rewrite still blocks', () => {
  const root = tmpDir();
  const before = writeSite(path.join(root, 'before'), { 'index.html': mini('/', { title: 'Home' }), 'en/index.html': mini('/en/', { title: 'English home' }), 'gone/index.html': mini('/gone/', { title: 'Gone' }) });
  const after = writeSite(path.join(root, 'after'), { 'index.html': mini('/', { title: 'Home' }), _redirects: '/en /index.html 200\n/* /index.html 200\n' });
  const out = path.join(root, 'out');
  const r = runScriptSync('seo-diff.mjs', ['--before', before, '--after', after, '--base-url', O, '--out', out]);
  assert.equal(r.status, 2, 'the catch-all-only page still trips the gate');
  const rows = changes(outputs(out, '-changes.csv'));
  assert.ok(has(rows, 'warn', 'rewrite-to-index', '/en/'), 'explicit route: verify on a preview');
  assert.ok(!has(rows, 'block', 'page-removed', '/en/'));
  assert.ok(has(rows, 'block', 'page-removed', '/gone/'), 'a wildcard SPA fallback is a soft 404, not a cover');
});
