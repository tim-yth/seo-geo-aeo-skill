// Google OAuth for service accounts (JWT RS256), authorized_user refresh tokens, or gcloud fallback.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { UserError, sleep, scriptCmd } from './util.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const SCOPES = {
  gscRead: 'https://www.googleapis.com/auth/webmasters.readonly',
  gscWrite: 'https://www.googleapis.com/auth/webmasters',
  ga4Read: 'https://www.googleapis.com/auth/analytics.readonly',
};

const ADC_LOGIN = `gcloud auth application-default login --scopes=${[SCOPES.gscRead, SCOPES.ga4Read, 'https://www.googleapis.com/auth/cloud-platform'].join(',')}`;

function readCredentialFile(file) {
  if (!fs.existsSync(file)) throw new UserError(`Credentials file not found: ${file}`, { hint: `Copy your service-account JSON into the workspace: ${scriptCmd('init.mjs')} --credentials /path/to/key.json` });
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new UserError(`Credentials file is not valid JSON: ${file}`);
  }
  return json;
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new UserError(`Could not reach Google OAuth (${e.message})`, { hint: 'Check your network connection or proxy settings.' });
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !body.access_token) {
    const reason = `${body.error || `HTTP ${res.status}`}${body.error_description ? `: ${body.error_description}` : ''}`;
    const hint = [];
    if (/invalid_grant/.test(reason) && /signature/i.test(reason)) hint.push('The key was deleted or rotated. Create a new JSON key for the service account and re-run init.mjs --credentials <file> --force.');
    else if (/invalid_grant/.test(reason) && /(timeframe|iat|exp)/i.test(reason)) hint.push('Your system clock is off. Sync the clock (e.g. enable automatic time) and retry.');
    else if (/invalid_grant/.test(reason)) hint.push('The refresh token or key is no longer valid. Re-authenticate (gcloud auth application-default login) or create a new key.');
    else if (/unauthorized_client|invalid_client/.test(reason)) hint.push('The credentials file is malformed or belongs to a disabled client. Download a fresh key.');
    throw new UserError(`Google OAuth token request failed (${reason})`, { hint });
  }
  return { token: body.access_token, expiresIn: Number(body.expires_in) || 3600 };
}

