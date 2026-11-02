#!/usr/bin/env node
// Indexing operations: IndexNow submission, GSC sitemap submit/list, URL Inspection with history,
// the manual "Request indexing" list, and coverage-export diffs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, formatHelp, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, appendText, normalizeUrl, collectList, sleep, chunk, bareHost, hostOf, globToRegExp, staticBase, urlFromTemplate, urlFromStaticFile, scriptCmd, readJson } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { gscClient, loadGscFile } from './lib/gsc.mjs';
import { fetchPage, fetchRobots, discoverSitemaps, collectSitemapUrls } from './lib/http.mjs';
import { loadWaves, isOpen } from './lib/experiments.mjs';
import { csvToRecords, findColumn, writeCsvFile } from './lib/csv.mjs';
import { readZipEntries } from './lib/zip.mjs';
import { groupMetrics } from './lib/metrics.mjs';
import { textTable, shortUrl } from './lib/format.mjs';

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  site: { type: 'string', placeholder: 'property', desc: 'Override gsc.siteUrl' },
  'from-file': { type: 'string', placeholder: 'file', desc: 'indexnow/inspect: URLs, one per line' },
  'changed-since': { type: 'string', placeholder: 'git-ref', desc: 'indexnow: URLs of content files changed since this git ref (repo.path)' },
  'url-template': { type: 'string', placeholder: 'tpl', desc: 'indexnow --changed-since: map files to URLs (default config repo.urlTemplate)' },
  'dry-run': { type: 'boolean', desc: 'indexnow/sitemap-submit: show what would be sent, send nothing' },
  'skip-verify': { type: 'boolean', desc: 'indexnow: do not check that the key file is live first' },
  endpoint: { type: 'string', placeholder: 'url', desc: 'indexnow: endpoint', default: INDEXNOW_ENDPOINT },
  sitemap: { type: 'list', placeholder: 'url', desc: 'sitemap-submit: sitemap URL(s) (default: from robots.txt or /sitemap.xml)' },
  'from-sitemap': { type: 'boolean', desc: 'inspect: take URLs from the sitemaps' },
  limit: { type: 'int', desc: 'inspect: max URLs this run (default 200; quota ~2,000/day/property) | list-manual: max URLs per section (default 10)' },
  'skip-days': { type: 'int', desc: 'inspect: skip URLs inspected within N days (resume)', default: 7 },
  language: { type: 'string', placeholder: 'bcp47', desc: 'inspect: language of the inspection messages', default: 'en-US' },
  delay: { type: 'int', placeholder: 'ms', desc: 'inspect: gap between requests', default: 300 },
  json: { type: 'boolean', desc: 'Print JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/indexing.mjs indexnow <url...> | --from-file urls.txt | --changed-since <git-ref> [--dry-run]',
    'node scripts/indexing.mjs sitemap-submit [--sitemap URL] [--dry-run]',
    'node scripts/indexing.mjs sitemaps',
    'node scripts/indexing.mjs inspect [<url...> | --from-file f | --from-sitemap] [--limit 200]',
    'node scripts/indexing.mjs list-manual [--limit 10]',
    'node scripts/indexing.mjs coverage-diff [old.csv|zip new.csv|zip]',
  ],
  summary:
    'indexnow: POSTs changed URLs (same host, <= 10,000 per batch) to api.indexnow.org after checking the key file is live (Bing, Yandex, ' +
    'Seznam, Naver...; Google does not use IndexNow, but ChatGPT search and Copilot rely on Bing). sitemap-submit: re-submits sitemaps through ' +
    'the Search Console API (needs the webmasters scope and a Full/Owner user) and reads back lastDownloaded. sitemaps: read-only status. ' +
    'inspect: URL Inspection API (verdict, coverage, last crawl, Google vs declared canonical), stored with history in ' +
    'data/indexing/state.json, diffed against the previous run, and checked against deploy times from experiments.json. list-manual: the ' +
    'prioritized "Request indexing" checklist a human must click in Search Console (the API cannot). coverage-diff: compares two Page ' +
    'indexing exports from the Search Console UI by issue type.',
  spec: SPEC,
  examples: [
    'node scripts/indexing.mjs indexnow https://www.example.com/blog/new-post/ https://www.example.com/blog/',
    'node scripts/indexing.mjs indexnow --changed-since HEAD~1 --dry-run',
    'node scripts/indexing.mjs inspect --from-file .seo-agent/data/treated.txt',
    'node scripts/indexing.mjs list-manual',
  ],
  notes: [
    'Only send URLs that really changed (new pages, substantial updates, new 301 sources). Do not re-submit sitemaps or ping IndexNow daily without changes.',
    'The Sitemaps API "indexed" counts are deprecated; use inspect for index status.',
  ],
});

