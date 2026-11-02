import fs from 'node:fs';
import path from 'node:path';
import { test, assert, makeWorkspace, runScript, startServer, editConfig, dataFile } from './harness.mjs';
import { csvToRecords } from '../lib/csv.mjs';
import { headDiagnostics, parseHtml } from '../lib/html.mjs';
import { parseRobotsTxt, robotsDecision } from '../lib/http.mjs';
import { beyondFetchLimit, compareUaResponse, challengeSignal, analyzeCrawl, hreflangMistake } from '../crawl-site.mjs';

const page = (title, { head = '', body = '', lang = 'en', canonical } = {}) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title} description for the test page.">${canonical === false ? '' : `<link rel="canonical" href="${canonical || '{{SELF}}'}">`}${head}</head><body><main><h1>${title}</h1><p>${'Useful words about brewing coffee at home with simple tools. '.repeat(12)}</p>${body}</main></body></html>`;

function siteRoutes() {
  const routes = {};
  const add = (p, html, headers = {}) => {
    routes[p] = { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: html.replaceAll('{{SELF}}', `{{ORIGIN}}${p}`) };
  };
  const links = ['/head-div/', '/canon-body/', '/big/', '/hdr-mismatch/', '/relative-canon/', '/en/page/', '/zh/page/', '/to-missing/', '/h1/', '/h2/', '/h3/']
    .map((p) => `<a href="${p}">${p}</a>`).join(' ');
  add('/', page('Home', { body: `<nav><a href="/">Home</a></nav><p>${links}</p><img src="/img/hero.webp" width="1200" height="600" alt="Coffee bar" fetchpriority="high"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","@id":"{{ORIGIN}}/#org","name":"Example","sameAs":["https://www.youtube.com/@example"]}</script>` }));
  add('/head-div/', page('Head div', { canonical: false, head: '<div class="banner"></div><link rel="canonical" href="{{ORIGIN}}/head-div/"><meta name="robots" content="index,follow">' }));
  add('/canon-body/', page('Canonical in body', { canonical: false, body: '<link rel="canonical" href="{{ORIGIN}}/canon-body/">' }));
  add('/big/', page('Big page', { canonical: false, head: `<script>var blob="${'x'.repeat(2200000)}";</script><link rel="canonical" href="{{ORIGIN}}/big/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Big"}</script>` }));
  add('/hdr-mismatch/', page('Header mismatch'), { link: '<{{ORIGIN}}/other-target/>; rel="canonical"' });
  add('/relative-canon/', page('Relative canonical', { canonical: '/relative-canon/' }));
  add('/en/page/', page('English page', { canonical: '{{ORIGIN}}/zh/page/', head: '<link rel="alternate" hreflang="en" href="{{ORIGIN}}/en/page/"><link rel="alternate" hreflang="zh-TW" href="{{ORIGIN}}/zh/page/">' }));
  add('/zh/page/', page('Chinese page', { lang: 'zh-TW', head: '<link rel="alternate" hreflang="en" href="{{ORIGIN}}/en/page/"><link rel="alternate" hreflang="zh-TW" href="{{ORIGIN}}/zh/page/">' }));
  add('/to-missing/', page('Canonical to a missing page', { canonical: '{{ORIGIN}}/gone-target/' }));
  for (const p of ['/h1/', '/h2/', '/h3/']) add(p, page(`Variant ${p}`, { canonical: '{{ORIGIN}}/' }));
  routes['/robots.txt'] = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private/\nDisallow: tmp\nNoindex: /old/\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /en/\n' };
  routes['/img/hero.webp'] = { status: 200, headers: { 'content-type': 'image/webp' }, body: 'RIFF' };
  return routes;
}

