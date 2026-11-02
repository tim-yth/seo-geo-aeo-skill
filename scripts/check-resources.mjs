#!/usr/bin/env node
// Readiness report: what is configured, reachable and accessible, and exactly how to fix the rest.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, formatHelp, COMMON_FLAGS, GOOGLE_FLAGS } from './lib/args.mjs';
import { runMain, out, scriptCmd, bareHost, UserError } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { fetchPage, fetchRobots, robotsAllows, robotsDecision, discoverSitemaps, collectSitemapUrls, DEFAULT_UA } from './lib/http.mjs';
import { parseHtml, robotsTokens } from './lib/html.mjs';
import { gscClient, propertyCandidates, validateSiteUrl } from './lib/gsc.mjs';
import { ga4Client } from './lib/ga4.mjs';
import { SCOPES } from './lib/google-auth.mjs';
import { textTable } from './lib/format.mjs';
import { describeTz } from './lib/dates.mjs';
import { globFiles } from './lib/util.mjs';
import { PROVIDERS, AI_ENGINE_PROVIDERS, providerSettings, credentialStatus, monthSpend } from './lib/providers.mjs';
import { ledgerAgeDays, statusCacheFile } from './lib/events.mjs';
import { gscToday, diffDays } from './lib/dates.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  ...GOOGLE_FLAGS,
  json: { type: 'boolean', desc: 'Print {items:[{id,status,detail,fix}], nextAction} as JSON' },
  offline: { type: 'boolean', desc: 'Skip all network checks' },
  skip: { type: 'csv', placeholder: 'ids', desc: 'Skip checks by id (e.g. ga4,bing)' },
  'user-agent': { type: 'string', placeholder: 'ua', desc: 'User-Agent for site requests', default: DEFAULT_UA },
};

const HELP = formatHelp({
  usage: 'node scripts/check-resources.mjs [--workspace dir] [--json]',
  summary:
    'Checks every resource the skill can use (config, site, robots.txt, sitemaps, AI crawler access with the deciding robots.txt line, Search ' +
    'Console, GA4, IndexNow, Bing Webmaster (used by bing-export/backlinks), PageSpeed, SERP API, AI engine keys and models for geo-track, ' +
    'optional paid providers and their monthly spend, freshness of the Google update / data-anomaly ledger, repo, secrets hygiene, llms.txt) ' +
    'and prints step-by-step fixes for anything missing. Read-only.',
  spec: SPEC,
  examples: ['node scripts/check-resources.mjs', 'node scripts/check-resources.mjs --json > readiness.json', 'node scripts/check-resources.mjs --skip bing,serp,geo_engines,providers'],
  notes: ['Exit code is 0 even when items are missing; use the JSON "status" fields to gate automation.'],
});

const ADC_LOGIN = `gcloud auth application-default login --scopes=${[SCOPES.gscRead, SCOPES.ga4Read, 'https://www.googleapis.com/auth/cloud-platform'].join(',')}`;
const ANSWER_BOTS = ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User', 'Claude-SearchBot', 'Claude-User', 'Applebot', 'DuckAssistBot'];
const TRAINING_BOTS = ['GPTBot', 'Google-Extended', 'ClaudeBot', 'CCBot', 'Applebot-Extended', 'meta-externalagent', 'Bytespider', 'Amazonbot'];
const CONTROL_TOKENS = new Set(['Google-Extended', 'Applebot-Extended']);
const blockedWithLine = (robots, bots) => bots.filter((b) => !robotsAllows(robots, b, '/')).map((b) => {
  const d = robotsDecision(robots, b, '/');
  return `${b}${d.rule ? ` (line ${d.rule.line})` : ''}${CONTROL_TOKENS.has(b) ? ' [control token]' : ''}`;
});

function credentialSteps(ws) {
  return [
    'Google Cloud Console -> select/create a project -> APIs & Services -> Library -> enable "Google Search Console API" (and "Google Analytics Data API" for GA4).',
    'IAM & Admin -> Service Accounts -> Create service account (no project roles needed) -> Keys -> Add key -> JSON. Keep the file private.',
    `${scriptCmd('init.mjs')} --workspace ${ws.dir} --credentials /path/to/key.json  (copies it into secrets/ with chmod 600)`,
    'Search Console -> Settings -> Users and permissions -> Add user -> paste the service account email -> Restricted (read-only) or Full (needed for sitemap submit).',
    `No service account? Use gcloud instead: ${ADC_LOGIN}`,
  ];
}

