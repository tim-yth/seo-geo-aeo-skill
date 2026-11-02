#!/usr/bin/env node
// Multi-engine AI visibility tracking (GEO): repeated, fixed-N samples per prompt and engine through official APIs
// with web search, brand mention / citation funnel with Wilson intervals, cited-domain shares; dry run by default.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, sleep, scriptCmd, normalizeUrl, SCRIPTS_DIR } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { writeCsvFile } from './lib/csv.mjs';
import { fmtPct, mdTable, textTable } from './lib/format.mjs';
import { formatInTz } from './lib/dates.mjs';
import { PROVIDERS, AI_ENGINE_PROVIDERS, CostGuard, credentialStatus, providerCredentials, providerSettings, requireProvider, redactSecrets } from './lib/providers.mjs';
import {
  GEO_COLUMNS, readGeoLog, appendGeoRows, collectPrompts, controlPromptDefs, filterPrompts, countryCode, makeTermMatcher, domainSet, sourceDomain, cleanText, excerpt,
  analyzeAnswer, summarizeSamples, groupBy, citedStability, median, domainShares, outreachCandidates, sampleRow, isYes, isMainArm, isValid, secretValues, containsSecret, clusterBootstrap,
} from './lib/geo.mjs';

export const ENGINES = ['openai', 'perplexity', 'anthropic', 'gemini'];
const ANSWER_CHARS = 4000;

const SPEC = {
  ...COMMON_FLAGS,
  run: { type: 'boolean', desc: 'Execute the plan (default: dry run that prints the plan and cost estimate, no API call)' },
  manual: { type: 'boolean', desc: 'Write a manual UI checklist (data/geo/<date>-manual-checklist.csv) instead of calling APIs' },
  engines: { type: 'csv', placeholder: 'list', desc: `Engines to use: ${ENGINES.join(', ')} (default: config geo.engines, else every engine with a key and a model)` },
  samples: { type: 'int', desc: 'Repetitions per prompt and engine, fixed in advance (default: config geo.samples, 3)' },
  'max-calls': { type: 'int', desc: 'Cap on API calls across all engines (default: config geo.maxCalls, 100); exit 2 when the plan exceeds it' },
  'prompt-id': { type: 'csv', placeholder: 'ids', desc: 'Only these prompt_id values' },
  cohort: { type: 'csv', desc: 'Only these cohorts (core, explore, ...)' },
  arm: { type: 'csv', desc: 'Only these arms (treated, control, placebo, negative; "none" = empty arm)' },
  locale: { type: 'csv', desc: 'Only these locales' },
  topic: { type: 'csv', desc: 'Only these topics' },
  limit: { type: 'int', desc: 'At most this many prompts after the filters' },
  'no-controls': { type: 'boolean', desc: 'Do not add config geo.controlPrompts as negative controls' },
  'no-append': { type: 'boolean', desc: 'Do not append rows to geo-prompts.csv (answers and summary files are still written)' },
  delay: { type: 'int', placeholder: 'ms', desc: 'Pause between API calls', default: 800 },
  timeout: { type: 'int', placeholder: 'sec', desc: 'Timeout per API call', default: 120 },
  'retry-ms': { type: 'int', desc: 'Base backoff for retries on 429/5xx (doubles per attempt, max 2 retries)', default: 2000, hidden: true },
  json: { type: 'boolean', desc: 'Print the plan (dry run) or the run summary as JSON' },
};

const HELP = formatHelp({
  usage: ['node scripts/geo-track.mjs                 # dry run: plan + cost estimate, no API call', 'node scripts/geo-track.mjs --run [--engines openai,anthropic] [--samples 3]', 'node scripts/geo-track.mjs --manual          # UI checklist for chatgpt/perplexity/gemini/... (no API)'],
  summary:
    'Asks every prompt in geo-prompts.csv (unique prompt_id; rows with template placeholders such as {category} are skipped) to each engine ' +
    'N times through official APIs with web search on (OpenAI Responses + web_search, Perplexity, Anthropic Messages + web search tool, ' +
    'Gemini + Google Search grounding only with geo.allowGeminiGrounding). Per answer: did it search, which sources it read (retrieved), which it ' +
    'cited, whether your brand is mentioned (Latin whole word, CJK substring) and recommended (heuristic), your citation and mention rank, ' +
    'competitor brands/domains and cited domains. Aggregates per engine, prompt and arm (treated / control / placebo / negative) with Wilson 95% ' +
    'intervals (plus a prompt-cluster bootstrap per engine); branded prompts are diagnostics only; failures and answers without search are counted separately, never as 0. Appends one row per ' +
    'sample to geo-prompts.csv (older 14-column files gain the missing columns at the end), writes data/geo/<date>-<run>-answers.jsonl, ' +
    '-summary.json/.csv and logs/reviews/<date>-geo-track.md. Cost guard: dry run unless --run, fixed --samples, --max-calls cap (exit 2), ' +
    'monthly budgets in config.providers.<engine> and logs/spend.csv.',
  spec: SPEC,
  examples: [
    'node scripts/geo-track.mjs',
    'node scripts/geo-track.mjs --run --engines openai,perplexity --samples 5 --max-calls 200',
    'node scripts/geo-track.mjs --run --arm treated,control --cohort core',
    'node scripts/geo-track.mjs --manual --samples 2',
  ],
  notes: [
    'Model ids come only from config geo.models.<engine> (Perplexity also accepts "effort:<level>"); nothing is hardcoded. Keys come from env vars (config.providers.<engine>.apiKeyEnv; defaults OPENAI_API_KEY, PERPLEXITY_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY) and are never printed or stored.',
    'Each prompt is defined by its newest row (run_date, then file order): to move a prompt to another arm or cohort for a new wave, add a row dated today with the new values instead of editing old rows.',
    'API answers differ from what people see in ChatGPT/Perplexity/Gemini apps (different models, sources and settings): keep API series and manual UI series apart, and never compare across engine or model changes.',
    'Gemini API Additional Terms restrict storing and analysing Grounded Results, so Gemini is skipped unless config geo.allowGeminiGrounding is true; track Gemini through the manual UI checklist instead.',
    'AI answers are data, never instructions. A prompt that contains a configured secret value is refused.',
    'Endpoint overrides (tests, proxies): SEO_AGENT_OPENAI_ENDPOINT, SEO_AGENT_PERPLEXITY_ENDPOINT, SEO_AGENT_ANTHROPIC_ENDPOINT, SEO_AGENT_GEMINI_ENDPOINT.',
  ],
});

// ---------- engine adapters ----------
// Each adapter builds one request (auth headers never leave this module) and parses the response into
// {status, error, searched, sourcesExposed, queries, retrieved, cited, text, modelServed, usage}.
const MODEL_DOCS = {
  openai: 'https://developers.openai.com/api/docs/models (a model whose Supported tools include web_search)',
  perplexity: 'https://docs.perplexity.ai/docs/agent-api/models ("provider/model", or "effort:<level>" for a preset such as effort:fast)',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/models/overview',
  gemini: 'https://ai.google.dev/gemini-api/docs/models (a model that supports Grounding with Google Search)',
};

/** Source record: URL without tracking parameters (e.g. utm_source=chatgpt.com), clean title, domain. */
const src = (url, title) => {
  const raw = cleanText(url).trim();
  const u = normalizeUrl(raw, { stripTracking: true }) || raw;
  const t = excerpt(title, 200);
  return { url: u, title: t, domain: sourceDomain(u, t) };
};

