import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, makeWorkspace, runScript, startServer, editConfig } from './harness.mjs';
import { keywordSlug, parseBrave, domainFrequency } from '../serp-snapshot.mjs';
import { gapList } from '../competitor-snapshot.mjs';

const C = path.join(FIXTURES, 'competitors');
const KEY = 'dummy-brave-key-7f3a9';

async function withSites(fn) {
  const ours = await startServer({ rootDir: path.join(C, 'ours') });
  let rivalsOrigin = '';
  const rivals = await startServer({
    rootDir: path.join(C, 'rivals'),
    routes: {
      '/brave': (req) => {
        if (req.headers['x-subscription-token'] !== KEY) return { status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID"}}' };
        const body = fs.readFileSync(path.join(C, 'brave-response.json'), 'utf8').replaceAll('{{RIVALS}}', rivalsOrigin).replaceAll('{{OURS}}', ours.origin);
        return { status: 200, headers: { 'content-type': 'application/json' }, body };
      },
    },
  });
  rivalsOrigin = rivals.origin;
  try {
    const ws = makeWorkspace();
    editConfig(ws, (c) => {
      c.site.url = `${ours.origin}/`;
      c.serp.country = 'US';
      c.serp.lang = 'en';
    });
    await fn({ ws, ours: ours.origin, rivals: rivals.origin });
  } finally {
    await ours.close();
    await rivals.close();
  }
}

const allOutputs = (ws) => {
  const texts = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else texts.push(fs.readFileSync(f, 'utf8'));
    }
  };
  walk(ws);
  return texts.join('\n');
};

test('serp-snapshot: pure helpers (slug for CJK, our rank, domain frequency)', () => {
  assert.match(keywordSlug('Pour Over Ratio'), /^pour-over-ratio-[0-9a-f]{6}$/);
  assert.match(keywordSlug('手沖咖啡 比例'), /^kw-[0-9a-f]{8}$/);
  assert.notEqual(keywordSlug('ai 咖啡'), keywordSlug('AI 拿鐵'));
  assert.notEqual(keywordSlug('c++ tutorial'), keywordSlug('c# tutorial'));
  const page = { web: { results: [{ url: 'https://a.com/x', title: '<b>A</b>' }, { url: 'https://www.ours.com/p', title: 'Ours' }, { url: 'https://b.com/y', title: 'B' }] }, faq: { results: [{}] } };
  const p = parseBrave([page], { top: 10, ourHost: 'ours.com' });
  assert.equal(p.ours.rank, 2);
  assert.equal(p.results[0].title, 'A');
  assert.equal(p.features.faq, true);
  const freq = domainFrequency([p, parseBrave([page], { top: 1, ourHost: 'ours.com' })], 'ours.com');
  assert.equal(freq[0].domain, 'a.com');
  assert.equal(freq[0].keywords, 2);
});

test('serp-snapshot CLI: mocked Brave API, outputs, key never written', async () => {
  await withSites(async ({ ws, rivals }) => {
    const missing = await runScript('serp-snapshot.mjs', ['--workspace', ws, '--keyword', 'x'], { env: { BRAVE_SEARCH_API_KEY: '', SEO_AGENT_BRAVE_ENDPOINT: `${rivals}/brave` } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /api-dashboard\.search\.brave\.com/);
    const bad = await runScript('serp-snapshot.mjs', ['--workspace', ws, '--keyword', 'x', '--delay', '0'], { env: { BRAVE_SEARCH_API_KEY: 'wrong', SEO_AGENT_BRAVE_ENDPOINT: `${rivals}/brave` } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /HTTP 401/);
    assert.ok(!bad.stderr.includes('wrong'), 'rejected key not echoed');
  });
  await withSites(async ({ ws, ours, rivals }) => {
    const env = { BRAVE_SEARCH_API_KEY: KEY, SEO_AGENT_BRAVE_ENDPOINT: `${rivals}/brave` };
    const r = await runScript('serp-snapshot.mjs', ['--workspace', ws, '--keyword', 'pour over ratio', '--keyword', '手沖咖啡 比例', '--delay', '0'], { env });
    assert.equal(r.status, 0, r.stderr);
    const dir = path.join(ws, 'data', 'serp');
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => /-pour-over-ratio-[0-9a-f]{6}\.json$/.test(f)));
    assert.ok(files.some((f) => /-kw-[0-9a-f]{8}\.json$/.test(f)));
    const snap = JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => /-pour-over-ratio-[0-9a-f]{6}\.json$/.test(f))), 'utf8'));
    assert.equal(snap.ours.rank, 2);
    assert.equal(snap.ours.urls[0], `${ours}/guides/pour-over/`);
    assert.equal(snap.results[0].title, 'Pour Over Ratio: The Complete Guide');
    assert.ok(fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('-domains.csv'))), 'utf8').includes('127.0.0.1'));
    assert.ok(!allOutputs(ws).includes(KEY) && !r.stdout.includes(KEY) && !r.stderr.includes(KEY), 'key leaked');

    const c = await runScript('competitor-snapshot.mjs', ['--workspace', ws, '--from-serp', path.join(dir, files.find((f) => /-pour-over-ratio-[0-9a-f]{6}\.json$/.test(f))), '--delay', '0']);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /2 competitor page\(s\)/);
    assert.match(c.stdout, /1 skipped/);
    const md = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.startsWith(`${new Date().getFullYear()}`) && f.includes('competitors'))), 'utf8');
    assert.ok(md.includes('## Side by side') && md.includes('## Gap list'));
    assert.ok(md.includes('disallowed by robots.txt'));
    for (const g of ['FAQ block', 'Comparison or data table', 'Outbound citations', 'Visible publish/update date']) assert.ok(md.includes(g), `gap ${g}`);
    assert.ok(/subtopic \| (temperature|water|bloom)/.test(md), 'subtopic gap from competitor headings');
    const csv = fs.readFileSync(path.join(ws, 'data', 'competitors', fs.readdirSync(path.join(ws, 'data', 'competitors')).find((f) => f.endsWith('-pages.csv'))), 'utf8');
    assert.ok(csv.includes('ours,') && csv.includes('competitor,'));
  });
});

test('competitor-snapshot: gap list logic', () => {
  const base = { schemaTypes: [], h2: ['a'], h3: [], wordEq: 300, citations: 0, modified: '', title: 'x', h1: '', description: '', text: '' };
  const comp = (o) => ({ ...base, faq: true, tables: 1, lists: true, answerFirst: true, schemaTypes: ['FAQPage'], h2: ['Water temperature', 'Grind size', 'Bloom'], wordEq: 1200, citations: 4, modified: new Date().toISOString(), ...o });
  const gaps = gapList({ ...base, faq: false, tables: 0, lists: false, answerFirst: false }, [comp({}), comp({}), comp({ faq: false })]);
  const items = gaps.map((g) => g.item);
  for (const i of ['FAQ block / question headings', 'Comparison or data table', 'FAQPage', 'Content depth', 'Outbound citations', 'Recent update']) assert.ok(items.includes(i), `missing ${i}`);
  assert.ok(gaps.some((g) => g.type === 'subtopic' && /temperature|grind|water/.test(g.item)));
});
