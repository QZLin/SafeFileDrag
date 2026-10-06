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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_DIR = join(ROOT, 'dev');
const DIST_DIR = join(ROOT, 'dist');
const HOST = '127.0.0.1';
const BASE_PORT = 8788;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Where Firefox usually lives on Windows; `FIREFOX_BIN` overrides everything. */
const FIREFOX_CANDIDATES = [
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Mozilla Firefox', 'firefox.exe'),
  'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
].filter(Boolean);

function parseArgs(argv) {
  const options = { check: false, port: null, firefox: null, passthrough: [] };
  for (const arg of argv) {
    if (arg === '--check' || arg === '--dry-run') options.check = true;
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--firefox=')) options.firefox = arg.slice('--firefox='.length);
    else options.passthrough.push(arg);
  }
  return options;
}

function resolveFirefox(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.FIREFOX_BIN) {
    return existsSync(process.env.FIREFOX_BIN) ? process.env.FIREFOX_BIN : null;
  }
  return FIREFOX_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** Resolves the local `web-ext` CLI entry point (its exports map hides the bin). */
function resolveWebExtBin() {
  const entry = fileURLToPath(import.meta.resolve('web-ext')); // .../web-ext/index.js
  const bin = join(dirname(entry), 'bin', 'web-ext.js');
  return existsSync(bin) ? bin : null;
}

function createStaticServer() {
  return createServer(async (request, response) => {
    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };

    try {
      const url = new URL(request.url ?? '/', `http://${HOST}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      const filePath = resolve(join(DEV_DIR, normalize(pathname)));
      if (filePath !== DEV_DIR && !filePath.startsWith(DEV_DIR + sep)) {
        send(403, 'text/plain; charset=utf-8', 'forbidden');
        return;
      }

      const body = await readFile(filePath);
      send(200, MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream', body);
    } catch {
      send(404, 'text/plain; charset=utf-8', 'not found');
    }
  });
}

async function listen(server, port) {
  for (let candidate = port; candidate < port + 10; candidate++) {
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          rejectPromise(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolvePromise();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, HOST);
      });
      return candidate;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`no free port in ${port}..${port + 9}`);
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
  const firefox = resolveFirefox(options.firefox);
  if (!firefox) {
    problems.push(
      'no Firefox executable found — set FIREFOX_BIN, pass --firefox=<path>, or let web-ext search for it.',
    );
  }

  const server = createStaticServer();
  const port = await listen(server, Number(options.port) || BASE_PORT);
  const pageUrl = `http://${HOST}:${port}/`;

  if (options.check) {
    let page = 'unreachable';
    try {
      const response = await fetch(pageUrl);
      page = `${response.status} ${response.headers.get('content-type')} (${(await response.text()).length} bytes)`;
    } catch (error) {
      problems.push(`the test page could not be fetched: ${error.message}`);
    }
    server.close();

    console.log('SafeFileDrag manual-test launcher — check');
    console.log(`  page        : ${pageUrl} -> ${page}`);
    console.log(`  add-on      : ${DIST_DIR}`);
    console.log(`  firefox     : ${firefox ?? '(not found; web-ext will search)'}`);
    console.log(`  web-ext CLI : ${webExtBin ?? '(not found)'}`);
    console.log(`  command     : node ${webExtBin} run --source-dir ${DIST_DIR} --start-url ${pageUrl}${firefox ? ` --firefox ${firefox}` : ''} --no-input`);
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

  const args = [
    webExtBin,
    'run',
    '--source-dir',
    DIST_DIR,
    '--start-url',
    pageUrl,
    '--firefox',
    firefox,
    '--no-input',
    ...options.passthrough,
  ];

  const child = spawn(process.execPath, args, { stdio: 'inherit' });

  const stop = () => {
    if (!child.killed) child.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  child.on('exit', (code, signal) => {
    server.close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}

await main();