async function serviceAccountToken(creds, scopes) {
  if (!creds.client_email || !creds.private_key) throw new UserError('Service-account JSON is missing client_email or private_key');
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: creds.client_email, scope: scopes.join(' '), aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  let signature;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), creds.private_key).toString('base64url');
  } catch (e) {
    throw new UserError(`Could not sign with the service-account private key (${e.message})`, { hint: 'The private_key field is corrupted. Download a new JSON key.' });
  }
  return tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` });
}

function gcloudToken() {
  const attempts = [
    ['auth', 'application-default', 'print-access-token'],
    ['auth', 'print-access-token'],
  ];
  for (const args of attempts) {
    try {
      const token = execFileSync('gcloud', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).toString().trim();
      if (token && !/\s/.test(token)) return { token, source: args[1] === 'application-default' ? 'gcloud-adc' : 'gcloud' };
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Create a token provider. Order: --access-token / $GOOGLE_OAUTH_ACCESS_TOKEN, --credentials or the
 * config file, $GOOGLE_APPLICATION_CREDENTIALS, then gcloud (ADC first).
 */
export function createTokenProvider({ scopes, credentialsFile, accessToken, quotaProject, label = 'Google API' }) {
  const state = { token: null, at: 0, ttl: 0, source: '', clientEmail: '', quotaProject: quotaProject || process.env.GOOGLE_CLOUD_QUOTA_PROJECT || '' };
  const explicitToken = accessToken || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '';
  const fileCandidates = [credentialsFile, process.env.GOOGLE_APPLICATION_CREDENTIALS].filter(Boolean);

  async function fetchToken() {
    if (explicitToken) return { token: explicitToken, expiresIn: 3000, source: 'access-token' };
    const file = fileCandidates.find((f) => fs.existsSync(f));
    if (file) {
      const creds = readCredentialFile(file);
      if (creds.type === 'service_account') {
        state.clientEmail = creds.client_email || '';
        return { ...(await serviceAccountToken(creds, scopes)), source: 'service-account' };
      }
      if (creds.type === 'authorized_user') {
        if (!state.quotaProject && creds.quota_project_id) state.quotaProject = creds.quota_project_id;
        return { ...(await tokenRequest({ grant_type: 'refresh_token', client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token })), source: 'authorized-user' };
      }
      throw new UserError(`Unsupported credentials type "${creds.type}" in ${file}`, { hint: 'Use a service-account JSON key (recommended) or an authorized_user file from gcloud application-default login.' });
    }
    if (credentialsFile && !fs.existsSync(credentialsFile)) {
      // configured but missing: fall through to gcloud, but remember why
      state.missingFile = credentialsFile;
    }
    const g = gcloudToken();
    if (g) return { token: g.token, expiresIn: 3000, source: g.source };
    throw new UserError(`No Google credentials available for ${label}`, {
      hint: [
        state.missingFile ? `Configured credentials file does not exist: ${state.missingFile}` : 'No credentialsFile is configured.',
        `Recommended: create a service account, download its JSON key, then run ${scriptCmd('init.mjs')} --credentials /path/to/key.json`,
        `Alternative: install gcloud and run: ${ADC_LOGIN}`,
        'Or pass --access-token <token> for a one-off run.',
      ],
    });
  }

  return {
    get info() {
      return { source: state.source, clientEmail: state.clientEmail, quotaProject: state.quotaProject };
    },
    async get(force = false) {
      if (!force && state.token && Date.now() - state.at < (state.ttl - 300) * 1000) return state.token;
      const t = await fetchToken();
      state.token = t.token;
      state.at = Date.now();
      state.ttl = t.expiresIn;
      state.source = t.source;
      return state.token;
    },
    headers() {
      return state.quotaProject && state.source !== 'service-account' ? { 'x-goog-user-project': state.quotaProject } : {};
    },
  };
}

export class GoogleApiError extends UserError {
  constructor(message, { status, reason, hint }) {
    super(message, { hint });
    this.status = status;
    this.reason = reason;
  }
}

const API_LIBRARY = {
  gsc: 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com',
  ga4: 'https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com',
  psi: 'https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com',
  inspection: 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com',
};

/** Turn a Google API error into actionable steps. */
export function explainGoogleError(api, status, message, ctx = {}) {
  const msg = String(message || '');
  const who = ctx.clientEmail ? `the service account ${ctx.clientEmail}` : 'your Google account / service account';
  const hints = [];
  if (/has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) {
    const link = (/(https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"]+)/.exec(msg) || [])[1] || API_LIBRARY[api];
    hints.push(`Enable the API for the credentials' Cloud project: ${link}`, 'Wait 1-5 minutes after enabling, then retry.');
  } else if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg)) {
    hints.push('The token was issued without the needed scope.');
    if (/gcloud/.test(ctx.source || '')) hints.push(`Re-run: ${ADC_LOGIN}`);
    if (ctx.write) hints.push('Writing (e.g. sitemap submit) needs the scope https://www.googleapis.com/auth/webmasters; a service-account key gets it automatically.');
    else hints.push('Prefer a service-account JSON key (init.mjs --credentials <file>), which requests the right scopes itself.');
  } else if (/quota project|x-goog-user-project|requires a quota project/i.test(msg)) {
    hints.push('User credentials need a quota project: gcloud auth application-default set-quota-project <PROJECT_ID>', 'Or pass --quota-project <PROJECT_ID> / set $GOOGLE_CLOUD_QUOTA_PROJECT.');
  } else if (status === 401) {
    hints.push('The access token was rejected. Check that the key still exists and that your clock is correct; tokens from --access-token expire after ~1 hour.');
  } else if (status === 429 || /quota|rate limit/i.test(msg)) {
    if (api === 'inspection') hints.push('URL Inspection allows ~2,000 calls/day and 600/minute per property. Continue tomorrow (use --resume).');
    else if (api === 'psi') hints.push('PageSpeed Insights is rate limited without a key. Create an API key and export PAGESPEED_API_KEY.');
    else hints.push('Quota exceeded. Wait a few minutes and retry with fewer parallel requests.');
  } else if (api === 'gsc' || api === 'inspection') {
    if (status === 403 && ctx.write) {
      hints.push(`Sitemap submission needs ${who} to be an Owner or Full user (not Restricted) in Search Console -> Settings -> Users and permissions.`);
    } else if (status === 403 || /permission|not have access|not authorized/i.test(msg)) {
      hints.push(`Add ${who} in Search Console -> Settings -> Users and permissions -> Add user (Restricted is enough for reading).`);
      hints.push(`Check the property string "${ctx.siteUrl || '?'}": Domain properties look like sc-domain:example.com; URL-prefix properties need the exact protocol, host and trailing slash, e.g. https://www.example.com/`);
      hints.push(`List the properties these credentials can see: ${scriptCmd('check-resources.mjs')}`);
    } else if (status === 404) {
      hints.push(`Property "${ctx.siteUrl || '?'}" was not found. Use sc-domain:example.com or the exact URL-prefix with trailing slash.`);
    } else if (status === 400) {
      hints.push('The request was rejected. Note: GSC regex filters use RE2 syntax (no lookarounds/backreferences); country codes are ISO-3166 alpha-3 lower case (e.g. usa, twn); devices are DESKTOP, MOBILE, TABLET.');
    }
  } else if (api === 'ga4') {
    if (/not a valid (dimension|metric)|Field .* is not a valid|is not a valid/i.test(msg)) {
      hints.push('Check dimension/metric names: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema');
    } else if (status === 403 || /permission/i.test(msg)) {
      hints.push(`Add ${who} in GA4 -> Admin -> Property access management -> + -> Add users, role Viewer.`);
      hints.push('Make sure ga4.propertyId is the numeric Property ID (Admin -> Property details), not the G-XXXX Measurement ID.');
    } else if (status === 404 || status === 400) {
      hints.push('Make sure ga4.propertyId is the numeric Property ID (GA4 -> Admin -> Property details).');
    }
  } else if (api === 'psi') {
    if (/API key not valid|keyInvalid/i.test(msg)) hints.push('PAGESPEED_API_KEY is not valid. Create a key in Cloud Console -> APIs & Services -> Credentials.');
    if (/NO_FCP|NO_LCP|FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST/i.test(msg)) hints.push('Lighthouse could not render the page (blocked by WAF/bot protection, timeout, or a blank page). Try the URL in PageSpeed Insights web UI.');
  }
  return hints;
}

/** JSON request with retries (429/5xx), token refresh on 401 and actionable errors. */
export async function googleRequest(provider, url, { method = 'GET', body, api = 'gsc', ctx = {}, retries = 4, timeoutMs = 120000 } = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await provider.get();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...provider.headers() },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new UserError(`Network error calling ${api.toUpperCase()} API: ${e.message}`);
    }
    if (res.ok) {
      if (res.status === 204) return {};
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    const message = (payload.error && (payload.error.message || payload.error.status)) || `HTTP ${res.status}`;
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await provider.get(true);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries && !/per day|daily/i.test(message)) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt + Math.random() * 500);
      continue;
    }
    const info = provider.info;
    const hint = explainGoogleError(api, res.status, message, { ...ctx, clientEmail: info.clientEmail, source: info.source });
    throw new GoogleApiError(`${api.toUpperCase()} API ${res.status}: ${message}`, { status: res.status, reason: payload.error && payload.error.status, hint });
  }
}
