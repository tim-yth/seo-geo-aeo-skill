#!/usr/bin/env node
// Import manual exports of the AI-visibility reports that have no API: Search Console "Generative AI" performance
// (Search and Discover) and Bing Webmaster Tools "AI Performance". Normalizes, stores, maps to pages and topics.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, readJson, normalizeUrl, ensureDir } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { readCsvFile, writeCsvFile } from './lib/csv.mjs';
import { addDays, listDays, isYmd, spanDays } from './lib/dates.mjs';
import { compactKey, topicTokens, jaccard } from './lib/text.mjs';
import { fmtInt, fmtPct, fmtSignedPct, mdTable, shortUrl } from './lib/format.mjs';
import { readZipEntries } from './lib/zip.mjs';
import { loadGscFile } from './lib/gsc.mjs';
import { loadEvents, overlapEvents, describeOverlap } from './lib/events.mjs';
import { clusterQueries } from './query-clusters.mjs';

export const SOURCES = {
  gsc: { dir: 'gsc/ai-features', label: 'Search Console Generative AI report', kinds: ['dates', 'pages', 'countries', 'devices'] },
  bing: { dir: 'bing/ai-performance', label: 'Bing Webmaster Tools AI Performance', kinds: ['trend', 'pages', 'grounding', 'intents', 'topics', 'citation-share', 'portfolio'] },
};

const SPEC = {
  ...COMMON_FLAGS,
  gsc: { type: 'list', placeholder: 'file', desc: 'Import this file as a Search Console Generative AI export (zip or CSV)' },
  bing: { type: 'list', placeholder: 'file', desc: 'Import this file as a Bing AI Performance export (CSV)' },
  label: { type: 'string', desc: 'Name of this import (default: its date range, e.g. 2026-10-01_2026-10-28)' },
  variant: { type: 'string', desc: 'GSC report variant: search or discover (default: from file name or filters)', choices: ['search', 'discover'] },
  force: { type: 'boolean', desc: 'Re-import files already imported (same SHA-256)' },
  'gsc-pages': { type: 'string', placeholder: 'file', desc: 'GSC page export (gsc-export page dimension, same period): AI impressions as a share of each page\'s total' },
  compare: { type: 'string', placeholder: 'A:B', desc: 'Compare two imports by label (periods must have equal length)' },
  similarity: { type: 'number', desc: 'Grounding queries: token-overlap threshold to group queries into one topic (0-1)', default: 0.4 },
  top: { type: 'int', desc: 'Rows per report section', default: 15 },
  json: { type: 'boolean', desc: 'Print the result as JSON' },
};

const HELP = formatHelp({
  usage: [
    'node scripts/ai-reports-import.mjs                         # import new files from the two inboxes',
    'node scripts/ai-reports-import.mjs <file|dir>... [--label oct-2026]',
    'node scripts/ai-reports-import.mjs --gsc export.zip --gsc-pages data/gsc/<date>-page-28d.json',
    'node scripts/ai-reports-import.mjs --compare 2026-09-01_2026-09-28:2026-09-29_2026-10-26',
  ],
  summary:
    'Neither report has an API: export them from the web UI and drop the raw files into <workspace>/data/gsc/ai-features/inbox/ (Search Console: ' +
    'Performance -> Generative AI -> Export -> CSV zip; the Discover variant too) and <workspace>/data/bing/ai-performance/inbox/ (Bing Webmaster ' +
    'Tools -> AI Performance -> Download / Download all as CSV). Each file is recognized by its headers (English, zh-TW, zh-CN, ja, ko, es, de, fr; file ' +
    'names are only a hint), normalized (BOM, quotes, thousands separators, %, full-width digits, many date formats) and stored as ' +
    'data/gsc/ai-features/<today>-<label>-{dates,pages,countries,devices}.json/.csv or data/bing/ai-performance/<today>-<label>-{trend,pages,grounding,' +
    'intents,topics,citation-share,portfolio}.json/.csv with source, kind, SHA-256 and period. Re-runs skip files already imported (imports.json). ' +
    'Analysis: weekly totals (last 4 weeks vs the 4 before, week over week), pages mapped to page groups and keyword-map.csv targets, AI share of ' +
    'each page\'s total impressions (--gsc-pages), grounding queries grouped into topics and matched to keyword-map.csv, Topics Portfolio rows where ' +
    'others are cited and you are not (portfolio-todo.csv), Search Console anomalies overlapping the period, and --compare of two equal-length imports. ' +
    'Report: logs/reviews/<today>-ai-reports.md.',
  spec: SPEC,
  examples: [
    'node scripts/ai-reports-import.mjs',
    'node scripts/ai-reports-import.mjs ~/Downloads/example.com-Performance-Generative-AI-2026-11-01.zip --label oct-2026',
    'node scripts/ai-reports-import.mjs --bing ~/Downloads/www.example.com_AISearchQueriesReport_11_1_2026.csv --bing ~/Downloads/www.example.com_AIPageStatsReport_11_1_2026.csv',
    'node scripts/ai-reports-import.mjs --compare sep-2026:oct-2026',
  ],
  notes: [
    'Evidence level: AI impressions (Google) and citations (Bing) only - not clicks, traffic or revenue. AI impressions are already inside the regular Performance totals: never add them, only compare as a share.',
    'Excel files (.xlsx) are not read: choose CSV in the export menu or save the sheet as CSV (UTF-8).',
    'A table export has no period inside it: import the chart/trend file together with the tables (same zip or same run) or pass --label with the period.',
  ],
});

// ---------- parsing ----------
/** Decode bytes: UTF-8 (BOM stripped) or UTF-16 LE/BE with BOM (Excel "Unicode text"). */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    throw new UserError('the file is not UTF-8 text (Excel saves plain "CSV" in the local code page)', { hint: ['Re-save it as "CSV UTF-8" (Excel) or UTF-8 (Numbers, Google Sheets, your editor), or use the original export file.'] });
  }
}

export function sniffDelimiter(text) {
  const first = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim()) || '';
  const count = (ch) => {
    let n = 0;
    let q = false;
    for (const c of first) {
      if (c === '"') q = !q;
      else if (c === ch && !q) n++;
    }
    return n;
  };
  const scores = [[',', count(',')], [';', count(';')], ['\t', count('\t')]].sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ',';
}

/** RFC 4180-style parse with a chosen delimiter (quotes, doubled quotes, embedded newlines, CRLF). */
export function parseDelimited(text, delim = ',') {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

const SPREADSHEET_EXT = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods', '.numbers']);

/** Tables in a file: [{name, file, rows: string[][]}] from a CSV/TSV or every CSV inside a zip. */
export function readTables(file) {
  const ext = path.extname(file).toLowerCase();
  const asCsvHint = ['Open it and save/export it as CSV (UTF-8), or pick CSV in the report\'s Export / Download menu.', 'Search Console: Export -> Download CSV (a zip of CSV files). Bing: Download -> CSV.'];
  if (SPREADSHEET_EXT.has(ext)) throw new UserError(`${path.basename(file)} is a spreadsheet; only CSV exports are read`, { hint: asCsvHint });
  const buf = fs.readFileSync(file);
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) {
    const entries = readZipEntries(file);
    if (entries.some((e) => /^xl\/workbook\.xml$/i.test(e.name) || /^\[Content_Types\]\.xml$/i.test(e.name))) throw new UserError(`${path.basename(file)} is an Excel workbook; only CSV exports are read`, { hint: asCsvHint });
    const csvs = entries.filter((e) => /\.(csv|tsv|txt)$/i.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name));
    if (!csvs.length) throw new UserError(`${path.basename(file)} contains no CSV (${entries.map((e) => e.name).join(', ') || 'empty zip'})`, { hint: asCsvHint });
    return csvs.map((e) => {
      const text = e.text.replace(/^\uFEFF/, '');
      return { name: path.basename(e.name), file, rows: parseDelimited(text, sniffDelimiter(text)) };
    });
  }
  let text;
  try {
    text = decodeText(buf);
  } catch (e) {
    throw new UserError(`${path.basename(file)}: ${e.message}`, { hint: e.hint });
  }
  return [{ name: path.basename(file), file, rows: parseDelimited(text, sniffDelimiter(text)) }];
}

// ---------- values ----------
const toAscii = (v) => String(v ?? '').normalize('NFKC').replace(/[\u00A0\u2007\u2009\u202F]/g, ' ').trim();

