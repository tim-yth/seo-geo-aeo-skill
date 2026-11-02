#!/usr/bin/env node
// Pre-deploy SEO regression gate: compares two versions of a site (build dirs, live origins or a git ref) and blocks
// the deploy on the references/10 step 1b list (noindex, canonical, removed pages, FAQ, dates, hreflang, robots, sitemap).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, ensureDir, escapeRe, globToRegExp, rateLimiter, mapLimit, bareHost, sleep } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { fetchPage, parseRobotsTxt, robotsAllows, robotsDecision, parseSitemap, decodeBody, isHtml, DEFAULT_UA } from './lib/http.mjs';
import { csvToRecords, findColumn, readCsvFile, writeCsvFile } from './lib/csv.mjs';
import { mdTable, shortUrl, fmtPct } from './lib/format.mjs';
import { compactKey, shingleSet, jaccard, truncate } from './lib/text.mjs';
import { appendChangesLog } from './lib/experiments.mjs';
import { listFiles, fileToUrlPath, pathKey, normKey, strictKey, inferOrigin, extractFacts, guessDirOrigin, guessDirPrefix, HTML_FILE_RE, ERROR_PAGE_RE } from './lib/page-facts.mjs';

// ---------- rules ----------
export const BLOCK_RULES = {
  'new-noindex': 'noindex added to a previously indexable page',
  'canonical-retargeted': 'canonical now points to another page',
  'page-removed': 'page gone without a redirect, a normalization twin or a --retired record',
  'sitemap-dropped': 'URL dropped from the sitemap while the page still exists and is indexable',
  'sitemap-count-drop': 'sitemap URL count dropped by more than --sitemap-drop-pct (or the sitemap disappeared)',
  'protected-file-changed': 'a protected (human-edited) file changed (config protect.paths)',
  'protected-page-changed': 'the visible body text of a protected page changed (protect.urls, content-inventory protected=yes)',
  'jsonld-removed': 'all JSON-LD disappeared from a page',
  'jsonld-parse-error': 'a JSON-LD block no longer parses',
  'faq-not-visible': 'FAQPage contains a question that is not in the visible text (verbatim, normalized)',
  'faq-count-mismatch': 'new or rewritten page whose FAQPage question count differs from the visible FAQ',
  'date-regressed': 'dateModified or sitemap lastmod went backwards',
  'title-empty': 'title became empty',
  'hreflang-reciprocity': 'an hreflang pair is no longer reciprocal (or points to a page that is missing)',
  'robots-disallow-added': 'robots.txt now disallows a previously indexable page for * or Googlebot',
};
export const WARN_RULES = {
  'faq-count-off-by-one': 'existing template page whose FAQPage count differs from the visible FAQ by one (should_fix)',
  'title-changed': 'title changed substantially',
  'description-changed': 'meta description changed substantially or was removed',
  'h1-changed': 'H1 changed substantially or was removed',
  'title-suffix-added': 'many titles gained the same suffix at once',
  'inlinks-halved': 'internal inlinks to a page halved (protected, guardrail and home pages listed first)',
  'body-shrank': 'visible body text shrank by --body-shrink or more',
  'lastmod-without-content-change': 'sitemap lastmod changed but the content signature did not',
  'hreflang-changed': 'hreflang set changed',
  'title-ledger-new-contains-old': 'new titles that contain the old title (a re-run text replace would duplicate it)',
  'title-ledger-shared-old-title': 'old titles shared by several pages (a text replace would hit all of them)',
  'title-ledger-stale': 'old titles still present elsewhere in the after build',
  'url-case-changed': 'a URL changed only its letter case without a redirect (most hosts are case-sensitive)',
  'canonical-removed': 'canonical tag removed',
  'canonical-form-changed': 'self-canonical URL changed form (slash, .html, host)',
  'schema-type-removed': 'a JSON-LD type disappeared from a page',
  'date-modified-removed': 'dateModified removed',
  'date-published-changed': 'datePublished changed on an existing page',
  'redirect-target-missing': 'a redirect for a removed page points to a page that is not in the after build',
  'redirect-chain': 'a redirect for a removed page points to another redirect',
  'redirect-temporary': 'a removed indexable page uses a temporary (302/303/307) redirect',
  'redirect-catch-all': 'a removed page is covered only by a wildcard redirect to one fixed page',
  'rewrite-to-index': 'a page exists only as an explicit rewrite to index.html (edge worker / client routing): verify on a preview',
  'redirect-removed': 'a URL that redirected before no longer redirects (old links will 404)',
  'sitemap-entry-invalid': 'a new sitemap URL is not a 200 indexable self-canonical page (missing, redirect, noindex, other canonical, .html variant)',
  'fetch-failed': 'a live page could not be fetched (429/5xx/network error): not compared',
};
export const INFO_RULES = ['page-added', 'schema-type-added', 'url-normalized', 'redirected', 'rewritten', 'retired', 'noindex-removed', 'canonical-now-self', 'og-url-changed', 'lastmod-not-updated', 'faq-count-unknown', 'sitemap-added', 'sitemap-dropped-info', 'sitemap-truncated', 'preview-noindex-ignored', 'not-compared', 'title-ledger'];
const ALL_RULES = new Set([...Object.keys(BLOCK_RULES), ...Object.keys(WARN_RULES), ...INFO_RULES]);
const SEVERITY_ORDER = { block: 0, allowed: 1, warn: 2, info: 3 };
const MAX_SITEMAPS = 500;

const SPEC = {
  ...COMMON_FLAGS,
  before: { type: 'string', placeholder: 'dir|URL|git:ref:dir', desc: 'Old version: a build directory, a live origin, or git:<ref>:<dir> (exported with git archive)' },
  after: { type: 'string', placeholder: 'dir|URL', desc: 'New version: a build directory (e.g. dist) or a live origin (e.g. a preview deploy)' },
  'base-url': { type: 'string', placeholder: 'url', desc: 'Production URL of the build root for directory sides, with a path when the site lives under one (default: site.url, the canonicals, the live side)' },
  'clean-urls': { type: 'boolean', desc: 'The host serves a.html as /a (Cloudflare Pages, Netlify pretty URLs, Vercel cleanUrls)' },
  redirects: { type: 'list', placeholder: 'file', desc: 'Extra redirect rules: _redirects, vercel.json, netlify.toml or CSV from,to[,status] (the after build\'s own files are read automatically)' },
  retired: { type: 'string', placeholder: 'file', desc: 'URLs or paths retired on purpose in this batch (one per line, first word counts, # comments; or a CSV with a url column)' },
  allow: { type: 'list', placeholder: 'rule=reason', desc: 'Intentional change: downgrade that rule\'s BLOCK/WARN items to "allowed", with the reason in the report' },
  'record-allowed': { type: 'boolean', desc: 'Append the allowed changes and their reasons to logs/changes.md' },
  'fail-on': { type: 'string', choices: ['block', 'warn'], default: 'block', desc: 'Exit 2 when any BLOCK item (or any BLOCK/WARN item) is left' },
  'protect-path': { type: 'list', placeholder: 'glob', desc: 'Protected file glob relative to the build dir (added to config protect.paths)' },
  'protect-url': { type: 'list', placeholder: 'url', desc: 'Protected page URL or path (added to protect.urls and content-inventory rows with protected=yes)' },
  'protect-marker': { type: 'list', placeholder: 'text', desc: 'Before pages whose HTML contains this text (e.g. a "hand-edited, do not regenerate" comment) are protected' },
  'sitemap-drop-pct': { type: 'number', default: 10, desc: 'BLOCK when the sitemap URL count drops by more than this percentage (0-100)' },
  'suffix-share': { type: 'number', default: 0.2, desc: 'WARN when at least this share (0-1) of compared titles gained the same suffix' },
  'body-shrink': { type: 'number', default: 0.3, desc: 'WARN when the visible body text shrinks by at least this share (0-1)' },
  'max-pages': { type: 'int', default: 2000, desc: 'Live sides: maximum pages fetched per side' },
  concurrency: { type: 'int', default: 4, desc: 'Live sides: parallel requests' },
  delay: { type: 'int', placeholder: 'ms', default: 100, desc: 'Live sides: minimum gap between requests' },
  timeout: { type: 'int', placeholder: 'ms', default: 20000, desc: 'Live sides: per-request timeout' },
  'user-agent': { type: 'string', placeholder: 'ua', default: DEFAULT_UA, desc: 'Live sides: User-Agent header' },
  out: { type: 'string', placeholder: 'dir', desc: 'Output directory (default: workspace data/diff + logs/reviews; without a workspace ./seo-diff-out)' },
  name: { type: 'string', default: 'seo-diff', desc: 'Output name prefix' },
  json: { type: 'boolean', desc: 'Print the JSON report on stdout' },
};

const HELP = formatHelp({
  usage: ['node scripts/seo-diff.mjs --before <dir|URL|git:ref:dir> --after <dir|URL> [--retired file] [--allow rule=reason] [--fail-on block|warn]'],
  summary:
    'Pre-deploy SEO regression gate (references/10 step 1b). Compares page facts of two versions: status, noindex (meta and ' +
    'X-Robots-Tag, incl. _headers/vercel.json/netlify.toml), canonical, title, description, H1, hreflang, JSON-LD (parse errors, types, FAQ ' +
    'questions, dates), og:url, visible body text and the content signature (references/10 step 2), plus robots.txt, sitemaps, ' +
    'redirect files and internal links. BLOCK: ' + Object.keys(BLOCK_RULES).join(', ') + '. WARN: ' + Object.keys(WARN_RULES).join(', ') + '. ' +
    'A removed URL is never a removal when the same page still exists as /x <-> /x.html <-> /x/ <-> /x/index.html (normalization; a ' +
    'case-only change is normalized too but warns), when a redirect rule really covers it (not a 404 rule, not a catch-all to the home ' +
    'page or an SPA fallback, not a rule pointing at the same URL), or when it is listed in --retired. Problems that already exist in ' +
    '--before are reported as WARN (pre-existing) so the gate does not stay red forever. Writes data/diff/<today>-seo-diff.json, ' +
    '-changes.csv, -changed-urls.txt (feed to log-change --urls-file / gsc-compare --urls-file), -title-ledger.csv and ' +
    'logs/reviews/<today>-seo-diff.md.',
  spec: SPEC,
  examples: [
    'node scripts/seo-diff.mjs --before https://www.example.com --after dist --retired retired-this-batch.txt',
    'node scripts/seo-diff.mjs --before previous-build --after dist --clean-urls --allow "new-noindex=thin tag pages leave the index" --record-allowed',
    'node scripts/seo-diff.mjs --before git:origin/main:site --after site --fail-on warn',
    '# CI step (GitHub Actions): the job fails with exit code 2 when a BLOCK item is left',
    '#   - run: node scripts/seo-diff.mjs --before https://www.example.com --after dist --retired retired.txt --out seo-diff-report',
  ],
  notes: [
    'Exit codes: 0 = gate passed (findings may still be listed), 1 = error, 2 = gate tripped (--fail-on block|warn).',
    'Without a workspace it still runs: config defaults are used and files go to --out (default ./seo-diff-out). With a workspace it reads protect.paths, protect.urls, content-inventory.csv (protected=yes/true) and guardrails[].page.',
    'Directory sides map a/index.html -> /a/ and a.html -> /a.html (/a with --clean-urls); 404.html is skipped; <meta http-equiv=refresh> stubs count as redirects. A --base-url path (https://www.example.com/docs/) is the URL of the build root.',
    'Live sides are fetched politely (your own site only; redirects are followed only within the same site): the other side\'s paths plus the live sitemap, up to --max-pages. A preview host that sends X-Robots-Tag: noindex on every page (Cloudflare Pages, Vercel previews) has that header ignored (meta robots still counts).',
    '--before git:<ref>:<dir> runs `git archive <ref> <dir>` in the current repository and extracts it with tar into a temporary directory (needs git and tar).',
    'Intentional changes: --allow <rule>=<reason> (repeatable) marks that rule\'s items "allowed"; --record-allowed appends them to logs/changes.md. Then log the deploy: log-change.mjs add --urls-file <changed-urls.txt>.',
    'Visible FAQ count = items in the element whose class/id contains "faq" or after an "FAQ" heading until the next heading of that level or the end of its section (summary, dt, microdata, class*=question, else deeper headings). A count found only from headings warns instead of blocking; no recognisable FAQ block = info.',
  ],
});

