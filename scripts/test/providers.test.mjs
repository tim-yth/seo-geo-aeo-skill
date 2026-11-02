import fs from 'node:fs';
import path from 'node:path';
import { test, assert, makeWorkspace, runScript, runScriptSync, FIXTURES, SCRIPTS_DIR } from './harness.mjs';
import { loadWorkspace } from '../lib/config.mjs';
import { CostGuard, requireProvider, notConfiguredMessage, monthSpend, recordSpend, redactSecrets, credentialStatus, providerSettings } from '../lib/providers.mjs';
import { csvToRecords, writeCsvFile } from '../lib/csv.mjs';

test('providers: cost guard plans, refuses over the per-run cap and monthly budget, and logs spend', () => {
  const dir = makeWorkspace(['--provider', 'openai=SEO_TEST_OPENAI_KEY', '--provider-budget', 'openai=1']);
  const ws = loadWorkspace({ workspace: dir });
  assert.equal(providerSettings(ws, 'openai').apiKeyEnv, 'SEO_TEST_OPENAI_KEY');
  const guard = new CostGuard(ws, { provider: 'openai', script: 'geo-track.mjs', maxCalls: 10, perCallUSD: 0.05 });
  const ok = guard.plan(10);
  assert.equal(ok.ok, true);
  assert.ok(Math.abs(ok.usd - 0.5) < 1e-9);
  assert.equal(guard.plan(11).ok, false);
  assert.throws(() => guard.assertPlan(guard.plan(11)), (e) => e.exitCode === 2 && /per-run cap/.test(e.message));
  for (let i = 0; i < 10; i++) guard.charge();
  assert.throws(() => guard.charge(), /per-run cap of 10/);
  guard.record('run T1');
  assert.ok(Math.abs(monthSpend(ws, 'openai', ws.today().slice(0, 7)).usd - 0.5) < 1e-9);
  recordSpend(ws, { provider: 'openai', script: 'manual', calls: 1, usd: 0.6 });
  const later = new CostGuard(ws, { provider: 'openai', maxCalls: 100, perCallUSD: 0.05 }).plan(1);
  assert.equal(later.ok, false, 'monthly budget of $1 already used');
  assert.match(later.reasons.join(' '), /monthly budget/);
  const rows = csvToRecords(fs.readFileSync(path.join(dir, 'logs', 'spend.csv'), 'utf8')).records;
  assert.deepEqual(rows.map((r) => r.provider), ['openai', 'openai']);
});

test('providers: missing keys and adapter-less providers explain what to do; secrets are redacted', () => {
  const ws = loadWorkspace({ workspace: makeWorkspace() });
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => requireProvider(ws, 'openai', { script: 'geo-track.mjs' }), (e) => /\$OPENAI_API_KEY is not set/.test(e.message) && e.hint.some((h) => /export OPENAI_API_KEY/.test(h)));
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
  assert.throws(() => requireProvider(ws, 'ahrefs'), /no built-in adapter/);
  assert.ok(notConfiguredMessage('dataforseo').hint.some((h) => /Scripts never call MCP servers/.test(h)));
  assert.deepEqual(credentialStatus(ws, 'dataforseo').envs, ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']);
  process.env.SEO_TEST_SECRET_FOR_REDACTION = 'sk-test-1234567890';
  try {
    const ws2 = loadWorkspace({ workspace: makeWorkspace(['--provider', 'openai=SEO_TEST_SECRET_FOR_REDACTION']) });
    const text = redactSecrets('failed https://api.example.com/x?apikey=abc123&q=1 with key sk-test-1234567890', ws2);
    assert.ok(!text.includes('abc123') && !text.includes('sk-test-1234567890'), text);
    assert.match(text, /apikey=<redacted>&q=1/);
  } finally {
    delete process.env.SEO_TEST_SECRET_FOR_REDACTION;
  }
});