/** Parse a count or measure: thousands separators, %, K/M suffixes, full-width digits; "~", "-", "" -> 0 for counts. */
export function toNumber(value, { integer = false, emptyZero = true } = {}) {
  let s = toAscii(value);
  if (s === '' || s === '~' || s === '-' || s === '—' || s === '–') return emptyZero ? 0 : null;
  s = s.replace(/^[<>~≈]\s*/, '').replace(/\s+/g, '');
  const pct = s.endsWith('%');
  if (pct) s = s.slice(0, -1);
  let mult = 1;
  const suf = /^(-?[\d.,]+)([kmb])$/i.exec(s);
  if (suf) {
    s = suf[1];
    mult = { k: 1e3, m: 1e6, b: 1e9 }[suf[2].toLowerCase()];
  }
  if (/^-?\d{1,3}([,.']\d{3})+$/.test(s) && (integer || /,\d{3}$/.test(s) || /'\d{3}/.test(s) || (s.match(/[.]/g) || []).length > 1)) s = s.replace(/[,.']/g, '');
  else if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const v = n * mult;
  return pct ? v / 100 : v;
}

const MONTHS = {
  jan: 1, january: 1, ene: 1, enero: 1, janv: 1, janvier: 1, januar: 1, jän: 1,
  feb: 2, february: 2, febrero: 2, févr: 2, fevr: 2, février: 2, februar: 2,
  mar: 3, march: 3, marzo: 3, mars: 3, mär: 3, märz: 3, marz: 3,
  apr: 4, april: 4, abr: 4, abril: 4, avr: 4, avril: 4,
  may: 5, mayo: 5, mai: 5,
  jun: 6, june: 6, junio: 6, juin: 6, juni: 6,
  jul: 7, july: 7, julio: 7, juil: 7, juillet: 7, juli: 7,
  aug: 8, august: 8, ago: 8, agosto: 8, août: 8, aout: 8,
  sep: 9, sept: 9, september: 9, septiembre: 9, septembre: 9,
  oct: 10, october: 10, octubre: 10, octobre: 10, okt: 10, oktober: 10,
  nov: 11, november: 11, noviembre: 11, novembre: 11,
  dec: 12, december: 12, dic: 12, diciembre: 12, déc: 12, decembre: 12, décembre: 12, dez: 12, dezember: 12,
};

const ymdOf = (y, m, d) => {
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isYmd(s) ? s : null;
};

/** Parse one date: 2026-10-01, 2026/10/01, Oct 1, 2026, 1 Oct 2026, 10/1/2026 (order: 'mdy'|'dmy'), 2026年10月1日, 2026. 10. 1. */
export function parseDateValue(value, order = 'mdy') {
  let s = toAscii(value);
  if (!s) return null;
  s = s.replace(/(?:[T ]|\s+)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AaPp]\.?[Mm]\.?|上午|下午|午前|午後)?\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT)?$/, '').trim();
  s = s.replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '');
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\.?$/.exec(s))) return ymdOf(m[1], m[2], m[3]);
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymdOf(m[1], m[2], m[3]);
  if ((m = /^(\d{4})\s*[年년.]\s*(\d{1,2})\s*[月월.]\s*(\d{1,2})\s*[日일.]?$/.exec(s))) return ymdOf(m[1], m[2], m[3]);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) {
    let [a, b] = [Number(m[1]), Number(m[2])];
    const dmy = a > 12 || (order === 'dmy' && b <= 12);
    if (!dmy && b > 12 && a <= 12) return ymdOf(m[3], a, b);
    return dmy ? ymdOf(m[3], b, a) : ymdOf(m[3], a, b);
  }
  if ((m = /^([\p{L}]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/u.exec(s)) && MONTHS[m[1].toLowerCase()]) return ymdOf(m[3], MONTHS[m[1].toLowerCase()], m[2]);
  if ((m = /^(\d{1,2})\.?\s+(?:de\s+)?([\p{L}]+)\.?,?\s+(?:de\s+)?(\d{4})$/u.exec(s)) && MONTHS[m[2].toLowerCase()]) return ymdOf(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  return null;
}

/** Day/month order for a column of n/n/yyyy dates: 'dmy' when any first part > 12 or the separator is a dot, else 'mdy'. */
export function inferDateOrder(values) {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = /^(\d{1,2})([/.-])(\d{1,2})\2\d{4}/.exec(toAscii(v));
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    else if (Number(m[3]) > 12) mdy++;
    else if (m[2] === '.') dmy += 0.01;
  }
  return dmy > mdy ? 'dmy' : 'mdy';
}

// ---------- header roles ----------
const norm = (h) => toAscii(h).replace(/^["']|["']$/g, '').toLowerCase().replace(/[\s_]+/g, ' ').trim();
const ROLES = {
  date: ['date', 'dates', 'day', 'days', '日期', '日付', '날짜', 'fecha', 'datum', 'data', 'jour', 'time', 'time period'],
  page: ['top pages', 'page', 'pages', 'url', 'urls', 'page url', 'cited page', 'cited url', 'landing page', '網頁', '熱門網頁', '网页', '热门网页', '排名靠前的网页', '页面', 'ページ', '上位のページ', '페이지', '인기 페이지', '상위 페이지', 'páginas principales', 'página', 'páginas', 'top-seiten', 'seite', 'seiten', 'pages les plus populaires', 'páginas principais', 'pagine principali', 'pagina'],
  country: ['country', 'countries', '國家/地區', '國家', '国家/地区', '国家', '国', '国/地域', '국가', 'país', 'países', 'land', 'länder', 'pays', 'paese'],
  device: ['device', 'devices', 'device type', '裝置', '设备', 'デバイス', '기기', 'dispositivo', 'dispositivos', 'gerät', 'geräte', 'appareil', 'appareils'],
  impressions: ['impressions', 'impression', '曝光', '曝光次數', '曝光次数', '展示', '展示次数', '展示次數', '表示回数', '노출', '노출수', 'impresiones', 'impressionen', 'impressões', 'impressioni'],
  citations: ['citations', 'citation', 'total citations', 'citation count', 'citations count', '引用', '引用次數', '引用次数', '被引用次數', '被引用次数', '引用數', '引用数', '引用回数', '인용', '인용 수', '인용수', 'citas', 'zitate', 'zitierungen', 'zitationen', 'citações', 'citazioni', 'citations totales', 'nombre de citations'],
  citedPages: ['cited pages', 'cited page count', 'pages cited', 'unique cited pages', '被引用網頁', '被引用的網頁', '被引用網頁數', '被引用页面', '被引用的页面', '引用されたページ', '引用ページ数', '인용된 페이지', 'páginas citadas', 'zitierte seiten', 'pages citées', 'páginas citadas'],
  query: ['grounding query', 'grounding queries', 'query', 'queries', 'search query', 'opportunity query', 'opportunity queries', 'your grounding queries', 'grounding 查詢', '基礎查詢', '依據查詢', 'grounding 查询', 'grounding クエリ', 'グラウンディング クエリ', '그라운딩 쿼리', 'consulta de grounding', 'consulta', 'consultas', 'grounding-abfrage', 'abfrage', 'suchanfrage', 'requête', "requête d'ancrage", 'requête de grounding'],
  intent: ['intent', 'intents', 'query intent', '意圖', '意图', 'インテント', '意図', '의도', 'intención', 'absicht', 'suchabsicht', 'intention'],
  topic: ['topic', 'topics', '主題', '主题', 'トピック', '주제', 'tema', 'thema', 'sujet', 'thème'],
  share: ['citation share', 'share', 'share of citations', 'your citation share', 'citation share (%)', '引用占比', '引用佔比', '引用份額', '引用份额', '引用比例', '引用シェア', '인용 점유율', 'cuota de citas', 'participación de citas', 'zitieranteil', 'zitationsanteil', 'part des citations', 'part de citation', 'quota di citazioni'],
  topicSize: ['topic size', 'size', 'topic citations', '主題規模', '主题规模', 'トピックサイズ', '주제 크기', 'tamaño del tema', 'themengröße', 'taille du sujet'],
  sitesCited: ['sites cited', 'cited sites', 'sites', 'other sites cited', '被引用網站', '被引用网站', '引用されたサイト', '인용된 사이트', 'sitios citados', 'zitierte websites', 'sites cités'],
  yours: ['your citations', 'your site citations', 'you', 'your site', 'cited (you)', 'your pages cited', 'your cited pages', 'your share', 'your citation count', '你的引用', '您的引用', '自分の引用'],
  volume: ['volume', 'search volume', 'query volume', 'opportunity', 'estimated volume', 'volume range'],
  queryCount: ['query count', 'number of queries', 'queries count'],
  filter: ['filter', 'filters', '篩選器', '篩選', '筛选器', '过滤器', 'フィルタ', 'フィルター', '필터', 'filtro', 'filtros', 'filtre', 'filtres'],
  value: ['value', 'values', '值', '値', '값', 'valor', 'wert', 'valeur', 'valore'],
  clicks: ['clicks', 'click', '點擊', '點擊次數', '点击次数', '点击', 'クリック数', '클릭수', 'clics', 'klicks', 'cliques', 'clic'],
  position: ['position', 'average position', 'ctr', '平均排名', '點閱率', '点击率', '掲載順位', '게재순위', 'posición', 'posição'],
};
const ROLE_SETS = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, new Set(v.map(norm))]));
const CONTAINS = { impressions: /(impression|曝光|展示|表示回数|노출|impresion|impressõ)/, citations: /(citation|引用|인용|zitat|zitier|citas|citaç|citazion)/, date: /^(date|日期|日付|날짜|fecha|datum)\b/ };

