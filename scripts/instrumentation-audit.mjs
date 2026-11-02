#!/usr/bin/env node
// Measurement audit: what tags run on each page group (live, static HTML) and in the source repo, what is
// wrong (duplicates, delayed loaders, reserved/PII params), and a plain-language "where to insert what" plan.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, collectList, normalizeUrl, rateLimiter, mapLimit } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { fetchPage, fetchRobots, discoverSitemaps, collectSitemapUrls, isHtml, DEFAULT_UA } from './lib/http.mjs';
import { parseHtml } from './lib/html.mjs';
import { mdTable, fmtPct } from './lib/format.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  'max-per-group': { type: 'int', desc: 'Sample URLs per page group (from the sitemap)', default: 5 },
  urls: { type: 'csv', placeholder: 'url,...', desc: 'Extra URLs to check' },
  'no-live': { type: 'boolean', desc: 'Skip the live page checks' },
  'no-repo': { type: 'boolean', desc: 'Skip the source repo scan' },
  repo: { type: 'string', placeholder: 'path', desc: 'Source repo to scan (default config repo.path)' },
  'max-files': { type: 'int', desc: 'Max files to scan in the repo', default: 5000 },
  delay: { type: 'int', placeholder: 'ms', desc: 'Gap between page requests', default: 300 },
  concurrency: { type: 'int', desc: 'Parallel page requests', default: 3 },
  timeout: { type: 'int', placeholder: 'ms', desc: 'Per-request timeout', default: 20000 },
  'user-agent': { type: 'string', placeholder: 'ua', desc: 'User-Agent for page requests', default: DEFAULT_UA },
  json: { type: 'boolean', desc: 'Print the audit JSON' },
};

const HELP = formatHelp({
  usage: 'node scripts/instrumentation-audit.mjs [--max-per-group 5] [--repo /path/to/site] [--no-live|--no-repo]',
  summary:
    'Checks a sample of pages per page group for GA4 (G-), GTM (GTM-), Google Ads (AW-) and Google tag (GT-) IDs, duplicate or multiple GA4 ' +
    'IDs, groups without any tag, delayed/lazy tag loaders (they undercount short visits), Consent Mode defaults and CMPs, other analytics, ' +
    'GSC/Bing verification metas, JSON-LD and canonical presence, and the IndexNow key file. Scans the source repo for the framework, the ' +
    'files where a tag belongs, and existing gtag/dataLayer/Measurement Protocol calls with their event names and parameters, flagging ' +
    'reserved GA4 names (e.g. a custom "source" overwrites traffic attribution) and personal data. Writes data/instrumentation/<today>-audit.json ' +
    'and logs/reviews/<today>-instrumentation-plan.md.',
  spec: SPEC,
  examples: ['node scripts/instrumentation-audit.mjs', 'node scripts/instrumentation-audit.mjs --repo ../my-site --max-per-group 3'],
  notes: [
    'Static HTML only: tags injected at runtime (by GTM, a tag manager in the CDN, or client-side rendering) are invisible here; pages that look JS-rendered are marked.',
    'Evidence levels differ: code in the repo != tag live in production != data received in GA4. Confirm in GA4 DebugView/Realtime before calling measurement done.',
  ],
});

