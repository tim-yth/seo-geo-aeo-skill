import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test, assert, FIXTURES, tmpDir, makeWorkspace, runScript, runScriptSync, editConfig, dataFile } from './harness.mjs';
import {
  GEO_COLUMNS, LEGACY_COLUMNS, makeTermMatcher, stripLinkTargets, analyzeAnswer, domainSet, summarizeSamples, citedStability, appendGeoRows, readGeoLog, collectPrompts,
  hasPlaceholder, countryCode, isRecommended, mentionRank, outreachCandidates, sourceDomain, promptKey, clusterBootstrap,
} from '../lib/geo.mjs';
import { ADAPTERS, aggregateRun, manualRows } from '../geo-track.mjs';
import { wilsonInterval } from '../lib/stats.mjs';

const G = path.join(FIXTURES, 'geo');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(G, name), 'utf8'));
const KEYS = { openai: 'sk-test-openai-7f3a9c1d', perplexity: 'pplx-test-55aa77bb', anthropic: 'sk-ant-test-0b1c2d3e', gemini: 'AIza-test-gemini-9e8d' };
const NO_KEYS = { OPENAI_API_KEY: '', PERPLEXITY_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' };
const P1 = 'What are the best pour over coffee guides?';
const P2 = '推薦手沖咖啡教學網站';
const CONTROL = 'Recommend a good dentist in Berlin';

/** Local JSON API mock that reads request bodies (the harness server does not). */
async function startApiMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const entry = { method: req.method, path: url.pathname, headers: req.headers, body: json };
      requests.push(entry);
      const r = handler(entry) || { status: 404, json: { error: { message: `no mock for ${url.pathname}` } } };
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function engineMock() {
  const counters = new Map();
  const nth = (key) => {
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);
    return n;
  };
  const bad = (msg) => ({ status: 400, json: { error: { type: 'invalid_request_error', message: `mock check failed: ${msg}` } } });
  return (req) => {
    const b = req.body || {};
    if (req.path === '/openai') {
      if (req.headers.authorization !== `Bearer ${KEYS.openai}`) return { status: 401, json: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } } };
      if (b.model !== 'test-openai-model' || !b.tools || b.tools[0].type !== 'web_search' || !(b.include || []).includes('web_search_call.action.sources')) return bad('openai body');
      if (b.input === CONTROL) return { status: 500, json: { error: { message: 'The server had an error', type: 'server_error' } } };
      if (b.input === P2) return { json: fixture('openai-nosearch.json') };
      return { json: fixture(nth(`openai:${b.input}`) === 1 ? 'openai-cited.json' : 'openai-uncited.json') };
    }
    if (req.path === '/perplexity') {
      if (req.headers.authorization !== `Bearer ${KEYS.perplexity}`) return { status: 401, json: { error: { message: 'Invalid API key provided.', type: 'invalid_api_key', code: 401 } } };
      if (b.model !== 'perplexity/test-model' || !b.tools || b.tools[0].type !== 'web_search' || typeof b.input !== 'string') return bad('perplexity body');
      const r = fixture('perplexity.json');
      if (b.input === CONTROL) r.output[1].content[0].text = 'Example Coffee Lab is a coffee site, not a dentist; try a dental directory [web:3].';
      return { json: r };
    }
    if (req.path === '/anthropic') {
      if (req.headers['x-api-key'] !== KEYS.anthropic || req.headers['anthropic-version'] !== '2023-06-01') return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
      if (b.model !== 'test-claude-model' || !b.tools || b.tools[0].type !== 'web_search_20250305' || b.tools[0].name !== 'web_search' || b.messages[0].role !== 'user') return bad('anthropic body');
      const prompt = b.messages[0].content;
      if (prompt === P2) return { json: fixture('anthropic-tool-error.json') };
      if (prompt === CONTROL) {
        const r = fixture('anthropic.json');
        r.content[1].content = [{ type: 'web_search_result', url: 'https://dentists.example.org/berlin', title: 'Dentists in Berlin', encrypted_content: 'e' }];
        r.content[2] = { type: 'text', text: 'Try a dental directory.', citations: [{ type: 'web_search_result_location', url: 'https://dentists.example.org/berlin', title: 'Dentists', cited_text: '...' }] };
        r.content.length = 3;
        return { json: r };
      }
      return { json: fixture('anthropic.json') };
    }
    if (req.path === '/gemini/models/test-gemini-model:generateContent') {
      if (req.headers['x-goog-api-key'] !== KEYS.gemini) return { status: 400, json: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } };
      if (!b.tools || !b.tools[0].google_search || b.contents[0].parts[0].text === undefined) return bad('gemini body');
      return { json: fixture('gemini.json') };
    }
    return null;
  };
}

