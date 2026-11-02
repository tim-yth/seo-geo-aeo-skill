import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, makeWorkspace, runScript, startServer, editConfig, dataFile } from './harness.mjs';
import { csvToRecords } from '../lib/csv.mjs';

async function withSite(fn) {
  const srv = await startServer({ rootDir: path.join(FIXTURES, 'site'), routes: { '/blog/old-post': { status: 301, headers: { location: '/blog/best-grinders/' }, body: '' } } });
  try {
    const ws = makeWorkspace(['--page-group', 'guides=^/guides/', '--page-group', 'blog=^/blog/']);
    editConfig(ws, (c) => {
      c.site.url = `${srv.origin}/`;
    });
    await fn(ws, srv.origin);
  } finally {
    await srv.close();
  }
}

test('crawl-site: finds the planted technical defects', async () => {
  await withSite(async (ws, origin) => {
    const r = await runScript('crawl-site.mjs', ['--workspace', ws, '--delay', '0', '--concurrency', '3']);
    assert.equal(r.status, 0, r.stderr);
    const issues = csvToRecords(fs.readFileSync(dataFile(ws, 'crawl', /issues\.csv$/), 'utf8')).records;
    const has = (rule, urlPart = '') => issues.some((i) => i.rule === rule && i.url.includes(urlPart));
    for (const [rule, part] of [
      ['sitemap-redirect', '/blog/old-post'],
      ['sitemap-non-200', '/blog/missing/'],
      ['http-error', '/blog/missing/'],
      ['internal-link-broken', ''],
      ['internal-link-to-redirect', ''],
      ['sitemap-noindex', '/blog/noindex-page/'],
      ['sitemap-blocked-by-robots', '/private/secret/'],
      ['sitemap-non-canonical', '/blog/best-grinders/'],
      ['orphan', '/orphan/'],
      ['hreflang-no-return', '/guides/pour-over/'],
      ['hreflang-invalid-code', '/guides/pour-over/'],
      ['jsonld-parse-error', '/blog/best-grinders/'],
      ['faq-schema-not-visible', '/guides/pour-over/'],
      ['title-duplicate', '/orphan/'],
      ['description-missing', '/blog/best-grinders/'],
      ['img-missing-alt', '/guides/pour-over/'],
      ['js-rendered', '/app/'],
      ['trailing-slash-variants', '/guides/pour-over'],
      ['entity-id-drift', ''],
    ]) assert.ok(has(rule, part), `missing ${rule} ${part}`);
    assert.ok(!issues.some((i) => i.rule === 'jsonld-parse-error' && i.url.includes('/blog/old-post')), 'redirect sources are not content-audited');
    const pages = csvToRecords(fs.readFileSync(dataFile(ws, 'crawl', /pages\.csv$/), 'utf8')).records;
    const home = pages.find((p) => p.url === `${origin}/`);
    assert.equal(home.canonical_status, 'self');
    const guide = pages.find((p) => p.url === `${origin}/guides/pour-over/`);
    assert.ok(Number(guide.inlinks) >= 2 && Number(guide.cjk_chars) > 40);
    assert.equal(pages.find((p) => p.url === `${origin}/blog/old-post`).status, '301');
    assert.equal(pages.find((p) => p.url.endsWith('/private/secret/')).status, 'blocked-by-robots');
    const text = fs.readFileSync(dataFile(ws, 'crawl', /text\.jsonl$/), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(text.some((t) => t.url.endsWith('/guides/pour-over/') && t.blocks.length > 2));
    assert.ok(fs.readFileSync(dataFile(ws, 'crawl', /summary\.md$/), 'utf8').includes('## Issues by rule'));
    const again = await runScript('crawl-site.mjs', ['--workspace', ws, '--delay', '0', '--name', 'second']);
    assert.equal(again.status, 0);
    assert.ok(fs.readFileSync(dataFile(ws, 'crawl', /second-summary\.md$/), 'utf8').includes('Changes since previous crawl'));
  });
});

test('check-resources: live checks against a local site (robots, sitemaps, AI crawlers, llms.txt)', async () => {
  await withSite(async (ws) => {
    const r = await runScript('check-resources.mjs', ['--workspace', ws, '--json', '--skip', 'gsc,ga4,bing,credentials']);
    assert.equal(r.status, 0, r.stderr);
    const items = Object.fromEntries(JSON.parse(r.stdout).items.map((i) => [i.id, i]));
    assert.equal(items.site.status, 'ok');
    assert.equal(items.robots.status, 'ok');
    assert.equal(items.sitemaps.status, 'ok');
    assert.match(items.sitemaps.detail, /10 URLs/);
    assert.equal(items.ai_crawlers.status, 'ok');
    assert.match(items.ai_crawlers.detail, /training-only bots blocked: GPTBot/);
    assert.equal(items.llms_txt.status, 'missing');
  });
});

test('content-audit can read the crawl text output', async () => {
  await withSite(async (ws) => {
    assert.equal((await runScript('crawl-site.mjs', ['--workspace', ws, '--delay', '0'])).status, 0);
    const r = await runScript('content-audit.mjs', ['--workspace', ws]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /crawl text/);
  });
});
