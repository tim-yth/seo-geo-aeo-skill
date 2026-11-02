// Crawler catalog (search, AI search, AI user-triggered, AI training, control tokens), official IP lists with a
// 24-hour cache and version ledger, exact CIDR matching (node:net BlockList) and reverse+forward DNS verification.
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { appendText, ensureDir, mapLimit, rateLimiter, readJson, writeJson } from './util.mjs';
import { fetchPage } from './http.mjs';

export const CATALOG_VERIFIED_ON = '2026-11-02';
export const CATEGORIES = ['search', 'ai-search', 'ai-user', 'ai-training', 'other-bot', 'control-token'];

/**
 * Official IP lists (format: {creationTime, prefixes:[{ipv4Prefix}|{ipv6Prefix}]}), all checked on 2026-11-02.
 * Google: https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests (moved from
 * /search/apis/ipranges/ on 2026-03-31; old URLs redirect). Never use goog.json (Google Cloud customer ranges).
 */
export const IP_LISTS = {
  'google-common': { company: 'Google', url: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json', covers: 'Googlebot and other common crawlers (rDNS *.googlebot.com)' },
  'google-special': { company: 'Google', url: 'https://developers.google.com/static/crawling/ipranges/special-crawlers.json', covers: 'special-case crawlers such as AdsBot (rDNS rate-limited-proxy-*.google.com)' },
  'google-user-triggered': { company: 'Google', url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers.json', covers: 'user-triggered fetchers (rDNS *.gae.googleusercontent.com)' },
  'google-user-triggered-google': { company: 'Google', url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json', covers: 'Google-controlled user-triggered fetchers (rDNS google-proxy-*.google.com)' },
  'google-user-triggered-agents': { company: 'Google', url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json', covers: 'Google-Agent' },
  bingbot: { company: 'Microsoft', url: 'https://www.bing.com/toolbox/bingbot.json', covers: 'Bingbot (creationTime is stale; reverse DNS search.msn.com is the primary check)' },
  'openai-gptbot': { company: 'OpenAI', url: 'https://openai.com/gptbot.json', covers: 'GPTBot' },
  'openai-searchbot': { company: 'OpenAI', url: 'https://openai.com/searchbot.json', covers: 'OAI-SearchBot' },
  'openai-chatgpt-user': { company: 'OpenAI', url: 'https://openai.com/chatgpt-user.json', covers: 'ChatGPT-User' },
  'openai-adsbot': { company: 'OpenAI', url: 'https://openai.com/adsbot.json', covers: 'OAI-AdsBot' },
  anthropic: { company: 'Anthropic', url: 'https://claude.com/crawling/bots.json', covers: 'ClaudeBot, Claude-SearchBot and Claude-User (one shared list: proves the company, not the purpose)' },
  perplexitybot: { company: 'Perplexity', url: 'https://www.perplexity.ai/perplexitybot.json', covers: 'PerplexityBot' },
  'perplexity-user': { company: 'Perplexity', url: 'https://www.perplexity.ai/perplexity-user.json', covers: 'Perplexity-User' },
  applebot: { company: 'Apple', url: 'https://search.developer.apple.com/applebot.json', covers: 'Applebot (rDNS *.applebot.apple.com)' },
  ccbot: { company: 'Common Crawl', url: 'https://index.commoncrawl.org/ccbot.json', covers: 'CCBot (rDNS *.crawl.commoncrawl.org for IPv4)' },
  duckduckbot: { company: 'DuckDuckGo', url: 'https://duckduckgo.com/duckduckbot.json', covers: 'DuckDuckBot' },
  duckassistbot: { company: 'DuckDuckGo', url: 'https://duckduckgo.com/duckassistbot.json', covers: 'DuckAssistBot' },
};

const V = CATALOG_VERIFIED_ON;
// googleusercontent.com is not used: Compute Engine customer VMs resolve under *.bc.googleusercontent.com. User-triggered
// fetchers are verified by their (authoritative, daily-updated) IP lists only.
const GOOGLE_COMMON = { company: 'Google', lists: ['google-common'], rdns: ['googlebot.com'], rdnsOther: ['google.com'], lastVerified: V };
const GOOGLE_SPECIAL = { company: 'Google', lists: ['google-special'], rdns: ['google.com'], lastVerified: V };
const GOOGLE_USER = { company: 'Google', lists: ['google-user-triggered', 'google-user-triggered-google', 'google-user-triggered-agents'], rdns: [], lastVerified: V };

/**
 * First matching entry wins, so control tokens and specific names come before generic ones (Googlebot-Image before
 * Googlebot, Applebot-Extended before Applebot). lists = official IP list ids; rdns = reverse-DNS domains (suffix match,
 * then a forward lookup must return the same IP). listAuthoritative: false = an IP missing from the list is not proof
 * of spoofing (the list is known to be stale). companyOnly: the list is shared by several bots of one company.
 */
export const BOTS = [
  { name: 'Google-Extended', company: 'Google', category: 'control-token', ua: /Google-Extended/i, lists: [], rdns: [], lastVerified: V, note: 'robots.txt control token for Gemini training/grounding; it never fetches, so a request naming it is spoofed' },
  { name: 'Applebot-Extended', company: 'Apple', category: 'control-token', ua: /Applebot-Extended/i, lists: [], rdns: [], lastVerified: V, note: 'robots.txt control token for Apple model training; it never fetches, so a request naming it is spoofed' },
  { name: 'Googlebot-Image', category: 'search', ua: /Googlebot-Image/i, ...GOOGLE_COMMON },
  { name: 'Googlebot-Video', category: 'search', ua: /Googlebot-Video/i, ...GOOGLE_COMMON },
  { name: 'Google-InspectionTool', category: 'other-bot', ua: /Google-InspectionTool/i, ...GOOGLE_COMMON },
  { name: 'Storebot-Google', category: 'other-bot', ua: /Storebot-Google/i, ...GOOGLE_COMMON },
  { name: 'Google-CloudVertexBot', category: 'other-bot', ua: /Google-CloudVertexBot/i, ...GOOGLE_COMMON },
  { name: 'GoogleOther', category: 'other-bot', ua: /GoogleOther/i, ...GOOGLE_COMMON },
  { name: 'Googlebot', category: 'search', ua: /Googlebot/i, ...GOOGLE_COMMON },
  { name: 'Google-Agent', category: 'ai-user', ua: /Google-Agent/i, ...GOOGLE_USER, lists: ['google-user-triggered-agents'] },
  { name: 'Google-GeminiNotebook', category: 'ai-user', ua: /Google-GeminiNotebook|Google-NotebookLM/i, ...GOOGLE_USER },
  { name: 'Google user-triggered fetcher', category: 'other-bot', ua: /FeedFetcher-Google|Google-Read-Aloud|GoogleProducer|Google-Site-Verification|Google-CWS|Google-Pinpoint|GoogleMessages/i, ...GOOGLE_USER },
  { name: 'AdsBot-Google', category: 'other-bot', ua: /AdsBot-Google/i, ...GOOGLE_SPECIAL },
  { name: 'Mediapartners-Google', category: 'other-bot', ua: /Mediapartners-Google/i, ...GOOGLE_SPECIAL },
  { name: 'Google special-case crawler', category: 'other-bot', ua: /APIs-Google|Google-Safety/i, ...GOOGLE_SPECIAL },
  { name: 'Bingbot', company: 'Microsoft', category: 'search', ua: /bingbot/i, lists: ['bingbot'], rdns: ['search.msn.com'], listAuthoritative: false, lastVerified: V },
  { name: 'OAI-SearchBot', company: 'OpenAI', category: 'ai-search', ua: /OAI-SearchBot/i, lists: ['openai-searchbot'], rdns: [], lastVerified: V },
  { name: 'ChatGPT-User', company: 'OpenAI', category: 'ai-user', ua: /ChatGPT-User/i, lists: ['openai-chatgpt-user'], rdns: [], lastVerified: V },
  { name: 'OAI-AdsBot', company: 'OpenAI', category: 'other-bot', ua: /OAI-AdsBot/i, lists: ['openai-adsbot'], rdns: [], lastVerified: V },
  { name: 'GPTBot', company: 'OpenAI', category: 'ai-training', ua: /GPTBot/i, lists: ['openai-gptbot'], rdns: [], lastVerified: V },
  { name: 'Claude-SearchBot', company: 'Anthropic', category: 'ai-search', ua: /Claude-SearchBot/i, lists: ['anthropic'], rdns: [], companyOnly: true, lastVerified: V },
  { name: 'Claude-User', company: 'Anthropic', category: 'ai-user', ua: /Claude-User/i, lists: ['anthropic'], rdns: [], companyOnly: true, lastVerified: V },
  { name: 'ClaudeBot', company: 'Anthropic', category: 'ai-training', ua: /ClaudeBot/i, lists: ['anthropic'], rdns: [], companyOnly: true, lastVerified: V },
  { name: 'Perplexity-User', company: 'Perplexity', category: 'ai-user', ua: /Perplexity-User/i, lists: ['perplexity-user'], rdns: [], lastVerified: V },
  { name: 'PerplexityBot', company: 'Perplexity', category: 'ai-search', ua: /PerplexityBot/i, lists: ['perplexitybot'], rdns: [], lastVerified: V },
  { name: 'Applebot', company: 'Apple', category: 'search', ua: /Applebot/i, lists: ['applebot'], rdns: ['applebot.apple.com'], lastVerified: V },
  { name: 'DuckAssistBot', company: 'DuckDuckGo', category: 'ai-search', ua: /DuckAssistBot/i, lists: ['duckassistbot'], rdns: [], lastVerified: V },
  { name: 'DuckDuckBot', company: 'DuckDuckGo', category: 'search', ua: /DuckDuckBot/i, lists: ['duckduckbot'], rdns: [], lastVerified: V },
  { name: 'CCBot', company: 'Common Crawl', category: 'ai-training', ua: /CCBot/i, lists: ['ccbot'], rdns: ['crawl.commoncrawl.org'], rdnsIpv4Only: true, lastVerified: V },
  { name: 'Amazonbot', company: 'Amazon', category: 'ai-training', ua: /Amazonbot/i, lists: [], rdns: ['crawl.amazonbot.amazon'], lastVerified: V },
  { name: 'Amzn-SearchBot', company: 'Amazon', category: 'ai-search', ua: /Amzn-SearchBot/i, lists: [], rdns: [], lastVerified: V, note: 'Amazon publishes its IPs as an HTML page only; not verifiable by script' },
  { name: 'Amzn-User', company: 'Amazon', category: 'ai-user', ua: /Amzn-User/i, lists: [], rdns: [], lastVerified: V, note: 'Amazon publishes its IPs as an HTML page only; not verifiable by script' },
  { name: 'meta-externalagent', company: 'Meta', category: 'ai-training', ua: /meta-externalagent/i, lists: [], rdns: [], lastVerified: V },
  { name: 'meta-externalfetcher', company: 'Meta', category: 'ai-user', ua: /meta-externalfetcher/i, lists: [], rdns: [], lastVerified: V },
  { name: 'MistralAI-User', company: 'Mistral', category: 'ai-user', ua: /MistralAI-User/i, lists: [], rdns: [], lastVerified: V },
  { name: 'Bytespider', company: 'ByteDance', category: 'ai-training', ua: /Bytespider/i, lists: [], rdns: [], lastVerified: V },
  { name: 'Yandex', company: 'Yandex', category: 'search', ua: /Yandex/i, lists: [], rdns: ['yandex.ru', 'yandex.net', 'yandex.com'], lastVerified: V },
  { name: 'Baiduspider', company: 'Baidu', category: 'search', ua: /Baiduspider/i, lists: [], rdns: ['baidu.com', 'baidu.jp'], lastVerified: V },
  { name: 'SEO tool crawlers', company: '', category: 'other-bot', ua: /AhrefsBot|AhrefsSiteAudit|SemrushBot|SiteAuditBot|MJ12bot|DotBot|rogerbot|Screaming Frog|DataForSeoBot|BLEXBot|serpstatbot/i, lists: [], rdns: [], lastVerified: V },
  { name: 'Other automated clients', company: '', category: 'other-bot', generic: true, ua: /(?<!cu)(?:bot|crawler|spider)(?:[/;\s)_-]|$)|crawl|slurp|scrapy|python-requests|python-urllib|aiohttp|httpx|curl\/|wget\/|go-http-client|headlesschrome|phantomjs|libwww|okhttp|axios\/|node-fetch|java\/\d/i, lists: [], rdns: [], lastVerified: V },
];

export function classifyUa(ua) {
  const s = String(ua || '');
  if (!s || s === '-') return null;
  for (const bot of BOTS) if (bot.ua.test(s)) return bot;
  return null;
}

export const botByName = (name) => BOTS.find((b) => b.name === name) || null;

// ---------- IP addresses ----------
/**
 * Canonical address from a log field ("1.2.3.4:443", "[2001:db8::1]", "::ffff:1.2.3.4"). For an X-Forwarded-For list the
 * right-most public address is used (the left part is supplied by the client and can be forged).
 */
export function canonicalIp(raw) {
  let s = String(raw || '').trim();
  if (!s || s === '-') return null;
  if (s.includes(',')) {
    const hops = s.split(',').map((x) => canonicalIp(x)).filter(Boolean);
    return hops.reverse().find((h) => !privateList.check(h.ip, h.family === 4 ? 'ipv4' : 'ipv6')) || hops[0] || null;
  }
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket) s = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.replace(/:\d+$/, '');
  s = s.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  const family = net.isIP(s);
  if (!family) return null;
  return { ip: family === 6 ? s.toLowerCase() : s, family };
}

/** Number of public addresses in an X-Forwarded-For style list (1 for a single address). */
export function publicHops(raw) {
  return String(raw || '').split(',').map((x) => canonicalIp(x)).filter((h) => h && !privateList.check(h.ip, h.family === 4 ? 'ipv4' : 'ipv6')).length;
}

/** Full 8-group IPv6 (for equality checks only). */
export function expandIpv6(ip) {
  let s = String(ip).toLowerCase();
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

export function sameIp(a, b) {
  const x = canonicalIp(a);
  const y = canonicalIp(b);
  if (!x || !y || x.family !== y.family) return false;
  return x.family === 4 ? x.ip === y.ip : expandIpv6(x.ip) === expandIpv6(y.ip);
}

/** Network prefix used instead of an address in reports: /24 for IPv4, /48 for IPv6. */
export function ipPrefix(ip) {
  const c = canonicalIp(ip);
  if (!c) return '(no IP)';
  if (c.family === 4) return `${c.ip.split('.').slice(0, 3).join('.')}.0/24`;
  const g = expandIpv6(c.ip).split(':').slice(0, 3).map((x) => x.replace(/^0+(?=.)/, ''));
  return `${g.join(':')}::/48`;
}

const PRIVATE_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16]];
const PRIVATE_V6 = [['fc00::', 7], ['fe80::', 10], ['::1', 128]];
const privateList = (() => {
  const bl = new net.BlockList();
  for (const [a, p] of PRIVATE_V4) bl.addSubnet(a, p, 'ipv4');
  for (const [a, p] of PRIVATE_V6) bl.addSubnet(a, p, 'ipv6');
  return bl;
})();

/** Private, loopback or carrier-NAT address: the log recorded a proxy/load balancer, not the client. */
export function isPrivateIp(ip) {
  const c = canonicalIp(ip);
  if (!c) return false;
  return privateList.check(c.ip, c.family === 4 ? 'ipv4' : 'ipv6');
}

// ---------- IP lists ----------
/** Parse an official list. Returns {creationTime, prefixes:[{cidr, family}], skipped}. */
export function parseIpList(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text.replace(/^\uFEFF/, '')) : text;
  } catch (e) {
    throw new Error(`not valid JSON (${e.message})`);
  }
  if (!data || !Array.isArray(data.prefixes)) throw new Error('no "prefixes" array');
  const prefixes = [];
  let skipped = 0;
  for (const p of data.prefixes) {
    const cidr = String((p && (p.ipv4Prefix || p.ipv6Prefix)) || '').trim();
    const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr);
    const family = m ? net.isIP(m[1]) : 0;
    if (!m || !family || Number(m[2]) > (family === 4 ? 32 : 128)) {
      skipped++;
      continue;
    }
    prefixes.push({ cidr, family });
  }
  return { creationTime: String(data.creationTime || ''), prefixes, skipped };
}

