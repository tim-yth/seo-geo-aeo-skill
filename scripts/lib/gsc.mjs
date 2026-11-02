// Search Console API client + helpers for records, filters, data freshness and offline exports.
import fs from 'node:fs';
import path from 'node:path';
import { UserError, readJson, scriptCmd } from './util.mjs';
import { SCOPES, createTokenProvider, googleRequest } from './google-auth.mjs';
import { addDays, gscToday, DEFAULT_FINAL_LAG_DAYS } from './dates.mjs';
import { csvToRecords, findColumn } from './csv.mjs';

const WEBMASTERS = 'https://searchconsole.googleapis.com/webmasters/v3';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
export const GSC_DIMENSIONS = ['query', 'page', 'date', 'country', 'device', 'searchAppearance', 'hour'];
export const GSC_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];
export const MAX_ROWS_PER_REQUEST = 25000;

export function validateSiteUrl(siteUrl) {
  const s = String(siteUrl || '').trim();
  if (!s) {
    throw new UserError('gsc.siteUrl is not set', {
      hint: [`Set it with ${scriptCmd('init.mjs')} --gsc-site sc-domain:example.com (Domain property) or --gsc-site https://www.example.com/ (URL-prefix property).`],
    });
  }
  if (s.startsWith('sc-domain:')) {
    if (/[/:]/.test(s.slice('sc-domain:'.length))) throw new UserError(`"${s}" is not a valid Domain property; use sc-domain:example.com (no protocol or path)`);
    return s;
  }
  if (/^https?:\/\//.test(s)) {
    if (!s.endsWith('/')) throw new UserError(`URL-prefix property "${s}" must end with "/"`, { hint: `Use "${s}/" (or sc-domain:${s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')} for a Domain property).` });
    return s;
  }
  throw new UserError(`"${s}" is not a Search Console property`, { hint: 'Use sc-domain:example.com or https://www.example.com/' });
}

/** Alternatives to try when the configured property is not accessible. */
export function propertyCandidates(siteUrlOrHost) {
  let host = String(siteUrlOrHost || '').replace(/^sc-domain:/, '');
  try {
    if (/^https?:/.test(host)) host = new URL(host).hostname;
  } catch {
    /* keep */
  }
  const bare = host.replace(/^www\./, '');
  return [`sc-domain:${bare}`, `https://${bare}/`, `https://www.${bare}/`, `http://${bare}/`, `http://www.${bare}/`];
}

export function gscClient(ws, flags = {}, { write = false, siteUrl: siteOverride } = {}) {
  const siteUrl = validateSiteUrl(siteOverride || flags.site || ws.config.gsc.siteUrl);
  const credentialsFile = flags.credentials ? path.resolve(flags.credentials) : ws.resolveFile(ws.config.gsc.credentialsFile);
  const provider = createTokenProvider({
    scopes: [write ? SCOPES.gscWrite : SCOPES.gscRead],
    credentialsFile,
    accessToken: flags.accessToken,
    quotaProject: flags.quotaProject,
    label: 'Search Console',
  });
  const ctx = { siteUrl, write };
  const enc = encodeURIComponent(siteUrl);

  async function queryPage(body) {
    return googleRequest(provider, `${WEBMASTERS}/sites/${enc}/searchAnalytics/query`, { method: 'POST', body, api: 'gsc', ctx });
  }

  /** All rows for a request (paginates by 25k). */
  async function query(body, { maxRows = Infinity, onPage } = {}) {
    const rows = [];
    let metadata = null;
    let aggregation = '';
    const pageSize = Math.min(MAX_ROWS_PER_REQUEST, body.rowLimit || MAX_ROWS_PER_REQUEST, maxRows);
    for (let startRow = 0; rows.length < maxRows; startRow += pageSize) {
      const resp = await queryPage({ ...body, rowLimit: pageSize, startRow });
      if (!metadata && resp.metadata) metadata = resp.metadata;
      if (!aggregation) aggregation = resp.responseAggregationType || '';
      const batch = resp.rows || [];
      rows.push(...batch);
      if (onPage) onPage(rows.length);
      if (batch.length < pageSize) break;
    }
    return { rows: toRecords(rows.slice(0, maxRows), body.dimensions || []), metadata: metadata || {}, aggregation, truncated: rows.length >= maxRows && maxRows !== Infinity };
  }

  /** Newest PT day with final data (via metadata.firstIncompleteDate). */
  async function latestFinalDate() {
    const end = gscToday();
    const resp = await queryPage({ startDate: addDays(end, -10), endDate: end, dimensions: ['date'], dataState: 'all', rowLimit: 50 });
    const first = resp.metadata && resp.metadata.firstIncompleteDate;
    if (first) return addDays(first, -1);
    const dates = (resp.rows || []).map((r) => r.keys[0]).sort();
    return dates.length ? dates[dates.length - 1] : addDays(end, -DEFAULT_FINAL_LAG_DAYS);
  }

  async function listSites() {
    const resp = await googleRequest(provider, `${WEBMASTERS}/sites`, { api: 'gsc', ctx });
    return resp.siteEntry || [];
  }

  async function listSitemaps() {
    const resp = await googleRequest(provider, `${WEBMASTERS}/sites/${enc}/sitemaps`, { api: 'gsc', ctx });
    return resp.sitemap || [];
  }

  async function getSitemap(feedUrl) {
    return googleRequest(provider, `${WEBMASTERS}/sites/${enc}/sitemaps/${encodeURIComponent(feedUrl)}`, { api: 'gsc', ctx });
  }

  async function submitSitemap(feedUrl) {
    return googleRequest(provider, `${WEBMASTERS}/sites/${enc}/sitemaps/${encodeURIComponent(feedUrl)}`, { method: 'PUT', api: 'gsc', ctx: { ...ctx, write: true } });
  }

  async function inspect(url, languageCode) {
    const body = { inspectionUrl: url, siteUrl, ...(languageCode ? { languageCode } : {}) };
    return googleRequest(provider, INSPECT_URL, { method: 'POST', body, api: 'inspection', ctx, retries: 2 });
  }

  return { siteUrl, provider, query, latestFinalDate, listSites, listSitemaps, getSitemap, submitSitemap, inspect };
}

