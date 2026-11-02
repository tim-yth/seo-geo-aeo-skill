// Number formatting and Markdown table helpers for reports.
import { displayWidth } from './text.mjs';

export function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '-';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtSigned(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const s = digits ? n.toFixed(digits) : Math.round(n).toLocaleString('en-US');
  return n > 0 ? `+${s}` : s;
}

export function fmtSignedPct(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 'new';
  return `${ratio > 0 ? '+' : ''}${(ratio * 100).toFixed(digits)}%`;
}

/** CTR change in percentage points. */
export function fmtPp(diff, digits = 2) {
  if (diff === null || diff === undefined || !Number.isFinite(diff)) return '-';
  return `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(digits)}pp`;
}

export function fmtPos(p) {
  return p ? p.toFixed(1) : '-';
}

export function mdEscape(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** columns: [{ label, key | value(row), align: 'right'|'left' }] */
export function mdTable(columns, rows, { empty = 'No rows.' } = {}) {
  if (!rows.length) return `_${empty}_\n`;
  const head = `| ${columns.map((c) => mdEscape(c.label)).join(' | ')} |`;
  const sep = `|${columns.map((c) => (c.align === 'right' ? '---:' : '---')).join('|')}|`;
  const body = rows.map((r) => `| ${columns.map((c) => mdEscape(c.value ? c.value(r) : r[c.key])).join(' | ')} |`);
  return `${[head, sep, ...body].join('\n')}\n`;
}

export function shortUrl(url, origin) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (!origin || u.origin === origin) return decodeURI(u.pathname + u.search) || '/';
    return `${u.host}${decodeURI(u.pathname + u.search)}`;
  } catch {
    return url;
  }
}

/** Plain-text table for terminal output (CJK-width aware). */
export function textTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const pad = (c, w) => {
    const s = String(c ?? '');
    return s + ' '.repeat(Math.max(0, w - displayWidth(s)));
  };
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
