// GA4 Data API runReport client, simple filter syntax and presets.
import path from 'node:path';
import { UserError, scriptCmd } from './util.mjs';
import { SCOPES, createTokenProvider, googleRequest } from './google-auth.mjs';

const GA4_API = 'https://analyticsdata.googleapis.com/v1beta';
const PAGE_SIZE = 100000;

export const AI_SOURCE_REGEX =
  '(chatgpt|openai|perplexity|gemini\\.google|bard\\.google|copilot|edgeservices|claude\\.ai|anthropic|you\\.com|phind|poe\\.com|deepseek|meta\\.ai|grok|x\\.ai|mistral|kagi|duckassist|chat\\.qwen|doubao|kimi|moonshot)';

export const PRESETS = {
  'organic-landing': {
    desc: 'Organic Search sessions by landing page',
    dimensions: ['landingPagePlusQueryString'],
    metrics: ['sessions', 'engagedSessions', 'engagementRate', 'averageSessionDuration', 'keyEvents', 'totalUsers'],
    filter: 'sessionDefaultChannelGroup==Organic Search',
    orderBy: 'sessions',
  },
  'ai-referrals': {
    desc: 'Sessions referred by AI assistants (ChatGPT, Perplexity, Gemini, Copilot, Claude, ...)',
    dimensions: ['sessionSource', 'sessionDefaultChannelGroup', 'landingPagePlusQueryString'],
    metrics: ['sessions', 'engagedSessions', 'keyEvents', 'totalUsers'],
    filter: `sessionSource=~${AI_SOURCE_REGEX}`,
    orderBy: 'sessions',
  },
  'events-by-landing': {
    desc: 'Event counts by landing page (add --filter "sessionDefaultChannelGroup==Organic Search" to focus on SEO)',
    dimensions: ['landingPagePlusQueryString', 'eventName'],
    metrics: ['eventCount', 'totalUsers'],
    orderBy: 'eventCount',
  },
  channels: {
    desc: 'Sessions by default channel group and date',
    dimensions: ['date', 'sessionDefaultChannelGroup'],
    metrics: ['sessions', 'engagedSessions', 'keyEvents', 'totalUsers'],
  },
};

export function normalizePropertyId(value) {
  const s = String(value || '').trim().replace(/^properties\//, '');
  if (!s) {
    throw new UserError('ga4.propertyId is not set', { hint: `Find it in GA4 -> Admin -> Property details (a number like 123456789), then run ${scriptCmd('init.mjs')} --ga4-property <id>` });
  }
  if (/^G-/i.test(s)) {
    throw new UserError(`"${s}" is a Measurement ID, not a Property ID`, { hint: 'Use the numeric Property ID from GA4 -> Admin -> Property details.' });
  }
  if (!/^\d+$/.test(s)) throw new UserError(`ga4.propertyId must be numeric (got "${s}")`);
  return s;
}

const OPS = [
  ['!~', 'PARTIAL_REGEXP', true],
  ['=~', 'PARTIAL_REGEXP', false],
  ['==', 'EXACT', false],
  ['!=', 'EXACT', true],
  ['^=', 'BEGINS_WITH', false],
  ['$=', 'ENDS_WITH', false],
  ['*=', 'CONTAINS', false],
  ['>=', 'GREATER_THAN_OR_EQUAL', false],
  ['<=', 'LESS_THAN_OR_EQUAL', false],
  ['>', 'GREATER_THAN', false],
  ['<', 'LESS_THAN', false],
];

/**
 * Parse "field==value;field=~regex;metric>10" (AND-ed). Operators: == != =~ !~ ^= $= *= > >= < <=.
 * Fields listed in `metricNames` become metric filters.
 */
export function parseFilter(expr, metricNames = []) {
  if (!expr) return {};
  const dims = [];
  const mets = [];
  for (const part of String(expr).split(';').map((s) => s.trim()).filter(Boolean)) {
    let hit = null;
    for (const [op, kind, negate] of OPS) {
      const idx = part.indexOf(op);
      if (idx > 0 && (!hit || idx < hit.idx || (idx === hit.idx && op.length > hit.op.length))) hit = { idx, op, kind, negate };
    }
    if (!hit) throw new UserError(`Cannot parse filter "${part}"`, { hint: 'Use field==value, field=~regex, field!=value, field^=prefix, field*=text, metric>number; join with ";"' });
    const field = part.slice(0, hit.idx).trim();
    const value = part.slice(hit.idx + hit.op.length).trim();
    let filter;
    if (['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL'].includes(hit.kind)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new UserError(`Filter "${part}" needs a number`);
      filter = { filter: { fieldName: field, numericFilter: { operation: hit.kind, value: Number.isInteger(n) ? { int64Value: String(n) } : { doubleValue: n } } } };
    } else {
      filter = { filter: { fieldName: field, stringFilter: { matchType: hit.kind, value, caseSensitive: false } } };
    }
    if (hit.negate) filter = { notExpression: filter };
    (metricNames.includes(field) ? mets : dims).push(filter);
  }
  const group = (list) => (list.length === 1 ? list[0] : { andGroup: { expressions: list } });
  return { ...(dims.length ? { dimensionFilter: group(dims) } : {}), ...(mets.length ? { metricFilter: group(mets) } : {}) };
}

export function ga4Client(ws, flags = {}) {
  const propertyId = normalizePropertyId(flags.property || ws.config.ga4.propertyId);
  const credentialsFile = flags.credentials ? path.resolve(flags.credentials) : ws.resolveFile(ws.config.ga4.credentialsFile || ws.config.gsc.credentialsFile);
  const provider = createTokenProvider({ scopes: [SCOPES.ga4Read], credentialsFile, accessToken: flags.accessToken, quotaProject: flags.quotaProject, label: 'GA4' });

  async function runReport(body, { maxRows = Infinity } = {}) {
    const rows = [];
    let first = null;
    for (let offset = 0; rows.length < maxRows; offset += PAGE_SIZE) {
      const limit = Math.min(PAGE_SIZE, maxRows - rows.length);
      const resp = await googleRequest(provider, `${GA4_API}/properties/${propertyId}:runReport`, { method: 'POST', body: { ...body, offset, limit }, api: 'ga4', ctx: { propertyId } });
      if (!first) first = resp;
      const batch = resp.rows || [];
      rows.push(...batch);
      if (batch.length < limit || rows.length >= (resp.rowCount || 0)) break;
    }
    const dims = (first && first.dimensionHeaders ? first.dimensionHeaders : []).map((h) => h.name);
    const mets = (first && first.metricHeaders ? first.metricHeaders : []).map((h) => ({ name: h.name, type: h.type }));
    const records = rows.map((r) => {
      const rec = {};
      dims.forEach((d, i) => {
        rec[d] = r.dimensionValues[i].value;
      });
      mets.forEach((m, i) => {
        const v = r.metricValues[i].value;
        rec[m.name] = m.type === 'TYPE_INTEGER' ? Number(v) : Number.isFinite(Number(v)) ? Number(v) : v;
      });
      return rec;
    });
    return { records, metadata: (first && first.metadata) || {}, rowCount: (first && first.rowCount) || records.length, dimensions: dims, metrics: mets.map((m) => m.name) };
  }

  return { propertyId, provider, runReport };
}