/** Map headers to roles: exact (localized) names first, then a few robust "contains" patterns. Returns {roles:{role: index}, extra:[...], dup:[role]}. */
export function headerRoles(headers) {
  const roles = {};
  const dup = [];
  headers.forEach((h, i) => {
    const n = norm(h);
    for (const [role, set] of Object.entries(ROLE_SETS)) {
      if (!set.has(n)) continue;
      if (roles[role] === undefined) roles[role] = i;
      else dup.push(role);
      return;
    }
  });
  headers.forEach((h, i) => {
    if (Object.values(roles).includes(i)) return;
    const n = norm(h);
    for (const [role, re] of Object.entries(CONTAINS)) {
      if (!re.test(n)) continue;
      if (role === 'impressions' && /citation|引用/.test(n)) continue;
      if (roles[role] === undefined) roles[role] = i;
      else dup.push(role);
      return;
    }
  });
  return { roles, dup: [...new Set(dup)], extra: headers.map((h, i) => (Object.values(roles).includes(i) ? null : h)).filter((h) => h !== null && String(h).trim() !== '') };
}

/** Recognize one table. Returns {source, kind, roles, ...} or {kind: 'unknown'|'performance'|'filters'}. */
export function classifyTable(table, { sourceHint = '', fileName = '' } = {}) {
  const headers = (table.rows[0] || []).map((h) => String(h).trim());
  const { roles, dup, extra } = headerRoles(headers);
  const has = (r) => roles[r] !== undefined;
  const base = { headers, roles, dup, extra, name: table.name };
  const nameHint = `${fileName} ${table.name}`;
  if (has('filter') && has('value') && headers.length <= 3) return { ...base, kind: 'filters' };
  const bingSignals = has('citations') || has('citedPages') || has('share') || has('topicSize') || has('sitesCited') || has('intent') || has('topic') || has('volume') || /AIPerformance|AISearchQueries|AIPageStats|AICitation|Topics?[ _-]?Portfolio|Opportunit|grounding|bing/i.test(nameHint);
  let source = sourceHint;
  if (!source) source = bingSignals && !(has('impressions') && !has('citations') && !has('share') && !has('query')) ? 'bing' : has('impressions') ? 'gsc' : '';
  if (source === 'gsc') {
    if (has('clicks') || has('position')) return { ...base, source, kind: 'performance' };
    if (!has('impressions')) return { ...base, source, kind: 'unknown' };
    if (has('date')) return { ...base, source, kind: 'dates' };
    if (has('page')) return { ...base, source, kind: 'pages' };
    if (has('country')) return { ...base, source, kind: 'countries' };
    if (has('device')) return { ...base, source, kind: 'devices' };
    return { ...base, source, kind: 'unknown' };
  }
  if (source === 'bing') {
    const opportunity = /opportunit/i.test(nameHint) || headers.some((h) => /opportunit/i.test(h));
    if (has('date') && (has('citations') || has('citedPages') || has('share'))) return { ...base, source, kind: 'trend' };
    if (has('topic') && (has('topicSize') || has('sitesCited') || has('yours') || /portfolio/i.test(nameHint))) return { ...base, source, kind: 'portfolio' };
    if (has('query') && (opportunity || /portfolio/i.test(nameHint))) return { ...base, source, kind: 'portfolio', opportunity: true };
    if (has('query')) return { ...base, source, kind: 'grounding' };
    if (has('page') && (has('citations') || has('share'))) return { ...base, source, kind: 'pages' };
    if (has('intent') && (has('citations') || has('share'))) return { ...base, source, kind: 'intents' };
    if (has('topic') && (has('citations') || has('share'))) return { ...base, source, kind: 'topics' };
    if (has('share') && !has('citations')) return { ...base, source, kind: 'citation-share' };
    return { ...base, source, kind: 'unknown' };
  }
  return { ...base, source: '', kind: 'unknown' };
}

const DEVICE_NAMES = [['mobile', /^(mobile|行動裝置|行動|手機|移动设备|移动|手机|モバイル|모바일|móvil|movil|mobil|mobilgerät|celular)$/i], ['desktop', /^(desktop|computer|電腦|桌機|桌上型電腦|计算机|电脑|桌面|パソコン|デスクトップ|데스크톱|ordenador|escritorio|ordinateur|computador)$/i], ['tablet', /^(tablet|平板電腦|平板|平板电脑|タブレット|태블릿|tableta|tablette)$/i]];
const normDevice = (v) => {
  const s = toAscii(v);
  for (const [name, re] of DEVICE_NAMES) if (re.test(s)) return name;
  return s.toLowerCase();
};

/** Normalized rows for a classified table (the original values of unmapped columns are kept under "extra"). */
export function normalizeTable(table, cls, { ws } = {}) {
  const rows = table.rows.slice(1);
  const r = cls.roles;
  const get = (row, role) => (r[role] === undefined ? '' : row[r[role]] ?? '');
  const order = r.date !== undefined ? inferDateOrder(rows.map((row) => get(row, 'date'))) : 'mdy';
  const shareValues = r.share !== undefined ? rows.map((row) => toAscii(get(row, 'share'))) : [];
  const sharePct = shareValues.some((v) => v.endsWith('%'));
  const shareMax = Math.max(0, ...shareValues.map((v) => toNumber(v, { emptyZero: false }) ?? 0));
  const share = (row) => {
    const raw = toAscii(get(row, 'share'));
    if (!raw) return null;
    const n = toNumber(raw, { emptyZero: false });
    if (n === null) return null;
    return sharePct || shareMax <= 1 ? n : n / 100;
  };
  const extraIdx = (cls.headers || []).map((h, i) => (Object.values(r).includes(i) || !String(h).trim() ? null : [h, i])).filter(Boolean);
  const extra = (row) => (extraIdx.length ? Object.fromEntries(extraIdx.map(([h, i]) => [h, row[i] ?? ''])) : undefined);
  const groupOf = (url) => (ws ? ws.pageGroupOf(url) : '');
  // a portfolio "Queries" column holds counts, not query text
  const queryIsCount = cls.kind === 'portfolio' && r.query !== undefined && rows.every((row) => {
    const v = toAscii(get(row, 'query'));
    return v === '' || toNumber(v, { emptyZero: false }) !== null;
  });
  const out = [];
  const bad = [];
  for (const row of rows) {
    const rec = {};
    if (r.date !== undefined) {
      const d = parseDateValue(get(row, 'date'), order);
      if (!d) {
        bad.push(get(row, 'date'));
        continue;
      }
      rec.date = d;
    }
    switch (cls.kind) {
      case 'dates':
        rec.impressions = toNumber(get(row, 'impressions'), { integer: true });
        break;
      case 'pages':
        rec.page = toAscii(get(row, 'page'));
        if (cls.source === 'gsc') rec.impressions = toNumber(get(row, 'impressions'), { integer: true });
        else {
          rec.citations = toNumber(get(row, 'citations'), { integer: true });
          if (r.share !== undefined) rec.citationShare = share(row);
        }
        rec.group = groupOf(rec.page);
        break;
      case 'countries':
        rec.country = toAscii(get(row, 'country'));
        rec.impressions = toNumber(get(row, 'impressions'), { integer: true });
        break;
      case 'devices':
        rec.device = normDevice(get(row, 'device'));
        rec.deviceLabel = toAscii(get(row, 'device'));
        rec.impressions = toNumber(get(row, 'impressions'), { integer: true });
        break;
      case 'trend':
        rec.citations = r.citations !== undefined ? toNumber(get(row, 'citations'), { integer: true }) : null;
        rec.citedPages = r.citedPages !== undefined ? toNumber(get(row, 'citedPages'), { integer: true }) : null;
        if (r.share !== undefined) rec.citationShare = share(row);
        break;
      case 'grounding':
        rec.query = toAscii(get(row, 'query'));
        rec.citations = r.citations !== undefined ? toNumber(get(row, 'citations'), { integer: true }) : null;
        if (r.intent !== undefined) rec.intent = toAscii(get(row, 'intent'));
        if (r.topic !== undefined) rec.topic = toAscii(get(row, 'topic'));
        if (r.share !== undefined) rec.citationShare = share(row);
        if (r.page !== undefined) rec.page = toAscii(get(row, 'page'));
        break;
      case 'intents':
      case 'topics':
        rec[cls.kind === 'intents' ? 'intent' : 'topic'] = toAscii(get(row, cls.kind === 'intents' ? 'intent' : 'topic'));
        rec.citations = r.citations !== undefined ? toNumber(get(row, 'citations'), { integer: true }) : null;
        if (r.share !== undefined) rec.citationShare = share(row);
        break;
      case 'citation-share': {
        const labelIdx = (cls.headers || []).findIndex((h, i) => i !== r.share && i !== r.date && String(h).trim());
        rec.label = labelIdx >= 0 ? toAscii(row[labelIdx]) : '';
        rec.citationShare = share(row);
        break;
      }
      case 'portfolio':
        if (r.topic !== undefined) rec.topic = toAscii(get(row, 'topic'));
        if (r.query !== undefined && queryIsCount) rec.queries = toNumber(get(row, 'query'), { integer: true, emptyZero: false });
        else if (r.query !== undefined) rec.query = toAscii(get(row, 'query'));
        if (r.topicSize !== undefined) rec.topicSize = toNumber(get(row, 'topicSize'), { emptyZero: false });
        if (r.sitesCited !== undefined) rec.sitesCited = toNumber(get(row, 'sitesCited'), { integer: true, emptyZero: false });
        if (r.citations !== undefined) rec.citations = toNumber(get(row, 'citations'), { integer: true, emptyZero: false });
        if (r.yours !== undefined) rec.yours = toAscii(get(row, 'yours'));
        if (r.share !== undefined) rec.citationShare = share(row);
        if (r.volume !== undefined) rec.volume = toAscii(get(row, 'volume'));
        rec.opportunity = Boolean(cls.opportunity);
        break;
      default:
        break;
    }
    const x = extra(row);
    if (x) rec.extra = x;
    const keyField = { pages: 'page', countries: 'country', devices: 'deviceLabel', grounding: 'query', intents: 'intent', topics: 'topic' }[cls.kind];
    if (keyField && !rec[keyField]) continue;
    out.push(rec);
  }
  return { rows: out, badDates: bad.slice(0, 5), badDateCount: bad.length, dateOrder: order };
}

