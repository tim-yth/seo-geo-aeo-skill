#!/usr/bin/env node
// Google ranking updates, Search Console data anomalies and logged site events: list them, check comparison windows
// against them, and refresh the dashboard incidents into the workspace.
import { parseArgs, formatHelp, parseRangeArg, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, UserError, scriptCmd } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { gscToday } from './lib/dates.mjs';
import { loadEvents, overlapEvents, describeOverlap, overlapAdvice, metricReliability, refreshStatusEvents, ledgerAgeDays, STATUS_INCIDENTS_URL } from './lib/events.mjs';
import { textTable } from './lib/format.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  since: { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'list: only events ending on or after this day', default: '2024-01-01' },
  kind: { type: 'csv', placeholder: 'kinds', desc: 'list/check: core, spam, discover, ranking-other, indexing, serving, gsc-anomaly, measurement, serp-feature, site' },
  pre: { type: 'string', placeholder: 'start:end', desc: 'check: pre window (PT dates)' },
  post: { type: 'string', placeholder: 'start:end', desc: 'check: post window (PT dates)' },
  window: { type: 'list', placeholder: 'start:end', desc: 'check: any other window (repeatable), e.g. a guardrail baseline' },
  appearance: { type: 'boolean', desc: 'check: include search-appearance anomalies (product snippets, job listings, ...)' },
  'fail-on-overlap': { type: 'boolean', desc: 'check: exit 2 when a ranking update, site event or impressions anomaly overlaps (for CI/schedulers)' },
  json: { type: 'boolean', desc: 'Print JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/search-events.mjs list [--since 2025-01-01] [--kind core,spam]',
    'node scripts/search-events.mjs check --pre 2026-09-01:2026-09-28 --post 2026-10-06:2026-11-02 [--fail-on-overlap]',
    'node scripts/search-events.mjs refresh',
  ],
  summary:
    'One ledger of everything outside your site that moves Search Console numbers: Google core/spam/Discover updates and ranking, ' +
    'indexing and serving incidents (Search Status Dashboard, verified 2024-2026), Search Console data anomalies (e.g. the impressions logging ' +
    'error 2025-05-13 -> 2026-04-27: impressions, CTR and position unreliable, clicks fine) and reporting changes, plus site-specific external ' +
    'events you log with log-change.mjs. "check" says which windows they overlap and which metrics become unreliable; gsc-compare, guardrail, ' +
    'review-due and split-test run the same check automatically. "refresh" downloads the dashboard\'s incidents.json (it only keeps about a year) ' +
    'into data/events/ so newer updates are known without waiting for a new skill release.',
  spec: SPEC,
  examples: [
    'node scripts/search-events.mjs list --kind core,spam,gsc-anomaly',
    'node scripts/search-events.mjs check --pre 2026-03-01:2026-03-28 --post 2026-04-02:2026-04-29',
    'node scripts/log-change.mjs add --type external-event --title "Viral mention on a news site" --date 2026-10-20 --until 2026-10-23',
  ],
  notes: [
    'Dates are Pacific Time days (the Search Console day). Ranking updates count with a settling buffer after their official end (core 7 days, spam 3).',
    'Only official Google sources are used for verified entries; third-party observations (e.g. the &num=100 change in Sept 2025) are shown as notes, never as facts.',
    `Source of new incidents: ${STATUS_INCIDENTS_URL}. The bundled ledger is scripts/data/google-events.json.`,
  ],
});

const fmtEvent = (e) => [e.id.length > 26 ? `${e.id.slice(0, 25)}~` : e.id, e.kind, e.start, e.ongoing ? `ongoing` : e.end, e.severity, e.title.length > 70 ? `${e.title.slice(0, 69)}~` : e.title];

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const cmd = positionals[0] || 'list';
  const ws = loadWorkspace(flags, { requireConfig: false });
  const today = gscToday();
  if (cmd === 'refresh') {
    if (!ws.exists) throw new UserError('refresh stores the incidents in a workspace; none found', { hint: `Create one: ${scriptCmd('init.mjs')} --url https://your-site.com` });
    let r;
    try {
      r = await refreshStatusEvents(ws);
    } catch (e) {
      throw new UserError(`Could not refresh the Search Status Dashboard incidents (${e.message})`, { hint: 'The bundled ledger still works offline. Retry later or check your network.' });
    }
    out(`Search Status Dashboard: ${r.added} new, ${r.updated} updated, ${r.total} incidents cached.`);
    out(`wrote ${r.file}`);
    return 0;
  }
  const events = loadEvents(ws.exists ? ws : null, { today });
  if (cmd === 'list') {
    const rows = events.filter((e) => e.end >= flags.since && (!flags.kind.length || flags.kind.includes(e.kind)));
    if (flags.json) return void process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    out(textTable(['id', 'kind', 'start (PT)', 'end (PT)', 'severity', 'title'], rows.map(fmtEvent)));
    const age = ledgerAgeDays(today);
    out(`\n${rows.length} event(s). Bundled ledger verified ${age === null ? '?' : `${age} days ago`}${age !== null && age > 90 ? ` - run ${scriptCmd('search-events.mjs')} refresh` : ''}.`);
    return 0;
  }
  if (cmd !== 'check') throw new UserError(`Unknown subcommand "${cmd}"`, { hint: 'Use list, check or refresh.' });
  const windows = [];
  if (flags.pre) windows.push({ name: 'pre', ...parseRangeArg(flags.pre, 'pre') });
  if (flags.post) windows.push({ name: 'post', ...parseRangeArg(flags.post, 'post') });
  flags.window.forEach((w, i) => windows.push({ name: `window ${i + 1}`, ...parseRangeArg(w, 'window') }));
  if (!windows.length) throw new UserError('check needs --pre/--post or --window START:END');
  const kinds = flags.kind.length ? flags.kind : null;
  const hits = overlapEvents(events, windows, { appearance: flags.appearance, kinds });
  const rel = metricReliability(events, windows, { appearance: flags.appearance });
  const advice = overlapAdvice(hits);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ windows, overlaps: hits.map((h) => ({ ...h, text: describeOverlap(h) })), unreliableMetrics: rel.unreliable, advice }, null, 2)}\n`);
  } else {
    out(`Windows: ${windows.map((w) => `${w.name} ${w.start}..${w.end}`).join(' | ')} (PT)`);
    if (!hits.length) out('No known Google update, Search Console anomaly or logged site event overlaps these windows.');
    for (const h of hits) out(`${h.event.severity === 'warn' ? 'WARNING' : h.event.severity === 'note' ? 'NOTE' : 'INFO'}: ${describeOverlap(h)}`);
    if (rel.unreliable.length) out(`Metrics not comparable across these windows: ${rel.unreliable.join(', ')}.`);
    for (const a of advice) out(`-> ${a}`);
  }
  const blocking = hits.some((h) => h.event.severity === 'warn');
  return flags.failOnOverlap && blocking ? 2 : 0;
}

runMain(import.meta.url, main);