export function toRecords(rows, dimensions) {
  return rows.map((r) => {
    const rec = {};
    dimensions.forEach((d, i) => {
      rec[d] = r.keys ? r.keys[i] : '';
    });
    rec.clicks = r.clicks || 0;
    rec.impressions = r.impressions || 0;
    rec.ctr = r.ctr || (r.impressions ? (r.clicks || 0) / r.impressions : 0);
    rec.position = r.position || 0;
    return rec;
  });
}

const RE2_UNSUPPORTED = /\(\?[=!<]|\\[1-9]/;

/** Use one regex both in GSC filters (RE2) and locally: "(?i)" prefix becomes the JS "i" flag. */
export function re2ToJs(pattern) {
  let src = String(pattern || '');
  let flags = '';
  if (src.startsWith('(?i)')) {
    src = src.slice(4);
    flags = 'i';
  }
  try {
    return new RegExp(src, flags);
  } catch (e) {
    throw new UserError(`Invalid regex "${pattern}": ${e.message}`);
  }
}

/** Subtract excluded (finer-grained) rows from base rows keyed by `dims`, keeping everything else (e.g. anonymized volume). */
export function subtractRows(baseRows, excludedRows, dims) {
  const key = (r) => dims.map((d) => r[d]).join('\t');
  const ex = new Map();
  for (const r of excludedRows) {
    const k = key(r);
    const e = ex.get(k) || { clicks: 0, impressions: 0, pw: 0 };
    e.clicks += r.clicks;
    e.impressions += r.impressions;
    e.pw += (r.position || 0) * r.impressions;
    ex.set(k, e);
  }
  const outRows = [];
  for (const r of baseRows) {
    const e = ex.get(key(r));
    if (!e) {
      outRows.push(r);
      continue;
    }
    const impressions = Math.max(0, r.impressions - e.impressions);
    const clicks = Math.max(0, r.clicks - e.clicks);
    const pw = (r.position || 0) * r.impressions - e.pw;
    if (!impressions && !clicks) continue;
    outRows.push({ ...r, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions && pw > 0 ? pw / impressions : r.position });
  }
  return outRows;
}

/** Build dimensionFilterGroups from simple flags. */
export function buildFilters(f = {}) {
  const filters = [];
  const add = (dimension, operator, expression) => {
    if (expression === undefined || expression === null || expression === '') return;
    if (/Regex$/.test(operator) && RE2_UNSUPPORTED.test(expression)) {
      throw new UserError(`Regex "${expression}" uses lookarounds/backreferences, which Search Console (RE2) does not support`);
    }
    filters.push({ dimension, operator, expression: String(expression) });
  };
  add('page', 'includingRegex', f.pageRegex);
  add('page', 'excludingRegex', f.pageExclude);
  add('page', 'equals', f.page);
  add('query', 'includingRegex', f.queryRegex);
  add('query', 'excludingRegex', f.queryExclude);
  add('query', 'equals', f.query);
  if (f.country) add('country', 'equals', String(f.country).toLowerCase());
  if (f.device) add('device', 'equals', String(f.device).toUpperCase());
  add('searchAppearance', 'equals', f.searchAppearance);
  return filters.length ? [{ groupType: 'and', filters }] : [];
}

// ---------- offline exports ----------
const QUERY_COLS = ['query', 'queries', 'top queries', 'search query', '查詢', '熱門查詢', '查询', 'クエリ', '검색어', 'consulta', 'requête'];
const PAGE_COLS = ['page', 'pages', 'top pages', 'url', 'landing page', '網頁', '熱門網頁', '网页', 'ページ', '페이지', 'página'];
const DATE_COLS = ['date', '日期', '日付', '날짜', 'fecha'];
const CLICK_COLS = ['clicks', 'click', '點擊', '點擊次數', '点击次数', 'クリック数', '클릭수', 'clics'];
const IMPR_COLS = ['impressions', '曝光', '曝光次數', '展示', '展示次数', '表示回数', '노출', 'impresiones'];
const CTR_COLS = ['ctr', '點閱率', '点击率', '클릭률'];
const POS_COLS = ['position', 'average position', '平均排名', '排名', '掲載順位', '게재순위', 'posición'];

const num = (v) => {
  const s = String(v ?? '').trim().replace(/[,\s]/g, '');
  if (s.endsWith('%')) return Number(s.slice(0, -1)) / 100;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Load GSC rows from a gsc-export JSON ({meta, rows}), a raw API response ({rows:[{keys}]}) or a CSV
 * (gsc-export output or a Search Console UI export). Returns { meta, rows, dimensions }.
 */
export function loadGscFile(file) {
  if (!fs.existsSync(file)) throw new UserError(`GSC export not found: ${file}`, { hint: `Create one with ${scriptCmd('gsc-export.mjs')}` });
  if (/\.json$/i.test(file)) {
    const data = readJson(file);
    if (Array.isArray(data)) return { meta: {}, rows: data.map(normalizeRow), dimensions: inferDims(data) };
    if (data.rows && data.rows.length && data.rows[0].keys) {
      const dims = (data.meta && data.meta.dimensions) || data.dimensions || [];
      return { meta: data.meta || {}, rows: toRecords(data.rows, dims), dimensions: dims };
    }
    return { meta: data.meta || {}, rows: (data.rows || []).map(normalizeRow), dimensions: (data.meta && data.meta.dimensions) || inferDims(data.rows || []) };
  }
  const { headers, records } = csvToRecords(fs.readFileSync(file, 'utf8'));
  const cols = {
    query: findColumn(headers, QUERY_COLS),
    page: findColumn(headers, PAGE_COLS),
    date: findColumn(headers, DATE_COLS),
    country: findColumn(headers, ['country', '國家/地區', '国家/地区', '国']),
    device: findColumn(headers, ['device', '裝置', '设备', 'デバイス']),
  };
  const clicks = findColumn(headers, CLICK_COLS);
  const impressions = findColumn(headers, IMPR_COLS);
  const ctr = findColumn(headers, CTR_COLS);
  const position = findColumn(headers, POS_COLS);
  if (!impressions) throw new UserError(`${file}: no impressions column found (headers: ${headers.join(', ')})`);
  const dimensions = Object.keys(cols).filter((k) => cols[k]);
  const rows = records.map((r) => {
    const rec = {};
    for (const d of dimensions) rec[d] = r[cols[d]];
    rec.clicks = num(r[clicks]);
    rec.impressions = num(r[impressions]);
    rec.ctr = ctr ? num(r[ctr]) : rec.impressions ? rec.clicks / rec.impressions : 0;
    if (rec.ctr > 1) rec.ctr /= 100;
    rec.position = num(r[position]);
    return rec;
  });
  return { meta: { source: path.basename(file) }, rows, dimensions };
}

function normalizeRow(r) {
  return { ...r, clicks: num(r.clicks), impressions: num(r.impressions), ctr: num(r.ctr), position: num(r.position) };
}

function inferDims(rows) {
  const first = rows[0] || {};
  return GSC_DIMENSIONS.filter((d) => d in first);
}