function geoWorkspace({ models = true, allowGemini = true } = {}) {
  const ws = makeWorkspace(['--brand-term', 'Example Coffee', '--brand-term', '範例咖啡', '--brand-name', 'Example Coffee Lab', '--competitor', 'rival.com']);
  fs.copyFileSync(path.join(G, 'geo-prompts-legacy.csv'), path.join(ws, 'geo-prompts.csv'));
  editConfig(ws, (c) => {
    c.geo = {
      models: models ? { openai: 'test-openai-model', perplexity: 'perplexity/test-model', anthropic: 'test-claude-model', gemini: 'test-gemini-model' } : { openai: '', perplexity: '', anthropic: '', gemini: '' },
      competitorBrands: ['Rival Brew'],
      controlPrompts: [CONTROL],
      allowGeminiGrounding: allowGemini,
      samples: 2,
      maxCalls: 100,
    };
  });
  return ws;
}

const envFor = (origin, keys = KEYS) => ({
  OPENAI_API_KEY: keys.openai || '',
  PERPLEXITY_API_KEY: keys.perplexity || '',
  ANTHROPIC_API_KEY: keys.anthropic || '',
  GEMINI_API_KEY: keys.gemini || '',
  SEO_AGENT_OPENAI_ENDPOINT: `${origin}/openai`,
  SEO_AGENT_PERPLEXITY_ENDPOINT: `${origin}/perplexity`,
  SEO_AGENT_ANTHROPIC_ENDPOINT: `${origin}/anthropic`,
  SEO_AGENT_GEMINI_ENDPOINT: `${origin}/gemini`,
});

function allText(dir) {
  const texts = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else texts.push(fs.readFileSync(f, 'utf8'));
    }
  };
  walk(dir);
  return texts.join('\n');
}

test('geo-track: --help works without a workspace', () => {
  const r = runScriptSync('geo-track.mjs', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node scripts\/geo-track\.mjs/);
  assert.match(r.stdout, /allowGeminiGrounding/);
});

test('geo-track: brand matching (Latin whole word, CJK substring, NFKC, short terms skipped)', () => {
  const m = makeTermMatcher(['Example Coffee', 'ECL', 'AB', '範例咖啡']);
  assert.ok(m.warnings.some((w) => /"AB"/.test(w)), 'short Latin term skipped with a warning');
  assert.ok(m.first('I like Example Coffee Lab.'));
  assert.ok(m.first('see examplecoffee.com'), 'space in a term also matches no separator');
  assert.ok(m.first('the example-coffee guide'));
  assert.equal(m.first('a counterexample coffee story'), null, 'whole word only');
  assert.ok(m.first('ECL is great'));
  assert.equal(m.first('ECLIPSE and eclectic'), null);
  assert.ok(m.first('ＥＣＬ（全形）'), 'NFKC folds full-width letters');
  assert.ok(m.first('我推薦範例咖啡的網站'), 'CJK substring without word boundaries');
  assert.equal(makeTermMatcher(['AB']).empty, true);
  assert.equal(stripLinkTargets('see [guide](https://www.example.com/x) and https://example.com/y'), 'see [guide] and  ');
  assert.equal(hasPlaceholder('Best {category} site'), true);
  assert.equal(hasPlaceholder('Best coffee site'), false);
  assert.equal(countryCode('twn'), 'TW');
  assert.equal(countryCode('US'), 'US');
  assert.equal(countryCode(''), '');
  assert.equal(sourceDomain('https://vertexaisearch.cloud.google.com/grounding-api-redirect/X', 'example.com'), 'example.com');
});

