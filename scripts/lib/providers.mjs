// Optional metered/paid API providers: credentials by environment-variable NAME (values are never printed or
// stored), per-run call caps, monthly USD budgets and a spend ledger (logs/spend.csv).
// Scripts never call MCP servers; MCP tools are used by the agent, outside scripts.
import fs from 'node:fs';
import { UserError, appendText } from './util.mjs';
import { readCsvFile } from './csv.mjs';

/**
 * Known providers. kind "ai-engine" = used by geo-track.mjs; kind "data" = optional third-party data with no
 * built-in adapter (export a CSV from the tool and import it, or let the agent use the provider's MCP server).
 * perCallUSD values are rough planning estimates only (search tool fee + typical tokens); set
 * config.providers.<name>.perCallUSD from the provider's current price list.
 */
export const PROVIDERS = {
  openai: {
    label: 'OpenAI Responses API (web search tool)',
    kind: 'ai-engine',
    apiKeyEnv: 'OPENAI_API_KEY',
    perCallUSD: 0.03,
    signup: 'https://platform.openai.com/api-keys',
    usedBy: ['geo-track.mjs'],
  },
  perplexity: {
    label: 'Perplexity API (search-grounded answers)',
    kind: 'ai-engine',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    perCallUSD: 0.015,
    signup: 'https://www.perplexity.ai/account/api',
    usedBy: ['geo-track.mjs'],
  },
  gemini: {
    label: 'Gemini API (Grounding with Google Search)',
    kind: 'ai-engine',
    apiKeyEnv: 'GEMINI_API_KEY',
    perCallUSD: 0.04,
    signup: 'https://aistudio.google.com/apikey',
    usedBy: ['geo-track.mjs'],
    note: 'The Gemini API terms restrict storing and analysing grounded results; geo-track only uses it when geo.allowGeminiGrounding is true.',
  },
  anthropic: {
    label: 'Anthropic Messages API (web search tool)',
    kind: 'ai-engine',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    perCallUSD: 0.04,
    signup: 'https://console.anthropic.com/settings/keys',
    usedBy: ['geo-track.mjs'],
  },
  dataforseo: {
    label: 'DataForSEO',
    kind: 'data',
    loginEnv: 'DATAFORSEO_LOGIN',
    passwordEnv: 'DATAFORSEO_PASSWORD',
    adapter: false,
    offers: 'Google SERP incl. AI Overview references, keyword volume, backlinks',
    signup: 'https://app.dataforseo.com/register',
  },
  ahrefs: {
    label: 'Ahrefs API',
    kind: 'data',
    apiKeyEnv: 'AHREFS_API_KEY',
    adapter: false,
    offers: 'backlinks, referring domains, keyword difficulty and volume',
    signup: 'https://ahrefs.com/api',
  },
  semrush: {
    label: 'Semrush API',
    kind: 'data',
    apiKeyEnv: 'SEMRUSH_API_KEY',
    adapter: false,
    offers: 'keyword volume, positions, backlinks',
    signup: 'https://www.semrush.com/api-analytics/',
  },
};

export const AI_ENGINE_PROVIDERS = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].kind === 'ai-engine');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Effective settings: built-in defaults overlaid with config.providers.<name> (env var names, budgets, prices). */
export function providerSettings(ws, name) {
  const base = PROVIDERS[name] || { label: name, kind: 'data', adapter: false };
  const cfg = ((ws && ws.config && ws.config.providers) || {})[name] || {};
  const merged = { name, ...base };
  for (const [k, v] of Object.entries(cfg)) if (!k.startsWith('_comment') && v !== '' && v !== null && v !== undefined) merged[k] = v;
  merged.configured = Object.prototype.hasOwnProperty.call((ws && ws.config && ws.config.providers) || {}, name);
  merged.monthlyBudgetUSD = num(merged.monthlyBudgetUSD);
  merged.perRunBudgetUSD = num(merged.perRunBudgetUSD);
  merged.perCallUSD = num(merged.perCallUSD) ?? 0;
  return merged;
}

