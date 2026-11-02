#!/usr/bin/env node
// Record deployed changes (and freezes, external events, rollbacks) as waves with D+N acceptance checkpoints.
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, UserError, collectList, slugify, scriptCmd } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { formatInTz, parseLocalDateTime, ymdInTz, GSC_TZ, isYmd, gscDaysForLocalDate, addDays } from './lib/dates.mjs';
import { loadEvents } from './lib/events.mjs';
import {
  loadWaves, saveWaves, findWave, buildCheckpoints, normalizeUrls, findOverlaps, changesEntry, appendChangesLog,
  activeFreezes, checkpointStatus, isOpen, isReviewed, WAVE_TYPES, CHECKPOINTS_BY_TYPE, VERDICTS,
} from './lib/experiments.mjs';
import { textTable } from './lib/format.mjs';

const KINDS = ['title-meta', 'content', 'internal-links', 'schema', 'technical', 'template', 'new-page', 'redirect', 'consolidation', 'navigation', 'other'];
const STATUSES = ['live', 'reviewed', 'closed', 'reverted', 'superseded', 'abandoned'];

const SPEC = {
  ...COMMON_FLAGS,
  title: { type: 'string', desc: 'add: short name of the change' },
  what: { type: 'string', desc: 'add: what changed (page group, number of pages, fields)' },
  type: { type: 'string', desc: `add: ${WAVE_TYPES.join(' | ')}`, default: 'seo-change', choices: WAVE_TYPES },
  kind: { type: 'string', desc: `add: ${KINDS.join(' | ')}`, choices: KINDS },
  at: { type: 'string', placeholder: 'time', desc: 'add: deploy-complete time, "YYYY-MM-DD HH:MM" in site time zone or ISO with offset (default: now)' },
  date: { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'add: D0 date (site time zone) when the exact time is unknown' },
  urls: { type: 'csv', placeholder: 'url,...', desc: 'add: changed URLs (absolute or paths)' },
  'urls-file': { type: 'string', placeholder: 'file', desc: 'add: changed URLs, one per line' },
  'site-wide': { type: 'boolean', desc: 'add: the change touches every page (template, shared HTML, navigation)' },
  hypothesis: { type: 'string', desc: 'add: expected effect and why' },
  metric: { type: 'string', desc: 'add: primary metric (e.g. "clicks on treated URLs", "same-query CTR")' },
  guardrail: { type: 'list', placeholder: 'query', desc: 'add: guardrail query (default: config guardrails)' },
  control: { type: 'string', desc: 'add: pre-registered control group (regex or description)' },
  commit: { type: 'string', desc: 'add: commit hash or deploy id' },
  notes: { type: 'string', desc: 'Notes (add/checkpoint/status)' },
  until: { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'add --type freeze|external-event: last day of the freeze or event (site time zone)' },
  scope: { type: 'string', desc: 'add --type freeze: what is frozen (page groups, home, templates, sitemap lastmod)' },
  checkpoints: { type: 'csv', placeholder: 'days', desc: 'add: acceptance offsets (default 7,14,28 for seo-change; 10,28 for rollback)' },
  id: { type: 'string', desc: 'add: custom wave id' },
  force: { type: 'boolean', desc: 'add: record even if it overlaps an unreviewed wave on the same URLs' },
  'dry-run': { type: 'boolean', desc: 'add: only check overlaps/freezes and print the entry' },
  wave: { type: 'string', placeholder: 'id', desc: 'checkpoint/status: wave id' },
  checkpoint: { type: 'string', placeholder: 'D+N', desc: 'checkpoint: which checkpoint (D+7, D+14, D+28)' },
  verdict: { type: 'string', desc: `checkpoint: ${VERDICTS.join(' | ')}`, choices: VERDICTS },
  report: { type: 'string', placeholder: 'path', desc: 'checkpoint: path of the review report' },
  'extend-to': { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'checkpoint with inconclusive: date of the next look' },
  status: { type: 'string', desc: `status: ${STATUSES.join(' | ')}`, choices: STATUSES },
  open: { type: 'boolean', desc: 'list: only open waves' },
  json: { type: 'boolean', desc: 'list: print JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/log-change.mjs add --title "..." --urls u1,u2 [--at "YYYY-MM-DD HH:MM"] [--hypothesis ...] [--metric ...]',
    'node scripts/log-change.mjs add --type freeze --title "Freeze before D+28" --until YYYY-MM-DD --scope "home, templates"',
    'node scripts/log-change.mjs add --type external-event --title "Google core update starts" --at "2026-11-11 09:00"',
    'node scripts/log-change.mjs checkpoint --wave <id> --checkpoint D+14 --verdict keep|iterate|revert|inconclusive [--report file]',
    'node scripts/log-change.mjs status --wave <id> --status reviewed|closed|reverted|superseded',
    'node scripts/log-change.mjs list [--open] [--json]',
  ],
  summary:
    'Appends one entry per deployed change to logs/changes.md (append-only) and logs/experiments.json. D0 = deploy-complete time, stored in ' +
    'the site time zone AND Pacific Time. SEO changes get D+7/D+14/D+28 checkpoints (pre/post windows, excluded PT deploy days and the date ' +
    'the data becomes final); rollbacks get D+10/D+28. Non-SEO changes, measurement changes, external events and freezes are logged too ' +
    '(URLs optional) because they interfere with other waves. "add" refuses to record a change that overlaps an unreviewed wave on the same ' +
    'URLs unless --force.',
  spec: SPEC,
  examples: [
    'node scripts/log-change.mjs add --title "Model+price in review titles" --kind title-meta --urls-file treated.txt --hypothesis "CTR up on review pages" --metric "same-query CTR" --control "^/guides/" --commit abc123',
    'node scripts/log-change.mjs add --type non-seo-change --title "New login button on home" --urls / --at "2026-10-12 21:40"',
    'node scripts/log-change.mjs checkpoint --wave W-2026-10-07-model-price-in-review-titles --checkpoint D+28 --verdict keep --report .seo-agent/logs/reviews/2026-11-08-compare-x.md',
  ],
  notes: ['Never rewrite past entries; corrections are new entries. A verdict of revert means: log the rollback itself with add --type rollback.'],
});

