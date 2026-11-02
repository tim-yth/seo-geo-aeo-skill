import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, assert, tmpDir, makeWorkspace, runScriptSync } from './harness.mjs';
import { evaluate } from '../review-due.mjs';
import { compareRates } from '../rate-test.mjs';
import { manualList, summarizeInspection } from '../indexing.mjs';
import { summarizePsi } from '../pagespeed.mjs';
import { findOverlaps } from '../lib/experiments.mjs';

test('init: creates the workspace, copies credentials with 600 perms, is idempotent, --force replaces', () => {
  const dir = path.join(tmpDir(), 'proj', '.seo-agent');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const keyFile = path.join(tmpDir(), 'sa.json');
  fs.writeFileSync(keyFile, JSON.stringify({ type: 'service_account', client_email: 'robot@demo-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  const r1 = runScriptSync('init.mjs', ['--workspace', dir, '--url', 'https://www.example.com/x', '--credentials', keyFile, '--competitor', 'rival.com|top 3', '--guardrail', 'best widgets|5', '--page-group', 'blog=^/blog/', '--brand-name', 'Example Co', '--same-as', 'https://www.linkedin.com/company/example', '--no-gitignore']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /robot@demo-project\.iam\.gserviceaccount\.com/);
  const sa = path.join(dir, 'secrets', 'google-service-account.json');
  assert.equal(fs.statSync(sa).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'secrets')).mode & 0o777, 0o700);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.site.url, 'https://www.example.com/');
  assert.equal(cfg.gsc.siteUrl, 'sc-domain:example.com');
  assert.ok(!JSON.stringify(cfg).includes('PRIVATE KEY'), 'no secret material in config');
  assert.deepEqual(cfg.competitors, [{ domain: 'rival.com', why: 'top 3' }]);
  assert.equal(cfg.guardrails[0].maxPosition, 5);
  for (const f of ['keyword-map.csv', 'geo-prompts.csv', 'content-inventory.csv', 'logs/changes.md', 'logs/experiments.json', '.gitignore', 'data/serp', 'data/instrumentation']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, 'geo-prompts.csv'), 'utf8'), /^run_date,engine,locale,intent,prompt,mentioned,rank,cited_url,reason,accuracy,pricing_claim,competitors,action_needed,notes/);
  const r2 = runScriptSync('init.mjs', ['--workspace', dir, '--url', 'https://other.com', '--competitor', 'rival.com', '--no-gitignore']);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /kept/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).competitors.length, 1);
  runScriptSync('init.mjs', ['--workspace', dir, '--url', 'https://other.com', '--force', '--no-gitignore']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).site.url, 'https://other.com/');
  const bad = runScriptSync('init.mjs', ['--workspace', dir, '--ga4-property', 'G-ABC123']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Measurement ID/);
});

test('init: adds the secrets folder to the project .gitignore inside a git repo', () => {
  const proj = tmpDir();
  if (!gitInit(proj)) return; // git not installed: nothing to test
  const r = runScriptSync('init.mjs', ['--workspace', path.join(proj, '.seo-agent'), '--url', 'https://www.example.com'], { cwd: proj });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8'), /\.seo-agent\/secrets\//);
});

