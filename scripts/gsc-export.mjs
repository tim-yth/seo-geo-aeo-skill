#!/usr/bin/env node
// Export Search Analytics rows (any dimensions, filters, full pagination) to JSON + CSV.
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, slugify } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { gscClient, buildFilters, GSC_DIMENSIONS, GSC_TYPES } from './lib/gsc.mjs';
import { resolveRange, gscToday, addDays } from './lib/dates.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { aggregate } from './lib/metrics.mjs';
import { fmtInt, fmtPct, fmtPos, textTable } from './lib/format.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  site: { type: 'string', placeholder: 'property', desc: 'Override gsc.siteUrl' },
  dimensions: { type: 'csv', placeholder: 'list', desc: `Dimensions: ${GSC_DIMENSIONS.join(', ')}`, default: ['query', 'page'] },
  start: { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'Start date (PT)' },
  end: { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'End date (PT). Default: newest final day (from the API)' },
  days: { type: 'int', desc: 'Window length when --start is not given', default: 28 },
  type: { type: 'string', desc: `Search type: ${GSC_TYPES.join(', ')}`, default: 'web', choices: GSC_TYPES },
  'data-state': { type: 'string', desc: 'final (default) | all (includes fresh, provisional days) | hourly_all (with the hour dimension)', default: 'final', choices: ['final', 'all', 'hourly_all'] },
  'page-regex': { type: 'string', placeholder: 're2', desc: 'Only pages matching this RE2 regex' },
  'page-exclude': { type: 'string', placeholder: 're2', desc: 'Exclude pages matching this RE2 regex' },
  page: { type: 'string', placeholder: 'url', desc: 'Only this exact page URL' },
  'query-regex': { type: 'string', placeholder: 're2', desc: 'Only queries matching this RE2 regex' },
  'query-exclude': { type: 'string', placeholder: 're2', desc: 'Exclude queries matching this RE2 regex' },
  query: { type: 'string', desc: 'Only this exact query' },
  country: { type: 'string', placeholder: 'iso3', desc: 'Country filter, ISO-3166 alpha-3 (usa, twn, deu)' },
  device: { type: 'string', desc: 'DESKTOP | MOBILE | TABLET' },
  'search-appearance': { type: 'string', desc: 'searchAppearance filter value' },
  aggregation: { type: 'string', desc: 'auto | byPage | byProperty', choices: ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] },
  'max-rows': { type: 'int', desc: 'Stop after this many rows (default: all)' },
  name: { type: 'string', desc: 'Output name (default derived from dimensions and window)' },
  out: { type: 'string', placeholder: 'path', desc: 'Output base path without extension (default <workspace>/data/gsc/<date>-<name>)' },
  format: { type: 'csv', desc: 'json,csv', default: ['json', 'csv'] },
  print: { type: 'int', desc: 'Print the top N rows by clicks', default: 10 },
};