test('geo-track: answer analysis (funnel, cited rank, mention rank, recommended heuristic, competitors)', () => {
  const brand = makeTermMatcher(['Example Coffee']);
  const ctx = { brand, competitorBrands: [{ name: 'Rival Brew', matcher: makeTermMatcher(['Rival Brew']) }], ours: domainSet(['www.example.com']), competitors: domainSet(['rival.com']) };
  const parsed = ADAPTERS.openai.parse(fixture('openai-cited.json'));
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.cited[1].url, 'https://www.example.com/guides/pour-over/', 'utm_source stripped');
  assert.deepEqual(parsed.queries, ['best pour over coffee guides']);
  const a = analyzeAnswer(parsed, ctx);
  assert.equal(a.mentioned, true);
  assert.equal(a.rank, 2, 'Rival Brew appears before us');
  assert.equal(a.citedRank, 2);
  assert.equal(a.recommended, true);
  assert.deepEqual(a.competitorsCited, ['rival.com']);
  assert.deepEqual(a.competitorsMentioned, ['Rival Brew']);
  assert.deepEqual(a.funnel, { searched: 'y', retrieved: 'y', cited: 'y', mentioned: 'y', recommended: 'y' });
  const b = analyzeAnswer(ADAPTERS.openai.parse(fixture('openai-uncited.json')), ctx);
  assert.deepEqual([b.mentioned, b.funnel.retrieved, b.funnel.cited], [false, 'n', 'n']);
  const noSearch = ADAPTERS.openai.parse(fixture('openai-nosearch.json'));
  assert.equal(noSearch.status, 'no-search');
  assert.equal(analyzeAnswer(noSearch, ctx).funnel.cited, 'n/a');
  // link-only mention is not a brand mention; a citation chip whose text is our domain is not one either
  assert.equal(analyzeAnswer({ searched: true, sourcesExposed: false, cited: [], retrieved: [], text: 'Read [this guide](https://examplecoffee.com/x).' }, ctx).mentioned, false);
  const chip = analyzeAnswer({ searched: true, sourcesExposed: true, cited: [], retrieved: [], text: '1. Rival Brew ([examplecoffee.com](https://examplecoffee.com/x?utm_source=openai))' }, ctx);
  assert.deepEqual([chip.mentioned, chip.recommended], [false, false], 'being cited is not being mentioned');
  assert.equal(analyzeAnswer({ searched: true, sourcesExposed: true, cited: [], retrieved: [], text: 'examplecoffee.com explains ratios well.' }, ctx).mentioned, true, 'a domain named in prose is a mention');
  // stages the engine does not expose are n/a, never "no"
  const hidden = analyzeAnswer({ searched: true, sourcesExposed: false, cited: [{ url: 'https://www.example.com/a', domain: 'example.com' }], retrieved: [], text: 'x' }, ctx);
  assert.deepEqual([hidden.funnel.retrieved, hidden.funnel.cited], ['n/a', 'y']);
  assert.equal(analyzeAnswer({ searched: true, sourcesExposed: true, citationsExposed: false, cited: [], retrieved: [], text: 'x' }, ctx).funnel.cited, 'n/a');
  // list order fallback without competitor brands
  assert.deepEqual(mentionRank('1. Foo\n2. Bar\n3. Example Coffee', brand, []), { rank: 3, method: 'list-item' });
  assert.equal(isRecommended('Example Coffee exists.', brand), false);
  assert.equal(isRecommended('I recommend Example Coffee for beginners.', brand), true);
  assert.equal(isRecommended('Example Coffee has an entry level guide.', brand), false, 'no "try" inside "entry"');
  assert.equal(isRecommended('I would not recommend Example Coffee.', brand), false, 'negated');
  assert.equal(isRecommended('我推薦 Example Coffee 的教學。', brand), true);
});

test('geo-track: adapters parse Perplexity markers, Anthropic tool errors (HTTP 200) and Gemini grounding', () => {
  const p = ADAPTERS.perplexity.parse(fixture('perplexity.json'));
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.cited.map((c) => c.domain), ['example.com', 'rival.com'], '[web:N] markers map to search result ids');
  assert.equal(p.retrieved.length, 3);
  const legacy = ADAPTERS.perplexity.parse({ model: 'sonar', choices: [{ message: { content: 'Example [1]' }, finish_reason: 'stop' }], citations: ['https://www.example.com/a'], search_results: [{ url: 'https://www.example.com/a', title: 'A' }] });
  assert.equal(legacy.cited[0].domain, 'example.com');
  const a = ADAPTERS.anthropic.parse(fixture('anthropic.json'));
  assert.equal(a.status, 'ok');
  assert.deepEqual(a.queries, ['best pour over coffee guides']);
  assert.equal(a.cited[0].url, 'https://www.example.com/guides/pour-over/');
  const err = ADAPTERS.anthropic.parse(fixture('anthropic-tool-error.json'));
  assert.equal(err.status, 'failed');
  assert.match(err.error, /too_many_requests/);
  const paused = ADAPTERS.anthropic.parse({ ...fixture('anthropic.json'), stop_reason: 'pause_turn' });
  assert.equal(paused.paused, true);
  const g = ADAPTERS.gemini.parse(fixture('gemini.json'));
  assert.equal(g.status, 'ok');
  assert.deepEqual(g.cited.map((c) => c.domain), ['example.com'], 'cited = chunks referenced by groundingSupports');
  assert.deepEqual(g.retrieved.map((c) => c.domain), ['example.com', 'rival.com'], 'domain from the chunk title (URIs are redirects)');
  assert.equal(g.modelServed, 'test-gemini-served');
  assert.ok(g.retrieved.every((x) => x.url === ''), 'Gemini redirect links are not stored');
  const gNoDomain = fixture('gemini.json');
  gNoDomain.candidates[0].groundingMetadata.groundingChunks = [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/C', title: 'A long page title' } }, { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/D', title: 'Guide', domain: 'example.org' } }];
  assert.deepEqual(ADAPTERS.gemini.parse(gNoDomain).retrieved.map((x) => x.domain), ['example.org'], 'the redirect host is never a cited domain');
  const pNoMarkers = fixture('perplexity.json');
  pNoMarkers.output[1].content[0].text = 'Example Coffee Lab has good guides.';
  const pn = ADAPTERS.perplexity.parse(pNoMarkers);
  assert.equal(pn.citationsExposed, false, 'no annotations and no [n] markers: citations not exposed');
  const req = ADAPTERS.openai.request({ model: 'm', prompt: 'q', country: '', apiKey: 'k', endpoint: 'http://x' });
  assert.deepEqual(req.body.tools[0].user_location, { type: 'approximate' }, 'no US default when the country is unknown');
});