export function buildBlockList(prefixes) {
  const bl = new net.BlockList();
  for (const { cidr, family } of prefixes) {
    const [addr, len] = cidr.split('/');
    bl.addSubnet(addr, Number(len), family === 4 ? 'ipv4' : 'ipv6');
  }
  return bl;
}

export function ipInList(list, ip) {
  const c = canonicalIp(ip);
  if (!c || !list || !list.blockList) return false;
  return list.blockList.check(c.ip, c.family === 4 ? 'ipv4' : 'ipv6');
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const listVersion = (l) => (l ? `${l.id}@${l.creationTime || 'no-creationTime'}#${String(l.sha256 || '').slice(0, 12)}` : '');

/** Where cached lists live: <ws>/data/bots/ip-ranges/. */
export const ipRangesDir = (ws) => ws.path('data', 'bots', 'ip-ranges');

function listUrl(id) {
  const endpoint = process.env.SEO_AGENT_BOT_LISTS_ENDPOINT;
  return endpoint ? `${endpoint.replace(/\/+$/, '')}/${id}.json` : IP_LISTS[id].url;
}

async function downloadList(id, { timeoutMs = 20000 } = {}) {
  const dir = process.env.SEO_AGENT_BOT_LISTS_DIR;
  if (dir) {
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) return { error: `no ${id}.json in SEO_AGENT_BOT_LISTS_DIR` };
    return { text: fs.readFileSync(file, 'utf8'), url: `file:${id}.json` };
  }
  const url = listUrl(id);
  const res = await fetchPage(url, { timeoutMs, headers: { accept: 'application/json,*/*;q=0.5' }, maxBytes: 20 * 1024 * 1024 });
  if (res.error) return { error: res.error, url };
  if (res.status !== 200) return { error: `HTTP ${res.status}`, url };
  return { text: res.body || '', url: res.finalUrl || url };
}

