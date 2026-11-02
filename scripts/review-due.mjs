#!/usr/bin/env node
// What needs reviewing today: due/overdue checkpoints (with the exact commands), active freezes, overlapping waves.
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, scriptCmd } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { loadWaves, isOpen, checkpointStatus, activeFreezes, measurementEnd, isReviewed, firstGscDay, measuredUrls } from './lib/experiments.mjs';
import { textTable } from './lib/format.mjs';
import { loadEvents, overlapEvents, describeOverlap } from './lib/events.mjs';
import { gscToday } from './lib/dates.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  all: { type: 'boolean', desc: 'Also list checkpoints that are not due yet' },
  json: { type: 'boolean', desc: 'Print JSON' },
  'fail-on-overdue': { type: 'boolean', desc: 'Exit with code 2 when anything is overdue (for schedulers)' },
};

const HELP = formatHelp({
  usage: 'node scripts/review-due.mjs [--all] [--json]',
  summary:
    'Reads logs/experiments.json and lists acceptance checkpoints that are due (data final, review now) or overdue (> 3 days late), the date ' +
    'Search Console data for each window becomes final, the exact gsc-compare and log-change commands to run, active freezes, and open ' +
    'waves whose URLs overlap (their results can only be reported as an overall effect). Run it at the start of every session.',
  spec: SPEC,
  examples: ['node scripts/review-due.mjs', 'node scripts/review-due.mjs --all --json'],
  notes: ['D+7 = risk check only; D+14 = direction; D+28 = decision. A calendar date reached does not mean the data is final: use reviewOn.'],
});

/**
 * Google updates, Search Console anomalies and logged site events overlapping each item's pre/post windows.
 * Returns [{event, items:[{wave, checkpoint, windows, between}]}] for warn-level events (others with all: true).
 */
export function eventOverlaps(items, events, { all = false } = {}) {
  const byEvent = new Map();
  for (const i of items) {
    if (!i.pre || !i.post) continue;
    for (const h of overlapEvents(events, [{ name: 'pre', ...i.pre }, { name: 'post', ...i.post }])) {
      if (!all && h.event.severity !== 'warn') continue;
      if (!byEvent.has(h.event.id)) byEvent.set(h.event.id, { event: h.event, text: describeOverlap(h), items: [] });
      byEvent.get(h.event.id).items.push({ wave: i.wave, checkpoint: i.checkpoint, windows: h.windows, between: h.between });
    }
  }
  return [...byEvent.values()];
}