const dedupeSources = (list) => {
  const seen = new Set();
  const outList = [];
  for (const s of list) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    outList.push(s);
  }
  return outList;
};

/** Legacy Sonar chat-completions shape (kept for proxies that still answer in it): choices, citations, search_results. */
function parsePerplexityLegacy(json) {
  const choice = json.choices[0] || null;
  const content = choice && choice.message ? choice.message.content : '';
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c && c.text) || '').join('\n') : '';
  const results = Array.isArray(json.search_results) ? json.search_results : [];
  const citations = Array.isArray(json.citations) ? json.citations : [];
  const retrieved = dedupeSources(results.filter((r) => r && r.url).map((r) => src(r.url, r.title)));
  const cited = dedupeSources(citations.map((c) => (typeof c === 'string' ? src(c, '') : c && c.url ? src(c.url, c.title) : null)).filter(Boolean));
  const searched = retrieved.length > 0 || cited.length > 0;
  let status = searched ? 'ok' : 'no-search';
  let error = '';
  if (!text) {
    status = 'failed';
    error = 'empty answer';
  } else if (choice && choice.finish_reason === 'length') {
    status = 'incomplete';
    error = 'answer cut off (finish_reason=length)';
  }
  return { status, error, searched, sourcesExposed: Array.isArray(json.search_results), queries: [], retrieved, cited, text, modelServed: json.model || '', usage: json.usage || null };
}

export const ADAPTERS = {
  // OpenAI Responses API + web_search tool: https://developers.openai.com/api/docs/guides/tools-web-search
  // (sources via include web_search_call.action.sources; user_location without fields avoids the US default).
  openai: {
    endpointEnv: 'SEO_AGENT_OPENAI_ENDPOINT',
    endpoint: 'https://api.openai.com/v1/responses',
    request({ model, prompt, country, apiKey, endpoint }) {
      const tool = { type: 'web_search', user_location: country ? { type: 'approximate', country } : { type: 'approximate' } };
      return {
        url: endpoint,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: { model, input: prompt, tools: [tool], tool_choice: 'auto', include: ['web_search_call.action.sources'], store: false },
      };
    },
    parse(json) {
      const items = Array.isArray(json.output) ? json.output : [];
      const calls = items.filter((o) => o && o.type === 'web_search_call');
      const queries = [];
      const retrieved = [];
      let sourcesExposed = false;
      for (const c of calls) {
        const a = c.action || {};
        if (a.query) queries.push(cleanText(a.query));
        for (const q of Array.isArray(a.queries) ? a.queries : []) queries.push(cleanText(q));
        if (Array.isArray(a.sources)) {
          sourcesExposed = true;
          for (const s of a.sources) if (s && s.url) retrieved.push(src(s.url, s.title));
        }
        if (a.type === 'open_page' && a.url) retrieved.push(src(a.url, ''));
      }
      const texts = [];
      const cited = [];
      let refused = '';
      const messages = items.filter((o) => o && o.type === 'message');
      const finals = messages.filter((m) => m.phase === 'final_answer');
      for (const m of finals.length ? finals : messages) {
        for (const part of Array.isArray(m.content) ? m.content : []) {
          if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
          if (part.type === 'refusal' && part.refusal) refused = String(part.refusal);
          for (const an of Array.isArray(part.annotations) ? part.annotations : []) if (an && an.type === 'url_citation' && an.url) cited.push(src(an.url, an.title));
        }
      }
      const text = texts.join('\n');
      const searched = calls.length > 0;
      let status = searched ? 'ok' : 'no-search';
      let error = '';
      if (json.status && json.status !== 'completed') {
        status = json.status === 'failed' ? 'failed' : 'incomplete';
        error = (json.error && json.error.message) || (json.incomplete_details && json.incomplete_details.reason) || json.status;
      } else if (!text) {
        status = 'failed';
        error = refused ? `refusal: ${excerpt(refused, 120)}` : 'empty answer';
      }
      return { status, error, searched, sourcesExposed, queries, retrieved: dedupeSources(retrieved), cited: dedupeSources(cited), text, modelServed: json.model || '', usage: json.usage || null };
    },
  },

  // Perplexity Agent API (POST /v1/agent; Sonar chat completions support ended 2026-09-27):
  // https://docs.perplexity.ai/api-reference/agent-post, https://docs.perplexity.ai/docs/agent-api/tools/web-search
  // geo.models.perplexity = "provider/model" (e.g. a perplexity/* model) or "effort:<level>" for a preset effort level.
  perplexity: {
    endpointEnv: 'SEO_AGENT_PERPLEXITY_ENDPOINT',
    endpoint: 'https://api.perplexity.ai/v1/agent',
    request({ model, prompt, country, apiKey, endpoint }) {
      const tool = { type: 'web_search' };
      if (country) tool.user_location = { country };
      const m = /^effort:(.+)$/i.exec(String(model).trim());
      const body = { ...(m ? { effort: m[1].trim() } : { model }), input: prompt, tools: [tool], max_output_tokens: 4096 };
      return { url: endpoint, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body };
    },
    parse(json) {
      if (Array.isArray(json.choices)) return parsePerplexityLegacy(json);
      const items = Array.isArray(json.output) ? json.output : [];
      const queries = [];
      const results = [];
      for (const it of items) {
        if (!it || it.type !== 'search_results') continue;
        for (const q of Array.isArray(it.queries) ? it.queries : []) queries.push(cleanText(q));
        for (const r of Array.isArray(it.results) ? it.results : []) if (r && r.url) results.push(r);
      }
      const byId = new Map(results.filter((r) => r.id !== undefined && r.id !== null).map((r) => [String(r.id), r]));
      const texts = [];
      const cited = [];
      for (const m of items.filter((o) => o && o.type === 'message')) {
        for (const part of Array.isArray(m.content) ? m.content : []) {
          if (part.type !== 'output_text' || typeof part.text !== 'string') continue;
          texts.push(part.text);
          for (const an of Array.isArray(part.annotations) ? part.annotations : []) if (an && an.url) cited.push(src(an.url, an.title));
        }
      }
      const text = texts.join('\n');
      const annotated = cited.length > 0;
      // inline markers [1] or [web:1] refer to search result ids
      let markers = 0;
      for (const mk of text.matchAll(/\[(?:web:)?(\d{1,3})\]/g)) {
        const r = byId.get(mk[1]);
        if (r) {
          markers++;
          cited.push(src(r.url, r.title));
        }
      }
      const fetched = items.filter((o) => o && o.type === 'fetch_url_results').flatMap((o) => (Array.isArray(o.contents) ? o.contents : [])).filter((c) => c && c.url);
      const retrieved = dedupeSources([...results.map((r) => src(r.url, r.title)), ...fetched.map((c) => src(c.url, c.title))]);
      const searched = items.some((o) => o && o.type === 'search_results');
      let status = searched ? 'ok' : 'no-search';
      let error = '';
      if (json.status && json.status !== 'completed') {
        status = json.status === 'incomplete' ? 'incomplete' : 'failed';
        error = (json.error && json.error.message) || json.status;
      } else if (!text) {
        status = 'failed';
        error = 'empty answer';
      }
      // without annotations or [n] markers the answer does not say which results it used: cited = n/a, not "no"
      return { status, error, searched, sourcesExposed: searched, citationsExposed: annotated || markers > 0, queries, retrieved, cited: dedupeSources(cited), text, modelServed: [json.model, json.effort].filter(Boolean).join(' '), usage: json.usage || null };
    },
  },

  anthropic: {
    endpointEnv: 'SEO_AGENT_ANTHROPIC_ENDPOINT',
    endpoint: 'https://api.anthropic.com/v1/messages',
    // Basic web search tool: available on every Claude model and platform; the dynamic-filtering versions search from
    // inside code execution and change what "retrieved" means. Override with config geo.anthropicTool.
    tool: 'web_search_20250305',
    request({ model, prompt, country, apiKey, endpoint, toolType, history }) {
      const tool = { type: toolType || this.tool, name: 'web_search', max_uses: 5 };
      if (country) tool.user_location = { type: 'approximate', country };
      const messages = [{ role: 'user', content: prompt }, ...(history || [])];
      return {
        url: endpoint,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: { model, max_tokens: 8000, messages, tools: [tool] },
      };
    },
    parse(json) {
      const blocks = Array.isArray(json.content) ? json.content : [];
      const queries = [];
      const retrieved = [];
      const cited = [];
      const texts = [];
      const toolErrors = [];
      let okResults = 0;
      let searchCalls = 0;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'server_tool_use' && b.name === 'web_search') {
          searchCalls++;
          if (b.input && b.input.query) queries.push(cleanText(b.input.query));
        } else if (b.type === 'web_search_tool_result') {
          if (Array.isArray(b.content)) {
            okResults++;
            for (const r of b.content) if (r && r.type === 'web_search_result' && r.url) retrieved.push(src(r.url, r.title));
          } else if (b.content && b.content.type === 'web_search_tool_result_error') toolErrors.push(b.content.error_code || 'unknown');
        } else if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
          for (const c of Array.isArray(b.citations) ? b.citations : []) if (c && c.url) cited.push(src(c.url, c.title));
        }
      }
      const text = texts.join('');
      const searched = okResults > 0;
      let status = searched ? 'ok' : 'no-search';
      let error = toolErrors.length ? `web search tool error: ${[...new Set(toolErrors)].join(', ')}` : '';
      if (!searched && toolErrors.length) status = 'failed';
      if (json.stop_reason === 'refusal') {
        status = 'failed';
        error = `refusal${json.stop_details && json.stop_details.category ? ` (${json.stop_details.category})` : ''}`;
      } else if (json.stop_reason === 'max_tokens') {
        status = 'incomplete';
        error = 'answer cut off (max_tokens)';
      } else if (json.stop_reason === 'pause_turn') {
        status = 'incomplete';
        error = 'paused turn (pause_turn) not resumed';
      } else if (!text && status !== 'failed') {
        status = 'failed';
        error = 'empty answer';
      }
      return { status, error, searched, sourcesExposed: okResults > 0 || searchCalls === 0, queries, retrieved: dedupeSources(retrieved), cited: dedupeSources(cited), text, modelServed: json.model || '', usage: json.usage || null, paused: json.stop_reason === 'pause_turn', content: blocks };
    },
  },

  // Gemini generateContent + Grounding with Google Search: https://ai.google.dev/gemini-api/docs/generate-content/google-search
  // groundingChunks[].web.uri are vertexaisearch redirect URLs; web.title usually carries the source domain.
  gemini: {
    endpointEnv: 'SEO_AGENT_GEMINI_ENDPOINT',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    request({ model, prompt, apiKey, endpoint }) {
      const id = String(model).replace(/^models\//, '');
      return {
        url: `${endpoint.replace(/\/+$/, '')}/models/${encodeURIComponent(id)}:generateContent`,
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] },
      };
    },
    parse(json) {
      const cand = Array.isArray(json.candidates) ? json.candidates[0] : null;
      const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
      const text = parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
      const gm = (cand && cand.groundingMetadata) || {};
      const chunks = Array.isArray(gm.groundingChunks) ? gm.groundingChunks : [];
      // keep only the domain/title: the redirect URIs carry no information and the terms restrict collecting Links
      const chunkSources = chunks.map((c) => {
        if (!c || !c.web) return null;
        const title = excerpt(c.web.title, 200);
        return { url: '', title, domain: sourceDomain(cleanText(c.web.uri || ''), title, c.web.domain || '') };
      });
      const byDomain = (list) => {
        const seen = new Set();
        return list.filter((x) => x && x.domain && !seen.has(x.domain) && seen.add(x.domain));
      };
      const order = [];
      for (const s of Array.isArray(gm.groundingSupports) ? gm.groundingSupports : []) for (const i of s.groundingChunkIndices || []) if (!order.includes(i)) order.push(i);
      const cited = byDomain(order.map((i) => chunkSources[i]));
      const queries = (Array.isArray(gm.webSearchQueries) ? gm.webSearchQueries : []).map(cleanText);
      const searched = queries.length > 0 || chunks.length > 0;
      let status = searched ? 'ok' : 'no-search';
      let error = '';
      const finish = cand && cand.finishReason;
      if (!cand) {
        status = 'failed';
        error = (json.promptFeedback && json.promptFeedback.blockReason) ? `blocked (${json.promptFeedback.blockReason})` : 'no candidate returned';
      } else if (finish === 'MAX_TOKENS') {
        status = 'incomplete';
        error = 'answer cut off (MAX_TOKENS)';
      } else if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
        status = 'failed';
        error = `finishReason ${finish}`;
      } else if (!text) {
        status = 'failed';
        error = 'empty answer';
      }
      return { status, error, searched, sourcesExposed: chunks.length > 0 || !searched, queries, retrieved: byDomain(chunkSources), cited, text, modelServed: json.modelVersion || '', usage: json.usageMetadata || null };
    },
  },
};

