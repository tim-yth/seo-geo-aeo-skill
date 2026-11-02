#!/usr/bin/env node
// Offline test runner: imports every test/*.test.mjs file and runs the registered cases in order.
// Usage: node scripts/test/run-tests.mjs [name-filter] [--file file-filter]
//   name-filter  regex on test names (only matching cases run)
//   --file f     regex on test file names (only matching files are imported)
// A test file that fails to import is reported as a failure; the other files still run.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEST_DIR, registered, cleanupTemps } from './harness.mjs';

const args = process.argv.slice(2);
let nameFilter = null;
let fileFilter = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') fileFilter = new RegExp(args[++i] || '.', 'i');
  else if (args[i].startsWith('--file=')) fileFilter = new RegExp(args[i].slice(7), 'i');
  else nameFilter = new RegExp(args[i], 'i');
}
const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs') && (!fileFilter || fileFilter.test(f))).sort();
let failed = 0;
for (const f of files) {
  try {
    await import(pathToFileURL(path.join(TEST_DIR, f)).href);
  } catch (err) {
    failed++;
    process.stdout.write(`  FAIL (import) ${f}\n       ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n       ')}\n`);
  }
}

let passed = 0;
const started = Date.now();
for (const { name, fn } of registered()) {
  if (nameFilter && !nameFilter.test(name)) continue;
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    process.stdout.write(`  ok   ${name} (${Date.now() - t0}ms)\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  FAIL ${name}\n       ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n       ')}\n`);
  }
}
cleanupTemps();
process.stdout.write(`\n${passed} passed, ${failed} failed (${files.length} files, ${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
process.exitCode = failed ? 1 : 0;
