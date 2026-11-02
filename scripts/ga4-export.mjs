#!/usr/bin/env node
// GA4 Data API export: any dimensions/metrics/filters, plus SEO/GEO presets.
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, slugify } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { ga4Client, parseFilter, PRESETS } from './lib/ga4.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { textTable, fmtInt } from './lib/format.mjs';
import { groupMetrics } from './lib/metrics.mjs';
import { describeTz } from './lib/dates.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  property: { type: 'string', placeholder: 'id', desc: 'Override ga4.propertyId (numeric)' },
  preset: { type: 'string', desc: `Preset: ${Object.keys(PRESETS).join(', ')}`, choices: Object.keys(PRESETS) },
  dimensions: { type: 'csv', placeholder: 'list', desc: 'Dimensions, e.g. date,landingPagePlusQueryString' },
  metrics: { type: 'csv', placeholder: 'list', desc: 'Metrics, e.g. sessions,engagedSessions,keyEvents' },
  filter: { type: 'string', placeholder: 'expr', desc: 'AND-ed filters: "field==v;field=~regex;field!=v;field^=prefix;field*=text;metric>10"' },
  channel: { type: 'string', desc: 'Shortcut for sessionDefaultChannelGroup==<value> (e.g. "Organic Search")' },
  start: { type: 'string', placeholder: 'date', desc: 'YYYY-MM-DD, NdaysAgo, yesterday or today' },
  end: { type: 'string', placeholder: 'date', desc: 'Default: yesterday' },
  days: { type: 'int', desc: 'Window length when --start is not given (ends yesterday)', default: 28 },
  'order-by': { type: 'string', placeholder: 'field[:asc]', desc: 'Sort by a metric or dimension (default: first metric, descending)' },
  'max-rows': { type: 'int', desc: 'Stop after this many rows' },
  name: { type: 'string', desc: 'Output name (default: preset or dimensions)' },
  out: { type: 'string', placeholder: 'path', desc: 'Output base path without extension' },
  format: { type: 'csv', desc: 'json,csv', default: ['json', 'csv'] },
  print: { type: 'int', desc: 'Print the top N rows', default: 15 },
};

const HELP = formatHelp({
  usage: ['node scripts/ga4-export.mjs --preset organic-landing', 'node scripts/ga4-export.mjs --dimensions date,sessionDefaultChannelGroup --metrics sessions,keyEvents --days 90'],
  summary:
    'Read-only GA4 Data API (runReport) export with pagination. Presets: ' +
    Object.entries(PRESETS).map(([k, v]) => `${k} (${v.desc})`).join('; ') +
    '. Writes <workspace>/data/ga4/<today>-<name>.json/.csv.',
  spec: SPEC,
  examples: [
    'node scripts/ga4-export.mjs --preset ai-referrals --days 90',
    'node scripts/ga4-export.mjs --preset events-by-landing --channel "Organic Search"',
    'node scripts/ga4-export.mjs --dimensions landingPage --metrics sessions --filter "landingPage=~^/blog/;sessions>=10"',
  ],
  notes: [
    'GA4 days follow the property time zone (printed after each run); Search Console days are Pacific Time. Compare weeks/months, not single days, across the two.',
    'keyEvents replaced conversions in GA4 (2024). Low-volume reports can be thresholded (rows hidden) when Google signals is on.',
    'Dimension/metric names: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema',
  ],
});

