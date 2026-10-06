#!/usr/bin/env node
/**
 * SafeFileDrag — package the add-on and submit it to AMO for signing.
 *
 *   pnpm run sign                        unlisted (self-distribution), the default
 *   pnpm run sign -- --channel=listed    submit for an AMO listing
 *   pnpm run sign -- --check             pre-flight only: no upload, no network
 *
 * `web-ext sign` on its own signs *the current directory*, which is the trap this script
 * exists to close: the repository root contains the source manifest, whose `content.js`
 * only exists after the build, so signing there uploads a package that AMO rejects with
 * `MANIFEST_CONTENT_SCRIPT_FILE_NOT_FOUND` — and it also drags `dev/` and `test/` along,
 * which produces a pile of INLINE_SCRIPT warnings for pages that are not part of the
 * add-on at all. `--source-dir dist` is always passed here.
 *
 * Credentials (never committed) come from:
 *   WEB_EXT_API_KEY / WEB_EXT_API_SECRET in the environment, or in a `.env` file next to
 *   this repository's package.json, or `--api-key=... --api-secret=...` as arguments.
 * Create them at https://addons.mozilla.org/developers/addon/api/key/
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWebExtBin } from './lib/firefox.mjs';
import { verifyPackage } from './lib/package-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(ROOT, 'dist');
const ARTIFACTS_DIR = join(ROOT, 'web-ext-artifacts');

const forwarded = process.argv.slice(2);
const preflightOnly = forwarded.includes('--check') || forwarded.includes('--dry-run');
const webExtArgs = forwarded.filter((arg) => arg !== '--check' && arg !== '--dry-run');
const hasFlag = (name) =>
  webExtArgs.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));

/** True when credentials are available to web-ext, from any of its sources. */
function credentialsAvailable() {
  if (process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) return 'environment';
  if (hasFlag('api-key') && hasFlag('api-secret')) return 'arguments';

  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    const contents = readFileSync(envFile, 'utf8');
    if (/^\s*WEB_EXT_API_KEY\s*=/m.test(contents) && /^\s*WEB_EXT_API_SECRET\s*=/m.test(contents)) {
      return '.env';
    }
  }
  return null;
}

async function main() {
  const problems = [];

  if (!existsSync(join(DIST_DIR, 'manifest.json'))) {
    problems.push('dist/manifest.json is missing — run `pnpm run build` (or use `pnpm run sign`).');
  } else {
    const { manifest, problems: mismatches } = await verifyPackage({
      distDir: DIST_DIR,
      manifestPath: join(DIST_DIR, 'manifest.json'),
    });
    problems.push(...mismatches);
    if (mismatches.length === 0) {
      console.log(`  package : ${manifest.name} ${manifest.version} (${DIST_DIR})`);
    }
  }

  const webExtBin = resolveWebExtBin();
  if (!webExtBin) problems.push('the local web-ext CLI was not found — run `pnpm install`.');

  const credentials = credentialsAvailable();
  const args = [
    webExtBin,
    'sign',
    '--source-dir',
    DIST_DIR,
    ...(hasFlag('channel') ? [] : ['--channel=unlisted']),
    ...webExtArgs,
  ];

  console.log('SafeFileDrag — sign');
  console.log(`  command : node ${args.join(' ')}`);
  console.log(`  output  : ${ARTIFACTS_DIR} (git-ignored)`);

  if (problems.length > 0) {
    console.error('\ncannot sign:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  if (preflightOnly) {
    console.log('\npre-flight only (--check): nothing was uploaded.');
    console.log(`  credentials : ${credentials ?? '(none found — a real run would stop here)'}`);
    return;
  }

  if (!credentials) {
    console.error('\nno AMO API credentials found, so web-ext would fail after the upload step.');
    console.error('Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET (environment or a .env file next');
    console.error('to package.json), or pass --api-key=... --api-secret=... . Create them at');
    console.error('https://addons.mozilla.org/developers/addon/api/key/ — and never commit them.');
    process.exitCode = 1;
    return;
  }

  console.log(`  credentials : from ${credentials}`);
  console.log('');

  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
    if (code === 0) console.log(`\nsigned — see ${ARTIFACTS_DIR}`);
  });
}

await main();
