#!/usr/bin/env node
/**
 * SafeFileDrag — automated check against a real Gecko.
 *
 *   pnpm run test:gecko              headless (default)
 *   pnpm run test:gecko -- --headed  watch it happen in a window
 *
 * What this adds over the jsdom suite (`pnpm run test`) is everything that depends on
 * the browser itself, and nothing that can be faked in a DOM stub:
 *
 *   - the manifest is accepted and the content script really is injected in the page's
 *     own world (`world: "MAIN"`) at `document_start`: the probe page reads the install
 *     marker from a `<head>` script, and checks that no WebExtension APIs are present;
 *   - the payloads are real `DataTransfer` objects carrying real `File`s, so
 *     `DataTransfer.types` ("Files") is the browser's answer, not a fixture;
 *   - the verdicts come from Gecko's own dispatch, `composedPath()` and shadow
 *     retargeting, including the open-shadow-root case fixed in 96eb814.
 *
 * What it still cannot prove — and why — is listed in the README: a real OS file drag is
 * needed to observe the navigation default action and the native `<input type="file">`
 * accepting a drop, which WebDriver cannot inject.
 *
 * The browser is driven through `web-ext run`: the probe page asserts, then POSTs its
 * results back to this script's http server. No WebDriver, no geckodriver, no extra
 * dependency.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  killWebExtTree,
  resolveFirefoxPath,
  resolveWebExtBin,
  spawnWebExtRun,
  webExtRunArgs,
} from './lib/firefox.mjs';
import { startStaticServer } from './lib/static-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(ROOT, 'dist');
const PAGE_DIR = join(ROOT, 'test', 'gecko');
const BASE_PORT = 8796;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Fewer results than this means the page never finished its checks. */
const MIN_CHECKS = 10;

function parseArgs(argv) {
  const options = { headed: false, firefox: null, timeout: DEFAULT_TIMEOUT_MS, passthrough: [] };
  for (const arg of argv) {
    if (arg === '--headed') options.headed = true;
    else if (arg.startsWith('--firefox=')) options.firefox = arg.slice('--firefox='.length);
    else if (arg.startsWith('--timeout=')) options.timeout = Number(arg.slice('--timeout='.length));
    else options.passthrough.push(arg);
  }
  return options;
}

function fail(problems) {
  console.error('SafeFileDrag — Gecko check: cannot run');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}

const options = parseArgs(process.argv.slice(2));
const problems = [];

if (!existsSync(join(DIST_DIR, 'manifest.json')) || !existsSync(join(DIST_DIR, 'content.js'))) {
  problems.push('dist/ is missing — run `pnpm run build` (the npm script does it for you).');
}
const webExtBin = resolveWebExtBin();
if (!webExtBin) problems.push('the local web-ext CLI was not found — run `pnpm install`.');
const firefox = resolveFirefoxPath(options.firefox);
if (!firefox) {
  problems.push('no Firefox executable found — set FIREFOX_BIN or pass --firefox=<path>.');
}
if (problems.length) {
  fail(problems);
} else {
  await run();
}

async function run() {
  /** @type {((payload: any) => void) | null} */
  let resolveResult = null;
  const resultPromise = new Promise((resolvePromise) => {
    resolveResult = resolvePromise;
  });

  const server = await startStaticServer({
    root: PAGE_DIR,
    port: BASE_PORT,
    onRequest: ({ request, url, send }) => {
      if (url.pathname !== '/__result' || request.method !== 'POST') return false;

      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        send(200, 'text/plain; charset=utf-8', 'ok');
        try {
          resolveResult?.(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          resolveResult?.({ ok: false, summary: `unreadable report: ${error.message}`, results: [] });
        }
      });
      return true;
    },
  });

  const pageUrl = server.url;
  const extra = options.headed ? options.passthrough : ['--arg=-headless', ...options.passthrough];

  console.log('SafeFileDrag — Gecko check');
  console.log(`  firefox : ${firefox}`);
  console.log(`  add-on  : ${DIST_DIR} (temporary install)`);
  console.log(`  page    : ${pageUrl}`);
  console.log(`  mode    : ${options.headed ? 'headed' : 'headless'}`);
  console.log(`  command : node ${webExtRunArgs({ webExtBin, sourceDir: DIST_DIR, startUrl: pageUrl, firefox, extra }).join(' ')}`);

  const child = spawnWebExtRun({
    webExtBin,
    sourceDir: DIST_DIR,
    startUrl: pageUrl,
    firefox,
    extra,
  });

  let childExited = null;
  child.on('exit', (code, signal) => {
    childExited = signal ? `signal ${signal}` : `code ${code}`;
  });

  const timeout = new Promise((resolvePromise) => {
    setTimeout(() => resolvePromise({ timedOut: true }), options.timeout).unref?.();
  });
  const exitWatch = new Promise((resolvePromise) => {
    const poll = setInterval(() => {
      if (childExited !== null) {
        clearInterval(poll);
        resolvePromise({ exited: childExited });
      }
    }, 200);
    poll.unref?.();
  });

  const outcome = await Promise.race([resultPromise, timeout, exitWatch]);

  killWebExtTree(child);
  server.close();

  if (outcome?.timedOut) {
    console.error(`\nno report from the probe page within ${Math.round(options.timeout / 1000)}s.`);
    console.error('Firefox output above should say why; the page reports back over http, so a');
    console.error('blocked or crashed content script shows up here.');
    process.exitCode = 1;
    return;
  }
  if (outcome?.exited) {
    console.error(`\nweb-ext exited early (${outcome.exited}) before the page reported.`);
    process.exitCode = 1;
    return;
  }

  report(outcome);
}

function report(payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const failed = results.filter((result) => !result.ok);

  console.log(`\n  ${payload.summary ?? `${results.length} checks`}`);
  for (const result of results) {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
    if (result.detail) console.log(`        ${result.detail}`);
  }

  const evidence = payload.evidence ?? {};
  console.log('\n  evidence from the browser');
  for (const [key, value] of Object.entries(evidence)) {
    console.log(`    ${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`);
  }

  if (results.length < MIN_CHECKS) {
    console.error(`\nonly ${results.length} checks reported (expected at least ${MIN_CHECKS}).`);
    process.exitCode = 1;
    return;
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${results.length} checks failed.`);
    if (!results[0]?.ok) {
      console.error('The first check is the injection itself: if it fails, Firefox did not load');
      console.error('the add-on (or did not run it in the page world at document_start).');
    }
    process.exitCode = 1;
    return;
  }
  console.log('\nok — every check passed in Gecko.');
}
