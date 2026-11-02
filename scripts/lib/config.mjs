// Workspace + config.json loading, path resolution and per-site helpers.
import fs from 'node:fs';
import path from 'node:path';
import { UserError, ensureDir, expandHome, scriptCmd, escapeRe, bareHost } from './util.mjs';
import { todayInTz, validTimeZone, systemTimeZone } from './dates.mjs';
import { compactKey } from './text.mjs';

export const DEFAULT_WORKSPACE = '.seo-agent';
export const DATA_SOURCES = [
  'gsc', 'gsc/ai-features/inbox', 'ga4', 'crawl', 'competitors', 'indexing', 'geo', 'pagespeed', 'serp', 'content', 'instrumentation',
  'bing', 'bing/ai-performance/inbox', 'backlinks', 'bots', 'images', 'migration', 'diff', 'events', 'experiments',
];

export const DEFAULT_AI_ENGINES = ['chatgpt', 'perplexity', 'gemini', 'google-ai-overviews', 'copilot'];

export function defaultConfig() {
  return {
    version: 1,
    site: { url: '', name: '', language: '', country: '', timezone: '', niche: '', brandTerms: [] },
    brand: { officialName: '', alternateNames: [], founder: '', foundingDate: '', sameAs: [], contactUrl: '', areaServed: '', authors: [] },
    gsc: { siteUrl: '', credentialsFile: '' },
    ga4: { propertyId: '', credentialsFile: '' },
    bing: { siteUrl: '', apiKeyEnv: 'BING_WEBMASTER_API_KEY' },
    indexnow: { keyFile: '', keyLocation: '' },
    pagespeed: { apiKeyEnv: 'PAGESPEED_API_KEY' },
    serp: { provider: 'brave', apiKeyEnv: 'BRAVE_SEARCH_API_KEY', country: '', lang: '' },
    repo: { path: '', contentGlobs: [], urlTemplate: '', deployCommand: '', productionBranch: 'main' },
    pageGroups: {},
    queryGroups: {},
    competitors: [],
    seedKeywords: [],
    aiEngines: [...DEFAULT_AI_ENGINES],
    guardrails: [],
    geo: {
      promptsFile: 'geo-prompts.csv',
      engines: [],
      models: { openai: '', perplexity: '', gemini: '', anthropic: '' },
      samples: 3,
      maxCalls: 100,
      country: '',
      language: '',
      controlPrompts: [],
      competitorBrands: [],
      ownDomains: [],
      allowGeminiGrounding: false,
    },
    providers: {},
    protect: { paths: [], urls: [] },
    logs: { inputs: [], format: 'auto', hosts: [] },
  };
}

export function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    const outObj = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('_comment')) outObj[k] = stripComments(v);
    return outObj;
  }
  return value;
}

export function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null) {
      result[k] = deepMerge(base[k], v);
    } else result[k] = v;
  }
  return result;
}

export function resolveWorkspaceDir(flag) {
  return path.resolve(expandHome(flag || process.env.SEO_AGENT_WORKSPACE || DEFAULT_WORKSPACE));
}

export class Workspace {
  constructor(dir, config, { exists }) {
    this.dir = dir;
    this.configPath = path.join(dir, 'config.json');
    this.config = config;
    this.exists = exists;
  }

  path(...parts) {
    return path.join(this.dir, ...parts);
  }

  timezone() {
    const tz = this.config.site.timezone;
    return tz && validTimeZone(tz) ? tz : systemTimeZone();
  }

  today() {
    return todayInTz(this.timezone());
  }

