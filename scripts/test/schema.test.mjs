import fs from 'node:fs';
import path from 'node:path';
import { test, assert, FIXTURES, tmpDir, makeWorkspace, runScript, runScriptSync, startServer, editConfig, dataFile } from './harness.mjs';
import { csvToRecords } from '../lib/csv.mjs';
import { parseIsoDate, parsePrice, parseRating, placeholderIn, numbersInText, statusFor, validateBlock, jsonPath, values, STATUS_RULES, ruleCatalog, LAST_VERIFIED } from '../lib/schema-rules.mjs';
import { sameAsKey, expandTypes, validatePages } from '../schema-validate.mjs';
import { compactKey } from '../lib/text.mjs';

const S = path.join(FIXTURES, 'schema');
const CRAWL = path.join(S, 'crawl-jsonld.jsonl');
const O = 'https://www.example.com';
const issuesOf = (file) => csvToRecords(fs.readFileSync(file, 'utf8'));
const find = (dir, suffix) => path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(suffix)));
const has = (rows, severity, rule, url = '', type = '') => rows.some((r) => r.severity === severity && r.rule === rule && (!url || r.url === `${O}${url}`) && (!type || r.type.split(',').includes(type)));
const page = (visible) => ({ url: `${O}/p/`, host: 'www.example.com', visibleText: visible, visibleKey: compactKey(visible), numbers: numbersInText(visible), now: Date.parse('2026-11-02T00:00:00Z') });
const ctx = (o) => ({ '@context': 'https://schema.org', ...o });

test('schema-validate: --help works without a workspace', () => {
  const r = runScriptSync('schema-validate.mjs', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node scripts\/schema-validate\.mjs/);
  assert.match(r.stdout, /Rich Results Test/);
});

test('schema-validate: value formats and helpers', () => {
  assert.ok(parseIsoDate('2026-10-02').ok && parseIsoDate('2026-10-02').dateOnly);
  assert.ok(parseIsoDate('2026-10-02T09:30:00+08:00').timezone);
  assert.ok(parseIsoDate('2026-10-02T09:30:00Z').timezone);
  assert.equal(parseIsoDate('2026-10-02T09:30:00').timezone, false);
  for (const bad of ['2026/10/02', '31/12/2026', '2026-02-30', 'yesterday']) assert.equal(parseIsoDate(bad).ok, false, bad);
  assert.ok(parsePrice('39.99').ok && parsePrice(0).ok);
  assert.match(parsePrice('€12,99').reason, /currency symbol/);
  assert.match(parsePrice('1,299').reason, /comma/);
  assert.deepEqual(parseRating('4.5'), { ok: true, value: 4.5 });
  assert.equal(parseRating('60%').percent, true);
  assert.equal(parseRating('6 / 10').best, 10);
  assert.equal(placeholderIn('{BRAND_NAME}'), 'template placeholder');
  assert.equal(placeholderIn('{首頁 title}'), 'template placeholder');
  assert.equal(placeholderIn('TODO: write this'), 'placeholder text');
  assert.equal(placeholderIn('https://example.com/x', 'www.example.org'), 'sample domain example.com');
  assert.equal(placeholderIn('https://www.example.com/x', 'www.example.com'), '');
  assert.equal(placeholderIn('Todo list app'), '');
  const nums = numbersInText('Now NT$1,280 or 39.99 and 1.299,00 rated 4.5 / 5');
  for (const n of [1280, 39.99, 1299, 4.5, 5]) assert.ok(nums.has(n), `number ${n}`);
  assert.equal(jsonPath(['@graph', 2, 'offers', 'price']), "$['@graph'][2].offers.price");
  assert.equal(values({ offers: [{ price: 1 }, { price: 2 }] }, 'offers.price').map((v) => v.value).join(','), '1,2');
  assert.equal(sameAsKey('https://www.Social.example.org/Example/'), 'social.example.org/example');
  assert.ok(expandTypes(['Article']).has('BlogPosting'));
  assert.ok(ruleCatalog().every((r) => r.docUrl.startsWith('https://') && r.lastVerified === LAST_VERIFIED));
});

