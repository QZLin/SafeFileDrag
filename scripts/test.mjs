/**
 * Test runner for SafeFileDrag.
 *
 * The suite is TypeScript that imports the shipping sources directly, which Node
 * cannot execute (`.ts` files, and `./guard.js` specifiers that TypeScript resolves to
 * `guard.ts`). This script bundles every test file with esbuild — the compiler the
 * build step already uses — into `.test-build/`, then hands the result to Node's
 * built-in test runner. No test framework, no runtime dependency, nothing to install.
 *
 * Usage:
 *   node scripts/test.mjs
 *   node scripts/test.mjs --test-name-pattern=shadow
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');
const outDir = join(root, '.test-build');
// pnpm forwards the `--` separator itself, and Node would read a bare `--` as the end of
// its own options — turning the forwarded flags into file paths.
const passthrough = process.argv.slice(2).filter((arg) => arg !== '--');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const bundle = (entryPoint, outfile) =>
  build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    // Only the sources under test are bundled. jsdom stays a runtime import: it is a
    // CommonJS package with dynamic requires, which an ESM bundle cannot express.
    packages: 'external',
    sourcemap: 'inline',
    logLevel: 'warning',
  });

const names = (await readdir(testDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => entry.name)
  .sort();

if (names.length === 0) {
  console.error('no *.test.ts files found in test/');
  process.exit(1);
}

const built = [];
for (const name of names) {
  const outfile = join(outDir, `${basename(name, '.ts')}.mjs`);
  await bundle(join(testDir, name), outfile);
  built.push(outfile);
}

// The content script is bundled twice on purpose: `test/content.test.ts` injects it,
// then injects the identical bundle a second time to prove the install marker holds.
await bundle(join(root, 'src', 'content.ts'), join(outDir, 'content.entry.mjs'));
await bundle(join(root, 'src', 'content.ts'), join(outDir, 'content.reinjection.mjs'));

console.log(`bundled ${built.length} test files into .test-build/`);

const child = spawn(
  process.execPath,
  ['--test', '--enable-source-maps', ...passthrough, ...built],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