function dateArg(v, label) {
  if (!v) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^(today|yesterday|\d+daysAgo)$/.test(v)) return v;
  throw new UserError(`Invalid ${label} "${v}" (use YYYY-MM-DD, NdaysAgo, yesterday or today)`);
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const preset = flags.preset ? PRESETS[flags.preset] : null;
  const dimensions = flags.dimensions.length ? flags.dimensions : preset ? preset.dimensions : ['date'];
  const metrics = flags.metrics.length ? flags.metrics : preset ? preset.metrics : ['sessions', 'totalUsers', 'engagedSessions', 'keyEvents'];
  const filterParts = [preset && preset.filter, flags.channel ? `sessionDefaultChannelGroup==${flags.channel}` : '', flags.filter].filter(Boolean);
  const filters = parseFilter(filterParts.join(';'), metrics);
  const end = dateArg(flags.end, '--end') || 'yesterday';
  const start = dateArg(flags.start, '--start') || `${flags.days}daysAgo`;
  const [orderField, orderDir] = (flags.orderBy || (preset && preset.orderBy) || metrics[0]).split(':');
  const body = {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    ...filters,
    orderBys: [metrics.includes(orderField) ? { metric: { metricName: orderField }, desc: orderDir !== 'asc' } : { dimension: { dimensionName: orderField }, desc: orderDir === 'desc' }],
    keepEmptyRows: false,
    returnPropertyQuota: false,
  };
  const ga = ga4Client(ws, flags);
  log(`GA4 property ${ga.propertyId}: ${dimensions.join('+') || 'totals'} x ${metrics.join(',')} (${start} -> ${end})...`);
  const res = await ga.runReport(body, { maxRows: flags.maxRows || Infinity });
  const name = flags.name || flags.preset || slugify(dimensions.join('-')) || 'totals';
  const base = flags.out ? path.resolve(flags.out.replace(/\.(json|csv)$/i, '')) : ws.dataFile('ga4', name, 'json').replace(/\.json$/, '');
  const warnings = [];
  const tz = res.metadata.timeZone || '';
  if (tz && tz !== ws.timezone()) warnings.push(`GA4 property time zone is ${describeTz(tz)} but site.timezone is ${ws.timezone()}: daily numbers will not line up with your deploy dates.`);
  warnings.push('Search Console days are Pacific Time; GA4 days follow the property time zone.');
  if (res.metadata.subjectToThresholding) warnings.push('Data is subject to thresholding (some rows hidden for privacy). Use longer ranges or fewer dimensions.');
  if (res.metadata.dataLossFromOtherRow) warnings.push('Some rows were grouped into "(other)" because of high cardinality. Narrow the date range or filter.');
  if (res.metadata.samplingMetadatas && res.metadata.samplingMetadatas.length) warnings.push('Results are sampled.');
  const meta = { tool: 'ga4-export', propertyId: ga.propertyId, preset: flags.preset || null, startDate: start, endDate: end, dimensions, metrics, filter: filterParts.join(';'), timeZone: tz, currencyCode: res.metadata.currencyCode || '', rowCount: res.rowCount, fetchedAt: new Date().toISOString(), warnings };
  const written = [];
  if (flags.format.includes('json')) written.push(writeJson(`${base}.json`, { meta, rows: res.records }));
  if (flags.format.includes('csv')) written.push(writeCsvFile(`${base}.csv`, res.records, [...dimensions, ...metrics]));

  out(`GA4 ${ga.propertyId} | ${start} -> ${end} | ${res.records.length} rows${tz ? ` | property time zone ${describeTz(tz)}` : ''}`);
  if (flags.preset === 'ai-referrals' && res.records.length) {
    const bySource = groupMetrics(res.records.map((r) => ({ ...r, clicks: r.sessions, impressions: 0 })), (r) => `${r.sessionSource}\t${r.sessionDefaultChannelGroup || '(not requested)'}`);
    out('\nSessions by AI source and default channel:');
    out(textTable(['source', 'default channel', 'sessions'], [...bySource].sort((a, b) => b[1].clicks - a[1].clicks).map(([k, v]) => [...k.split('\t'), fmtInt(v.clicks)])));
    const outsideAiChannel = [...bySource.keys()].filter((k) => !/AI Assistant/i.test(k.split('\t')[1])).map((k) => k.split('\t')[0]);
    out('GA4 has a default "AI Assistant" channel since 2026-05-13 (Google lists ChatGPT, Gemini, Claude, DeepSeek, Copilot, Grok; Perplexity is not listed and may still land in Referral; Google AI Overviews/AI Mode clicks stay in Organic Search). Check the channel column first.');
    if (outsideAiChannel.length) out(`Only for sources the default channel misses (${[...new Set(outsideAiChannel)].slice(0, 6).join(', ')}), add a custom channel group rule; do not count the same sessions twice. Comparisons that cross 2026-05-13 need the old AI referrers merged by hand.`);
  } else if (flags.preset === 'ai-referrals') out('No AI-assistant referrals in this range (or they arrive without a referrer and show as Direct).');
  if (flags.print > 0 && res.records.length) {
    out('');
    out(textTable([...dimensions, ...metrics], res.records.slice(0, flags.print).map((r) => [...dimensions.map((d) => String(r[d]).slice(0, 70)), ...metrics.map((m) => (typeof r[m] === 'number' && !Number.isInteger(r[m]) ? r[m].toFixed(3) : r[m]))])));
  }
  for (const w of warnings) out(`note: ${w}`);
  out('');
  for (const f of written) out(`wrote ${f}`);
  return 0;
}

runMain(import.meta.url, main);
