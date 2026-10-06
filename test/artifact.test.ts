/**
 * The shipped artifact: `dist/content.js` and `dist/manifest.json` as built by
 * `scripts/build.mjs`, which is what actually gets loaded into Firefox.
 *
 * These tests are skipped when `dist/` has not been built (it is generated output and is
 * not committed); `pnpm run check` builds before it tests, so the full gate always
 * exercises the artifact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { installJsdomGlobals } from './support/globals.js';
import { dragEvent, fileDragPayload, type Dom } from './support/dom.js';

const contentUrl = new URL('../dist/content.js', import.meta.url);
const builtManifestUrl = new URL('../dist/manifest.json', import.meta.url);
const sourceManifestUrl = new URL('../manifest.json', import.meta.url);

const skip = existsSync(contentUrl)
  ? false
  : 'dist/ is not built — run `pnpm run build` (or `pnpm run check`) first';

/** Evaluates the built IIFE with the jsdom DOM as its globals. */
function evaluateBundle(dom: Dom): void {
  const code = readFileSync(contentUrl, 'utf8');
  const factory = new Function('window', 'document', 'EventTarget', 'Event', code);
  factory(dom.window, dom.document, dom.window.EventTarget, dom.window.Event);
}

test('the built bundle blocks a file drop on a plain element', { skip }, () => {
  const dom = installJsdomGlobals();
  evaluateBundle(dom);
  const target = dom.document.createElement('div');
  dom.body.append(target);

  const event = dragEvent(dom, 'drop', fileDragPayload());
  target.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
});

test('the built bundle leaves an upload control alone', { skip }, () => {
  const dom = installJsdomGlobals();
  evaluateBundle(dom);
  const input = dom.document.createElement('input');
  input.setAttribute('type', 'file');
  dom.body.append(input);

  const event = dragEvent(dom, 'drop', fileDragPayload());
  input.dispatchEvent(event);

  assert.equal(event.defaultPrevented, false);
});

test('the built bundle installs once per window', { skip }, () => {
  const dom = installJsdomGlobals();
  evaluateBundle(dom);
  evaluateBundle(dom);

  assert.equal(dom.counts.count(dom.window, 'drop'), 1);
  assert.equal(dom.counts.count(dom.window, 'dragover'), 1);
  assert.equal(dom.counts.count(dom.window, 'dragenter'), 1);
});

test('the built manifest is the source manifest, unchanged', { skip }, () => {
  const built = JSON.parse(readFileSync(builtManifestUrl, 'utf8'));
  const source = JSON.parse(readFileSync(sourceManifestUrl, 'utf8'));

  assert.deepEqual(built, source);
});
