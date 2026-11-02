#!/usr/bin/env node
// Create or update a per-site workspace from templates/workspace.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, formatHelp } from './lib/args.mjs';
import { UserError, runMain, copyMissing, ensureDir, expandHome, out, scriptCmd, SCRIPTS_DIR, bareHost } from './lib/util.mjs';
import { resolveWorkspaceDir, defaultConfig, deepMerge, DATA_SOURCES } from './lib/config.mjs';
import { validTimeZone, systemTimeZone } from './lib/dates.mjs';

const TEMPLATE_DIR = path.resolve(SCRIPTS_DIR, '..', 'templates', 'workspace');

const SPEC = {
  workspace: { type: 'string', placeholder: 'dir', desc: 'Workspace directory to create (default ./.seo-agent; e.g. ~/.seo-agent/example.com for sites without a repo)' },
  url: { type: 'string', placeholder: 'https://...', desc: 'Site URL (canonical origin)' },
  name: { type: 'string', desc: 'Site name' },
  language: { type: 'string', placeholder: 'bcp47', desc: 'Main content language, e.g. en, zh-TW, ja' },
  country: { type: 'string', placeholder: 'iso3', desc: 'Main market as ISO-3166 alpha-3 (usa, twn, jpn)' },
  timezone: { type: 'string', placeholder: 'iana', desc: 'Site time zone for deploy/acceptance dates (default: this machine)' },
  niche: { type: 'string', desc: 'One-line description of the topic/niche' },
  'gsc-site': { type: 'string', placeholder: 'property', desc: 'Search Console property: sc-domain:example.com or https://www.example.com/' },
  'ga4-property': { type: 'string', placeholder: 'id', desc: 'Numeric GA4 Property ID (not G-XXXX)' },
  credentials: { type: 'string', placeholder: 'file', desc: 'Google service-account JSON; copied into secrets/ with 600 perms' },
  'ga4-credentials': { type: 'string', placeholder: 'file', desc: 'Separate service-account JSON for GA4 (optional)' },
  'indexnow-key-file': { type: 'string', placeholder: 'file', desc: 'File containing your IndexNow key; copied into secrets/' },
  'indexnow-key-location': { type: 'string', placeholder: 'url', desc: 'Public URL of the key file (default https://<site>/<key>.txt)' },
  'bing-site': { type: 'string', placeholder: 'url', desc: 'Bing Webmaster Tools site URL' },
  'bing-key-env': { type: 'string', placeholder: 'NAME', desc: 'Environment variable that holds the Bing Webmaster API key (default BING_WEBMASTER_API_KEY)' },
  'geo-engine': { type: 'list', placeholder: 'name', desc: 'AI engine for geo-track.mjs API runs: openai | perplexity | anthropic | gemini' },
  'geo-model': { type: 'list', placeholder: 'engine=model', desc: 'Model id geo-track.mjs should query for an engine, e.g. openai=<model-id>' },
  'geo-country': { type: 'string', placeholder: 'cc', desc: 'Country for geo-track.mjs search location (2-letter, e.g. US, TW)' },
  'geo-language': { type: 'string', placeholder: 'lang', desc: 'Answer language hint for geo-track.mjs (e.g. en, zh-TW)' },
  provider: { type: 'list', placeholder: 'name[=ENV]', desc: 'Optional metered provider and the env var holding its key, e.g. openai=OPENAI_API_KEY, dataforseo' },
  'provider-budget': { type: 'list', placeholder: 'name=USD', desc: 'Monthly budget for a provider, e.g. openai=20 (geo-track refuses runs that would exceed it)' },
  'protect-path': { type: 'list', placeholder: 'glob', desc: 'Human-edited build file that generators must not change (seo-diff blocks the deploy), e.g. blog/pricing/index.html' },
  'protect-url': { type: 'list', placeholder: 'url', desc: 'Protected page URL or path (seo-diff blocks body changes and reports lost inlinks)' },
  'serp-country': { type: 'string', placeholder: 'cc', desc: 'Brave SERP country code, e.g. US, TW' },
  'serp-lang': { type: 'string', placeholder: 'lang', desc: 'Brave search_lang, e.g. en, zh-hant, jp' },
  competitor: { type: 'list', placeholder: 'domain[|why]', desc: 'Competitor domain, optionally "domain|why"' },
  'brand-term': { type: 'list', placeholder: 'term', desc: 'Brand spelling people search for' },
  'brand-name': { type: 'string', desc: 'Official brand/organization name' },
  'same-as': { type: 'list', placeholder: 'url', desc: 'Official profile URL for the brand entity (sameAs)' },
  'page-group': { type: 'list', placeholder: 'name=regex', desc: 'Page group by path regex, e.g. blog=^/blog/' },
  guardrail: { type: 'list', placeholder: 'query|maxPosition', desc: 'Guardrail query, e.g. "best crm|5"' },
  'seed-keyword': { type: 'list', placeholder: 'kw', desc: 'Seed keyword' },
  repo: { type: 'string', placeholder: 'path', desc: 'Local checkout of the site source' },
  'content-glob': { type: 'list', placeholder: 'glob', desc: 'Content files relative to repo, e.g. content/**/*.md' },
  'url-template': { type: 'string', placeholder: 'tpl', desc: 'Map content files to URLs, e.g. https://example.com/blog/{slug}/' },
  'deploy-command': { type: 'string', desc: 'How the site is deployed (informational)' },
  'production-branch': { type: 'string', desc: 'Production git branch' },
  force: { type: 'boolean', desc: 'Overwrite existing values/files instead of keeping them' },
  'no-gitignore': { type: 'boolean', desc: 'Do not touch the project .gitignore' },
  json: { type: 'boolean', desc: 'Print the result as JSON' },
  debug: { type: 'boolean', desc: 'Print stack traces on errors' },
};