export function dateRangeOf(rows) {
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return dates.length ? { start: dates[0], end: dates[dates.length - 1], days: spanDays(dates[0], dates[dates.length - 1]) } : null;
}

/** 7-day blocks ending at the newest date (leading partial block dropped); last 4 vs the 4 before; week over week. */
export function weeklyTrend(daily, valueKey) {
  const rows = daily.filter((d) => d.date && Number.isFinite(d[valueKey])).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) return { weeks: [], last4: null, prev4: null, change4: null, wow: null, total: 0, granularity: 'none' };
  const byDate = new Map();
  for (const d of rows) byDate.set(d.date, (byDate.get(d.date) || 0) + d[valueKey]); // hourly rows add up to their day
  const total = rows.reduce((s, d) => s + d[valueKey], 0);
  const dates = [...byDate.keys()];
  const gaps = dates.slice(1).map((d, i) => spanDays(dates[i], d) - 1).sort((a, b) => a - b);
  if (gaps.length && gaps[Math.floor(gaps.length / 2)] >= 5) return { weeks: [], last4: null, prev4: null, change4: null, wow: null, total, granularity: gaps[Math.floor(gaps.length / 2)] >= 25 ? 'monthly' : 'weekly' };
  const first = rows[0].date;
  const last = rows[rows.length - 1].date;
  const weeks = [];
  for (let end = last; addDays(end, -6) >= first; end = addDays(end, -7)) {
    const start = addDays(end, -6);
    let total = 0;
    let days = 0;
    for (const d of listDays(start, end)) {
      if (!byDate.has(d)) continue;
      total += byDate.get(d);
      days++;
    }
    weeks.unshift({ start, end, total, days });
  }
  const n = weeks.length;
  const sum = (ws) => ws.reduce((s, w) => s + w.total, 0);
  const last4 = n >= 4 ? sum(weeks.slice(-4)) : null;
  const prev4 = n >= 8 ? sum(weeks.slice(-8, -4)) : null;
  const wow = n >= 2 && weeks[n - 2].total ? weeks[n - 1].total / weeks[n - 2].total - 1 : null;
  return { weeks, last4, prev4, change4: last4 !== null && prev4 ? last4 / prev4 - 1 : null, wow, total, granularity: 'daily' };
}

// ---------- workspace data ----------
const urlKey = (u, origin) => {
  const n = normalizeUrl(String(u || '').trim(), { base: origin, stripTracking: true });
  return n ? n.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '').toLowerCase() : String(u || '').trim().toLowerCase();
};

/** keyword-map.csv: target_url -> keywords, plus the keyword list (for topic matching). */
export function loadKeywordMap(ws) {
  const file = ws.path('keyword-map.csv');
  const byUrl = new Map();
  const keywords = [];
  if (!fs.existsSync(file)) return { byUrl, keywords, exists: false };
  let origin = '';
  try {
    origin = ws.origin();
  } catch {
    /* no site.url */
  }
  for (const r of readCsvFile(file, { required: false }).records) {
    const kw = String(r.keyword || '').trim();
    if (!kw) continue;
    keywords.push({ keyword: kw, target: String(r.target_url || '').trim(), cluster: r.cluster || '' });
    if (r.target_url) {
      const k = urlKey(r.target_url, origin);
      if (!byUrl.has(k)) byUrl.set(k, []);
      byUrl.get(k).push(kw);
    }
  }
  return { byUrl, keywords, exists: true, origin };
}

/** Best keyword-map entry for a topic (token Jaccard >= 0.34 or containment). */
export function matchKeyword(texts, keywords) {
  const tt = new Set(texts.flatMap((t) => topicTokens(t)));
  const keys = texts.map(compactKey);
  let best = null;
  for (const k of keywords) {
    const kt = new Set(topicTokens(k.keyword));
    const kk = compactKey(k.keyword);
    let score = kt.size && tt.size ? jaccard(kt, tt) : 0;
    if (kk.length >= 2 && keys.some((q) => q.includes(kk) || (q.length >= 3 && kk.includes(q)))) score = Math.max(score, 0.75);
    if (score >= 0.34 && (!best || score > best.score)) best = { ...k, score };
  }
  return best;
}

/** Topics Portfolio rows where others are cited and you are not (opportunity tables: every row). */
export function portfolioTodo(rows) {
  const todo = [];
  for (const r of rows) {
    const yoursRaw = r.yours === undefined ? null : String(r.yours).trim().toLowerCase();
    const yoursZero = yoursRaw !== null && (yoursRaw === '' || yoursRaw === '-' || /^(0|0\.0+%?|0%|no|n|false|not cited|none|否|無|无|なし|없음)$/.test(yoursRaw));
    const othersCited = (r.sitesCited ?? 0) > 0 || (r.topicSize ?? 0) > 0 || (r.citations ?? 0) > 0;
    if (r.opportunity) todo.push({ ...r, reason: 'opportunity query (others are cited, you are not)' });
    else if (yoursRaw !== null && yoursZero && othersCited) todo.push({ ...r, reason: 'others are cited for this topic, you are not' });
    else if (yoursRaw === null && r.citationShare === 0 && othersCited) todo.push({ ...r, reason: 'your citation share is 0' });
  }
  return todo;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function indexFile(ws, source) {
  return ws.path('data', SOURCES[source].dir, 'imports.json');
}

function loadIndex(ws, source) {
  const f = indexFile(ws, source);
  const data = fs.existsSync(f) ? readJson(f, { version: 1, imports: [] }) : { version: 1, imports: [] };
  if (!Array.isArray(data.imports)) data.imports = [];
  return data;
}

const safeLabel = (s) => String(s || '').normalize('NFKC').trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function expandInputs(list) {
  const files = [];
  for (const p of list) {
    const abs = path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
    if (!fs.existsSync(abs)) throw new UserError(`File not found: ${abs}`);
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) {
        const full = path.join(abs, f);
        if (fs.statSync(full).isFile() && /\.(csv|tsv|zip|txt|xlsx|xls)$/i.test(f) && !f.startsWith('.')) files.push(full);
      }
    } else files.push(abs);
  }
  return files;
}

