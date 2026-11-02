#!/usr/bin/env node
// PageSpeed Insights (Lighthouse lab + CrUX field data) for a set of URLs, mobile and desktop.
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, collectList, normalizeUrl, mapLimit, sleep } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { loadGscFile } from './lib/gsc.mjs';
import { groupMetrics } from './lib/metrics.mjs';
import { explainGoogleError } from './lib/google-auth.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { textTable, shortUrl } from './lib/format.mjs';

const PSI = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

const SPEC = {
  ...COMMON_FLAGS,
  'from-file': { type: 'string', placeholder: 'file', desc: 'URLs, one per line' },
  'top-pages': { type: 'int', desc: 'Also test the top N pages by clicks from the newest GSC page export' },
  strategy: { type: 'csv', desc: 'mobile,desktop', default: ['mobile', 'desktop'] },
  concurrency: { type: 'int', desc: 'Parallel PSI calls', default: 2 },
  name: { type: 'string', desc: 'Output name', default: 'pagespeed' },
};

const HELP = formatHelp({
  usage: 'node scripts/pagespeed.mjs [url...] [--from-file f] [--top-pages 5] [--strategy mobile,desktop]',
  summary:
    'Runs PageSpeed Insights for each URL and strategy and records lab metrics (performance score, LCP, CLS, TBT as the lab proxy for INP, ' +
    'FCP, Speed Index) and Chrome UX Report field data at p75 (LCP, INP, CLS, FCP, TTFB with good/needs-improvement/poor; falls back to ' +
    'origin-level data when the URL has too little traffic). Writes data/pagespeed/<today>-<name>.csv/.json. Defaults to the home page.',
  spec: SPEC,
  examples: ['node scripts/pagespeed.mjs', 'node scripts/pagespeed.mjs https://www.example.com/blog/post/ --strategy mobile', 'node scripts/pagespeed.mjs --top-pages 10'],
  notes: [
    'API key (optional, raises quota): set the env var named in config.pagespeed.apiKeyEnv (default PAGESPEED_API_KEY). It is never printed.',
    'Use lab numbers to locate problems; judge Core Web Vitals on field data (CrUX, 28-day rolling).',
  ],
});

const audit = (lh, id) => (lh.audits && lh.audits[id] ? lh.audits[id].numericValue : null);