const HELP = formatHelp({
  usage: 'node scripts/init.mjs --url https://example.com [options]',
  summary:
    'Creates the workspace (config.json, secrets/, data/, logs/, keyword-map.csv, ...) from templates/workspace and fills config from flags. ' +
    'Idempotent: existing files are never overwritten and existing config values are kept unless --force. List flags are merged.',
  spec: SPEC,
  examples: [
    'node scripts/init.mjs --url https://www.example.com --gsc-site sc-domain:example.com --credentials ~/Downloads/sa-key.json',
    'node scripts/init.mjs --workspace ~/.seo-agent/example.com --url https://example.com --ga4-property 123456789 --competitor rival.com',
    'node scripts/init.mjs --page-group blog=^/blog/ --guardrail "pour over coffee|5" --brand-term "example coffee"',
    'node scripts/init.mjs --geo-engine openai --geo-model openai=<model-id> --geo-country US --provider openai=OPENAI_API_KEY --provider-budget openai=20',
    'node scripts/init.mjs --protect-path "blog/pricing/index.html" --protect-url /guides/pour-over/',
  ],
  notes: ['Secrets are copied into <workspace>/secrets/ (chmod 600) and referenced by path; they are never written into config.json.'],
});

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function gitRoot(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function copySecret(src, dest, { force, report }) {
  const from = path.resolve(expandHome(src));
  if (!fs.existsSync(from)) throw new UserError(`File not found: ${from}`);
  if (path.resolve(from) === path.resolve(dest)) {
    fs.chmodSync(dest, 0o600);
    return 'kept';
  }
  if (fs.existsSync(dest) && !force) {
    const same = fs.readFileSync(dest).equals(fs.readFileSync(from));
    if (!same) {
      report.kept.push(`${path.basename(dest)} already exists with different content (use --force to replace)`);
      return 'kept';
    }
  }
  fs.copyFileSync(from, dest);
  fs.chmodSync(dest, 0o600);
  return 'copied';
}

function readServiceAccount(file) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(path.resolve(expandHome(file)), 'utf8'));
  } catch (e) {
    throw new UserError(`${file} is not a readable JSON file (${e.message})`);
  }
  if (!['service_account', 'authorized_user'].includes(json.type)) {
    throw new UserError(`${file} is not a Google service-account key (type "${json.type}")`, { hint: 'Download a JSON key: Cloud Console -> IAM & Admin -> Service Accounts -> Keys -> Add key -> JSON.' });
  }
  return json;
}

