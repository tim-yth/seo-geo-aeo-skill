// GEO prompt tracking helpers: the geo-prompts.csv log (29 columns, older 14-column files), prompt definitions,
// brand/competitor matching in AI answers, the retrieved -> cited -> mentioned -> recommended funnel, and
// aggregation with Wilson intervals. AI answers are data: nothing here follows instructions found in them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { UserError, bareHost, escapeRe } from './util.mjs';
import { parseCsv } from './csv.mjs';
import { isYmd } from './dates.mjs';
import { CJK_RE, splitSentences } from './text.mjs';
import { wilsonInterval, mulberry32 } from './stats.mjs';
import { PROVIDERS, providerSettings } from './providers.mjs';

export const GEO_COLUMNS = [
  'run_date', 'engine', 'locale', 'intent', 'prompt', 'mentioned', 'rank', 'cited_url', 'reason', 'accuracy', 'pricing_claim', 'competitors', 'action_needed', 'notes',
  'prompt_id', 'portfolio_version', 'cohort', 'arm', 'variant_group', 'branded', 'topic', 'country', 'method', 'k', 'searched', 'retrieved', 'cited', 'recommended', 'cited_domains',
];
export const LEGACY_COLUMNS = GEO_COLUMNS.slice(0, 14);
const DEFINITION_FIELDS = ['locale', 'intent', 'portfolio_version', 'cohort', 'arm', 'variant_group', 'branded', 'topic', 'country'];
export const SMALL_SAMPLE = 20;

// ---------- text hygiene ----------
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Strip control and bidi-override characters (answers and titles are printed and stored). */
export function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
}