/** Which env vars a provider needs, and whether they are set. Never returns the values. */
export function credentialStatus(ws, name) {
  const s = providerSettings(ws, name);
  const envs = [s.apiKeyEnv, s.loginEnv, s.passwordEnv].filter(Boolean);
  const missing = envs.filter((e) => !process.env[e]);
  return { name, envs, missing, ok: envs.length > 0 && missing.length === 0 };
}

/** Credential values for a provider (only for building requests; do not log them). */
export function providerCredentials(ws, name) {
  const s = providerSettings(ws, name);
  return {
    apiKey: s.apiKeyEnv ? process.env[s.apiKeyEnv] || '' : '',
    login: s.loginEnv ? process.env[s.loginEnv] || '' : '',
    password: s.passwordEnv ? process.env[s.passwordEnv] || '' : '',
  };
}

/** Message for providers without a built-in adapter (DataForSEO, Ahrefs, Semrush, ...). */
export function notConfiguredMessage(name, { script = '' } = {}) {
  const p = PROVIDERS[name];
  const label = p ? p.label : name;
  return new UserError(`${label}: no built-in adapter${script ? ` in ${script}` : ''} (optional provider, not configured)`, {
    hint: [
      `Export the data from ${label} as CSV and import it (e.g. backlinks.mjs import --csv <file> --source ${name}).`,
      'Or let the agent use the provider\'s MCP server and save its results as JSON/CSV in the workspace. Scripts never call MCP servers.',
      p && p.offers ? `What it adds: ${p.offers}. Free sources come first: Search Console, Bing Webmaster, Brave SERP.` : 'Free sources come first: Search Console, Bing Webmaster, Brave SERP.',
    ],
  });
}

/** Throws a UserError with exact setup steps unless the provider can be called from a script. */
export function requireProvider(ws, name, { script = '' } = {}) {
  const s = providerSettings(ws, name);
  if (s.adapter === false) throw notConfiguredMessage(name, { script });
  if (s.enabled === false) throw new UserError(`Provider "${name}" is disabled in config.providers.${name}.enabled`);
  const c = credentialStatus(ws, name);
  if (!c.ok) {
    throw new UserError(`${s.label}: environment variable ${c.missing.map((e) => `$${e}`).join(', ') || '(none configured)'} is not set`, {
      hint: [
        s.signup ? `Create a key: ${s.signup}` : 'Create an API key in the provider dashboard.',
        `export ${c.missing[0] || s.apiKeyEnv || 'KEY'}=<value>   (shell profile or secret manager; never in config.json or prompts)`,
        `Optional budget: config.providers.${name} = {"apiKeyEnv": "${s.apiKeyEnv || 'ENV_NAME'}", "monthlyBudgetUSD": 20}`,
      ],
    });
  }
  return s;
}

// ---------- spend ledger ----------
export const SPEND_COLUMNS = ['date', 'month', 'provider', 'script', 'calls', 'usd', 'note'];

export function spendFile(ws) {
  return ws.path('logs', 'spend.csv');
}

/** Recorded spend (USD estimates) for a provider in a calendar month "YYYY-MM" (site time zone). */
export function monthSpend(ws, provider, month) {
  const file = spendFile(ws);
  if (!fs.existsSync(file)) return { usd: 0, calls: 0 };
  let usd = 0;
  let calls = 0;
  for (const r of readCsvFile(file, { required: false }).records) {
    if (r.provider !== provider || r.month !== month) continue;
    usd += Number(r.usd) || 0;
    calls += Number(r.calls) || 0;
  }
  return { usd, calls };
}

export function recordSpend(ws, { provider, script, calls, usd, note = '' }) {
  const file = spendFile(ws);
  const today = ws.today();
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  if (!fs.existsSync(file)) appendText(file, `${SPEND_COLUMNS.join(',')}\n`);
  appendText(file, `${[today, today.slice(0, 7), provider, script, calls, (Math.round(usd * 10000) / 10000).toFixed(4), note].map(cell).join(',')}\n`);
  return file;
}

/**
 * Cost guard for one script run against one provider.
 *   const guard = new CostGuard(ws, { provider: 'openai', script: 'geo-track.mjs', maxCalls: 100 });
 *   const plan = guard.plan(60);            // estimate before any call
 *   guard.assertPlan(plan);                 // UserError (exit 2) when over maxCalls / per-run / monthly budget
 *   guard.charge();                         // before each real call; throws once maxCalls would be exceeded
 *   guard.record('run R1');                 // append the real calls to logs/spend.csv
 */
