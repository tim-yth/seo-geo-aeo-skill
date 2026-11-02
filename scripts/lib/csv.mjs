// RFC 4180-ish CSV parse/stringify (quotes, embedded newlines, BOM, CRLF).
import fs from 'node:fs';
import { UserError, writeText } from './util.mjs';

export function parseCsv(text) {
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
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
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
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export function csvToRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const rec = {};
    headers.forEach((h, i) => {
      rec[h] = r[i] === undefined ? '' : unFormulaSafe(r[i]);
    });
    return rec;
  });
  return { headers, records };
}

export function readCsvFile(file, { required = true } = {}) {
  if (!fs.existsSync(file)) {
    if (!required) return { headers: [], records: [] };
    throw new UserError(`CSV file not found: ${file}`);
  }
  return csvToRecords(fs.readFileSync(file, 'utf8'));
}

// Spreadsheet formula injection: crawled text (anchors, alt text, titles, queries) can start with "=", "+", "-" or "@".
// Such cells are written with a leading apostrophe (plain numbers like -2.5 or +15% are left alone) and the
// apostrophe is removed again when the CSV is read back with csvToRecords.
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER_LIKE = /^[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?%?$/i;

export function formulaSafe(text) {
  const s = String(text ?? '');
  return FORMULA_START.test(s) && !NUMBER_LIKE.test(s) ? `'${s}` : s;
}

export function unFormulaSafe(text) {
  const s = String(text ?? '');
  return s.startsWith("'") && FORMULA_START.test(s.slice(1)) && !NUMBER_LIKE.test(s.slice(1)) ? s.slice(1) : s;
}

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = Array.isArray(value) ? value.join(' | ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value === 'number' && !Number.isInteger(value)) s = String(Math.round(value * 1e6) / 1e6);
  else if (typeof value !== 'number') s = formulaSafe(s);
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records, columns) {
  const cols = columns || [...new Set(records.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(cell).join(',')];
  for (const r of records) lines.push(cols.map((c) => cell(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}

export function writeCsvFile(file, records, columns) {
  const bom = process.env.SEO_AGENT_CSV_BOM === '1' ? '\uFEFF' : '';
  return writeText(file, bom + toCsv(records, columns));
}

/** Find a header among localized/alternative names (case/space-insensitive). */
export function findColumn(headers, candidates) {
  const norm = (h) => String(h || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
  const map = new Map(headers.map((h) => [norm(h), h]));
  for (const c of candidates) {
    const hit = map.get(norm(c));
    if (hit) return hit;
  }
  return '';
}