test('init + check-resources: geo engines, providers, protect and the event ledger are configured and reported', () => {
  const dir = makeWorkspace(['--geo-engine', 'openai', '--geo-model', 'openai=test-model', '--geo-country', 'tw', '--provider', 'dataforseo', '--protect-path', 'blog/a/index.html', '--protect-url', '/guides/x/', '--bing-key-env', 'MY_BING_KEY']);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.geo.engines, ['openai']);
  assert.equal(cfg.geo.models.openai, 'test-model');
  assert.equal(cfg.geo.country, 'TW');
  assert.deepEqual(cfg.protect, { paths: ['blog/a/index.html'], urls: ['/guides/x/'] });
  assert.equal(cfg.bing.apiKeyEnv, 'MY_BING_KEY');
  assert.ok('dataforseo' in cfg.providers);
  const bad = runScriptSync('init.mjs', ['--workspace', dir, '--provider', 'openai=sk-live-not-a-name']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /environment variable NAME/);
  for (const d of ['gsc/ai-features/inbox', 'bing/ai-performance/inbox', 'bots', 'diff']) assert.ok(fs.existsSync(path.join(dir, 'data', d)), d);
  const r = runScriptSync('check-resources.mjs', ['--workspace', dir, '--offline', '--json'], { env: { OPENAI_API_KEY: '' } });
  assert.equal(r.status, 0, r.stderr);
  const items = Object.fromEntries(JSON.parse(r.stdout).items.map((i) => [i.id, i]));
  assert.equal(items.geo_engines.status, 'missing');
  assert.match(items.geo_engines.detail, /openai: \$OPENAI_API_KEY not set, model test-model/);
  assert.equal(items.providers.status, 'missing');
  assert.match(items.providers.detail, /dataforseo .*no built-in adapter/);
  assert.equal(items.events.status, 'ok');
  const ok = runScriptSync('check-resources.mjs', ['--workspace', dir, '--offline', '--json'], { env: { OPENAI_API_KEY: 'x'.repeat(20) } });
  assert.equal(JSON.parse(ok.stdout).items.find((i) => i.id === 'geo_engines').status, 'ok');
});

test('content-audit: machine columns refresh, manual and user-added columns are never overwritten (old headers gain new columns)', async () => {
  const ws = makeWorkspace();
  const inv = path.join(ws, 'content-inventory.csv');
  const url = 'https://www.example.com/blog/pour-over-guide/';
  fs.writeFileSync(inv, `url,slug,title,grade,x_flags,action,target_url,wave,notes,my_column\n${url},my-slug,Old title,A,,merge,https://www.example.com/x/,W-1,keep this,custom value\n`);
  const r = await runScript('content-audit.mjs', ['--workspace', ws, '--glob', path.join(FIXTURES, 'content', 'pour-over-guide.md'), '--url-template', 'https://www.example.com/blog/{slug}/']);
  assert.equal(r.status, 0, r.stderr);
  const { headers, records } = csvToRecords(fs.readFileSync(inv, 'utf8'));
  for (const c of ['review_grade', 'review_x', 'review_action', 'review_target', 'value_tier', 'protected', 'my_column']) assert.ok(headers.includes(c), c);
  const row = records.find((x) => x.url === url);
  assert.deepEqual([row.slug, row.action, row.target_url, row.wave, row.notes, row.my_column], ['my-slug', 'merge', 'https://www.example.com/x/', 'W-1', 'keep this', 'custom value']);
  assert.notEqual(row.title, 'Old title', 'title is a machine column (the page as it is now)');
  assert.ok(row.grade && row.audited_at && row.template_ratio, 'machine columns refreshed');
  // a human verdict in review_* survives the next run
  const edited = csvToRecords(fs.readFileSync(inv, 'utf8'));
  edited.records[0].review_grade = 'B';
  edited.records[0].protected = 'true';
  writeCsvFile(inv, edited.records, edited.headers);
  assert.equal((await runScript('content-audit.mjs', ['--workspace', ws, '--glob', path.join(FIXTURES, 'content', 'pour-over-guide.md'), '--url-template', 'https://www.example.com/blog/{slug}/'])).status, 0);
  const again = csvToRecords(fs.readFileSync(inv, 'utf8')).records.find((x) => x.url === url);
  assert.deepEqual([again.review_grade, again.protected], ['B', 'true']);
  const tmpl = fs.readFileSync(path.join(SCRIPTS_DIR, '..', 'templates', 'workspace', 'content-inventory.csv'), 'utf8');
  assert.match(tmpl, /,review_grade,review_x,review_action,review_target,value_tier,protected$/m);
});