// ---------- live detection ----------
const CMPS = [
  ['Cookiebot', /consent\.cookiebot\.com|cookiebot/i],
  ['OneTrust', /cdn\.cookielaw\.org|optanon|onetrust/i],
  ['CookieYes', /cookieyes/i],
  ['Usercentrics', /usercentrics/i],
  ['Didomi', /privacy-center\.org|didomi/i],
  ['Termly', /app\.termly\.io/i],
  ['iubenda', /iubenda/i],
  ['Complianz', /cmplz|complianz/i],
  ['Osano', /osano\.com/i],
  ['Quantcast Choice', /quantcast\.(mgr\.consensu\.org|com\/choice)|cmp\.quantcast/i],
];
const OTHER_ANALYTICS = [
  ['Meta Pixel', /connect\.facebook\.net\/[^"']*fbevents|fbq\(\s*['"]init/i],
  ['Microsoft Clarity', /clarity\.ms\/tag|clarity\(/i],
  ['Hotjar', /static\.hotjar\.com|hotjar/i],
  ['Plausible', /plausible\.io\/js/i],
  ['Fathom', /cdn\.usefathom\.com/i],
  ['Umami', /umami[^"']*\.js|data-website-id/i],
  ['Matomo', /matomo\.js|piwik\.js|_paq\.push/i],
  ['Cloudflare Web Analytics', /static\.cloudflareinsights\.com/i],
  ['Vercel Analytics', /\/_vercel\/insights|@vercel\/analytics/i],
  ['PostHog', /posthog\.init|i\.posthog\.com/i],
  ['Segment', /cdn\.segment\.com|analytics\.load\(/i],
  ['TikTok Pixel', /analytics\.tiktok\.com/i],
  ['LinkedIn Insight', /snap\.licdn\.com/i],
  ['Cloudflare Zaraz', /\/cdn-cgi\/zaraz\//i],
];

const uniq = (a) => [...new Set(a)];
const all = (re, s) => [...String(s || '').matchAll(re)].map((m) => m[1] || m[0]);

/** Detect measurement tags in one HTML document; exported for tests. */
export function detectTags(html) {
  const src = String(html || '');
  const p = parseHtml(src, 'https://example.invalid/');
  const loaderIds = all(/googletagmanager\.com\/gtag\/js\?id=(G-[A-Z0-9]{4,15})/g, src);
  const configCalls = all(/gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{4,15})['"]/g, src);
  const mentioned = all(/['"=](G-[A-Z0-9]{6,15})\b/g, src);
  const ga4Ids = uniq([...loaderIds, ...configCalls, ...mentioned]).filter((id) => !/^G-(XXXX|0000)/.test(id));
  const counts = {};
  for (const id of configCalls) counts[id] = (counts[id] || 0) + 1;
  const loaderCounts = {};
  for (const id of loaderIds) loaderCounts[id] = (loaderCounts[id] || 0) + 1;
  const doubleConfigured = Object.entries(counts).filter(([, n]) => n > 1).map(([id]) => id).concat(Object.entries(loaderCounts).filter(([, n]) => n > 1).map(([id]) => id));
  const gtm = uniq(all(/\b(GTM-[A-Z0-9]{4,10})\b/g, src));
  const ads = uniq(all(/\b(AW-\d{6,12})\b/g, src));
  const googleTag = uniq(all(/\b(GT-[A-Z0-9]{5,12})\b/g, src));
  const inline = p.inlineScripts.map((x) => x.text).join('\n');
  const delayed = [];
  if (/createElement\(\s*['"]script['"]\s*\)/.test(inline) && /googletagmanager\.com/.test(inline)) {
    if (/setTimeout|requestIdleCallback/.test(inline)) delayed.push('timer-delayed loader (setTimeout/requestIdleCallback)');
    if (/addEventListener\(\s*['"](scroll|mousemove|touchstart|keydown|click|pointerdown|wheel|mouseover)['"]/.test(inline)) delayed.push('interaction-triggered loader (scroll/mousemove/touch/click)');
  }
  if (/type=["']text\/partytown["'][^>]*>[^<]*(gtag|googletagmanager)/i.test(src) || /<script[^>]+type=["']text\/partytown["'][^>]*src=["'][^"']*googletagmanager/i.test(src)) delayed.push('Partytown (web worker) tag');
  if (/data-rocket-src|rocketlazyloadscript/i.test(src)) delayed.push('WP Rocket "delay JavaScript"');
  if (/<script[^>]+type=["']text\/plain["'][^>]*(data-cookieconsent|data-category|data-cookiecategory|data-cookieyes)[^>]*>/i.test(src)) delayed.push('consent-gated scripts (load only after consent)');
  if (/flying-scripts|data-flying|data-delay-src/i.test(src)) delayed.push('script-delay plugin');
  const consentDefault = /gtag\(\s*['"]consent['"]\s*,\s*['"]default['"]/.test(src);
  const consentUpdate = /gtag\(\s*['"]consent['"]\s*,\s*['"]update['"]/.test(src);
  const scriptSrcs = p.scripts.map((x) => x.src).join(' ');
  const cmps = CMPS.filter(([, re]) => re.test(scriptSrcs) || re.test(inline)).map(([n]) => n);
  const others = OTHER_ANALYTICS.filter(([, re]) => re.test(src)).map(([n]) => n);
  const jsRendered = p.stats.wordEq < 80 && (/<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(src) || p.scripts.length >= 3);
  return {
    ga4Ids,
    doubleConfigured: uniq(doubleConfigured),
    gtm,
    ads,
    googleTag,
    directGtag: loaderIds.length > 0 || configCalls.length > 0,
    delayed: uniq(delayed),
    consentDefault,
    consentUpdate,
    cmps,
    otherAnalytics: others,
    verification: { google: p.verification.google.length > 0, bing: p.verification.bing.length > 0 },
    jsonld: p.jsonLdTypes.length > 0,
    jsonldTypes: p.jsonLdTypes,
    canonical: Boolean(p.canonical),
    jsRendered,
  };
}

// ---------- repo scan ----------
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output', 'vendor', '.cache', 'coverage', '.svelte-kit', '.vercel', '.netlify', '.wrangler', 'tmp', '.turbo']);
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|astro|html?|php|liquid|njk|hbs|twig|erb|py|rb|go)$/i;

function walk(root, maxFiles) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full);
      } else if (e.isFile()) files.push(path.relative(root, full).replace(/\\/g, '/'));
      if (files.length >= maxFiles) break;
    }
  }
  return files.sort();
}

/** Framework(s) and insertion candidates for a repo file list; exported for tests. */
export function detectFrameworks(root, files) {
  const has = (re) => files.filter((f) => re.test(f));
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      return '';
    }
  };
  let pkg = {};
  if (files.includes('package.json')) {
    try {
      pkg = JSON.parse(read('package.json'));
    } catch {
      pkg = {};
    }
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const frameworks = [];
  const insertion = [];
  const add = (fw, evidence) => frameworks.push({ framework: fw, evidence });
  const cand = (list, why) => list.slice(0, 5).forEach((f) => insertion.push({ file: f, why }));
  const appLayout = has(/^(src\/)?app\/layout\.(js|jsx|ts|tsx)$/);
  const pagesDoc = has(/^(src\/)?pages\/_(document|app)\.(js|jsx|ts|tsx)$/);
  if (deps.next || appLayout.length || pagesDoc.length) {
    if (appLayout.length) {
      add('Next.js (App Router)', appLayout[0]);
      cand(appLayout, 'root layout: renders <head>/<body> for every page; add the tag with next/script (strategy "afterInteractive") or @next/third-parties GoogleAnalytics');
    }
    if (pagesDoc.length) {
      add('Next.js (Pages Router)', pagesDoc[0]);
      cand(pagesDoc, '_document/_app wraps every page; add the tag once here');
    }
    if (!appLayout.length && !pagesDoc.length) add('Next.js', 'package.json');
  }
  if (deps.nuxt || has(/^nuxt\.config\.(js|ts|mjs)$/).length) {
    add('Nuxt', has(/^nuxt\.config\./)[0] || 'package.json');
    cand([...has(/^nuxt\.config\./), ...has(/^app\.vue$/), ...has(/^plugins\//)], 'Nuxt: app.head in nuxt.config or a client plugin');
  }
  if (deps.astro || has(/^astro\.config\./).length) {
    add('Astro', has(/^astro\.config\./)[0] || 'package.json');
    cand(has(/^src\/layouts\/.*\.astro$/), 'shared Astro layout: put the tag in its <head>');
  }
  if (deps.gatsby || has(/^gatsby-(config|ssr|browser)\./).length) {
    add('Gatsby', has(/^gatsby-/)[0] || 'package.json');
    cand(has(/^gatsby-(ssr|browser|config)\./), 'Gatsby: gatsby-plugin-google-gtag in gatsby-config or onRenderBody in gatsby-ssr');
  }
  if (deps['@sveltejs/kit']) {
    add('SvelteKit', 'package.json');
    cand(has(/^src\/app\.html$/), 'SvelteKit app.html: shared <head>');
  }
  if (Object.keys(deps).some((d) => d.startsWith('@remix-run/'))) {
    add('Remix', 'package.json');
    cand(has(/^app\/root\.(jsx|tsx)$/), 'Remix root: shared <head>');
  }
  const wp = has(/(^|\/)wp-content\/themes\/[^/]+\/(header|functions)\.php$/).concat(has(/^(header|functions)\.php$/));
  if (files.includes('wp-config.php') || wp.length || has(/(^|\/)style\.css$/).some((f) => /Theme Name:/i.test(read(f).slice(0, 2000)))) {
    add('WordPress', files.includes('wp-config.php') ? 'wp-config.php' : wp[0] || 'style.css');
    cand(wp, 'theme header.php (before </head>) or a wp_head hook in functions.php; Site Kit / GTM4WP plugins are alternatives');
    const plugins = uniq(files.map((f) => (/wp-content\/plugins\/([^/]+)\//.exec(f) || [])[1]).filter(Boolean)).filter((x) => /site-kit|gtm|tag-manager|analytics|rocket|cookie|consent/i.test(x));
    if (plugins.length) frameworks[frameworks.length - 1].plugins = plugins;
  }
  if (files.includes('layout/theme.liquid')) {
    add('Shopify theme', 'layout/theme.liquid');
    cand(['layout/theme.liquid'], 'Shopify theme layout <head>; checkout/purchase events belong in Settings -> Customer events (web pixels)');
  }
  const hugoConf = has(/^(hugo|config)\.(toml|yaml|yml|json)$/);
  if (hugoConf.some((f) => /baseURL/i.test(read(f))) && has(/^(themes\/[^/]+\/)?layouts\//).length) {
    add('Hugo', hugoConf[0]);
    cand([...has(/^layouts\/partials\/head\.html$/), ...has(/^layouts\/_default\/baseof\.html$/), ...has(/^themes\/[^/]+\/layouts\/(_default\/baseof|partials\/head)\.html$/)], 'Hugo base template / head partial (override the theme file in your own layouts/)');
  }
  if (files.includes('_config.yml') && has(/^_(layouts|includes)\//).length) {
    add('Jekyll', '_config.yml');
    cand([...has(/^_includes\/head\.html$/), ...has(/^_layouts\/default\.html$/)], 'Jekyll head include / default layout');
  }
  if (has(/^(\.eleventy\.js|eleventy\.config\.(js|mjs|cjs))$/).length) {
    add('Eleventy', has(/eleventy/)[0]);
    cand(has(/^_includes\/.*\.(njk|liquid|html)$/), 'Eleventy base layout in _includes');
  }
  const cf = [...has(/(^|\/)_worker\.js$/), ...has(/^wrangler\.(toml|json|jsonc)$/), ...has(/^functions\/.*\.(js|ts)$/).slice(0, 2)];
  const rewriter = files.filter((f) => /\.(js|mjs|ts)$/.test(f)).slice(0, 2000).filter((f) => /HTMLRewriter/.test(read(f)));
  if (cf.length || rewriter.length) {
    add('Cloudflare Workers/Pages', cf[0] || rewriter[0]);
    cand(uniq([...has(/(^|\/)_worker\.js$/), ...rewriter]), 'Worker: inject the tag into <head> with HTMLRewriter for every HTML response');
  }
  if (deps.vite && files.includes('index.html') && /id=["'](root|app)["']/.test(read('index.html'))) {
    add('Vite single-page app', 'index.html');
    cand(['index.html'], 'SPA shell: add the tag once; send page_view on route changes (history events)');
  }
  const htmlFiles = has(/\.html?$/).filter((f) => !/^(node_modules|dist|build)\//.test(f));
  if (!frameworks.length && htmlFiles.length) {
    add('Static HTML', `${htmlFiles.length} HTML files`);
    const includes = htmlFiles.filter((f) => /(header|head|layout|base|partials?)/i.test(f));
    cand(includes.length ? includes : htmlFiles, includes.length ? 'shared header/layout include' : 'each HTML page needs the snippet in <head>; prefer a shared include or a build step');
  }
  return { frameworks, insertion: uniq(insertion.map((i) => JSON.stringify(i))).map((s) => JSON.parse(s)) };
}

const RESERVED_PARAMS = new Set(['cid', 'customer_id', 'customerid', 'dclid', 'gclid', 'session_id', 'sessionid', 'sfmc_id', 'sid', 'srsltid', 'uid', 'user_id', 'userid']);
const RESERVED_PREFIX = /^(_|firebase_|ga_|google_|gtag\.)/;
const ATTRIBUTION_PARAMS = new Set(['source', 'medium', 'campaign', 'term', 'content', 'campaign_id', 'campaign_source', 'campaign_medium', 'campaign_name', 'campaign_term', 'campaign_content', 'page_location', 'page_referrer', 'page_path', 'page_title', 'language', 'screen_resolution']);
const RESERVED_EVENTS = new Set(['ad_activeview', 'ad_click', 'ad_exposure', 'ad_impression', 'ad_query', 'adunit_exposure', 'app_clear_data', 'app_install', 'app_remove', 'app_store_refund', 'app_update', 'app_upgrade', 'error', 'first_open', 'first_visit', 'in_app_purchase', 'notification_dismiss', 'notification_foreground', 'notification_open', 'notification_receive', 'os_update', 'screen_view', 'session_start', 'user_engagement']);
const PII_PARAMS = /^(email|e_mail|mail|email_address|phone|phone_number|tel|mobile|name|first_name|last_name|full_name|fullname|address|street|uid|user_id|userid|question|message|comment|password|birthday|dob|date_of_birth|ip|ip_address|ssn|national_id|id_number)$/i;
const SERVER_PATH = /(^|\/)(functions|server|api|backend|workers?|lambda|scripts)\//i;

function objectAfter(lines, i, startCol) {
  let text = lines[i].slice(startCol);
  let depth = 0;
  let started = false;
  let outText = '';
  for (let k = i; k < Math.min(lines.length, i + 25); k++) {
    const chunk = k === i ? text : lines[k];
    for (const ch of chunk) {
      if (ch === '{') {
        depth++;
        started = true;
      }
      if (started) outText += ch;
      if (ch === '}' && started) {
        depth--;
        if (depth === 0) return outText;
      }
      if (!started && ch === ')') return '';
    }
    if (started) outText += '\n';
  }
  return outText;
}

const keysOf = (obj) => uniq([...String(obj || '').matchAll(/(?:^|[,{\n])\s*['"]?([A-Za-z_$][\w$.]*)['"]?\s*:/g)].map((m) => m[1]));

/** Find analytics calls in one file's text; exported for tests. */
export function scanCode(file, text) {
  const calls = [];
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => {
    const push = (type, name, col) => {
      const obj = col >= 0 ? objectAfter(lines, i, col) : '';
      calls.push({ file, line: i + 1, type, event: name || '', params: keysOf(obj).filter((k) => k !== 'event') });
    };
    let m;
    const evRe = /gtag\(\s*['"]event['"]\s*,\s*['"`]([^'"`]+)['"`]/g;
    while ((m = evRe.exec(line))) push('gtag-event', m[1], m.index + m[0].length);
    const cfgRe = /gtag\(\s*['"]config['"]\s*,\s*['"]([^'"]+)['"]/g;
    while ((m = cfgRe.exec(line))) push('gtag-config', m[1], m.index + m[0].length);
    const setRe = /gtag\(\s*['"]set['"]/g;
    while ((m = setRe.exec(line))) push('gtag-set', '', m.index + m[0].length);
    const dlRe = /dataLayer\.push\(/g;
    while ((m = dlRe.exec(line))) {
      const obj = objectAfter(lines, i, m.index + m[0].length);
      const ev = (/event\s*:\s*['"`]([^'"`]+)['"`]/.exec(obj) || [])[1] || '';
      calls.push({ file, line: i + 1, type: 'dataLayer.push', event: ev, params: keysOf(obj).filter((k) => k !== 'event') });
    }
    if (/navigator\.sendBeacon\(/.test(line)) calls.push({ file, line: i + 1, type: 'sendBeacon', event: '', params: [] });
    if (/google-analytics\.com\/(debug\/)?mp\/collect|\/mp\/collect\?/.test(line) || /api_secret/.test(line)) {
      calls.push({ file, line: i + 1, type: 'measurement-protocol', event: '', params: [], secretPresent: /api_secret\s*[=:]\s*['"`]?[A-Za-z0-9_-]{8,}/.test(line) });
    }
    const fbRe = /fbq\(\s*['"]track(?:Custom)?['"]\s*,\s*['"]([^'"]+)['"]/g;
    while ((m = fbRe.exec(line))) push('meta-pixel', m[1], m.index + m[0].length);
    const phRe = /posthog\.capture\(\s*['"]([^'"]+)['"]/g;
    while ((m = phRe.exec(line))) push('posthog', m[1], m.index + m[0].length);
    const plRe = /plausible\(\s*['"]([^'"]+)['"]/g;
    while ((m = plRe.exec(line))) push('plausible', m[1], m.index + m[0].length);
  });
  return calls;
}

/** Findings from code calls; exported for tests. */
export function checkCalls(calls) {
  const findings = [];
  for (const c of calls) {
    const where = `${c.file}:${c.line}`;
    if (c.type === 'gtag-event' || c.type === 'dataLayer.push' || c.type === 'gtag-config' || c.type === 'gtag-set') {
      if (c.event && RESERVED_EVENTS.has(c.event)) findings.push({ severity: 'high', id: 'reserved-event-name', where, detail: `event "${c.event}" is reserved by GA4; rename it (e.g. "${c.event}_custom")` });
      for (const k of c.params) {
        const key = k.split('.').pop();
        if (ATTRIBUTION_PARAMS.has(key)) findings.push({ severity: 'high', id: 'attribution-param', where, detail: `param "${key}" collides with GA4 traffic/page fields and can overwrite attribution (a custom "source" once created a fake traffic source); rename to e.g. "${key === 'language' ? 'page_language' : `entry_${key}`}"` });
        else if (RESERVED_PARAMS.has(key) || RESERVED_PREFIX.test(key)) findings.push({ severity: 'high', id: 'reserved-param', where, detail: `param "${key}" is reserved by GA4 and will be dropped or misread; rename it` });
        if (PII_PARAMS.test(key)) findings.push({ severity: 'high', id: 'pii-param', where, detail: `param "${key}" looks like personal data or free text; GA4 policy forbids PII. Remove it, hash it server-side, or replace free text with a category` });
      }
    }
    if (c.type === 'measurement-protocol' && c.secretPresent) {
      findings.push({ severity: SERVER_PATH.test(c.file) || /\.(py|rb|go)$/.test(c.file) ? 'info' : 'high', id: 'mp-secret', where, detail: SERVER_PATH.test(c.file) ? 'Measurement Protocol api_secret present in server code (value redacted); keep it in an environment secret' : 'Measurement Protocol api_secret appears in front-end code (value redacted): anyone can send fake events. Move it server-side and rotate it' });
    }
  }
  return findings;
}

// ---------- plan ----------
function buildPlan({ groups, siteIds, live, repo, codeFindings, indexnow, ws }) {
  const plan = [];
  const file = repo && repo.insertion.length ? repo.insertion[0].file : '';
  const loc = (fallback) => (file ? `${file}${fallback ? ` (${fallback})` : ''}` : fallback || 'site-wide <head>');
  const anyTag = siteIds.ga4.length || siteIds.gtm.length;
  if (live && !anyTag) {
    plan.push({ location: loc('all page groups'), add: 'GA4 base tag (gtag.js) or a GTM container, once per page, early in <head>', measures: 'page_view, sessions, engagement, landing pages for organic traffic', userAction: 'Create a GA4 property + web data stream (Admin -> Data streams), send us the G- Measurement ID, approve the code change' });
  }
  const missing = Object.entries(groups).filter(([, g]) => g.pages && !g.withTag && anyTag);
  for (const [name] of missing) plan.push({ location: `page group "${name}"${file ? ` -> ${file}` : ''}`, add: 'the same GA4/GTM tag the rest of the site uses (this group has none)', measures: 'sessions and conversions that currently vanish for this group', userAction: 'Approve adding the tag to the template used by these pages' });
  if (siteIds.ga4.length > 1) plan.push({ location: 'all pages', add: `one GA4 ID instead of ${siteIds.ga4.length} (${siteIds.ga4.join(', ')})`, measures: 'clean, non-split traffic numbers', userAction: 'Tell us which GA4 property is the real one; remove or route the others' });
  if (siteIds.double.length) plan.push({ location: loc('pages with the duplicate'), add: `a single config call for ${siteIds.double.join(', ')}`, measures: 'page_view counted once (now double)', userAction: 'Approve removing the duplicate snippet (or the duplicate GTM GA4 tag)' });
  if (siteIds.gtmAndGtag) plan.push({ location: 'GTM container + page code', add: 'GA4 configured in only one place (GTM or gtag.js)', measures: 'avoids double page_view', userAction: 'Check GTM -> Tags for a Google tag/GA4 config with the same ID; keep one' });
  if (siteIds.delayed.length) plan.push({ location: loc('tag loader'), add: `load gtag.js early (async in <head>) instead of: ${siteIds.delayed.join('; ')}; use Consent Mode to respect consent`, measures: 'short visits that may leave before the delayed loader fires (size unknown until measured: compare GA4 page_view / CDN HTML views and GA4 organic sessions / GSC clicks per page group before and after)', userAction: 'Approve; log it with log-change.mjs add --type measurement because session counts will jump (new baseline)' });
  if (live && anyTag && !siteIds.consentDefault) plan.push({ location: loc('<head>, before the tag'), add: "gtag('consent','default',{...}) for the regions that need a banner, updated by your CMP", measures: 'modelled conversions and compliant collection in the EEA/UK and similar regions', userAction: 'Decide with your CMP/legal owner which regions need consent; approve the defaults' });
  const attr = codeFindings.filter((f) => f.id === 'attribution-param' || f.id === 'reserved-param' || f.id === 'reserved-event-name');
  for (const f of attr.slice(0, 10)) plan.push({ location: f.where, add: f.detail, measures: 'correct traffic source / page attribution', userAction: 'Approve the rename; then GA4 Admin -> Custom definitions -> register the new parameter name' });
  const pii = codeFindings.filter((f) => f.id === 'pii-param');
  for (const f of pii.slice(0, 10)) plan.push({ location: f.where, add: f.detail, measures: '(stops sending personal data)', userAction: 'Approve removal; if the data was already collected, consider GA4 Admin -> Data deletion requests' });
  for (const f of codeFindings.filter((x) => x.id === 'mp-secret' && x.severity === 'high')) plan.push({ location: f.where, add: 'move the Measurement Protocol call server-side; read the secret from an environment variable', measures: 'server-side events without forgeable credentials', userAction: 'Rotate the API secret in GA4 Admin -> Data streams -> Measurement Protocol API secrets' });
  plan.push({ location: loc('shared layout'), add: 'page-group dimension on every page: surface (home/tool/article/category...), page_type and page_language as page_view parameters (or a seo_landing_view event); never name it "language" (gtag treats that as the browser language)', measures: 'organic landing -> start -> complete, split by page group without URL regex guessing', userAction: 'Approve; GA4 Admin -> Custom definitions -> create event-scoped dimensions surface, page_type, page_language' });
  plan.push({ location: 'GA4 Admin -> Events', add: 'mark your real outcomes (sign_up, generate_lead, purchase, tool_complete...) as key events', measures: 'key events per organic landing page', userAction: 'Click "Mark as key event" for each outcome event (GA4 UI)' });
  plan.push({ location: 'GA4 Admin -> Data display -> Channel groups', add: 'custom channel "AI assistants" only for AI sources the default "AI Assistant" channel misses (e.g. source matches perplexity|poe\\.com), placed above Referral', measures: 'sessions referred by AI answers (GEO) that would otherwise hide inside Referral', userAction: 'Create the channel group in the GA4 UI (no code)' });
  plan.push({ location: 'GA4 Admin -> Product links -> Search Console links', add: 'link the Search Console property', measures: 'queries and landing pages next to GA4 engagement', userAction: 'Click Link in the GA4 UI (needs owner rights in both)' });
  if (live && !siteIds.verificationGoogle) plan.push({ location: loc('<head> or DNS'), add: 'Search Console verification (DNS TXT for a Domain property is best)', measures: 'access to Search Console data', userAction: 'Verify in Search Console; skip if already verified by DNS' });
  if (live && !siteIds.verificationBing) plan.push({ location: 'Bing Webmaster Tools', add: 'verify the site (import from Search Console is fastest)', measures: 'Bing/Copilot/ChatGPT-search visibility data', userAction: 'Sign in at bing.com/webmasters and import from GSC' });
  if (indexnow && !indexnow.ok) plan.push({ location: `${ws.origin()}/<key>.txt`, add: 'IndexNow key file', measures: 'faster recrawl by Bing and other IndexNow engines after each deploy', userAction: 'Approve publishing the key file; then indexing.mjs indexnow after deploys' });
  for (const [name, g] of Object.entries(groups)) {
    if (!g.pages) continue;
    if (g.jsonld < g.pages) plan.push({ location: `page group "${name}"`, add: 'JSON-LD for the page type (Organization/WebSite on home; Article/BreadcrumbList on articles; Product/SoftwareApplication on product/tool pages)', measures: 'rich results eligibility and clearer entities for AI answers', userAction: 'Approve the template change' });
    if (g.canonical < g.pages) plan.push({ location: `page group "${name}"`, add: 'self-referencing rel=canonical in the shared <head>', measures: 'consolidated signals, fewer duplicate URLs', userAction: 'Approve the template change' });
  }
  return plan;
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const fetchOpts = { userAgent: flags.userAgent, timeoutMs: flags.timeout };
  const findings = [];
  let live = null;
  const groups = {};
  const siteIds = { ga4: [], gtm: [], ads: [], googleTag: [], double: [], delayed: [], consentDefault: false, gtmAndGtag: false, verificationGoogle: false, verificationBing: false };
  let indexnow = null;
  if (!flags.noLive) {
    const origin = ws.origin();
    const robots = await fetchRobots(origin, fetchOpts);
    const maps = await discoverSitemaps(origin, robots.robots, fetchOpts);
    const col = maps.length ? await collectSitemapUrls(maps, { fetchOpts, maxUrls: 50000 }) : { urls: [] };
    const byGroup = new Map();
    for (const u of col.urls) {
      const g = ws.pageGroupOf(u.loc);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(u.loc);
    }
    const sample = [ws.siteUrl(), ...collectList(flags.urls).map((u) => (/^https?:/i.test(u) ? u : new URL(u, origin).href))];
    for (const [, list] of byGroup) {
      // spread the sample across the group instead of taking the first N URLs
      const step = Math.max(1, Math.floor(list.length / flags.maxPerGroup));
      for (let n = 0; n < Math.min(flags.maxPerGroup, list.length); n++) sample.push(list[n * step]);
    }
    const urls = [...new Set(sample.map((u) => normalizeUrl(u) || u))];
    log(`Checking ${urls.length} page(s) across ${byGroup.size || 1} group(s)...`);
    const wait = rateLimiter(flags.delay);
    const pages = await mapLimit(urls, flags.concurrency, async (u) => {
      await wait();
      const res = await fetchPage(u, fetchOpts);
      if (res.error || res.status !== 200 || !isHtml(res)) return { url: u, group: ws.pageGroupOf(u), error: res.error || `HTTP ${res.status}` };
      return { url: u, group: ws.pageGroupOf(u), ...detectTags(res.body) };
    });
    for (const p of pages) {
      const g = groups[p.group] || (groups[p.group] = { pages: 0, errors: 0, withTag: 0, ga4Ids: [], gtm: [], consentDefault: 0, delayed: 0, jsonld: 0, canonical: 0, jsRendered: 0 });
      if (p.error) {
        g.errors++;
        continue;
      }
      g.pages++;
      if (p.ga4Ids.length || p.gtm.length || p.googleTag.length) g.withTag++;
      g.ga4Ids = uniq([...g.ga4Ids, ...p.ga4Ids]);
      g.gtm = uniq([...g.gtm, ...p.gtm]);
      if (p.consentDefault) g.consentDefault++;
      if (p.delayed.length) g.delayed++;
      if (p.jsonld) g.jsonld++;
      if (p.canonical) g.canonical++;
      if (p.jsRendered) g.jsRendered++;
      siteIds.ga4 = uniq([...siteIds.ga4, ...p.ga4Ids]);
      siteIds.gtm = uniq([...siteIds.gtm, ...p.gtm]);
      siteIds.ads = uniq([...siteIds.ads, ...p.ads]);
      siteIds.googleTag = uniq([...siteIds.googleTag, ...p.googleTag]);
      siteIds.double = uniq([...siteIds.double, ...p.doubleConfigured]);
      siteIds.delayed = uniq([...siteIds.delayed, ...p.delayed]);
      siteIds.consentDefault = siteIds.consentDefault || p.consentDefault;
      siteIds.gtmAndGtag = siteIds.gtmAndGtag || (p.gtm.length > 0 && p.directGtag);
      siteIds.verificationGoogle = siteIds.verificationGoogle || p.verification.google;
      siteIds.verificationBing = siteIds.verificationBing || p.verification.bing;
    }
    live = { pages, sampled: urls.length, sitemapUrls: col.urls.length };
    const anyTag = siteIds.ga4.length || siteIds.gtm.length;
    if (!anyTag) findings.push({ severity: 'high', id: 'no-tag', where: 'all sampled pages', detail: 'No GA4 or GTM found in static HTML (if a CDN/tag manager injects it at runtime, confirm in GA4 Realtime)' });
    for (const [name, g] of Object.entries(groups)) {
      if (g.pages && !g.withTag && anyTag) findings.push({ severity: 'high', id: 'group-missing-tag', where: `group ${name}`, detail: `${g.pages} sampled page(s) without GA4/GTM while other groups have it` });
      if (g.jsRendered) findings.push({ severity: 'info', id: 'js-rendered', where: `group ${name}`, detail: `${g.jsRendered} page(s) look client-rendered: tags injected at runtime are invisible to this check` });
    }
    if (siteIds.ga4.length > 1) findings.push({ severity: 'medium', id: 'multiple-ga4', where: 'site', detail: `Multiple GA4 IDs: ${siteIds.ga4.join(', ')}` });
    if (siteIds.double.length) findings.push({ severity: 'high', id: 'double-config', where: 'site', detail: `Same GA4 ID configured twice on a page: ${siteIds.double.join(', ')} (double page_view)` });
    if (siteIds.gtmAndGtag) findings.push({ severity: 'medium', id: 'gtm-and-gtag', where: 'site', detail: 'Both GTM and a direct gtag.js are present: make sure GA4 is not configured in both' });
    if (siteIds.delayed.length) findings.push({ severity: 'high', id: 'delayed-loader', where: 'site', detail: `Delayed tag loading (${siteIds.delayed.join('; ')}): visitors who leave before it fires may not be counted; compare GA4 / CDN and GA4 organic sessions / GSC clicks per page group before and after the change before reporting an undercount` });
    if (anyTag && !siteIds.consentDefault) findings.push({ severity: 'medium', id: 'no-consent-default', where: 'site', detail: "No gtag('consent','default', ...) found in static HTML" });
    const keyFile = ws.resolveFile(ws.config.indexnow.keyFile);
    const key = keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : process.env.INDEXNOW_KEY || '';
    if (key) {
      const loc = ws.config.indexnow.keyLocation || `${origin}/${key}.txt`;
      const r = await fetchPage(loc, fetchOpts);
      indexnow = { ok: r.status === 200 && String(r.body || '').trim() === key, location: loc, status: r.status };
      if (!indexnow.ok) findings.push({ severity: 'medium', id: 'indexnow-key', where: loc, detail: 'IndexNow key file is not reachable or its content does not match' });
    } else indexnow = { ok: false, location: '', status: 0, missing: true };
  }

  let repo = null;
  let calls = [];
  let codeFindings = [];
  const repoPath = flags.repo ? path.resolve(flags.repo) : ws.config.repo.path ? ws.resolveFile(ws.config.repo.path, { prefer: 'project' }) : '';
  if (!flags.noRepo && repoPath) {
    if (!fs.existsSync(repoPath)) throw new UserError(`Repo not found: ${repoPath}`);
    const files = walk(repoPath, flags.maxFiles);
    const fw = detectFrameworks(repoPath, files);
    for (const f of files.filter((x) => CODE_EXT.test(x))) {
      let text = '';
      try {
        const st = fs.statSync(path.join(repoPath, f));
        if (st.size > 1500000) continue;
        text = fs.readFileSync(path.join(repoPath, f), 'utf8');
      } catch {
        continue;
      }
      if (!/gtag|dataLayer|sendBeacon|mp\/collect|api_secret|fbq\(|posthog|plausible\(/.test(text)) continue;
      calls.push(...scanCode(f, text));
    }
    codeFindings = checkCalls(calls);
    repo = { path: repoPath, files: files.length, ...fw, calls };
    findings.push(...codeFindings);
    if (!fw.frameworks.length) findings.push({ severity: 'info', id: 'framework-unknown', where: repoPath, detail: 'Could not recognise the framework; tell us which file renders the shared <head>' });
  }

  const plan = buildPlan({ groups, siteIds, live, repo, codeFindings, indexnow, ws });
  const result = { meta: { site: ws.config.site.url, generatedAt: new Date().toISOString(), sampled: live ? live.sampled : 0, repo: repo ? repo.path : null }, live: live ? { pages: live.pages, groups, siteWide: siteIds, indexnow } : null, repo: repo ? { framework: repo.frameworks, insertionFiles: repo.insertion, calls: repo.calls, files: repo.files } : null, findings, plan };
  const jsonPath = writeJson(ws.dataFile('instrumentation', 'audit', 'json'), result);

  const L = [`# Measurement plan / 量測插入計畫 (${ws.today()})`, ''];
  L.push(`- Site: ${ws.config.site.url || '(not set)'}; pages checked: ${live ? live.sampled : 0}${repo ? `; repo: ${repo.path} (${repo.frameworks.map((f) => f.framework).join(', ') || 'framework not recognised'})` : '; repo: not scanned'}`);
  L.push('- Evidence level: static HTML and source code only. Confirm data actually arrives in GA4 (DebugView / Realtime / next-day reports) before calling it done.', '');
  if (live) {
    L.push('## Tags by page group / 各頁群現況', '');
    L.push(mdTable(
      [
        { label: 'Group', value: (r) => r[0] },
        { label: 'Pages', align: 'right', value: (r) => r[1].pages },
        { label: 'With GA4/GTM', align: 'right', value: (r) => `${r[1].withTag}/${r[1].pages}` },
        { label: 'GA4 IDs', value: (r) => r[1].ga4Ids.join(' ') || '-' },
        { label: 'GTM', value: (r) => r[1].gtm.join(' ') || '-' },
        { label: 'Consent default', align: 'right', value: (r) => `${r[1].consentDefault}/${r[1].pages}` },
        { label: 'Delayed loader', align: 'right', value: (r) => r[1].delayed },
        { label: 'JSON-LD', align: 'right', value: (r) => fmtPct(r[1].pages ? r[1].jsonld / r[1].pages : 0, 0) },
        { label: 'Canonical', align: 'right', value: (r) => fmtPct(r[1].pages ? r[1].canonical / r[1].pages : 0, 0) },
      ],
      Object.entries(groups),
    ));
  }
  if (repo && repo.insertion.length) {
    L.push('## Where the tag goes in your code / 程式碼插入位置', '', mdTable([{ label: 'File', key: 'file' }, { label: 'Why', key: 'why' }], repo.insertion));
  }
  if (calls.length) {
    L.push('## Existing tracking calls / 現有事件', '', mdTable([{ label: 'Where', value: (c) => `${c.file}:${c.line}` }, { label: 'Type', key: 'type' }, { label: 'Event', key: 'event' }, { label: 'Params', value: (c) => (c.secretPresent ? 'api_secret (redacted)' : c.params.join(', ')) }], calls.slice(0, 60)));
  }
  if (findings.length) L.push('## Findings / 發現', '', mdTable([{ label: 'Severity', key: 'severity' }, { label: 'Where', key: 'where' }, { label: 'Detail', key: 'detail' }], findings.sort((a, b) => ['high', 'medium', 'low', 'info'].indexOf(a.severity) - ['high', 'medium', 'low', 'info'].indexOf(b.severity))));
  L.push('## Plan / 插入計畫', '');
  L.push('| 位置 Location | 要加什麼 What to add | 量什麼 What it measures | 需要使用者做什麼 What you need to do |');
  L.push('|---|---|---|---|');
  for (const p of plan) L.push(`| ${[p.location, p.add, p.measures, p.userAction].map((x) => String(x).replace(/\|/g, '\\|')).join(' | ')} |`);
  L.push('', 'After approval and deploy: log a measurement D0 (`log-change.mjs add --type measurement`) because numbers before and after are not comparable.');
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-instrumentation-plan.md`), L.join('\n'));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (live) out(`GA4: ${siteIds.ga4.join(', ') || 'none'} | GTM: ${siteIds.gtm.join(', ') || 'none'} | groups without a tag: ${Object.entries(groups).filter(([, g]) => g.pages && !g.withTag).map(([n]) => n).join(', ') || 'none'} | delayed loader: ${siteIds.delayed.length ? 'yes' : 'no'} | consent default: ${siteIds.consentDefault ? 'yes' : 'no'}`);
  if (repo) out(`Repo: ${repo.frameworks.map((f) => f.framework).join(', ') || 'unknown framework'}; ${calls.length} tracking call(s); insertion: ${repo.insertion.slice(0, 2).map((i) => i.file).join(', ') || '-'}`);
  out(`Findings: ${findings.filter((f) => f.severity === 'high').length} high, ${findings.filter((f) => f.severity === 'medium').length} medium; plan rows: ${plan.length}`);
  out(`\nwrote ${md}\nwrote ${jsonPath}`);
  return 0;
}

runMain(import.meta.url, main);