  siteUrl({ required = true } = {}) {
    const url = String(this.config.site.url || '').trim();
    if (!url) {
      if (!required) return '';
      throw new UserError('site.url is not set in config.json', { hint: `Run: ${scriptCmd('init.mjs')} --workspace ${this.dir} --url https://your-site.com` });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new UserError(`site.url "${url}" is not a valid absolute URL`, { hint: 'Use the full origin, e.g. https://www.example.com/' });
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new UserError(`site.url must start with http:// or https:// (got "${url}")`);
    return parsed.href;
  }

  origin() {
    return new URL(this.siteUrl()).origin;
  }

  host() {
    return new URL(this.siteUrl()).hostname.toLowerCase();
  }

  /**
   * Resolve a config path. Absolute and ~/ paths are used as is. Relative paths are tried inside the
   * workspace first (so secrets never resolve to another site's files), then the project root (the
   * workspace's parent), then the current directory. prefer: 'project' tries the project root first
   * (for repo.path, which is usually relative to the project).
   */
  resolveFile(p, { prefer = 'workspace' } = {}) {
    if (!p) return '';
    const expanded = expandHome(p);
    if (path.isAbsolute(expanded)) return expanded;
    const base = path.basename(this.dir);
    const inside = [
      expanded.startsWith('.seo-agent/') ? path.resolve(this.dir, expanded.slice('.seo-agent/'.length)) : null,
      expanded.startsWith(`${base}/`) ? path.resolve(this.dir, expanded.slice(base.length + 1)) : null,
      path.resolve(this.dir, expanded),
    ].filter(Boolean);
    const project = path.resolve(path.dirname(this.dir), expanded);
    const candidates = prefer === 'project' ? [project, ...inside, path.resolve(expanded)] : [...inside, project, path.resolve(expanded)];
    return candidates.find((c) => fs.existsSync(c)) || candidates[0];
  }

  /** <workspace>/data/<source>/<date>-<name>.<ext> (directory is created). */
  dataFile(source, name, ext, { date } = {}) {
    const dir = ensureDir(this.path('data', source));
    return path.join(dir, `${date || this.today()}-${name}.${ext}`);
  }

  /** Data files for a source, newest first (by file name). */
  listData(source, re) {
    const dir = this.path('data', source);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => (re ? re.test(f) : true))
      .sort()
      .reverse()
      .map((f) => path.join(dir, f));
  }

  pageGroups() {
    const groups = [];
    for (const [name, pattern] of Object.entries(this.config.pageGroups || {})) {
      try {
        groups.push({ name, re: new RegExp(pattern) });
      } catch (e) {
        throw new UserError(`pageGroups.${name} is not a valid regular expression: ${e.message}`);
      }
    }
    return groups;
  }

  pageGroupOf(url) {
    let p = url;
    try {
      const u = new URL(url);
      p = u.pathname + u.search;
    } catch {
      /* already a path */
    }
    for (const g of this.pageGroups()) if (g.re.test(p)) return g.name;
    return 'other';
  }

  brandTerms() {
    const c = this.config;
    const terms = [...(c.site.brandTerms || []), c.brand.officialName, ...(c.brand.alternateNames || [])].filter(Boolean);
    return [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
  }

  brandMatcher() {
    return makeBrandMatcher(this.brandTerms());
  }

  guardrails() {
    return (this.config.guardrails || []).filter((g) => g && g.query);
  }
}

export function makeBrandMatcher(terms) {
  const keys = terms.map((t) => compactKey(t)).filter((k) => k.length >= 2);
  if (!keys.length) return () => false;
  const re = new RegExp(keys.map(escapeRe).join('|'));
  return (query) => re.test(compactKey(query));
}

export function loadWorkspace(flags = {}, { requireConfig = true } = {}) {
  const dir = resolveWorkspaceDir(flags.workspace);
  const configPath = path.join(dir, 'config.json');
  let raw = null;
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new UserError(`config.json is not valid JSON (${configPath}): ${e.message}`, { hint: 'Fix the syntax error (no comments or trailing commas in JSON).' });
    }
  } else if (requireConfig) {
    throw new UserError(`No workspace config found at ${configPath}`, {
      hint: [`Create one: ${scriptCmd('init.mjs')} --url https://your-site.com`, 'Or point to an existing workspace with --workspace <dir> or SEO_AGENT_WORKSPACE=<dir>.'],
    });
  }
  const config = deepMerge(defaultConfig(), stripComments(raw || {}));
  return new Workspace(dir, config, { exists: Boolean(raw) });
}

export function hostKey(url) {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return bareHost(url);
  }
}