/** One-line excerpt safe to print. */
export function excerpt(value, max = 160) {
  const s = cleanText(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// ---------- prompts ----------
export const isYes = (v) => /^(y|yes|true|1|是)$/i.test(String(v ?? '').trim());

/** Stable id for a prompt without prompt_id: hash of the normalized prompt + locale. */
export function promptKey(prompt, locale = '') {
  const norm = `${String(prompt || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()}|${String(locale || '').trim().toLowerCase()}`;
  return `h${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8)}`;
}

/** Template placeholders such as {category} or {品類} that must be replaced before a prompt is sent. */
export function hasPlaceholder(text) {
  return /\{[^{}\n]{1,40}\}/.test(String(text || ''));
}

/**
 * Unique prompt definitions from geo-prompts.csv records: keyed by prompt_id (else promptKey(prompt, locale)); the
 * latest row (run_date, then file order) supplies the text and metadata. Returns {prompts, placeholders} (placeholders =
 * definitions skipped because they still contain {template} words).
 */
export function collectPrompts(records) {
  const defs = new Map();
  records.forEach((r, i) => {
    const prompt = cleanText(r.prompt).trim();
    if (!prompt) return;
    const id = String(r.prompt_id || '').trim() || promptKey(prompt, r.locale);
    const date = isYmd(String(r.run_date || '').trim()) ? String(r.run_date).trim() : '';
    const prev = defs.get(id);
    if (prev && date < prev.lastDate) return;
    const def = { id, prompt, lastDate: date, row: i };
    for (const f of DEFINITION_FIELDS) def[f] = String(r[f] ?? '').trim();
    def.arm = def.arm.toLowerCase();
    def.cohort = def.cohort.toLowerCase();
    defs.set(id, def);
  });
  const prompts = [];
  let placeholders = 0;
  for (const def of defs.values()) {
    if (hasPlaceholder(def.prompt)) placeholders++;
    else prompts.push(def);
  }
  return { prompts, placeholders };
}

/** Negative-control prompts from config.geo.controlPrompts (strings or {prompt, locale, country}). */
export function controlPromptDefs(list, { locale = '', country = '' } = {}) {
  const defs = [];
  for (const item of list || []) {
    const prompt = cleanText(typeof item === 'string' ? item : item && item.prompt).trim();
    if (!prompt || hasPlaceholder(prompt)) continue;
    const loc = (item && item.locale) || locale;
    defs.push({ id: `ctl-${promptKey(prompt, loc).slice(1, 7)}`, prompt, lastDate: '', row: -1, locale: loc, intent: 'negative-control', portfolio_version: '', cohort: 'diagnostic', arm: 'negative', variant_group: '', branded: 'n', topic: 'negative-control', country: (item && item.country) || country, control: true });
  }
  return defs;
}

/** Apply --prompt-id/--cohort/--arm/--locale/--topic/--limit filters (case-insensitive). */
export function filterPrompts(prompts, { ids = [], cohort = [], arm = [], locale = [], topic = [], limit = 0 } = {}) {
  const set = (xs) => new Set(xs.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  const fIds = set(ids);
  const fCohort = set(cohort);
  const fArm = set(arm);
  const fLocale = set(locale);
  const fTopic = set(topic);
  const has = (s, v) => !s.size || s.has(String(v || '').toLowerCase()) || (s.has('none') && !v);
  let list = prompts.filter((p) => (!fIds.size || fIds.has(p.id.toLowerCase())) && has(fCohort, p.cohort) && has(fArm, p.arm) && has(fLocale, p.locale) && has(fTopic, p.topic));
  if (limit > 0) list = list.slice(0, limit);
  return list;
}

const ALPHA3 = {
  USA: 'US', TWN: 'TW', JPN: 'JP', KOR: 'KR', CHN: 'CN', HKG: 'HK', MAC: 'MO', SGP: 'SG', MYS: 'MY', THA: 'TH', VNM: 'VN', IDN: 'ID', PHL: 'PH', IND: 'IN',
  AUS: 'AU', NZL: 'NZ', CAN: 'CA', MEX: 'MX', BRA: 'BR', ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE', GBR: 'GB', IRL: 'IE', DEU: 'DE', AUT: 'AT', CHE: 'CH',
  FRA: 'FR', BEL: 'BE', NLD: 'NL', LUX: 'LU', ESP: 'ES', PRT: 'PT', ITA: 'IT', DNK: 'DK', SWE: 'SE', NOR: 'NO', FIN: 'FI', POL: 'PL', CZE: 'CZ', HUN: 'HU',
  ROU: 'RO', GRC: 'GR', TUR: 'TR', ISR: 'IL', ARE: 'AE', SAU: 'SA', ZAF: 'ZA', EGY: 'EG', NGA: 'NG', KEN: 'KE', UKR: 'UA',
};

/** ISO 3166-1 alpha-2 code for user_location (accepts alpha-2 or common alpha-3 such as twn/usa). '' when unknown. */
export function countryCode(value) {
  const v = String(value || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(v)) return v === 'UK' ? 'GB' : v;
  if (/^[A-Z]{3}$/.test(v)) return ALPHA3[v] || '';
  return '';
}

// ---------- geo-prompts.csv ----------
/** Strict UTF-8 decode (Excel's plain "CSV" in Big5/Shift-JIS locales would otherwise be read as garbage). */
export function decodeUtf8(buf, file) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); // ignoreBOM keeps the BOM so a rewrite preserves it
  } catch {
    throw new UserError(`${file} is not UTF-8 text`, { hint: ['Re-save it as "CSV UTF-8 (comma delimited)" in Excel, or UTF-8 in Numbers / Google Sheets / your editor; nothing was sent or changed.'] });
  }
}

/**
 * Read geo-prompts.csv: raw header cells and rows are kept for a lossless rewrite; records map each column name to its
 * first occurrence. Refuses non-UTF-8 files and rows with extra non-empty cells before any API call.
 */
export function readGeoLog(file) {
  if (!fs.existsSync(file)) return { exists: false, headers: [], rawHeaders: [], rows: [], records: [], bom: false, crlf: false };
  const raw = decodeUtf8(fs.readFileSync(file), file);
  const bom = raw.startsWith('\uFEFF');
  const crlf = /\r\n/.test(raw);
  const rows = parseCsv(raw);
  if (!rows.length) return { exists: true, headers: [], rawHeaders: [], rows: [], records: [], bom, crlf };
  const rawHeaders = rows[0];
  const headers = rawHeaders.map((h) => h.trim());
  const bad = rows.findIndex((r, i) => i > 0 && r.length > headers.length && r.slice(headers.length).some((c) => c.trim() !== ''));
  if (bad > 0) throw new UserError(`${file}: row ${bad + 1} has more cells than the header (${rows[bad].length} > ${headers.length})`, { hint: 'Fix the row (quote cells that contain commas) before appending new results; nothing was sent.' });
  const first = new Map();
  headers.forEach((h, i) => {
    if (h && !first.has(h)) first.set(h, i);
  });
  const records = rows.slice(1).map((r) => Object.fromEntries([...first].map(([h, i]) => [h, r[i] === undefined ? '' : r[i]])));
  return { exists: true, headers, rawHeaders, rows, records, bom, crlf };
}

