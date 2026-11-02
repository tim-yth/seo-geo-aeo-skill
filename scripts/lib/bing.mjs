// Bing Webmaster Tools API (JSON protocol; SOAP/POX were retired 2026-08-31): GET
// https://ssl.bing.com/webmaster/api.svc/json/<Method>?apikey=<key>&siteUrl=<url>&..., data wrapped in {"d": ...}.
// Errors arrive as HTTP 400 {"ErrorCode": n, "Message": "..."}; throttling is ErrorCode 4/5 (and 17) on HTTP 400.
// Docs: https://learn.microsoft.com/en-us/bingwebmaster/getting-started and the IWebmasterApi method reference.
import { UserError, sleep } from './util.mjs';
import { redactSecrets } from './providers.mjs';

export const BING_ENDPOINT = 'https://ssl.bing.com/webmaster/api.svc/json';

// ApiErrorCode enum (17 = ThrottleIP is undocumented but seen in the wild).
export const BING_ERROR_CODES = {
  0: 'None', 1: 'InternalError', 2: 'UnknownError', 3: 'InvalidApiKey', 4: 'ThrottleUser', 5: 'ThrottleHost', 6: 'UserBlocked', 7: 'InvalidUrl', 8: 'InvalidParameter',
  9: 'TooManySites', 10: 'UserNotFound', 11: 'NotFound', 12: 'AlreadyExists', 13: 'NotAllowed', 14: 'NotAuthorized', 15: 'UnexpectedState', 16: 'Deprecated', 17: 'ThrottleIP',
};
const THROTTLE = new Set(['ThrottleUser', 'ThrottleHost', 'ThrottleIP']);

/** "/Date(1700000000000)/" or "/Date(1700000000000-0800)/" -> {iso, ymd}; the offset is applied before taking the day. */
export function parseBingDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/$/.exec(String(value).trim());
  if (!m) {
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { iso: s, ymd: s.slice(0, 10) };
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : { iso: new Date(t).toISOString(), ymd: new Date(t).toISOString().slice(0, 10) };
  }
  const ms = Number(m[1]);
  if (ms < 0) return null; // /Date(-62135596800000)/ = DateTime.MinValue (no date)
  const offset = m[2] ? (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) * 60000 : 0;
  return { iso: new Date(ms).toISOString(), ymd: new Date(ms + offset).toISOString().slice(0, 10) };
}

/** Recursively drop "__type" and convert /Date()/ strings: keys ending in "Date" -> YYYY-MM-DD, others -> ISO. */
export function convertDates(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => convertDates(v, key));
  if (value && typeof value === 'object') {
    const outObj = {};
    for (const [k, v] of Object.entries(value)) if (k !== '__type') outObj[k] = convertDates(v, k);
    return outObj;
  }
  if (typeof value === 'string' && /^\/Date\(/.test(value)) {
    const d = parseBingDate(value);
    if (!d) return null;
    return /date$/i.test(key) ? d.ymd : d.iso;
  }
  return value;
}

export function errorName(code, message = '') {
  const n = code === '' || code === null || code === undefined ? NaN : Number(code);
  if (Number.isInteger(n) && n > 0 && BING_ERROR_CODES[n]) return BING_ERROR_CODES[n];
  const m = /(InvalidApiKey|Throttle\w+|UserBlocked|InvalidUrl|InvalidParameter|NotFound|NotAllowed|NotAuthorized|Deprecated|UserNotFound)/.exec(String(message));
  return m ? m[1] : '';
}

export function bingErrorHints(status, name, apiKeyEnv = 'BING_WEBMASTER_API_KEY') {
  if (name === 'InvalidApiKey' || status === 401 || status === 403) {
    return [
      'Generate the key in Bing Webmaster Tools -> Settings -> API access -> API Key -> Generate API Key (a new key can take up to 30 minutes to work).',
      `export ${apiKeyEnv}=<key>  (never in config.json); one key per user works for all sites verified in that account.`,
    ];
  }
  if (THROTTLE.has(name) || status === 429) return ['Bing throttled the request (per-key/host quota): wait a few minutes and retry, or raise --delay.'];
  if (['InvalidUrl', 'NotFound', 'NotAllowed', 'NotAuthorized', 'UserNotFound'].includes(name)) {
    return ['bing.siteUrl must be a site added AND verified in the same Bing Webmaster account as the key (same protocol and host, e.g. https://www.example.com/).', 'Bing Webmaster Tools -> Add a site (Import from Google Search Console is fastest).'];
  }
  if (name === 'InvalidParameter') return ['A parameter was rejected (keyword country is a lowercase 2-letter code such as us, language like en-US; dates YYYY-MM-DD).'];
  if (name === 'Deprecated' || status === 404) return ['This API method is retired or unknown; it is skipped.'];
  if (name === 'UserBlocked') return ['The Bing Webmaster account is blocked from the API; check the account in Bing Webmaster Tools.'];
  return [];
}

/**
 * Minimal client. call(method, params) -> the data inside {"d": ...} with /Date()/ converted. Retries throttling
 * (HTTP 400 ErrorCode 4/5/17, 429, 5xx) with backoff. Every URL and message printed is redacted (apikey=<redacted>).
 */
export function bingClient({ apiKey, siteUrl, endpoint = BING_ENDPOINT, ws, apiKeyEnv, delayMs = 0, timeoutMs = 60000, retries = 2, retryMs = 5000 }) {
  const redact = (s) => redactSecrets(apiKey ? String(s ?? '').split(apiKey).join('<redacted>') : String(s ?? ''), ws);
  let last = 0;
  let calls = 0;
  async function call(method, params = {}, { siteParam = true } = {}) {
    const qs = new URLSearchParams({ apikey: apiKey });
    if (siteParam) qs.set('siteUrl', siteUrl);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const url = `${endpoint.replace(/\/+$/, '')}/${method}?${qs}`;
    for (let attempt = 0; ; attempt++) {
      const wait = last + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      calls++;
      let res;
      let text = '';
      try {
        res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        text = await res.text();
      } catch (e) {
        if (attempt < retries) {
          await sleep(retryMs * 2 ** attempt);
          continue;
        }
        const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : `network error (${redact((e && e.cause && e.cause.code) || (e && e.message) || e)})`;
        throw new UserError(`Bing API ${method}: ${why}`, { hint: [`URL: ${redact(url)}`] });
      }
      if (res.ok) {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new UserError(`Bing API ${method}: response is not JSON`, { hint: [`URL: ${redact(url)}`] });
        }
        return convertDates(json && typeof json === 'object' && 'd' in json ? json.d : json);
      }
      let code = '';
      let message = '';
      try {
        const j = JSON.parse(text);
        const f = j && typeof j === 'object' && 'd' in j && j.d ? j.d : j;
        code = f.ErrorCode ?? '';
        message = String(f.Message || '');
      } catch {
        message = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      }
      const name = errorName(code, message);
      if ((THROTTLE.has(name) || res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(retryMs * 2 ** attempt);
        continue;
      }
      const label = name || (code !== '' ? `ErrorCode ${code}` : '');
      const msg = message.replace(/^ERROR!!!\s*/, '').trim();
      const err = new UserError(`Bing API ${method}: HTTP ${res.status}${label ? ` ${label}` : ''}${msg && msg !== name ? ` - ${redact(msg)}` : ''}`, { hint: [...bingErrorHints(res.status, name, apiKeyEnv), `URL: ${redact(url)}`] });
      err.status = res.status;
      err.bingError = name;
      throw err;
    }
  }
  return { call, siteUrl, redact, calls: () => calls };
}