test('geo-track: Wilson aggregation, denominators exclude failures/no-search/branded, stability and outreach', () => {
  const mk = (o) => ({ engine: 'openai', promptId: 'p1', arm: '', branded: 'n', def: { prompt: 'x', cohort: 'core' }, status: 'ok', analysis: { mentioned: false, citedDomains: [], competitorsCited: [], competitorsMentioned: [], funnel: { searched: 'y', retrieved: 'n', cited: 'n', mentioned: 'n', recommended: 'n' } }, ...o });
  const yes = (o = {}) => mk({ analysis: { mentioned: true, citedDomains: ['example.com'], competitorsCited: [], competitorsMentioned: [], funnel: { searched: 'y', retrieved: 'y', cited: 'y', mentioned: 'y', recommended: 'n' } }, ...o });
  const samples = [...Array.from({ length: 4 }, () => yes()), ...Array.from({ length: 6 }, () => mk()), mk({ status: 'failed', analysis: null }), mk({ status: 'failed', analysis: null }), mk({ status: 'no-search' })];
  const s = summarizeSamples(samples);
  assert.equal(s.valid, 10);
  assert.equal(s.failed, 2);
  assert.equal(s.noSearch, 1);
  const w = wilsonInterval(4, 10);
  assert.deepEqual([s.mention.k, s.mention.n, s.mention.small], [4, 10, true]);
  assert.ok(Math.abs(s.mention.low - w.low) < 1e-12 && Math.abs(s.mention.high - w.high) < 1e-12);
  const ctx = { ours: domainSet(['example.com']), competitors: domainSet(['rival.com']), brand: makeTermMatcher(['Example Coffee']) };
  const branded = Array.from({ length: 3 }, () => yes({ branded: 'y', promptId: 'b1' }));
  const agg = aggregateRun([...samples, ...branded], ctx);
  assert.equal(agg.byEngine[0].valid, 10, 'branded prompts are excluded from the main rates');
  assert.ok(agg.byArm.some((x) => x.arm === 'branded' && x.mention.k === 3));
  const boot = clusterBootstrap([...Array.from({ length: 5 }, () => yes({ promptId: 'a' })), ...Array.from({ length: 5 }, () => mk({ promptId: 'b' }))], 'mentioned');
  assert.deepEqual([boot.prompts, boot.iterations, boot.seed], [2, 2000, 7]);
  assert.ok(boot.low === 0 && boot.high === 1, 'two prompts at 100% and 0%: the cluster interval spans everything');
  assert.deepEqual(clusterBootstrap([yes()], 'mentioned'), null);
  assert.deepEqual(clusterBootstrap([yes({ promptId: 'a' }), yes({ promptId: 'b' })], 'mentioned'), clusterBootstrap([yes({ promptId: 'a' }), yes({ promptId: 'b' })], 'mentioned'), 'seeded: deterministic');
  const j = citedStability([yes(), mk({ analysis: { ...yes().analysis, citedDomains: ['example.com', 'other.org'] } })]);
  assert.equal(j, 0.5);
  const out = outreachCandidates([
    mk({ analysis: { mentioned: false, citedDomains: ['rival.com', 'list.example.net', 'wiki.example.org'], competitorsCited: ['rival.com'], competitorsMentioned: [], funnel: {} } }),
    mk({ analysis: { mentioned: true, citedDomains: ['example.com', 'wiki.example.org'], competitorsCited: [], competitorsMentioned: [], funnel: {} } }),
  ], ctx);
  assert.deepEqual(out.map((o) => o.domain), ['list.example.net'], 'domains also cited with us are not outreach candidates');
});

