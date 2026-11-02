import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES } from './harness.mjs';
import { parseArgs } from '../lib/args.mjs';
import { addDays, deployWindows, gscDaysForLocalDate, finalDataReadyOn, parseLocalDateTime, formatInTz, resolveRange, weekday } from '../lib/dates.mjs';
import { compactKey, textStats, buildCjkVocabulary, topicTokens, displayWidth, shingleSet, jaccard } from '../lib/text.mjs';
import { parseCsv, toCsv, csvToRecords } from '../lib/csv.mjs';
import { parseHtml } from '../lib/html.mjs';
import { parseMarkdown } from '../lib/markdown.mjs';
import { parseRobotsTxt, robotsAllows, parseSitemap } from '../lib/http.mjs';
import { aggregate, decomposeClicks, expectedCtr, fitCtrCurve, DEFAULT_CTR_CURVE, fixedSetComparison } from '../lib/metrics.mjs';
import { fisherExact, twoProportionZ, wilsonInterval, binomialTwoSided, sameQueryCtr, daysInTop10, diffInDiff, didBinomial, sampleSizePerGroup } from '../lib/stats.mjs';
import { explainGoogleError } from '../lib/google-auth.mjs';
import { validateSiteUrl, buildFilters, re2ToJs, subtractRows } from '../lib/gsc.mjs';
import { parseFilter, normalizePropertyId } from '../lib/ga4.mjs';
import { globToRegExp, normalizeUrl, urlFromTemplate } from '../lib/util.mjs';

test('args: types, lists, --no-, unknown flag suggestion', () => {
  const spec = { days: { type: 'int', default: 28 }, dims: { type: 'csv', default: ['query'] }, tag: { type: 'list' }, dry: { type: 'boolean' }, fix: { type: 'boolean', default: true } };
  const { flags, positionals } = parseArgs(['--days=7', '--dims', 'query,page', '--tag', 'a,b', '--tag', 'c', '--dry', '--no-fix', 'pos'], spec);
  assert.equal(flags.days, 7);
  assert.deepEqual(flags.dims, ['query', 'page']);
  assert.deepEqual(flags.tag, ['a,b', 'c']);
  assert.equal(flags.dry, true);
  assert.equal(flags.fix, false);
  assert.deepEqual(positionals, ['pos']);
  assert.throws(() => parseArgs(['--dayz', '3'], spec), /Unknown option --dayz/);
  assert.throws(() => parseArgs(['--days', 'x'], spec), /integer/);
});

test('dates: deploy in UTC+8 excludes two PT days and builds equal windows', () => {
  assert.deepEqual(gscDaysForLocalDate('2026-10-07', 'Asia/Taipei'), ['2026-10-06', '2026-10-07']);
  const w = deployWindows('2026-10-07', 28, { siteTz: 'Asia/Taipei' });
  assert.deepEqual(w.post, { start: '2026-10-08', end: '2026-11-04', days: 28 });
  assert.deepEqual(w.pre, { start: '2026-09-08', end: '2026-10-05', days: 28 });
  const w10 = deployWindows('2026-10-07', 10, { siteTz: 'Asia/Taipei' });
  assert.equal(weekday(w10.pre.start), weekday(w10.post.start));
  assert.equal(w10.pre.days, 10);
  assert.ok(w10.pre.end < '2026-10-06');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(finalDataReadyOn('2026-11-04', 'Asia/Taipei'), '2026-11-08');
  const t = parseLocalDateTime('2026-10-07 01:30', 'Asia/Taipei');
  assert.equal(formatInTz(t, 'America/Los_Angeles'), '2026-10-06 10:30');
  assert.deepEqual(resolveRange({ days: 7, latestEnd: '2026-10-10' }), { start: '2026-10-04', end: '2026-10-10', days: 7 });
});

test('text: CJK-aware counts, brand keys, vocabulary segmentation', () => {
  assert.equal(compactKey('AI 咖啡！'), 'ai咖啡');
  const s = textStats('Hello world 手沖咖啡');
  assert.equal(s.latinWords, 2);
  assert.equal(s.cjkChars, 4);
  assert.equal(displayWidth('ab咖啡'), 6);
  const qs = ['手沖咖啡比例', '手沖咖啡 教學', '冰滴咖啡比例', '咖啡比例', '手沖咖啡推薦'];
  const vocab = buildCjkVocabulary(qs);
  assert.deepEqual(topicTokens('手沖咖啡比例', { vocab }), ['手沖', '咖啡', '比例']);
  assert.deepEqual(topicTokens('咖啡比例', { vocab }), ['咖啡', '比例']);
  assert.ok(topicTokens('best running shoes 2024').includes('shoe'));
  assert.ok(!topicTokens('best running shoes 2024').includes('2024'));
  assert.ok(jaccard(shingleSet('the quick brown fox jumps over the lazy dog'), shingleSet('the quick brown fox jumps over the lazy cat')) > 0.5);
});