export async function runChecks(ws, flags) {
  const items = [];
  const add = (id, title, status, detail, fix = [], optional = false) => {
    items.push({ id, title, status, detail, fix, optional });
  };
  const skip = new Set(flags.skip || []);
  const fetchOpts = { userAgent: flags.userAgent || DEFAULT_UA, timeoutMs: 20000 };
  const cfg = ws.config;

  // config
  if (!ws.exists) {
    add('config', 'Workspace config', 'missing', `No config.json in ${ws.dir}`, [`${scriptCmd('init.mjs')} --workspace ${ws.dir} --url https://your-site.com`]);
    return finish(items);
  }
  let siteUrl = '';
  try {
    siteUrl = ws.siteUrl();
    add('config', 'Workspace config', 'ok', `${ws.configPath} (site ${siteUrl}, timezone ${ws.timezone()})`);
  } catch (e) {
    add('config', 'Workspace config', 'missing', e.message, [`${scriptCmd('init.mjs')} --workspace ${ws.dir} --url https://your-site.com`]);
    return finish(items);
  }
  const origin = new URL(siteUrl).origin;
  const online = !flags.offline;

  // site
  let robots = null;
  if (online && !skip.has('site')) {
    const res = await fetchPage(siteUrl, fetchOpts);
    if (res.error || res.status >= 400 || res.status === 0) {
      add('site', 'Site reachable', 'error', `${siteUrl} -> ${res.error || `HTTP ${res.status}`}`, [
        'Check site.url in config.json (protocol, www vs non-www).',
        res.status === 403 || res.status === 503 ? 'A firewall/bot protection may block unknown clients: allowlist this crawler or pass --user-agent with a browser UA.' : 'Make sure the site is up and publicly reachable.',
      ]);
    } else {
      const notes = [];
      if (res.chain.length) notes.push(`redirects to ${res.finalUrl}${new URL(res.finalUrl).host !== new URL(siteUrl).host ? ' (different host: update site.url)' : ''}`);
      const page = parseHtml(res.body || '', res.finalUrl);
      const xr = robotsTokens(res.headers['x-robots-tag']);
      const noindex = page.robotsNoindex || xr.includes('noindex') || xr.includes('none');
      if (page.canonical && page.canonical.replace(/\/$/, '') !== res.finalUrl.replace(/\/$/, '')) notes.push(`homepage canonical points to ${page.canonical}`);
      if (noindex) {
        add('site', 'Site reachable', 'error', `Homepage is noindex (${page.robots.join(',') || res.headers['x-robots-tag']})`, ['Remove the noindex directive (meta robots or X-Robots-Tag) from the homepage unless the site must stay hidden.']);
      } else add('site', 'Site reachable', 'ok', `HTTP ${res.status} in ${res.timeMs}ms${notes.length ? `; ${notes.join('; ')}` : ''}`);
    }
  }

  // robots.txt + AI crawlers
  if (online && !skip.has('robots')) {
    const r = await fetchRobots(origin, fetchOpts);
    robots = r.robots;
    if (r.error) add('robots', 'robots.txt', 'error', `${origin}/robots.txt -> ${r.error}`, ['Make sure /robots.txt returns 200 (or 404). 5xx responses make Google pause crawling.']);
    else if (r.status >= 500) add('robots', 'robots.txt', 'error', `HTTP ${r.status}`, ['robots.txt returning 5xx makes Googlebot stop crawling the site. Fix the server response.']);
    else if (r.status >= 400) {
      add('robots', 'robots.txt', 'missing', `HTTP ${r.status} (crawlers treat this as "allow everything")`, ['Create /robots.txt with at least:', 'User-agent: *', 'Allow: /', `Sitemap: ${origin}/sitemap.xml`]);
    } else if (!robotsAllows(robots, 'Googlebot', '/') && !robotsAllows(robots, '*', '/')) {
      add('robots', 'robots.txt', 'error', 'Disallow: / blocks all crawlers', ['Remove "Disallow: /" for User-agent: * unless the site must stay out of search.']);
    } else add('robots', 'robots.txt', 'ok', `${robots.groups.length} groups, ${robots.sitemaps.length} Sitemap lines`);

    if (!skip.has('ai_crawlers') && robots) {
      const blockedAnswer = blockedWithLine(robots, ANSWER_BOTS);
      const blockedTraining = blockedWithLine(robots, TRAINING_BOTS);
      const detail = `answer/search bots blocked: ${blockedAnswer.join(', ') || 'none'}; training-only bots blocked: ${blockedTraining.join(', ') || 'none'} (policy choice; Google-Extended and Applebot-Extended are control tokens, not crawlers, and do not affect Search)`;
      if (blockedAnswer.length) {
        add('ai_crawlers', 'Search & AI answer crawlers', 'error', detail, [
          `Allow the retrieval bots in robots.txt (they fetch pages to cite them in answers): ${blockedAnswer.join(', ')}. See which line decides with: ${scriptCmd('crawl-site.mjs')} --robots-check /`,
          'Blocking training bots (GPTBot, Google-Extended, ClaudeBot, CCBot) does not remove you from AI search answers; blocking OAI-SearchBot/PerplexityBot/Claude-SearchBot/Bingbot does.',
          'Also check CDN/WAF bot rules (e.g. "block AI bots" toggles), which robots.txt cannot reveal.',
        ]);
      } else add('ai_crawlers', 'Search & AI answer crawlers', 'ok', detail);
    }
  }

  // sitemaps
  if (online && !skip.has('sitemaps')) {
    const found = await discoverSitemaps(origin, robots, fetchOpts);
    if (!found.length) {
      add('sitemaps', 'XML sitemaps', 'missing', 'No Sitemap: line in robots.txt and nothing at /sitemap.xml, /sitemap_index.xml or /wp-sitemap.xml', [
        'Generate an XML sitemap of canonical, indexable 200 URLs (most CMSs and frameworks have a plugin or built-in option).',
        `Reference it in robots.txt: Sitemap: ${origin}/sitemap.xml`,
        `Submit it in Search Console -> Sitemaps, or run ${scriptCmd('indexing.mjs')} sitemap-submit`,
      ]);
    } else {
      const col = await collectSitemapUrls(found, { fetchOpts, maxSitemaps: 20, maxUrls: 50000 });
      const bad = col.sitemaps.filter((s) => s.error);
      const hostOfLoc = (loc) => {
        try {
          return bareHost(new URL(loc).hostname);
        } catch {
          return null;
        }
      };
      const invalid = col.urls.filter((u) => hostOfLoc(u.loc) === null).length;
      const foreign = col.urls.filter((u) => hostOfLoc(u.loc) !== null && hostOfLoc(u.loc) !== bareHost(new URL(origin).hostname)).length;
      const withLastmod = col.urls.filter((u) => u.lastmod).length;
      const detail = `${col.sitemaps.length} sitemap file(s), ${col.urls.length}${col.truncated ? '+' : ''} URLs, lastmod on ${col.urls.length ? Math.round((withLastmod / col.urls.length) * 100) : 0}%${foreign ? `, ${foreign} URLs on another host` : ''}${invalid ? `, ${invalid} invalid/relative <loc> values` : ''}`;
      if (bad.length || !col.urls.length || invalid) {
        add('sitemaps', 'XML sitemaps', 'error', `${detail}; problems: ${bad.map((b) => `${b.url}: ${b.error}`).join('; ') || 'no URLs found'}`, [
          'Fix the failing sitemap files (they must return 200 with <urlset> or <sitemapindex>); every <loc> must be an absolute URL.',
          'Only list canonical, indexable URLs on the same host as the property.',
        ]);
      } else add('sitemaps', 'XML sitemaps', 'ok', detail);
    }
  }

  // credentials file hygiene
  const credPath = flags.credentials ? path.resolve(flags.credentials) : ws.resolveFile(cfg.gsc.credentialsFile);
  let clientEmail = '';
  if (!skip.has('credentials')) {
    if (credPath && fs.existsSync(credPath)) {
      let json = {};
      try {
        json = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      } catch {
        /* reported below */
      }
      clientEmail = json.client_email || '';
      const mode = fs.statSync(credPath).mode & 0o777;
      if (!['service_account', 'authorized_user'].includes(json.type)) {
        add('credentials', 'Google credentials file', 'error', `${credPath} is not a service-account JSON`, credentialSteps(ws));
      } else if (mode & 0o077) {
        add('credentials', 'Google credentials file', 'error', `${credPath} is readable by other users (mode ${mode.toString(8)})`, [`chmod 600 "${credPath}"`]);
      } else add('credentials', 'Google credentials file', 'ok', `${json.type}${clientEmail ? ` ${clientEmail}` : ''} (mode ${mode.toString(8)})`);
    } else if (!flags.accessToken) {
      add('credentials', 'Google credentials file', 'missing', credPath ? `Not found: ${credPath} (gcloud fallback will be tried)` : 'No credentials file configured', credentialSteps(ws));
    }
  }

  // Search Console
  if (online && !skip.has('gsc')) {
    let siteProp = '';
    try {
      siteProp = validateSiteUrl(flags.site || cfg.gsc.siteUrl);
    } catch (e) {
      add('gsc', 'Search Console access', 'missing', e.message, [`${scriptCmd('init.mjs')} --workspace ${ws.dir} --gsc-site sc-domain:${bareHost(new URL(origin).hostname)}`, ...[].concat(e.hint || [])]);
    }
    if (siteProp) {
      try {
        const gsc = gscClient(ws, flags);
        const sites = await gsc.listSites();
        const who = gsc.provider.info.clientEmail || clientEmail || 'the credentials';
        const entry = sites.find((s) => s.siteUrl === siteProp);
        if (!entry) {
          const cands = propertyCandidates(siteProp);
          const visible = sites.map((s) => s.siteUrl);
          const match = visible.find((v) => cands.includes(v));
          add('gsc', 'Search Console access', 'error', `${who} cannot see property "${siteProp}". Visible: ${visible.join(', ') || 'none'}`, [
            match ? `Use the property it can see: ${scriptCmd('init.mjs')} --workspace ${ws.dir} --gsc-site ${match} --force` : `Search Console -> Settings -> Users and permissions -> Add user -> ${who} (Restricted for read-only, Full for sitemap submit).`,
            'Domain properties are "sc-domain:example.com"; URL-prefix properties must match protocol, host and trailing slash exactly.',
            'If you just added the user, wait a minute and re-run.',
          ]);
        } else if (entry.permissionLevel === 'siteUnverifiedUser') {
          add('gsc', 'Search Console access', 'error', `${who} is listed but unverified for ${siteProp}`, ['Add it as a user from an owner account in Search Console -> Settings -> Users and permissions.']);
        } else {
          const latest = await gsc.latestFinalDate();
          const write = ['siteOwner', 'siteFullUser'].includes(entry.permissionLevel);
          add('gsc', 'Search Console access', 'ok', `${siteProp} as ${entry.permissionLevel} via ${gsc.provider.info.source}; final data through ${latest} (PT)${write ? '' : '; read-only (sitemap submit needs Full or Owner)'}`);
        }
      } catch (e) {
        add('gsc', 'Search Console access', e instanceof UserError && /No Google credentials/.test(e.message) ? 'missing' : 'error', e.message, [].concat(e.hint || []).concat(e.status ? [] : credentialSteps(ws)));
      }
    }
  }

  // GA4
  if (online && !skip.has('ga4')) {
    if (!cfg.ga4.propertyId) {
      add('ga4', 'GA4 Data API access', 'missing', 'ga4.propertyId is not set', [
        'GA4 -> Admin -> Property details: copy the numeric Property ID (not the G-XXXX Measurement ID).',
        `${scriptCmd('init.mjs')} --workspace ${ws.dir} --ga4-property <id>`,
        'GA4 -> Admin -> Property access management -> + -> Add users -> the service account email -> Viewer.',
        'Enable "Google Analytics Data API" in the service account\'s Cloud project.',
      ]);
    } else {
      try {
        const ga = ga4Client(ws, flags);
        const r = await ga.runReport({ dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }], metrics: [{ name: 'sessions' }] }, { maxRows: 1 });
        const tz = r.metadata.timeZone || '?';
        const sessions = r.records[0] ? r.records[0].sessions : 0;
        const tzNote = tz !== '?' && tz !== ws.timezone() ? `; NOTE: differs from site.timezone ${ws.timezone()}` : '';
        add('ga4', 'GA4 Data API access', 'ok', `property ${ga.propertyId}, time zone ${describeTz(tz)}, ${sessions} sessions in the last 7 days${tzNote}`);
      } catch (e) {
        add('ga4', 'GA4 Data API access', 'error', e.message, [].concat(e.hint || []));
      }
    }
  }

  // IndexNow
  if (!skip.has('indexnow')) {
    const keyPath = ws.resolveFile(cfg.indexnow.keyFile);
    const key = keyPath && fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8').trim() : process.env.INDEXNOW_KEY || '';
    const steps = [
      'Generate a key: node -e "console.log(require(\'crypto\').randomBytes(16).toString(\'hex\'))"',
      `Publish a text file at ${origin}/<key>.txt containing only the key, and deploy it.`,
      `${scriptCmd('init.mjs')} --workspace ${ws.dir} --indexnow-key-file <file-with-key> --indexnow-key-location ${origin}/<key>.txt`,
    ];
    if (!key) add('indexnow', 'IndexNow key', 'missing', 'No key file (indexnow.keyFile) and no $INDEXNOW_KEY', steps, true);
    else if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) add('indexnow', 'IndexNow key', 'error', 'Key has an invalid format (8-128 chars of a-z A-Z 0-9 -)', steps, true);
    else if (online) {
      const loc = cfg.indexnow.keyLocation || `${origin}/${key}.txt`;
      const res = await fetchPage(loc, fetchOpts);
      const body = String(res.body || '').trim();
      if (bareHost(new URL(loc).hostname) !== bareHost(new URL(origin).hostname)) {
        add('indexnow', 'IndexNow key', 'error', `keyLocation ${loc} is on a different host than the site`, ['The key file must be served from the same host as the URLs you submit.'], true);
      } else if (res.status === 200 && body === key) add('indexnow', 'IndexNow key', 'ok', `key file live at ${loc}`, [], true);
      else add('indexnow', 'IndexNow key', 'error', `${loc} -> ${res.error || `HTTP ${res.status}`}${res.status === 200 ? ' but content does not match the key' : ''}`, [steps[1]], true);
    } else add('indexnow', 'IndexNow key', 'ok', 'key present (not verified offline)', [], true);
  }

  // Bing Webmaster
  if (!skip.has('bing')) {
    const envName = cfg.bing.apiKeyEnv || 'BING_WEBMASTER_API_KEY';
    const key = process.env[envName];
    const steps = [
      'https://www.bing.com/webmasters -> add your site (Import from Google Search Console is fastest).',
      'Settings (gear icon) -> API access -> API key -> Generate.',
      `Keep it out of files: export ${envName}=<key> in your shell profile or secret manager.`,
      `${scriptCmd('init.mjs')} --workspace ${ws.dir} --bing-site ${origin}/`,
    ];
    if (!key) add('bing', 'Bing Webmaster API', 'missing', `$${envName} is not set (bing-export.mjs: Bing traffic, queries, crawl errors, inbound links and keyword demand; backlinks.mjs uses its link list)`, steps, true);
    else if (online && cfg.bing.siteUrl) {
      try {
        const res = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20000) });
        const data = res.ok ? await res.json() : null;
        const sites = data && Array.isArray(data.d) ? data.d : [];
        const target = bareHost(new URL(cfg.bing.siteUrl).hostname);
        const hit = sites.find((s) => bareHost(new URL(s.Url).hostname) === target);
        if (!res.ok) add('bing', 'Bing Webmaster API', 'error', `API key rejected (HTTP ${res.status})`, steps.slice(1), true);
        else if (!hit) add('bing', 'Bing Webmaster API', 'error', `Key works but ${cfg.bing.siteUrl} is not in this account (${sites.length} sites)`, [steps[0]], true);
        else {
          const exported = ws.listData('bing', /-(traffic|queries|links)\.json$/).length > 0;
          add('bing', 'Bing Webmaster API', 'ok', `${hit.Url}${hit.IsVerified === false ? ' (NOT verified)' : ''}${exported ? '' : `; nothing exported yet: ${scriptCmd('bing-export.mjs')} all`}`, [], true);
        }
      } catch (e) {
        add('bing', 'Bing Webmaster API', 'error', `Could not reach the Bing API (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`, [], true);
      }
    } else add('bing', 'Bing Webmaster API', 'ok', `$${envName} is set${cfg.bing.siteUrl ? '' : ' (set bing.siteUrl to verify it)'}`, [], true);
  }

  // PageSpeed + SERP keys
  if (!skip.has('pagespeed')) {
    const env = cfg.pagespeed.apiKeyEnv || 'PAGESPEED_API_KEY';
    if (process.env[env]) add('pagespeed', 'PageSpeed Insights key', 'ok', `$${env} is set`, [], true);
    else {
      add('pagespeed', 'PageSpeed Insights key', 'missing', `$${env} is not set (PSI still works without a key, but slowly and with low quota)`, [
        'Cloud Console -> APIs & Services -> Library -> enable "PageSpeed Insights API".',
        'Credentials -> Create credentials -> API key -> restrict it to the PageSpeed Insights API.',
        `export ${env}=<key>`,
      ], true);
    }
  }
  if (!skip.has('serp')) {
    const env = (cfg.serp && cfg.serp.apiKeyEnv) || 'BRAVE_SEARCH_API_KEY';
    if (process.env[env]) add('serp', 'SERP API key (Brave)', 'ok', `$${env} is set (not validated; run serp-snapshot.mjs to test)`, [], true);
    else {
      add('serp', 'SERP API key (Brave)', 'missing', `$${env} is not set (only needed for serp-snapshot.mjs)`, [
        'Create an account at https://api-dashboard.search.brave.com/ and subscribe to a Search plan (a free tier exists).',
        'API Keys -> Add API key.',
        `export ${env}=<key>; optionally set serp.country / serp.lang via init.mjs --serp-country US --serp-lang en`,
      ], true);
    }
  }

  // AI engines for geo-track (optional, metered)
  if (!skip.has('geo_engines')) {
    const geo = cfg.geo || {};
    const rows = AI_ENGINE_PROVIDERS.map((name) => {
      const c = credentialStatus(ws, name);
      const model = (geo.models || {})[name] || '';
      const blockedByTerms = name === 'gemini' && !geo.allowGeminiGrounding;
      return { name, key: c.ok, env: c.envs[0], model, runnable: c.ok && Boolean(model) && !blockedByTerms, blockedByTerms };
    });
    const runnable = rows.filter((r) => r.runnable).map((r) => r.name);
    const detail = rows.map((r) => `${r.name}: ${r.key ? 'key set' : `$${r.env} not set`}${r.model ? `, model ${r.model}` : ', no model in geo.models'}${r.blockedByTerms ? ', disabled (geo.allowGeminiGrounding=false)' : ''}`).join('; ');
    if (runnable.length) add('geo_engines', 'AI engines for geo-track', 'ok', `runnable: ${runnable.join(', ')} | ${detail}`, [], true);
    else {
      add('geo_engines', 'AI engines for geo-track', 'missing', `no engine has both a key and a model (${detail}); manual tracking still works: ${scriptCmd('geo-track.mjs')} --manual`, [
        'Pick one or more engines and create API keys: OpenAI https://platform.openai.com/api-keys, Perplexity https://www.perplexity.ai/account/api, Anthropic https://console.anthropic.com/settings/keys.',
        'export OPENAI_API_KEY=<key> (or PERPLEXITY_API_KEY / ANTHROPIC_API_KEY); keys stay in the environment, never in config.json.',
        `Set the model ids you want to measure (from each provider's model list) and a budget: ${scriptCmd('init.mjs')} --workspace ${ws.dir} --geo-model openai=<model-id> --provider openai --provider-budget openai=20`,
        `Dry-run first (default, no calls): ${scriptCmd('geo-track.mjs')}; then add --run.`,
        'Gemini grounding is off by default: the Gemini API terms restrict storing and analysing grounded results.',
      ], true);
    }
  }

  // first-party AI visibility reports (no API: manual UI exports imported by ai-reports-import.mjs)
  if (!skip.has('ai_reports')) {
    const parts = [];
    let waiting = 0;
    let newest = '';
    for (const [dir, label] of [['gsc/ai-features', 'Search Console Generative AI'], ['bing/ai-performance', 'Bing AI Performance']]) {
      const inbox = ws.path('data', dir, 'inbox');
      const files = fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((f) => !f.startsWith('.') && /\.(csv|tsv|zip|txt)$/i.test(f)) : [];
      let imports = [];
      try {
        imports = JSON.parse(fs.readFileSync(ws.path('data', dir, 'imports.json'), 'utf8')).imports || [];
      } catch {
        imports = [];
      }
      const last = imports.map((i) => String(i.importedAt || '').slice(0, 10)).sort().pop() || '';
      if (last > newest) newest = last;
      waiting += files.length;
      parts.push(`${label}: ${imports.length ? `last import ${last}` : 'never imported'}${files.length ? `, ${files.length} file(s) waiting in ${dir}/inbox/` : ''}`);
    }
    const stale = !newest || diffDays(newest, ws.today()) > 35;
    if (waiting) add('ai_reports', 'AI visibility reports (GSC + Bing)', 'missing', parts.join('; '), [`${scriptCmd('ai-reports-import.mjs')}   (imports the files waiting in the inboxes)`], true);
    else if (stale) {
      add('ai_reports', 'AI visibility reports (GSC + Bing)', 'missing', parts.join('; '), [
        'Search Console -> Performance -> Generative AI (Search; also Discover if you have it) -> Export -> Download CSV; put the zip in data/gsc/ai-features/inbox/.',
        'Bing Webmaster Tools -> AI Performance -> Download (CSV) for the trend, pages and grounding queries; put the files in data/bing/ai-performance/inbox/.',
        `${scriptCmd('ai-reports-import.mjs')}   (monthly; neither report has an API)`,
      ], true);
    } else add('ai_reports', 'AI visibility reports (GSC + Bing)', 'ok', parts.join('; '), [], true);
  }

  // optional paid data providers (no built-in adapters; scripts never call MCP servers)
  if (!skip.has('providers')) {
    const configured = Object.keys(cfg.providers || {}).filter((n) => !n.startsWith('_comment'));
    if (!configured.length) {
      add('providers', 'Optional paid providers', 'ok', 'none configured (not needed: Search Console, Bing Webmaster and Brave cover the core work)', [], true);
    } else {
      const parts = [];
      const month = ws.today().slice(0, 7);
      for (const name of configured) {
        const s = providerSettings(ws, name);
        const c = credentialStatus(ws, name);
        const spent = monthSpend(ws, name, month).usd;
        const kind = PROVIDERS[name] ? PROVIDERS[name].kind : 'unknown';
        parts.push(`${name} (${kind}${s.adapter === false ? ', no built-in adapter: import CSV exports or use its MCP server from the agent' : ''}): ${c.ok ? 'credentials set' : `missing ${c.missing.map((e) => `$${e}`).join(', ') || 'apiKeyEnv'}`}${s.monthlyBudgetUSD !== null ? `, spent $${spent.toFixed(2)} of $${s.monthlyBudgetUSD.toFixed(2)} this month` : spent ? `, spent $${spent.toFixed(2)} this month (no monthly budget set)` : ''}`);
      }
      const missing = configured.filter((n) => !credentialStatus(ws, n).ok);
      add('providers', 'Optional paid providers', missing.length ? 'missing' : 'ok', parts.join('; '), missing.length ? [`export the missing environment variables (${missing.join(', ')}), or remove the provider from config.providers`, 'Budgets: config.providers.<name>.monthlyBudgetUSD; spend is logged in logs/spend.csv.'] : [], true);
    }
  }

  // Google updates / Search Console anomaly ledger freshness
  if (!skip.has('events')) {
    const age = ledgerAgeDays(gscToday());
    const cache = statusCacheFile(ws);
    let refreshedAge = null;
    if (fs.existsSync(cache)) {
      try {
        refreshedAge = Math.max(0, diffDays(JSON.parse(fs.readFileSync(cache, 'utf8')).fetchedAt.slice(0, 10), gscToday()));
      } catch {
        refreshedAge = null;
      }
    }
    const freshest = [age, refreshedAge].filter((x) => x !== null).sort((a, b) => a - b)[0];
    const detail = `bundled ledger verified ${age === null ? '?' : `${age} day(s) ago`}${refreshedAge === null ? '; dashboard incidents never refreshed into this workspace' : `; dashboard incidents refreshed ${refreshedAge} day(s) ago`}`;
    if (freshest !== undefined && freshest > 30) {
      add('events', 'Google update & data-anomaly ledger', 'missing', detail, [`${scriptCmd('search-events.mjs')} refresh   (newer Google updates; Search Console data anomalies still need a manual look at https://support.google.com/webmasters/answer/6211453)`], true);
    } else add('events', 'Google update & data-anomaly ledger', 'ok', detail, [], true);
  }

  // repo
  if (!skip.has('repo')) {
    const repo = cfg.repo.path ? ws.resolveFile(cfg.repo.path, { prefer: 'project' }) : '';
    const steps = [`${scriptCmd('init.mjs')} --workspace ${ws.dir} --repo /path/to/site-repo --content-glob "content/**/*.md" --url-template "${origin}/blog/{slug}/"`];
    if (!repo) add('repo', 'Site source repo', 'missing', 'repo.path not set (content-audit and indexing --changed-since need it)', steps, true);
    else if (!fs.existsSync(repo)) add('repo', 'Site source repo', 'error', `repo.path does not exist: ${repo}`, steps, true);
    else {
      const files = cfg.repo.contentGlobs.length ? globFiles(cfg.repo.contentGlobs, { cwd: repo }) : [];
      const isGit = fs.existsSync(path.join(repo, '.git'));
      const detail = `${repo}${isGit ? ' (git)' : ' (not a git repo)'}; ${cfg.repo.contentGlobs.length ? `${files.length} content files match` : 'no contentGlobs set'}${cfg.repo.urlTemplate ? '' : '; no urlTemplate'}`;
      if (cfg.repo.contentGlobs.length && !files.length) add('repo', 'Site source repo', 'error', detail, ['Fix repo.contentGlobs (paths are relative to repo.path).'], true);
      else add('repo', 'Site source repo', 'ok', detail, [], true);
    }
  }

  // secrets hygiene
  if (!skip.has('secrets')) {
    let root = '';
    try {
      root = execFileSync('git', ['-C', ws.dir, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      /* not a repo */
    }
    if (root) {
      const wsReal = fs.existsSync(ws.dir) ? fs.realpathSync(ws.dir) : ws.dir;
      const probe = path.join(wsReal, 'secrets', 'probe.json');
      let ignored = false;
      try {
        execFileSync('git', ['-C', root, 'check-ignore', '-q', probe], { stdio: 'ignore' });
        ignored = true;
      } catch {
        ignored = false;
      }
      let tracked = '';
      try {
        tracked = execFileSync('git', ['-C', root, 'ls-files', path.join(wsReal, 'secrets')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch {
        /* ignore */
      }
      if (tracked) {
        add('secrets', 'Secrets kept out of git', 'error', `Tracked by git: ${tracked.split('\n').join(', ')}`, [
          `git -C "${root}" rm --cached -r "${path.relative(root, path.join(wsReal, 'secrets'))}"`,
          'Rotate every key that was committed (delete the service-account key and create a new one); history keeps the old key.',
        ]);
      } else if (!ignored) {
        add('secrets', 'Secrets kept out of git', 'error', `${path.join(ws.dir, 'secrets')} is not gitignored`, [`Add "${path.relative(root, path.join(wsReal, 'secrets'))}/" to ${path.join(root, '.gitignore')}`]);
      } else add('secrets', 'Secrets kept out of git', 'ok', 'secrets/ is gitignored and untracked');
    } else add('secrets', 'Secrets kept out of git', 'ok', 'workspace is not inside a git repository');
  }

  // llms.txt (GEO, optional)
  if (online && !skip.has('llms_txt')) {
    const res = await fetchPage(`${origin}/llms.txt`, fetchOpts);
    if (res.status === 200 && !/<html/i.test(String(res.body || '').slice(0, 500))) add('llms_txt', 'llms.txt (optional, GEO)', 'ok', `${origin}/llms.txt (${res.bytes} bytes)`, [], true);
    else {
      add('llms_txt', 'llms.txt (optional, GEO)', 'missing', `${origin}/llms.txt -> ${res.error || `HTTP ${res.status}`}${res.status === 200 ? ' (HTML, probably a soft 404)' : ''}`, [
        'Optional: publish /llms.txt (Markdown: site summary + links to the most useful pages). Cheap to add; no major engine has confirmed using it, so do not expect ranking effects.',
      ], true);
    }
  }
  return finish(items);
}

const PRIORITY = ['config', 'site', 'robots', 'sitemaps', 'credentials', 'gsc', 'ai_crawlers', 'secrets', 'ga4', 'indexnow', 'bing', 'events', 'repo', 'pagespeed', 'serp', 'ai_reports', 'geo_engines', 'providers', 'llms_txt'];

function finish(items) {
  const order = (id) => (PRIORITY.indexOf(id) === -1 ? 99 : PRIORITY.indexOf(id));
  const blocking = items.filter((i) => i.status !== 'ok' && !i.optional).sort((a, b) => order(a.id) - order(b.id));
  const optional = items.filter((i) => i.status !== 'ok' && i.optional).sort((a, b) => order(a.id) - order(b.id));
  let nextAction = 'All required resources are ready. Next: run gsc-export.mjs and gsc-opportunities.mjs.';
  if (blocking.length) nextAction = `${blocking[0].title}: ${blocking[0].fix[0] || blocking[0].detail}`;
  else if (optional.length) nextAction = `Required resources are ready. Optional next: ${optional[0].title}: ${optional[0].fix[0] || optional[0].detail}`;
  return { items, nextAction };
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags, { requireConfig: false });
  const result = await runChecks(ws, flags);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  out(`Workspace: ${ws.dir}\n`);
  out(textTable(['STATUS', 'CHECK', 'DETAIL'], result.items.map((i) => [i.status.toUpperCase() + (i.optional && i.status !== 'ok' ? ' (optional)' : ''), i.title, i.detail.length > 140 ? `${i.detail.slice(0, 137)}...` : i.detail])));
  const todo = result.items.filter((i) => i.status !== 'ok' && i.fix.length);
  if (todo.length) {
    out('\nHow to fix:');
    for (const i of todo) {
      out(`\n[${i.id}] ${i.title}${i.optional ? ' (optional)' : ''}`);
      i.fix.forEach((step, n) => out(`  ${n + 1}. ${step}`));
    }
  }
  out(`\nNext action: ${result.nextAction}`);
  return 0;
}

runMain(import.meta.url, main);