/** Append-only ledger of every list version seen (so past verifications stay traceable) + a frozen copy per version. */
function recordVersion(dir, entry, text) {
  const ledger = path.join(dir, 'versions.csv');
  if (!fs.existsSync(ledger)) appendText(ledger, 'id,creation_time,sha256,first_fetched_at,url,prefixes\n');
  const seen = fs.readFileSync(ledger, 'utf8').split('\n').some((l) => l.startsWith(`${entry.id},`) && l.includes(`,${entry.sha256},`));
  if (!seen) appendText(ledger, `${[entry.id, entry.creationTime, entry.sha256, entry.fetchedAt, entry.url, entry.prefixCount].map((v) => String(v).replace(/[,\n\r]/g, ' ')).join(',')}\n`);
  const archived = path.join(ensureDir(path.join(dir, 'archive')), `${entry.id}-${entry.sha256.slice(0, 12)}.json`);
  if (!fs.existsSync(archived)) fs.writeFileSync(archived, text);
}

/**
 * Load IP lists by id. Uses <cacheDir>/<id>.json when younger than maxAgeHours; otherwise downloads (or reads
 * $SEO_AGENT_BOT_LISTS_DIR/<id>.json in tests). offline: cache only (stale allowed). A failed download falls back to a
 * stale cache. Returns Map id -> {id, url, creationTime, sha256, fetchedAt, source, stale, prefixes, blockList, error}.
 */
