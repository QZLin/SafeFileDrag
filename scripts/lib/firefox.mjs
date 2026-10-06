/**
 * Finding Firefox and the local `web-ext` CLI, and running (or tearing down) Firefox
 * through `web-ext run`.
 *
 * Shared by `scripts/dev.mjs` (manual playground) and `scripts/test-gecko.mjs`
 * (automated check against a real Gecko).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where Firefox usually lives on Windows; `FIREFOX_BIN` overrides everything. */
const FIREFOX_CANDIDATES = [
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Mozilla Firefox', 'firefox.exe'),
  'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
].filter(Boolean);

/**
 * @param {string | null} [explicit] path from `--firefox=` on the command line
 * @returns {string | null} an existing executable, or null to let web-ext search
 */
export function resolveFirefoxPath(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.FIREFOX_BIN) {
    return existsSync(process.env.FIREFOX_BIN) ? process.env.FIREFOX_BIN : null;
  }
  return FIREFOX_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** Resolves the local `web-ext` CLI entry point (its exports map hides the bin). */
export function resolveWebExtBin() {
  const entry = fileURLToPath(import.meta.resolve('web-ext')); // .../web-ext/index.js
  const bin = join(dirname(entry), 'bin', 'web-ext.js');
  return existsSync(bin) ? bin : null;
}

/** The `web-ext run` argv (minus the Node executable) for one launch. */
export function webExtRunArgs({ webExtBin, sourceDir, startUrl, firefox, extra = [] }) {
  return [
    webExtBin,
    'run',
    '--source-dir',
    sourceDir,
    '--start-url',
    startUrl,
    ...(firefox ? ['--firefox', firefox] : []),
    '--no-input',
    ...extra,
  ];
}

/** Spawns `web-ext run` with inherited stdio, so its progress is visible. */
export function spawnWebExtRun(options) {
  return spawn(process.execPath, webExtRunArgs(options), { stdio: 'inherit' });
}

/**
 * Shuts down `web-ext run` *and* the Firefox it started.
 *
 * On Windows `child.kill()` terminates only the Node process and would leave the
 * browser behind, so the whole process tree is killed instead. `/T` limits the damage to
 * this tree: a Firefox the user has open themselves is a separate process and is not
 * touched.
 */
export function killWebExtTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}