const HELP = formatHelp({
  usage: 'node scripts/gsc-export.mjs [--dimensions query,page] [--days 28 | --start A --end B] [filters]',
  summary:
    'Read-only Search Analytics export with full pagination (25,000 rows per request). Writes <workspace>/data/gsc/<today>-<name>.json ' +
    '({meta, rows}) and .csv. Dates are Pacific Time; by default the window ends at the newest day whose data is final.',
  spec: SPEC,
  examples: [
    'node scripts/gsc-export.mjs --dimensions query,page --days 28',
    'node scripts/gsc-export.mjs --dimensions date --days 480 --name daily-16mo',
    'node scripts/gsc-export.mjs --dimensions query --page-regex "^https://www.example.com/blog/" --country usa --device MOBILE',
    'node scripts/gsc-export.mjs --dimensions hour,query --data-state hourly_all --start 2026-10-20 --query "best widgets"',
  ],
  notes: [
    'Anonymized queries are omitted by Google from query-level rows, so query totals are lower than page/site totals.',
    'Discover and Google News types have no query dimension and no position.',
  ],
});

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const dims = flags.dimensions;
  for (const d of dims) if (!GSC_DIMENSIONS.includes(d)) throw new UserError(`Unknown dimension "${d}"`, { hint: `Valid: ${GSC_DIMENSIONS.join(', ')}` });
  if (['discover', 'googleNews'].includes(flags.type) && dims.includes('query')) throw new UserError(`The ${flags.type} type has no query dimension`);
  let dataState = flags.dataState;
  if (dims.includes('hour') && dataState !== 'hourly_all') {
    dataState = 'hourly_all';
    log('Note: the hour dimension requires dataState=hourly_all; using it.');
  }
  const gsc = gscClient(ws, flags);
  let latest;
  if (!flags.end) {
    latest = dataState === 'final' ? await gsc.latestFinalDate() : gscToday();
    if (dataState !== 'final') log(`Note: data-state ${dataState} includes provisional data for the newest days (up to ${latest}).`);
  }
  const range = resolveRange({ start: flags.start, end: flags.end, days: flags.days, latestEnd: latest || flags.end });
  if (dims.includes('hour') && range.start < addDays(gscToday(), -10)) log('Note: hourly data only covers roughly the last 10 days.');
  const body = {
    startDate: range.start,
    endDate: range.end,
    dimensions: dims,
    type: flags.type,
    dataState,
    dimensionFilterGroups: buildFilters({
      pageRegex: flags.pageRegex,
      pageExclude: flags.pageExclude,
      page: flags.page,
      queryRegex: flags.queryRegex,
      queryExclude: flags.queryExclude,
      query: flags.query,
      country: flags.country,
      device: flags.device,
      searchAppearance: flags.searchAppearance,
    }),
    ...(flags.aggregation ? { aggregationType: flags.aggregation } : {}),
  };
  log(`Querying ${gsc.siteUrl} ${range.start} -> ${range.end} (${range.days} days, ${dims.join('+') || 'totals'}, ${flags.type}, ${dataState})...`);
  const result = await gsc.query(body, { maxRows: flags.maxRows || Infinity, onPage: (n) => log(`  ${n} rows`) });
  const name = flags.name || `${slugify(dims.join('-')) || 'totals'}-${flags.start || flags.end ? `${range.start}_${range.end}` : `${range.days}d`}${flags.type !== 'web' ? `-${flags.type}` : ''}`;
  const base = flags.out ? path.resolve(flags.out.replace(/\.(json|csv)$/i, '')) : ws.dataFile('gsc', name, 'json').replace(/\.json$/, '');
  const meta = {
    tool: 'gsc-export',
    siteUrl: gsc.siteUrl,
    startDate: range.start,
    endDate: range.end,
    days: range.days,
    dimensions: dims,
    type: flags.type,
    dataState,
    filters: body.dimensionFilterGroups,
    aggregation: result.aggregation,
    firstIncompleteDate: result.metadata.firstIncompleteDate || null,
    firstIncompleteHour: result.metadata.firstIncompleteHour || null,
    rowCount: result.rows.length,
    truncated: result.truncated,
    fetchedAt: new Date().toISOString(),
    timezoneNote: 'Search Console dates are Pacific Time (America/Los_Angeles).',
  };
  const written = [];
  if (flags.format.includes('json')) written.push(writeJson(`${base}.json`, { meta, rows: result.rows }));
  if (flags.format.includes('csv')) written.push(writeCsvFile(`${base}.csv`, result.rows, [...dims, 'clicks', 'impressions', 'ctr', 'position']));

  const total = aggregate(result.rows);
  out(`GSC ${gsc.siteUrl} | ${range.start} -> ${range.end} | ${dims.join('+') || 'totals'} | ${result.rows.length} rows${result.truncated ? ' (truncated)' : ''}`);
  out(`Sum of rows: ${fmtInt(total.clicks)} clicks, ${fmtInt(total.impressions)} impressions, CTR ${fmtPct(total.ctr, 2)}, avg position ${fmtPos(total.position)} (impression-weighted)`);
  if (meta.firstIncompleteDate) out(`Provisional from ${meta.firstIncompleteDate} (PT); later days may still change.`);
  if (flags.print > 0 && result.rows.length) {
    const top = [...result.rows].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, flags.print);
    out('');
    out(textTable([...dims, 'clicks', 'impr', 'ctr', 'pos'], top.map((r) => [...dims.map((d) => String(r[d]).slice(0, 70)), fmtInt(r.clicks), fmtInt(r.impressions), fmtPct(r.ctr), fmtPos(r.position)])));
  }
  out('');
  for (const f of written) out(`wrote ${f}`);
  return 0;
}

runMain(import.meta.url, main);