/** Union header: existing columns in their order, then missing GEO_COLUMNS (never drops, renames or reorders). */
export function unionHeader(existing, wanted = GEO_COLUMNS) {
  const out = [...existing];
  for (const c of wanted) if (!out.includes(c)) out.push(c);
  return out;
}

// Same quoting rule as lib/csv.mjs; the line ending is chosen by the caller so quoted newlines stay untouched.
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells) => cells.map(csvCell).join(',');

/**
 * Append rows (objects keyed by column name) to geo-prompts.csv. In place when the header already has every column;
 * otherwise rewritten once (temp file + rename, previous version kept as .bak) with the missing columns added at the
 * end: existing header cells, rows, BOM and line endings are preserved. Returns {file, added, rewritten, header}.
 */
export function appendGeoRows(file, newRecords) {
  const log = readGeoLog(file);
  const eol = log.crlf ? '\r\n' : '\n';
  const header = log.headers.length ? unionHeader(log.headers) : [...GEO_COLUMNS];
  const index = new Map();
  header.forEach((h, i) => {
    if (h && !index.has(h)) index.set(h, i);
  });
  const toCells = (rec) => {
    const cells = new Array(header.length).fill('');
    for (const [k, v] of Object.entries(rec)) if (index.has(k)) cells[index.get(k)] = v ?? '';
    return cells;
  };
  const lines = newRecords.map((r) => csvLine(toCells(r)));
  if (log.headers.length && header.length === log.headers.length) {
    const text = fs.readFileSync(file, 'utf8');
    const prefix = text.length && !/\n$/.test(text) ? eol : '';
    fs.appendFileSync(file, `${prefix}${lines.join(eol)}${lines.length ? eol : ''}`, 'utf8');
    return { file, added: newRecords.length, rewritten: false, header };
  }
  const added = header.slice(log.headers.length);
  const width = log.rawHeaders.length;
  const body = log.headers.length
    ? [csvLine([...log.rawHeaders, ...added]), ...log.rows.slice(1).map((r) => csvLine([...r.slice(0, width), ...new Array(Math.max(0, width - r.length)).fill(''), ...added.map(() => '')])), ...lines]
    : [csvLine(header), ...lines];
  if (log.exists) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${log.bom ? '\uFEFF' : ''}${body.join(eol)}${eol}`, 'utf8');
  fs.renameSync(tmp, file);
  return { file, added: newRecords.length, rewritten: true, header, previousHeader: log.headers, backup: log.exists ? `${file}.bak` : '' };
}

// ---------- brand and competitor matching ----------
/**
 * Matcher for brand terms in answer text (NFKC): Latin terms match whole words case-insensitively (spaces in a term
 * also match "-", "_" or nothing, e.g. "example coffee" ~ "examplecoffee"); terms with CJK characters match as
 * substrings; Latin terms shorter than 3 letters/digits are skipped with a warning. first(text) -> {index, term} | null.
 */
export function makeTermMatcher(terms, { label = 'brand' } = {}) {
  const warnings = [];
  const pats = [];
  for (const raw of terms || []) {
    const t = String(raw ?? '').normalize('NFKC').trim();
    if (!t) continue;
    if (CJK_RE.test(t)) {
      pats.push({ term: t, re: new RegExp(t.toLowerCase().split(/\s+/).map(escapeRe).join('\\s*'), 'gu'), lower: true });
      continue;
    }
    if (t.replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
      warnings.push(`${label} term "${t}" is shorter than 3 characters and was skipped (too many false matches); add a longer spelling.`);
      continue;
    }
    const body = t.split(/[\s_-]+/).filter(Boolean).map(escapeRe).join('[\\s_-]*');
    pats.push({ term: t, re: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu'), lower: false });
  }
  const first = (text) => {
    const norm = String(text ?? '').normalize('NFKC');
    const lowered = norm.toLowerCase();
    let best = null;
    for (const p of pats) {
      p.re.lastIndex = 0;
      const m = p.re.exec(p.lower ? lowered : norm);
      if (m && (!best || m.index < best.index)) best = { index: m.index, term: p.term };
    }
    return best;
  };
  return { first, terms: pats.map((p) => p.term), warnings, empty: !pats.length };
}

const DOMAIN_OR_URL_RE = /^\s*(?:https?:\/\/)?(?:www\.)?(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:[/?#]\S*)?\s*(?:\+\d+)?\s*$/u;

/**
 * Remove citation chips and URLs so being cited alone never counts as a brand mention: markdown links whose visible
 * text is a domain or URL (e.g. OpenAI's "([example.com](https://...))") are dropped, other links keep their text,
 * bare URLs are removed.
 */
export function stripLinkTargets(text) {
  return String(text || '')
    .replace(/\(\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))+\)\)|\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, (m, chip, plain) => {
      const label = chip !== undefined ? chip : plain;
      if (DOMAIN_OR_URL_RE.test(label)) return ' ';
      return chip !== undefined ? `([${label}])` : `[${label}]`;
    })
    .replace(/https?:\/\/[^\s)\]>"']+/g, ' ');
}

const LIST_ITEM_RE = /^\s*(?:\*\*|__)?\s*(?:[-*+•‣▪◦●]|\d{1,2}[.)、．]|[（(]\d{1,2}[)）]|#{1,4}\s*\d{1,2}[.)、．]?)\s+/;

export function listItems(text) {
  return String(text || '').split('\n').filter((l) => LIST_ITEM_RE.test(l)).map((l) => l.trim());
}

// Recommendation wording (heuristic) in en, zh, ja, ko, es, de, fr, pt; negated recommendations do not count.
const RECO_RE = /(\b(?:recommend|suggest|best|top pick|top choice|go-to|worth (?:a )?(?:try|trying|considering|checking|a look)|great (?:option|choice|place|resource)|ideal for|consider (?:using|trying)|try(?: out)?\b|recomiend|recomendad|empfehl|recommand|recomend)|推薦|推荐|建議|建议|首選|首选|不妨|可以試試|可以试试|值得一試|值得一试|最佳|おすすめ|オススメ|推奨|추천)/i;
const NEG_RE = /(\b(?:not|never|avoid|no longer)\b[^.!?。！？]{0,40}\b(?:recommend|suggest)|n't\s+(?:\w+\s+){0,2}(?:recommend|suggest)|不推薦|不推荐|不建議|不建议|おすすめしない|おすすめできない|추천하지)/i;

/** Heuristic: brand inside a list item, or in a sentence with (non-negated) recommendation wording. */
export function isRecommended(text, matcher) {
  if (!matcher || matcher.empty) return false;
  for (const item of listItems(text)) if (matcher.first(item)) return true;
  for (const s of splitSentences(text)) if (matcher.first(s) && RECO_RE.test(s) && !NEG_RE.test(s)) return true;
  return false;
}

/** Mention rank: order of first appearance among our brand and competitor brands; fallback: list-item order. */
export function mentionRank(text, brand, competitors = []) {
  const ours = brand.first(text);
  if (!ours) return { rank: null, method: '' };
  const active = competitors.filter((c) => !c.matcher.empty);
  if (active.length) {
    let before = 0;
    for (const c of active) {
      const hit = c.matcher.first(text);
      if (hit && hit.index < ours.index) before++;
    }
    return { rank: before + 1, method: 'order-of-appearance' };
  }
  const items = listItems(text);
  const idx = items.findIndex((it) => brand.first(it));
  return idx >= 0 ? { rank: idx + 1, method: 'list-item' } : { rank: null, method: 'not-in-list' };
}

// ---------- domains ----------
export function domainOf(url) {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

const looksLikeDomain = (s) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(String(s || '').trim());

/**
 * Domain of a source. Redirect hosts (Gemini grounding chunks) never count as a domain: the title (or fallback) is used
 * when it is a bare domain, else ''.
 */
export function sourceDomain(url, title, fallback = '') {
  const d = domainOf(url);
  if (d && !/(^|\.)vertexaisearch\.cloud\.google\.com$/.test(d)) return d;
  for (const cand of [title, fallback]) if (looksLikeDomain(cand)) return bareHost(String(cand).trim().toLowerCase());
  return '';
}

/** Set of bare domains; has(d) also matches subdomains. */
export function domainSet(domains) {
  const list = [...new Set((domains || []).map((d) => bareHost(String(d || '').replace(/^https?:\/\//i, '').replace(/[/:].*$/, '')).trim()).filter(Boolean))];
  return {
    list,
    has: (d) => {
      const x = bareHost(d);
      return Boolean(x) && list.some((o) => x === o || x.endsWith(`.${o}`));
    },
    match: (d) => {
      const x = bareHost(d);
      return list.find((o) => x === o || x.endsWith(`.${o}`)) || '';
    },
  };
}

// ---------- secrets ----------
/** Values of every configured secret env var (providers, Bing, SERP, PageSpeed). Never print them. */
export function secretValues(ws) {
  const names = new Set();
  for (const name of Object.keys(PROVIDERS)) {
    const p = providerSettings(ws, name);
    for (const e of [p.apiKeyEnv, p.loginEnv, p.passwordEnv]) if (e) names.add(e);
  }
  for (const extra of ['BING_WEBMASTER_API_KEY', 'BRAVE_SEARCH_API_KEY', 'PAGESPEED_API_KEY', 'GOOGLE_OAUTH_ACCESS_TOKEN']) names.add(extra);
  if (ws && ws.config) for (const sec of ['bing', 'serp', 'pagespeed']) if (ws.config[sec] && ws.config[sec].apiKeyEnv) names.add(ws.config[sec].apiKeyEnv);
  return [...names].map((n) => process.env[n]).filter((v) => v && v.length >= 6);
}

/** True when the text contains a configured secret value (such a prompt is never sent). */
export function containsSecret(text, secrets) {
  const s = String(text || '');
  return secrets.some((v) => s.includes(v));
}

// ---------- per-answer analysis ----------
/**
 * answer: {status, searched, sourcesExposed, retrieved:[{url,title,domain}], cited:[{url,title,domain}], text}
 * ctx: {brand (makeTermMatcher), competitorBrands:[{name, matcher}], ours (domainSet), competitors (domainSet)}
 * Returns the CSV/funnel fields: mentioned, rank, citedRank, ourCitedUrl, citedDomains, competitorsCited,
 * competitorsMentioned, recommended and funnel {searched, retrieved, cited, mentioned, recommended} as y/n/n/a.
 */
export function analyzeAnswer(answer, ctx) {
  const text = stripLinkTargets(cleanText(answer.text));
  const mentioned = Boolean(ctx.brand.first(text));
  const cited = answer.cited || [];
  const retrieved = answer.retrieved || [];
  const citedDomains = [...new Set(cited.map((c) => c.domain).filter(Boolean))];
  const ourCitedIdx = citedDomains.findIndex((d) => ctx.ours.has(d));
  const ourCitation = cited.find((c) => ctx.ours.has(c.domain));
  const weRetrieved = retrieved.some((r) => ctx.ours.has(r.domain));
  const searched = Boolean(answer.searched);
  const rank = mentioned ? mentionRank(text, ctx.brand, ctx.competitorBrands || []) : { rank: null, method: '' };
  const recommended = mentioned && isRecommended(text, ctx.brand);
  const competitorsCited = [...new Set(citedDomains.map((d) => ctx.competitors.match(d)).filter(Boolean))];
  const competitorsMentioned = (ctx.competitorBrands || []).filter((c) => !c.matcher.empty && c.matcher.first(text)).map((c) => c.name);
  // n/a = the engine did not search, or exposes no source list / no citations, so the stage cannot be measured
  const citedFlag = !searched || answer.citationsExposed === false ? 'n/a' : ourCitedIdx >= 0 ? 'y' : 'n';
  const retrievedFlag = !searched || !answer.sourcesExposed ? 'n/a' : weRetrieved || citedFlag === 'y' ? 'y' : 'n';
  return {
    mentioned,
    rank: rank.rank,
    rankMethod: rank.method,
    citedRank: ourCitedIdx >= 0 ? ourCitedIdx + 1 : null,
    // redirect URLs (e.g. Gemini grounding) only identify the domain: no page URL is recorded for them
    ourCitedUrl: ourCitation && domainOf(ourCitation.url) === ourCitation.domain ? ourCitation.url : '',
    citedDomains,
    competitorsCited,
    competitorsMentioned,
    recommended,
    funnel: { searched: searched ? 'y' : 'n', retrieved: retrievedFlag, cited: citedFlag, mentioned: mentioned ? 'y' : 'n', recommended: recommended ? 'y' : 'n' },
  };
}

// ---------- aggregation ----------
export function rateOf(k, n) {
  if (!n) return { k: 0, n: 0, rate: null, low: null, high: null, small: true };
  const w = wilsonInterval(k, n);
  return { k, n, rate: k / n, low: w.low, high: w.high, small: n < SMALL_SAMPLE };
}

/** Valid = completed answer with a web search; everything else is counted separately (never as 0). */
export const isValid = (s) => s.status === 'ok';
export const isMainArm = (s) => !isYes(s.branded) && !['negative', 'placebo'].includes(String(s.arm || '').toLowerCase());

/**
 * Rates over samples ({status, branded, arm, analysis}). Denominator = valid answers; retrieved/cited rates only
 * over answers whose engine exposes that stage (n/a excluded).
 */
export function summarizeSamples(samples) {
  const valid = samples.filter(isValid);
  const flag = (stage) => valid.filter((s) => s.analysis && s.analysis.funnel[stage] !== 'n/a');
  const yes = (list, stage) => list.filter((s) => s.analysis.funnel[stage] === 'y').length;
  const retrievedBase = flag('retrieved');
  const citedBase = flag('cited');
  return {
    samples: samples.length,
    valid: valid.length,
    failed: samples.filter((s) => s.status === 'failed' || s.status === 'incomplete').length,
    noSearch: samples.filter((s) => s.status === 'no-search').length,
    mention: rateOf(yes(valid, 'mentioned'), valid.length),
    retrieved: rateOf(yes(retrievedBase, 'retrieved'), retrievedBase.length),
    cited: rateOf(yes(citedBase, 'cited'), citedBase.length),
    recommended: rateOf(yes(valid, 'recommended'), valid.length),
  };
}

/**
 * Prompt-cluster bootstrap 95% interval for a pooled rate (samples of one prompt are correlated): resample prompts with
 * replacement (fixed seed), pool k/n. Null with fewer than 2 prompts. stage: mentioned | cited | retrieved | recommended.
 */
export function clusterBootstrap(samples, stage = 'mentioned', { iterations = 2000, seed = 7 } = {}) {
  const usable = samples.filter((s) => isValid(s) && s.analysis && s.analysis.funnel[stage] !== 'n/a');
  const groups = [...groupBy(usable, (s) => s.promptId).values()].map((list) => ({ k: list.filter((s) => s.analysis.funnel[stage] === 'y').length, n: list.length }));
  if (groups.length < 2) return null;
  const rand = mulberry32(seed);
  const rates = [];
  for (let it = 0; it < iterations; it++) {
    let k = 0;
    let n = 0;
    for (let j = 0; j < groups.length; j++) {
      const g = groups[Math.floor(rand() * groups.length)];
      k += g.k;
      n += g.n;
    }
    rates.push(n ? k / n : 0);
  }
  rates.sort((a, b) => a - b);
  return { low: rates[Math.floor(0.025 * iterations)], high: rates[Math.ceil(0.975 * iterations) - 1], prompts: groups.length, iterations, seed };
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

const setJaccard = (a, b) => {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/** Mean pairwise Jaccard of cited-domain sets across samples of one prompt (null with < 2 valid samples). */
export function citedStability(samples) {
  const sets = samples.filter(isValid).map((s) => new Set(s.analysis.citedDomains));
  if (sets.length < 2) return null;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      sum += setJaccard(sets[i], sets[j]);
      pairs++;
    }
  }
  return sum / pairs;
}

export function median(xs) {
  const v = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Share of valid answers citing each domain, plus ours/competitor flags. */
export function domainShares(samples, ctx) {
  const valid = samples.filter(isValid);
  const counts = new Map();
  let occurrences = 0;
  for (const s of valid) {
    for (const d of s.analysis.citedDomains) counts.set(d, (counts.get(d) || 0) + 1);
    occurrences += s.analysis.citedDomains.length;
  }
  return [...counts.entries()]
    .map(([domain, answers]) => ({ domain, answers, answerShare: valid.length ? answers / valid.length : 0, citationShare: occurrences ? answers / occurrences : 0, ours: ctx.ours.has(domain), competitor: Boolean(ctx.competitors.match(domain)) }))
    .sort((a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain));
}

/**
 * Outreach candidates: third-party domains cited in answers where a competitor is cited or mentioned and we are not
 * cited, and never cited in an answer that also cites us.
 */
export function outreachCandidates(samples, ctx) {
  const valid = samples.filter(isValid);
  const withUs = new Set();
  const alongside = new Map();
  for (const s of valid) {
    const a = s.analysis;
    const weCited = a.citedDomains.some((d) => ctx.ours.has(d));
    for (const d of a.citedDomains) if (weCited) withUs.add(d);
    const competitorPresent = a.competitorsCited.length > 0 || a.competitorsMentioned.length > 0;
    if (weCited || !competitorPresent) continue;
    for (const d of a.citedDomains) {
      if (ctx.ours.has(d) || ctx.competitors.match(d)) continue;
      const e = alongside.get(d) || { domain: d, answers: 0, engines: new Set(), prompts: new Set(), competitors: new Set() };
      e.answers++;
      e.engines.add(s.engine);
      e.prompts.add(s.promptId);
      for (const c of [...a.competitorsCited, ...a.competitorsMentioned]) e.competitors.add(c);
      alongside.set(d, e);
    }
  }
  return [...alongside.values()]
    .filter((e) => !withUs.has(e.domain))
    .map((e) => ({ domain: e.domain, answers: e.answers, engines: [...e.engines].sort(), prompts: [...e.prompts].sort(), competitors: [...e.competitors].sort() }))
    .sort((a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain));
}

// ---------- CSV rows ----------
const yn = (b) => (b ? 'yes' : 'no');

/** geo-prompts.csv row for one automated sample (human columns reason/accuracy/pricing_claim/action_needed stay empty). */
export function sampleRow(s, { date, runId }) {
  const def = s.def;
  const row = Object.fromEntries(GEO_COLUMNS.map((c) => [c, '']));
  Object.assign(row, {
    run_date: date,
    engine: `${s.engine}-api`,
    locale: def.locale,
    intent: def.intent,
    prompt: def.prompt,
    prompt_id: def.id,
    portfolio_version: def.portfolio_version,
    cohort: def.cohort,
    arm: def.arm,
    variant_group: def.variant_group,
    branded: def.branded,
    topic: def.topic,
    country: def.country,
    method: `api:${s.model}`,
    k: String(s.k),
  });
  const notes = [`auto run=${runId}`];
  if (s.status === 'ok' || s.status === 'no-search') {
    const a = s.analysis;
    Object.assign(row, {
      mentioned: yn(a.mentioned),
      rank: a.rank ? String(a.rank) : '',
      cited_url: a.ourCitedUrl,
      competitors: [...new Set([...a.competitorsMentioned, ...a.competitorsCited])].join(';'),
      searched: a.funnel.searched,
      retrieved: a.funnel.retrieved,
      cited: a.funnel.cited,
      recommended: a.funnel.recommended,
      cited_domains: a.citedDomains.join(';'),
    });
    if (a.citedRank) notes.push(`cited_rank=${a.citedRank}`);
    if (s.status === 'no-search') notes.push('no web search (not counted in rates)');
  } else {
    notes.push(`${s.status}: ${excerpt(s.error, 120)} (not counted in rates)`);
  }
  row.notes = notes.join('; ');
  return row;
}