test('geo-track: appending to an existing 14-column CSV keeps old rows, columns, BOM and CRLF', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'geo-prompts.csv');
  fs.writeFileSync(file, `\uFEFF${fs.readFileSync(path.join(G, 'geo-prompts-legacy.csv'), 'utf8')}`);
  const before = readGeoLog(file);
  assert.deepEqual(before.headers, LEGACY_COLUMNS);
  const row = Object.fromEntries(GEO_COLUMNS.map((c) => [c, '']));
  Object.assign(row, { run_date: '2026-11-02', engine: 'openai-api', locale: 'en', prompt: P1, prompt_id: promptKey(P1, 'en'), k: '1', notes: 'auto run=r1' });
  const r1 = appendGeoRows(file, [row]);
  assert.equal(r1.rewritten, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('\uFEFF'), 'BOM kept');
  assert.ok(/\r\n/.test(text) && !/[^\r]\n/.test(text), 'CRLF kept');
  const after = readGeoLog(file);
  assert.deepEqual(after.headers, GEO_COLUMNS, 'missing columns added at the end, in order');
  assert.equal(after.records.length, 4);
  assert.equal(after.records[0].notes, 'manual row kept');
  assert.equal(after.records[1].notes, 'manual, with comma');
  assert.equal(after.records[3].prompt_id, promptKey(P1, 'en'));
  const r2 = appendGeoRows(file, [{ ...row, k: '2' }]);
  assert.equal(r2.rewritten, false, 'header complete: rows appended in place');
  assert.equal(readGeoLog(file).records.length, 5);
  const { prompts, placeholders } = collectPrompts(readGeoLog(file).records);
  assert.equal(placeholders, 1);
  assert.equal(prompts.length, 2, 'rows without prompt_id and automated rows with the hash id are one definition');
  assert.equal(prompts.find((p) => p.prompt === P1).lastDate, '2026-11-02', 'the latest row supplies the metadata');
  // extra user columns survive a rewrite
  const custom = path.join(dir, 'custom.csv');
  fs.writeFileSync(custom, 'run_date,engine,prompt,my_column\n2026-10-01,chatgpt,hello,keep me\n');
  appendGeoRows(custom, [row]);
  const c = readGeoLog(custom);
  assert.deepEqual(c.headers.slice(0, 4), ['run_date', 'engine', 'prompt', 'my_column']);
  assert.equal(c.records[0].my_column, 'keep me');
  assert.throws(() => {
    fs.writeFileSync(custom, 'run_date,engine\n2026-10-01,chatgpt,extra,cells\n');
    readGeoLog(custom);
  }, /more cells than the header/);
  // lossless rewrite: duplicate and empty header names, raw header cells, newlines inside quoted cells, .bak kept
  const odd = path.join(dir, 'odd.csv');
  fs.writeFileSync(odd, ' run_date ,notes,notes,,prompt\r\n2026-10-01,first note,second note,x,"multi\r\nline"\r\n');
  const res = appendGeoRows(odd, [row]);
  assert.equal(res.rewritten, true);
  assert.ok(fs.existsSync(`${odd}.bak`));
  const oddText = fs.readFileSync(odd, 'utf8');
  assert.ok(oddText.startsWith('" run_date ",notes,notes,,prompt,engine,'), 'header cells kept (whitespace preserved by quoting), missing columns appended');
  assert.deepEqual(readGeoLog(odd).records[1].run_date, '2026-11-02', 'new rows map to the trimmed column name');
  assert.ok(oddText.includes('2026-10-01,first note,second note,x,"multi\r\nline"'), 'old row kept cell by cell');
  assert.ok(!oddText.includes('\r\r\n'), 'quoted newlines untouched');
  // non-UTF-8 (e.g. Big5 from Excel) is refused before anything is sent or rewritten
  const big5 = path.join(dir, 'big5.csv');
  const bytes = Buffer.concat([Buffer.from('run_date,engine,prompt\n2026-10-01,chatgpt,'), Buffer.from([0xb1, 0xc0, 0xc2, 0xcb]), Buffer.from('\n')]);
  fs.writeFileSync(big5, bytes);
  assert.throws(() => appendGeoRows(big5, [row]), /is not UTF-8 text/);
  assert.ok(fs.readFileSync(big5).equals(bytes), 'file unchanged');
});