export async function loadIpLists(ids, { cacheDir, offline = false, maxAgeHours = 24, now = Date.now(), log = () => {} } = {}) {
  const outMap = new Map();
  for (const id of [...new Set(ids)]) {
    if (!IP_LISTS[id]) {
      outMap.set(id, { id, error: 'unknown list id' });
      continue;
    }
    const cacheFile = cacheDir ? path.join(cacheDir, `${id}.json`) : '';
    let cached = null;
    try {
      cached = cacheFile && fs.existsSync(cacheFile) ? readJson(cacheFile, null) : null;
      if (cached) parseIpList(cached.data);
    } catch {
      log(`IP list cache ${id}.json is unreadable; ignoring it`);
      cached = null;
    }
    const age = cached && cached.fetchedAt ? (now - Date.parse(cached.fetchedAt)) / 3600000 : Infinity;
    const fromCache = (stale, note) => {
      const parsed = parseIpList(cached.data);
      return { id, url: cached.url, creationTime: parsed.creationTime, sha256: cached.sha256, fetchedAt: cached.fetchedAt, source: 'cache', stale, note, prefixes: parsed.prefixes, blockList: buildBlockList(parsed.prefixes), error: '' };
    };
    if (cached && age < maxAgeHours) {
      outMap.set(id, fromCache(false));
      continue;
    }
    if (offline) {
      if (cached) outMap.set(id, fromCache(true, `offline: cache from ${cached.fetchedAt}`));
      else outMap.set(id, { id, error: 'offline and no cached copy' });
      continue;
    }
    const got = await downloadList(id);
    let parsed = null;
    let error = got.error || '';
    if (!error) {
      try {
        parsed = parseIpList(got.text);
        if (!parsed.prefixes.length) error = 'list has no prefixes';
      } catch (e) {
        error = e.message;
      }
    }
    if (error) {
      log(`IP list ${id}: ${error}${cached ? ' (using the stale cached copy)' : ''}`);
      outMap.set(id, cached ? fromCache(true, `download failed (${error}); cache from ${cached.fetchedAt}`) : { id, error });
      continue;
    }
    const entry = { id, url: got.url, creationTime: parsed.creationTime, sha256: sha256(got.text), fetchedAt: new Date(now).toISOString(), prefixCount: parsed.prefixes.length };
    if (cacheDir) {
      ensureDir(cacheDir);
      const tmp = `${cacheFile}.tmp-${process.pid}`;
      writeJson(tmp, { id, url: entry.url, fetchedAt: entry.fetchedAt, creationTime: entry.creationTime, sha256: entry.sha256, data: JSON.parse(got.text.replace(/^\uFEFF/, '')) });
      fs.renameSync(tmp, cacheFile);
      recordVersion(cacheDir, entry, got.text);
    }
    outMap.set(id, { ...entry, source: process.env.SEO_AGENT_BOT_LISTS_DIR ? 'dir' : 'network', stale: false, prefixes: parsed.prefixes, blockList: buildBlockList(parsed.prefixes), error: '' });
  }
  return outMap;
}

