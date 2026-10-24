#!/usr/bin/env node
/**
 * SafeFileDrag — remove generated output.
 *
 *   pnpm run clean             dist/, .test-build/ and web-ext-artifacts/
 *   pnpm run clean -- --dry-run  list what would be removed, remove nothing
 *   pnpm run clean -- --all      the above plus node_modules/ (then `pnpm install`)
 *
 * Only the fixed names below are ever touched, each resolved against this
 * repository's root, so a stray `clean` cannot delete an unrelated directory. The
 * build already starts by wiping `dist/`, so the interesting part is the rest:
 * `.test-build/` (bundled tests) and `web-ext-artifacts/` (signed .xpi / .zip files)
 * are otherwise left behind, and the artifacts are the ones easy to mistake for
 * something worth keeping.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUTS = ['dist', '.test-build', 'web-ext-artifacts'];
const DEPENDENCIES = 'node_modules';

const forwarded = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = forwarded.includes('--dry-run');
const includeDependencies = forwarded.includes('--all');
const unknown = forwarded.filter((arg) => arg !== '--dry-run' && arg !== '--all');

if (unknown.length > 0) {
  console.error(`unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}`);
  console.error('usage: pnpm run clean [-- --dry-run] [-- --all]');
  process.exit(1);
}

/** Bytes below a directory, for the "freed" summary. Symlinks are not followed. */
function sizeOf(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOf(join(path, entry.name));
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const targets = [...OUTPUTS, ...(includeDependencies ? [DEPENDENCIES] : [])];
let freed = 0;

console.log(`SafeFileDrag — clean${dryRun ? ' (dry run)' : ''}`);

for (const name of targets) {
  const path = join(ROOT, name);
  if (!existsSync(path)) {
    console.log(`  absent  : ${name}/`);
    continue;
  }
  const bytes = sizeOf(path);
  freed += bytes;
  if (dryRun) {
    console.log(`  would rm: ${name}/ (${formatBytes(bytes)})`);
  } else {
    await rm(path, { recursive: true, force: true });
    console.log(`  removed : ${name}/ (${formatBytes(bytes)})`);
  }
}

console.log('');
console.log(
  dryRun
    ? `${formatBytes(freed)} would be freed.`
    : freed > 0
      ? `${formatBytes(freed)} freed.${includeDependencies ? ' Run `pnpm install` to restore dependencies.' : ''}`
      : 'nothing to remove.',
);