// ---------- import ----------
/** Parse, classify and group files; returns {groups, skipped, warnings}. Groups = one import each (a zip, or loose CSVs of one source/variant/export). */
export function prepareImports(ws, inputs, flags) {
  const warnings = [];
  const skipped = [];
  const loose = new Map();
  const groups = [];
  const indexes = { gsc: loadIndex(ws, 'gsc'), bing: loadIndex(ws, 'bing') };
  for (const input of inputs) {
    try {
      prepareOne(input);
    } catch (e) {
      // a stray file in an inbox must not block the others; files passed explicitly fail loudly
      if (!input.inbox || !(e instanceof UserError)) throw e;
      warnings.push(`${path.basename(input.file)} (inbox) skipped: ${e.message}${e.hint ? ` (${[].concat(e.hint)[0]})` : ''}`);
    }
  }
  function prepareOne(input) {
    const sha = sha256(input.file);
    const tables = readTables(input.file);
    const classified = tables.map((t) => ({ table: t, cls: classifyTable(t, { sourceHint: input.source, fileName: path.basename(input.file) }) }));
    const usable = classified.filter((c) => c.cls.source && SOURCES[c.cls.source] && SOURCES[c.cls.source].kinds.includes(c.cls.kind));
    for (const c of classified) {
      if (c.cls.kind === 'performance') warnings.push(`${path.basename(input.file)}${tables.length > 1 ? `/${c.table.name}` : ''}: looks like a regular Performance export (clicks/position columns), not the Generative AI report - skipped. Use gsc-export.mjs for Performance data.`);
    }
    if (!usable.length) {
      const filters = classified.filter((c) => c.cls.kind === 'filters');
      if (filters.length === classified.length) {
        warnings.push(`${path.basename(input.file)}: only a Filters table; skipped.`);
        return;
      }
      if (classified.every((c) => c.cls.kind === 'performance' || c.cls.kind === 'filters')) {
        throw new UserError(`${path.basename(input.file)} is a regular Search Console Performance export (it has clicks/CTR/position), not the Generative AI report`, {
          hint: ['Generative AI report: Search Console -> Performance -> Generative AI (impressions only) -> Export -> Download CSV.', 'Regular Performance data: use gsc-export.mjs, or pass the file to gsc-compare.mjs / gsc-opportunities.mjs --input.'],
        });
      }
      throw new UserError(`${path.basename(input.file)}: not a recognized ${input.source ? SOURCES[input.source].label : 'Search Console Generative AI or Bing AI Performance'} export`, {
        hint: [
          `Headers found: ${classified.map((c) => `${c.table.name}: ${c.cls.headers.join(', ') || '(none)'}`).join(' | ')}`,
          'Supported: Search Console Generative AI (Search or Discover) tables Dates/Chart, Pages, Countries, Devices (impressions only); Bing AI Performance citations over time, cited pages, grounding queries, intents, topics, citation share, Topics Portfolio.',
          'If the headers are in another language, pass --gsc <file> or --bing <file> and open an issue with the header names.',
        ],
      });
    }
    const source = usable[0].cls.source;
    const mixed = usable.filter((c) => c.cls.source !== source);
    for (const c of mixed) warnings.push(`${path.basename(input.file)}/${c.table.name}: looks like a ${SOURCES[c.cls.source].label} table inside a ${SOURCES[source].label} export; skipped (import it separately).`);
    if (mixed.length) usable.splice(0, usable.length, ...usable.filter((c) => c.cls.source === source));
    const prev = indexes[source].imports.find((i) => i.sha256 === sha);
    if (prev && !flags.force) {
      skipped.push({ file: input.file, sha256: sha, label: prev.label, importedAt: prev.importedAt });
      return;
    }
    const filterRows = classified.filter((c) => c.cls.kind === 'filters').flatMap((c) => c.table.rows.slice(1).map((r) => r.join(': ')));
    let variant = '';
    if (source === 'gsc') variant = flags.variant || (/discover|探索/i.test(path.basename(input.file)) || filterRows.some((r) => /discover|探索|発見/i.test(r)) ? 'discover' : 'search');
    const exportStamp = (/_(\d{1,2})_(\d{1,2})_(\d{4})\.[a-z]+$/i.exec(path.basename(input.file)) || []).slice(1).join('-');
    const entry = { file: input.file, sha256: sha, tables: usable, filters: filterRows, unknown: classified.filter((c) => c.cls.kind === 'unknown').map((c) => `${c.table.name} (${c.cls.headers.join(', ')})`) };
    for (const u of entry.unknown) warnings.push(`${path.basename(input.file)}: table not recognized, kept out: ${u}`);
    if (/\.zip$/i.test(input.file) || usable.length > 1) groups.push({ source, variant, files: [entry] });
    else {
      const key = `${source}|${variant}|${exportStamp}`;
      if (!loose.has(key)) loose.set(key, { source, variant, files: [] });
      loose.get(key).files.push(entry);
    }
  }
  groups.push(...loose.values());
  for (const g of groups) {
    const kinds = g.files.flatMap((f) => f.tables.map((t) => t.cls.kind));
    const dupKinds = kinds.filter((k, i) => kinds.indexOf(k) !== i);
    if (dupKinds.length) throw new UserError(`Two "${dupKinds[0]}" tables in one ${SOURCES[g.source].label} import (${g.files.map((f) => path.basename(f.file)).join(', ')})`, { hint: 'Import each export separately (one run per period), or pass the files of one export only.' });
  }
  return { groups, skipped, warnings };
}

export function runImport(ws, group, flags, warnings) {
  const importedAt = new Date().toISOString();
  const normalized = [];
  for (const f of group.files) {
    for (const t of f.tables) {
      const res = normalizeTable(t.table, t.cls, { ws });
      if (res.badDateCount) warnings.push(`${path.basename(f.file)}/${t.table.name}: ${res.badDateCount} row(s) with unreadable dates skipped (e.g. "${res.badDates[0]}")`);
      if (t.cls.dup.length) warnings.push(`${path.basename(f.file)}/${t.table.name}: several ${t.cls.dup.join('/')} columns (comparison export?); used the first. Export one period at a time.`);
      normalized.push({ file: f, cls: t.cls, table: t.table, rows: res.rows, dateOrder: res.dateOrder });
    }
  }
  const dated = normalized.find((n) => n.cls.kind === 'dates' || n.cls.kind === 'trend');
  const range = dated ? dateRangeOf(dated.rows) : null;
  let label = safeLabel(flags.label) || (range ? `${range.start}_${range.end}` : '');
  if (!label) {
    const stamp = (/_(\d{1,2})_(\d{1,2})_(\d{4})\.[a-z]+$/i.exec(path.basename(group.files[0].file)) || []);
    label = stamp.length ? `export-${stamp[3]}-${stamp[1].padStart(2, '0')}-${stamp[2].padStart(2, '0')}` : `import-${group.files[0].sha256.slice(0, 8)}`;
    warnings.push(`${SOURCES[group.source].label}: no date table in this import, so its period is unknown (label "${label}"). Import the chart/trend export together, or pass --label with the period; --compare needs it.`);
  }
  if (group.variant === 'discover' && !/discover/i.test(label)) label = `${label}-discover`;
  const outputs = [];
  const tables = {};
  for (const n of normalized) {
    const meta = {
      source: group.source === 'gsc' ? 'gsc-generative-ai' : 'bing-ai-performance',
      sourceLabel: SOURCES[group.source].label,
      variant: group.variant || undefined,
      kind: n.cls.kind,
      label,
      file: path.basename(n.file.file),
      table: n.table.name,
      sha256: n.file.sha256,
      rows: n.rows.length,
      dateRange: n.cls.kind === 'dates' || n.cls.kind === 'trend' ? dateRangeOf(n.rows) : range,
      dateRangeFrom: n.cls.kind === 'dates' || n.cls.kind === 'trend' ? 'this table' : range ? 'the date table of the same import' : 'unknown',
      headers: n.cls.headers,
      filters: n.file.filters.length ? n.file.filters : undefined,
      importedAt,
    };
    const base = ws.dataFile(SOURCES[group.source].dir, `${label}-${n.cls.kind}`, 'json');
    writeJson(base, { meta, rows: n.rows });
    const csvRows = n.rows.map((r) => {
      const { extra, ...rest } = r;
      return { ...rest, ...(extra || {}) };
    });
    const csvFile = base.replace(/\.json$/, '.csv');
    writeCsvFile(csvFile, csvRows);
    outputs.push(base, csvFile);
    tables[n.cls.kind] = { meta, rows: n.rows, file: base };
  }
  const index = loadIndex(ws, group.source);
  for (const f of group.files) {
    index.imports = index.imports.filter((i) => i.sha256 !== f.sha256);
    index.imports.push({ sha256: f.sha256, file: path.basename(f.file), source: group.source, variant: group.variant || undefined, label, kinds: f.tables.map((t) => t.cls.kind), dateRange: range, importedAt, outputs: outputs.map((o) => path.basename(o)) });
  }
  writeJson(indexFile(ws, group.source), index);
  return { source: group.source, variant: group.variant, label, range, files: group.files.map((f) => f.file), tables, outputs };
}

/** Stored tables of an import by label (newest file of each kind). */
export function loadImport(ws, source, label) {
  const dir = ws.path('data', SOURCES[source].dir);
  if (!fs.existsSync(dir)) return null;
  // only the tables written by the newest import of this label (a re-import with fewer tables must not mix in old ones)
  const entries = loadIndex(ws, source).imports.filter((i) => i.label === label);
  const newest = entries.map((i) => String(i.importedAt || '')).sort().pop();
  const allowed = entries.length ? new Set(entries.filter((i) => String(i.importedAt || '') === newest).flatMap((i) => i.outputs || [])) : null;
  const tables = {};
  for (const kind of SOURCES[source].kinds) {
    const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${kind}\\.json$`);
    const f = fs.readdirSync(dir).filter((x) => re.test(x) && (!allowed || allowed.has(x))).sort().pop();
    if (f) {
      const data = readJson(path.join(dir, f));
      tables[kind] = { meta: data.meta || {}, rows: data.rows || [], file: path.join(dir, f) };
    }
  }
  if (!Object.keys(tables).length) return null;
  const any = Object.values(tables)[0].meta;
  const range = (tables.dates || tables.trend || {}).meta ? (tables.dates || tables.trend).meta.dateRange : any.dateRange || null;
  return { source, variant: any.variant || '', label, range, tables };
}

/** Latest import per source/variant from the index (used when nothing new was imported). */
function latestImports(ws) {
  const res = [];
  for (const source of Object.keys(SOURCES)) {
    const idx = loadIndex(ws, source);
    const seen = new Set();
    for (const imp of [...idx.imports].sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)))) {
      const key = `${source}|${imp.variant || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const loaded = loadImport(ws, source, imp.label);
      if (loaded) res.push(loaded);
    }
  }
  return res;
}