test('csv: round trip with quotes, commas, newlines, CJK and BOM', () => {
  const rows = [{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2', d: '中文' }];
  const text = toCsv(rows);
  const back = csvToRecords(`﻿${text}`);
  assert.deepEqual(back.headers, ['a', 'b', 'c', 'd']);
  assert.deepEqual(back.records[0], rows[0]);
  assert.equal(parseCsv('a,b\r\n1,2\r\n').length, 2);
});

test('html: extracts SEO fields from a fixture page', () => {
  const html = fs.readFileSync(path.join(FIXTURES, 'site', 'guides', 'pour-over', 'index.html'), 'utf8').replaceAll('{{ORIGIN}}', 'https://www.example.com');
  const p = parseHtml(html, 'https://www.example.com/guides/pour-over/');
  assert.equal(p.title, 'Pour over guide | Example');
  assert.equal(p.lang, 'zh-TW');
  assert.equal(p.canonical, 'https://www.example.com/guides/pour-over/');
  assert.equal(p.hreflang.length, 3);
  assert.deepEqual(p.h1, ['Pour over guide']);
  assert.ok(p.jsonLdTypes.includes('FAQPage') && p.jsonLdTypes.includes('Article'));
  assert.equal(p.images.filter((i) => i.alt === null).length, 1);
  assert.ok(p.stats.cjkChars > 40);
  assert.equal(p.dates.modified, '2026-10-02');
  assert.ok(p.links.some((l) => l.url === 'https://www.example.com/blog/best-grinders/'));
  const broken = parseHtml('<html><head><script type="application/ld+json">{bad</script><title>T</title></head><body><svg><title>icon</title></svg><h1>A</h1><h1>B</h1></body></html>');
  assert.equal(broken.title, 'T');
  assert.equal(broken.jsonLdErrors.length, 1);
  assert.equal(broken.h1.length, 2);
});

test('markdown: front matter, headings, links, blocks', () => {
  const m = parseMarkdown('---\ntitle: "T"\nkeywords:\n  - a\n  - b\n---\n# T\n\nIntro [x](/y/).\n\n## Q?\n\nAnswer here.\n');
  assert.equal(m.title, 'T');
  assert.deepEqual(m.frontMatter.keywords, ['a', 'b']);
  assert.equal(m.links[0].href, '/y/');
  assert.deepEqual(m.blocks.map((b) => b.type), ['h', 'p', 'h', 'p']);
});

test('robots: longest match wins, allow wins ties, agent groups', () => {
  const r = parseRobotsTxt('User-agent: *\nDisallow: /private/\nAllow: /private/ok\n\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://e.com/s.xml');
  assert.equal(robotsAllows(r, 'any-bot', '/private/x'), false);
  assert.equal(robotsAllows(r, 'any-bot', '/private/ok/1'), true);
  assert.equal(robotsAllows(r, 'Mozilla/5.0 (compatible; GPTBot/1.0)', '/blog'), false);
  assert.deepEqual(r.sitemaps, ['https://e.com/s.xml']);
});

test('sitemap: urlset with image tags and sitemap index', () => {
  const u = parseSitemap('<urlset><url><image:image><image:loc>https://e.com/i.png</image:loc></image:image><loc>https://e.com/a?x=1&amp;y=2</loc><lastmod>2026-01-01</lastmod></url></urlset>');
  assert.equal(u.type, 'urlset');
  assert.equal(u.entries[0].loc, 'https://e.com/a?x=1&y=2');
  const i = parseSitemap('<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(i.type, 'index');
});

test('metrics: weighted position, decomposition adds up, CTR curves', () => {
  const a = aggregate([{ clicks: 10, impressions: 100, position: 2 }, { clicks: 0, impressions: 300, position: 10 }]);
  assert.equal(a.position, 8);
  const pre = [{ query: 'a', clicks: 30, impressions: 300, position: 5 }, { query: 'b', clicks: 5, impressions: 100, position: 9 }, { query: 'gone', clicks: 4, impressions: 50, position: 8 }];
  const post = [{ query: 'a', clicks: 60, impressions: 400, position: 3 }, { query: 'b', clicks: 2, impressions: 100, position: 9 }, { query: 'new', clicks: 3, impressions: 30, position: 7 }];
  const d = decomposeClicks(pre, post, (r) => r.query, DEFAULT_CTR_CURVE);
  assert.ok(Math.abs(d.total - (65 - 39)) < 1e-9);
  assert.ok(Math.abs(d.impressionEffect + d.positionEffect + d.ctrEffect - d.total) < 1e-9);
  assert.ok(d.positionEffect > 0);
  assert.ok(expectedCtr(1) > expectedCtr(2.5) && expectedCtr(2.5) > expectedCtr(3));
  const rows = [];
  for (let p = 1; p <= 10; p++) rows.push({ query: `q${p}`, clicks: Math.round(1000 * (0.3 / p)), impressions: 1000, position: p });
  const curve = fitCtrCurve(rows);
  for (let i = 1; i < curve.points.length; i++) assert.ok(curve.points[i][1] <= curve.points[i - 1][1] + 1e-12);
  const fs1 = fixedSetComparison([{ query: 'a', page: 'p', clicks: 1, impressions: 50, position: 4 }], [{ query: 'a', page: 'p', clicks: 1, impressions: 50, position: 6 }]);
  assert.equal(fs1.positionDelta, 2);
});

test('stats: Fisher, z, Wilson, binomial, power match known values', () => {
  assert.ok(Math.abs(fisherExact(3, 10, 9, 10) - 0.01977) < 1e-4);
  assert.ok(Math.abs(binomialTwoSided(7, 10, 0.5) - 0.34375) < 1e-6);
  const z = twoProportionZ(12, 240, 30, 250);
  assert.ok(z.z > 2.7 && z.p < 0.01);
  const w = wilsonInterval(12, 240);
  assert.ok(w.low < 0.05 && w.high > 0.05);
  assert.equal(sampleSizePerGroup(0.47, 0.55), 612);
  const did = didBinomial(100, 150, 1000, 1000, 28, 28);
  assert.ok(Math.abs(did.netEffect - 0.5) < 1e-9 && did.pValue < 0.01);
});

test('stats: same-query CTR, days in top 10 with boundary share, DiD permutation', () => {
  const pre = [{ query: 'a', clicks: 10, impressions: 100 }, { query: 'b', clicks: 1, impressions: 100 }, { query: 'small', clicks: 5, impressions: 10 }];
  const post = [{ query: 'a', clicks: 20, impressions: 100 }, { query: 'b', clicks: 1, impressions: 100 }, { query: 'new', clicks: 0, impressions: 900 }];
  const sq = sameQueryCtr(pre, post, { minImpr: 50 });
  assert.equal(sq.queries, 2);
  assert.ok(Math.abs(sq.pre - 0.055) < 1e-12 && Math.abs(sq.post - 0.105) < 1e-12);
  const daily = ['2026-01-01', '2026-01-02', '2026-01-03'].map((d, i) => ({ date: d, query: 'x', clicks: 1, impressions: 10, position: [9, 12, 4][i] }));
  const [t] = daysInTop10(daily, ['x'], { start: '2026-01-01', end: '2026-01-03' });
  assert.equal(t.top10Days, 2);
  assert.ok(Math.abs(t.boundaryShare - 1 / 3) < 1e-12);
  const mk = (start, n, tc, cc) => Array.from({ length: n }, (_, i) => [{ date: addDays(start, i), page: 't', clicks: tc, impressions: 100 }, { date: addDays(start, i), page: 'c', clicks: cc, impressions: 100 }]).flat();
  const r = diffInDiff(mk('2026-01-01', 14, 10, 10), mk('2026-01-15', 14, 20, 10), { start: '2026-01-01', end: '2026-01-14' }, { start: '2026-01-15', end: '2026-01-28' }, (x) => x.page === 't', (x) => x.page === 'c');
  assert.ok(r.netEffect > 0.8);
  assert.match(r.method, /weeks/);
});

test('google errors and validators give actionable hints', () => {
  const h = explainGoogleError('gsc', 403, 'User does not have sufficient permission for site', { siteUrl: 'sc-domain:example.com', clientEmail: 'bot@p.iam.gserviceaccount.com' });
  assert.ok(h.some((x) => /Users and permissions/.test(x) && /bot@p\.iam/.test(x)));
  assert.ok(explainGoogleError('ga4', 403, 'Google Analytics Data API has not been used in project 1 before or it is disabled').some((x) => /Enable the API/.test(x)));
  assert.throws(() => validateSiteUrl('https://example.com'), /must end with/);
  assert.equal(validateSiteUrl('sc-domain:example.com'), 'sc-domain:example.com');
  assert.throws(() => normalizePropertyId('G-ABC123'), /Measurement ID/);
  assert.throws(() => buildFilters({ queryRegex: '(?=x)' }), /RE2/);
  assert.equal(buildFilters({ country: 'TWN', device: 'mobile' })[0].filters.length, 2);
  assert.ok(re2ToJs('(?i)^Coffee$').test('coffee'));
  const sub = subtractRows([{ page: 'p', clicks: 10, impressions: 100, position: 5 }], [{ query: 'x', page: 'p', clicks: 4, impressions: 40, position: 5 }], ['page']);
  assert.deepEqual([sub[0].clicks, sub[0].impressions], [6, 60]);
  const f = parseFilter('sessionDefaultChannelGroup==Organic Search;sessions>=10', ['sessions']);
  assert.equal(f.dimensionFilter.filter.stringFilter.matchType, 'EXACT');
  assert.equal(f.metricFilter.filter.numericFilter.operation, 'GREATER_THAN_OR_EQUAL');
});

test('util: globs, URL normalization and URL templates', () => {
  assert.ok(globToRegExp('content/**/*.{md,html}').test('content/a/b/c.md'));
  assert.ok(globToRegExp('content/**/*.md').test('content/c.md'));
  assert.ok(!globToRegExp('content/*.md').test('content/a/c.md'));
  assert.equal(normalizeUrl('HTTPS://WWW.Example.com:443/a?utm_source=x&b=1#top'), 'https://www.example.com/a?b=1');
  assert.equal(urlFromTemplate('https://e.com/blog/{slug}/', '/r/c/x/index.md', '/r/c'), 'https://e.com/blog/x/');
});
