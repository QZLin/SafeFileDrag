#!/usr/bin/env node
/**
 * SafeFileDrag — manual test launcher.
 *
 *   pnpm start                build is run first by the npm script, then:
 *                             serve ./dev over http://127.0.0.1:<port>/ and start
 *                             Firefox with ./dist installed as a *temporary* add-on.
 *   pnpm start -- --check     everything except launching Firefox (plumbing check).
 *
 * The page served from ./dev is a hand-testing playground. A local http origin is
 * used on purpose: content scripts never run on `data:` URLs, and `file://` needs an
 * extra per-add-on permission that would only add a failure mode.
 *
 * Extra arguments are forwarded to `web-ext run`, e.g.
 *   pnpm start -- --arg=-headless
 *   pnpm start -- --firefox="D:\\other\\firefox.exe"
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { killWebExtTree, resolveFirefoxPath, resolveWebExtBin, spawnWebExtRun, webExtRunArgs } from './lib/firefox.mjs';
import { startStaticServer } from './lib/static-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_DIR = join(ROOT, 'dev');
const DIST_DIR = join(ROOT, 'dist');
const BASE_PORT = 8788;

function parseArgs(argv) {
  const options = { check: false, port: null, firefox: null, passthrough: [] };
  for (const arg of argv) {
    // pnpm forwards the `--` separator itself; web-ext must not see it, or it would treat
    // everything after it as positional arguments.
    if (arg === '--') continue;
    if (arg === '--check' || arg === '--dry-run') options.check = true;
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--firefox=')) options.firefox = arg.slice('--firefox='.length);
    else options.passthrough.push(arg);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const problems = [];

  if (!existsSync(join(DIST_DIR, 'manifest.json')) || !existsSync(join(DIST_DIR, 'content.js'))) {
    problems.push('dist/ is missing or incomplete — run `pnpm run build` (or use `pnpm start`).');
  }
  const webExtBin = resolveWebExtBin();
  if (!webExtBin) {
    problems.push('the local web-ext CLI was not found — run `pnpm install`.');
  }
  const firefox = resolveFirefoxPath(options.firefox);
  if (!firefox) {
    problems.push(
      'no Firefox executable found — set FIREFOX_BIN, pass --firefox=<path>, or let web-ext search for it.',
    );
  }

  const server = await startStaticServer({
    root: DEV_DIR,
    port: Number(options.port) || BASE_PORT,
  });
  const pageUrl = server.url;

  if (options.check) {
    let page = 'unreachable';
    try {
      const response = await fetch(pageUrl);
      const html = await response.text();
      page = `${response.status} ${response.headers.get('content-type')} (${html.length} bytes)`;

      // The page loads its own script externally, so a typo in that path would otherwise
      // only show up in the browser: fetch every local asset the page references.
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((asset) => asset && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(asset));
      for (const asset of assets) {
        try {
          const assetResponse = await fetch(new URL(asset, pageUrl));
          const body = await assetResponse.text();
          console.log(
            `  asset       : ${asset} -> ${assetResponse.status} ${assetResponse.headers.get('content-type')} (${body.length} bytes)`,
          );
          if (!assetResponse.ok) problems.push(`the page asset ${asset} returned ${assetResponse.status}.`);
        } catch (error) {
          problems.push(`the page asset ${asset} could not be fetched: ${error.message}`);
        }
      }
    } catch (error) {
      problems.push(`the test page could not be fetched: ${error.message}`);
    }
    server.close();

    console.log('SafeFileDrag manual-test launcher — check');
    console.log(`  page        : ${pageUrl} -> ${page}`);
    console.log(`  add-on      : ${DIST_DIR}`);
    console.log(`  firefox     : ${firefox ?? '(not found; web-ext will search)'}`);
    console.log(`  web-ext CLI : ${webExtBin ?? '(not found)'}`);
    console.log(`  command     : node ${webExtRunArgs({ webExtBin, sourceDir: DIST_DIR, startUrl: pageUrl, firefox, extra: options.passthrough }).join(' ')}`);
    if (problems.length) {
      console.error('\nproblems:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nok — nothing below this line is launched in --check mode.');
    return;
  }

  if (problems.length) {
    for (const problem of problems) console.error(`- ${problem}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  console.log('SafeFileDrag — manual test');
  console.log(`  page   : ${pageUrl}`);
  console.log(`  add-on : ${DIST_DIR} (temporary install)`);
  console.log('  Drop a local file on the page and check the log; close Firefox (or press');
  console.log('  Ctrl+C here) to stop. Rebuild + restart to pick up extension changes.');

  const child = spawnWebExtRun({
    webExtBin,
    sourceDir: DIST_DIR,
    startUrl: pageUrl,
    firefox,
    extra: options.passthrough,
  });

  const stop = () => killWebExtTree(child);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  child.on('exit', (code, signal) => {
    server.close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}

await main();
