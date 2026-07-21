#!/usr/bin/env node
// Guard rail: fail the build if catalog.json would publish something broken.
// Runs in CI on every push/PR and in the sync workflow before it commits, so
// a malformed or invariant-violating catalog can never reach production.
//
//   node tools/verify-catalog.mjs [path-to-catalog.json]

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCatalog, hasErrors, referencedAssets} from './lib-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || path.join(ROOT, 'catalog.json');

let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e){
  console.error(`✗ could not read/parse ${file}: ${e.message}`);
  process.exit(1);
}

const problems = validateCatalog(catalog);
const assets = referencedAssets(catalog);
for (const p of problems)
  console.log(`  ${p.level === 'error' ? '✗ error' : '‼ warn '}: ${p.msg}`);

const errors = problems.filter(p => p.level === 'error').length;
const warns = problems.filter(p => p.level === 'warn').length;
console.log(`\n  ${assets.length} media asset(s) referenced · ${errors} error(s) · ${warns} warning(s)`);

if (hasErrors(problems)){
  console.error('\n  catalog.json is not publishable — fix the errors above.');
  process.exit(1);
}
console.log('  catalog.json is internally consistent. ✓');