// ---------- HTTP ----------
function apiErrorMessage(text) {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
    if (e && typeof e === 'object') return [e.type || e.status || e.code, e.message].filter(Boolean).join(': ');
    if (typeof e === 'string') return e;
    if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail).slice(0, 300);
    if (j.message) return j.message;
  } catch {
    /* not JSON */
  }
  return String(text || '').replace(/\s+/g, ' ').slice(0, 300);
}

/** POST JSON with retries on network errors, 429 and 5xx (max 2 retries, exponential backoff, Retry-After honoured up to 30 s). */
export async function postJson(req, { timeoutMs = 120000, retries = 2, retryMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    let text = '';
    try {
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e) {
      if (attempt < retries) {
        await sleep(retryMs * 2 ** attempt);
        continue;
      }
      return { ok: false, status: 0, error: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `timeout after ${Math.round(timeoutMs / 1000)}s` : `network error (${(e && e.cause && e.cause.code) || (e && e.message) || e})` };
    }
    if (res.ok) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, status: res.status, error: 'response is not JSON' };
      }
      return json && typeof json === 'object' && !Array.isArray(json) ? { ok: true, status: res.status, json } : { ok: false, status: res.status, error: 'response is not a JSON object' };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : retryMs * 2 ** attempt);
      continue;
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${apiErrorMessage(text)}` };
  }
}

const HTTP_HINTS = {
  401: 'The API key was rejected: check the env var named in config.providers.<engine>.apiKeyEnv.',
  403: 'The key has no access to this model or feature (web search may need to be enabled for your organization or plan).',
  404: 'Unknown model or endpoint: check config geo.models.<engine> against the provider model list.',
  429: 'Rate limited or out of credit: wait, lower --samples/--max-calls, or check the provider billing page.',
};

// ---------- engine selection and plan ----------
/** Decide which engines run: (--engines | all) ∩ config geo.engines ∩ engines with a key and a model. */
export function selectEngines(ws, flags) {
  const geo = ws.config.geo || {};
  const cfgEngines = (geo.engines || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const unknown = [...flags.engines, ...cfgEngines].map((e) => String(e).toLowerCase()).filter((e) => !ENGINES.includes(e));
  if (unknown.length) throw new UserError(`Unknown engine(s): ${[...new Set(unknown)].join(', ')}`, { hint: `Use ${ENGINES.join(', ')} (Copilot has no API: use Bing AI Performance via ai-reports-import.mjs; Google AI Overviews: manual checklist).` });
  const requested = flags.engines.map((e) => e.toLowerCase());
  let candidates = requested.length ? requested : cfgEngines.length ? cfgEngines : [...AI_ENGINE_PROVIDERS];
  const skipped = [];
  if (requested.length && cfgEngines.length) {
    for (const e of candidates.filter((x) => !cfgEngines.includes(x))) skipped.push({ engine: e, reason: 'not in config geo.engines' });
    candidates = candidates.filter((x) => cfgEngines.includes(x));
  }
  const explicit = requested.length > 0 || cfgEngines.length > 0;
  const notices = [];
  const runnable = [];
  for (const engine of [...new Set(candidates)]) {
    if (!ENGINES.includes(engine)) continue;
    if (engine === 'gemini' && geo.allowGeminiGrounding !== true) {
      const wanted = explicit || credentialStatus(ws, engine).ok;
      skipped.push({ engine, reason: wanted ? 'disabled: Gemini API terms restrict storing/analysing grounded results (set geo.allowGeminiGrounding: true only if your use is permitted)' : `no $${providerSettings(ws, engine).apiKeyEnv} (and disabled by default: Gemini API terms)` });
      if (wanted) notices.push('Gemini is not called: the Gemini API Additional Terms restrict storing, caching and analysing Grounded Results (Grounding with Google Search). Track Gemini through the manual UI checklist (--manual) instead; geo.allowGeminiGrounding: true enables it at your own responsibility.');
      continue;
    }
    const settings = providerSettings(ws, engine);
    if (settings.enabled === false) {
      skipped.push({ engine, reason: `disabled in config.providers.${engine}.enabled` });
      continue;
    }
    const cred = credentialStatus(ws, engine);
    if (!cred.ok) {
      skipped.push({ engine, reason: `no $${cred.missing[0] || settings.apiKeyEnv}` });
      continue;
    }
    requireProvider(ws, engine, { script: 'geo-track.mjs' });
    const model = String(((geo.models || {})[engine]) || '').trim();
    if (!model) {
      if (explicit) {
        throw new UserError(`config geo.models.${engine} is empty: geo-track never guesses a model id`, {
          hint: [`Pick a current model id from ${MODEL_DOCS[engine]}`, `Set it in config.json: "geo": {"models": {"${engine}": "<model id>"}}`, 'Keep the same model across runs; a model change starts a new series.'],
        });
      }
      skipped.push({ engine, reason: `no model in config geo.models.${engine} (see ${MODEL_DOCS[engine].split(' ')[0]})` });
      continue;
    }
    runnable.push({ engine, model, settings });
  }
  return { runnable, skipped, notices: [...new Set(notices)] };
}

/** Calls per engine and the budget check; reasons -> exit 2. */
export function buildPlan(ws, runnable, { prompts, samples, maxCalls }) {
  const perEngine = runnable.map((r) => {
    const guard = new CostGuard(ws, { provider: r.engine, script: 'geo-track.mjs', maxCalls });
    const plan = guard.plan(prompts * samples);
    return { ...r, guard, plan, calls: prompts * samples };
  });
  const total = perEngine.reduce((s, e) => s + e.calls, 0);
  const reasons = [];
  if (total > maxCalls) reasons.push(`${total} calls (${prompts} prompts x ${samples} samples x ${perEngine.length} engines) exceed the per-run cap of ${maxCalls} (--max-calls / config geo.maxCalls)`);
  for (const e of perEngine) for (const r of e.plan.reasons) if (!/per-run cap/.test(r)) reasons.push(`${e.engine}: ${r}`);
  return { perEngine, total, usd: perEngine.reduce((s, e) => s + e.plan.usd, 0), reasons, ok: reasons.length === 0 };
}

// ---------- manual checklist ----------
export function manualRows(prompts, engines, samples, date) {
  const rows = [];
  for (const def of prompts) {
    for (const engine of engines) {
      for (let k = 1; k <= samples; k++) {
        const row = Object.fromEntries(GEO_COLUMNS.map((c) => [c, '']));
        Object.assign(row, { run_date: date, engine, locale: def.locale, intent: def.intent, prompt: def.prompt, prompt_id: def.id, portfolio_version: def.portfolio_version, cohort: def.cohort, arm: def.arm, variant_group: def.variant_group, branded: def.branded, topic: def.topic, country: def.country, method: 'ui-manual', k: String(k) });
        rows.push(row);
      }
    }
  }
  return rows;
}

function writeManual(ws, prompts, samples, reason) {
  const engines = (ws.config.aiEngines && ws.config.aiEngines.length ? ws.config.aiEngines : ['chatgpt', 'perplexity', 'gemini', 'google-ai-overviews', 'copilot']).map(String);
  const rows = manualRows(prompts, engines, samples, ws.today());
  const file = writeCsvFile(ws.dataFile('geo', 'manual-checklist', 'csv'), rows, GEO_COLUMNS);
  if (reason) out(reason);
  out(`Manual checklist: ${prompts.length} prompt(s) x ${engines.length} engine(s) (${engines.join(', ')}) x ${samples} sample(s) = ${rows.length} row(s).`);
  out('How to fill it:');
  for (const line of [
    'Use a logged-out, clean browser profile (private window), with search/web mode ON, from the same location every time; note anything unusual in notes.',
    `Spread the ${samples} repetition(s) (column k) over different days when you can; set run_date to the day you actually asked.`,
    'mentioned yes/no; rank = position of your brand among the brands/list items; cited_url = your page that was cited; competitors = other brands named (;-separated).',
    'searched/retrieved/cited/recommended = y, n or n/a (n/a when the interface shows no sources); cited_domains = every cited domain (;-separated).',
    'accuracy (correct / partly_wrong / wrong), pricing_claim and reason are for you to judge; record the wrong claim briefly, not the whole answer.',
    `Paste the finished rows into ${path.basename(ws.config.geo.promptsFile || 'geo-prompts.csv')} (same columns). Copilot has no API: also export Bing AI Performance (ai-reports-import.mjs).`,
  ]) out(`  - ${line}`);
  out(`\nwrote ${file}`);
  return 0;
}

// ---------- reporting helpers ----------
const fmtRate = (r) => (r && r.n ? `${fmtPct(r.rate, 0)} [${fmtPct(r.low, 0)}-${fmtPct(r.high, 0)}] n=${r.n}${r.small ? '*' : ''}` : '-');
const kn = (r) => (r && r.n ? `${r.k}/${r.n}` : '-');
const armOf = (s) => (isYes(s.branded) ? 'branded' : s.arm || '(none)');

export function aggregateRun(samples, ctx) {
  const main = samples.filter(isMainArm);
  const byEngine = [...groupBy(main, (s) => s.engine)].map(([engine, list]) => {
    const prompts = [...groupBy(list, (s) => s.promptId).values()];
    return { engine, model: list[0].model, modelServed: [...new Set(list.map((s) => s.modelServed).filter(Boolean))].join(', '), ...summarizeSamples(list), mentionBootstrap: clusterBootstrap(list, 'mentioned'), citedBootstrap: clusterBootstrap(list, 'cited'), stability: median(prompts.map(citedStability)) };
  });
  const byArm = [...groupBy(samples, (s) => `${s.engine}\t${armOf(s)}`)].map(([key, list]) => {
    const [engine, arm] = key.split('\t');
    return { engine, arm, ...summarizeSamples(list) };
  }).sort((a, b) => a.engine.localeCompare(b.engine) || a.arm.localeCompare(b.arm));
  const byPrompt = [...groupBy(samples, (s) => `${s.engine}\t${s.promptId}`)].map(([key, list]) => {
    const [engine, promptId] = key.split('\t');
    const ranks = list.filter((s) => isValid(s) && s.analysis.rank).map((s) => s.analysis.rank);
    return { engine, promptId, prompt: list[0].def.prompt, arm: armOf(list[0]), cohort: list[0].def.cohort, ...summarizeSamples(list), medianRank: median(ranks), stability: citedStability(list) };
  });
  const negatives = samples.filter((s) => String(s.arm).toLowerCase() === 'negative' && isValid(s));
  const branded = samples.filter((s) => isYes(s.branded) && isValid(s));
  return {
    byEngine,
    byArm,
    byPrompt,
    domains: domainShares(main, ctx),
    domainsByEngine: Object.fromEntries([...groupBy(main, (s) => s.engine)].map(([e, list]) => [e, domainShares(list, ctx).slice(0, 25)])),
    outreach: outreachCandidates(main, ctx),
    diagnostics: {
      negativeMentions: negatives.filter((s) => s.analysis.mentioned).length,
      negativeValid: negatives.length,
      brandedMissed: branded.filter((s) => !s.analysis.mentioned).length,
      brandedValid: branded.length,
    },
  };
}

function rateCsvRows(agg) {
  const row = (level, x) => ({
    level,
    engine: x.engine,
    prompt_id: x.promptId || '',
    arm: x.arm || '',
    samples: x.samples,
    valid: x.valid,
    no_search: x.noSearch,
    failed: x.failed,
    mention_k: x.mention.k,
    mention_rate: x.mention.rate,
    mention_low: x.mention.low,
    mention_high: x.mention.high,
    retrieved_k: x.retrieved.k,
    retrieved_n: x.retrieved.n,
    retrieved_rate: x.retrieved.rate,
    cited_k: x.cited.k,
    cited_n: x.cited.n,
    cited_rate: x.cited.rate,
    cited_low: x.cited.low,
    cited_high: x.cited.high,
    recommended_k: x.recommended.k,
    recommended_rate: x.recommended.rate,
    small_sample: x.mention.small ? 'yes' : '',
    mention_boot_low: x.mentionBootstrap ? x.mentionBootstrap.low : '',
    mention_boot_high: x.mentionBootstrap ? x.mentionBootstrap.high : '',
    stability: x.stability ?? '',
  });
  return [...agg.byEngine.map((x) => row('engine', x)), ...agg.byArm.map((x) => row('arm', x)), ...agg.byPrompt.map((x) => row('engine-prompt', x))];
}

function renderReport({ date, runId, plan, samples, agg, warnings, notices, files, ctx }) {
  const L = [`# GEO tracking - ${date} (run ${runId})`, ''];
  L.push('_Evidence level: sampled answers from official APIs with web search. API answers differ from the consumer apps (models, sources, settings): keep API and manual UI series apart; a model or engine change starts a new series. "recommended" is a wording heuristic; rates marked * have n < 20 (small sample). Failures and answers without a web search are counted separately, never as 0._', '');
  L.push('## Run', '');
  L.push(mdTable([{ label: 'Engine', key: 'engine' }, { label: 'Model (config)', key: 'model' }, { label: 'Model served', value: (e) => [...new Set(samples.filter((s) => s.engine === e.engine).map((s) => s.modelServed).filter(Boolean))].join(', ') || '-' }, { label: 'Calls', align: 'right', value: (e) => e.guard.calls }, { label: 'Est. USD', align: 'right', value: (e) => e.guard.usd.toFixed(2) }], plan.perEngine));
  L.push(`Prompts: ${new Set(samples.map((s) => s.promptId)).size}; samples per prompt and engine: ${plan.samples}; cost figures are estimates (config.providers.<engine>.perCallUSD) recorded in logs/spend.csv.`, '');
  L.push('## Per engine (non-branded prompts, excluding placebo and negative controls)', '');
  L.push(mdTable([
    { label: 'Engine', key: 'engine' },
    { label: 'Valid', align: 'right', key: 'valid' },
    { label: 'Mentioned', value: (x) => fmtRate(x.mention) },
    { label: 'Retrieved', value: (x) => fmtRate(x.retrieved) },
    { label: 'Cited', value: (x) => fmtRate(x.cited) },
    { label: 'Recommended (heuristic)', value: (x) => fmtRate(x.recommended) },
    { label: 'No search', align: 'right', key: 'noSearch' },
    { label: 'Failed', align: 'right', key: 'failed' },
    { label: 'Cited-domain stability', align: 'right', value: (x) => (x.stability === null || x.stability === undefined ? '-' : x.stability.toFixed(2)) },
  ], agg.byEngine, { empty: 'No answers to non-branded prompts.' }));
  const boot = (b) => (b ? `${fmtPct(b.low, 0)}-${fmtPct(b.high, 0)} (${b.prompts} prompts)` : '- (needs >= 2 prompts)');
  if (agg.byEngine.length) L.push('Prompt-cluster bootstrap 95% intervals (2,000 resamples of prompts, seed 7; wider than Wilson because samples of one prompt are correlated - use these for decisions):', '', ...agg.byEngine.map((x) => `- ${x.engine}: mentioned ${boot(x.mentionBootstrap)}; cited ${boot(x.citedBootstrap)}`), '');
  L.push('Funnel: retrieved (your page among the sources the engine read) -> cited (linked) -> mentioned (brand named) -> recommended. Retrieved without cited: fix the page (answer capsule, quotable sentences); cited or mentioned without being recommended: entity consistency and off-site citations. Stability = median Jaccard overlap of cited domains between samples of the same prompt.', '');
  L.push('## Per arm', '');
  L.push(mdTable([{ label: 'Engine', key: 'engine' }, { label: 'Arm', key: 'arm' }, { label: 'Valid', align: 'right', key: 'valid' }, { label: 'Mentioned', value: (x) => fmtRate(x.mention) }, { label: 'Cited', value: (x) => fmtRate(x.cited) }, { label: 'Recommended', value: (x) => fmtRate(x.recommended) }, { label: 'No search / failed', value: (x) => `${x.noSearch} / ${x.failed}` }], agg.byArm));
  L.push('Treated vs control is only meaningful against the same arms before the change (difference in differences over >= 4 weekly runs). Placebo = reworded treated prompts (how much numbers move without any change); negative = unrelated category (must stay at 0); branded = diagnostic (must mention you).', '');
  L.push('## Per engine and prompt', '');
  L.push(mdTable([
    { label: 'Engine', key: 'engine' },
    { label: 'Prompt', value: (x) => `${x.promptId}: ${excerpt(x.prompt, 60)}` },
    { label: 'Arm', key: 'arm' },
    { label: 'Mentioned', value: (x) => kn(x.mention) },
    { label: 'Cited', value: (x) => kn(x.cited) },
    { label: 'Recommended', value: (x) => kn(x.recommended) },
    { label: 'Median rank', align: 'right', value: (x) => (x.medianRank ? x.medianRank.toFixed(1) : '-') },
    { label: 'No search / failed', value: (x) => `${x.noSearch} / ${x.failed}` },
  ], agg.byPrompt));
  L.push('## Cited domains (all engines, main prompts)', '');
  L.push(mdTable([{ label: 'Domain', value: (d) => `${d.domain}${d.ours ? ' (us)' : d.competitor ? ' (competitor)' : ''}` }, { label: 'Answers', align: 'right', key: 'answers' }, { label: 'Share of valid answers', align: 'right', value: (d) => fmtPct(d.answerShare, 0) }], agg.domains.slice(0, 25), { empty: 'No citations.' }));
  L.push('## Outreach candidates (cited alongside competitors, never with you)', '');
  L.push(mdTable([{ label: 'Domain', key: 'domain' }, { label: 'Answers', align: 'right', key: 'answers' }, { label: 'Engines', value: (o) => o.engines.join(', ') }, { label: 'Competitors present', value: (o) => o.competitors.join(', ') }, { label: 'Prompts', value: (o) => o.prompts.join(', ') }], agg.outreach.slice(0, 25), { empty: 'None (or no competitor configured in config.competitors / geo.competitorBrands).' }));
  L.push('Hand these to the off-site citation work (references/12): directories, reviews, lists and media that AI engines already cite for your topic.', '');
  L.push('## Diagnostics and warnings', '');
  const diag = [...warnings, ...notices];
  if (!diag.length) diag.push('None.');
  for (const w of diag) L.push(`- ${w}`);
  L.push('');
  const failures = samples.filter((s) => s.status === 'failed' || s.status === 'incomplete');
  if (failures.length) {
    L.push('## Failed or incomplete answers (not counted in rates)', '');
    L.push(mdTable([{ label: 'Engine', key: 'engine' }, { label: 'Prompt', key: 'promptId' }, { label: 'k', key: 'k' }, { label: 'Status', key: 'status' }, { label: 'Error', value: (s) => excerpt(s.error, 140) }], failures.slice(0, 50)));
  }
  L.push('## Next steps', '');
  L.push('- Read a few answers in the answers file and fill accuracy / pricing_claim / reason in geo-prompts.csv for rows that mention you (the script leaves them empty).');
  L.push('- Wrong facts: fix the single source of truth (llms.txt, About, pricing FAQ), log the change with log-change.mjs, and re-run the same prompts on the same schedule.');
  L.push('- Compare runs only with the same prompt portfolio version, engines, models and mode; weekly numbers show large moves only, decide on 4-week windows.', '');
  L.push('## Files', '');
  for (const f of files) L.push(`- ${f}`);
  L.push('');
  return L.join('\n');
}