/** Pure evaluation; exported for tests. */
export function evaluate(waves, today) {
  const items = [];
  for (const w of waves) {
    if (!isOpen(w)) continue;
    for (const c of w.checkpoints || []) {
      if (isReviewed(c)) continue;
      const status = checkpointStatus(c, today);
      const last = c === w.checkpoints[w.checkpoints.length - 1];
      items.push({ wave: w.id, type: w.type, title: w.title, checkpoint: c.label, date: c.date, reviewOn: c.review && c.review.extendTo ? c.review.extendTo : c.reviewOn, status, followUp: Boolean(c.review), last, post: c.post, pre: c.pre, guardrails: w.guardrails || [] });
    }
  }
  const order = { overdue: 0, due: 1, pending: 2 };
  items.sort((a, b) => order[a.status] - order[b.status] || (a.reviewOn < b.reviewOn ? -1 : 1));
  const freezes = activeFreezes(waves, today).map((f) => ({ wave: f.id, title: f.title, since: f.date, until: f.until || '', scope: f.scope || '' }));
  const overlaps = [];
  const open = waves.filter((w) => isOpen(w) && ((w.urls || []).length || w.siteWide) && !['freeze', 'external-event'].includes(w.type));
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const [a, b] = open[i].date <= open[j].date ? [open[i], open[j]] : [open[j], open[i]];
      if (!(a.checkpoints || []).length) continue;
      const shared = a.siteWide || b.siteWide ? ['(site-wide)'] : measuredUrls(a).filter((u) => measuredUrls(b).includes(u));
      if (shared.length && firstGscDay(b) <= measurementEnd(a)) overlaps.push({ earlier: a.id, later: b.id, shared: shared.length, example: shared[0] });
    }
  }
  return { today, items, freezes, overlaps };
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const res = evaluate(loadWaves(ws), ws.today());
  const shown = res.items.filter((i) => flags.all || i.status !== 'pending');
  const evHits = eventOverlaps(shown, loadEvents(ws, { today: gscToday() }), { all: flags.json });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...res, items: shown, events: evHits.map((h) => ({ id: h.event.id, kind: h.event.kind, title: h.event.title, start: h.event.start, end: h.event.end, severity: h.event.severity, url: h.event.url, items: h.items })) }, null, 2)}\n`);
    return flags.failOnOverdue && res.items.some((i) => i.status === 'overdue') ? 2 : 0;
  }
  out(`Review status on ${res.today} (${ws.timezone()})`);
  if (!shown.length) out(res.items.length ? `Nothing due. Next: ${res.items[0].wave} ${res.items[0].checkpoint} on ${res.items[0].reviewOn}.` : 'No open checkpoints.');
  else {
    out(textTable(['status', 'wave', 'checkpoint', 'calendar', 'data final', 'post window (PT)'], shown.map((i) => [i.status.toUpperCase(), i.wave, `${i.checkpoint}${i.followUp ? ' (follow-up)' : ''}`, i.date, i.reviewOn, `${i.post.start}..${i.post.end}`])));
    out('\nRun:');
    // D+7 (and split-test checkpoints before the last one) are risk/direction checks: never suggest keep/iterate/revert there.
    const verdictHint = (i) => (!i.followUp && (i.checkpoint === 'D+7' || (i.type === 'split-test' && !i.last)) ? '--verdict inconclusive --notes "<risk and direction only>"' : '--verdict <keep|iterate|revert|inconclusive>');
    for (const i of shown.filter((x) => x.status !== 'pending')) {
      if (i.type === 'split-test') {
        out(`  ${scriptCmd('split-test.mjs')} evaluate --id ${i.wave} --checkpoint ${i.checkpoint}   (randomized control group; not gsc-compare --wave)`);
        out(`  ${scriptCmd('log-change.mjs')} checkpoint --wave ${i.wave} --checkpoint ${i.checkpoint} ${verdictHint(i)} --report <report.md>`);
        continue;
      }
      const tq = i.guardrails.length ? ` ${i.guardrails.map((g) => `--target-query "${g}"`).join(' ')}` : '';
      const extra = i.checkpoint === 'D+28' ? ' --placebo --yoy --by searchAppearance' : i.checkpoint === 'D+7' ? '' : ' --placebo';
      out(`  ${scriptCmd('gsc-compare.mjs')} --wave ${i.wave} --checkpoint ${i.checkpoint}${extra}${tq}`);
      out(`  ${scriptCmd('log-change.mjs')} checkpoint --wave ${i.wave} --checkpoint ${i.checkpoint} ${verdictHint(i)} --report <report.md>`);
    }
    if (shown.some((i) => i.checkpoint === 'D+7' && i.status !== 'pending')) out('  (D+7: check risk only - guardrails, indexing, tracking - do not conclude.)');
  }
  for (const h of evHits) {
    const where = h.items.map((x) => `${x.wave} ${x.checkpoint} (${x.between ? 'between windows' : x.windows.map((w) => `${w.name} ${w.days}d`).join(', ')})`);
    out(`\nWARNING: ${h.event.origin === 'site-log' ? 'Site event' : h.event.kind === 'gsc-anomaly' ? 'Search Console data anomaly' : 'Google'} "${h.event.title}" (${h.event.start}${h.event.end !== h.event.start ? ` -> ${h.event.ongoing ? 'ongoing' : h.event.end}` : ''} PT) overlaps: ${where.slice(0, 6).join('; ')}${where.length > 6 ? `; +${where.length - 6} more` : ''}.`);
    out(h.event.kind === 'gsc-anomaly' ? '  Impressions, CTR and position are not comparable for these checkpoints: judge on clicks.' : '  Report it as interference; rely on treatment vs control and the placebo, and check the live SERP before acting.');
    if (h.event.url) out(`  ${h.event.url}`);
  }
  if (res.freezes.length) {
    out('\nActive freezes:');
    for (const f of res.freezes) out(`  ${f.wave}: since ${f.since}${f.until ? ` until ${f.until}` : ''} - ${f.scope || f.title}`);
  }
  if (res.overlaps.length) {
    out('\nOverlapping open waves (report only an overall effect for these):');
    for (const o of res.overlaps) out(`  ${o.later} touched ${o.shared} URL(s) of ${o.earlier} during its measurement window (e.g. ${o.example})`);
  }
  return flags.failOnOverdue && res.items.some((i) => i.status === 'overdue') ? 2 : 0;
}

runMain(import.meta.url, main);