export class CostGuard {
  constructor(ws, { provider, script = '', maxCalls = Infinity, maxUsd = null, perCallUSD = null } = {}) {
    this.ws = ws;
    this.provider = provider;
    this.script = script;
    this.settings = providerSettings(ws, provider);
    this.maxCalls = Number.isFinite(maxCalls) ? maxCalls : Infinity;
    this.maxUsd = maxUsd ?? this.settings.perRunBudgetUSD;
    this.perCallUSD = perCallUSD ?? this.settings.perCallUSD ?? 0;
    this.calls = 0;
    this.usd = 0;
  }

  month() {
    return this.ws.today().slice(0, 7);
  }

  plan(calls) {
    const usd = calls * this.perCallUSD;
    const spent = monthSpend(this.ws, this.provider, this.month());
    const budget = this.settings.monthlyBudgetUSD;
    const reasons = [];
    if (calls > this.maxCalls) reasons.push(`${calls} calls exceed the per-run cap of ${this.maxCalls} (--max-calls)`);
    if (this.maxUsd !== null && this.maxUsd !== undefined && usd > this.maxUsd) reasons.push(`estimated $${usd.toFixed(2)} exceeds the per-run budget of $${Number(this.maxUsd).toFixed(2)}`);
    if (budget !== null && budget !== undefined && spent.usd + usd > budget) reasons.push(`month ${this.month()}: $${spent.usd.toFixed(2)} already spent + $${usd.toFixed(2)} estimated > monthly budget $${budget.toFixed(2)} (config.providers.${this.provider}.monthlyBudgetUSD)`);
    return { provider: this.provider, calls, perCallUSD: this.perCallUSD, usd, monthSpentUSD: spent.usd, monthlyBudgetUSD: budget, maxCalls: this.maxCalls, ok: reasons.length === 0, reasons };
  }

  assertPlan(plan) {
    if (plan.ok) return plan;
    throw new UserError(`Cost guard (${this.provider}): ${plan.reasons.join('; ')}`, {
      exitCode: 2,
      hint: ['Lower --samples, select fewer prompts/engines, or raise the cap knowingly (--max-calls, config.providers.<name>.monthlyBudgetUSD / perRunBudgetUSD).'],
    });
  }

  charge(n = 1, usd = null) {
    if (this.calls + n > this.maxCalls) throw new UserError(`Cost guard (${this.provider}): stopping at the per-run cap of ${this.maxCalls} calls`, { exitCode: 2 });
    this.calls += n;
    this.usd += usd ?? n * this.perCallUSD;
    return this.calls;
  }

  record(note = '') {
    if (!this.calls) return null;
    return recordSpend(this.ws, { provider: this.provider, script: this.script, calls: this.calls, usd: this.usd, note });
  }
}

/** Redact secrets (env values of all known providers and generic key/token query params) from a string. */
export function redactSecrets(text, ws) {
  let s = String(text ?? '');
  const names = new Set();
  for (const name of Object.keys(PROVIDERS)) {
    const p = providerSettings(ws, name);
    for (const e of [p.apiKeyEnv, p.loginEnv, p.passwordEnv]) if (e) names.add(e);
  }
  for (const extra of ['BING_WEBMASTER_API_KEY', 'BRAVE_SEARCH_API_KEY', 'PAGESPEED_API_KEY', 'GOOGLE_OAUTH_ACCESS_TOKEN']) names.add(extra);
  if (ws && ws.config) for (const sec of ['bing', 'serp', 'pagespeed']) if (ws.config[sec] && ws.config[sec].apiKeyEnv) names.add(ws.config[sec].apiKeyEnv);
  for (const n of names) {
    const v = process.env[n];
    if (v && v.length >= 6) s = s.split(v).join(`<$${n}>`);
  }
  return s.replace(/([?&](?:api[_-]?key|apikey|key|token|access_token|sig|signature)=)[^&#\s"']+/gi, '$1<redacted>');
}