// ---------- DNS ----------
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms).unref())]);

/** Default resolver: PTR via dns.reverse, forward via A + AAAA lookups. */
export function systemDnsResolver({ timeoutMs = 5000 } = {}) {
  const r = new dns.promises.Resolver({ timeout: timeoutMs, tries: 2 });
  return {
    reverse: (ip) => withTimeout(r.reverse(ip), timeoutMs * 2),
    async forward(host) {
      const out = [];
      for (const fn of [(h) => r.resolve4(h), (h) => r.resolve6(h)]) {
        try {
          out.push(...(await withTimeout(fn(host), timeoutMs * 2)));
        } catch (e) {
          if (!['ENODATA', 'ENOTFOUND', 'ENOTIMP', 'EREFUSED'].includes(e.code)) throw e;
        }
      }
      return out;
    },
  };
}

/** Resolver backed by a JSON file {ptr:{ip:[hosts]}, forward:{host:[ips]}} (tests: $SEO_AGENT_DNS_FIXTURE). */
export function fixtureDnsResolver(fileOrData) {
  const data = typeof fileOrData === 'string' ? readJson(fileOrData) : fileOrData;
  const ptr = data.ptr || {};
  const fwd = data.forward || {};
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    async reverse(ip) {
      const key = Object.keys(ptr).find((k) => sameIp(k, ip));
      if (!key) throw err('ENOTFOUND');
      return ptr[key];
    },
    async forward(host) {
      return fwd[String(host).toLowerCase().replace(/\.$/, '')] || [];
    },
  };
}