// ---------- main ----------
function newRunId(ws) {
  const hhmmss = formatInTz(Date.now(), ws.timezone()).slice(11).replace(':', '');
  return `r${hhmmss}${String(new Date().getSeconds()).padStart(2, '0')}-${crypto.randomBytes(2).toString('hex')}`;
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const geo = ws.config.geo || {};
  const promptsFile = ws.resolveFile(geo.promptsFile || 'geo-prompts.csv');
  if (!fs.existsSync(promptsFile)) {
    throw new UserError(`Prompt file not found: ${promptsFile}`, { hint: [`Copy ${path.join(SCRIPTS_DIR, '..', 'templates', 'geo-prompts.csv')} to the workspace and replace the {placeholders} with your category, niche and use cases.`, 'Or set config geo.promptsFile.'] });
  }
  const logFile = readGeoLog(promptsFile);
  // rows of the shipped template's worked examples ("範例列" / "example row" in notes) are not prompts to send
  const isExample = (r) => /^\s*(範例列|example row)/i.test(String(r.notes || ''));
  const examples = logFile.records.filter(isExample).length;
  const collected = collectPrompts(logFile.records.filter((r) => !isExample(r)));
  const placeholders = collected.placeholders;
  // negative controls come from config geo.controlPrompts on every run; logged ctl- rows are results, not definitions
  const fromFile = collected.prompts.filter((p) => !/^ctl-/.test(p.id));
  const warnings = [];
  if (placeholders) warnings.push(`${placeholders} prompt(s) in ${path.basename(promptsFile)} still contain template placeholders such as {category} and were skipped; replace them with your own words.`);
  if (examples) warnings.push(`${examples} template example row(s) (notes start with "範例列" / "example row") were ignored; delete them once you have your own prompts.`);
  const site = ws.config.site || {};
  const controls = flags.noControls ? [] : controlPromptDefs(geo.controlPrompts, { locale: geo.language || site.language || '', country: geo.country || site.country || '' });
  const texts = new Set(fromFile.map((p) => p.prompt));
  const all = [...fromFile, ...controls.filter((c) => !texts.has(c.prompt))];
  const prompts = filterPrompts(all, { ids: flags.promptId, cohort: flags.cohort, arm: flags.arm, locale: flags.locale, topic: flags.topic, limit: flags.limit || 0 });
  if (!prompts.length) {
    throw new UserError(all.length ? 'No prompt matches the filters' : `No usable prompt in ${promptsFile}`, {
      hint: all.length ? 'Check --prompt-id/--cohort/--arm/--locale/--topic.' : ['Add rows with prompt_id, prompt, locale, intent, cohort, arm, branded, topic, country (see templates/geo-prompts.csv).', 'Template rows with {placeholders} are skipped until you replace them.'],
    });
  }
  const samples = flags.samples ?? (Number.isInteger(geo.samples) ? geo.samples : 3);
  if (!Number.isInteger(samples) || samples < 1 || samples > 50) throw new UserError(`--samples must be 1-50 (got ${samples})`, { hint: 'Fix N before the run (e.g. 3-5) and keep it; never stop early when the interval looks narrow.' });
  const cfgMax = geo.maxCalls === null || geo.maxCalls === undefined || geo.maxCalls === '' ? NaN : Number(geo.maxCalls);
  const maxCalls = flags.maxCalls ?? (Number.isFinite(cfgMax) ? cfgMax : 100);
  const secrets = secretValues(ws);
  const leaking = prompts.filter((p) => containsSecret(p.prompt, secrets));
  if (leaking.length) throw new UserError(`Refusing to send ${leaking.length} prompt(s) that contain a configured secret value (${leaking.map((p) => p.id).join(', ')})`, { hint: 'Remove the secret from geo-prompts.csv / config geo.controlPrompts; prompts are sent to third-party APIs and stored.' });

  if (flags.manual) return writeManual(ws, prompts, samples);

  const { runnable, skipped, notices } = selectEngines(ws, flags);
  if (runnable.some((r) => r.engine === 'gemini')) notices.push('geo.allowGeminiGrounding is true: the Gemini API Additional Terms (https://ai.google.dev/gemini-api/terms#grounding-with-google-search) restrict caching, storing, analysing and programmatically collecting Grounded Results and Links; you are responsible for using Gemini results within those terms.');
  for (const n of notices) log(`notice: ${n}`);
  if (!runnable.length) {
    const why = skipped.length ? skipped.map((s) => `${s.engine}: ${s.reason}`).join('; ') : 'no engine selected';
    const first = skipped.find((s) => /^no \$/.test(s.reason));
    const hint = first ? ` To automate, export ${first.reason.slice(4)} (${PROVIDERS[first.engine].signup}) and set geo.models.${first.engine}.` : '';
    writeManual(ws, prompts, samples, `No engine can be called (${why}).${hint} Writing the manual UI checklist instead.`);
    return flags.run ? 1 : 0; // --run asked for measurements and none were made
  }
  const brand = makeTermMatcher(ws.brandTerms(), { label: 'brand' });
  if (brand.empty) warnings.push('No usable brand term (site.brandTerms, brand.officialName, brand.alternateNames): mentions cannot be detected. Run init.mjs --brand-term "<name>".');
  warnings.push(...brand.warnings);
  const competitorBrands = (geo.competitorBrands || []).map((name) => {
    const m = makeTermMatcher([name], { label: 'competitor brand' });
    warnings.push(...m.warnings);
    return { name: String(name), matcher: m };
  });
  const ctx = {
    brand,
    competitorBrands,
    ours: domainSet([ws.host(), ...(geo.ownDomains || [])]),
    competitors: domainSet((ws.config.competitors || []).map((c) => (typeof c === 'string' ? c : c && c.domain)).filter(Boolean)),
  };
  const plan = buildPlan(ws, runnable, { prompts: prompts.length, samples, maxCalls });
  plan.samples = samples;
  const counts = { branded: prompts.filter((p) => isYes(p.branded)).length, negative: prompts.filter((p) => p.arm === 'negative').length, placebo: prompts.filter((p) => p.arm === 'placebo').length };
  const planJson = {
    mode: flags.run ? 'run' : 'dry-run',
    promptsFile,
    prompts: prompts.length,
    skippedPlaceholders: placeholders,
    ...counts,
    samples,
    maxCalls,
    engines: plan.perEngine.map((e) => ({ engine: e.engine, model: e.model, calls: e.calls, perCallUSD: e.plan.perCallUSD, usd: e.plan.usd, monthSpentUSD: e.plan.monthSpentUSD, monthlyBudgetUSD: e.plan.monthlyBudgetUSD })),
    skipped,
    totalCalls: plan.total,
    estimatedUSD: plan.usd,
    ok: plan.ok,
    reasons: plan.reasons,
  };
  if (!flags.run || !plan.ok) {
    if (flags.json) process.stdout.write(`${JSON.stringify(planJson, null, 2)}\n`);
    else {
      out(`GEO tracking plan${flags.run ? '' : ' (dry run)'} - ${ws.today()}`);
      out(`Prompts: ${prompts.length} from ${path.basename(promptsFile)}${controls.length && !flags.noControls ? ` incl. ${prompts.filter((p) => p.control).length} negative control(s) from config` : ''} (branded ${counts.branded}, placebo ${counts.placebo}, negative ${counts.negative})${placeholders ? `; ${placeholders} skipped (template placeholders)` : ''}`);
      out(`Samples per prompt and engine: ${samples} (fixed in advance)`);
      for (const p of prompts.slice(0, 40)) out(`  ${p.id}${p.arm ? ` [${p.arm}]` : ''}${isYes(p.branded) ? ' [branded]' : ''} ${p.locale || '-'}/${countryCode(p.country || geo.country || site.country) || '-'}: ${excerpt(p.prompt, 90)}`);
      if (prompts.length > 40) out(`  ... and ${prompts.length - 40} more`);
      out(textTable(['engine', 'model', 'calls', 'est. USD', 'month spent', 'monthly budget'], [
        ...plan.perEngine.map((e) => [e.engine, e.model, String(e.calls), e.plan.usd.toFixed(2), e.plan.monthSpentUSD.toFixed(2), e.plan.monthlyBudgetUSD === null || e.plan.monthlyBudgetUSD === undefined ? '-' : e.plan.monthlyBudgetUSD.toFixed(2)]),
        ['total', '', String(plan.total), plan.usd.toFixed(2), '', ''],
      ]));
      out(`Cap: ${plan.total} of ${maxCalls} calls (--max-calls / config geo.maxCalls). Estimates use config.providers.<engine>.perCallUSD (defaults are rough).`);
      for (const s of skipped) out(`skipped ${s.engine}: ${s.reason}`);
      for (const w of warnings) out(`warning: ${w}`);
    }
    if (!plan.ok) throw new UserError(`Cost guard: ${plan.reasons.join('; ')}`, { exitCode: 2, hint: ['Lower --samples, select fewer prompts (--prompt-id/--cohort/--limit) or engines, or raise the cap knowingly (--max-calls, config.providers.<engine>.monthlyBudgetUSD / perRunBudgetUSD).'] });
    if (!flags.json) out(`\nDry run: no API call was made. Re-run with --run to execute (${plan.total} calls, about $${plan.usd.toFixed(2)}).`);
    return 0;
  }

  // ---------- run ----------
  const runId = newRunId(ws);
  const date = ws.today();
  const results = [];
  let globalCalls = 0;
  let stoppedHard = false;
  const timeoutMs = Math.max(5, flags.timeout) * 1000;
  log(`GEO run ${runId}: ${plan.total} planned calls across ${plan.perEngine.length} engine(s)...`);
  try {
    for (const e of plan.perEngine) {
      const adapter = ADAPTERS[e.engine];
      const endpoint = process.env[adapter.endpointEnv] || adapter.endpoint;
      const { apiKey } = providerCredentials(ws, e.engine);
      let stopReason = '';
      let consecutive4xx = 0;
      for (const def of prompts) {
        const country = countryCode(def.country || geo.country || site.country);
        for (let k = 1; k <= samples; k++) {
          const base = { engine: e.engine, model: e.model, def, promptId: def.id, arm: def.arm, branded: def.branded, k, startedAt: new Date().toISOString() };
          if (stopReason) {
            results.push({ ...base, status: 'failed', error: `not called: ${stopReason}`, searched: false, retrieved: [], cited: [], text: '', queries: [] });
            continue;
          }
          if (globalCalls >= maxCalls) {
            results.push({ ...base, status: 'failed', error: 'not called: per-run cap reached', searched: false, retrieved: [], cited: [], text: '', queries: [] });
            continue;
          }
          if (globalCalls > 0 && flags.delay > 0) await sleep(flags.delay);
          const t0 = Date.now();
          e.guard.charge();
          globalCalls++;
          const req = adapter.request({ model: e.model, prompt: def.prompt, country, apiKey, endpoint, toolType: e.engine === 'anthropic' ? geo.anthropicTool : undefined });
          let res = await postJson(req, { timeoutMs, retryMs: flags.retryMs });
          let parsed = null;
          if (res.ok) {
            parsed = adapter.parse(res.json);
            // Anthropic: resume a paused server-tool turn (max 2 continuations, within the call cap).
            let history = [];
            let blocks = parsed.content || [];
            for (let c = 0; parsed.paused && c < 2 && globalCalls < maxCalls; c++) {
              history = [{ role: 'assistant', content: blocks }];
              e.guard.charge();
              globalCalls++;
              const next = await postJson(adapter.request({ model: e.model, prompt: def.prompt, country, apiKey, endpoint, toolType: geo.anthropicTool, history }), { timeoutMs, retryMs: flags.retryMs });
              if (!next.ok) {
                res = next;
                break;
              }
              blocks = [...blocks, ...(next.json.content || [])];
              parsed = adapter.parse({ ...next.json, content: blocks });
            }
          }
          if (!res.ok) {
            const err = redactSecrets(res.error, ws);
            const authLike = /API_KEY_INVALID|API key not valid|invalid[_ ]api[_ ]key|unauthori[sz]ed|authentication/i.test(err);
            const hint = HTTP_HINTS[authLike ? 401 : res.status] || '';
            results.push({ ...base, status: 'failed', error: `${err}${hint ? ` (${hint})` : ''}`, httpStatus: res.status, searched: false, retrieved: [], cited: [], text: '', queries: [], ms: Date.now() - t0 });
            const quota = /insufficient_quota|billing|credit balance|spend limit|usage limit|RESOURCE_EXHAUSTED.*(credit|billing)|exceeded your current quota/i.test(err) || res.status === 402;
            if ([401, 402, 403, 404].includes(res.status) || authLike || quota) {
              stopReason = `${e.engine} returned HTTP ${res.status} (${quota ? 'out of credit or quota: check the provider billing page' : hint})`;
              stoppedHard = true;
            }
            else if (res.status >= 400 && res.status < 500 && res.status !== 429 && ++consecutive4xx >= 2) stopReason = `${e.engine} rejected two requests in a row (HTTP ${res.status})`;
            log(`  ${e.engine} ${def.id} k=${k}: failed (${excerpt(err, 120)})`);
            continue;
          }
          consecutive4xx = 0;
          const { content, paused, ...answer } = parsed;
          const sample = { ...base, ...answer, error: redactSecrets(answer.error || '', ws), text: cleanText(answer.text), ms: Date.now() - t0 };
          sample.analysis = analyzeAnswer(sample, ctx);
          results.push(sample);
          log(`  ${e.engine} ${def.id} k=${k}: ${sample.status}${sample.status === 'ok' || sample.status === 'no-search' ? `, mentioned ${sample.analysis.mentioned ? 'yes' : 'no'}, cited ${sample.analysis.funnel.cited}` : ` (${excerpt(sample.error, 80)})`}`);
        }
      }
      if (stopReason) warnings.push(`${e.engine}: stopped early, ${stopReason}.`);
    }
  } finally {
    for (const e of plan.perEngine) e.guard.record(`run=${runId}`);
  }
  for (const s of results) if (s.status !== 'ok' && s.status !== 'no-search' && !s.analysis) s.analysis = null;

  const agg = aggregateRun(results, ctx);
  if (agg.diagnostics.negativeMentions > 0) warnings.push(`Negative-control prompts mentioned the brand in ${agg.diagnostics.negativeMentions} of ${agg.diagnostics.negativeValid} valid answer(s): check brand terms for false positives (short or generic words) or engine drift before reading the other numbers.`);
  if (agg.diagnostics.brandedMissed > 0) warnings.push(`Branded prompts did not mention the brand in ${agg.diagnostics.brandedMissed} of ${agg.diagnostics.brandedValid} valid answer(s): check brand terms and entity consistency (references/11 steps 1-3).`);
  const smallN = agg.byEngine.filter((x) => x.mention.small);
  if (smallN.length) warnings.push(`Small samples (n < 20 valid answers) for ${smallN.map((x) => x.engine).join(', ')}: report direction only; pool 4 weekly runs before deciding.`);

  const answersFile = ws.dataFile('geo', `${runId}-answers`, 'jsonl');
  const lines = results.map((s) => JSON.stringify({
    runId, date, engine: s.engine, model: s.model, modelServed: s.modelServed || '', promptId: s.promptId, prompt: s.def.prompt, locale: s.def.locale, country: s.def.country, arm: s.arm, cohort: s.def.cohort, branded: s.branded, k: s.k,
    status: s.status, error: s.error || '', httpStatus: s.httpStatus || null, searched: Boolean(s.searched), queries: s.queries || [], retrieved: s.retrieved || [], cited: s.cited || [],
    text: (s.text || '').slice(0, ANSWER_CHARS), truncatedText: (s.text || '').length > ANSWER_CHARS, usage: s.usage || null, analysis: s.analysis || null, startedAt: s.startedAt, ms: s.ms || null,
  }));
  writeText(answersFile, lines.length ? `${lines.join('\n')}\n` : '');
  const summary = { meta: { runId, date, promptsFile, samples, maxCalls, calls: plan.perEngine.reduce((n, e) => n + e.guard.calls, 0), estimatedUSD: plan.perEngine.reduce((n, e) => n + e.guard.usd, 0), engines: plan.perEngine.map((e) => ({ engine: e.engine, model: e.model, calls: e.guard.calls })), skipped, ourDomains: ctx.ours.list, competitorDomains: ctx.competitors.list, brandTerms: brand.terms, warnings: [...warnings, ...notices] }, ...agg };
  const summaryJson = writeJson(ws.dataFile('geo', `${runId}-summary`, 'json'), summary);
  const summaryCsv = writeCsvFile(ws.dataFile('geo', `${runId}-summary`, 'csv'), rateCsvRows(agg));
  const files = [answersFile, summaryJson, summaryCsv];
  if (!flags.noAppend) {
    const appended = appendGeoRows(promptsFile, results.filter((s) => !/^not called:/.test(s.error || '')).map((s) => sampleRow(s, { date, runId })));
    if (appended.rewritten && appended.previousHeader && appended.previousHeader.length) warnings.push(`${path.basename(promptsFile)} gained ${appended.header.length - appended.previousHeader.length} column(s) at the end (${appended.header.slice(appended.previousHeader.length).join(', ')}); existing rows and columns were kept (previous version: ${path.basename(appended.backup)}).`);
    files.unshift(promptsFile);
  }
  const reportFile = ws.path('logs', 'reviews', `${date}-geo-track.md`);
  files.push(reportFile);
  const report = renderReport({ date, runId, plan, samples: results, agg, warnings, notices, files, ctx });
  // a second run on the same day is added below the first instead of replacing it
  if (fs.existsSync(reportFile) && /^# GEO tracking - /m.test(fs.readFileSync(reportFile, 'utf8'))) fs.appendFileSync(reportFile, `\n---\n\n${report}`, 'utf8');
  else writeText(reportFile, report);

  const usable = results.filter((s) => s.status === 'ok' || s.status === 'no-search').length;
  const exitCode = !usable || stoppedHard ? 1 : 0;
  const failNote = !usable ? 'no usable answer in this run' : 'an engine stopped early (key, model, access or credit problem)';
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, files, exitCode }, null, 2)}\n`);
    if (exitCode) process.stderr.write(`Error: ${failNote}; see the report.\n`);
    return exitCode;
  }
  const valid = results.filter(isValid).length;
  out(`GEO run ${runId}: ${summary.meta.calls} call(s), ${results.length} sample(s): ${valid} valid, ${results.filter((s) => s.status === 'no-search').length} without search, ${results.filter((s) => s.status === 'failed' || s.status === 'incomplete').length} failed/incomplete.`);
  for (const x of agg.byEngine) out(`  ${x.engine}: mentioned ${fmtRate(x.mention)}; cited ${fmtRate(x.cited)}; recommended ${fmtRate(x.recommended)}`);
  if (agg.outreach.length) out(`  outreach candidates: ${agg.outreach.slice(0, 5).map((o) => o.domain).join(', ')}`);
  for (const w of warnings) out(`warning: ${w}`);
  out('(* = fewer than 20 valid answers: direction only)');
  out('');
  for (const f of files) out(`wrote ${f}`);
  out(`next: ${scriptCmd('geo-track.mjs')} --manual for engines without an API (Gemini UI, Google AI Overviews, Copilot)`);
  if (exitCode) process.stderr.write(`Error: ${failNote}; see the warnings above and the report.\n`);
  return exitCode;
}

runMain(import.meta.url, main);