export function applyFlags(config, flags, { force = false, report = { set: [], kept: [] } } = {}) {
  const setScalar = (obj, key, value, label) => {
    if (value === undefined || value === null || value === '') return;
    if (isEmpty(obj[key]) || force || obj[key] === value) {
      if (obj[key] !== value) report.set.push(`${label} = ${JSON.stringify(value)}`);
      obj[key] = value;
    } else report.kept.push(`${label} kept ${JSON.stringify(obj[key])} (use --force to replace with ${JSON.stringify(value)})`);
  };
  const mergeList = (obj, key, values, label, keyOf = (x) => JSON.stringify(x)) => {
    if (!values || !values.length) return;
    if (force) obj[key] = [];
    const existing = new Set((obj[key] || []).map(keyOf));
    for (const v of values) {
      if (existing.has(keyOf(v))) continue;
      obj[key] = [...(obj[key] || []), v];
      existing.add(keyOf(v));
      report.set.push(`${label} += ${JSON.stringify(v)}`);
    }
  };
  if (flags.url) {
    let u;
    try {
      u = new URL(flags.url);
    } catch {
      throw new UserError(`--url "${flags.url}" is not a valid URL`, { hint: 'Use the full origin, e.g. https://www.example.com' });
    }
    if (!/^https?:$/.test(u.protocol)) throw new UserError('--url must start with http:// or https://');
    setScalar(config.site, 'url', `${u.origin}/`, 'site.url');
  }
  setScalar(config.site, 'name', flags.name, 'site.name');
  setScalar(config.site, 'language', flags.language, 'site.language');
  if (flags.country) setScalar(config.site, 'country', flags.country.toUpperCase(), 'site.country');
  if (flags.timezone) {
    if (!validTimeZone(flags.timezone)) throw new UserError(`Unknown time zone "${flags.timezone}"`, { hint: 'Use an IANA name such as America/New_York or Asia/Taipei.' });
    setScalar(config.site, 'timezone', flags.timezone, 'site.timezone');
  }
  setScalar(config.site, 'niche', flags.niche, 'site.niche');
  if (flags.gscSite) {
    const s = flags.gscSite.trim();
    if (!/^sc-domain:[^/:]+$/.test(s) && !/^https?:\/\/.+\/$/.test(s)) {
      throw new UserError(`--gsc-site "${s}" is not a property string`, { hint: 'Use sc-domain:example.com (Domain property) or https://www.example.com/ (URL-prefix, with trailing slash).' });
    }
    setScalar(config.gsc, 'siteUrl', s, 'gsc.siteUrl');
  }
  if (flags.ga4Property) {
    const p = flags.ga4Property.trim().replace(/^properties\//, '');
    if (/^G-/i.test(p)) throw new UserError(`"${p}" is a Measurement ID; --ga4-property needs the numeric Property ID (GA4 -> Admin -> Property details)`);
    if (!/^\d+$/.test(p)) throw new UserError('--ga4-property must be numeric');
    setScalar(config.ga4, 'propertyId', p, 'ga4.propertyId');
  }
  setScalar(config.bing, 'siteUrl', flags.bingSite, 'bing.siteUrl');
  if (flags.bingKeyEnv) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(flags.bingKeyEnv)) throw new UserError(`--bing-key-env "${flags.bingKeyEnv}" must be an environment variable NAME (e.g. BING_WEBMASTER_API_KEY), not the key itself`);
    if (config.bing.apiKeyEnv === 'BING_WEBMASTER_API_KEY') config.bing.apiKeyEnv = ''; // the default name may always be replaced
    setScalar(config.bing, 'apiKeyEnv', flags.bingKeyEnv, 'bing.apiKeyEnv');
  }
  config.geo = config.geo || {};
  config.geo.models = config.geo.models || {};
  const ENGINES = ['openai', 'perplexity', 'anthropic', 'gemini'];
  for (const e of flags.geoEngine || []) if (!ENGINES.includes(e)) throw new UserError(`--geo-engine "${e}" must be one of ${ENGINES.join(', ')}`);
  mergeList(config.geo, 'engines', flags.geoEngine, 'geo.engines');
  for (const pair of flags.geoModel || []) {
    const eq = pair.indexOf('=');
    const engine = pair.slice(0, eq).trim();
    if (eq < 1 || !ENGINES.includes(engine) || !pair.slice(eq + 1).trim()) throw new UserError(`--geo-model "${pair}" must look like engine=model-id (engine: ${ENGINES.join(', ')})`);
    setScalar(config.geo.models, engine, pair.slice(eq + 1).trim(), `geo.models.${engine}`);
  }
  if (flags.geoCountry) setScalar(config.geo, 'country', flags.geoCountry.toUpperCase(), 'geo.country');
  setScalar(config.geo, 'language', flags.geoLanguage, 'geo.language');
  config.providers = config.providers || {};
  for (const spec of flags.provider || []) {
    const [name, env] = spec.split('=').map((x) => (x || '').trim());
    if (!/^[a-z0-9-]+$/.test(name)) throw new UserError(`--provider "${spec}" must look like name or name=ENV_VAR`);
    if (env && !/^[A-Z_][A-Z0-9_]*$/.test(env)) throw new UserError(`--provider ${name}: "${env}" must be an environment variable NAME, never the key itself`);
    const cur = config.providers[name] || {};
    const key = name === 'dataforseo' ? 'loginEnv' : 'apiKeyEnv';
    if (env) setScalar(cur, key, env, `providers.${name}.${key}`);
    else if (!config.providers[name]) report.set.push(`providers.${name} = {} (default environment variable names)`);
    config.providers[name] = cur;
  }
  for (const spec of flags.providerBudget || []) {
    const [name, usd] = spec.split('=').map((x) => (x || '').trim());
    const n = Number(usd);
    if (!name || !(n >= 0)) throw new UserError(`--provider-budget "${spec}" must look like name=USD (e.g. openai=20)`);
    config.providers[name] = config.providers[name] || {};
    setScalar(config.providers[name], 'monthlyBudgetUSD', n, `providers.${name}.monthlyBudgetUSD`);
  }
  config.protect = config.protect || { paths: [], urls: [] };
  mergeList(config.protect, 'paths', flags.protectPath, 'protect.paths');
  mergeList(config.protect, 'urls', flags.protectUrl, 'protect.urls');
  setScalar(config.indexnow, 'keyLocation', flags.indexnowKeyLocation, 'indexnow.keyLocation');
  setScalar(config.serp, 'country', flags.serpCountry, 'serp.country');
  setScalar(config.serp, 'lang', flags.serpLang, 'serp.lang');
  setScalar(config.brand, 'officialName', flags.brandName, 'brand.officialName');
  mergeList(config.brand, 'sameAs', flags.sameAs, 'brand.sameAs');
  mergeList(config.site, 'brandTerms', flags.brandTerm, 'site.brandTerms', (x) => String(x).toLowerCase());
  mergeList(config, 'seedKeywords', flags.seedKeyword, 'seedKeywords', (x) => String(x).toLowerCase());
  mergeList(
    config,
    'competitors',
    (flags.competitor || []).map((c) => {
      const [domain, ...why] = c.split('|');
      return { domain: bareHost(domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')), why: why.join('|').trim() };
    }),
    'competitors',
    (x) => x.domain,
  );
  for (const pg of flags.pageGroup || []) {
    const eq = pg.indexOf('=');
    if (eq < 1) throw new UserError(`--page-group "${pg}" must look like name=regex`);
    const name = pg.slice(0, eq).trim();
    const re = pg.slice(eq + 1).trim();
    try {
      new RegExp(re);
    } catch (e) {
      throw new UserError(`--page-group ${name}: invalid regex (${e.message})`);
    }
    setScalar(config.pageGroups, name, re, `pageGroups.${name}`);
  }
  mergeList(
    config,
    'guardrails',
    (flags.guardrail || []).map((g) => {
      const [query, max, ...note] = g.split('|');
      const maxPosition = max === undefined || max.trim() === '' ? null : Number(max);
      if (maxPosition !== null && !(maxPosition > 0)) throw new UserError(`--guardrail "${g}": maxPosition must be a positive number`);
      return { query: query.trim(), maxPosition, note: note.join('|').trim() };
    }),
    'guardrails',
    (x) => String(x.query).toLowerCase(),
  );
  if (flags.repo) setScalar(config.repo, 'path', path.resolve(expandHome(flags.repo)), 'repo.path');
  mergeList(config.repo, 'contentGlobs', flags.contentGlob, 'repo.contentGlobs');
  setScalar(config.repo, 'urlTemplate', flags.urlTemplate, 'repo.urlTemplate');
  setScalar(config.repo, 'deployCommand', flags.deployCommand, 'repo.deployCommand');
  setScalar(config.repo, 'productionBranch', flags.productionBranch, 'repo.productionBranch');
  return report;
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  if (positionals.length) throw new UserError(`Unexpected argument "${positionals[0]}"`, { hint: 'Run with --help.' });
  if (!fs.existsSync(path.join(TEMPLATE_DIR, 'config.json'))) throw new UserError(`Workspace template missing at ${TEMPLATE_DIR}`);
  const dir = resolveWorkspaceDir(flags.workspace);
  const report = { workspace: dir, created: [], set: [], kept: [], notes: [] };
  const existed = fs.existsSync(path.join(dir, 'config.json'));

  report.created = copyMissing(TEMPLATE_DIR, dir).filter((f) => !f.endsWith('.gitkeep'));
  ensureDir(path.join(dir, 'secrets'), 0o700);
  fs.chmodSync(path.join(dir, 'secrets'), 0o700);
  for (const source of DATA_SOURCES) ensureDir(path.join(dir, 'data', source));
  ensureDir(path.join(dir, 'logs', 'reviews'));

  const configPath = path.join(dir, 'config.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new UserError(`Cannot parse ${configPath}: ${e.message}`, { hint: 'Fix the JSON syntax (no comments/trailing commas), or move the file away and re-run init.' });
  }
  const config = deepMerge(defaultConfig(), raw);
  applyFlags(config, flags, { force: flags.force, report });

  const secretsRel = path.basename(dir) === '.seo-agent' ? '.seo-agent/secrets' : 'secrets';
  if (flags.credentials) {
    const sa = readServiceAccount(flags.credentials);
    const dest = path.join(dir, 'secrets', 'google-service-account.json');
    const status = copySecret(flags.credentials, dest, { force: flags.force, report });
    const rel = `${secretsRel}/google-service-account.json`;
    for (const section of ['gsc', 'ga4']) {
      if (section === 'ga4' && flags.ga4Credentials) continue;
      const cur = config[section].credentialsFile;
      if (!cur || flags.force || cur.endsWith('secrets/google-service-account.json')) config[section].credentialsFile = rel;
    }
    report.set.push(`credentials ${status} -> ${rel}`);
    if (sa.client_email) report.notes.push(`Service account email (add it in Search Console and GA4): ${sa.client_email}`);
  }
  if (flags.ga4Credentials) {
    const sa = readServiceAccount(flags.ga4Credentials);
    const dest = path.join(dir, 'secrets', 'ga4-service-account.json');
    const status = copySecret(flags.ga4Credentials, dest, { force: flags.force, report });
    config.ga4.credentialsFile = `${secretsRel}/ga4-service-account.json`;
    report.set.push(`ga4 credentials ${status} -> ${config.ga4.credentialsFile}`);
    if (sa.client_email) report.notes.push(`GA4 service account email (add as Viewer in GA4): ${sa.client_email}`);
  }
  if (flags.indexnowKeyFile) {
    const key = fs.readFileSync(path.resolve(expandHome(flags.indexnowKeyFile)), 'utf8').trim();
    if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new UserError('IndexNow key must be 8-128 characters of a-z, A-Z, 0-9 or "-"');
    const dest = path.join(dir, 'secrets', 'indexnow.key');
    if (!fs.existsSync(dest) || flags.force) {
      fs.writeFileSync(dest, `${key}\n`, { mode: 0o600 });
      fs.chmodSync(dest, 0o600);
      report.set.push(`indexnow key copied -> ${secretsRel}/indexnow.key`);
    } else if (fs.readFileSync(dest, 'utf8').trim() !== key) report.kept.push('secrets/indexnow.key exists with a different key (use --force to replace)');
    config.indexnow.keyFile = `${secretsRel}/indexnow.key`;
    if (!config.indexnow.keyLocation && config.site.url) {
      config.indexnow.keyLocation = `${new URL(config.site.url).origin}/${key}.txt`;
      report.set.push(`indexnow.keyLocation = ${config.indexnow.keyLocation} (default; publish the key file there)`);
    }
  }

  if (config.site.url) {
    const host = new URL(config.site.url).hostname;
    if (!config.site.name) config.site.name = bareHost(host);
    if (!config.gsc.siteUrl) {
      config.gsc.siteUrl = `sc-domain:${bareHost(host)}`;
      report.set.push(`gsc.siteUrl = "${config.gsc.siteUrl}" (guess; check-resources verifies the exact property)`);
    }
  }
  if (!config.site.timezone) {
    config.site.timezone = systemTimeZone();
    report.set.push(`site.timezone = "${config.site.timezone}" (from this machine; override with --timezone)`);
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  if (!flags.noGitignore) {
    const root = gitRoot(path.dirname(dir));
    const real = fs.realpathSync(dir);
    if (root && real.startsWith(fs.realpathSync(root) + path.sep)) {
      const rel = path.relative(fs.realpathSync(root), real).split(path.sep).join('/');
      const gi = path.join(root, '.gitignore');
      const current = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
      const wanted = [`${rel}/secrets/`, `${rel}/data/raw/`].filter((l) => !current.split(/\r?\n/).includes(l));
      if (wanted.length) {
        fs.appendFileSync(gi, `${current && !current.endsWith('\n') ? '\n' : ''}# seo-geo-aeo workspace secrets\n${wanted.join('\n')}\n`);
        report.notes.push(`Added to ${gi}: ${wanted.join(', ')}`);
      }
    }
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...report, existed }, null, 2)}\n`);
    return 0;
  }
  out(`${existed ? 'Updated' : 'Created'} workspace: ${dir}`);
  if (report.created.length) out(`  new files: ${report.created.join(', ')}`);
  for (const s of report.set) out(`  set   ${s}`);
  for (const k of report.kept) out(`  kept  ${k}`);
  for (const n of report.notes) out(`  note  ${n}`);
  out('');
  out(`Next: ${scriptCmd('check-resources.mjs')}${flags.workspace ? ` --workspace ${flags.workspace}` : ''}`);
  return 0;
}

runMain(import.meta.url, main);