export const domainMatches = (host, domains) => {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
};

/**
 * Forward-confirmed reverse DNS: a PTR name under one of `domains` whose A/AAAA records include the IP.
 * Returns {ok, host, reason: ''|'no-ptr'|'wrong-domain'|'forward-mismatch'|'dns-error', other: true when the host is under otherDomains}.
 */
export async function dnsCheck(ip, domains, resolver, { otherDomains = [], cache } = {}) {
  let entry = cache && cache.get(ip);
  if (!entry) {
    entry = { ptr: null, error: '', forward: new Map() };
    try {
      entry.ptr = (await resolver.reverse(ip)).map((h) => String(h).toLowerCase().replace(/\.$/, ''));
    } catch (e) {
      entry.ptr = [];
      entry.error = ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(e.code) ? '' : e.code || e.message || 'error';
    }
    if (cache) cache.set(ip, entry);
  }
  if (entry.error) return { ok: false, host: '', reason: 'dns-error', detail: entry.error };
  if (!entry.ptr.length) return { ok: false, host: '', reason: 'no-ptr' };
  let mismatch = '';
  for (const [wanted, other] of [[domains, false], [otherDomains, true]]) {
    for (const host of entry.ptr.filter((h) => domainMatches(h, wanted))) {
      let addrs = entry.forward.get(host);
      if (!addrs) {
        try {
          addrs = await resolver.forward(host);
        } catch (e) {
          return { ok: false, host, reason: 'dns-error', detail: e.code || e.message };
        }
        entry.forward.set(host, addrs);
      }
      if (addrs.some((a) => sameIp(a, ip))) return other ? { ok: false, host, reason: 'other-domain', other: true } : { ok: true, host, reason: '' };
      mismatch = mismatch || host;
    }
    if (mismatch) return { ok: false, host: mismatch, reason: 'forward-mismatch' };
  }
  return { ok: false, host: entry.ptr[0], reason: 'wrong-domain' };
}

