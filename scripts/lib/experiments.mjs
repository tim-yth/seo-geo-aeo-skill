// Change waves (experiments.json) + changes.md: checkpoints, review status and overlap detection.
import fs from 'node:fs';
import { UserError, readJson, writeJson, appendText, normalizeUrl, scriptCmd } from './util.mjs';
import { addDays, deployWindows, finalDataReadyOn, isYmd, gscDaysForLocalDate } from './dates.mjs';

export const DEFAULT_CHECKPOINTS = [7, 14, 28];
export const CLOSED_STATUSES = new Set(['reviewed', 'closed', 'reverted', 'superseded', 'abandoned']);
export const VERDICTS = ['keep', 'iterate', 'revert', 'inconclusive'];

export function experimentsPath(ws) {
  return ws.path('logs', 'experiments.json');
}

export function loadWaves(ws) {
  const file = experimentsPath(ws);
  const data = readJson(file, []);
  if (!Array.isArray(data)) throw new UserError(`${file} must contain a JSON array of waves`);
  return data;
}

export function saveWaves(ws, waves) {
  writeJson(experimentsPath(ws), waves);
}

export function findWave(waves, id) {
  const wave = waves.find((w) => w.id === id);
  if (!wave) {
    throw new UserError(`Wave "${id}" not found`, { hint: `List waves with ${scriptCmd('log-change.mjs')} list` });
  }
  return wave;
}

/** Checkpoint windows for a wave deployed on `date` (site-local). */
export function buildCheckpoints(date, { siteTz, offsets = DEFAULT_CHECKPOINTS, lagDays = 3 } = {}) {
  return offsets.map((offset) => {
    const w = deployWindows(date, offset, { siteTz });
    return {
      label: `D+${offset}`,
      offset,
      date: addDays(date, offset),
      reviewOn: finalDataReadyOn(w.post.end, siteTz, lagDays),
      pre: { start: w.pre.start, end: w.pre.end },
      post: { start: w.post.start, end: w.post.end },
      excludedGscDays: w.excluded,
      review: null,
    };
  });
}

export function normalizeUrls(urls, origin) {
  const outList = [];
  for (const u of urls) {
    const abs = /^https?:\/\//i.test(u) ? u : origin ? new URL(u, origin).href : u;
    outList.push(normalizeUrl(abs, { stripTracking: true }) || abs);
  }
  return [...new Set(outList)];
}

export function isOpen(wave) {
  return !CLOSED_STATUSES.has(wave.status);
}

/** Status of each checkpoint relative to today (site-local). */
export function checkpointStatus(cp, today) {
  if (isReviewed(cp)) return 'done';
  if (cp.review && cp.review.extendTo) return today < cp.review.extendTo ? 'pending' : today <= addDays(cp.review.extendTo, 3) ? 'due' : 'overdue';
  if (today < cp.reviewOn) return 'pending';
  return today <= addDays(cp.reviewOn, 3) ? 'due' : 'overdue';
}

/** Last day of the measurement period of a wave (its longest post window). */
export function measurementEnd(wave) {
  const ends = (wave.checkpoints || []).map((c) => c.post.end).sort();
  return ends[ends.length - 1] || wave.date;
}

/** First Pacific-Time day touched by a wave's deploy date (GSC calendar). */
export function firstGscDay(wave) {
  return gscDaysForLocalDate(wave.date, wave.timezone || 'UTC')[0];
}

/**
 * Open waves that share URLs with `candidate` (site-wide waves share every URL) and are still being
 * measured when the candidate deploys, i.e. the new change would contaminate their post windows.
 * Dates are compared on the GSC (Pacific Time) calendar.
 */
/** URLs a wave measures: its changed URLs plus, for a split test, the randomized control group. */
export function measuredUrls(wave) {
  const control = wave && wave.splitTest && Array.isArray(wave.splitTest.control) ? wave.splitTest.control : [];
  return [...new Set([...(wave.urls || []), ...control])];
}