test('geo-track: dry run prints the plan without calling APIs; --max-calls gate exits 2', async () => {
  const mock = await startApiMock(engineMock());
  try {
    const ws = geoWorkspace();
    fs.appendFileSync(path.join(ws, 'geo-prompts.csv'), '2026-01-05,perplexity,zh-TW,x,Template example prompt,yes,3,,,,,,,範例列：未登入\r\n');
    editConfig(ws, (c) => {
      c.geo.maxCalls = null;
    });
    const dry = await runScript('geo-track.mjs', ['--workspace', ws], { env: envFor(mock.origin) });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run: no API call was made/);
    assert.match(dry.stdout, /Cap: 24 of 100 calls/, 'geo.maxCalls null = default cap');
    assert.match(dry.stdout, /What are the best pour over coffee guides\?/, 'the plan lists the prompts');
    assert.ok(!dry.stdout.includes('Template example prompt'));
    assert.match(dry.stdout, /1 template example row\(s\)/);
    assert.match(dry.stdout, /total\s+24/);
    assert.match(dry.stdout, /1 skipped \(template placeholders\)/);
    assert.equal(mock.requests.length, 0, 'no API call in a dry run');
    const json = await runScript('geo-track.mjs', ['--workspace', ws, '--json', '--engines', 'openai,anthropic'], { env: envFor(mock.origin) });
    assert.equal(json.status, 0, json.stderr);
    const plan = JSON.parse(json.stdout);
    assert.equal(plan.totalCalls, 12);
    assert.deepEqual(plan.engines.map((e) => e.engine), ['openai', 'anthropic']);
    const capped = await runScript('geo-track.mjs', ['--workspace', ws, '--run', '--max-calls', '5'], { env: envFor(mock.origin) });
    assert.equal(capped.status, 2, capped.stderr);
    assert.match(capped.stderr, /Cost guard: 24 calls .* exceed the per-run cap of 5/);
    assert.equal(mock.requests.length, 0, 'the gate stops before any call');
    editConfig(ws, (c) => {
      c.providers = { openai: { monthlyBudgetUSD: 0.05, perCallUSD: 0.03 } };
    });
    const budget = await runScript('geo-track.mjs', ['--workspace', ws, '--engines', 'openai'], { env: envFor(mock.origin) });
    assert.equal(budget.status, 2);
    assert.match(budget.stderr, /monthly budget/);
  } finally {
    await mock.close();
  }
});