// ---------- helpers ----------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const normWs = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const TEXT_FILE_RE = /\.(html?|xml|txt|json|md|webmanifest|rss|atom|csv)$/i;
const WILDCARD_RE = /[*:]/;
/** Site identity of a URL: host without www, with a non-default port (two origins on one host are two sites). */
const siteHost = (u) => {
  try {
    return bareHost(new URL(u).host);
  } catch {
    return bareHost(String(u || ''));
  }
};

/** Dice coefficient of character bigrams of the compact keys (1 = identical). */
export function similarity(a, b) {
  const x = compactKey(a);
  const y = compactKey(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) grams.set(x.slice(i, i + 2), (grams.get(x.slice(i, i + 2)) || 0) + 1);
  let hit = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) || 0;
    if (n > 0) {
      hit++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length - 1 + y.length - 1);
}

/** Suffix a title gained ("A" -> "A | Brand" gives "| Brand"), or ''. */
export function addedSuffix(before, after) {
  const b = normWs(before);
  const a = normWs(after);
  if (!b || !a || a === b) return '';
  if (a.startsWith(b)) return a.slice(b.length).trim();
  const m = /(\s*[|｜\-–—·•:：]\s*)([^|｜\-–—·•:：]+)$/.exec(a);
  if (!m) return '';
  const head = a.slice(0, m.index).trim();
  return head && !b.includes(m[2].trim()) && b.includes(head) ? `${m[1].trim()} ${m[2].trim()}` : '';
}

function compareDates(a, b) {
  const dateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s).trim());
  if (dateOnly(a) || dateOnly(b)) {
    const x = String(a).trim().slice(0, 10);
    const y = String(b).trim().slice(0, 10);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a) === String(b) ? 0 : NaN;
  return x === y ? 0 : x < y ? -1 : 1;
}

function firstDifference(a, b) {
  const x = normWs(a);
  const y = normWs(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  const from = Math.max(0, i - 30);
  return `"...${x.slice(from, i + 50)}..." -> "...${y.slice(from, i + 50)}..."`;
}

const countOf = (text, needle) => {
  if (!needle) return 0;
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n++;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
};
const htmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- redirect and header rules ----------
function compileNetlifyPattern(from) {
  const names = [];
  let body = '';
  for (const m of String(from).matchAll(/:([A-Za-z_][A-Za-z0-9_]*)|\*|[^:*]+|:/g)) {
    if (m[1]) {
      names.push(m[1]);
      body += '([^/]+)';
    } else if (m[0] === '*') {
      names.push('splat');
      body += '(.*)';
    } else body += escapeRe(m[0]);
  }
  body = body.replace(/\/$/, '');
  return { re: new RegExp(`^${body}/?$`), names };
}

function compileVercelPattern(source) {
  const names = [];
  let body = '';
  const s = String(source);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ':') {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)(\((?:[^()]|\([^()]*\))*\))?([*+?])?/.exec(s.slice(i));
      if (m) {
        names.push(m[1]);
        const inner = m[2] ? m[2].slice(1, -1) : '';
        const mod = m[3] || '';
        if (mod === '*' || mod === '?') {
          const slash = body.endsWith('/');
          if (slash) body = body.slice(0, -1);
          body += `(?:${slash ? '/' : ''}(${inner || (mod === '*' ? '.*' : '[^/]+')}))?`;
        } else body += `(${inner || (mod === '+' ? '.+' : '[^/]+')})`;
        i += m[0].length;
        continue;
      }
    }
    if (c === '(') {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      names.push(String(names.length + 1));
      body += `(${s.slice(i + 1, j).replace(/^\?:/, '')})`;
      i = j + 1;
      continue;
    }
    if (c === '*') {
      names.push('splat');
      body += '(.*)';
      i++;
      continue;
    }
    body += escapeRe(c);
    i++;
  }
  body = body.replace(/\/$/, '');
  return { re: new RegExp(`^${body}/?$`), names };
}

const ruleKind = (status) => (status === 200 ? 'rewrite' : status === 404 ? 'notfound' : status === 410 ? 'gone' : 'redirect');

/** Parse redirect rules: Netlify/Cloudflare _redirects, vercel.json, netlify.toml or CSV (from,to[,status]). */
export function parseRedirects(text, name = '_redirects') {
  const rules = [];
  const base = path.basename(name);
  const push = (from, to, status, line, flavor = 'netlify') => {
    if (typeof from !== 'string' || !from.startsWith('/')) return;
    const st = status ? Number(String(status).replace('!', '')) : null;
    const compiled = flavor === 'vercel' ? compileVercelPattern(from) : compileNetlifyPattern(from.replace(/[?#].*$/, ''));
    rules.push({ from, to: String(to || ''), status: Number.isFinite(st) ? st : null, kind: ruleKind(st), source: `${base}${line ? `:${line}` : ''}`, ...compiled });
  };
  if (/\.json$/i.test(base)) {
    let data;
    try {
      data = JSON.parse(String(text).replace(/^﻿/, ''));
    } catch (e) {
      throw new UserError(`${name} is not valid JSON: ${e.message}`);
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.redirects) ? data.redirects : [];
    // rules limited by has/missing conditions (a host, header or cookie) do not apply to every request: skipped
    list.forEach((r, i) => r && !r.has && !r.missing && push(r.source || r.from, r.destination || r.to, r.statusCode || r.status || (r.permanent === false ? 307 : r.permanent === true ? 308 : null), `redirects[${i}]`, 'vercel'));
    const rewrites = !Array.isArray(data) && data && Array.isArray(data.rewrites) ? data.rewrites : [];
    rewrites.forEach((r, i) => r && !r.has && !r.missing && push(r.source, r.destination, 200, `rewrites[${i}]`, 'vercel'));
    return rules;
  }
  if (/\.toml$/i.test(base)) {
    for (const sec of String(text).split(/^\s*(?=\[)/m)) {
      if (!/^\[\[redirects\]\]/.test(sec)) continue;
      const get = (k) => {
        const m = new RegExp(`^\\s*${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\d+))`, 'm').exec(sec);
        return m ? m[1] ?? m[2] ?? m[3] : '';
      };
      if (/^\s*conditions\s*=/m.test(sec)) continue;
      push(get('from'), get('to'), get('status') || null, 'redirects');
    }
    return rules;
  }
  if (/\.csv$/i.test(base)) {
    const { headers, records } = csvToRecords(text);
    const fromCol = findColumn(headers, ['from', 'source', 'old', 'old_url', 'old url', 'source_url', 'url']);
    const toCol = findColumn(headers, ['to', 'destination', 'target', 'new', 'new_url', 'new url', 'target_url', 'redirect_to']);
    const stCol = findColumn(headers, ['status', 'code', 'status_code', 'type']);
    if (!fromCol || !toCol) throw new UserError(`${name}: needs "from" and "to" columns (got ${headers.join(', ')})`);
    records.forEach((r, i) => push(pathKeyOrSelf(r[fromCol]), r[toCol], /^\d{3}$/.test(r[stCol] || '') ? r[stCol] : null, i + 2));
    return rules;
  }
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const t = line.split(/\s+/);
    const toIdx = t.findIndex((x, j) => j > 0 && (x.startsWith('/') || /^https?:\/\//i.test(x)));
    if (toIdx < 0) return;
    if (t.slice(toIdx + 1).some((x) => /^(country|language|role|cookie)=/i.test(x))) return; // conditional rule
    const status = t.slice(toIdx + 1).find((x) => /^\d{3}!?$/.test(x));
    push(t[0], t[toIdx], status || null, i + 1);
  });
  return rules;
}

const pathKeyOrSelf = (v) => (/^https?:\/\//i.test(String(v || '')) ? pathKey(v) : String(v || '').trim());

/** First rule matching a path: {rule, to (placeholders filled), kind, status, source} or null. */
export function matchRedirect(rules, key) {
  const p = String(key || '').replace(/\?.*$/, '');
  for (const rule of rules || []) {
    const m = rule.re.exec(p) || rule.re.exec(p.replace(/\/$/, '')) || (p.endsWith('/') ? null : rule.re.exec(`${p}/`));
    if (!m) continue;
    let to = rule.to;
    rule.names.forEach((n, i) => {
      to = to.replace(new RegExp(`:${escapeRe(n)}(?![A-Za-z0-9_])(\\([^)]*\\))?[*+?]?`, 'g'), () => m[i + 1] || '');
      to = to.split(`$${i + 1}`).join(m[i + 1] || '');
    });
    return { rule, to, kind: rule.kind, status: rule.status, source: rule.source };
  }
  return null;
}

/** Header rules (Netlify/Cloudflare _headers, vercel.json headers, netlify.toml [[headers]]): [{re, names, headers}]. */
export function parseHeaderRules(text, name = '_headers') {
  const rules = [];
  if (/\.json$/i.test(name)) {
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      return rules;
    }
    for (const h of (data && Array.isArray(data.headers) ? data.headers : [])) {
      if (!h || h.has || h.missing) continue;
      const headers = {};
      for (const kv of Array.isArray(h.headers) ? h.headers : []) if (kv && kv.key) headers[String(kv.key).toLowerCase()] = String(kv.value || '');
      rules.push({ ...compileVercelPattern(h.source || '/'), headers });
    }
    return rules;
  }
  if (/\.toml$/i.test(name)) {
    let current = null;
    for (const sec of String(text).split(/^\s*(?=\[)/m)) {
      if (/^\[\[headers\]\]/.test(sec)) {
        const m = /^\s*for\s*=\s*(?:"([^"]*)"|'([^']*)')/m.exec(sec);
        current = m ? { ...compileNetlifyPattern(m[1] ?? m[2]), headers: {} } : null;
        if (current) rules.push(current);
      } else if (/^\[headers\.values\]/.test(sec) && current) {
        for (const kv of sec.matchAll(/^\s*"?([A-Za-z0-9-]+)"?\s*=\s*(?:"([^"]*)"|'([^']*)')/gm)) current.headers[kv[1].toLowerCase()] = kv[2] ?? kv[3];
      } else current = null;
    }
    return rules;
  }
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { ...compileNetlifyPattern(raw.trim()), headers: {} };
      rules.push(current);
      continue;
    }
    const m = /^\s+([^:!][^:]*):\s*(.*)$/.exec(raw);
    if (current && m) {
      const k = m[1].trim().toLowerCase();
      current.headers[k] = current.headers[k] ? `${current.headers[k]}, ${m[2].trim()}` : m[2].trim();
    }
  }
  return rules;
}

function headersFor(rules, key) {
  const res = {};
  const p = String(key || '').replace(/\?.*$/, '');
  for (const r of rules) {
    if (!r.re.test(p)) continue;
    for (const [k, v] of Object.entries(r.headers)) res[k] = res[k] ? `${res[k]}, ${v}` : v;
  }
  return res;
}

/** --retired file: one URL/path per line (first word; # comments) or a CSV with a url column -> Set of normalized keys. */
export function loadRetired(file) {
  if (!file) return new Set();
  if (!fs.existsSync(file)) throw new UserError(`--retired file not found: ${file}`);
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let entries = [];
  const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) || '';
  if (/,/.test(first) && !/^https?:\/\//i.test(first.trim()) && !first.trim().startsWith('/')) {
    const { headers, records } = csvToRecords(text);
    const col = findColumn(headers, ['url', 'old_url', 'old url', 'from', 'source', 'path', 'page']);
    if (!col) throw new UserError(`--retired ${file}: CSV needs a url column (got ${headers.join(', ')})`);
    entries = records.map((r) => r[col]).filter(Boolean);
  } else entries = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '').trim().split(/[\s,]+/)[0]).filter(Boolean);
  return new Set(entries.map((e) => normKey(pathKey(e.trim().startsWith('/') || /^https?:/i.test(e.trim()) ? e.trim() : `/${e.trim()}`))));
}