// ---------- analysis ----------
function analyzeGsc(ws, imp, { kmap, gscPages, top, warnings }) {
  const t = imp.tables;
  const res = { source: 'gsc', variant: imp.variant || 'search', label: imp.label, range: imp.range };
  if (t.dates) {
    res.trend = weeklyTrend(t.dates.rows, 'impressions');
    res.chartTotal = res.trend.total;
  }
  if (t.pages) {
    const origin = kmap.origin;
    const total = t.pages.rows.reduce((s, r) => s + (r.impressions || 0), 0);
    res.tableTotal = total;
    let gscTotals = null;
    if (gscPages) {
      gscTotals = new Map();
      for (const r of gscPages.rows) {
        if (!r.page) continue;
        const k = urlKey(r.page, origin);
        gscTotals.set(k, (gscTotals.get(k) || 0) + (r.impressions || 0));
      }
    }
    res.pages = t.pages.rows
      .map((r) => {
        const k = urlKey(r.page, origin);
        const all = gscTotals ? gscTotals.get(k) : undefined;
        return { page: r.page, impressions: r.impressions || 0, group: r.group || ws.pageGroupOf(r.page), keywords: kmap.byUrl.get(k) || [], totalImpressions: all ?? null, aiShare: all ? (r.impressions || 0) / all : null };
      })
      .sort((a, b) => b.impressions - a.impressions);
    const groups = new Map();
    for (const p of res.pages) groups.set(p.group, (groups.get(p.group) || 0) + p.impressions);
    res.groups = [...groups].map(([group, impressions]) => ({ group, impressions, share: total ? impressions / total : 0 })).sort((a, b) => b.impressions - a.impressions);
    if (gscPages) {
      const over = res.pages.filter((p) => p.aiShare !== null && p.aiShare > 1);
      if (over.length) warnings.push(`${over.length} page(s) have more AI impressions than total impressions in --gsc-pages: the two exports cover different periods, properties or search types; AI share is not meaningful for them.`);
      const gm = gscPages.meta || {};
      if (imp.range && gm.startDate && gm.endDate && (gm.startDate !== imp.range.start || gm.endDate !== imp.range.end)) warnings.push(`--gsc-pages covers ${gm.startDate} -> ${gm.endDate} but the AI export covers ${imp.range.start} -> ${imp.range.end}: shares are only indicative.`);
      res.unmatchedPages = res.pages.filter((p) => p.totalImpressions === null).length;
    }
  }
  if (t.countries) res.countries = t.countries.rows.map((r) => ({ country: r.country, impressions: r.impressions || 0 })).sort((a, b) => b.impressions - a.impressions).slice(0, top);
  if (t.devices) res.devices = t.devices.rows.map((r) => ({ device: r.device, impressions: r.impressions || 0 })).sort((a, b) => b.impressions - a.impressions);
  if (imp.range) {
    const scopes = res.variant === 'discover' ? ['discover'] : ['genai-search'];
    const hits = overlapEvents(loadEvents(ws), [{ name: 'the export period', start: imp.range.start, end: imp.range.end }], { scopes });
    res.events = hits.map(describeOverlap);
  }
  return res;
}

function analyzeBing(ws, imp, { kmap, top, similarity = 0.4 }) {
  const t = imp.tables;
  const res = { source: 'bing', label: imp.label, range: imp.range };
  if (t.trend) {
    if (t.trend.rows.some((r) => Number.isFinite(r.citations))) res.trend = weeklyTrend(t.trend.rows, 'citations');
    if (t.trend.rows.some((r) => Number.isFinite(r.citedPages))) {
      const cp = t.trend.rows.filter((r) => Number.isFinite(r.citedPages));
      res.avgCitedPages = cp.reduce((s, r) => s + r.citedPages, 0) / cp.length;
    }
  }
  if (t.pages) {
    const total = t.pages.rows.reduce((s, r) => s + (r.citations || 0), 0);
    res.pagesTotal = total;
    res.pages = t.pages.rows.map((r) => ({ page: r.page, citations: r.citations || 0, group: r.group || ws.pageGroupOf(r.page), keywords: kmap.byUrl.get(urlKey(r.page, kmap.origin)) || [] })).sort((a, b) => b.citations - a.citations);
    const groups = new Map();
    for (const p of res.pages) groups.set(p.group, (groups.get(p.group) || 0) + p.citations);
    res.groups = [...groups].map(([group, citations]) => ({ group, citations, share: total ? citations / total : 0 })).sort((a, b) => b.citations - a.citations);
  }
  if (t.grounding) {
    const rows = t.grounding.rows.filter((r) => r.query);
    const clustered = clusterQueries(rows.map((r) => ({ query: r.query, page: r.page || '', clicks: 0, impressions: Math.max(1, r.citations || 0), position: 0 })), { brandTerms: ws.brandTerms(), similarity, minImpressions: 1 });
    res.groundingQueries = rows.length;
    res.topics = clustered.clusters.slice(0, 200).map((c) => {
      const m = kmap.keywords.length ? matchKeyword([c.label, ...c.topQueries], kmap.keywords) : null;
      return { topic: c.label, queries: c.queries, citations: c.impressions, examples: c.topQueries.slice(0, 4), brand: c.brand, keyword: m ? m.keyword : '', target: m ? m.target : '', matchScore: m ? m.score : null };
    });
    res.gaps = res.topics.filter((x) => !x.keyword && !x.brand);
    res.byIntent = summarizeField(rows, 'intent');
    res.byTopicColumn = summarizeField(rows, 'topic');
    if (rows.some((r) => r.citationShare !== undefined && r.citationShare !== null)) res.lowShare = rows.filter((r) => r.citationShare !== null && r.citationShare !== undefined && r.citationShare < 0.1 && (r.citations || 0) > 0).sort((a, b) => (b.citations || 0) - (a.citations || 0)).slice(0, top);
  }
  if (t.intents) res.intents = t.intents.rows.slice().sort((a, b) => (b.citations || 0) - (a.citations || 0));
  if (t.topics) res.topicsTable = t.topics.rows.slice().sort((a, b) => (b.citations || 0) - (a.citations || 0));
  if (t['citation-share']) res.citationShare = t['citation-share'].rows;
  if (t.portfolio) {
    res.portfolioRows = t.portfolio.rows.length;
    res.portfolioTodo = portfolioTodo(t.portfolio.rows).map((r) => {
      const m = kmap.keywords.length ? matchKeyword([r.topic || r.query || ''].filter(Boolean), kmap.keywords) : null;
      return { ...r, keyword: m ? m.keyword : '', target: m ? m.target : '' };
    });
    res.portfolioHasYours = t.portfolio.rows.some((r) => r.yours !== undefined || r.opportunity || r.citationShare !== undefined);
  }
  return res;
}

function summarizeField(rows, field) {
  if (!rows.some((r) => r[field])) return null;
  const map = new Map();
  for (const r of rows) {
    const k = r[field] || '(none)';
    const e = map.get(k) || { [field]: k, queries: 0, citations: 0 };
    e.queries++;
    e.citations += r.citations || 0;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.citations - a.citations || b.queries - a.queries);
}

/** Compare two imports of the same source; refuses periods of different length. */
export function compareImports(a, b) {
  if (!a.range || !b.range) throw new UserError(`Cannot compare "${a.label}" and "${b.label}": the period of ${!a.range ? a.label : b.label} is unknown (no date table)`, { hint: 'Import the chart/trend export with the tables so the period is known.' });
  if (a.range.days !== b.range.days) throw new UserError(`Refusing to compare "${a.label}" (${a.range.days} days) with "${b.label}" (${b.range.days} days): periods must have equal length`, { hint: 'Export both periods with the same length (e.g. 28 days each); totals over unequal windows are not comparable.' });
  const metric = a.source === 'gsc' ? 'impressions' : 'citations';
  const sumRows = (rows) => rows.reduce((s, r) => s + (r[metric] || 0), 0);
  const res = { source: a.source, metric, a: { label: a.label, range: a.range }, b: { label: b.label, range: b.range }, tables: {} };
  const keyed = { pages: 'page', countries: 'country', devices: 'device', grounding: 'query', intents: 'intent', topics: 'topic' };
  for (const kind of SOURCES[a.source].kinds) {
    const ta = a.tables[kind];
    const tb = b.tables[kind];
    if (!ta || !tb) continue;
    const entry = { totalA: sumRows(ta.rows), totalB: sumRows(tb.rows) };
    entry.change = entry.totalA ? entry.totalB / entry.totalA - 1 : null;
    const key = keyed[kind];
    if (key) {
      const ma = new Map();
      const mb = new Map();
      for (const r of ta.rows) ma.set(r[key], (ma.get(r[key]) || 0) + (r[metric] || 0));
      for (const r of tb.rows) mb.set(r[key], (mb.get(r[key]) || 0) + (r[metric] || 0));
      entry.movers = [...new Set([...ma.keys(), ...mb.keys()])].map((k) => ({ key: k, a: ma.get(k) || 0, b: mb.get(k) || 0, delta: (mb.get(k) || 0) - (ma.get(k) || 0) })).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    }
    res.tables[kind] = entry;
  }
  return res;
}

// ---------- report ----------
const CAVEATS = [
  'Evidence level: AI impressions (Google) and citations (Bing) - not clicks, traffic or revenue. Report them as the exposure layer; clicks and conversions come from GSC/GA4 separately.',
  'Google: AI impressions are already counted inside the regular Performance report totals - never add them; compare only as a share of the same page\'s total.',
  'Google: the chart is aggregated by property and the Pages table by page, so their totals differ; tables are truncated to 1,000 rows and low-volume rows are omitted.',
  'The newest days are provisional (dotted line in Search Console; Bing refreshes daily with a delay): judge whole weeks and re-export later for final numbers.',
  'Bing grounding queries and citations are sampled; a citation is not a click. Totals differ between Bing views.',
  'Compare only equal-length periods exported the same way (same filters, same variant).',
];