// ---------- verification ----------
/** IP list ids needed for a set of bots. */
export const listsFor = (bots) => [...new Set(bots.flatMap((b) => b.lists || []))];

/**
 * Verify claims ({bot, ip}) with mode ranges|dns|both|none. Returns Map "<bot>|<ip>" ->
 * {status: 'verified'|'spoofed'|'unverifiable', method, detail, version}. dns: reverse+forward DNS where the operator documents
 * domains (IPv4 only for CCBot), the IP list otherwise. Details never contain host names or addresses (they can encode visitor IPs).
 */
export async function verifyClaims(claims, { mode = 'ranges', lists = new Map(), resolver, dnsConcurrency = 4, dnsDelayMs = 25 } = {}) {
  const results = new Map();
  const dnsCache = new Map();
  const wait = rateLimiter(dnsDelayMs);
  const pending = [];
  const ids = (ls) => ls.map((l) => l.id).join(', ');
  for (const { bot, ip } of claims) {
    const key = `${bot.name}|${ip}`;
    if (results.has(key)) continue;
    const r = (status, method, detail, version = '') => results.set(key, { status, method, detail, version });
    if (bot.category === 'control-token') {
      r('spoofed', 'control-token', `${bot.name} is a robots.txt control token; it never fetches`);
      continue;
    }
    if (mode === 'none') {
      r('unverifiable', '', 'verification off (--verify none)');
      continue;
    }
    if (!(bot.lists || []).length && !(bot.rdns || []).length) {
      r('unverifiable', '', 'the operator publishes no machine-readable IP list or reverse-DNS domain');
      continue;
    }
    const c = canonicalIp(ip);
    if (!c) {
      r('unverifiable', '', 'no IP address in the log line');
      continue;
    }
    if (isPrivateIp(c.ip)) {
      r('unverifiable', '', 'private/proxy address: the log records a proxy or load balancer, not the client');
      continue;
    }
    const dnsPossible = (bot.rdns || []).length > 0 && !(bot.rdnsIpv4Only && c.family === 6);
    const useDns = (mode === 'dns' || mode === 'both') && dnsPossible && Boolean(resolver);
    const useLists = mode === 'ranges' || mode === 'both' || (mode === 'dns' && !dnsPossible);
    const loaded = (bot.lists || []).map((id) => lists.get(id)).filter((l) => l && !l.error && l.blockList);
    const hit = loaded.find((l) => ipInList(l, c.ip));
    const rangeVerdict = !useLists || !(bot.lists || []).length ? null : !loaded.length ? 'unavailable' : hit ? 'in' : 'out';
    if (rangeVerdict === 'in') {
      r('verified', 'ip-list', `in ${hit.id}`, listVersion(hit));
      continue;
    }
    if (useDns) {
      pending.push({ key, bot, ip: c.ip, rangeVerdict, loaded });
      continue;
    }
    if (rangeVerdict === 'out') {
      if (bot.listAuthoritative === false) r('unverifiable', 'ip-list', `not in ${ids(loaded)}, which is known to be stale; check with --verify dns`, loaded.map(listVersion).join(' '));
      else r('spoofed', 'ip-list', `not in ${ids(loaded)}`, loaded.map(listVersion).join(' '));
    } else if (rangeVerdict === 'unavailable') r('unverifiable', 'ip-list', `IP list ${bot.lists.join(', ')} unavailable (offline or download failed)`);
    else r('unverifiable', '', (bot.lists || []).length ? 'no IP list loaded' : 'no IP list published; use --verify dns or both');
  }
  await mapLimit(pending, Math.max(1, dnsConcurrency), async (p) => {
    if (!dnsCache.has(p.ip)) await wait();
    const d = await dnsCheck(p.ip, p.bot.rdns, resolver, { otherDomains: p.bot.rdnsOther || [], cache: dnsCache });
    const set = (status, method, detail, version = '') => results.set(p.key, { status, method, detail, version });
    const listOut = p.rangeVerdict === 'out' && p.bot.listAuthoritative !== false;
    const versions = p.loaded.map(listVersion).join(' ');
    if (d.ok) return set('verified', 'rdns', `forward-confirmed reverse DNS under ${p.bot.rdns.join(', ')}`);
    if (listOut) return set('spoofed', 'ip-list', `not in ${ids(p.loaded)}; reverse DNS: ${d.reason}`, versions);
    if (d.other) return set('unverifiable', 'rdns', `reverse DNS under ${p.bot.rdnsOther.join(', ')}: the company, but not ${p.bot.name}`);
    if (d.reason === 'dns-error') return set('unverifiable', 'rdns', `DNS lookup failed (${d.detail || 'error'})`);
    const why = { 'no-ptr': 'no reverse DNS name', 'wrong-domain': `reverse DNS name is not under ${p.bot.rdns.join(', ')}`, 'forward-mismatch': 'reverse DNS name does not resolve back to the IP' }[d.reason] || d.reason;
    return set('spoofed', 'rdns', why, versions);
  });
  // With several public hops (CDN or public proxy in front) the right-most one may be the proxy: a failed check proves nothing.
  for (const { bot, ip } of claims) {
    const key = `${bot.name}|${ip}`;
    const r = results.get(key);
    if (r && r.status === 'spoofed' && r.method !== 'control-token' && String(ip).includes(',') && publicHops(ip) > 1) {
      results.set(key, { status: 'unverifiable', method: r.method, detail: 'several public addresses in X-Forwarded-For (CDN or proxy in front?): log CF-Connecting-IP / True-Client-IP', version: r.version });
    }
  }
  return results;
}