// ---------- sides ----------
function makeSide(label, kind, { origin, prefix = '', hosts = [] }) {
  const side = {
    label, kind, origin, prefix, spec: '', hosts: new Set(hosts.map(bareHost).filter(Boolean)),
    pages: new Map(), redirects: new Map(), missing: new Map(), errors: new Map(), fetched: new Set(), files: null, fileOf: new Map(), keyOfFile: new Map(), hash: () => null,
    byNorm: new Map(), sitemap: { found: false, truncated: false, files: [], entries: new Map() }, robots: null, robotsFound: false, truncated: false, headerRules: [], redirectRules: [], dir: '',
  };
  side.keyOf = (u) => {
    try {
      const x = new URL(u, `${side.origin}/`);
      if (!side.hosts.has(bareHost(x.host))) return null;
      let k = x.pathname + x.search;
      if (side.prefix) {
        if (x.pathname === side.prefix) k = `/${x.search}`;
        else if (x.pathname.startsWith(`${side.prefix}/`)) k = k.slice(side.prefix.length);
        else return null;
      }
      return k;
    } catch {
      return null;
    }
  };
  side.lookup = (k) => (k === null || k === undefined ? null : side.pages.has(k) ? k : side.byNorm.get(normKey(k)) || null);
  side.resolveLink = (u) => side.lookup(side.keyOf(u));
  side.urlOf = (k) => `${side.origin}${side.prefix}${k}`;
  side.index = () => {
    side.byNorm.clear();
    for (const k of side.pages.keys()) if (!side.byNorm.has(normKey(k))) side.byNorm.set(normKey(k), k);
  };
  return side;
}

function readDirSitemaps(side, files, robotsText) {
  const fileSet = new Set(files);
  const queue = files.filter((f) => /^(wp-)?sitemap[^/]*\.xml(\.gz)?$/i.test(f));
  for (const line of parseRobotsTxt(robotsText || '').sitemaps) {
    const rel = pathKey(line).replace(/^\//, '').replace(/\?.*$/, '');
    if (fileSet.has(rel) && !queue.includes(rel)) queue.push(rel);
  }
  const seen = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const parsed = parseSitemap(decodeBody(fs.readFileSync(path.join(side.dir, rel)), 'application/xml'));
    if (parsed.type === 'unknown') continue;
    side.sitemap.files.push(rel);
    const dominant = inferOrigin(parsed.entries.map((e) => e.loc));
    if (dominant) side.hosts.add(siteHost(dominant));
    if (parsed.type === 'index') {
      for (const e of parsed.entries) {
        const r = pathKey(e.loc).replace(/^\//, '').replace(/\?.*$/, '');
        if (fileSet.has(r)) queue.push(r);
      }
      continue;
    }
    for (const e of parsed.entries) {
      const k = side.keyOf(e.loc);
      if (k && !side.sitemap.entries.has(k)) side.sitemap.entries.set(k, { loc: e.loc, lastmod: e.lastmod || '' });
    }
  }
  side.sitemap.found = side.sitemap.files.length > 0;
}

function readRuleFiles(dir) {
  const redirects = [];
  const headers = [];
  const read = (n) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : null);
  const r = read('_redirects');
  if (r !== null) redirects.push(...parseRedirects(r, '_redirects'));
  const v = read('vercel.json');
  if (v !== null) {
    try {
      redirects.push(...parseRedirects(v, 'vercel.json'));
      headers.push(...parseHeaderRules(v, 'vercel.json'));
    } catch {
      /* not a vercel config */
    }
  }
  const t = read('netlify.toml');
  if (t !== null) {
    redirects.push(...parseRedirects(t, 'netlify.toml'));
    headers.push(...parseHeaderRules(t, 'netlify.toml'));
  }
  const h = read('_headers');
  if (h !== null) headers.push(...parseHeaderRules(h, '_headers'));
  return { redirects, headers };
}

function loadDirSide(label, dir, o) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UserError(`--${label} directory not found: ${dir}`, { hint: 'Build the site first, or pass a live origin (https://...) or git:<ref>:<dir>.' });
  const side = makeSide(label, 'dir', { origin: o.origin, prefix: o.prefix, hosts: [siteHost(o.origin), ...o.hosts] });
  side.dir = dir;
  side.files = new Map();
  side.hash = (rel) => {
    if (!side.files.has(rel)) return null;
    if (!side.files.get(rel)) side.files.set(rel, sha256(fs.readFileSync(path.join(dir, rel))));
    return side.files.get(rel);
  };
  const files = listFiles(dir);
  const rules = readRuleFiles(dir);
  side.redirectRules = rules.redirects;
  side.headerRules = rules.headers;
  const robotsText = fs.existsSync(path.join(dir, 'robots.txt')) ? fs.readFileSync(path.join(dir, 'robots.txt'), 'utf8') : '';
  if (robotsText) {
    side.robots = parseRobotsTxt(robotsText);
    side.robotsFound = true;
  }
  for (const rel of files) {
    side.files.set(rel, null);
    if (!HTML_FILE_RE.test(rel) || ERROR_PAGE_RE.test(rel)) continue;
    const buf = fs.readFileSync(path.join(dir, rel));
    const key = fileToUrlPath(rel, { cleanUrls: o.cleanUrls });
    side.keyOfFile.set(rel, key);
    const html = decodeBody(buf, 'text/html');
    const facts = extractFacts(html, side.urlOf(key), { headers: headersFor(side.headerRules, key), hosts: [...side.hosts], keepSearchText: false });
    if (o.markers.length && o.markers.some((m) => html.includes(m))) facts.protectedMarker = true;
    if (facts.refresh && facts.refresh.delay <= 1 && side.keyOf(facts.refresh.url) !== key) {
      side.redirects.set(key, { to: facts.refresh.url, status: null, kind: 'redirect', source: `meta refresh in ${rel}` });
      continue;
    }
    if (side.pages.has(key)) continue;
    side.pages.set(key, facts);
    side.fileOf.set(key, rel);
  }
  readDirSitemaps(side, files, robotsText);
  side.index();
  return side;
}

