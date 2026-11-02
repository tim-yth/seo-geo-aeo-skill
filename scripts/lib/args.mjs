// Minimal declarative CLI parser with generated --help output.
import { UserError } from './util.mjs';

const camel = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function suggest(name, names) {
  let best = null;
  let bestScore = Infinity;
  for (const candidate of names) {
    const score = levenshtein(name, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best && bestScore <= Math.max(2, Math.floor(name.length / 3)) ? `Did you mean --${best}?` : 'Run with --help to see the options.';
}

function convert(def, value, name) {
  if (def.type === 'number' || def.type === 'int') {
    const n = Number(value);
    if (!Number.isFinite(n) || (def.type === 'int' && !Number.isInteger(n))) {
      throw new UserError(`Option --${name} expects ${def.type === 'int' ? 'an integer' : 'a number'}, got "${value}"`);
    }
    return n;
  }
  if (def.choices && !def.choices.includes(value)) {
    throw new UserError(`Option --${name} must be one of: ${def.choices.join(', ')} (got "${value}")`);
  }
  return value;
}

/**
 * spec: { 'flag-name': { type: 'string'|'number'|'int'|'boolean'|'list'|'csv', default, desc, placeholder, choices, short } }
 * 'list' is repeatable; 'csv' is repeatable and also split on commas.
 */
export function parseArgs(argv, spec) {
  const flags = {};
  const positionals = [];
  const shorts = new Map();
  for (const [name, def] of Object.entries(spec)) {
    const key = camel(name);
    if (def.short) shorts.set(def.short, name);
    if (def.type === 'list' || def.type === 'csv') flags[key] = def.default ? [...def.default] : [];
    else if (def.default !== undefined) flags[key] = def.default;
    else if (def.type === 'boolean') flags[key] = false;
  }
  const seenLists = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    let name;
    let value;
    if (arg.startsWith('--')) {
      name = arg.slice(2);
      const eq = name.indexOf('=');
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
    } else if (/^-[a-zA-Z]$/.test(arg) && shorts.has(arg[1])) {
      name = shorts.get(arg[1]);
    } else {
      positionals.push(arg);
      continue;
    }
    let def = spec[name];
    if (!def && name.startsWith('no-') && spec[name.slice(3)] && spec[name.slice(3)].type === 'boolean') {
      flags[camel(name.slice(3))] = false;
      continue;
    }
    if (!def) throw new UserError(`Unknown option --${name}`, { hint: suggest(name, Object.keys(spec)) });
    const key = camel(name);
    if (def.type === 'boolean') {
      if (value === undefined) flags[key] = true;
      else if (/^(1|true|yes|on)$/i.test(value)) flags[key] = true;
      else if (/^(0|false|no|off)$/i.test(value)) flags[key] = false;
      else throw new UserError(`Option --${name} is a switch; use --${name} or --no-${name}`);
      continue;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2) || (next.startsWith('-') && next.length === 2 && !/^-\d$/.test(next))) {
        throw new UserError(`Option --${name} requires a value${def.placeholder ? ` (${def.placeholder})` : ''}`);
      }
      value = next;
      i++;
    }
    if (def.type === 'list' || def.type === 'csv') {
      if (!seenLists.has(key)) {
        flags[key] = [];
        seenLists.add(key);
      }
      const parts = def.type === 'csv' ? value.split(',').map((s) => s.trim()).filter(Boolean) : [value];
      flags[key].push(...parts.map((p) => convert(def, p, name)));
    } else {
      flags[key] = convert(def, value, name);
    }
  }
  return { flags, positionals };
}

export function formatHelp({ usage, summary, spec, examples = [], notes = [] }) {
  const lines = [];
  lines.push(`Usage: ${[].concat(usage).join('\n       ')}`, '');
  if (summary) lines.push(summary.trim(), '');
  const rows = Object.entries(spec)
    .filter(([, def]) => !def.hidden)
    .map(([name, def]) => {
      let left = `--${name}`;
      if (def.short) left = `-${def.short}, ${left}`;
      if (def.type !== 'boolean') left += ` <${def.placeholder || (def.type === 'number' || def.type === 'int' ? 'n' : 'value')}>`;
      let desc = def.desc || '';
      if (def.type === 'list' || def.type === 'csv') desc += ' (repeatable)';
      if (def.default !== undefined && def.default !== '' && !(Array.isArray(def.default) && !def.default.length) && def.type !== 'boolean') {
        desc += ` [default: ${Array.isArray(def.default) ? def.default.join(',') : def.default}]`;
      }
      return [left, desc];
    });
  rows.push(['-h, --help', 'Show this help']);
  const width = Math.min(38, Math.max(...rows.map(([l]) => l.length)) + 2);
  lines.push('Options:');
  for (const [left, desc] of rows) {
    if (left.length + 2 > width) lines.push(`  ${left}`, `  ${' '.repeat(width)}${desc}`);
    else lines.push(`  ${left.padEnd(width)}${desc}`);
  }
  if (examples.length) {
    lines.push('', 'Examples:');
    for (const ex of examples) lines.push(`  ${ex}`);
  }
  if (notes.length) {
    lines.push('', 'Notes:');
    for (const note of notes) lines.push(`  - ${note}`);
  }
  return `${lines.join('\n')}\n`;
}

export const COMMON_FLAGS = {
  workspace: { type: 'string', placeholder: 'dir', desc: 'Workspace directory (default: ./.seo-agent or $SEO_AGENT_WORKSPACE)' },
  debug: { type: 'boolean', desc: 'Print stack traces on errors' },
};

export const GOOGLE_FLAGS = {
  credentials: { type: 'string', placeholder: 'file', desc: 'Service-account (or authorized_user) JSON; overrides config' },
  'access-token': { type: 'string', placeholder: 'token', desc: 'Use this OAuth access token instead of credentials (also $GOOGLE_OAUTH_ACCESS_TOKEN)' },
  'quota-project': { type: 'string', placeholder: 'id', desc: 'Quota project for user (gcloud) credentials (also $GOOGLE_CLOUD_QUOTA_PROJECT)' },
};

/** Parse "a:b" into {start, end}. */
export function parseRangeArg(value, name) {
  const m = /^(\d{4}-\d{2}-\d{2})(?::|\.\.)(\d{4}-\d{2}-\d{2})$/.exec(String(value || '').trim());
  if (!m) throw new UserError(`--${name} must look like YYYY-MM-DD:YYYY-MM-DD (got "${value}")`);
  if (m[1] > m[2]) throw new UserError(`--${name} start date is after end date (${value})`);
  return { start: m[1], end: m[2] };
}
