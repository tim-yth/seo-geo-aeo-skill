// Shared helpers: errors, entry-point handling, filesystem, concurrency, globbing, URLs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class UserError extends Error {
  constructor(message, { hint, exitCode = 1 } = {}) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export function fail(message, hint) {
  throw new UserError(message, { hint });
}

/** Command a user can paste to run another script, relative to the current directory. */
export function scriptCmd(name) {
  const abs = path.join(SCRIPTS_DIR, name);
  let rel = path.relative(process.cwd(), abs) || name;
  if (rel.startsWith(`..${path.sep}..${path.sep}`)) rel = abs;
  return `node ${/\s/.test(rel) ? JSON.stringify(rel) : rel}`;
}

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

export function runMain(metaUrl, main) {
  if (!isMain(metaUrl)) return;
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((err) => {
      const debug = process.env.SEO_AGENT_DEBUG === '1' || process.argv.includes('--debug');
      process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`);
      if (err && err.hint) for (const line of [].concat(err.hint)) process.stderr.write(`  -> ${line}\n`);
      if (debug && err && err.stack) process.stderr.write(`${err.stack}\n`);
      else if (!(err instanceof UserError) && !(err && err.hint)) process.stderr.write('  (run with --debug for a stack trace)\n');
      process.exitCode = err && err.exitCode ? err.exitCode : 1;
    });
}

export const log = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);
export const out = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);

// ---------- filesystem ----------
export function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, ...(mode ? { mode } : {}) });
  return dir;
}

export function writeText(file, text, { mode } = {}) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, mode ? { encoding: 'utf8', mode } : 'utf8');
  if (mode) fs.chmodSync(file, mode);
  return file;
}

export function writeJson(file, data) {
  return writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new UserError(`File not found: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new UserError(`Could not parse JSON in ${file}: ${e.message}`);
  }
}

export function appendText(file, text) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text, 'utf8');
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
  return p;
}

/** Copy a directory tree, only creating files that do not exist yet. Returns created relative paths. */
export function copyMissing(srcDir, destDir, rel = '') {
  const created = [];
  ensureDir(path.join(destDir, rel));
  for (const entry of fs.readdirSync(path.join(srcDir, rel), { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    const dest = path.join(destDir, relPath);
    if (entry.isDirectory()) {
      created.push(...copyMissing(srcDir, destDir, relPath));
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(srcDir, relPath), dest);
      created.push(relPath);
    }
  }
  return created;
}

// ---------- concurrency ----------
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Ensures successive calls to wait() start at least `intervalMs` apart (shared across workers). */
export function rateLimiter(intervalMs) {
  let nextAt = 0;
  return async function wait() {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + intervalMs;
    if (at > now) await sleep(at - now);
  };
}

// ---------- glob ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export { escapeRe };

function globBody(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        if (atStart && glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob.slice(i + 1, end).split(',').map(globBody).join('|')})`;
        i = end;
      } else re += '\\{';
    } else re += escapeRe(c);
  }
  return re;
}

export function globToRegExp(glob) {
  return new RegExp(`^${globBody(glob.replace(/\\/g, '/'))}$`);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

/** Expand glob patterns relative to `cwd`. Returns sorted absolute file paths. */
export function globFiles(patterns, { cwd = process.cwd() } = {}) {
  const found = new Set();
  for (const raw of [].concat(patterns)) {
    if (!raw) continue;
    const pattern = expandHome(raw).replace(/\\/g, '/');
    const abs = path.isAbsolute(pattern) ? pattern : path.join(cwd, pattern).replace(/\\/g, '/');
    if (!/[*?{]/.test(abs)) {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) found.add(path.resolve(abs));
      continue;
    }
    const segments = abs.split('/');
    const firstWild = segments.findIndex((s) => /[*?{]/.test(s));
    const base = segments.slice(0, firstWild).join('/') || '/';
    if (!fs.existsSync(base)) continue;
    const re = globToRegExp(segments.slice(firstWild).join('/'));
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(base, full).replace(/\\/g, '/');
          if (re.test(rel)) found.add(path.resolve(full));
        }
      }
    };
    walk(base);
  }
  return [...found].sort();
}

// ---------- URLs ----------
const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|dclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|srsltid|yclid)$/i;

export function normalizeUrl(input, { base, stripHash = true, stripTracking = true, stripQuery = false } = {}) {
  let u;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  if (stripHash) u.hash = '';
  if (stripQuery) u.search = '';
  else if (stripTracking && u.search) {
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  let href = u.href;
  if (u.search === '' && href.endsWith('?')) href = href.slice(0, -1);
  return href;
}

export function urlPath(input) {
  try {
    const u = new URL(input);
    return u.pathname + u.search;
  } catch {
    return String(input || '');
  }
}

export function hostOf(input) {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export const bareHost = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

export function sameSite(url, siteHost, { includeSubdomains = false } = {}) {
  const h = bareHost(hostOf(url));
  const s = bareHost(siteHost);
  if (!h || !s) return false;
  return h === s || (includeSubdomains && h.endsWith(`.${s}`));
}

/** Read a list of URLs/lines from positional args, a file (one per line) or both. */
export function collectList(values = [], file) {
  const list = [];
  for (const v of values) list.push(...String(v).split(/[\s,]+/));
  if (file) {
    if (!fs.existsSync(file)) fail(`List file not found: ${file}`);
    list.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '')));
  }
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

export function uniq(arr) {
  return [...new Set(arr)];
}

export function chunk(arr, size) {
  const outArr = [];
  for (let i = 0; i < arr.length; i += size) outArr.push(arr.slice(i, i + size));
  return outArr;
}

export function slugify(text, max = 40) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

// ---------- content file -> URL ----------
/** Directory part of a glob before its first wildcard segment. */
export function staticBase(pattern) {
  const segs = String(pattern).replace(/\\/g, '/').split('/');
  const i = segs.findIndex((x) => /[*?{]/.test(x));
  return i === -1 ? path.dirname(pattern) : segs.slice(0, i).join('/') || '.';
}

/** Map a content file to its URL with a template: {slug} = file name (index -> folder), {path} = relative path without extension. */
export function urlFromTemplate(tpl, file, base) {
  const rel = path.relative(base, file).replace(/\\/g, '/');
  let noExt = rel.replace(/\.(md|markdown|mdx|html?|njk|liquid|astro|vue|svelte)$/i, '');
  let slug = path.basename(noExt);
  if (/^(index|_index|readme)$/i.test(slug)) {
    noExt = path.dirname(noExt) === '.' ? '' : path.dirname(noExt);
    slug = path.basename(noExt);
  }
  return tpl.replaceAll('{slug}', slug).replaceAll('{path}', noExt).replace(/([^:]\/)\/+/g, '$1');
}

/** Static-site mapping without a template: <publicDir>/a/b.html -> /a/b.html, a/index.html -> /a/. */
export function urlFromStaticFile(file, repoRoot, origin) {
  let rel = path.relative(repoRoot, file).replace(/\\/g, '/');
  rel = rel.replace(/^(site|public|dist|out|_site|build|www|static|docs)\//, '');
  if (!/\.html?$/i.test(rel)) return '';
  rel = rel.replace(/(^|\/)index\.html?$/i, '$1');
  return new URL(`/${rel}`, origin).href;
}