test('schema-validate: retired and limited types are info, never errors (references/15 §15)', () => {
  const ids = STATUS_RULES.map((s) => s.id);
  for (const id of ['faq', 'howto', 'course-info', 'claim-review', 'estimated-salary', 'learning-video', 'special-announcement', 'vehicle-listing', 'practice-problem', 'dataset', 'book-actions', 'sitelinks-search-box', 'breadcrumb-mobile']) assert.ok(ids.includes(id), `status ${id}`);
  assert.equal(STATUS_RULES.find((s) => s.id === 'faq').since, '2026-05-07');
  assert.equal(STATUS_RULES.find((s) => s.id === 'book-actions').status, 'supported (limited)');
  assert.equal(statusFor({ '@type': 'WebSite', potentialAction: { '@type': 'SearchAction' } })[0].id, 'sitelinks-search-box');
  assert.equal(statusFor({ '@type': 'Car', offers: {} })[0].id, 'vehicle-listing');
  // structural problems inside a retired FAQPage are warnings; a question missing from the page stays an error
  const faq = validateBlock(ctx({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Is it visible?' }, { '@type': 'Question', name: 'Hidden question?', acceptedAnswer: { '@type': 'Answer', text: 'x' } }] }), { page: page('FAQ Is it visible? Yes.') });
  assert.ok(faq.some((i) => i.rule === 'required-missing' && i.severity === 'warning' && /acceptedAnswer/.test(i.detail)));
  assert.ok(faq.some((i) => i.rule === 'faq-not-visible' && i.severity === 'error' && /Hidden question/.test(i.detail)));
  assert.ok(!faq.some((i) => i.rule === 'faq-not-visible' && /Is it visible/.test(i.detail)));
  assert.ok(validateBlock(ctx({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: '水溫幾度？', acceptedAnswer: { '@type': 'Answer', text: '九十三度' } }] }), { page: page('常見問題 水溫 幾度 九十三度') }).every((i) => i.rule !== 'faq-not-visible'), 'CJK compare ignores spaces and punctuation');
});

test('schema-validate: per-type rules (Product, Offer, rating, Event, WebSite, Breadcrumb, Article, references)', () => {
  const rules = (data, visible = '') => validateBlock(data, { page: visible ? page(visible) : { url: `${O}/p/`, host: 'www.example.com', now: Date.now() } });
  const r1 = rules(ctx({ '@type': 'Product', name: 'Kettle' }));
  assert.ok(r1.some((i) => i.rule === 'required-one-of' && i.severity === 'error'));
  const r2 = rules(ctx({ '@type': 'Product', name: 'X', image: `${O}/x.png`, offers: { '@type': 'Offer', price: '0', priceCurrency: 'usd', availability: 'Reserved' }, aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', reviewCount: '12' } }), 'X costs 0 rated 4.5 by 12');
  assert.ok(r2.some((i) => i.rule === 'merchant-price-zero' && i.severity === 'warning'));
  assert.ok(r2.some((i) => i.rule === 'invalid-currency' && i.severity === 'warning' && /upper case/.test(i.detail)));
  assert.ok(r2.some((i) => i.rule === 'invalid-availability' && i.severity === 'info'));
  assert.ok(!r2.some((i) => i.severity === 'error'), JSON.stringify(r2.filter((i) => i.severity === 'error')));
  const r3 = rules(ctx({ '@type': 'Product', name: 'X', offers: { '@type': 'AggregateOffer', lowPrice: '10' }, review: { '@type': 'Review', reviewRating: { '@type': 'Rating', ratingValue: 7, bestRating: 10 } } }));
  assert.ok(r3.some((i) => i.rule === 'required-missing' && /priceCurrency/.test(i.detail)));
  assert.ok(r3.some((i) => i.rule === 'required-missing' && /author/.test(i.detail)));
  assert.ok(!r3.some((i) => i.rule === 'rating-out-of-range'), '7 of 10 is in range');
  const r4 = rules(ctx({ '@type': 'Event', name: 'Cupping', startDate: '2026-12-01T19:00+08:00', location: { '@type': 'Place', name: 'Lab' } }));
  assert.ok(r4.some((i) => i.rule === 'required-missing' && /address/.test(i.detail) && i.severity === 'error'));
  const r5 = rules(ctx({ '@type': 'WebSite', name: 'Example', url: `${O}/blog/` }));
  assert.ok(r5.some((i) => i.rule === 'website-url-not-home'));
  const r6 = rules(ctx({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${O}/` }, { '@type': 'ListItem', position: 3, name: 'Page' }] }));
  assert.ok(r6.some((i) => i.rule === 'invalid-value' && /positions should run/.test(i.detail)));
  assert.ok(!r6.some((i) => i.rule === 'required-missing'), 'the last item may omit item');
  const r7 = rules(ctx({ '@type': 'NewsArticle', headline: 'H', image: `${O}/i.jpg`, datePublished: '2026-10-05T10:00:00+08:00', dateModified: '2026-10-01T10:00:00+08:00', author: { '@type': 'Person', name: 'Jane Doe', url: `${O}/about/` } }));
  assert.ok(r7.some((i) => i.rule === 'date-order'));
  const r8 = rules(ctx({ '@graph': [{ '@type': 'Article', headline: 'H', publisher: { '@type': 'Organization' }, author: { '@id': `${O}/#jane` } }] }));
  assert.ok(r8.some((i) => i.rule === 'reference-incomplete' && /publisher/.test(i.detail)));
  assert.ok(!r8.some((i) => i.type === 'Organization' && i.rule === 'recommended-missing'), 'a publisher reference is not validated as a full Organization');
  const r9 = rules({ '@type': 'Article', headline: 'No context' });
  assert.ok(r9.some((i) => i.rule === 'context-missing' && i.severity === 'error'));
});

test('schema-validate: crawl fixture (graph, broken JSON, FAQ, Product, dates, @id, sameAs, retired types)', async () => {
  const out = tmpDir();
  const r = await runScript('schema-validate.mjs', ['--from-crawl', CRAWL, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Validated 12 page\(s\)/);
  assert.match(r.stdout, /passing is not a guarantee of rich results/);
  const { headers, records: rows } = issuesOf(find(out, '-schema-issues.csv'));
  assert.deepEqual(headers, ['severity', 'rule', 'url', 'type', 'path', 'detail', 'source']);
  for (const [severity, rule, url, type] of [
    ['error', 'jsonld-parse-error', '/blog/broken/'],
    ['error', 'faq-not-visible', '/blog/brew-guide/', 'FAQPage'],
    ['error', 'required-one-of', '/products/kettle/', 'Product'],
    ['error', 'invalid-currency', '/products/grinder/', 'Product'],
    ['error', 'invalid-price', '/products/grinder/', 'Product'],
    ['error', 'rating-out-of-range', '/products/grinder/', 'Product'],
    ['error', 'invalid-count', '/products/grinder/', 'Product'],
    ['error', 'required-missing', '/blog/brew-guide/', 'BreadcrumbList'],
    ['error', 'required-missing', '/shop/', 'CafeOrCoffeeShop'],
    ['error', 'required-missing', '/videos/latte-art/', 'VideoObject'],
    ['error', 'required-missing', '/glossary/bloom/', 'DefinedTerm'],
    ['warning', 'not-eligible', '/tools/ratio/', 'WebApplication'],
    ['error', 'event-not-physical', '/events/cupping/', 'Event'],
    ['error', 'context-missing', '/glossary/bloom/'],
    ['warning', 'invalid-date', '/blog/brew-guide/', 'BlogPosting'],
    ['warning', 'invalid-date', '/products/grinder/', 'Offer'],
    ['warning', 'invalid-availability', '/products/grinder/', 'Product'],
    ['warning', 'price-not-visible', '/products/kettle/', 'Product'],
    ['warning', 'dangling-id', '/'],
    ['warning', 'organization-multiple-ids'],
    ['warning', 'organization-conflict'],
    ['warning', 'id-type-conflict'],
    ['warning', 'url-not-canonical', '/blog/brew-guide/', 'BlogPosting'],
    ['warning', 'internal-url-variant', '/blog/brew-guide/', 'BlogPosting'],
    ['warning', 'same-as-not-https', '/', 'Organization'],
    ['warning', 'same-as-not-linked-on-site', '/', 'Organization'],
    ['warning', 'placeholder', '/tools/ratio/', 'WebApplication'],
    ['info', 'same-as-not-linked', '/', 'Organization'],
    ['info', 'date-no-timezone', '/blog/brew-guide/', 'BlogPosting'],
    ['info', 'breadcrumb-not-visible', '/blog/brew-guide/', 'BreadcrumbList'],
    ['info', 'self-serving-review', '/shop/', 'CafeOrCoffeeShop'],
    ['info', 'microdata-present', '/legacy/'],
  ]) assert.ok(has(rows, severity, rule, url, type), `missing ${severity} ${rule} ${url} ${type || ''}`);
  assert.ok(!has(rows, 'error', 'required-one-of', '/tools/ratio/'), 'an app without ratings is not eligible for stars, not broken');
  const parse = rows.find((x) => x.rule === 'jsonld-parse-error');
  assert.match(parse.detail, /starts with: \{"@context"/);
  assert.equal(rows.find((x) => x.rule === 'invalid-price').path, '$.offers.price');
  assert.match(rows.find((x) => x.rule === 'dangling-id').detail, /#founder/);
  assert.match(rows.find((x) => x.rule === 'same-as-not-linked').detail, /linked elsewhere on the site/);
  const retired = rows.filter((x) => ['retired-type', 'limited-type'].includes(x.rule));
  assert.ok(retired.length >= 5 && retired.every((x) => x.severity === 'info'));
  for (const t of ['FAQPage', 'HowTo', 'ClaimReview', 'WebSite', 'BreadcrumbList']) assert.ok(retired.some((x) => x.type.split(',').includes(t)), `status row for ${t}`);
  assert.ok(!rows.some((x) => x.severity === 'error' && ['HowTo', 'ClaimReview'].includes(x.type)), 'retired types never produce errors');
  assert.ok(!rows.some((x) => x.rule === 'organization-conflict' && x.url.endsWith('/shop/')), 'a LocalBusiness branch is not a second identity');
  const summary = JSON.parse(fs.readFileSync(find(out, '-schema-summary.json'), 'utf8'));
  assert.equal(summary.stats.parseErrors, 1);
  assert.equal(summary.graph.organizationIds.length, 2);
  assert.ok(summary.graph.dangling.includes(`${O}/#founder`));
  assert.equal(summary.status.find((s) => s.id === 'faq').since, '2026-05-07');
  assert.ok(summary.rules.find((x) => x.id === 'Product').docUrl.includes('product-snippet'));
  assert.equal(summary.counts.error, rows.filter((x) => x.severity === 'error').length);
  const md = fs.readFileSync(find(out, '-schema-summary.md'), 'utf8');
  assert.ok(md.includes('## Retired or limited types on this site') && md.includes('## Entity graph') && md.includes('Rich Results Test'));
});

test('schema-validate: newest crawl in a workspace, brand config, --types and --fail-on', async () => {
  const ws = makeWorkspace();
  editConfig(ws, (c) => {
    c.brand.officialName = 'Example Coffee Lab Ltd';
    c.brand.sameAs = ['https://social.example.org/examplecoffee'];
  });
  const dir = path.join(ws, 'data', 'crawl');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(CRAWL, path.join(dir, '2026-11-01-crawl-jsonld.jsonl'));
  fs.copyFileSync(path.join(S, 'crawl-links.jsonl'), path.join(dir, '2026-11-01-crawl-links.jsonl'));
  let r = await runScript('schema-validate.mjs', ['--workspace', ws]);
  assert.equal(r.status, 0, r.stderr);
  const rows = issuesOf(dataFile(ws, 'crawl', /-schema-issues\.csv$/)).records;
  assert.ok(has(rows, 'warning', 'organization-name-mismatch'));
  assert.ok(has(rows, 'info', 'same-as-config-mismatch'));
  assert.ok(dataFile(ws, 'crawl', /-schema-summary\.json$/) && dataFile(ws, 'crawl', /-schema-summary\.md$/));
  r = await runScript('schema-validate.mjs', ['--workspace', ws, '--from-crawl', '--types', 'Product', '--name', 'products']);
  assert.equal(r.status, 0, r.stderr);
  const products = issuesOf(dataFile(ws, 'crawl', /-products-issues\.csv$/)).records;
  assert.ok(products.length > 3 && products.every((x) => x.rule === 'jsonld-parse-error' || x.type.split(',').some((t) => ['Product', 'IndividualProduct', 'ProductModel', 'SomeProducts'].includes(t))), 'only Product rows (+ parse errors)');
  r = await runScript('schema-validate.mjs', ['--workspace', ws, '--fail-on', 'error', '--name', 'gate']);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Gate: FAILED \(--fail-on error\)/);
  r = await runScript('schema-validate.mjs', ['--workspace', ws, '--types', 'Organization', '--fail-on', 'error', '--name', 'org']);
  assert.equal(r.status, 2, 'the parse error is always reported and trips --fail-on error');
});

test('schema-validate: --build-dir run (offline asset check, placeholders)', async () => {
  const out = tmpDir();
  const r = await runScript('schema-validate.mjs', ['--build-dir', path.join(S, 'build'), '--out', out, '--fail-on', 'error']);
  assert.equal(r.status, 2, r.stderr);
  const rows = issuesOf(find(out, '-schema-issues.csv')).records;
  assert.ok(has(rows, 'warning', 'asset-missing', '/products/grinder/'));
  assert.ok(!rows.some((x) => x.rule === 'asset-missing' && /logo\.png/.test(x.detail)), 'logo.png exists in the build');
  assert.ok(has(rows, 'warning', 'placeholder', '/tools/ratio/'));
  assert.ok(has(rows, 'error', 'faq-not-visible', '/blog/brew-guide/'));
  assert.ok(has(rows, 'warning', 'same-as-not-linked-on-site', '/'));
});

test('schema-validate: --urls from a local site with --check-same-as and --check-assets', async () => {
  const graph = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', '@id': '{{ORIGIN}}/#organization', name: 'Example Coffee Lab', url: '{{ORIGIN}}/', logo: '{{ORIGIN}}/logo.png', sameAs: ['{{ORIGIN}}/profiles/ok', '{{ORIGIN}}/profiles/gone'] }, { '@type': 'Product', name: 'Dripper', image: '{{ORIGIN}}/img/none.png', offers: { '@type': 'Offer', price: '25.00', priceCurrency: 'EUR' } }] });
  const srv = await startServer({
    routes: {
      '/': { status: 200, body: `<html><head><title>Home</title><link rel="canonical" href="{{ORIGIN}}/"><script type="application/ld+json">${graph}</script></head><body><main><h1>Dripper</h1><p>25.00 EUR</p><a href="{{ORIGIN}}/profiles/ok">Profile</a></main></body></html>` },
      '/profiles/ok': { status: 200, body: '<html><body>profile</body></html>' },
      '/logo.png': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>not an image</html>' },
    },
  });
  try {
    const out = tmpDir();
    const r = await runScript('schema-validate.mjs', ['--urls', `${srv.origin}/`, '--check-same-as', '--check-assets', '--delay', '0', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const rows = issuesOf(find(out, '-schema-issues.csv')).records;
    assert.ok(rows.some((x) => x.rule === 'same-as-unreachable' && x.url.endsWith('/profiles/gone') && /HTTP 404/.test(x.detail)));
    assert.ok(!rows.some((x) => x.rule === 'same-as-unreachable' && x.url.endsWith('/profiles/ok')));
    assert.ok(rows.some((x) => x.rule === 'asset-not-image' && /logo\.png/.test(x.detail)));
    assert.ok(rows.some((x) => x.rule === 'asset-unreachable' && /none\.png/.test(x.detail)));
    assert.ok(rows.some((x) => x.rule === 'same-as-not-linked' && /profiles\/gone/.test(x.detail)));
  } finally {
    await srv.close();
  }
});

test('schema-validate: validatePages graph checks on hand-made pages', () => {
  const mk = (url, data, extra = {}) => ({ url, canonical: url, blocks: [{ types: [], error: '', data }], visibleText: 'Example Coffee Lab', links: [], microdataTypes: [], ...extra });
  const res = validatePages([
    mk(`${O}/`, { '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', '@id': `${O}/#organization`, name: 'Example Coffee Lab', url: `${O}/` }, { '@type': 'WebSite', name: 'Example Coffee Lab', url: `${O}/` }] }),
    mk(`${O}/a/`, { '@context': 'https://schema.org', '@type': 'Article', headline: 'A', url: `${O}/a/`, publisher: { '@id': `${O}/#organization` }, author: { '@id': `${O}/#nobody` } }),
    mk(`${O}/b/`, { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Example Lab', url: `${O}/` }),
  ], { mode: 'build' });
  const rules = res.issues.map((i) => i.rule);
  assert.ok(rules.includes('dangling-id'));
  assert.ok(!res.issues.some((i) => i.rule === 'dangling-id' && i.detail.includes('#organization')), 'defined on another page is not dangling');
  assert.ok(rules.includes('website-conflict'));
  assert.ok(!rules.includes('organization-multiple-ids'));
  assert.deepEqual(res.graph.organizationIds, [`${O}/#organization`]);
});

test('schema-validate: errors are actionable', () => {
  let r = runScriptSync('schema-validate.mjs', ['--workspace', path.join(tmpDir(), 'none')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No input/);
  r = runScriptSync('schema-validate.mjs', ['--build-dir', path.join(tmpDir(), 'missing')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--build-dir not found/);
  r = runScriptSync('schema-validate.mjs', ['--build-dir', S, '--from-crawl', CRAWL]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /one input at a time/);
  const ws = makeWorkspace();
  r = runScriptSync('schema-validate.mjs', ['--workspace', ws]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /crawl-site\.mjs/);
});

test('schema-validate: common valid shapes are not flagged (Yoast @id graph, variants, OfferCatalog, linked reviews)', () => {
  const mk = (data, visible) => ({ url: `${O}/p/`, canonical: `${O}/p/`, blocks: [{ types: [], error: '', data }], visibleText: visible, links: [], microdataTypes: [] });
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': `${O}/#organization`, name: 'Example Coffee Lab', url: `${O}/`, foundingDate: '2016' },
      { '@type': 'FAQPage', '@id': `${O}/p/#faq`, mainEntity: [{ '@id': `${O}/p/#q1` }, { '@id': `${O}/p/#q2` }] },
      { '@type': 'Question', '@id': `${O}/p/#q1`, name: 'What&#8217;s the best grind?', acceptedAnswer: { '@type': 'Answer', text: 'Medium <b>fine</b>.' } },
      { '@type': 'Question', '@id': `${O}/p/#q2`, name: 'Is this question hidden?', acceptedAnswer: { '@type': 'Answer', text: 'Yes.' } },
      { '@type': 'ProductGroup', '@id': `${O}/p/#group`, name: 'Wool coat', productGroupID: 'C1', variesBy: 'https://schema.org/size', hasVariant: [{ '@type': 'Product', isVariantOf: { '@id': `${O}/p/#group` }, url: `${O}/p/?size=small` }] },
      { '@type': 'Product', name: 'Wool coat large', image: `${O}/coat.jpg`, offers: { '@type': 'Offer', price: '120.00', priceCurrency: 'EUR' }, review: { '@id': `${O}/p/#r1` }, aggregateRating: { '@id': `${O}/p/#ar` } },
      { '@type': 'Review', '@id': `${O}/p/#r1`, author: { '@type': 'Person', name: 'Ann' }, reviewRating: { '@type': 'Rating', ratingValue: 5 } },
      { '@type': 'AggregateRating', '@id': `${O}/p/#ar`, ratingValue: 4.5, reviewCount: 8 },
      { '@type': 'Store', name: 'Shop', address: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressCountry: 'US' }, telephone: '+1-555-0100', url: `${O}/`, geo: { '@type': 'GeoCoordinates', latitude: 40.12345, longitude: -73.12345 }, openingHoursSpecification: { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Monday', opens: '09:00', closes: '17:00' }, hasOfferCatalog: { '@type': 'OfferCatalog', itemListElement: [{ '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Beans' } }] } },
    ],
  };
  const res = validatePages([mk(graph, 'Example Coffee Lab FAQ What’s the best grind? Medium fine. Wool coat 120.00 EUR rated 4.5 by 8')], { mode: 'crawl' });
  const bad = res.issues.filter((i) => i.severity !== 'info');
  assert.ok(bad.some((i) => i.rule === 'faq-not-visible' && /hidden/.test(i.detail)), 'questions given as @id references are checked');
  assert.ok(!bad.some((i) => i.rule === 'faq-not-visible' && /grind/.test(i.detail)), 'entities in names are decoded');
  assert.deepEqual(bad.filter((i) => i.rule !== 'faq-not-visible').map((i) => `${i.rule} ${i.path} ${i.detail}`), []);
  // an app WITH ratings must still carry offers.price
  const app = validateBlock(ctx({ '@type': 'SoftwareApplication', name: 'App', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4, ratingCount: 3 }, applicationCategory: 'UtilitiesApplication', operatingSystem: 'Web' }), { page: page('App rated 4') });
  assert.ok(app.some((i) => i.rule === 'required-missing' && i.severity === 'error' && /offers\.price/.test(i.detail)));
});

test('schema-validate: --build-dir with a body-less page and a --base-url path', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'guide'), { recursive: true });
  const faq = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Do I need a scale?', acceptedAnswer: { '@type': 'Answer', text: 'It helps.' } }] });
  const crumbs = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Docs', item: `${O}/docs/` }, { '@type': 'ListItem', position: 2, name: 'Guide', item: `${O}/docs/guide/` }] });
  fs.writeFileSync(path.join(dir, 'guide', 'index.html'), `<!doctype html><html><head><title>Guide</title><link rel="canonical" href="${O}/docs/guide/"><script type="application/ld+json">${faq}</script><script type="application/ld+json">${crumbs}</script></head><h1>Guide</h1><p>Docs Guide</p><h2>FAQ</h2><h3>Do I need a scale?</h3><p>It helps.</p>`);
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><title>Docs</title><link rel="canonical" href="${O}/docs/"></head><body><main><h1>Docs</h1><p>Docs home</p></main></body></html>`);
  const out = tmpDir();
  let r = await runScript('schema-validate.mjs', ['--build-dir', dir, '--base-url', `${O}/docs/`, '--out', out, '--fail-on', 'warning']);
  assert.equal(r.status, 0, `${r.stdout}\n${fs.readFileSync(find(out, '-schema-issues.csv'), 'utf8')}`);
  r = await runScript('schema-validate.mjs', ['--build-dir', dir, '--base-url', 'www.example.com', '--out', out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be an absolute URL/);
});
