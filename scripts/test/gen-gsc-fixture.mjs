#!/usr/bin/env node
// Regenerates test/fixtures/gsc-daily.json: synthetic, deterministic Search Console rows
// (date x query x page) for a fictional site with a known treatment effect on /guides/ pages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../lib/stats.mjs';
import { addDays, weekday } from '../lib/dates.mjs';
import { expectedCtr } from '../lib/metrics.mjs';

const ORIGIN = 'https://www.example.com';
const START = '2026-07-27';
const DAYS = 100;
export const DEPLOY_DATE = '2026-09-29'; // site-local (Asia/Taipei) -> PT days 2026-09-28/29 excluded

// [query, path, impressions/day, position before, position after]
const PAIRS = [
  ['example coffee', '/', 40, 1.1, 1.1],
  ['examplecoffee', '/', 8, 1.0, 1.0],
  ['coffee', '/', 120, 24, 24],
  ['pour over ratio', '/guides/pour-over/', 60, 6.5, 3.0],
  ['how to make pour over coffee', '/guides/pour-over/', 45, 9.0, 4.5],
  ['pour over', '/guides/pour-over/', 50, 4.2, 4.0],
  ['french press ratio', '/guides/french-press/', 35, 12.5, 7.5],
  ['best coffee grinder', '/blog/best-grinders/', 80, 14, 14],
  ['burr vs blade grinder', '/blog/best-grinders/', 30, 7, 7],
  ['how to store coffee beans', '/blog/coffee-storage/', 55, 5, 5],
  ['coffee storage', '/blog/coffee-storage/', 20, 8, 8],
  ['coffee ratio calculator', '/tools/ratio-calculator/', 40, 2, 2],
  ['pour over ratio', '/tools/ratio-calculator/', 30, 9, 9],
  ['best coffee 2019', '/blog/old-2019-post/', 50, 9.5, 9.5],
  ['咖啡 比例', '/guides/pour-over/', 15, 8, 4],
  ['手沖咖啡 比例', '/guides/pour-over/', 18, 7, 3.5],
  ['手沖咖啡 教學', '/guides/pour-over/', 12, 11, 6],
  ['cold brew ratio', '/recipes/cold-brew/', 14, 6, 6],
  ['cold brew ratio', '/tools/ratio-calculator/', 14, 6, 6],
];
const LATE = '2026-09-29'; // start of the "current" 28-day window when the data ends 2026-10-26

// Extra patterns (outside the /guides/ treatment and /blog/ control groups):
// decliner, rank-up-but-CTR-down, rotating cannibalization that loses position.
function modifiers(query, p, date, i) {
  const late = date >= LATE;
  if (query === 'coffee ratio calculator' && late) return { position: 6.5 };
  if (query === 'coffee' && late) return { position: 15, ctr: 0.3 };
  if (query === 'cold brew ratio') {
    const even = i % 2 === 0;
    const mine = p.startsWith('/recipes/') ? even : !even;
    return { impressions: mine ? 2 : 0.6, position: late ? 9.5 : 6 };
  }
  return {};
}

export function generate() {
  const rand = mulberry32(42);
  const rows = [];
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(START, i);
    const after = date >= '2026-09-30';
    const weekend = [0, 6].includes(weekday(date)) ? 0.8 : 1;
    for (const [query, p, base, before, afterPos] of PAIRS) {
      const treated = p.startsWith('/guides/');
      const mod = modifiers(query, p, date, i);
      const impressions = Math.max(1, Math.round(base * (mod.impressions || 1) * weekend * (treated && after ? 1.2 : 1) * (0.85 + rand() * 0.3)));
      const position = Math.max(1, (mod.position || (after ? afterPos : before)) * (0.9 + rand() * 0.2));
      let ctrFactor = (0.8 + rand() * 0.4) * (mod.ctr || 1);
      if (query.includes('example')) ctrFactor = 1.6;
      const noise = query === 'best coffee 2019' ? 0 : rand() < 0.3 ? rand() : 0;
      const clicks = query === 'best coffee 2019' ? 0 : Math.min(impressions, Math.round(impressions * expectedCtr(position) * ctrFactor + noise));
      rows.push({ date, query, page: `${ORIGIN}${p}`, clicks, impressions, ctr: clicks / impressions, position: Math.round(position * 10) / 10 });
    }
  }
  return {
    meta: { tool: 'gsc-export', siteUrl: 'sc-domain:example.com', startDate: START, endDate: addDays(START, DAYS - 1), days: DAYS, dimensions: ['date', 'query', 'page'], type: 'web', dataState: 'final', synthetic: true },
    rows,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gsc-daily.json');
  fs.writeFileSync(file, `${JSON.stringify(generate())}\n`);
  process.stdout.write(`wrote ${file}\n`);
}