// ---------- IndexNow ----------
function indexNowKey(ws) {
  const file = ws.resolveFile(ws.config.indexnow.keyFile);
  const key = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : process.env.INDEXNOW_KEY || '';
  if (!key) throw new UserError('No IndexNow key', { hint: [`Create one and publish it at ${ws.origin()}/<key>.txt, then: ${scriptCmd('init.mjs')} --indexnow-key-file <file> --indexnow-key-location ${ws.origin()}/<key>.txt`, 'Or set $INDEXNOW_KEY for a one-off run.'] });
  if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new UserError('IndexNow key must be 8-128 characters of a-z, A-Z, 0-9 or "-"');
  return key;
}

function changedFiles(ws, ref, flags) {
  const repo = ws.config.repo.path ? ws.resolveFile(ws.config.repo.path, { prefer: 'project' }) : '';
  if (!repo || !fs.existsSync(repo)) throw new UserError('--changed-since needs repo.path in config', { hint: `${scriptCmd('init.mjs')} --repo /path/to/site-repo` });
  let names;
  try {
    names = execFileSync('git', ['-C', repo, 'diff', '--name-only', '--diff-filter=ACMR', ref, 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().split('\n').filter(Boolean);
  } catch (e) {
    throw new UserError(`git diff failed for ref "${ref}" in ${repo}`, { hint: 'Use a ref that exists locally (e.g. HEAD~1, a tag or the last deployed commit).' });
  }
  const globs = ws.config.repo.contentGlobs || [];
  const tpl = flags.urlTemplate || ws.config.repo.urlTemplate;
  const urls = [];
  const unmapped = [];
  for (const rel of names) {
    const abs = path.join(repo, rel);
    const glob = globs.find((g) => globToRegExp(g.replace(/^\.\//, '')).test(rel));
    if (globs.length && !glob) continue;
    let url = '';
    if (tpl && glob) url = urlFromTemplate(tpl, abs, path.join(repo, staticBase(glob)));
    else url = urlFromStaticFile(abs, repo, ws.origin());
    if (url) urls.push(url);
    else unmapped.push(rel);
  }
  return { urls, unmapped, files: names.length };
}

async function cmdIndexnow(ws, flags, positionals) {
  let urls = collectList(positionals, flags.fromFile);
  let unmapped = [];
  if (flags.changedSince) {
    const c = changedFiles(ws, flags.changedSince, flags);
    urls.push(...c.urls);
    unmapped = c.unmapped;
    log(`${c.files} changed files since ${flags.changedSince}; ${c.urls.length} mapped to URLs`);
  }
  urls = [...new Set(urls.map((u) => normalizeUrl(/^https?:/i.test(u) ? u : new URL(u, ws.origin()).href) || u))];
  if (!urls.length) throw new UserError('No URLs to submit', { hint: 'Pass URLs, --from-file or --changed-since <git-ref>.' });
  const host = ws.host();
  const foreign = urls.filter((u) => hostOf(u) !== host);
  if (foreign.length) log(`Skipping ${foreign.length} URL(s) not on ${host} (IndexNow requires one host per request): ${foreign.slice(0, 3).join(', ')}`);
  urls = urls.filter((u) => hostOf(u) === host);
  const key = indexNowKey(ws);
  const keyLocation = ws.config.indexnow.keyLocation || `${ws.origin()}/${key}.txt`;
  if (bareHost(hostOf(keyLocation)) !== bareHost(host)) throw new UserError(`keyLocation ${keyLocation} is not on ${host}`);
  if (unmapped.length) log(`Not mapped to URLs (set repo.urlTemplate or --url-template): ${unmapped.slice(0, 5).join(', ')}${unmapped.length > 5 ? ' ...' : ''}`);
  if (flags.dryRun) {
    out(`Would submit ${urls.length} URL(s) for ${host} (key location ${keyLocation}):`);
    for (const u of urls) out(`  ${u}`);
    return 0;
  }
  if (!flags.skipVerify) {
    const res = await fetchPage(keyLocation, { timeoutMs: 15000 });
    if (res.status !== 200 || String(res.body || '').trim() !== key) {
      throw new UserError(`IndexNow key file is not live at ${keyLocation} (${res.error || `HTTP ${res.status}`}${res.status === 200 ? ', content differs from the key' : ''})`, { hint: ['Publish a text file containing only the key at that URL and deploy, or fix indexnow.keyLocation.', 'Use --skip-verify only if you are sure.'] });
    }
  }
  const results = [];
  for (const batch of chunk(urls, 10000)) {
    let res;
    try {
      res = await fetch(flags.endpoint, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host, key, keyLocation, urlList: batch }), signal: AbortSignal.timeout(60000) });
    } catch (e) {
      throw new UserError(`IndexNow request failed: ${e.message}`);
    }
    const text = await res.text().catch(() => '');
    results.push({ status: res.status, count: batch.length });
    if (![200, 202].includes(res.status)) {
      const why = { 400: 'bad request (invalid format)', 403: 'key not valid (file missing or content mismatch)', 422: 'URLs do not belong to the host or the key does not match the schema', 429: 'too many requests: slow down' }[res.status] || text.slice(0, 200);
      throw new UserError(`IndexNow HTTP ${res.status}: ${why}`, { hint: 'Check the key file and that every URL is on the same host as keyLocation.' });
    }
  }
  const record = { at: new Date().toISOString(), host, endpoint: flags.endpoint, urls, results };
  writeJson(ws.dataFile('indexing', 'indexnow', 'json'), record);
  appendText(ws.path('data', 'indexing', 'submissions.jsonl'), `${JSON.stringify({ type: 'indexnow', at: record.at, count: urls.length, statuses: results.map((r) => r.status) })}\n`);
  out(`IndexNow accepted ${urls.length} URL(s) for ${host} (HTTP ${results.map((r) => r.status).join(', ')}). Bing and other IndexNow engines will recrawl them; Google does not use IndexNow.`);
  return 0;
}

// ---------- sitemaps ----------
async function sitemapUrls(ws, flags) {
  if (flags.sitemap.length) return flags.sitemap;
  const robots = await fetchRobots(ws.origin());
  const found = await discoverSitemaps(ws.origin(), robots.robots);
  if (!found.length) throw new UserError('No sitemap found (robots.txt Sitemap: lines or /sitemap.xml)', { hint: 'Pass --sitemap https://your-site/sitemap.xml' });
  return found;
}

async function cmdSitemapSubmit(ws, flags) {
  const maps = await sitemapUrls(ws, flags);
  if (flags.dryRun) {
    out(`Would submit to Search Console: ${maps.join(', ')}`);
    return 0;
  }
  const gsc = gscClient(ws, flags, { write: true });
  for (const m of maps) {
    await gsc.submitSitemap(m);
    await sleep(1500);
    let info = {};
    try {
      info = await gsc.getSitemap(m);
    } catch {
      /* read-back is best effort */
    }
    out(`submitted ${m}: lastSubmitted ${info.lastSubmitted || '?'}, lastDownloaded ${info.lastDownloaded || 'not yet'}, pending ${info.isPending ?? '?'}, errors ${info.errors ?? '?'}, warnings ${info.warnings ?? '?'}`);
  }
  appendText(ws.path('data', 'indexing', 'submissions.jsonl'), `${JSON.stringify({ type: 'sitemap-submit', at: new Date().toISOString(), sitemaps: maps })}\n`);
  out('Record this in logs/changes.md with the deploy it belongs to.');
  return 0;
}

async function cmdSitemaps(ws, flags) {
  const gsc = gscClient(ws, flags);
  const list = await gsc.listSitemaps();
  if (flags.json) return void process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  if (!list.length) return void out('No sitemaps submitted in Search Console for this property.');
  out(textTable(['sitemap', 'last submitted', 'last downloaded', 'pending', 'errors', 'warnings', 'submitted URLs'], list.map((s) => [s.path, (s.lastSubmitted || '').slice(0, 16), (s.lastDownloaded || '').slice(0, 16), s.isPending ? 'yes' : 'no', s.errors || 0, s.warnings || 0, (s.contents || []).map((c) => `${c.type}:${c.submitted}`).join(' ')])));
  out('Note: the API "indexed" counts are deprecated; use "inspect" for index status.');
  return 0;
}

// ---------- inspection ----------
const statePath = (ws) => ws.path('data', 'indexing', 'state.json');
export function loadState(ws) {
  return readJson(statePath(ws), { urls: {} });
}

function deployTimes(ws) {
  if (!fs.existsSync(ws.path('logs', 'experiments.json'))) return new Map();
  const m = new Map();
  for (const w of loadWaves(ws)) {
    if (!['seo-change', 'rollback'].includes(w.type)) continue;
    const t = w.deployedAt ? w.deployedAt.utc : `${w.date}T00:00:00Z`;
    for (const u of w.urls || []) if (!m.has(u) || m.get(u).at < t) m.set(u, { at: t, wave: w.id, open: isOpen(w) });
  }
  return m;
}

export function summarizeInspection(url, r) {
  const i = (r && r.inspectionResult) || {};
  const x = i.indexStatusResult || {};
  return {
    url,
    checkedAt: new Date().toISOString(),
    verdict: x.verdict || '',
    coverageState: x.coverageState || '',
    indexingState: x.indexingState || '',
    robotsTxtState: x.robotsTxtState || '',
    pageFetchState: x.pageFetchState || '',
    lastCrawlTime: x.lastCrawlTime || '',
    crawledAs: x.crawledAs || '',
    googleCanonical: x.googleCanonical || '',
    userCanonical: x.userCanonical || '',
    sitemap: (x.sitemap || []).join(' '),
    referringUrls: (x.referringUrls || []).slice(0, 5),
    richResults: ((i.richResultsResult || {}).detectedItems || []).map((d) => d.richResultType),
    richIssues: ((i.richResultsResult || {}).detectedItems || []).flatMap((d) => (d.items || []).flatMap((it) => (it.issues || []).map((s) => `${s.severity}: ${s.issueMessage}`))).slice(0, 5),
  };
}

async function cmdInspect(ws, flags, positionals) {
  let urls = collectList(positionals, flags.fromFile).map((u) => normalizeUrl(/^https?:/i.test(u) ? u : new URL(u, ws.origin()).href) || u);
  const state = loadState(ws);
  if (!urls.length || flags.fromSitemap) {
    const maps = await sitemapUrls(ws, flags);
    const col = await collectSitemapUrls(maps, { maxUrls: 100000 });
    const deploys = deployTimes(ws);
    const fresh = (u) => {
      const s = state.urls[u];
      return s && Date.now() - Date.parse(s.checkedAt) < flags.skipDays * 86400000;
    };
    const fromMaps = col.urls.map((x) => x.loc);
    const prioritized = [...new Set([...[...deploys.keys()].filter((u) => deploys.get(u).open), ...fromMaps])];
    urls = [...new Set([...urls, ...prioritized.filter((u) => !fresh(u))])];
    log(`${fromMaps.length} sitemap URLs; ${urls.length} not inspected in the last ${flags.skipDays} days`);
  }
  urls = urls.slice(0, flags.limit ?? 200);
  if (!urls.length) return void out('Nothing to inspect (everything was checked recently; lower --skip-days to re-check).');
  const gsc = gscClient(ws, flags);
  const deploys = deployTimes(ws);
  const rows = [];
  const changes = [];
  let stopped = '';
  for (const [n, url] of urls.entries()) {
    let res;
    try {
      res = await gsc.inspect(url, flags.language);
    } catch (e) {
      if (e.status === 429 || /quota/i.test(e.message)) {
        stopped = `Stopped after ${n} URLs: ${e.message}. Resume tomorrow (the run skips URLs already checked).`;
        break;
      }
      rows.push({ url, error: e.message });
      continue;
    }
    const cur = summarizeInspection(url, res);
    const prev = state.urls[url];
    if (prev) {
      for (const f of ['verdict', 'coverageState', 'googleCanonical', 'lastCrawlTime', 'pageFetchState']) if ((prev[f] || '') !== (cur[f] || '')) changes.push({ url, field: f, before: prev[f] || '', after: cur[f] || '' });
    }
    state.urls[url] = { ...cur, history: [...((prev && prev.history) || []), { checkedAt: cur.checkedAt, verdict: cur.verdict, coverageState: cur.coverageState, lastCrawlTime: cur.lastCrawlTime, googleCanonical: cur.googleCanonical }].slice(-10) };
    const d = deploys.get(url);
    rows.push({ ...cur, lastChange: d ? d.at : '', lastChangeWave: d ? d.wave : '', recrawledAfterChange: d ? (cur.lastCrawlTime && cur.lastCrawlTime > d.at ? 'yes' : 'no') : '', canonicalMismatch: cur.googleCanonical && cur.userCanonical && cur.googleCanonical !== cur.userCanonical ? 'yes' : '' });
    if ((n + 1) % 20 === 0) {
      log(`  ${n + 1}/${urls.length}`);
      writeJson(statePath(ws), state);
    }
    await sleep(flags.delay);
  }
  writeJson(statePath(ws), state);
  const csv = writeCsvFile(ws.dataFile('indexing', 'inspect', 'csv'), rows.map((r) => ({
    url: r.url, verdict: r.verdict || '', coverage: r.coverageState || r.error || '', last_crawl: r.lastCrawlTime || '', google_canonical: r.googleCanonical || '', user_canonical: r.userCanonical || '', canonical_mismatch: r.canonicalMismatch || '', last_change: r.lastChange || '', change_wave: r.lastChangeWave || '', recrawled_after_change: r.recrawledAfterChange || '', fetch: r.pageFetchState || '', robots: r.robotsTxtState || '', rich_results: (r.richResults || []).join(' '),
  })));
  const indexed = rows.filter((r) => r.verdict === 'PASS').length;
  out(`Inspected ${rows.length} URL(s): ${indexed} indexed (PASS), ${rows.length - indexed} not or errors.`);
  const notIndexed = rows.filter((r) => r.verdict && r.verdict !== 'PASS');
  if (notIndexed.length) out(textTable(['url', 'coverage', 'last crawl'], notIndexed.slice(0, 15).map((r) => [shortUrl(r.url), r.coverageState, (r.lastCrawlTime || '').slice(0, 10)])));
  const notRecrawled = rows.filter((r) => r.recrawledAfterChange === 'no');
  if (notRecrawled.length) out(`${notRecrawled.length} changed URL(s) not recrawled since their deploy: Google has not seen the new version yet, so their rankings cannot be judged.`);
  const mism = rows.filter((r) => r.canonicalMismatch);
  if (mism.length) out(`${mism.length} URL(s) where Google chose a different canonical than declared.`);
  if (changes.length) {
    out('\nChanges since the previous inspection:');
    out(textTable(['url', 'field', 'before', 'after'], changes.slice(0, 30).map((c) => [shortUrl(c.url), c.field, c.before.slice(0, 40), c.after.slice(0, 40)])));
  }
  if (stopped) out(`\n${stopped}`);
  out(`\nwrote ${csv}\nupdated ${statePath(ws)}`);
  return 0;
}

// ---------- manual list ----------
/** Pure prioritization for the "Request indexing" checklist; exported for tests. */
export function manualList({ state, deploys, crawl, inventory, impressions, now = Date.now(), limit = 10, homeUrl = '' }) {
  const must = [];
  const conditional = [];
  const skip = [];
  const crawlBy = new Map((crawl || []).map((p) => [p.url, p]));
  const invBy = new Map((inventory || []).map((r) => [r.url, r]));
  const urls = new Set([...Object.keys(state.urls || {}), ...deploys.keys()]);
  for (const url of urls) {
    const s = state.urls[url];
    const d = deploys.get(url);
    const inv = invBy.get(url);
    const page = crawlBy.get(url);
    const reasons = [];
    if (inv && /merge|redirect|301/i.test(`${inv.action || ''}`)) {
      skip.push({ url, reason: `scheduled for ${inv.action}` });
      continue;
    }
    if (/[?&](page|p)=\d+|\/page\/\d+\/?$/i.test(url)) {
      skip.push({ url, reason: 'pagination' });
      continue;
    }
    if (page && (page.status !== 200 || page.noindex || (page.canonicalStatus && page.canonicalStatus !== 'self'))) {
      skip.push({ url, reason: `not indexable live (HTTP ${page.status}${page.noindex ? ', noindex' : ''}${page.canonicalStatus && page.canonicalStatus !== 'self' ? ', canonical elsewhere' : ''})` });
      continue;
    }
    if (inv && /^[CD]$/.test(inv.grade || '')) {
      skip.push({ url, reason: `thin/low-grade content (grade ${inv.grade}) - fix first` });
      continue;
    }
    const lastCrawl = s && s.lastCrawlTime ? Date.parse(s.lastCrawlTime) : 0;
    if (s && s.verdict === 'PASS' && (!d || lastCrawl > Date.parse(d.at))) {
      skip.push({ url, reason: 'already indexed and crawled after the last change' });
      continue;
    }
    if (s) {
      if (/redirect/i.test(s.coverageState)) reasons.push(`stale record: "${s.coverageState}"`);
      if (s.googleCanonical && homeUrl && s.googleCanonical === homeUrl && url !== homeUrl) reasons.push('Google picked the home page as canonical');
      if (lastCrawl && now - lastCrawl > 60 * 86400000) reasons.push(`last crawled ${Math.round((now - lastCrawl) / 86400000)} days ago`);
      if (/unknown|discovered|crawled - currently not indexed/i.test(s.coverageState)) reasons.push(`"${s.coverageState}"`);
    }
    if (d && d.open && (!lastCrawl || lastCrawl < Date.parse(d.at)) && now - Date.parse(d.at) > 48 * 3600000) reasons.push(`changed in ${d.wave} > 48h ago and not recrawled since`);
    if (!reasons.length) continue;
    const verified = Boolean(page);
    const item = { url, reason: reasons.join('; ') + (verified ? '' : ' (live status not verified: run crawl-site first)'), impressions: impressions.get(url) || 0, wave: d ? d.wave : '' };
    (verified ? must : conditional).push(item);
  }
  const rank = (a, b) => (b.wave ? 1 : 0) - (a.wave ? 1 : 0) || b.impressions - a.impressions;
  must.sort(rank);
  conditional.sort(rank);
  return { must: must.slice(0, limit), conditional: conditional.slice(0, limit), skip };
}

async function cmdListManual(ws, flags) {
  const state = loadState(ws);
  const deploys = deployTimes(ws);
  const crawlFile = ws.listData('crawl', /-crawl\.json$/)[0];
  const crawl = crawlFile ? readJson(crawlFile, { pages: [] }).pages : null;
  const invFile = ws.path('content-inventory.csv');
  const inventory = fs.existsSync(invFile) ? csvToRecords(fs.readFileSync(invFile, 'utf8')).records : null;
  const impressions = new Map();
  const gscFile = ws.listData('gsc', /-(page|query-page)[^/]*\.json$/)[0];
  if (gscFile) {
    try {
      const g = loadGscFile(gscFile);
      if (g.dimensions.includes('page')) for (const [p, m] of groupMetrics(g.rows, (r) => normalizeUrl(r.page) || r.page)) impressions.set(p, m.impressions);
    } catch {
      /* optional */
    }
  }
  if (!Object.keys(state.urls).length && !deploys.size) {
    out(`No inspection data yet. Run ${scriptCmd('indexing.mjs')} inspect first (it records coverage and last crawl times).`);
    return 0;
  }
  const res = manualList({ state, deploys, crawl, inventory, impressions, limit: flags.limit ?? 10, homeUrl: normalizeUrl(ws.siteUrl()) });
  const link = (u) => `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(ws.config.gsc.siteUrl || '')}&id=${encodeURIComponent(u)}`;
  const L = [`# Request indexing checklist (${ws.today()})`, '', 'Only a human can click "Request indexing" (Search Console allows roughly 10 per day). Open each link, wait for the live result, click Request indexing, then note the date in logs/changes.md and re-inspect after 7 days.', ''];
  L.push('## Must do', '');
  for (const i of res.must) L.push(`- [ ] ${i.url} - ${i.reason}\n  ${link(i.url)}`);
  if (!res.must.length) L.push('- (none)');
  L.push('', '## Conditional (verify live status first)', '');
  for (const i of res.conditional) L.push(`- [ ] ${i.url} - ${i.reason}\n  ${link(i.url)}`);
  if (!res.conditional.length) L.push('- (none)');
  L.push('', '## Not needed', '');
  for (const i of res.skip.slice(0, 30)) L.push(`- ${i.url} - ${i.reason}`);
  if (!res.skip.length) L.push('- (none)');
  const file = writeText(ws.dataFile('indexing', 'manual-list', 'md'), L.join('\n'));
  out(L.join('\n'));
  out(`\nwrote ${file}`);
  return 0;
}

// ---------- coverage diff ----------
const ISSUE_COLS = ['reason', 'issue', 'type', 'status', '原因', '問題', '狀態', '原因／問題', 'motivo', 'raison', '理由'];
const COUNT_COLS = ['pages', 'affected pages', 'urls', 'count', '網頁', '頁數', '受影響的網頁', '数量', 'páginas', 'ページ'];

export function summarizeCoverage(text, { strict = false } = {}) {
  const { headers, records } = csvToRecords(text);
  const issue = findColumn(headers, ISSUE_COLS) || (strict ? '' : headers[0]);
  if (!issue) return null;
  const count = findColumn(headers, COUNT_COLS);
  const map = new Map();
  for (const r of records) {
    const k = r[issue] || '(blank)';
    map.set(k, (map.get(k) || 0) + (count ? Number(String(r[count]).replace(/[,\s]/g, '')) || 0 : 1));
  }
  return map;
}

function readCoverage(file) {
  if (/\.zip$/i.test(file)) {
    const entries = readZipEntries(file).filter((e) => /\.csv$/i.test(e.name));
    if (!entries.length) throw new UserError(`${file} contains no CSV`);
    // the export has a chart (one row per date), issue tables (critical / non-critical) and metadata: merge the issue tables only
    const merged = new Map();
    for (const e of entries) {
      const s = summarizeCoverage(e.text, { strict: true });
      if (!s) continue;
      for (const [k, v] of s) merged.set(k, (merged.get(k) || 0) + v);
    }
    if (!merged.size) throw new UserError(`${file}: no CSV with an issue/reason column (${entries.map((e) => e.name).join(', ')})`);
    return merged;
  }
  return summarizeCoverage(fs.readFileSync(file, 'utf8'));
}

async function cmdCoverageDiff(ws, flags, positionals) {
  let files = positionals.map((f) => path.resolve(f));
  if (files.length < 2) files = ws.listData('indexing', /coverage.*\.(csv|zip)$/i).slice(0, 2).reverse();
  if (files.length < 2) throw new UserError('coverage-diff needs two Page indexing exports', { hint: 'Search Console -> Pages -> Export (CSV or zip). Save them as data/indexing/<date>-coverage.zip, or pass two files.' });
  const [a, b] = files.map(readCoverage);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const rows = keys.map((k) => ({ issue: k, before: a.get(k) || 0, after: b.get(k) || 0, delta: (b.get(k) || 0) - (a.get(k) || 0) })).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  out(`${path.basename(files[0])} -> ${path.basename(files[1])}`);
  out(textTable(['issue', 'before', 'after', 'change'], rows.map((r) => [r.issue, r.before, r.after, r.delta > 0 ? `+${r.delta}` : r.delta])));
  return 0;
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help || !positionals.length) return void process.stdout.write(HELP);
  const [cmd, ...rest] = positionals;
  const ws = loadWorkspace(flags);
  if (cmd === 'indexnow') return cmdIndexnow(ws, flags, rest);
  if (cmd === 'sitemap-submit') return cmdSitemapSubmit(ws, flags);
  if (cmd === 'sitemaps') return cmdSitemaps(ws, flags);
  if (cmd === 'inspect') return cmdInspect(ws, flags, rest);
  if (cmd === 'list-manual') return cmdListManual(ws, flags);
  if (cmd === 'coverage-diff') return cmdCoverageDiff(ws, flags, rest);
  throw new UserError(`Unknown subcommand "${cmd}"`, { hint: 'Use indexnow, sitemap-submit, sitemaps, inspect, list-manual or coverage-diff.' });
}

runMain(import.meta.url, main);