test('crawl-site rules pack: 2MB cut, <head> closed early, canonical cross-checks, robots matrix, link/JSON-LD/image outputs', async () => {
  const routes = siteRoutes();
  const home = routes['/'];
  routes['/'] = (req) => {
    const ua = String(req.headers['user-agent'] || '');
    if (/GPTBot/.test(ua)) return { status: 403, body: 'Forbidden' };
    if (/PerplexityBot/.test(ua)) return { status: 503, headers: { 'cf-mitigated': 'challenge' }, body: '<html><head><title>Just a moment...</title></head><body>checking</body></html>' };
    if (/ClaudeBot/.test(ua)) return { status: 200, body: '<html><head><title>Lite</title></head><body>tiny</body></html>' };
    return home;
  };
  const srv = await startServer({ routes });
  try {
    const ws = makeWorkspace();
    editConfig(ws, (c) => {
      c.site.url = `${srv.origin}/`;
    });
    const r = await runScript('crawl-site.mjs', ['--workspace', ws, '--delay', '0', '--no-sitemap', '--compare-ua', '--compare-ua-agents', 'googlebot,gptbot,perplexitybot,claudebot', '--compare-ua-max', '1']);
    assert.equal(r.status, 0, r.stderr);
    const issues = csvToRecords(fs.readFileSync(dataFile(ws, 'crawl', /issues\.csv$/), 'utf8')).records;
    const has = (rule, urlPart = '', severity = '') => issues.some((i) => i.rule === rule && i.url.includes(urlPart) && (!severity || i.severity === severity));
    assert.ok(has('html-over-2mb', '/big/', 'high'), 'canonical and JSON-LD after the 2 MB cut');
    assert.ok(issues.find((i) => i.rule === 'html-over-2mb').detail.includes('canonical'));
    assert.ok(has('head-closed-early', '/head-div/', 'high'));
    assert.ok(has('canonical-in-body', '/canon-body/', 'high'));
    assert.ok(has('canonical-header-mismatch', '/hdr-mismatch/', 'high'));
    assert.ok(has('canonical-relative', '/relative-canon/', 'low'));
    assert.ok(has('canonical-cross-language', '/en/page/', 'high'));
    assert.ok(has('canonical-to-non-200', '/to-missing/', 'high'), 'canonical target outside the crawl is fetched');
    assert.ok(has('canonical-to-home', '/h1/', 'medium'), '3 of 11 pages: reported per page, below the site-wide pattern threshold');
    assert.ok(has('robots-pattern', '/robots.txt', 'medium'));
    assert.ok(has('robots-unknown-directive', '/robots.txt', 'info'));
    assert.ok(issues.some((i) => i.rule === 'robots-blocks-agent' && /PerplexityBot/.test(i.detail) && i.severity === 'medium'));
    assert.ok(issues.some((i) => i.rule === 'robots-blocks-agent' && /GPTBot/.test(i.detail) && i.severity === 'info'));
    assert.ok(issues.some((i) => i.rule === 'ua-blocked' && /perplexitybot: challenge/.test(i.detail) && i.severity === 'high'));
    assert.ok(issues.some((i) => i.rule === 'ua-blocked' && /gptbot: blocked/.test(i.detail) && i.severity === 'info'));
    assert.ok(issues.some((i) => i.rule === 'ua-response-differs' && /claudebot/.test(i.detail)));
    assert.ok(!issues.some((i) => /googlebot:/.test(i.detail)), 'googlebot gets the browser response');
    const ua = csvToRecords(fs.readFileSync(dataFile(ws, 'crawl', /ua-compare\.csv$/), 'utf8')).records;
    assert.equal(ua.find((x) => x.agent === 'perplexitybot').robots.startsWith('allow'), true);
    const robots = csvToRecords(fs.readFileSync(dataFile(ws, 'crawl', /robots\.csv$/), 'utf8')).records;
    assert.match(robots.find((x) => x.url.endsWith('/en/page/')).PerplexityBot, /^BLOCK L\d+ \/en\//);
    const links = fs.readFileSync(dataFile(ws, 'crawl', /links\.jsonl$/), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const homeLinks = links.find((l) => l.url === `${srv.origin}/`);
    assert.ok(homeLinks.links.some((l) => l.boiler && l.internal) && homeLinks.links.some((l) => !l.boiler && l.url.endsWith('/big/')));
    const jsonld = fs.readFileSync(dataFile(ws, 'crawl', /jsonld\.jsonl$/), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const org = jsonld.find((x) => x.blocks.some((b) => b.types.includes('Organization')));
    assert.ok(org.visibleText.includes('Useful words') && org.links.length > 0);
    const images = fs.readFileSync(dataFile(ws, 'crawl', /images\.jsonl$/), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const hero = images.find((x) => x.images.length).images[0];
    assert.deepEqual([hero.width, hero.fetchpriority, hero.alt], ['1200', 'high', 'Coffee bar']);
    const check = await runScript('crawl-site.mjs', ['--workspace', ws, '--robots-check', '/en/page/', '--robots-ua', 'PerplexityBot,Googlebot,Google-Extended']);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /PerplexityBot\s+BLOCK\s+L\d+: Disallow: \/en\//);
    assert.match(check.stdout, /Google-Extended .*control token/);
    assert.match(check.stdout, /lint L3: Line 3: pattern "tmp"/);
  } finally {
    await srv.close();
  }
});

test('crawl-site helpers: head diagnostics, 2MB cut positions, robots deciding line, challenge detection', () => {
  const hd = headDiagnostics('<html><head><title>t</title><img src=x><meta name=robots content=noindex><link rel=canonical href=/a></head><body></body></html>');
  assert.equal(hd.closedEarly.tag, 'img');
  assert.deepEqual(hd.afterClose.map((x) => x.tag), ['robots', 'canonical']);
  assert.deepEqual(headDiagnostics('<!doctype html><html><head><meta charset=utf-8><noscript><img src=p></noscript><link rel=canonical href=/a></head><body><p>x</p></body></html>').noscriptInHead, ['img']);
  const html = `<html><head><link rel="canonical" href="https://e.com/a"></head><body>${'é'.repeat(600)}<a href="/x">x</a><script type="application/ld+json">{"@type":"Thing"}</script></body></html>`;
  const parsed = parseHtml(html, 'https://e.com/a');
  const cut = beyondFetchLimit(html, parsed, 700);
  assert.equal(cut.canonical, 0);
  assert.equal(cut.jsonLd, 1, 'multi-byte characters count as UTF-8 bytes');
  assert.equal(cut.internalLinks, 1);
  const robots = parseRobotsTxt('User-agent: *\nAllow: /a/b\nDisallow: /a/\n');
  const d = robotsDecision(robots, 'Googlebot', '/a/b/c');
  assert.deepEqual([d.allowed, d.rule.line], [true, 2]);
  assert.equal(challengeSignal({ status: 403, headers: {}, body: '<script src="/cdn-cgi/challenge-platform/x.js"></script>' }), 'HTTP 403 with a bot-challenge script');
  assert.equal(challengeSignal({ status: 200, headers: {}, body: '<title>Pour over guide</title><script src="https://www.google.com/recaptcha/api.js"></script>' }), '', 'a normal page with a captcha widget is not a challenge');
  assert.equal(compareUaResponse({ status: 200, finalUrl: 'https://e.com/', bytes: 5000, body: '<title>A</title>' }, { status: 200, finalUrl: 'https://e.com/', bytes: 4900, body: '<title>A</title>' }).verdict, 'ok');
  const rec = (u, canonical) => ({ url: u, finalUrl: u, status: 200, html: true, redirects: 0, canonical, canonicals: [canonical], canonicalStatus: canonical === u ? 'self' : 'other', title: u, metaDescription: 'd', h1Count: 1, lang: 'en', wordEq: 300, links: [] });
  const records = [rec('https://e.com/', 'https://e.com/'), ...['a', 'b', 'c', 'd'].map((x) => rec(`https://e.com/${x}/`, 'https://e.com/'))];
  const { issues } = analyzeCrawl(records, { host: 'e.com' });
  assert.ok(issues.some((i) => i.rule === 'canonical-all-to-home' && i.severity === 'high'), 'template bug: every page canonicalizes to home');
});

test('crawl-site rules: hreflang country-code mistakes, generic anchors and broken in-page links', () => {
  assert.equal(hreflangMistake('jp').severity, 'medium');
  assert.match(hreflangMistake('en-uk').text, /en-GB/);
  assert.equal(hreflangMistake('tw').severity, 'low', 'tw is also the code for Twi');
  assert.equal(hreflangMistake('uk'), null, 'uk alone is Ukrainian');
  assert.equal(hreflangMistake('zh-TW'), null);
  const p = parseHtml('<html><body><main><h2 id="faq">FAQ</h2><a href="#faq">FAQ</a><a href="#missing">x</a><a href="#top">top</a><a href="#">menu</a></main></body></html>', 'https://e.com/');
  assert.deepEqual(p.brokenFragments, ['#missing']);
  const rec = { url: 'https://e.com/a', finalUrl: 'https://e.com/a', status: 200, html: true, redirects: 0, canonical: 'https://e.com/a', canonicals: ['https://e.com/a'], canonicalStatus: 'self', title: 'A page about grinders', metaDescription: 'd', h1Count: 1, lang: 'en', wordEq: 300, brokenFragments: ['#missing'], links: [{ internal: true, target: 'https://e.com/b', text: 'Read more', boiler: false }, { internal: true, target: 'https://e.com/c', text: '點此', boiler: false }, { internal: true, target: 'https://e.com/', text: 'More', boiler: true }] };
  const { issues } = analyzeCrawl([rec], { host: 'e.com' });
  const generic = issues.find((i) => i.rule === 'anchor-generic');
  assert.match(generic.detail, /^2 body link/);
  assert.ok(issues.some((i) => i.rule === 'broken-fragment-link'));
});
