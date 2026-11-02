// Tiny offline test harness: test files register cases with test(name, fn).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export { assert };
export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.resolve(TEST_DIR, '..');
export const FIXTURES = path.join(TEST_DIR, 'fixtures');

const cases = [];
export function test(name, fn) {
  cases.push({ name, fn });
}
export function registered() {
  return cases;
}

/** Fresh temporary directory (removed by the runner at exit). */
const temps = [];
export function tmpDir(prefix = 'seo-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
export function cleanupTemps() {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
}

/** API keys that must never reach a test (tests use local mock servers; pass a fake key explicitly via `env`). */
export const SECRET_ENV_NAMES = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'BING_WEBMASTER_API_KEY', 'BRAVE_SEARCH_API_KEY', 'PAGESPEED_API_KEY', 'CRUX_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'AHREFS_API_KEY', 'SEMRUSH_API_KEY', 'INDEXNOW_KEY'];
for (const name of SECRET_ENV_NAMES) delete process.env[name];
const childEnv = (env) => ({ ...process.env, SEO_AGENT_WORKSPACE: '', GOOGLE_APPLICATION_CREDENTIALS: '', GOOGLE_OAUTH_ACCESS_TOKEN: '', ...Object.fromEntries(SECRET_ENV_NAMES.map((n) => [n, ''])), ...env });

/** Run a script asynchronously (keeps in-process test servers responsive): resolves {status, stdout, stderr}. */
export function runScript(name, args = [], { cwd, env, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, name), ...args], { cwd: cwd || os.tmpdir(), env: childEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Synchronous variant for scripts that need no in-process server. */
export function runScriptSync(name, args = [], { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, name), ...args], { cwd: cwd || os.tmpdir(), env: childEnv(env), encoding: 'utf8', timeout: 120000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Create a workspace via init.mjs in a temp dir; returns its path. */
export function makeWorkspace(extraArgs = []) {
  const dir = path.join(tmpDir('seo-ws-'), '.seo-agent');
  const r = runScriptSync('init.mjs', ['--workspace', dir, '--url', 'https://www.example.com', '--timezone', 'Asia/Taipei', '--no-gitignore', ...extraArgs]);
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}`);
  return dir;
}

/**
 * Local static HTTP server for crawler tests. `routes` maps path -> {status, body, headers} or a
 * function(req) returning that; files from `rootDir` are served with {{ORIGIN}} replaced.
 */
export async function startServer({ routes = {}, rootDir } = {}) {
  let origin = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    let route = routes[url.pathname + url.search] || routes[url.pathname];
    if (typeof route === 'function') route = route(req, url);
    if (!route && rootDir) {
      let file = path.join(rootDir, decodeURIComponent(url.pathname));
      if (file.endsWith('/') || (fs.existsSync(file) && fs.statSync(file).isDirectory())) file = path.join(file, 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = file.endsWith('.xml') ? 'application/xml' : file.endsWith('.txt') ? 'text/plain' : file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8';
        route = { status: 200, headers: { 'content-type': type }, body: fs.readFileSync(file, 'utf8') };
      }
    }
    if (!route) route = { status: 404, headers: { 'content-type': 'text/html' }, body: '<html><head><title>Not found</title></head><body>404</body></html>' };
    const body = String(route.body ?? '').replaceAll('{{ORIGIN}}', origin);
    res.writeHead(route.status || 200, { 'content-type': 'text/html; charset=utf-8', ...(route.headers || {}) });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Read/modify/write a workspace config.json. */
export function editConfig(ws, fn) {
  const file = path.join(ws, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(cfg);
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return cfg;
}

/** Newest data file in <ws>/data/<source> whose name matches re. */
export function dataFile(ws, source, re) {
  const dir = path.join(ws, 'data', source);
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => re.test(x)).sort().pop() : null;
  return f ? path.join(dir, f) : null;
}
