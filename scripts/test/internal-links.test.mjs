import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, makeWorkspace, runScriptSync, dataFile } from './harness.mjs';
import { csvToRecords } from '../lib/csv.mjs';
import { buildGraph, pageRank, linkScores, clickDepth, phraseRegex, findMentions, batchSuggestions, normalizeWithMap } from '../lib/link-graph.mjs';
import { analyze, readKeywordMap, readPages, opportunityByPage } from '../internal-links.mjs';

const FX = path.join(FIXTURES, 'internal-links');
const O = 'https://www.example.com';
const readJsonl = (f) => fs.readFileSync(path.join(FX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function workspaceWithCrawl() {
  const ws = makeWorkspace(['--page-group', 'guides=^/guides/', '--page-group', 'blog=^/blog/', '--page-group', 'tools=^/tools/']);
  const crawl = path.join(ws, 'data', 'crawl');
  fs.mkdirSync(crawl, { recursive: true });
  for (const f of ['2026-11-01-crawl-links.jsonl', '2026-11-01-crawl-text.jsonl', '2026-11-01-crawl-pages.csv']) fs.copyFileSync(path.join(FX, f), path.join(crawl, f));
  fs.copyFileSync(path.join(FX, 'keyword-map.csv'), path.join(ws, 'keyword-map.csv'));
  return ws;
}

test('internal-links: --help works without a workspace', () => {
  const r = runScriptSync('internal-links.mjs', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PageRank/);
  assert.match(r.stdout, /--max-per-source/);
});

test('internal-links: weighted PageRank, template discount, nofollow evaporation, depth', () => {
  const rec = (p, links) => ({ url: O + p, finalUrl: O + p, links: links.map(([to, boiler = false, nofollow = false]) => ({ url: O + to, internal: true, text: to, boiler, nofollow })) });
  const records = [
    rec('/', [['/a/'], ['/b/', true]]),
    rec('/a/', [['/c/']]),
    rec('/b/', [['/c/'], ['/d/', false, true]]),
    rec('/c/', [['/'], ['/a/']]),
    rec('/d/', []),
  ];
  const g = buildGraph(records);
  const { pr, iterations } = pageRank(g);
  assert.ok(Math.abs(pr.reduce((s, x) => s + x, 0) - 1) < 1e-9, 'normalized');
  assert.ok(iterations > 5 && iterations < 300);
  const at = (p) => pr[g.index.get(O + p)];
  assert.ok(at('/a/') > at('/b/'), 'a body link (1.0) passes more than a nav link (0.5)');
  assert.equal(g.evap[g.index.get(`${O}/b/`)], 1, 'nofollow share evaporates');
  assert.equal(g.out[g.index.get(`${O}/b/`)].length, 1);
  const depth = clickDepth(g, g.index.get(`${O}/`));
  assert.equal(depth.get(g.index.get(`${O}/c/`)), 2);
  assert.equal(depth.has(g.index.get(`${O}/d/`)), false, '/d/ is only reachable through nofollow');
  const scores = linkScores(pr, [0, 1, 2, 3, 4]);
  assert.equal(Math.max(...scores.values()), 100);
  assert.equal(Math.min(...scores.values()), 1);
  // sitewide: a link to /n/ from every page is discounted to 0.3
  const many = Array.from({ length: 6 }, (_, i) => rec(`/p${i}/`, [['/n/', true], [`/p${(i + 1) % 6}/`]]));
  many.push(rec('/n/', []));
  const g2 = buildGraph(many);
  assert.deepEqual(g2.out[0].map((e) => e.weight).sort(), [0.3, 1]);
  assert.deepEqual(g2.sitewideTargets, [`${O}/n/`]);
});

test('internal-links: phrase matching keeps the natural anchor, whole words, CJK, longest phrase, skips linked text', () => {
  const phrases = ['coffee ratio calculator', 'ratio calculator', 'french press', 'french press ratio', '手沖咖啡', 'pour over'].map((k) => ({ key: k, re: phraseRegex(k) }));
  const m = findMentions([
    'Try the Coffee-Ratio Calculator before you pour overflowing cups.',
    'The french press ratio is coarser; a french press is forgiving.',
    '我們的團隊每天都在研究手沖 咖啡的萃取。',
    'See our pour over guide.',
  ], phrases, { linkTexts: ['pour over guide'] });
  assert.deepEqual(m.map((x) => [x.paragraph, x.anchor]), [[0, 'Coffee-Ratio Calculator'], [1, 'french press ratio'], [1, 'french press'], [2, '手沖 咖啡']]);
  assert.equal(m[0].sentence, 'Try the Coffee-Ratio Calculator before you pour overflowing cups.');
  assert.equal(normalizeWithMap('Ａｂｃ – Déjà').norm, 'abc déjà');
  const picked = batchSuggestions([
    ...['/t1/', '/t2/', '/t3/', '/t4/'].map((t, i) => ({ source: '/s/', target: t, score: 10 - i, mentions: [{ paragraph: 0, start: 0, anchor: 'x', phrase: { key: 'x' } }] })),
    { source: '/s/', target: '/t1/', score: 1, mentions: [{ paragraph: 1, start: 0, anchor: 'y', phrase: { key: 'y' } }] },
  ], { maxPerSource: 3, batchSize: 30 });
  assert.deepEqual(picked.map((p) => `${p.target}:${p.batch}`), ['/t1/:B1', '/t2/:B1', '/t3/:B1', '/t4/:B2']);
});

test('internal-links: Latin next to CJK, Japanese long vowels, half-width kana, link text only suppresses whole words', () => {
  const anchors = (paras, keys, linkTexts = []) => findMentions(paras, keys.map((k) => ({ key: k, re: phraseRegex(k) })), { linkTexts }).map((m) => m.anchor);
  assert.deepEqual(anchors(['我們使用ChatGPT寫作。'], ['ChatGPT']), ['ChatGPT']);
  assert.deepEqual(anchors(['我們使用ChatGPT寫作。'], ['Chat']), [], 'still whole Latin words');
  assert.deepEqual(anchors(['推薦幾個SEO工具。', '推薦幾個SEO 工具。'], ['SEO工具']), ['SEO工具', 'SEO 工具']);
  assert.deepEqual(anchors(['這款iPhone 手機殼很好看。'], ['iPhone手機殼']), ['iPhone 手機殼']);
  assert.deepEqual(anchors(['毎朝コーヒーを飲む。'], ['コーヒー']), ['コーヒー']);
  assert.deepEqual(anchors(['新しいｶﾞｲﾄﾞです。'], ['ガイド']), ['ｶﾞｲﾄﾞ']);
  assert.deepEqual(anchors(['Read our email marketing start guide about the coffee grinder.'], ['email marketing', 'start guide', 'coffee grinder'], ['AI', 'Art', 'Coffee']), ['email marketing', 'start guide', 'coffee grinder']);
  assert.deepEqual(anchors(['See our coffee grinder review.'], ['coffee grinder'], ['coffee grinder review']), [], 'already inside a link');
  // only body links count as "already linked text": template links are not in the paragraph
  const g = buildGraph([{ url: `${O}/a/`, finalUrl: `${O}/a/`, links: [{ url: `${O}/b/`, internal: true, text: 'Coffee', boiler: true }, { url: `${O}/c/`, internal: true, text: 'grinder guide', boiler: false }] }]);
  assert.deepEqual(g.linkTexts[0], ['grinder guide']);
});

test('internal-links: a keyword-map target that is a redirect alias in the link graph resolves to the page', () => {
  const linkRecords = [
    { url: `${O}/`, finalUrl: `${O}/`, depth: 0, links: [{ url: `${O}/guide/`, internal: true, text: 'Guide', boiler: true }, { url: `${O}/tool/`, internal: true, text: 'Tool', boiler: true }] },
    { url: `${O}/guide/`, finalUrl: `${O}/guide/`, links: [{ url: `${O}/`, internal: true, text: 'Home', boiler: true }] },
    { url: `${O}/old-tool`, finalUrl: `${O}/tool/`, links: [{ url: `${O}/`, internal: true, text: 'Home', boiler: true }] },
  ];
  const textRecords = [{ url: `${O}/guide/`, finalUrl: `${O}/guide/`, status: 200, paragraphs: ['Use the ratio tool before brewing.'] }];
  const res = analyze({ linkRecords, textRecords, keywordRows: [{ keyword: 'ratio tool', target: `${O}/old-tool`, cluster: '', phrases: ['ratio tool'] }], home: `${O}/` });
  assert.equal(res.suggestions.length, 1);
  assert.equal(res.suggestions[0].target, `${O}/tool/`);
});

test('internal-links: fixture graph metrics and suggestions (pure)', () => {
  const linkRecords = readJsonl('2026-11-01-crawl-links.jsonl');
  const textRecords = readJsonl('2026-11-01-crawl-text.jsonl');
  const { facts, redirects } = readPages(path.join(FX, '2026-11-01-crawl-pages.csv'));
  const keywordRows = readKeywordMap(path.join(FX, 'keyword-map.csv'), { origin: O, redirects });
  assert.equal(keywordRows.find((r) => r.keyword === 'french press').target, `${O}/guides/french-press/`, 'redirecting target resolved');
  assert.deepEqual(keywordRows.find((r) => r.keyword === 'pour over').phrases, ['pour over', 'pour-over coffee', '手沖咖啡']);
  const opportunity = opportunityByPage(path.join(FX, 'gsc-query-page.csv'));
  assert.equal(opportunity.get(`${O}/tools/ratio-calculator/`), 1000);
  assert.equal(opportunity.get(`${O}/guides/pour-over/`), undefined, 'position 3 is not an opportunity');
  const groupOf = (u) => (/\/guides\//.test(u) ? 'guides' : /\/blog\//.test(u) ? 'blog' : /\/tools\//.test(u) ? 'tools' : 'other');
  const res = analyze({ linkRecords, textRecords, facts, redirects, keywordRows, opportunity, home: `${O}/`, pageGroupOf: groupOf, important: new Map([[`${O}/tools/ratio-calculator/`, 'keyword-map target']]) });
  const page = (p) => res.pages.find((x) => x.url === O + p);
  const navPages = ['/', '/guides/', '/blog/', '/about/'];
  const best = res.pages.filter((p) => p.eligible).sort((a, b) => b.linkScore - a.linkScore);
  assert.ok(navPages.includes(best[0].url.replace(O, '')), `strongest page is a navigation target (${best[0].url})`);
  assert.equal(page('/orphan-page/').linkScore, 1, 'the orphan is the weakest page');
  assert.ok(page('/guides/pour-over/').linkScore > page('/guides/deep-4/').linkScore);
  assert.equal(page('/guides/').inlinksBody, 0);
  assert.equal(page('/guides/').inlinksNav, 14);
  assert.equal(page('/guides/pour-over/').inlinksBody, 3);
  assert.equal(page('/guides/french-press/').inlinksBody, 2, 'a link to a redirect counts for its target');
  assert.equal(page('/orphan-page/').orphan, true);
  assert.equal(page('/orphan-page/').depth, null);
  assert.equal(page('/guides/deep-3/').depth, 4);
  assert.equal(page('/guides/deep-3/').deep, true);
  assert.equal(page('/guides/deep-2/').deep, false);
  assert.equal(page('/blog/tag/coffee/').eligible, false);
  assert.equal(page('/blog/tag/coffee/').linkScore, null);
  assert.equal(page('/tools/ratio-calculator/').weakContextual, true);
  const s = (src, tgt) => res.suggestions.find((x) => x.source === O + src && x.target === O + tgt);
  assert.equal(s('/guides/pour-over/', '/tools/ratio-calculator/').anchor, 'Coffee Ratio Calculator', 'anchor as written');
  assert.equal(s('/guides/pour-over/', '/tools/ratio-calculator/').placement, 'paragraph 2 of 4');
  assert.match(s('/guides/pour-over/', '/tools/ratio-calculator/').snippet, /^If you do not want to do the math/);
  assert.equal(s('/blog/coffee-storage/', '/tools/ratio-calculator/').anchor, 'french press ratio', 'longest phrase wins');
  assert.equal(s('/about/', '/guides/pour-over/').anchor, '手沖咖啡');
  assert.ok(!s('/guides/pour-over/', '/guides/french-press/'), 'already links (through a redirect)');
  assert.ok(!s('/guides/pour-over/', '/blog/coffee-storage/'), 'headings are not used');
  assert.ok(!s('/guides/deep-1/', '/guides/pour-over/'), '"pour overflowing" is not "pour over"');
  assert.ok(!s('/', '/guides/pour-over/'), 'home already links');
  assert.ok(!res.suggestions.some((x) => x.source.includes('/blog/tag/') || x.target.includes('/blog/tag/')), 'noindex pages are neither sources nor targets');
  assert.ok(!res.suggestions.some((x) => x.source === x.target));
  const fromStorage = res.suggestions.filter((x) => x.source === `${O}/blog/coffee-storage/`);
  assert.equal(fromStorage.length, 4);
  assert.equal(fromStorage.filter((x) => x.batch === 'B1').length, 3, 'max 3 per source per batch');
  assert.equal(s('/blog/coffee-storage/', '/guides/pour-over/').batch, 'B2', 'lowest score moves to the next batch');
  assert.equal(res.suggestions[0].target, `${O}/tools/ratio-calculator/`, 'opportunity ranks the calculator first');
  for (let i = 1; i < res.suggestions.length; i++) if (res.suggestions[i].batch === res.suggestions[i - 1].batch) assert.ok(res.suggestions[i].score <= res.suggestions[i - 1].score);
});

test('internal-links CLI: outputs, limits and errors', () => {
  const ws = workspaceWithCrawl();
  const r = runScriptSync('internal-links.mjs', ['--workspace', ws, '--gsc', path.join(FX, 'gsc-query-page.csv'), '--max-per-source', '2']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /15 pages in the link graph \(14 eligible\)/);
  const pages = csvToRecords(fs.readFileSync(dataFile(ws, 'crawl', /-internal-links\.csv$/), 'utf8')).records;
  const row = pages.find((p) => p.url === `${O}/orphan-page/`);
  assert.equal(row.orphan, 'yes');
  assert.equal(row.deep, 'unreachable');
  assert.equal(pages.find((p) => p.url === `${O}/tools/ratio-calculator/`).important, 'keyword-map target');
  const sugg = csvToRecords(fs.readFileSync(dataFile(ws, 'crawl', /-link-suggestions\.csv$/), 'utf8'));
  assert.deepEqual(sugg.headers.slice(0, 8), ['source', 'target', 'anchor', 'snippet', 'placement', 'reason', 'score', 'batch']);
  const perSourceB1 = new Map();
  for (const x of sugg.records.filter((y) => y.batch === 'B1')) perSourceB1.set(x.source, (perSourceB1.get(x.source) || 0) + 1);
  assert.ok(Math.max(...perSourceB1.values()) <= 2);
  assert.ok(fs.readFileSync(dataFile(ws, 'crawl', /B1-sources\.txt$/), 'utf8').includes(`${O}/blog/coffee-storage/`));
  const md = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.endsWith('-internal-links.md'))), 'utf8');
  assert.match(md, /source URLs become the treatment group/);
  assert.match(md, /Important pages with weak contextual inlinks/);
  assert.match(md, /ratio-calculator/);
  const none = runScriptSync('internal-links.mjs', ['--workspace', makeWorkspace()]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /crawl-site\.mjs/);
  const badGsc = runScriptSync('internal-links.mjs', ['--workspace', ws, '--gsc', path.join(FX, '2026-11-01-crawl-pages.csv')]);
  assert.equal(badGsc.status, 1);
  assert.match(badGsc.stderr, /impressions column|query and page/);
});