/** Flatten a PSI response; exported for tests. */
export function summarizePsi(url, strategy, data) {
  const lh = data.lighthouseResult || {};
  const field = (data.loadingExperience && data.loadingExperience.metrics) || null;
  const origin = (data.originLoadingExperience && data.originLoadingExperience.metrics) || null;
  const src = field && Object.keys(field).length ? field : origin;
  const m = (k) => (src && src[k] ? src[k] : null);
  const p75 = (k, div = 1) => (m(k) ? m(k).percentile / div : null);
  return {
    url,
    strategy,
    score: lh.categories && lh.categories.performance && lh.categories.performance.score !== null ? Math.round(lh.categories.performance.score * 100) : null,
    lab_lcp_ms: audit(lh, 'largest-contentful-paint'),
    lab_cls: audit(lh, 'cumulative-layout-shift'),
    lab_tbt_ms: audit(lh, 'total-blocking-time'),
    lab_fcp_ms: audit(lh, 'first-contentful-paint'),
    lab_si_ms: audit(lh, 'speed-index'),
    field_source: src === field && field ? 'url' : origin ? 'origin' : 'none',
    field_overall: src ? ((src === field ? data.loadingExperience : data.originLoadingExperience) || {}).overall_category || '' : '',
    field_lcp_ms: p75('LARGEST_CONTENTFUL_PAINT_MS'),
    field_lcp: m('LARGEST_CONTENTFUL_PAINT_MS') ? m('LARGEST_CONTENTFUL_PAINT_MS').category : '',
    field_inp_ms: p75('INTERACTION_TO_NEXT_PAINT'),
    field_inp: m('INTERACTION_TO_NEXT_PAINT') ? m('INTERACTION_TO_NEXT_PAINT').category : '',
    field_cls: p75('CUMULATIVE_LAYOUT_SHIFT_SCORE', 100),
    field_cls_cat: m('CUMULATIVE_LAYOUT_SHIFT_SCORE') ? m('CUMULATIVE_LAYOUT_SHIFT_SCORE').category : '',
    field_fcp_ms: p75('FIRST_CONTENTFUL_PAINT_MS'),
    field_ttfb_ms: p75('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
    final_url: lh.finalDisplayedUrl || lh.finalUrl || url,
    lighthouse: lh.lighthouseVersion || '',
    error: lh.runtimeError ? `${lh.runtimeError.code}: ${lh.runtimeError.message}` : '',
  };
}

async function runPsi(url, strategy, key) {
  const qs = new URLSearchParams({ url, strategy, category: 'performance' });
  if (key) qs.set('key', key);
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`${PSI}?${qs}`, { signal: AbortSignal.timeout(180000) });
    } catch (e) {
      if (attempt < 2) {
        await sleep(3000);
        continue;
      }
      return { error: `network error: ${e.name === 'TimeoutError' ? 'timeout' : e.message}` };
    }
    if (res.ok) return { data: await res.json() };
    const body = await res.json().catch(() => ({}));
    const msg = (body.error && body.error.message) || `HTTP ${res.status}`;
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    return { error: `PSI ${res.status}: ${msg.replace(key || '\u0000', '***')}`, hint: explainGoogleError('psi', res.status, msg) };
  }
  return { error: 'PSI failed after retries' };
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  let urls = collectList(positionals, flags.fromFile).map((u) => (/^https?:/i.test(u) ? u : new URL(u, ws.origin()).href));
  if (flags.topPages) {
    const file = ws.listData('gsc', /\.json$/).find((f) => {
      try {
        return loadGscFile(f).dimensions.includes('page');
      } catch {
        return false;
      }
    });
    if (!file) log('No GSC export with a page dimension found; run gsc-export.mjs --dimensions page first.');
    else {
      const g = loadGscFile(file);
      urls.push(...[...groupMetrics(g.rows, (r) => normalizeUrl(r.page) || r.page)].sort((a, b) => b[1].clicks - a[1].clicks).slice(0, flags.topPages).map(([u]) => u));
    }
  }
  if (!urls.length) urls = [ws.siteUrl()];
  urls = [...new Set(urls)];
  for (const s of flags.strategy) if (!['mobile', 'desktop'].includes(s)) throw new UserError(`Unknown strategy "${s}" (mobile or desktop)`);
  const key = process.env[ws.config.pagespeed.apiKeyEnv || 'PAGESPEED_API_KEY'] || '';
  if (!key) log('No PageSpeed API key set: running without one (low quota; set the env var named in config.pagespeed.apiKeyEnv).');
  const jobs = urls.flatMap((u) => flags.strategy.map((s) => ({ url: u, strategy: s })));
  log(`Running ${jobs.length} PageSpeed test(s); each takes 10-60 s...`);
  const raw = [];
  const rows = await mapLimit(jobs, flags.concurrency, async (j) => {
    const r = await runPsi(j.url, j.strategy, key);
    if (r.error) {
      log(`  ${j.strategy} ${j.url}: ${r.error}`);
      return { url: j.url, strategy: j.strategy, error: r.error };
    }
    raw.push({ url: j.url, strategy: j.strategy, loadingExperience: r.data.loadingExperience, originLoadingExperience: r.data.originLoadingExperience, categories: r.data.lighthouseResult && r.data.lighthouseResult.categories });
    return summarizePsi(j.url, j.strategy, r.data);
  });
  const base = ws.dataFile('pagespeed', flags.name, 'csv').replace(/\.csv$/, '');
  const cols = ['url', 'strategy', 'score', 'lab_lcp_ms', 'lab_cls', 'lab_tbt_ms', 'lab_fcp_ms', 'lab_si_ms', 'field_source', 'field_overall', 'field_lcp_ms', 'field_lcp', 'field_inp_ms', 'field_inp', 'field_cls', 'field_cls_cat', 'field_fcp_ms', 'field_ttfb_ms', 'final_url', 'error'];
  const csv = writeCsvFile(`${base}.csv`, rows, cols);
  const json = writeJson(`${base}.json`, { fetchedAt: new Date().toISOString(), rows, field: raw });
  const ms = (v) => (v === null || v === undefined ? '-' : `${Math.round(v)}`);
  out(textTable(['url', 'strategy', 'score', 'lab LCP', 'lab CLS', 'TBT', 'field LCP p75', 'INP p75', 'CLS p75', 'field'], rows.map((r) => [shortUrl(r.url), r.strategy, r.error ? 'ERR' : r.score ?? '-', ms(r.lab_lcp_ms), r.lab_cls === null || r.lab_cls === undefined ? '-' : r.lab_cls.toFixed(3), ms(r.lab_tbt_ms), r.field_lcp_ms ? `${ms(r.field_lcp_ms)} ${r.field_lcp}` : '-', r.field_inp_ms ? `${ms(r.field_inp_ms)} ${r.field_inp}` : '-', r.field_cls !== null && r.field_cls !== undefined ? `${r.field_cls.toFixed(2)} ${r.field_cls_cat}` : '-', r.field_source || '-'])));
  out('Thresholds (p75 field): LCP <= 2500 ms good / > 4000 poor; INP <= 200 ms / > 500; CLS <= 0.1 / > 0.25.');
  out(`\nwrote ${csv}\nwrote ${json}`);
  return rows.every((r) => r.error) ? 1 : 0;
}

runMain(import.meta.url, main);
