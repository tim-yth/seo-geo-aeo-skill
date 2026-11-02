import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, makeWorkspace, runScript, dataFile } from './harness.mjs';
import { docFromFile, templateAnalysis, nearDuplicates, keywordDensity, auditDoc } from '../content-audit.mjs';
import { csvToRecords } from '../lib/csv.mjs';

const DIR = path.join(FIXTURES, 'content');
const docs = fs.readdirSync(DIR).sort().map((f) => docFromFile(path.join(DIR, f), { url: `https://www.example.com/blog/${f.replace(/\.\w+$/, '')}/`, origin: 'https://www.example.com' }));
const byFile = (name) => docs.findIndex((d) => d.file.endsWith(name));

test('content-audit: template ratio flags programmatic pages (title replaced by a placeholder)', () => {
  const t = templateAnalysis(docs, { minDocs: 3 });
  assert.ok(t.ratios[byFile('french-press.md')] >= 0.5, `ratio ${t.ratios[byFile('french-press.md')]}`);
  assert.ok(t.ratios[byFile('pour-over-guide.md')] < 0.1);
  assert.ok(t.top.some((x) => x.sentence.includes('\u25C6')), 'placeholder appears in template sentences');
});

test('content-audit: near-duplicates via MinHash + exact Jaccard', () => {
  const pairs = nearDuplicates(docs, { threshold: 0.5 });
  const names = pairs.map((p) => [docs[p.a].file, docs[p.b].file].map((f) => path.basename(f)).sort().join('+'));
  assert.ok(names.includes('cold-brew-a.md+cold-brew-b.md'));
  assert.ok(!names.some((n) => n.includes('pour-over-guide.md')));
});

test('content-audit: CJK keyword stuffing density', () => {
  const d = keywordDensity(docs[byFile('zh-stuffed.md')], '手沖咖啡比例');
  assert.ok(d.count >= 8 && d.density > 0.2);
});

test('content-audit: per-page checks (X placeholder, opener, headings, years, GEO blocks)', () => {
  const ctx = { currentYear: 2026, now: Date.parse('2026-11-02'), minWords: 300, maxDensity: 0.03, staleDays: 365, templateRatio: 0, bestDup: null, terms: [], brokenLinks: [], redirectLinks: [] };
  const fp = auditDoc(docs[byFile('french-press.md')], ctx);
  assert.ok(fp.xFlags.length > 0, 'placeholder is an X flag');
  assert.ok(fp.flags.includes('generic-opener'));
  assert.ok(fp.flags.some((f) => f.startsWith('outdated-year')));
  const html = auditDoc(docs[byFile('broken-intro.html')], ctx);
  assert.ok(html.flags.includes('heading-skip'));
  assert.ok(html.flags.includes('generic-opener'));
  const good = auditDoc(docs[byFile('pour-over-guide.md')], ctx);
  assert.equal(good.xFlags.length, 0);
  assert.ok(good.hasTldr && good.hasFaq);
  assert.ok(good.answerCapsules >= 2, `capsules ${good.answerCapsules}`);
  assert.ok(good.score > fp.score);
});

test('content-audit CLI: grades, outputs, inventory merge preserves manual columns', async () => {
  const ws = makeWorkspace();
  const inv = path.join(ws, 'content-inventory.csv');
  fs.writeFileSync(inv, 'url,slug,title,page_type,intent_key,grade,x_flags,action,target_url,cluster_id,wave,imp_28d,clk_28d,ctr_28d,pos_28d,index_status,http_status,template_ratio,audited_at,notes,owner\nhttps://www.example.com/blog/cold-brew-b/,,,,,,,keep for now,,c-7,,,,,,,,,,do not touch,ana\n');
  const r = await runScript('content-audit.mjs', ['--workspace', ws, '--glob', path.join(DIR, '*.{md,html}'), '--url-template', 'https://www.example.com/blog/{slug}/', '--gsc-pages', path.join(FIXTURES, 'gsc-daily.json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Grades: A \d+ \| B \d+ \| C \d+ \| D \d+ \| X 3/);
  const csv = csvToRecords(fs.readFileSync(dataFile(ws, 'content', /content-audit\.csv$/), 'utf8'));
  const cold = csv.records.find((x) => x.url === 'https://www.example.com/recipes/cold-brew/');
  assert.ok(cold, 'front-matter url wins over the template');
  const after = csvToRecords(fs.readFileSync(inv, 'utf8'));
  const kept = after.records.find((x) => x.url === 'https://www.example.com/blog/cold-brew-ratio/' || x.url === 'https://www.example.com/blog/cold-brew-b/');
  assert.equal(kept.notes, 'do not touch');
  assert.equal(kept.action, 'keep for now');
  assert.equal(kept.owner, 'ana');
  assert.ok(after.headers.includes('owner') && after.headers.includes('word_eq'));
  assert.ok(fs.readdirSync(path.join(ws, 'logs', 'reviews')).some((f) => f.endsWith('content-audit.md')));
});