function uniqueId(waves, base) {
  let id = base;
  for (let i = 2; waves.some((w) => w.id === id); i++) id = `${base}-${i}`;
  return id;
}

export function buildWave(ws, flags, waves) {
  if (!flags.title) throw new UserError('add needs --title');
  const tz = ws.timezone();
  let instant;
  if (flags.at) instant = parseLocalDateTime(flags.at, tz);
  else if (flags.date) instant = parseLocalDateTime(flags.date, tz) + 12 * 3600000;
  else instant = Date.now();
  const date = flags.date && !flags.at ? flags.date : ymdInTz(new Date(instant), tz);
  if (!isYmd(date)) throw new UserError(`Invalid date "${date}"`);
  const origin = ws.siteUrl({ required: false }) ? ws.origin() : '';
  const urls = normalizeUrls(collectList(flags.urls, flags.urlsFile), origin);
  const needsUrls = ['seo-change', 'rollback'].includes(flags.type);
  if (needsUrls && !urls.length && !flags.siteWide) throw new UserError(`--type ${flags.type} needs --urls/--urls-file or --site-wide`, { hint: 'Treated URLs are what the checkpoints compare against their control group.' });
  if (flags.type === 'freeze' && flags.until && !isYmd(flags.until)) throw new UserError(`Invalid --until "${flags.until}"`);
  const offsets = flags.checkpoints.length ? flags.checkpoints.map(Number) : CHECKPOINTS_BY_TYPE[flags.type];
  if (offsets.some((n) => !Number.isInteger(n) || n < 1)) throw new UserError('--checkpoints must be positive whole days, e.g. 7,14,28');
  const slug = slugify(flags.title, 40);
  const id = flags.id || uniqueId(waves, `W-${date}-${slug || flags.type}`);
  if (flags.id && waves.some((w) => w.id === flags.id)) throw new UserError(`Wave id "${flags.id}" already exists`);
  return {
    id,
    date,
    timezone: tz,
    deployedAt: { utc: new Date(instant).toISOString(), local: formatInTz(instant, tz), pt: formatInTz(instant, GSC_TZ), exact: Boolean(flags.at) || !flags.date },
    title: flags.title,
    what: flags.what || '',
    type: flags.type,
    kind: flags.kind || '',
    urls,
    siteWide: Boolean(flags.siteWide),
    hypothesis: flags.hypothesis || '',
    primaryMetric: flags.metric || (flags.type === 'seo-change' ? 'clicks' : ''),
    guardrails: flags.guardrail.length ? flags.guardrail : flags.type === 'seo-change' ? ws.guardrails().map((g) => g.query) : [],
    control: flags.control || '',
    commit: flags.commit || '',
    notes: flags.notes || '',
    until: flags.until || '',
    scope: flags.scope || '',
    status: 'live',
    createdAt: new Date().toISOString(),
    checkpoints: offsets.length ? buildCheckpoints(date, { siteTz: tz, offsets }) : [],
    overlaps: [],
  };
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const cmd = positionals[0] || 'add';
  const ws = loadWorkspace(flags);
  const waves = loadWaves(ws);

  if (cmd === 'list') {
    const today = ws.today();
    const rows = waves.filter((w) => !flags.open || isOpen(w));
    if (flags.json) return void process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    if (!rows.length) return void out('No waves logged yet.');
    out(textTable(['id', 'D0', 'type', 'status', 'urls', 'checkpoints'], rows.map((w) => [
      w.id, w.deployedAt ? w.deployedAt.local : w.date, w.type, w.status, w.siteWide ? 'site-wide' : (w.urls || []).length,
      (w.checkpoints || []).map((c) => `${c.label}:${c.review ? c.review.verdict : checkpointStatus(c, today)}`).join(' ') || (w.type === 'freeze' ? `until ${w.until || '?'}` : '-'),
    ])));
    return 0;
  }

  if (cmd === 'checkpoint' || cmd === 'review') {
    if (!flags.wave || !flags.checkpoint || !flags.verdict) throw new UserError('checkpoint needs --wave, --checkpoint and --verdict');
    const wave = findWave(waves, flags.wave);
    const label = `D+${String(flags.checkpoint).replace(/^D\+/i, '')}`;
    const cp = (wave.checkpoints || []).find((c) => c.label === label);
    if (!cp) throw new UserError(`Wave ${wave.id} has no checkpoint ${label}`, { hint: `Available: ${(wave.checkpoints || []).map((c) => c.label).join(', ') || 'none'}` });
    if (isReviewed(cp)) {
      const v = cp.followUp || cp.review;
      throw new UserError(`${label} of ${wave.id} was already recorded (${v.verdict} on ${v.date})`, { hint: 'Corrections are new notes: use status --notes, never overwrite a verdict.' });
    }
    if (flags.verdict === 'inconclusive' && flags.extendTo && !isYmd(flags.extendTo)) throw new UserError(`Invalid --extend-to "${flags.extendTo}"`);
    const entry = { date: ws.today(), verdict: flags.verdict, report: flags.report || '', notes: flags.notes || '', extendTo: flags.extendTo || '' };
    const followUp = Boolean(cp.review);
    if (followUp) {
      if (flags.verdict === 'inconclusive') throw new UserError('The follow-up after an extended "inconclusive" must be keep, iterate or revert', { hint: 'If there is still no signal, record iterate (no effect) and note why.' });
      cp.followUp = entry;
    } else cp.review = entry;
    const last = wave.checkpoints[wave.checkpoints.length - 1];
    if (cp === last && isReviewed(cp)) wave.status = flags.verdict === 'revert' ? 'live' : 'reviewed';
    saveWaves(ws, waves);
    appendChangesLog(ws, `### ${wave.id} ${label}${followUp ? ' (follow-up)' : ''}: ${flags.verdict} (${ws.today()})\n\n${flags.notes ? `- ${flags.notes}\n` : ''}${flags.report ? `- Report: ${flags.report}\n` : ''}${flags.extendTo ? `- Next look: ${flags.extendTo}\n` : ''}\n`);
    out(`Recorded ${label} = ${flags.verdict} for ${wave.id}${wave.status === 'reviewed' ? ' (wave closed as reviewed)' : ''}.`);
    if (flags.verdict === 'revert') out(`Next: roll back ONE variable via a normal deploy, then log it: ${scriptCmd('log-change.mjs')} add --type rollback --title "Revert ..." --urls ...`);
    if (flags.verdict === 'keep' && cp === last) out('Next: expand to 10-20 similar pages only if at least two pages clearly improved.');
    return 0;
  }

  if (cmd === 'status') {
    if (!flags.wave || !flags.status) throw new UserError('status needs --wave and --status');
    const wave = findWave(waves, flags.wave);
    const before = wave.status;
    wave.status = flags.status;
    (wave.statusHistory = wave.statusHistory || []).push({ date: ws.today(), from: before, to: flags.status, notes: flags.notes || '' });
    saveWaves(ws, waves);
    appendChangesLog(ws, `### ${wave.id}: status ${before} -> ${flags.status} (${ws.today()})\n\n${flags.notes ? `- ${flags.notes}\n` : ''}\n`);
    out(`${wave.id}: ${before} -> ${flags.status}`);
    return 0;
  }

  if (cmd !== 'add') throw new UserError(`Unknown subcommand "${cmd}"`, { hint: 'Use add, list, checkpoint or status.' });
  const wave = buildWave(ws, flags, waves);
  const blocking = ['seo-change', 'rollback'].includes(wave.type);
  const overlaps = wave.urls.length || wave.siteWide ? findOverlaps(waves, wave) : [];
  const freezes = activeFreezes(waves, wave.date).filter((f) => f.id !== wave.id);
  const warnings = [];
  for (const o of overlaps) warnings.push(`Overlaps ${o.wave.id} (${o.wave.date}) on ${o.shared[0] === '(site-wide)' ? 'every URL (site-wide change)' : `${o.shared.length} URL(s)`}; its pending checkpoints ${o.pending.join(', ')} ${blocking ? 'would be contaminated' : 'will count this as interference'}.`);
  for (const f of freezes) if (wave.type !== 'external-event' && wave.type !== 'freeze') warnings.push(`A freeze is active (${f.id}: ${f.scope || 'scope not stated'}, until ${f.until || 'open'}). If this change touches it, it counts as interference.`);
  if (['seo-change', 'rollback'].includes(wave.type)) {
    const d0 = gscDaysForLocalDate(wave.date, wave.timezone)[0];
    for (const e of loadEvents(ws, { includeSite: false })) {
      if (!['core', 'spam', 'ranking-other'].includes(e.kind)) continue;
      if (e.start <= d0 && d0 <= addDays(e.end, e.bufferDays)) warnings.push(`Google ${e.title} is ${e.ongoing ? 'rolling out' : 'settling'} (${e.start} -> ${e.ongoing ? 'ongoing' : e.end} PT): this wave's windows will overlap it; deploy after it settles if you can, otherwise only treatment vs control can read the result. ${e.url}`);
    }
  }
  if (wave.type === 'seo-change') {
    const recent = waves.filter((w) => w.type === 'seo-change' && isOpen(w) && w.id !== wave.id && w.date <= wave.date && w.date > ymdInTz(new Date(parseLocalDateTime(wave.date, wave.timezone) - 14 * 86400000), wave.timezone));
    if (recent.length) warnings.push(`Another SEO wave went live less than 14 days ago (${recent.map((w) => w.id).join(', ')}); keep batches at least 14 days apart.`);
  }
  for (const w of warnings) out(`WARNING: ${w}`);
  if (flags.dryRun) {
    out('\n(dry run, nothing written)\n');
    out(changesEntry(wave));
    return overlaps.length && blocking ? 2 : 0;
  }
  if (overlaps.length && blocking && !flags.force) {
    throw new UserError('Not recorded: this change overlaps an unreviewed wave on the same URLs', {
      exitCode: 2,
      hint: ['Postpone the change or shrink its URL list until the earlier wave is reviewed.', 'If it is already live, re-run with --force: it will be recorded as overlapping and both waves can only report an overall effect.'],
    });
  }
  wave.overlaps = overlaps.map((o) => ({ wave: o.wave.id, shared: o.shared.length, pending: o.pending }));
  waves.push(wave);
  saveWaves(ws, waves);
  const file = appendChangesLog(ws, changesEntry(wave));
  out(`Logged ${wave.id} (${wave.type}) D0 ${wave.deployedAt.exact ? `${wave.deployedAt.local} ${wave.timezone} = ${wave.deployedAt.pt} PT` : `${wave.date} ${wave.timezone} (time not recorded; pass --at "YYYY-MM-DD HH:MM" next time)`}`);
  for (const c of wave.checkpoints) out(`  ${c.label}: ${c.date}; windows pre ${c.pre.start}..${c.pre.end} / post ${c.post.start}..${c.post.end}; review on or after ${c.reviewOn}`);
  out(`wrote ${file}\nwrote ${ws.path('logs', 'experiments.json')}`);
  if (wave.type === 'seo-change' && wave.urls.length) out(`Next: submit changed URLs (${scriptCmd('indexing.mjs')} indexnow --from-file <urls>) and check reviews with ${scriptCmd('review-due.mjs')}`);
  return 0;
}

runMain(import.meta.url, main);
