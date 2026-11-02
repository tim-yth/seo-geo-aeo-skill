import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, makeWorkspace, runScript, startServer, editConfig, dataFile } from './harness.mjs';
import { detectTags, detectFrameworks, scanCode, checkCalls } from '../instrumentation-audit.mjs';

const I = path.join(FIXTURES, 'instrumentation');
const read = (p) => fs.readFileSync(path.join(I, p), 'utf8');
const listFiles = (root) => {
  const outList = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else outList.push(path.relative(root, f).split(path.sep).join('/'));
    }
  };
  walk(root);
  return outList.sort();
};

test('instrumentation: tag detection (IDs, duplicates, GTM+gtag, delayed loaders, consent, CMP)', () => {
  const home = detectTags(read('site/index.html'));
  assert.deepEqual(home.ga4Ids, ['G-TEST12345']);
  assert.equal(home.consentDefault, true);
  assert.deepEqual(home.cmps, ['Cookiebot']);
  assert.equal(home.verification.google, true);
  const a = detectTags(read('site/blog/a/index.html'));
  assert.deepEqual(a.doubleConfigured, ['G-TEST12345']);
  assert.deepEqual(a.gtm, ['GTM-ABCD12']);
  assert.ok(a.otherAnalytics.includes('Meta Pixel'));
  const b = detectTags(read('site/blog/b/index.html'));
  assert.ok(b.delayed.some((x) => /timer/.test(x)) && b.delayed.some((x) => /interaction/.test(x)));
  const tool = detectTags(read('site/tools/calc/index.html'));
  assert.equal(tool.ga4Ids.length + tool.gtm.length, 0);
  assert.equal(detectTags(read('site/app/index.html')).jsRendered, true);
});

test('instrumentation: framework detection and insertion files', () => {
  const fw = (name) => detectFrameworks(path.join(I, 'repos', name), listFiles(path.join(I, 'repos', name)));
  const next = fw('next-app');
  assert.equal(next.frameworks[0].framework, 'Next.js (App Router)');
  assert.equal(next.insertion[0].file, 'app/layout.tsx');
  const wp = fw('wordpress');
  assert.equal(wp.frameworks[0].framework, 'WordPress');
  assert.ok(wp.insertion.some((i) => i.file.endsWith('header.php')));
  assert.deepEqual(wp.frameworks[0].plugins, ['google-site-kit']);
  assert.equal(fw('shopify').frameworks[0].framework, 'Shopify theme');
  assert.equal(fw('hugo').frameworks[0].framework, 'Hugo');
  const worker = fw('worker');
  assert.equal(worker.frameworks[0].framework, 'Cloudflare Workers/Pages');
  assert.ok(worker.insertion.some((i) => i.file === '_worker.js'));
});

test('instrumentation: code calls, reserved/attribution/PII params, redacted Measurement Protocol secret', () => {
  const calls = [...scanCode('app/layout.tsx', read('repos/next-app/app/layout.tsx')), ...scanCode('lib/mp.ts', read('repos/next-app/lib/mp.ts')), ...scanCode('functions/track.js', read('repos/next-app/functions/track.js'))];
  const ev = calls.find((c) => c.type === 'gtag-event');
  assert.equal(ev.event, 'start_reading');
  assert.deepEqual(ev.params.sort(), ['email', 'page_type', 'source']);
  const dl = calls.find((c) => c.type === 'dataLayer.push');
  assert.equal(dl.event, 'session_start');
  const f = checkCalls(calls);
  const ids = f.map((x) => `${x.id}:${x.where}`);
  assert.ok(ids.includes('attribution-param:app/layout.tsx:4'));
  assert.ok(ids.includes('pii-param:app/layout.tsx:4'));
  assert.ok(ids.includes('reserved-event-name:app/layout.tsx:13'));
  assert.ok(f.some((x) => x.id === 'pii-param' && /question/.test(x.detail)));
  const mp = f.filter((x) => x.id === 'mp-secret');
  assert.equal(mp.find((x) => x.where.startsWith('lib/mp.ts')).severity, 'high');
  assert.ok(!JSON.stringify(f).includes('SuperSecretValue123'));
});

test('instrumentation CLI: live sample + repo scan -> plan with the bilingual table, secret never written', async () => {
  const srv = await startServer({ rootDir: path.join(I, 'site') });
  try {
    const ws = makeWorkspace(['--page-group', 'blog=^/blog/', '--page-group', 'tools=^/tools/', '--page-group', 'app=^/app/']);
    editConfig(ws, (c) => {
      c.site.url = `${srv.origin}/`;
      c.repo.path = path.join(I, 'repos', 'next-app');
    });
    const r = await runScript('instrumentation-audit.mjs', ['--workspace', ws, '--delay', '0']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GA4: G-TEST12345/);
    assert.match(r.stdout, /groups without a tag: tools/);
    const planFile = fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.endsWith('instrumentation-plan.md'));
    const plan = fs.readFileSync(path.join(ws, 'logs', 'reviews', planFile), 'utf8');
    assert.ok(plan.includes('| 位置 Location | 要加什麼 What to add | 量什麼 What it measures | 需要使用者做什麼 What you need to do |'));
    assert.ok(plan.includes('app/layout.tsx'));
    assert.ok(/entry_source/.test(plan));
    const json = fs.readFileSync(dataFile(ws, 'instrumentation', /audit\.json$/), 'utf8');
    assert.ok(JSON.parse(json).findings.some((f) => f.id === 'delayed-loader'));
    for (const text of [plan, json, r.stdout]) assert.ok(!text.includes('SuperSecretValue123'), 'secret leaked');
  } finally {
    await srv.close();
  }
});