export function findOverlaps(waves, candidate) {
  const urls = new Set(candidate.urls || []);
  const start = firstGscDay(candidate);
  const result = [];
  for (const w of waves) {
    if (w.id === candidate.id || !isOpen(w) || !(w.checkpoints || []).length) continue;
    const shared = candidate.siteWide || w.siteWide ? ['(site-wide)'] : measuredUrls(w).filter((u) => urls.has(u));
    if (!shared.length) continue;
    const pending = (w.checkpoints || []).filter((c) => !isReviewed(c) && start <= c.post.end).map((c) => c.label);
    if (pending.length) result.push({ wave: w, shared, pending });
  }
  return result;
}

/** A checkpoint is reviewed once it has a final verdict (an "inconclusive" with --extend-to waits for one follow-up). */
export function isReviewed(cp) {
  if (!cp.review) return false;
  if (cp.review.verdict === 'inconclusive' && cp.review.extendTo) return Boolean(cp.followUp);
  return true;
}

export const WAVE_TYPES = ['seo-change', 'non-seo-change', 'measurement', 'external-event', 'freeze', 'rollback'];
export const CHECKPOINTS_BY_TYPE = { 'seo-change': [7, 14, 28], rollback: [10, 28], 'non-seo-change': [], measurement: [], 'external-event': [], freeze: [] };

export function changesEntry(wave) {
  const lines = [];
  lines.push(`## ${wave.id} - ${wave.title}`, '');
  const when = wave.deployedAt && wave.deployedAt.exact !== false ? `${wave.deployedAt.local} (${wave.timezone}) = ${wave.deployedAt.pt} PT` : `${wave.date} (${wave.timezone}; time not recorded)`;
  lines.push(`- D0: ${when} | Type: ${wave.type}${wave.kind ? ` / ${wave.kind}` : ''} | Status: ${wave.status}`);
  if (wave.type === 'freeze') lines.push(`- Freeze until: ${wave.until || '(open-ended)'} | Scope: ${wave.scope || '(not stated)'}`);
  lines.push(`- What changed: ${wave.what || wave.title}`);
  if (wave.hypothesis) lines.push(`- Hypothesis: ${wave.hypothesis}`);
  if (wave.primaryMetric) lines.push(`- Primary metric: ${wave.primaryMetric}${wave.guardrails && wave.guardrails.length ? ` | Guardrail queries: ${wave.guardrails.join(', ')}` : ''}`);
  if (wave.control) lines.push(`- Control group: ${wave.control}`);
  if (wave.commit) lines.push(`- Commit/deploy ref: ${wave.commit}`);
  if (wave.siteWide) lines.push('- URLs: site-wide (template/shared HTML)');
  else if (wave.urls && wave.urls.length) {
    lines.push(`- URLs (${wave.urls.length}):`);
    for (const u of wave.urls.slice(0, 50)) lines.push(`  - ${u}`);
    if (wave.urls.length > 50) lines.push(`  - ... ${wave.urls.length - 50} more in logs/experiments.json`);
  }
  if (wave.checkpoints && wave.checkpoints.length) lines.push(`- Acceptance: ${wave.checkpoints.map((c) => `${c.label} ${c.date} (final data ~${c.reviewOn})`).join(' | ')}`);
  if (wave.overlaps && wave.overlaps.length) lines.push(`- OVERLAPS (recorded with --force): ${wave.overlaps.map((o) => `${o.wave} on ${o.shared} URL(s), pending ${o.pending.join('/')}`).join('; ')}. Only an overall effect can be reported.`);
  if (wave.notes) lines.push(`- Notes: ${wave.notes}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Active freezes on `day` (site-local). */
export function activeFreezes(waves, day) {
  return waves.filter((w) => w.type === 'freeze' && isOpen(w) && w.date <= day && (!w.until || day <= w.until));
}

export function appendChangesLog(ws, text) {
  const file = ws.path('logs', 'changes.md');
  if (!fs.existsSync(file)) appendText(file, '# Change log\n\nOne entry per deployed change wave. Append-only; do not rewrite history.\n\n');
  appendText(file, text);
  return file;
}

export function validateDate(value, label) {
  if (!isYmd(value)) throw new UserError(`Invalid ${label} "${value}" (expected YYYY-MM-DD)`);
  return value;
}