function trendTable(trend, unit) {
  if (trend && (trend.granularity === 'weekly' || trend.granularity === 'monthly')) return `_The export has ${trend.granularity} rows (total ${fmtInt(trend.total)}); export with daily dates for the weekly trend._\n`;
  if (!trend || !trend.weeks.length) return `_No daily data (or less than one full week)._\n`;
  const weeks = trend.weeks.slice(-8);
  let md = mdTable([{ label: 'Week', value: (w) => `${w.start} -> ${w.end}${w.days < 7 ? ` (${w.days} days)` : ''}` }, { label: unit, align: 'right', value: (w) => fmtInt(w.total) }], weeks);
  md += `\nLast 4 weeks ${trend.last4 === null ? '-' : fmtInt(trend.last4)} vs the 4 before ${trend.prev4 === null ? '- (needs 8 weeks)' : fmtInt(trend.prev4)}${trend.change4 !== null ? ` (${fmtSignedPct(trend.change4)})` : ''}; last week vs previous: ${trend.wow === null ? '-' : fmtSignedPct(trend.wow)}.\n`;
  return md;
}

function renderReport(ws, { imported, skipped, analyses, comparisons, warnings, todoFile, top }) {
  const origin = (() => {
    try {
      return ws.origin();
    } catch {
      return '';
    }
  })();
  const L = [`# AI visibility reports - ${ws.today()}`, '', '_Evidence level: AI impressions/citations, not clicks or revenue._', ''];
  L.push('## Imports', '');
  if (imported.length) L.push(mdTable([{ label: 'Source', value: (i) => SOURCES[i.source].label + (i.variant ? ` (${i.variant})` : '') }, { label: 'Label', key: 'label' }, { label: 'Period', value: (i) => (i.range ? `${i.range.start} -> ${i.range.end} (${i.range.days} days)` : 'unknown') }, { label: 'Tables', value: (i) => Object.keys(i.tables).join(', ') }, { label: 'Files', value: (i) => i.files.map((f) => path.basename(f)).join(', ') }], imported));
  else L.push('_Nothing new imported; the analysis uses the latest stored import of each source._', '');
  if (skipped.length) L.push(`Skipped (already imported, same SHA-256; --force to re-import): ${skipped.map((s) => `${path.basename(s.file)} -> ${s.label}`).join('; ')}`, '');
  for (const a of analyses) {
    if (a.source === 'gsc') {
      L.push(`## Google Search Console - Generative AI (${a.variant}) - ${a.label}`, '');
      if (a.range) L.push(`Period: ${a.range.start} -> ${a.range.end} (${a.range.days} days, Pacific Time days).`, '');
      if (a.chartTotal !== undefined || a.tableTotal !== undefined) L.push(`Impressions: chart (property-level) ${a.chartTotal === undefined ? '-' : fmtInt(a.chartTotal)}; pages table (page-level) ${a.tableTotal === undefined ? '-' : fmtInt(a.tableTotal)}. The two totals differ by design.`, '');
      if (a.trend) L.push('### Weekly AI impressions', '', trendTable(a.trend, 'AI impressions'));
      if (a.pages) {
        L.push('### Pages', '', mdTable([{ label: 'Page', value: (p) => shortUrl(p.page, origin) }, { label: 'Group', key: 'group' }, { label: 'AI impressions', align: 'right', value: (p) => fmtInt(p.impressions) }, { label: 'AI share of page total', align: 'right', value: (p) => (p.aiShare === null ? '-' : fmtPct(p.aiShare, 1)) }, { label: 'keyword-map targets', value: (p) => p.keywords.slice(0, 3).join('; ') }], a.pages.slice(0, top)));
        if (a.pages[0] && a.pages[0].aiShare === null) L.push('_AI share needs --gsc-pages <gsc page export for the same period>; it is a ratio only (AI impressions are inside the total)._', '');
        L.push('### Page groups', '', mdTable([{ label: 'Group', key: 'group' }, { label: 'AI impressions', align: 'right', value: (g) => fmtInt(g.impressions) }, { label: 'Share', align: 'right', value: (g) => fmtPct(g.share, 1) }], a.groups));
      }
      if (a.countries) L.push('### Countries', '', mdTable([{ label: 'Country', key: 'country' }, { label: 'AI impressions', align: 'right', value: (c) => fmtInt(c.impressions) }], a.countries));
      if (a.devices) L.push('### Devices', '', mdTable([{ label: 'Device', key: 'device' }, { label: 'AI impressions', align: 'right', value: (c) => fmtInt(c.impressions) }], a.devices));
      if (a.events && a.events.length) L.push('### Search Console data anomalies in this period', '', ...a.events.map((e) => `- ${e}`), '');
    } else {
      L.push(`## Bing Webmaster Tools - AI Performance - ${a.label}`, '');
      if (a.range) L.push(`Period: ${a.range.start} -> ${a.range.end} (${a.range.days} days).`, '');
      if (a.trend) L.push('### Weekly citations', '', trendTable(a.trend, 'Citations'));
      if (a.avgCitedPages !== undefined) L.push(`Average cited pages per day: ${a.avgCitedPages.toFixed(1)}.`, '');
      if (a.pages) {
        L.push('### Cited pages', '', mdTable([{ label: 'Page', value: (p) => shortUrl(p.page, origin) }, { label: 'Group', key: 'group' }, { label: 'Citations', align: 'right', value: (p) => fmtInt(p.citations) }, { label: 'keyword-map targets', value: (p) => p.keywords.slice(0, 3).join('; ') }], a.pages.slice(0, top)));
        L.push('### Page groups', '', mdTable([{ label: 'Group', key: 'group' }, { label: 'Citations', align: 'right', value: (g) => fmtInt(g.citations) }, { label: 'Share', align: 'right', value: (g) => fmtPct(g.share, 1) }], a.groups));
      }
      if (a.topics) {
        L.push(`### Grounding queries grouped into topics (${a.groundingQueries} queries)`, '', mdTable([{ label: 'Topic', key: 'topic' }, { label: 'Queries', align: 'right', key: 'queries' }, { label: 'Citations', align: 'right', value: (x) => fmtInt(x.citations) }, { label: 'keyword-map', value: (x) => (x.keyword ? `${x.keyword}${x.target ? ` -> ${shortUrl(x.target, origin)}` : ''}` : x.brand ? '(brand)' : 'no entry') }, { label: 'Examples', value: (x) => x.examples.join('; ') }], a.topics.slice(0, top)));
        if (a.gaps.length) L.push(`${a.gaps.length} topic(s) AI engines search for have no keyword-map.csv entry: ${a.gaps.slice(0, 10).map((g) => `"${g.topic}"`).join(', ')}. Check whether a page answers them; add them to keyword-map.csv.`, '');
      }
      if (a.byIntent) L.push('### Grounding queries by intent', '', mdTable([{ label: 'Intent', key: 'intent' }, { label: 'Queries', align: 'right', key: 'queries' }, { label: 'Citations', align: 'right', value: (x) => fmtInt(x.citations) }], a.byIntent.slice(0, top)));
      if (a.lowShare && a.lowShare.length) L.push('### Grounding queries where your citation share is under 10%', '', mdTable([{ label: 'Query', key: 'query' }, { label: 'Citations', align: 'right', value: (x) => fmtInt(x.citations) }, { label: 'Citation share', align: 'right', value: (x) => fmtPct(x.citationShare, 1) }], a.lowShare));
      if (a.intents) L.push('### Intents', '', mdTable([{ label: 'Intent', key: 'intent' }, { label: 'Citations', align: 'right', value: (x) => fmtInt(x.citations) }, { label: 'Citation share', align: 'right', value: (x) => (x.citationShare === undefined || x.citationShare === null ? '-' : fmtPct(x.citationShare, 1)) }], a.intents.slice(0, top)));
      if (a.topicsTable) L.push('### Topics', '', mdTable([{ label: 'Topic', key: 'topic' }, { label: 'Citations', align: 'right', value: (x) => fmtInt(x.citations) }, { label: 'Citation share', align: 'right', value: (x) => (x.citationShare === undefined || x.citationShare === null ? '-' : fmtPct(x.citationShare, 1)) }], a.topicsTable.slice(0, top)));
      if (a.citationShare) L.push('### Citation share', '', mdTable([{ label: 'Item', key: 'label' }, { label: 'Date', value: (x) => x.date || '' }, { label: 'Citation share', align: 'right', value: (x) => (x.citationShare === null ? '-' : fmtPct(x.citationShare, 1)) }], a.citationShare.slice(0, top)));
      if (a.portfolioRows !== undefined) {
        L.push('### Topics Portfolio', '');
        if (a.portfolioTodo.length) L.push(`${a.portfolioTodo.length} of ${a.portfolioRows} row(s) where others are cited and you are not (to-do list${todoFile ? `: ${todoFile}` : ''}):`, '', mdTable([{ label: 'Topic / query', value: (x) => x.topic || x.query }, { label: 'Topic size', align: 'right', value: (x) => (x.topicSize === undefined || x.topicSize === null ? '-' : fmtInt(x.topicSize)) }, { label: 'Sites cited', align: 'right', value: (x) => (x.sitesCited === undefined || x.sitesCited === null ? '-' : fmtInt(x.sitesCited)) }, { label: 'keyword-map', value: (x) => x.keyword || 'no entry' }], a.portfolioTodo.slice(0, top)));
        else if (!a.portfolioHasYours) L.push('_The portfolio export has no column showing your own citations, so no to-do list was made. Open the topic details (Your Grounding Queries / Opportunity Queries) and export those too._', '');
        else L.push('_No portfolio row where others are cited and you are not._', '');
      }
    }
  }
  for (const c of comparisons) {
    L.push(`## Compare ${c.a.label} -> ${c.b.label} (${SOURCES[c.source].label}, ${c.a.range.days} days each)`, '');
    for (const [kind, e] of Object.entries(c.tables)) {
      L.push(`### ${kind}: ${fmtInt(e.totalA)} -> ${fmtInt(e.totalB)} ${c.metric} (${e.change === null ? 'new' : fmtSignedPct(e.change)})`, '');
      if (e.movers) L.push(mdTable([{ label: 'Item', value: (m) => (kind === 'pages' ? shortUrl(m.key, origin) : m.key) }, { label: c.a.label, align: 'right', value: (m) => fmtInt(m.a) }, { label: c.b.label, align: 'right', value: (m) => fmtInt(m.b) }, { label: 'Change', align: 'right', value: (m) => (m.delta > 0 ? `+${fmtInt(m.delta)}` : fmtInt(m.delta)) }], e.movers.slice(0, top)));
    }
  }
  L.push('## Caveats', '', ...CAVEATS.map((c) => `- ${c}`), '');
  if (warnings.length) L.push('## Warnings', '', ...warnings.map((w) => `- ${w}`), '');
  L.push('## Next steps', '', '- Pages with AI impressions/citations: keep their facts current and make sure the cited page is the best answer for the intent (references/11 step 4).', '- Topics AI engines search for without a keyword-map entry or page: plan an answer page or strengthen the closest page; do not create one page per phrasing.', '- Export both reports monthly on a fixed day, same period length, and run this script again; compare with --compare A:B.', '');
  return L.join('\n');
}