test('check-resources: offline JSON contract {items:[{id,status,detail,fix}], nextAction}', () => {
  const ws = makeWorkspace();
  const r = runScriptSync('check-resources.mjs', ['--workspace', ws, '--offline', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(Array.isArray(j.items) && typeof j.nextAction === 'string');
  for (const i of j.items) {
    assert.ok(['ok', 'missing', 'error'].includes(i.status), i.status);
    assert.ok(typeof i.id === 'string' && typeof i.detail === 'string' && Array.isArray(i.fix));
  }
  const cred = j.items.find((i) => i.id === 'credentials');
  assert.equal(cred.status, 'missing');
  assert.ok(cred.fix.some((s) => /Users and permissions/.test(s)));
  assert.match(j.nextAction, /credentials/i);
  const none = runScriptSync('check-resources.mjs', ['--workspace', path.join(tmpDir(), 'nothing'), '--json', '--offline']);
  assert.equal(JSON.parse(none.stdout).items[0].status, 'missing');
});

test('log-change + review-due: D0 in site time zone and PT, checkpoints, overlap refusal, freeze, verdicts', async () => {
  const ws = makeWorkspace(['--guardrail', 'core query|4']);
  const add = (args) => runScriptSync('log-change.mjs', ['add', '--workspace', ws, ...args]);
  const a = add(['--title', 'Title test', '--kind', 'title-meta', '--urls', '/reviews/a/,/reviews/b/', '--at', '2026-10-07 01:30', '--hypothesis', 'CTR up']);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /2026-10-07 01:30 Asia\/Taipei = 2026-10-06 10:30 PT/);
  assert.match(a.stdout, /D\+28: 2026-11-04; windows pre 2026-09-08\.\.2026-10-05 \/ post 2026-10-08\.\.2026-11-04; review on or after 2026-11-08/);
  const b = add(['--title', 'Overlap', '--urls', '/reviews/b/', '--at', '2026-10-15 10:00']);
  assert.equal(b.status, 2);
  assert.match(b.stderr, /overlaps an unreviewed wave/);
  assert.equal(add(['--title', 'Overlap', '--urls', '/reviews/b/', '--at', '2026-10-15 10:00', '--force']).status, 0);
  assert.equal(add(['--type', 'freeze', '--title', 'Freeze', '--date', '2026-10-16', '--until', '2026-12-31', '--scope', 'home']).status, 0);
  assert.equal(add(['--type', 'external-event', '--title', 'Core update', '--date', '2026-10-20']).status, 0);
  assert.equal(add(['--title', 'No urls']).status, 1);
  const waves = JSON.parse(fs.readFileSync(path.join(ws, 'logs', 'experiments.json'), 'utf8'));
  assert.equal(waves.length, 4);
  assert.deepEqual(waves[0].guardrails, ['core query']);
  assert.equal(waves[1].overlaps[0].wave, waves[0].id);
  const res = evaluate(waves, '2026-11-02');
  assert.ok(res.items.some((i) => i.wave === waves[0].id && i.checkpoint === 'D+7' && i.status === 'overdue'));
  assert.ok(res.items.some((i) => i.checkpoint === 'D+28' && i.status === 'pending'));
  assert.equal(res.freezes.length, 1);
  assert.equal(res.overlaps.length, 1);
  const cp = runScriptSync('log-change.mjs', ['checkpoint', '--workspace', ws, '--wave', waves[0].id, '--checkpoint', 'D+7', '--verdict', 'inconclusive', '--extend-to', '2026-11-20']);
  assert.equal(cp.status, 0, cp.stderr);
  const follow = runScriptSync('log-change.mjs', ['checkpoint', '--workspace', ws, '--wave', waves[0].id, '--checkpoint', 'D+7', '--verdict', 'iterate']);
  assert.equal(follow.status, 0, 'one follow-up verdict is allowed after an extended inconclusive');
  assert.equal(runScriptSync('log-change.mjs', ['checkpoint', '--workspace', ws, '--wave', waves[0].id, '--checkpoint', 'D+7', '--verdict', 'keep']).status, 1, 'verdicts are never overwritten');
  const due = runScriptSync('review-due.mjs', ['--workspace', ws]);
  assert.equal(due.status, 0);
  assert.match(due.stdout, /gsc-compare\.mjs --wave .* --checkpoint D\+14 --placebo --target-query "core query"/);
  assert.match(due.stdout, /Active freezes/);
  assert.equal(runScriptSync('review-due.mjs', ['--workspace', ws, '--fail-on-overdue']).status, 2);
  const changes = fs.readFileSync(path.join(ws, 'logs', 'changes.md'), 'utf8');
  assert.match(changes, /D\+7: inconclusive/);
  assert.equal(findOverlaps(waves, { id: 'x', date: '2026-12-31', urls: [waves[0].urls[0]] }).length, 0, 'after the measurement period there is no overlap');
});

test('rate-test: sample gate, Fisher verdicts, daily mode with rolling placebo', () => {
  assert.equal(compareRates({ k1: 3, n1: 20, k2: 6, n2: 22 }).verdict, 'insufficient sample: keep observing');
  assert.equal(compareRates({ k1: 12, n1: 240, k2: 30, n2: 250, days1: 7, days2: 7 }).verdict, 'improved');
  assert.equal(compareRates({ k1: 30, n1: 300, k2: 31, n2: 300, days1: 7, days2: 7 }).verdict, 'no detectable change');
  assert.equal(compareRates({ k1: 10, n1: 200, k2: 10, n2: 200, days1: 5, days2: 7 }).verdict, 'insufficient sample: keep observing');
  const csv = path.join(tmpDir(), 'daily.csv');
  const lines = ['date,entrants,successes'];
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
    lines.push(`${d},50,${d >= '2026-10-01' ? 9 : 5}`);
  }
  fs.writeFileSync(csv, `${lines.join('\n')}\n`);
  const r = runScriptSync('rate-test.mjs', ['--daily', csv, '--change-date', '2026-09-30', '--window', '7', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verdict, 'improved');
  assert.ok(j.placebo.windows > 20);
  const p = JSON.parse(runScriptSync('rate-test.mjs', ['power', '--p1', '0.47', '--p2', '0.55', '--per-week', '240', '--json']).stdout);
  assert.equal(p.perGroup, 612);
});

test('indexing: inspection summary and the manual "Request indexing" list', () => {
  const s = summarizeInspection('https://www.example.com/a/', { inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Page with redirect', lastCrawlTime: '2026-03-01T00:00:00Z', googleCanonical: 'https://www.example.com/', userCanonical: 'https://www.example.com/a/' } } });
  assert.equal(s.coverageState, 'Page with redirect');
  const state = { urls: { 'https://www.example.com/a/': s, 'https://www.example.com/ok/': { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-10-30T00:00:00Z' }, 'https://www.example.com/merge-me/': { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', lastCrawlTime: '2026-01-01T00:00:00Z' } } };
  const deploys = new Map([['https://www.example.com/new/', { at: '2026-10-25T00:00:00Z', wave: 'W-1', open: true }]]);
  const crawl = [{ url: 'https://www.example.com/a/', status: 200, canonicalStatus: 'self' }, { url: 'https://www.example.com/new/', status: 200, canonicalStatus: 'self' }];
  const inventory = [{ url: 'https://www.example.com/merge-me/', action: 'merge into /ok/', grade: 'D' }];
  const res = manualList({ state, deploys, crawl, inventory, impressions: new Map(), now: Date.parse('2026-11-02'), homeUrl: 'https://www.example.com/' });
  assert.deepEqual(res.must.map((x) => x.url).sort(), ['https://www.example.com/a/', 'https://www.example.com/new/']);
  assert.ok(res.must.find((x) => x.url.endsWith('/a/')).reason.includes('home page'));
  assert.ok(res.skip.some((x) => x.url.endsWith('/merge-me/') && /merge/.test(x.reason)));
  assert.ok(res.skip.some((x) => x.url.endsWith('/ok/')));
});

test('pagespeed: PSI response is flattened with field-data fallback to origin', () => {
  const data = {
    lighthouseResult: { categories: { performance: { score: 0.71 } }, audits: { 'largest-contentful-paint': { numericValue: 3100 }, 'cumulative-layout-shift': { numericValue: 0.02 }, 'total-blocking-time': { numericValue: 250 } }, lighthouseVersion: '12.0.0' },
    loadingExperience: { metrics: {} },
    originLoadingExperience: { overall_category: 'AVERAGE', metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2800, category: 'AVERAGE' }, INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: 'FAST' }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'FAST' } } },
  };
  const r = summarizePsi('https://www.example.com/', 'mobile', data);
  assert.equal(r.score, 71);
  assert.equal(r.field_source, 'origin');
  assert.equal(r.field_lcp_ms, 2800);
  assert.equal(r.field_cls, 0.05);
  assert.equal(r.lab_tbt_ms, 250);
});

function gitInit(dir) {
  try {
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