test('geo-track: --run against mocked OpenAI, Perplexity, Anthropic and Gemini APIs', async () => {
  const mock = await startApiMock(engineMock());
  try {
    const ws = geoWorkspace();
    const r = await runScript('geo-track.mjs', ['--workspace', ws, '--run', '--delay', '0', '--retry-ms', '1'], { env: envFor(mock.origin) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GEO run r\d{6}-[0-9a-f]{4}: 24 call\(s\), 24 sample\(s\)/);
    assert.match(r.stdout, /Negative-control prompts mentioned the brand in 4 of 6/);
    assert.match(r.stderr, /notice: geo\.allowGeminiGrounding is true/);
    assert.equal(mock.requests.filter((q) => q.path === '/openai' && q.body && q.body.input === CONTROL).length, 6, 'HTTP 500 retried twice per sample');
    // CSV: old 14 columns first, new columns appended, old rows intact, one row per sample
    const log = readGeoLog(path.join(ws, 'geo-prompts.csv'));
    assert.deepEqual(log.headers, GEO_COLUMNS);
    assert.equal(log.records.length, 3 + 24);
    assert.equal(log.records[0].notes, 'manual row kept');
    const auto = log.records.slice(3);
    assert.deepEqual([...new Set(auto.map((x) => x.engine))].sort(), ['anthropic-api', 'gemini-api', 'openai-api', 'perplexity-api']);
    const o1 = auto.find((x) => x.engine === 'openai-api' && x.prompt === P1 && x.k === '1');
    assert.deepEqual([o1.mentioned, o1.rank, o1.cited_url, o1.searched, o1.retrieved, o1.cited, o1.recommended, o1.method], ['yes', '2', 'https://www.example.com/guides/pour-over/', 'y', 'y', 'y', 'y', 'api:test-openai-model']);
    assert.equal(o1.cited_domains, 'rival.com;example.com;reviews.example.org');
    assert.match(o1.competitors, /Rival Brew/);
    assert.match(o1.notes, /^auto run=r\d{6}-[0-9a-f]{4}; cited_rank=2$/);
    assert.equal(o1.reason, '');
    assert.equal(o1.accuracy, '');
    const ctrl = auto.find((x) => x.engine === 'openai-api' && x.prompt === CONTROL);
    assert.equal(ctrl.arm, 'negative');
    assert.match(ctrl.notes, /failed: HTTP 500/);
    const toolErr = auto.find((x) => x.engine === 'anthropic-api' && x.prompt === P2);
    assert.match(toolErr.notes, /too_many_requests/);
    assert.equal(toolErr.mentioned, '');
    const gem = auto.find((x) => x.engine === 'gemini-api' && x.prompt === P1);
    assert.equal(gem.cited, 'y');
    assert.equal(gem.cited_url, '', 'redirect URLs are not recorded as our cited URL');
    // summary, answers, report, spend
    const summary = JSON.parse(fs.readFileSync(dataFile(ws, 'geo', /-summary\.json$/), 'utf8'));
    const byEngine = Object.fromEntries(summary.byEngine.map((x) => [x.engine, x]));
    assert.deepEqual([byEngine.openai.valid, byEngine.openai.noSearch, byEngine.openai.mention.k], [2, 2, 1]);
    assert.deepEqual([byEngine.anthropic.valid, byEngine.anthropic.failed], [2, 2]);
    assert.equal(byEngine.perplexity.cited.k, 4);
    assert.ok(summary.outreach.some((o) => o.domain === 'listicle.example.net'));
    assert.ok(!summary.outreach.some((o) => o.domain === 'reviews.example.org'));
    assert.equal(summary.diagnostics.negativeMentions, 4);
    const answers = fs.readFileSync(dataFile(ws, 'geo', /-answers\.jsonl$/), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(answers.length, 24);
    assert.ok(answers.every((a) => !('headers' in a)));
    assert.ok(fs.readFileSync(dataFile(ws, 'geo', /-summary\.csv$/), 'utf8').startsWith('level,engine,prompt_id'));
    const report = fs.readFileSync(path.join(ws, 'logs', 'reviews', fs.readdirSync(path.join(ws, 'logs', 'reviews')).find((f) => f.endsWith('-geo-track.md'))), 'utf8');
    for (const s of ['## Per engine', '## Per arm', '## Outreach candidates', 'listicle.example.net', 'Evidence level', 'Prompt-cluster bootstrap 95% intervals']) assert.ok(report.includes(s), `report misses ${s}`);
    const spend = fs.readFileSync(path.join(ws, 'logs', 'spend.csv'), 'utf8');
    for (const e of ['openai', 'perplexity', 'anthropic', 'gemini']) assert.match(spend, new RegExp(`,${e},geo-track\\.mjs,6,`));
    const everything = `${allText(ws)}\n${r.stdout}\n${r.stderr}`;
    for (const k of Object.values(KEYS)) assert.ok(!everything.includes(k), 'API key leaked');
  } finally {
    await mock.close();
  }
});

test('geo-track: manual checklist (explicit and when no engine is runnable)', async () => {
  const ws = geoWorkspace({ models: false });
  const r = await runScript('geo-track.mjs', ['--workspace', ws], { env: { ...NO_KEYS, SEO_AGENT_OPENAI_ENDPOINT: 'http://127.0.0.1:9/x' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No engine can be called/);
  assert.match(r.stdout, /logged-out, clean browser/);
  const file = dataFile(ws, 'geo', /-manual-checklist\.csv$/);
  const log = readGeoLog(file);
  assert.deepEqual(log.headers, GEO_COLUMNS);
  assert.equal(log.records.length, 3 * 5 * 2, 'prompts x config.aiEngines x samples');
  assert.deepEqual([...new Set(log.records.map((x) => x.engine))], ['chatgpt', 'perplexity', 'gemini', 'google-ai-overviews', 'copilot']);
  assert.ok(log.records.every((x) => x.method === 'ui-manual' && x.mentioned === ''));
  assert.deepEqual([...new Set(log.records.map((x) => x.k))], ['1', '2']);
  assert.equal(log.records.find((x) => x.prompt === CONTROL).arm, 'negative');
  const m = await runScript('geo-track.mjs', ['--workspace', ws, '--manual', '--samples', '1', '--prompt-id', collectPrompts(readGeoLog(path.join(ws, 'geo-prompts.csv')).records).prompts[0].id], { env: NO_KEYS });
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /1 prompt\(s\) x 5 engine\(s\) .* = 5 row\(s\)/);
  const rows = manualRows([{ id: 'p1', prompt: 'x', locale: 'en', intent: '', portfolio_version: 'v1', cohort: 'core', arm: '', variant_group: '', branded: 'n', topic: '', country: 'US' }], ['chatgpt'], 2, '2026-11-02');
  assert.deepEqual(rows.map((x) => x.k), ['1', '2']);
});

test('geo-track: errors (model missing for a selected engine, Gemini terms, secret in a prompt, no prompts)', async () => {
  const ws = geoWorkspace({ models: false, allowGemini: false });
  const env = { ...NO_KEYS, OPENAI_API_KEY: KEYS.openai, GEMINI_API_KEY: KEYS.gemini, SEO_AGENT_OPENAI_ENDPOINT: 'http://127.0.0.1:9/x', SEO_AGENT_GEMINI_ENDPOINT: 'http://127.0.0.1:9/x' };
  const noModel = await runScript('geo-track.mjs', ['--workspace', ws, '--engines', 'openai'], { env });
  assert.equal(noModel.status, 1);
  assert.match(noModel.stderr, /geo\.models\.openai is empty/);
  assert.match(noModel.stderr, /developers\.openai\.com\/api\/docs\/models/);
  editConfig(ws, (c) => {
    c.geo.models.gemini = 'test-gemini-model';
  });
  const gem = await runScript('geo-track.mjs', ['--workspace', ws, '--engines', 'gemini'], { env });
  assert.equal(gem.status, 0, gem.stderr);
  assert.match(gem.stderr, /Gemini API Additional Terms restrict storing/);
  assert.match(gem.stdout, /Writing the manual UI checklist instead/);
  fs.appendFileSync(path.join(ws, 'geo-prompts.csv'), `2026-10-02,chatgpt,en,x,leaked ${KEYS.openai} in a prompt,,,,,,,,,\r\n`);
  editConfig(ws, (c) => {
    c.geo.models.openai = 'test-openai-model';
  });
  const secret = await runScript('geo-track.mjs', ['--workspace', ws, '--engines', 'openai'], { env });
  assert.equal(secret.status, 1);
  assert.match(secret.stderr, /Refusing to send 1 prompt/);
  assert.ok(!secret.stderr.includes(KEYS.openai));
  const empty = makeWorkspace();
  const none = await runScript('geo-track.mjs', ['--workspace', empty], { env: NO_KEYS });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No usable prompt/);
});

test('geo-track: run edge cases (pause_turn continuation, keys echoed in errors, 401 stop and exit 1, --no-controls after a run)', async () => {
  const paused = new Set();
  const mock = await startApiMock((req) => {
    const b = req.body || {};
    if (req.path === '/anthropic') {
      const prompt = b.messages[0].content;
      if (prompt === P1 && b.messages.length === 1) {
        // first leg of a long server-tool turn
        const r = fixture('anthropic.json');
        r.stop_reason = 'pause_turn';
        r.content = r.content.slice(0, 2);
        paused.add(req.body);
        return { json: r };
      }
      if (prompt === P1) {
        if (b.messages[1].role !== 'assistant' || b.messages[1].content[0].type !== 'server_tool_use') return { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad continuation' } } };
        const r = fixture('anthropic.json');
        r.content = r.content.slice(2);
        return { json: r };
      }
      return { json: fixture('anthropic.json') };
    }
    if (req.path === '/openai') {
      if (b.input === P1) return { json: { id: 'r', status: 'failed', model: 'm', output: [], error: { code: 'server_error', message: `upstream rejected credential ${KEYS.openai}` } } };
      return { status: 401, json: { error: { message: `Incorrect API key provided: ${KEYS.openai}`, type: 'invalid_request_error', code: 'invalid_api_key' } } };
    }
    return null;
  });
  try {
    const ws = geoWorkspace();
    const env = envFor(mock.origin);
    const r = await runScript('geo-track.mjs', ['--workspace', ws, '--run', '--engines', 'anthropic,openai', '--delay', '0', '--retry-ms', '1'], { env });
    assert.equal(r.status, 1, 'an engine stopped on HTTP 401: exit 1 after writing the outputs');
    assert.match(r.stderr, /an engine stopped early/);
    assert.match(r.stdout, /openai: stopped early, openai returned HTTP 401/);
    assert.equal(mock.requests.filter((q) => q.path === '/anthropic').length, 6 + 2, 'two pause_turn continuations');
    const answers = fs.readFileSync(dataFile(ws, 'geo', /-answers\.jsonl$/), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(answers.length, 12);
    const resumed = answers.filter((a) => a.engine === 'anthropic' && a.prompt === P1);
    assert.ok(resumed.every((a) => a.status === 'ok' && a.analysis.funnel.cited === 'y' && a.queries[0] === 'best pour over coffee guides'), 'paused turn resumed and merged');
    assert.equal(answers.filter((a) => /^not called/.test(a.error)).length, 3);
    const log = readGeoLog(path.join(ws, 'geo-prompts.csv'));
    const auto = log.records.slice(3);
    assert.equal(auto.length, 6 + 3, 'never-sent samples stay out of geo-prompts.csv');
    assert.ok(auto.some((x) => x.engine === 'openai-api' && /failed: HTTP 401/.test(x.notes)));
    const spend = fs.readFileSync(path.join(ws, 'logs', 'spend.csv'), 'utf8');
    assert.match(spend, /,anthropic,geo-track\.mjs,8,/);
    assert.match(spend, /,openai,geo-track\.mjs,3,/);
    const everything = `${allText(ws)}\n${r.stdout}\n${r.stderr}`;
    assert.ok(!everything.includes(KEYS.openai), 'key echoed by the API is redacted everywhere');
    assert.ok(everything.includes('<$OPENAI_API_KEY>'));
    // controls come from config on every run: --no-controls really drops them even after ctl- rows were logged
    const noCtl = await runScript('geo-track.mjs', ['--workspace', ws, '--no-controls', '--engines', 'anthropic'], { env });
    assert.equal(noCtl.status, 0, noCtl.stderr);
    assert.match(noCtl.stdout, /Prompts: 2 from geo-prompts\.csv/);
    assert.ok(!/ctl-/.test(noCtl.stdout));
    // --run with nothing runnable: checklist written, exit 1
    const none = await runScript('geo-track.mjs', ['--workspace', ws, '--run'], { env: NO_KEYS });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /No engine can be called/);
    assert.ok(dataFile(ws, 'geo', /-manual-checklist\.csv$/));
  } finally {
    await mock.close();
  }
});