/** Export <dir> at <ref> with `git archive | tar -x` into a temp dir. spec = git:<ref>:<dir>. */
export function exportGitTree(spec, { cwd = process.cwd() } = {}) {
  const m = /^git:([^:]+):?(.*)$/.exec(spec);
  if (!m) throw new UserError(`Bad git spec "${spec}" (use git:<ref>:<dir>, e.g. git:origin/main:dist)`);
  const ref = m[1];
  if (ref.startsWith('-')) throw new UserError(`Bad git ref "${ref}" in ${spec}: a ref cannot start with "-"`);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (top.error) throw new UserError('git is not installed or not on PATH (needed for --before git:...)');
  if (top.status !== 0) throw new UserError(`${cwd} is not inside a git repository (needed for --before ${spec})`);
  const root = top.stdout.trim();
  const rel = path.relative(root, path.resolve(cwd, m[2] || '.')).replace(/\\/g, '/') || '.';
  const ar = spawnSync('git', ['archive', '--format=tar', ref, '--', rel], { cwd: root, maxBuffer: 2 ** 31 - 1 });
  if (ar.status !== 0) throw new UserError(`git archive ${ref} ${rel} failed: ${String(ar.stderr || '').trim().slice(0, 200)}`, { hint: 'Check the ref (git log --oneline) and that the directory is committed at that ref.' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-diff-git-'));
  const tx = spawnSync('tar', ['-x', '-f', '-', '-C', tmp], { input: ar.stdout, maxBuffer: 64 * 1024 * 1024 });
  if (tx.error || tx.status !== 0) throw new UserError(`tar could not extract the git archive: ${String((tx.error && tx.error.message) || tx.stderr || '').trim().slice(0, 200)}`);
  return { dir: path.join(tmp, rel), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** GET that follows redirects only within the side's own hosts. {status, chain, finalUrl, headers, body, error, offsite}. */
async function fetchSameSite(url, side, fetchOpts, extra = {}) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop <= 10; hop++) {
    const res = await fetchPage(current, { ...fetchOpts, ...extra, followRedirects: false });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      let next;
      try {
        next = new URL(res.headers.location, current).href;
      } catch {
        return { ...res, chain, finalUrl: current, error: `invalid redirect location "${String(res.headers.location).slice(0, 80)}"` };
      }
      chain.push({ url: current, status: res.status, location: next });
      if (!side.hosts.has(siteHost(next))) return { status: res.status, chain, finalUrl: next, headers: res.headers, body: null, error: '', offsite: true };
      if (chain.some((c) => c.url === next)) return { ...res, chain, finalUrl: next, error: 'redirect loop' };
      current = next;
      continue;
    }
    return { ...res, chain, finalUrl: current, offsite: false };
  }
  return { status: 0, chain, finalUrl: current, headers: {}, body: null, error: 'more than 10 redirects', offsite: false };
}

const transient = (res) => res.status === 429 || res.status >= 500 || (!res.status && res.error);

async function liveMeta(label, spec, o) {
  const base = new URL(spec);
  const side = makeSide(label, 'live', { origin: base.origin, prefix: base.pathname.replace(/\/+$/, ''), hosts: [base.host, ...o.hosts] });
  const rob = await fetchSameSite(`${base.origin}/robots.txt`, side, o.fetchOpts, { maxBytes: 600 * 1024 });
  if (rob.status === 200 && !rob.error) {
    side.robots = parseRobotsTxt(rob.body || '');
    side.robotsFound = true;
  }
  // Sitemap URLs listed in robots.txt (or nested in an index) may name the production host: read this side's own copy.
  const local = (u) => {
    try {
      const x = new URL(u, base.origin);
      return `${base.origin}${x.pathname}${x.search}`;
    } catch {
      return '';
    }
  };
  const queue = side.robots && side.robots.sitemaps.length ? side.robots.sitemaps.map(local).filter(Boolean) : [`${base.origin}${side.prefix}/sitemap.xml`, `${base.origin}/sitemap_index.xml`, `${base.origin}/sitemap-index.xml`, `${base.origin}/wp-sitemap.xml`];
  const guesses = side.robots && side.robots.sitemaps.length ? new Set() : new Set(queue);
  const seen = new Set();
  const locs = [];
  while (queue.length) {
    const sm = queue.shift();
    if (!sm || seen.has(sm)) continue;
    if (seen.size >= MAX_SITEMAPS) {
      side.sitemap.truncated = true;
      break;
    }
    seen.add(sm);
    const res = await fetchSameSite(sm, side, o.fetchOpts, { maxBytes: 60 * 1024 * 1024 });
    if (res.error || res.status !== 200 || res.offsite) continue;
    const parsed = parseSitemap(res.body);
    if (parsed.type === 'unknown') continue;
    side.sitemap.files.push(sm);
    if (guesses.has(sm)) for (let i = queue.length - 1; i >= 0; i--) if (guesses.has(queue[i])) queue.splice(i, 1);
    if (parsed.type === 'index') queue.push(...parsed.entries.map((e) => local(e.loc)));
    else locs.push(...parsed.entries);
  }
  const dominant = inferOrigin(locs.map((e) => e.loc));
  if (dominant) side.hosts.add(siteHost(dominant));
  for (const e of locs) {
    const k = side.keyOf(e.loc);
    if (k && !side.sitemap.entries.has(k)) side.sitemap.entries.set(k, { loc: e.loc, lastmod: e.lastmod || '' });
  }
  side.sitemap.found = side.sitemap.files.length > 0;
  return side;
}

async function liveFetch(side, keys, o) {
  const list = keys.slice(0, o.maxPages);
  side.truncated = keys.length > o.maxPages;
  const wait = rateLimiter(o.delay);
  let done = 0;
  const pageFacts = (res, url) => {
    const facts = extractFacts(res.body || '', url, { headers: res.headers, status: 200, hosts: [...side.hosts], keepSearchText: side.label === 'after' });
    if (o.markers.length && o.markers.some((m) => String(res.body).includes(m))) facts.protectedMarker = true;
    return facts;
  };
  await mapLimit(list, Math.max(1, o.concurrency), async (key) => {
    await wait();
    const url = side.urlOf(key);
    let res = await fetchSameSite(url, side, o.fetchOpts, { maxBytes: 5 * 1024 * 1024 });
    if (transient(res)) {
      await sleep(1000);
      res = await fetchSameSite(url, side, o.fetchOpts, { maxBytes: 5 * 1024 * 1024 });
    }
    side.fetched.add(key);
    if (++done % 50 === 0) log(`  ${side.label}: ${done}/${list.length} fetched`);
    if (res.error && !res.chain.length) return void side.errors.set(key, res.status ? `HTTP ${res.status}: ${res.error}` : res.error);
    if (res.chain.length) {
      const entry = { to: res.finalUrl, status: res.chain[0].status, kind: 'redirect', source: 'live redirect', offsite: Boolean(res.offsite) };
      side.redirects.set(key, entry);
      if (res.offsite) return;
      if (res.error) {
        entry.broken = `ends with an error (${res.error})`;
        return;
      }
      const fk = side.keyOf(res.finalUrl);
      if (res.status === 200 && isHtml(res)) {
        if (fk !== null && !side.pages.has(fk)) {
          side.pages.set(fk, pageFacts(res, res.finalUrl));
          side.fetched.add(fk);
        }
      } else entry.broken = `ends at HTTP ${res.status || 0}${res.error ? ` (${res.error})` : ''}`;
      return;
    }
    if (res.status === 200 && isHtml(res)) {
      const facts = pageFacts(res, url);
      if (facts.refresh && facts.refresh.delay <= 1 && side.keyOf(facts.refresh.url) !== key) return void side.redirects.set(key, { to: facts.refresh.url, status: null, kind: 'redirect', source: 'meta refresh' });
      side.pages.set(key, facts);
      return;
    }
    if (res.status === 404 || res.status === 410) side.missing.set(key, res.status);
    else if (res.status >= 400) side.errors.set(key, `HTTP ${res.status}`);
  });
  side.index();
}

/** Preview hosts send X-Robots-Tag: noindex on every response: ignore that header (meta robots still counts). */
function ignorePreviewNoindex(side, productionHost) {
  if (side.kind !== 'live') return 0;
  const pages = [...side.pages.values()];
  const headerOnly = pages.filter((f) => f.headerNoindex && !f.metaNoindex);
  // only a host that is provably not production: a site-wide noindex header on production must never be ignored
  if (!headerOnly.length || !productionHost || siteHost(side.origin) === bareHost(productionHost)) return 0;
  for (const f of headerOnly) {
    f.noindex = false;
    f.noindexSource = '';
  }
  return headerOnly.length;
}

// ---------- comparison ----------
function canonicalSelf(f, key, side) {
  if (!f.canonical) return true;
  const ck = side.keyOf(f.canonical);
  return ck !== null && normKey(ck) === normKey(key);
}
const canonicalTarget = (f, side) => {
  const ck = side.keyOf(f.canonical);
  return ck !== null ? `key:${normKey(ck)}` : `url:${f.canonical}`;
};
const isIndexable = (f, key, side) => Boolean(f) && !f.noindex && canonicalSelf(f, key, side);

function hreflangBreaks(side) {
  const breaks = new Map();
  for (const [key, f] of side.pages) {
    if (!f.hreflang.length || f.noindex || !canonicalSelf(f, key, side)) continue;
    for (const h of f.hreflang) {
      const raw = side.keyOf(h.href);
      if (raw === null) continue;
      if (side.kind === 'live' && !side.fetched.has(raw) && !side.lookup(raw)) continue;
      const dst = side.lookup(raw);
      if (dst === key || normKey(raw) === normKey(key)) continue;
      const xDefault = h.lang === 'x-default';
      if (!dst) {
        breaks.set(`${key}>${normKey(raw)}`, { key, xDefault, missing: raw, detail: `hreflang ${h.lang} -> ${h.href}: that page is not in this version` });
        continue;
      }
      const t = side.pages.get(dst);
      if (!t.hreflang.some((x) => side.resolveLink(x.href) === key)) breaks.set(`${key}>${normKey(raw)}`, { key, xDefault, detail: `hreflang ${h.lang} -> ${h.href} does not link back${xDefault ? ' (an x-default selector page may omit the return link)' : ''}` });
    }
  }
  return breaks;
}

function inlinkCounts(side) {
  const map = new Map();
  for (const [k, f] of side.pages) {
    for (const u of new Set(f.links)) {
      const t = side.resolveLink(u);
      if (!t || t === k) continue;
      if (!map.has(t)) map.set(t, new Set());
      map.get(t).add(k);
    }
  }
  return map;
}

function hreflangSet(f, side) {
  return new Set(f.hreflang.map((h) => {
    const k = side.keyOf(h.href);
    return `${h.lang}=${k !== null ? normKey(k) : h.href}`;
  }));
}

/**
 * Compare two loaded sides. o = {redirectRules, retiredNorm, protectedNorm, priority: Map(normKey -> label),
 * protectFile(rel), sitemapDropPct, suffixShare, bodyShrink, abs(key)}. Returns {findings, ledger, urls, changed, pairs}.
 */
export function diffSides(B, A, o) {
  const findings = [];
  const add = (severity, rule, url, detail, extra = {}) => findings.push({ severity, rule, url, field: extra.field || '', before: extra.before ?? '', after: extra.after ?? '', detail, ...(extra.priority ? { priority: extra.priority } : {}) });
  const abs = o.abs;
  const ledger = [];
  const changed = new Set();
  const urls = { added: [], removed: [], redirected: [], normalized: [], retired: [], notFetched: [] };
  const pairs = [];
  const rules = [...(o.redirectRules || []), ...(A.redirectRules || [])];
  const redirectFor = (k) => A.redirects.get(k) || matchRedirect(rules, k);
  const targetKey = (red) => A.keyOf(red.to);
  /** Why a matching rule does not keep the URL alive ('' = it does). */
  const notCover = (k, red) => {
    if (red.kind === 'notfound') return `only a 404 rule matches (${red.source})`;
    if (red.broken) return `the redirect to ${red.to} ${red.broken}`;
    const tk = targetKey(red);
    const wild = red.rule && WILDCARD_RE.test(red.rule.from);
    const fixedTarget = red.rule && !/[:*$]/.test(String(red.rule.to).replace(/^https?:\/\//i, ''));
    // an explicit rule for this very path (no wildcard) is a deliberate route, e.g. "/en /index.html 200" served by an edge worker
    const explicitRewrite = red.kind === 'rewrite' && red.rule && !wild && !/^\/\*?$/.test(red.rule.from);
    if (red.kind === 'rewrite' && !explicitRewrite && ((red.rule && /^\/\*?$/.test(red.rule.from)) || /^\/(index\.html?)?$/.test(String(red.to || '').replace(/^https?:\/\/[^/]+/i, '')) || (wild && fixedTarget))) return `only a catch-all/SPA rewrite matches (${red.source}): it serves another page with 200, a soft 404`;
    if (red.kind === 'redirect' && tk !== null && normKey(tk) === '/' && normKey(k) !== '/' && (wild || !red.rule)) return `it redirects to the home page (${red.source}), which Google treats as a soft 404`;
    if (tk !== null && normKey(tk) === normKey(k)) return `the matching rule (${red.source}) only re-spells the same URL (${red.to}) and that page is gone`;
    return '';
  };
  const coverage = (k) => {
    const red = redirectFor(k);
    return red && !notCover(k, red) ? red : null;
  };
  const isProtected = (bk, f) => o.protectedNorm.has(normKey(bk)) || Boolean(f && f.protectedMarker);

  const handleCovered = (bk, bf, red) => {
    changed.add(bk);
    if (red.kind === 'gone') {
      urls.retired.push(bk);
      add('info', 'retired', abs(bk), `Removed with an explicit 410 rule (${red.source})`);
      return;
    }
    if (red.kind === 'rewrite') {
      if (/^\/(index\.html?)?$/.test(String(red.to || '').replace(/^https?:\/\/[^/]+/i, ''))) add('warn', 'rewrite-to-index', abs(bk), `Served only by the explicit rewrite ${red.rule ? red.rule.from : bk} -> ${red.to} (${red.source}): the build cannot show what this URL renders (edge worker or client-side routing); check it on a preview deploy`);
      else add('info', 'rewritten', abs(bk), `Served by a rewrite rule to ${red.to} (${red.source})`);
      return;
    }
    urls.redirected.push([bk, red.to]);
    add('info', 'redirected', abs(bk), `Redirected to ${red.to}${red.status ? ` (${red.status})` : ''} via ${red.source}${red.offsite ? ' (another host: not checked)' : ''}`, { before: bk, after: red.to });
    const tk = targetKey(red);
    if (tk !== null && !A.lookup(tk)) {
      const next = coverage(tk);
      if (next && next.kind === 'redirect') add('warn', 'redirect-chain', abs(bk), `Redirect target ${red.to} redirects again to ${next.to}: send ${bk} straight to the final page (one hop)`);
      else if (!(A.kind === 'live' && !A.fetched.has(tk))) add('warn', 'redirect-target-missing', abs(bk), `Redirect target ${red.to} is not a page in the after version (fine only if a server route serves it)`);
    }
    if (red.rule && WILDCARD_RE.test(red.rule.from) && !/[:*$]/.test(String(red.rule.to).replace(/^https?:\/\//i, ''))) add('warn', 'redirect-catch-all', abs(bk), `Only the wildcard rule ${red.rule.from} -> ${red.rule.to} covers this page: many URLs to one page can be treated as soft 404s; redirect to the closest equivalent page`);
    if ([302, 303, 307].includes(red.status) && isIndexable(bf, bk, B)) add('warn', 'redirect-temporary', abs(bk), `${red.status} is a temporary redirect: use 301/308 for a permanent move`);
  };

  // pages of the before side
  for (const [bk, bf] of B.pages) {
    if (A.pages.has(bk)) {
      pairs.push([bk, bk]);
      continue;
    }
    const ak = A.byNorm.get(normKey(bk));
    if (ak) {
      urls.normalized.push([bk, ak]);
      changed.add(bk);
      changed.add(ak);
      add('info', 'url-normalized', abs(bk), `${bk} -> ${ak}: same page under a normalized URL (.html / trailing slash / index.html), not a removal`, { before: bk, after: ak });
      if (strictKey(bk) !== strictKey(ak)) {
        const red = redirectFor(bk);
        const tk = red ? targetKey(red) : null;
        if (!(red && red.kind === 'redirect' && !red.broken && tk !== null && strictKey(tk) === strictKey(ak))) add('warn', 'url-case-changed', abs(bk), `${bk} -> ${ak} changes only letter case and no redirect covers the old spelling: most hosts are case-sensitive, so old links will 404 (add a 301)`, { before: bk, after: ak });
      }
      if (!B.pages.has(ak)) pairs.push([bk, ak]);
      continue;
    }
    const red = redirectFor(bk);
    const why = red ? notCover(bk, red) : '';
    if (red && !why) {
      handleCovered(bk, bf, red);
      continue;
    }
    if (o.retiredNorm.has(normKey(bk))) {
      urls.retired.push(bk);
      changed.add(bk);
      add('info', 'retired', abs(bk), 'Removed on purpose (listed in --retired)');
      continue;
    }
    if (A.kind === 'live' && !A.fetched.has(bk)) {
      urls.notFetched.push(bk);
      continue;
    }
    if (A.kind === 'live' && A.errors.has(bk)) {
      add('warn', 'fetch-failed', abs(bk), `The after version answered ${A.errors.get(bk)}; this URL was not compared (retry later)`);
      continue;
    }
    urls.removed.push(bk);
    changed.add(bk);
    const detail = why ? ` (${why})` : A.missing.has(bk) ? ` (after: HTTP ${A.missing.get(bk)})` : '';
    if (isIndexable(bf, bk, B) || isProtected(bk, bf)) add('block', 'page-removed', abs(bk), `Page is gone from the after version with no redirect rule, no normalization twin and no --retired record${detail}`, { before: bf.title });
    else add('warn', 'page-removed', abs(bk), `Non-indexable page removed (${bf.noindex ? 'noindex' : `canonical -> ${bf.canonical}`})${detail}`, { before: bf.title });
  }
  for (const [k, e] of B.errors) add('warn', 'fetch-failed', abs(k), `The before version answered ${e}; this URL was not compared`);

  // new pages
  const paired = new Set(pairs.map((p) => p[1]));
  for (const [ak, af] of A.pages) {
    if (paired.has(ak) || B.pages.has(ak) || B.byNorm.has(normKey(ak))) continue;
    if (B.kind === 'live' && !B.redirects.has(ak) && (B.errors.has(ak) || !B.fetched.has(ak))) {
      if (!B.errors.has(ak)) add('info', 'not-compared', abs(ak), 'The before version of this URL was not fetched (--max-pages); not compared');
      continue;
    }
    urls.added.push(ak);
    changed.add(ak);
    add('info', 'page-added', abs(ak), `New page${af.noindex ? ' (noindex)' : ''}: ${truncate(af.title, 80)}`, { after: af.title });
    if (!af.noindex) {
      if (!af.title) add('block', 'title-empty', abs(ak), 'New page has no title', { field: 'title' });
      if (af.jsonldErrors.length) add('block', 'jsonld-parse-error', abs(ak), `JSON-LD does not parse: ${af.jsonldErrors[0]}`, { field: 'jsonld' });
    }
    faqChecks(abs(ak), af, null, { isNew: true });
  }

  function faqChecks(url, a, b, { isNew = false, rewritten = () => false }) {
    if (a.noindex) return;
    const beforeMissing = new Set((b ? b.faq.notVisible : []).map((q) => compactKey(q)));
    for (const q of a.faq.notVisible) {
      const pre = beforeMissing.has(compactKey(q));
      add(pre ? 'warn' : 'block', 'faq-not-visible', url, `FAQPage question is not in the visible text: "${truncate(q, 100)}"${pre ? ' (pre-existing)' : ''}`, { field: 'faq', after: q });
    }
    if (!a.faq.schemaCount) return;
    const vis = a.faq.visible.detected ? a.faq.visible.count : null;
    if (vis === null) {
      add('info', 'faq-count-unknown', url, 'FAQPage present but no visible FAQ block was recognised; count check skipped (mark it with an "FAQ" heading, <details>/<summary>, <dl> or a class containing "faq")');
      return;
    }
    const diff = Math.abs(a.faq.schemaCount - vis);
    if (!diff) return;
    const sure = a.faq.visible.structural;
    const detail = `FAQPage has ${a.faq.schemaCount} question(s), the visible FAQ shows ${vis}${sure ? '' : ' (counted from headings only: check by hand)'}`;
    const extra = { field: 'faq', before: b ? String(b.faq.schemaCount) : '', after: `${a.faq.schemaCount} schema / ${vis} visible` };
    if (isNew || rewritten()) add(sure ? 'block' : 'warn', 'faq-count-mismatch', url, `${detail} (${isNew ? 'new' : 'rewritten'} page: the counts must match)`, extra);
    else if (diff === 1) add('warn', 'faq-count-off-by-one', url, `${detail} (should_fix: existing template page; fix it in the generator)`, extra);
    else {
      const bVis = b && b.faq.visible.detected ? b.faq.visible.count : null;
      const pre = b && bVis !== null && Math.abs(b.faq.schemaCount - bVis) === diff;
      add(pre || !sure ? 'warn' : 'block', 'faq-count-mismatch', url, `${detail}${pre ? ' (pre-existing)' : ''}`, extra);
    }
  }

  // compare pairs
  const substantial = [];
  for (const [bk, ak] of pairs) {
    const b = B.pages.get(bk);
    const a = A.pages.get(ak);
    const url = abs(ak);
    if (b.signature !== a.signature) changed.add(ak);
    const bIdx = isIndexable(b, bk, B);
    if (!b.noindex && a.noindex) add(bIdx ? 'block' : 'warn', 'new-noindex', url, `noindex added via ${a.noindexSource}${bIdx ? '' : ' (the page was not indexable before: canonical pointed elsewhere)'}`, { field: 'robots', before: b.robots || '(none)', after: a.robots || a.noindexSource });
    else if (b.noindex && !a.noindex) add('info', 'noindex-removed', url, 'noindex removed: the page becomes indexable', { field: 'robots', before: b.robots, after: a.robots });
    const bSelf = canonicalSelf(b, bk, B);
    const aSelf = canonicalSelf(a, ak, A);
    if (a.canonical && !aSelf) {
      const bt = b.canonical && !bSelf ? canonicalTarget(b, B) : '';
      if (!bt || bt !== canonicalTarget(a, A)) add(bIdx ? 'block' : 'warn', 'canonical-retargeted', url, `canonical now points to another page: ${a.canonical}${bt ? ` (was ${b.canonical})` : ''}`, { field: 'canonical', before: b.canonical, after: a.canonical });
    } else if (b.canonical && !bSelf && aSelf) add('info', 'canonical-now-self', url, 'canonical now points to the page itself', { field: 'canonical', before: b.canonical, after: a.canonical });
    else if (b.canonical && !a.canonical) add('warn', 'canonical-removed', url, 'canonical tag removed', { field: 'canonical', before: b.canonical, after: '' });
    else if (b.canonical && a.canonical && bSelf && aSelf && b.canonical !== a.canonical && !(bk !== ak && A.keyOf(a.canonical) === ak)) add('warn', 'canonical-form-changed', url, `self-canonical changed form: ${b.canonical} -> ${a.canonical} (make sure the new form answers 200 without a redirect)`, { field: 'canonical', before: b.canonical, after: a.canonical });
    if (b.title && !a.title) add('block', 'title-empty', url, 'title became empty', { field: 'title', before: b.title, after: '' });
    for (const field of ['title', 'description', 'h1']) {
      const bv = field === 'h1' ? b.h1.join(' | ') : b[field];
      const av = field === 'h1' ? a.h1.join(' | ') : a[field];
      if (normWs(bv) === normWs(av)) continue;
      ledger.push({ key: ak, url, field, before: bv, after: av });
      if (!bv) continue;
      if (!av) {
        if (field !== 'title') add('warn', `${field}-changed`, url, `${field === 'h1' ? 'H1' : 'meta description'} removed`, { field, before: bv, after: '' });
        continue;
      }
      if (similarity(bv, av) < 0.7) substantial.push({ field, key: ak, url, bv, av });
    }
    if (b.jsonldBlocks - b.jsonldErrors.length > 0 && a.jsonldBlocks === 0) add(bIdx ? 'block' : 'warn', 'jsonld-removed', url, `All JSON-LD disappeared (before: ${b.jsonldTypes.join(', ') || 'untyped'})`, { field: 'jsonld', before: b.jsonldTypes.join(' '), after: '' });
    if (a.jsonldErrors.length) {
      const fresh = a.jsonldErrors.length > b.jsonldErrors.length;
      add(fresh ? 'block' : 'warn', 'jsonld-parse-error', url, `${a.jsonldErrors.length} JSON-LD block(s) do not parse: ${a.jsonldErrors[0]}${fresh ? '' : ' (pre-existing)'}`, { field: 'jsonld', before: String(b.jsonldErrors.length), after: String(a.jsonldErrors.length) });
    }
    const goneTypes = b.jsonldTypes.filter((t) => !a.jsonldTypes.includes(t));
    if (goneTypes.length && a.jsonldBlocks > 0 && !a.jsonldErrors.length) add('warn', 'schema-type-removed', url, `JSON-LD type(s) removed: ${goneTypes.join(', ')}`, { field: 'jsonld', before: b.jsonldTypes.join(' '), after: a.jsonldTypes.join(' ') });
    const newTypes = a.jsonldTypes.filter((t) => !b.jsonldTypes.includes(t));
    if (newTypes.length) add('info', 'schema-type-added', url, `New JSON-LD type(s): ${newTypes.join(', ')}`, { field: 'jsonld', before: b.jsonldTypes.join(' '), after: a.jsonldTypes.join(' ') });
    const faqSetChanged = [...new Set(b.faq.questions.map(compactKey))].sort().join('|') !== [...new Set(a.faq.questions.map(compactKey))].sort().join('|');
    faqChecks(url, a, b, { rewritten: () => faqSetChanged || (b.bodyHash !== a.bodyHash && jaccard(shingleSet(b.bodyText), shingleSet(a.bodyText)) < 0.6) });
    if (b.dateModified && a.dateModified && compareDates(b.dateModified, a.dateModified) > 0) add('block', 'date-regressed', url, `dateModified went back from ${b.dateModified} to ${a.dateModified}`, { field: 'dateModified', before: b.dateModified, after: a.dateModified });
    else if (b.dateModified && !a.dateModified && !a.jsonldErrors.length && a.jsonldBlocks > 0) add('warn', 'date-modified-removed', url, 'dateModified removed', { field: 'dateModified', before: b.dateModified, after: '' });
    if (b.datePublished && a.datePublished && compareDates(b.datePublished, a.datePublished) !== 0) add('warn', 'date-published-changed', url, `datePublished changed (${b.datePublished} -> ${a.datePublished}); do not reset publish dates`, { field: 'datePublished', before: b.datePublished, after: a.datePublished });
    const bh = hreflangSet(b, B);
    const ah = hreflangSet(a, A);
    if (bh.size !== ah.size || [...bh].some((x) => !ah.has(x))) add('warn', 'hreflang-changed', url, `hreflang set changed: removed ${[...bh].filter((x) => !ah.has(x)).join(' ') || '-'}; added ${[...ah].filter((x) => !bh.has(x)).join(' ') || '-'}`, { field: 'hreflang', before: [...bh].join(' '), after: [...ah].join(' ') });
    if (b.ogUrl !== a.ogUrl) add('info', 'og-url-changed', url, 'og:url changed', { field: 'og:url', before: b.ogUrl, after: a.ogUrl });
    if (b.bodyLength >= 200 && a.bodyLength <= b.bodyLength * (1 - o.bodyShrink)) add('warn', 'body-shrank', url, `Visible body text shrank ${fmtPct(1 - a.bodyLength / b.bodyLength, 0)} (${b.bodyLength} -> ${a.bodyLength} characters)`, { field: 'body', before: String(b.bodyLength), after: String(a.bodyLength) });
    if (isProtected(bk, b) && b.bodyHash !== a.bodyHash) add('block', 'protected-page-changed', url, `Protected (hand-edited) page: visible body text changed ${firstDifference(b.bodyText, a.bodyText)}`, { field: 'body' });
  }

  // title suffix added to many pages at once
  const suffixes = new Map();
  let compared = 0;
  for (const [bk, ak] of pairs) {
    const b = B.pages.get(bk);
    const a = A.pages.get(ak);
    if (!b.title || !a.title) continue;
    compared++;
    const s = addedSuffix(b.title, a.title);
    if (!s) continue;
    if (!suffixes.has(s)) suffixes.set(s, []);
    suffixes.get(s).push(ak);
  }
  const suffixKeys = new Set();
  for (const [s, keys] of suffixes) {
    if (keys.length < 3 || keys.length / compared < o.suffixShare) continue;
    keys.forEach((k) => suffixKeys.add(k));
    add('warn', 'title-suffix-added', abs(keys[0]), `${keys.length} of ${compared} titles (${fmtPct(keys.length / compared, 0)}) gained the same suffix "${s}" at once; do not add one suffix site-wide`, { field: 'title', after: s });
  }
  for (const s of substantial) {
    if (s.field === 'title' && suffixKeys.has(s.key)) continue;
    add('warn', `${s.field}-changed`, s.url, `${s.field === 'h1' ? 'H1' : s.field} changed substantially`, { field: s.field, before: s.bv, after: s.av });
  }

  // inlinks halved (only when neither side was cut by --max-pages)
  if (!B.truncated && !A.truncated) {
    const inB = inlinkCounts(B);
    const inA = inlinkCounts(A);
    for (const [bk, ak] of pairs) {
      const nb = (inB.get(bk) || new Set()).size;
      const na = (inA.get(ak) || new Set()).size;
      const prio = o.priority.get(normKey(bk));
      if (nb >= (prio ? 1 : 2) && na <= nb / 2) add('warn', 'inlinks-halved', abs(ak), `Internal inlinks ${nb} -> ${na}${prio ? ` (${prio} page: lost internal links)` : ''}`, { field: 'inlinks', before: String(nb), after: String(na), priority: prio || '' });
    }
  }

  // hreflang reciprocity in the after version
  const beforeBreaks = hreflangBreaks(B);
  for (const [k, br] of hreflangBreaks(A)) {
    const pre = beforeBreaks.has(k);
    // a target that only exists as an explicit rewrite (edge worker, SPA route) cannot be checked from the build
    const red = br.missing ? redirectFor(br.missing) : null;
    const viaRewrite = red && red.kind === 'rewrite' && !notCover(br.missing, red);
    add(pre || br.xDefault || viaRewrite ? 'warn' : 'block', 'hreflang-reciprocity', abs(br.key), `${br.detail}${viaRewrite ? ` (served by the rewrite ${red.rule ? red.rule.from : br.missing} -> ${red.to}: check its hreflang on a preview deploy)` : ''}${pre ? ' (pre-existing)' : ''}`, { field: 'hreflang' });
  }

  // robots.txt: new Disallow on previously indexable pages
  if (A.robots) {
    for (const [bk, bf] of B.pages) {
      if (!isIndexable(bf, bk, B)) continue;
      for (const ua of ['*', 'Googlebot']) {
        const was = B.robots ? robotsAllows(B.robots, ua, `${B.prefix}${bk}`) : true;
        const d = robotsDecision(A.robots, ua, `${A.prefix}${bk}`);
        if (was && !d.allowed) {
          add('block', 'robots-disallow-added', abs(bk), `robots.txt now blocks ${ua === '*' ? 'all crawlers (*)' : ua} on this indexable page: line ${d.rule.line} "Disallow: ${d.rule.path}"`, { field: 'robots.txt', after: `Disallow: ${d.rule.path}` });
          break;
        }
      }
    }
  }

  // sitemaps
  if (B.sitemap.truncated || A.sitemap.truncated) add('info', 'sitemap-truncated', abs('/'), `More than ${MAX_SITEMAPS} sitemap files: the sitemap comparison was skipped`);
  else if (B.sitemap.found) {
    const bn = B.sitemap.entries.size;
    if (!A.sitemap.found) add('block', 'sitemap-count-drop', abs('/'), `The after version has no sitemap (before: ${bn} URLs in ${B.sitemap.files.join(', ')})`, { field: 'sitemap', before: String(bn), after: '0' });
    else {
      const an = A.sitemap.entries.size;
      const drop = bn ? (bn - an) / bn : 0;
      if (drop * 100 > o.sitemapDropPct) add('block', 'sitemap-count-drop', abs('/'), `Sitemap URL count dropped ${fmtPct(drop, 1)} (${bn} -> ${an}; limit ${o.sitemapDropPct}%)`, { field: 'sitemap', before: String(bn), after: String(an) });
      const aNorm = new Map([...A.sitemap.entries.keys()].map((k) => [normKey(k), k]));
      for (const [k] of B.sitemap.entries) {
        if (A.sitemap.entries.has(k)) continue;
        const nk = aNorm.get(normKey(k));
        if (nk) {
          add('info', 'url-normalized', abs(k), `Sitemap now lists ${nk} instead of ${k} (normalized, not dropped)`, { field: 'sitemap', before: k, after: nk });
          continue;
        }
        if (o.retiredNorm.has(normKey(k)) || coverage(k)) continue;
        const ak = A.lookup(k);
        if (!ak) continue;
        const af = A.pages.get(ak);
        if (!isIndexable(af, ak, A)) {
          add('info', 'sitemap-dropped-info', abs(k), `Dropped from the sitemap; the page is now ${af.noindex ? 'noindex' : `canonicalized to ${af.canonical}`}`, { field: 'sitemap' });
          continue;
        }
        add('block', 'sitemap-dropped', abs(k), 'Dropped from the after sitemap although the page still exists, is indexable and is not retired, redirected or normalized', { field: 'sitemap', before: k, after: '' });
      }
      for (const [k, e] of B.sitemap.entries) {
        const ae = A.sitemap.entries.get(k);
        if (!ae || !e.lastmod || !ae.lastmod) continue;
        const cmp = compareDates(e.lastmod, ae.lastmod);
        const bk = B.lookup(k);
        const ak = A.lookup(k);
        const same = bk && ak && B.pages.get(bk).signature === A.pages.get(ak).signature;
        if (cmp > 0) add('block', 'date-regressed', abs(k), `sitemap lastmod went back from ${e.lastmod} to ${ae.lastmod}`, { field: 'lastmod', before: e.lastmod, after: ae.lastmod });
        else if (cmp < 0 && same) add('warn', 'lastmod-without-content-change', abs(k), `lastmod changed (${e.lastmod} -> ${ae.lastmod}) but the content signature did not`, { field: 'lastmod', before: e.lastmod, after: ae.lastmod });
        else if (cmp === 0 && bk && ak && !same) add('info', 'lastmod-not-updated', abs(k), `Content signature changed but lastmod stayed ${e.lastmod}`, { field: 'lastmod', before: e.lastmod, after: ae.lastmod });
      }
    }
  } else if (A.sitemap.found) add('info', 'sitemap-added', abs('/'), `The after version has a sitemap (${A.sitemap.entries.size} URLs); the before version had none`);
  // new sitemap URLs must be 200, indexable, self-canonical pages in their canonical spelling (references/10 rules 1, 8, 12)
  if (A.sitemap.found && !A.sitemap.truncated) {
    for (const [k] of A.sitemap.entries) {
      if (B.sitemap.entries.has(k) || (A.kind === 'live' && !A.fetched.has(k))) continue;
      let problem = '';
      if (A.pages.has(k)) {
        const af = A.pages.get(k);
        if (af.noindex) problem = 'the page is noindex';
        else if (!canonicalSelf(af, k, A)) problem = `the page's canonical points to ${af.canonical}`;
      } else {
        const variant = A.lookup(k);
        const red = redirectFor(k);
        if (variant) problem = `the page is served as ${variant}: list that spelling`;
        else if (red && red.kind === 'redirect') problem = `it is a redirect source (-> ${red.to})`;
        else problem = 'it is not a page in the after version';
      }
      if (problem) add('warn', 'sitemap-entry-invalid', abs(k), `New sitemap URL is not a 200, indexable, self-canonical page: ${problem}`, { field: 'sitemap', after: k });
    }
  }

  // redirects that existed before and are gone now
  const oldSources = new Map();
  for (const [k, r] of B.redirects) oldSources.set(k, r.to);
  for (const r of B.redirectRules || []) if (r.kind === 'redirect' && !WILDCARD_RE.test(r.from)) oldSources.set(r.from, r.to);
  for (const [k, to] of oldSources) {
    if (A.lookup(k) || coverage(k) || o.retiredNorm.has(normKey(k)) || (A.kind === 'live' && !A.fetched.has(k))) continue;
    add('warn', 'redirect-removed', abs(k), `${k} redirected to ${to} before; the after version no longer redirects it (old links and bookmarks will 404)`, { before: to, after: '' });
  }

  // protected files (both sides are directories)
  if (B.files && A.files && o.protectFile) {
    for (const rel of B.files.keys()) {
      if (!o.protectFile(rel)) continue;
      const ah = A.hash(rel);
      if (ah === B.hash(rel)) continue;
      const k = B.keyOfFile.get(rel);
      add('block', 'protected-file-changed', k ? abs(k) : rel, `Protected (hand-edited) file ${ah ? 'changed' : 'removed'}: ${rel}`, { field: 'file', before: rel, after: ah ? rel : '' });
    }
  }
  return { findings, ledger, urls, changed, pairs };
}

/** Title ledger collisions: new contains old, shared old titles, old titles still present in the after corpus. */
export function ledgerCollisions(ledger, B, corpus, { maxRows = 300 } = {}) {
  const oldCount = new Map();
  for (const f of B.pages.values()) if (f.title) oldCount.set(normWs(f.title), (oldCount.get(normWs(f.title)) || 0) + 1);
  const rows = ledger.filter((r) => r.field === 'title' && r.before && r.after);
  for (const r of rows) {
    r.newContainsOld = normWs(r.after).includes(normWs(r.before));
    r.sharedOld = (oldCount.get(normWs(r.before)) || 0) > 1;
    r.staleFiles = [];
  }
  const searchable = rows.filter((r) => !r.newContainsOld && compactKey(r.before).length >= 6).slice(0, maxRows);
  if (searchable.length) {
    const variants = searchable.map((r) => {
      const v = [...new Set([r.before, htmlEscape(r.before), JSON.stringify(r.before).slice(1, -1)])];
      const nv = [...new Set([r.after, htmlEscape(r.after), JSON.stringify(r.after).slice(1, -1)])];
      return { r, v, nv, inNew: v.map((x) => countOf(r.after, x)) };
    });
    for (const { name, text } of corpus()) {
      for (const { r, v, nv, inNew } of variants) {
        let n = 0;
        v.forEach((x, i) => {
          const hits = countOf(text, x);
          if (!hits) return;
          n += hits - (inNew[i] ? nv.reduce((s, y) => s + countOf(text, y), 0) * inNew[i] : 0);
        });
        if (n > 0) r.staleFiles.push(name);
      }
    }
  }
  return { rows, searched: searchable.length };
}

// ---------- main ----------
function parseSpec(value, label) {
  const v = String(value || '').trim();
  if (!v) throw new UserError(`--${label} is required`, { hint: ['Example: node scripts/seo-diff.mjs --before https://www.example.com --after dist', 'A side is a build directory, a live origin (https://...), or (for --before) git:<ref>:<dir>.'] });
  if (/^git:/i.test(v)) {
    if (label !== 'before') throw new UserError('git:<ref>:<dir> is only supported for --before');
    return { kind: 'git', value: v };
  }
  if (/^https?:\/\//i.test(v)) {
    try {
      new URL(v);
    } catch {
      throw new UserError(`--${label} "${v}" is not a valid URL`);
    }
    return { kind: 'live', value: v };
  }
  return { kind: 'dir', value: path.resolve(v) };
}

function loadProtection(ws, flags) {
  const cfg = (ws.config && ws.config.protect) || {};
  const globs = [...(cfg.paths || []), ...flags.protectPath].filter(Boolean);
  const res = globs.map((g) => globToRegExp(String(g).replace(/^\.?\//, '')));
  const urls = [...(cfg.urls || []), ...flags.protectUrl];
  if (ws.exists) {
    const inv = readCsvFile(ws.path('content-inventory.csv'), { required: false });
    const urlCol = findColumn(inv.headers, ['url', 'page']);
    const protCol = findColumn(inv.headers, ['protected', 'protect']);
    if (urlCol && protCol) for (const r of inv.records) if (/^(yes|y|true|1|x)$/i.test(String(r[protCol] || '').trim())) urls.push(r[urlCol]);
  }
  const protectedNorm = new Set(urls.filter(Boolean).map((u) => normKey(pathKey(/^https?:/i.test(u) || String(u).startsWith('/') ? u : `/${u}`))));
  return { globs, protectFile: res.length ? (rel, base = '') => res.some((re) => re.test(rel) || (base && re.test(`${base}/${rel}`))) : null, protectedNorm };
}

function checkRange(name, value, min, max) {
  if (!(value >= min && value <= max)) throw new UserError(`--${name} must be between ${min} and ${max} (got ${value})`);
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const beforeSpec = parseSpec(flags.before, 'before');
  const afterSpec = parseSpec(flags.after, 'after');
  checkRange('body-shrink', flags.bodyShrink, 0.01, 1);
  checkRange('suffix-share', flags.suffixShare, 0.01, 1);
  checkRange('sitemap-drop-pct', flags.sitemapDropPct, 0, 100);
  checkRange('max-pages', flags.maxPages, 1, 1e7);
  checkRange('concurrency', flags.concurrency, 1, 64);
  let baseUrl = null;
  if (flags.baseUrl) {
    try {
      baseUrl = new URL(flags.baseUrl);
      if (!/^https?:$/.test(baseUrl.protocol)) throw new Error('scheme');
    } catch {
      throw new UserError(`--base-url "${flags.baseUrl}" must be an absolute URL such as https://www.example.com or https://www.example.com/docs/`);
    }
  }
  const ws = loadWorkspace(flags, { requireConfig: false });
  const siteUrl = ws.exists ? ws.siteUrl({ required: false }) : '';
  for (const a of flags.allow) {
    const i = a.indexOf('=');
    const rule = i > 0 ? a.slice(0, i).trim() : a.trim();
    if (i <= 0 || !a.slice(i + 1).trim()) throw new UserError(`--allow needs <rule>=<reason> (got "${a}")`, { hint: 'Example: --allow "new-noindex=thin tag pages leave the index on purpose"' });
    if (!ALL_RULES.has(rule)) throw new UserError(`Unknown rule "${rule}" in --allow`, { hint: `BLOCK rules: ${Object.keys(BLOCK_RULES).join(', ')}` });
  }
  const allow = new Map(flags.allow.map((a) => [a.slice(0, a.indexOf('=')).trim(), a.slice(a.indexOf('=') + 1).trim()]));
  const fetchOpts = { userAgent: flags.userAgent, timeoutMs: flags.timeout };
  const liveBefore = beforeSpec.kind === 'live' ? new URL(beforeSpec.value) : null;
  const liveAfter = afterSpec.kind === 'live' ? new URL(afterSpec.value) : null;
  const extraHosts = [siteUrl && siteHost(siteUrl), baseUrl && baseUrl.host, liveBefore && liveBefore.host, liveAfter && liveAfter.host].filter(Boolean);
  const cleanups = [];
  try {
    let beforeDir = beforeSpec.kind === 'dir' ? beforeSpec.value : '';
    if (beforeSpec.kind === 'git') {
      log(`Exporting ${beforeSpec.value} ...`);
      const ex = exportGitTree(beforeSpec.value);
      cleanups.push(ex.cleanup);
      beforeDir = ex.dir;
    }
    const afterDir = afterSpec.kind === 'dir' ? afterSpec.value : '';
    let origin = baseUrl ? baseUrl.origin : siteUrl ? new URL(siteUrl).origin : '';
    if (!origin) origin = (afterDir && fs.existsSync(afterDir) && guessDirOrigin(afterDir)) || (beforeDir && fs.existsSync(beforeDir) && guessDirOrigin(beforeDir)) || (liveBefore && liveBefore.origin) || (liveAfter && liveAfter.origin) || 'https://site.invalid';
    const livePrefix = [liveBefore, liveAfter].map((u) => (u ? u.pathname.replace(/\/+$/, '') : '')).find(Boolean) || '';
    const prefix = baseUrl ? baseUrl.pathname.replace(/\/+$/, '') : [afterDir, beforeDir].filter((x) => x && fs.existsSync(x)).map((x) => guessDirPrefix(x, { cleanUrls: flags.cleanUrls })).find(Boolean) || livePrefix;
    if (prefix && !baseUrl) log(`Directory sides are served under ${prefix}/ (from the canonicals or the live URL); pass --base-url to override.`);
    const markers = flags.protectMarker.filter(Boolean);
    const dirOpts = { origin, prefix, cleanUrls: flags.cleanUrls, hosts: extraHosts, markers };
    const liveOpts = { fetchOpts, hosts: extraHosts, maxPages: flags.maxPages, concurrency: flags.concurrency, delay: flags.delay, markers };
    const B = beforeDir ? loadDirSide('before', beforeDir, dirOpts) : await liveMeta('before', beforeSpec.value, liveOpts);
    const A = afterDir ? loadDirSide('after', afterDir, dirOpts) : await liveMeta('after', afterSpec.value, liveOpts);
    B.spec = flags.before;
    A.spec = flags.after;
    for (const h of [...B.hosts]) A.hosts.add(h);
    for (const h of [...A.hosts]) B.hosts.add(h);
    if (B.kind === 'live' || A.kind === 'live') {
      const keys = [...new Set(['/', ...B.pages.keys(), ...B.redirects.keys(), ...B.sitemap.entries.keys(), ...A.pages.keys(), ...A.redirects.keys(), ...A.sitemap.entries.keys()])];
      for (const side of [B, A]) {
        if (side.kind !== 'live') continue;
        log(`Fetching up to ${Math.min(keys.length, flags.maxPages)} pages from ${side.origin}${side.prefix} (${side.label}) ...`);
        await liveFetch(side, keys, liveOpts);
      }
    }
    const canonicalOrigin = inferOrigin([...B.pages.values(), ...A.pages.values()].map((p) => p.canonical).filter(Boolean));
    if (canonicalOrigin) for (const side of [B, A]) side.hosts.add(siteHost(canonicalOrigin));
    const productionHost = baseUrl ? baseUrl.host : siteUrl ? siteHost(siteUrl) : canonicalOrigin ? siteHost(canonicalOrigin) : '';
    const previewIgnored = [B, A].map((side) => ({ side, n: ignorePreviewNoindex(side, productionHost) })).filter((x) => x.n);
    if (!B.pages.size) throw new UserError(`The before version has no HTML pages (${flags.before})`, { hint: 'Check the path or URL; directory sides need *.html files.' });
    const prot = loadProtection(ws, flags);
    if (B.kind !== 'dir' && prot.protectFile && A.files) for (const [rel, key] of A.keyOfFile) if (prot.protectFile(rel)) prot.protectedNorm.add(normKey(key));
    const priority = new Map([[normKey('/'), 'home']]);
    for (const g of ws.config.guardrails || []) if (g && g.page) priority.set(normKey(B.keyOf(g.page) || pathKey(g.page)), 'guardrail');
    for (const k of prot.protectedNorm) priority.set(k, 'protected');
    const extraRules = [];
    for (const f of flags.redirects) {
      if (!fs.existsSync(f)) throw new UserError(`--redirects file not found: ${f}`);
      extraRules.push(...parseRedirects(fs.readFileSync(f, 'utf8'), f));
    }
    const outOrigin = origin === 'https://site.invalid' ? '' : origin;
    const abs = (k) => (k && k.startsWith('/') ? `${outOrigin}${prefix}${k}` : k);
    const result = diffSides(B, A, {
      redirectRules: extraRules, retiredNorm: loadRetired(flags.retired), protectedNorm: prot.protectedNorm, priority,
      protectFile: prot.protectFile ? (rel) => prot.protectFile(rel, path.basename(B.dir || '')) : null,
      sitemapDropPct: flags.sitemapDropPct, suffixShare: flags.suffixShare, bodyShrink: flags.bodyShrink, abs,
    });
    const f = result.findings;
    for (const { side, n } of previewIgnored) f.push({ severity: 'info', rule: 'preview-noindex-ignored', url: side.origin, field: 'robots', before: '', after: '', detail: `${side.label}: X-Robots-Tag noindex on ${n} page(s) of a preview host was ignored (meta robots noindex still counts)` });
    // title ledger
    const corpus = A.kind === 'dir'
      ? function* () {
        for (const rel of A.files.keys()) {
          if (!TEXT_FILE_RE.test(rel)) continue;
          const file = path.join(A.dir, rel);
          if (fs.statSync(file).size > 5 * 1024 * 1024) continue;
          yield { name: rel, text: fs.readFileSync(file, 'utf8') };
        }
      }
      : function* () {
        for (const [k, p] of A.pages) yield { name: k, text: p.searchText || '' };
      };
    const led = ledgerCollisions(result.ledger, B, corpus);
    const htmlOnly = result.urls.normalized.filter(([b, a]) => /\.html?$/i.test(b) !== /\.html?$/i.test(a)).length;
    if (!flags.cleanUrls && htmlOnly >= 3 && htmlOnly >= 0.5 * result.pairs.length) log('Hint: most pages differ only by ".html": if the host serves a.html as /a, re-run with --clean-urls.');
    const nc = led.rows.filter((r) => r.newContainsOld);
    const so = led.rows.filter((r) => r.sharedOld);
    const st = led.rows.filter((r) => r.staleFiles.length);
    if (result.ledger.length) f.push({ severity: 'info', rule: 'title-ledger', url: '', field: '', before: '', after: '', detail: `${result.ledger.length} title/description/H1 change(s) recorded in the title ledger` });
    if (nc.length) f.push({ severity: 'warn', rule: 'title-ledger-new-contains-old', url: nc[0].url, field: 'title', before: nc[0].before, after: nc[0].after, detail: `${nc.length} new title(s) contain the old title: a text replace that runs twice duplicates it ("A?" -> "A?B" -> "A?BB"); write titles by URL/slug, never by search-and-replace` });
    if (so.length) f.push({ severity: 'warn', rule: 'title-ledger-shared-old-title', url: so[0].url, field: 'title', before: so[0].before, after: so[0].after, detail: `${so.length} changed title(s) had an old title shared with another page: a text replace would hit both; locate by URL/slug` });
    if (st.length) f.push({ severity: 'warn', rule: 'title-ledger-stale', url: st[0].url, field: 'title', before: st[0].before, after: st[0].after, detail: `${st.length} old title(s) still appear in ${new Set(st.flatMap((r) => r.staleFiles)).size} file(s) of the after version (lists, anchors, og/twitter, JSON-LD, ItemList, llms files, sitemap image titles), e.g. ${st[0].staleFiles.slice(0, 3).join(', ')}` });
    for (const x of f) {
      if ((x.severity === 'block' || x.severity === 'warn') && allow.has(x.rule)) {
        x.originalSeverity = x.severity;
        x.severity = 'allowed';
        x.reason = allow.get(x.rule);
      }
    }
    f.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || a.rule.localeCompare(b.rule) || String(a.url).localeCompare(String(b.url)));
    const counts = { block: 0, warn: 0, info: 0, allowed: 0 };
    for (const x of f) counts[x.severity]++;
    const tripped = counts.block > 0 || (flags.failOn === 'warn' && counts.warn > 0);
    const changedUrls = [...result.changed].map(abs).sort();
    const today = ws.today();
    const outDir = flags.out ? path.resolve(flags.out) : ws.exists ? '' : path.resolve('seo-diff-out');
    const file = (name, ext) => (outDir ? path.join(ensureDir(outDir), `${today}-${flags.name}${name}.${ext}`) : ws.dataFile('diff', `${flags.name}${name}`, ext));
    const mdFile = outDir ? path.join(outDir, `${today}-${flags.name}.md`) : ws.path('logs', 'reviews', `${today}-${flags.name}.md`);
    const allowedSummary = [...allow].map(([rule, reason]) => ({ rule, reason, count: f.filter((x) => x.rule === rule && x.severity === 'allowed').length }));
    const report = {
      meta: { before: flags.before, after: flags.after, beforeKind: beforeSpec.kind, afterKind: afterSpec.kind, origin: outOrigin, basePath: prefix, generatedAt: new Date().toISOString(), failOn: flags.failOn, gate: tripped ? 'fail' : 'pass', workspace: ws.exists ? ws.dir : '', cleanUrls: flags.cleanUrls, liveTruncated: B.truncated || A.truncated },
      counts,
      allowed: allowedSummary,
      pages: { before: B.pages.size, after: A.pages.size },
      urls: { ...result.urls, changed: changedUrls.length },
      sitemap: { before: { found: B.sitemap.found, files: B.sitemap.files, urls: B.sitemap.entries.size }, after: { found: A.sitemap.found, files: A.sitemap.files, urls: A.sitemap.entries.size } },
      findings: f,
      ledger: result.ledger.map((r) => ({ url: r.url, field: r.field, before: r.before, after: r.after, newContainsOld: Boolean(r.newContainsOld), sharedOld: Boolean(r.sharedOld), staleFiles: r.staleFiles || [] })),
    };
    const jsonPath = writeJson(file('', 'json'), report);
    const changesCsv = writeCsvFile(file('-changes', 'csv'), f.map((x) => ({ severity: x.severity, rule: x.rule, url: x.url, field: x.field, before: truncate(x.before, 300), after: truncate(x.after, 300), detail: `${x.detail}${x.reason ? ` [allowed: ${x.reason}]` : ''}` })), ['severity', 'rule', 'url', 'field', 'before', 'after', 'detail']);
    const urlsTxt = writeText(file('-changed-urls', 'txt'), changedUrls.length ? `${changedUrls.join('\n')}\n` : '');
    const ledgerCsv = writeCsvFile(file('-title-ledger', 'csv'), result.ledger.map((r) => ({ url: r.url, field: r.field, before: r.before, after: r.after, new_contains_old: r.newContainsOld ? 'yes' : '', shared_old_title: r.sharedOld ? 'yes' : '', stale_files: r.staleFiles ? r.staleFiles.length || '' : '', stale_examples: r.staleFiles ? r.staleFiles.slice(0, 5).join(' | ') : '' })), ['url', 'field', 'before', 'after', 'new_contains_old', 'shared_old_title', 'stale_files', 'stale_examples']);
    const md = writeText(mdFile, renderMarkdown({ report, findings: f, B, A, today, flags, tripped, files: { urlsTxt, ledgerCsv, changesCsv } }));
    let recorded = '';
    if (flags.recordAllowed && allowedSummary.length) {
      if (!ws.exists) log('Warning: --record-allowed needs a workspace (logs/changes.md); nothing was recorded.');
      else {
        const lines = [`## seo-diff allowed changes - ${today}`, '', `- Before: ${flags.before} | After: ${flags.after}`];
        for (const a of allowedSummary) lines.push(`- Allowed ${a.rule} (${a.count} item(s)): ${a.reason}`);
        lines.push(`- Changed URLs: ${changedUrls.length} (${urlsTxt}); record the deploy with log-change.mjs add --urls-file <that file>`, '', '');
        recorded = appendChangesLog(ws, lines.join('\n'));
      }
    }
    if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      out(`seo-diff: ${flags.before} (${B.pages.size} pages) -> ${flags.after} (${A.pages.size} pages)`);
      out(`BLOCK ${counts.block}  WARN ${counts.warn}  INFO ${counts.info}  ALLOWED ${counts.allowed}`);
      out(`URLs: ${result.urls.added.length} added, ${result.urls.removed.length} removed, ${result.urls.redirected.length} redirected, ${result.urls.normalized.length} normalized, ${result.urls.retired.length} retired; ${changedUrls.length} changed`);
      const blocking = f.filter((x) => x.severity === 'block');
      for (const x of blocking.slice(0, 12)) out(`  BLOCK ${x.rule}  ${shortUrl(x.url, outOrigin) || '(site)'}  ${truncate(x.detail, 140)}`);
      if (blocking.length > 12) out(`  ... ${blocking.length - 12} more blocking item(s) in the report`);
      out(`Gate: ${tripped ? `FAILED (--fail-on ${flags.failOn})` : 'passed'}`);
      out('');
      for (const x of [md, jsonPath, changesCsv, urlsTxt, ledgerCsv, recorded].filter(Boolean)) out(`wrote ${x}`);
    }
    return tripped ? 2 : 0;
  } finally {
    for (const c of cleanups) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
  }
}

function renderMarkdown({ report, findings, B, A, today, flags, tripped, files }) {
  const origin = report.meta.origin;
  const L = [`# SEO diff ${today}: ${flags.before} -> ${flags.after}`, ''];
  const c = report.counts;
  L.push(`**Result: ${tripped ? 'BLOCKED' : 'passed'}** (fail on ${flags.failOn}): ${c.block} blocking, ${c.warn} warnings, ${c.info} info, ${c.allowed} allowed.`, '');
  L.push(`- Pages: ${B.pages.size} before, ${A.pages.size} after. URLs: ${report.urls.added.length} added, ${report.urls.removed.length} removed, ${report.urls.redirected.length} redirected, ${report.urls.normalized.length} normalized, ${report.urls.retired.length} retired; ${report.urls.changed} changed.`);
  L.push(`- Sitemap URLs: ${B.sitemap.found ? B.sitemap.entries.size : 'none'} before, ${A.sitemap.found ? A.sitemap.entries.size : 'none'} after.`);
  if (B.truncated || A.truncated || report.urls.notFetched.length) L.push(`- Live side capped at --max-pages ${flags.maxPages}: some pages were not compared${report.urls.notFetched.length ? ` (${report.urls.notFetched.length} before URLs not fetched)` : ''}.`);
  L.push('- Problems that already existed before are WARN "(pre-existing)": fix them separately; they do not block this deploy.', '');
  const cols = [{ label: 'Rule', key: 'rule' }, { label: 'URL', value: (x) => shortUrl(x.url, origin) || '(site)' }, { label: 'Detail', value: (x) => truncate(x.detail, 220) }];
  L.push('## Blocking (fix, or --allow <rule>=<reason> when intentional)', '', mdTable(cols, findings.filter((x) => x.severity === 'block').slice(0, 200), { empty: 'Nothing blocks this deploy.' }));
  const allowed = findings.filter((x) => x.severity === 'allowed');
  if (allowed.length) L.push('## Allowed (intentional, with reason)', '', mdTable([...cols, { label: 'Reason', key: 'reason' }], allowed.slice(0, 200)));
  const lost = findings.filter((x) => x.rule === 'inlinks-halved' && x.priority);
  if (lost.length) L.push('## Lost internal links to protected pages', '', mdTable([{ label: 'Page', value: (x) => shortUrl(x.url, origin) }, { label: 'Kind', key: 'priority' }, { label: 'Inlinks', value: (x) => `${x.before} -> ${x.after}` }], lost));
  L.push('## Warnings', '', mdTable(cols, findings.filter((x) => x.severity === 'warn').slice(0, 200), { empty: 'No warnings.' }));
  const infoCounts = new Map();
  for (const x of findings.filter((y) => y.severity === 'info')) infoCounts.set(x.rule, (infoCounts.get(x.rule) || 0) + 1);
  L.push('## Info', '', mdTable([{ label: 'Rule', key: 'rule' }, { label: 'Count', key: 'n', align: 'right' }], [...infoCounts].map(([rule, n]) => ({ rule, n })), { empty: 'None.' }));
  if (report.ledger.length) {
    L.push('## Title ledger', '', `Every title, description and H1 change is in ${path.basename(files.ledgerCsv)}. Propagate a title to all places (title, og/twitter, JSON-LD headline, breadcrumb, H1, cover alt, lists, anchors, ItemList, sitemap image titles, llms files) by URL/slug, not by search-and-replace.`, '');
    L.push(mdTable([{ label: 'URL', value: (r) => shortUrl(r.url, origin) }, { label: 'Field', key: 'field' }, { label: 'Before', value: (r) => truncate(r.before, 70) }, { label: 'After', value: (r) => truncate(r.after, 70) }, { label: 'Collisions', value: (r) => [r.newContainsOld && 'new contains old', r.sharedOld && 'shared old title', r.staleFiles && r.staleFiles.length && `stale in ${r.staleFiles.length} file(s)`].filter(Boolean).join('; ') }], report.ledger.slice(0, 100)));
  }
  L.push('## Next steps', '');
  if (tripped) L.push('- Fix the blocking items, or re-run with `--allow <rule>=<reason>` (and `--record-allowed`) for intentional changes.');
  L.push(`- After deploying, record D0 with \`log-change.mjs add --urls-file ${files.urlsTxt}\` and verify the live site with \`crawl-site.mjs --urls-file ${files.urlsTxt}\`.`);
  L.push('- Static HTML only: content injected by JavaScript is not compared.', '');
  return L.join('\n');
}

runMain(import.meta.url, main);