// ---------- main ----------
export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const top = Math.max(1, flags.top);
  const inputs = [
    ...expandInputs(positionals).map((file) => ({ file, source: '' })),
    ...expandInputs(flags.gsc).map((file) => ({ file, source: 'gsc' })),
    ...expandInputs(flags.bing).map((file) => ({ file, source: 'bing' })),
  ];
  const usedInboxes = !inputs.length && !flags.compare;
  if (usedInboxes) {
    for (const source of Object.keys(SOURCES)) {
      const inbox = ensureDir(ws.path('data', SOURCES[source].dir, 'inbox'));
      for (const file of expandInputs([inbox])) inputs.push({ file, source, inbox: true });
    }
  }
  const { groups, skipped, warnings } = prepareImports(ws, inputs, flags);
  if (flags.label && groups.length > 1) {
    const sources = new Set(groups.map((g) => `${g.source}|${g.variant}`));
    if (sources.size < groups.length) throw new UserError(`--label "${flags.label}" would be used for ${groups.length} separate exports of the same report`, { hint: 'Import one export per run when you set --label.' });
  }
  const imported = groups.map((g) => runImport(ws, g, flags, warnings));
  let gscPages = null;
  if (flags.gscPages) {
    gscPages = loadGscFile(ws.resolveFile(flags.gscPages));
    if (!gscPages.rows.some((r) => r.page)) throw new UserError(`--gsc-pages ${flags.gscPages} has no page column`, { hint: 'Export pages for the same period: node scripts/gsc-export.mjs --dimensions page --start <start> --end <end> --name page-ai-period' });
  }
  const kmap = loadKeywordMap(ws);
  const targets = imported.length ? imported.map((i) => loadImport(ws, i.source, i.label)).filter(Boolean) : latestImports(ws);
  const analyses = targets.map((imp) => (imp.source === 'gsc' ? analyzeGsc(ws, imp, { kmap, gscPages, top, warnings }) : analyzeBing(ws, imp, { kmap, top, similarity: flags.similarity })));
  const files = imported.flatMap((i) => i.outputs);
  let todoFile = '';
  const todo = analyses.filter((a) => a.source === 'bing' && a.portfolioTodo && a.portfolioTodo.length).flatMap((a) => a.portfolioTodo.map((r) => ({ label: a.label, topic: r.topic || '', query: r.query || '', topic_size: r.topicSize ?? '', sites_cited: r.sitesCited ?? '', your_citations: r.yours ?? '', citation_share: r.citationShare ?? '', volume: r.volume || '', reason: r.reason, keyword_map_match: r.keyword || '', target_url: r.target || '', action: r.keyword ? 'Strengthen the target page for this topic (answer capsule, facts, internal links)' : 'No keyword-map entry: decide whether a page should answer this topic; add it to keyword-map.csv' })));
  if (todo.length) {
    todoFile = writeCsvFile(ws.dataFile(SOURCES.bing.dir, 'portfolio-todo', 'csv'), todo);
    files.push(todoFile);
  }
  const comparisons = [];
  if (flags.compare) {
    const m = /^(.+?):(.+)$/.exec(String(flags.compare));
    if (!m) throw new UserError('--compare expects labelA:labelB');
    const [la, lb] = [safeLabel(m[1]), safeLabel(m[2])];
    for (const source of Object.keys(SOURCES)) {
      const a = loadImport(ws, source, la);
      const b = loadImport(ws, source, lb);
      if (a && b) comparisons.push(compareImports(a, b));
    }
    if (!comparisons.length) {
      const known = Object.keys(SOURCES).flatMap((s) => loadIndex(ws, s).imports.map((i) => `${s}:${i.label}`));
      throw new UserError(`No source has both imports "${la}" and "${lb}"`, { hint: `Known imports: ${[...new Set(known)].join(', ') || 'none yet'}` });
    }
  }
  if (!imported.length && !analyses.length && !comparisons.length) {
    if (skipped.length) {
      out(`Nothing new: ${skipped.length} file(s) already imported (use --force to re-import).`);
      return 0;
    }
    throw new UserError(usedInboxes ? 'No exports found in the inboxes' : 'Nothing to import', {
      hint: [
        `Search Console: Performance -> Generative AI -> Export -> Download CSV; put the zip in ${ws.path('data', SOURCES.gsc.dir, 'inbox')}`,
        `Bing Webmaster Tools: AI Performance -> Download (CSV); put the files in ${ws.path('data', SOURCES.bing.dir, 'inbox')}`,
        'Or pass files: node scripts/ai-reports-import.mjs <file> [--gsc file] [--bing file]',
      ],
    });
  }
  const reportFile = writeText(ws.path('logs', 'reviews', `${ws.today()}-ai-reports.md`), renderReport(ws, { imported, skipped, analyses, comparisons, warnings, todoFile, top }));
  files.push(reportFile);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ imported: imported.map((i) => ({ source: i.source, variant: i.variant, label: i.label, range: i.range, files: i.files, outputs: i.outputs })), skipped, analyses, comparisons, warnings, files }, null, 2)}\n`);
    return 0;
  }
  for (const i of imported) out(`imported ${SOURCES[i.source].label}${i.variant ? ` (${i.variant})` : ''} as "${i.label}"${i.range ? ` (${i.range.start} -> ${i.range.end})` : ''}: ${Object.entries(i.tables).map(([k, t]) => `${k} ${t.rows.length}`).join(', ')}`);
  for (const s of skipped) out(`skipped ${path.basename(s.file)}: already imported as "${s.label}" (--force to re-import)`);
  for (const a of analyses) {
    if (a.source === 'gsc') {
      const t = a.trend;
      out(`GSC generative AI (${a.variant}) ${a.label}: ${t ? `${fmtInt(t.total)} AI impressions; last 4 weeks ${t.last4 === null ? '-' : fmtInt(t.last4)} vs prior 4 ${t.prev4 === null ? '-' : fmtInt(t.prev4)}${t.change4 !== null ? ` (${fmtSignedPct(t.change4)})` : ''}` : 'no daily table'}${a.pages ? `; ${a.pages.length} page(s), top: ${a.pages.slice(0, 3).map((p) => shortUrl(p.page, kmap.origin)).join(', ')}` : ''}`);
      for (const e of a.events || []) out(`  note: ${e}`);
    } else {
      out(`Bing AI Performance ${a.label}: ${a.trend ? `${fmtInt(a.trend.total)} citations` : 'no trend table'}${a.pages ? `; ${a.pages.length} cited page(s)` : ''}${a.topics ? `; ${a.groundingQueries} grounding queries in ${a.topics.length} topic(s), ${a.gaps.length} without a keyword-map entry` : ''}${a.portfolioTodo ? `; portfolio to-do ${a.portfolioTodo.length}` : ''}`);
    }
  }
  for (const c of comparisons) for (const [kind, e] of Object.entries(c.tables)) out(`compare ${c.source} ${kind}: ${fmtInt(e.totalA)} -> ${fmtInt(e.totalB)} ${c.metric} (${e.change === null ? 'new' : fmtSignedPct(e.change)})`);
  for (const w of warnings) out(`warning: ${w}`);
  out('AI impressions/citations are exposure, not clicks or revenue; never add AI impressions to Performance totals.');
  out('');
  for (const f of files) out(`wrote ${f}`);
  return 0;
}

runMain(import.meta.url, main);
