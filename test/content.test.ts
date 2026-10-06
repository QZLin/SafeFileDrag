/**
 * The real content script, evaluated against jsdom.
 *
 * `test/policy.test.ts` drives `installGuard()` with a harness-supplied native-target
 * policy; this file runs `src/content.ts` itself, so the Firefox-specific parts — file
 * input detection (including disabled and shadow-nested controls), `composedPath()`
 * wiring, adapter identity and the once-per-window install marker — are covered by the
 * same suite.
 *
 * The bundle is loaded with a runtime `import()` because the globals have to be swapped
 * *before* the script is evaluated; a static import would be hoisted above
 * `installJsdomGlobals()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installJsdomGlobals } from './support/globals.js';
import { dragEvent, fileDragPayload, filesTypeOnlyPayload, textDragPayload } from './support/dom.js';
import type { DataTransferLike } from '../src/guard.js';

const dom = installJsdomGlobals();
await import(new URL('./content.entry.mjs', import.meta.url).href);

const INSTALLED = Symbol.for('safe-file-drag/installed/v1');

function el(
  tagName: string,
  init: { id?: string; type?: string; disabled?: boolean } = {},
  parent: ParentNode = dom.body,
): HTMLElement {
  const element = dom.document.createElement(tagName);
  if (init.id !== undefined) element.id = init.id;
  if (init.type !== undefined) element.setAttribute('type', init.type);
  if (init.disabled !== undefined) element.toggleAttribute('disabled', init.disabled);
  parent.append(element);
  return element;
}

function drop(target: EventTarget, dataTransfer: DataTransferLike = fileDragPayload()): Event {
  const event = dragEvent(dom, 'drop', dataTransfer);
  target.dispatchEvent(event);
  return event;
}

test('the content script installs one guard per window and marks it', () => {
  assert.equal(dom.counts.count(dom.window, 'dragenter'), 1);
  assert.equal(dom.counts.count(dom.window, 'dragover'), 1);
  assert.equal(dom.counts.count(dom.window, 'drop'), 1);
  assert.equal(
    (dom.window as unknown as Record<symbol, unknown>)[INSTALLED],
    true,
    'window must carry the install marker',
  );
});

test('a file dropped on a plain element is cancelled', () => {
  assert.equal(drop(el('div', { id: 'plain' })).defaultPrevented, true);
});

test('a file dropped on <input type="file"> is not cancelled', () => {
  assert.equal(drop(el('input', { id: 'upload', type: 'file' })).defaultPrevented, false);
});

test('the file input type is matched case-insensitively', () => {
  assert.equal(drop(el('input', { id: 'shouty', type: 'FILE' })).defaultPrevented, false);
});

test('a disabled file input is not an upload target', () => {
  const disabled = el('input', { id: 'disabled', type: 'file', disabled: true });
  assert.equal(drop(disabled).defaultPrevented, true);
});

test('text inputs and textareas are not upload targets', () => {
  assert.equal(drop(el('input', { id: 'text', type: 'text' })).defaultPrevented, true);
  assert.equal(drop(el('textarea', { id: 'notes' })).defaultPrevented, true);
});

test('a file input inside an open shadow root is not cancelled', () => {
  const host = el('div', { id: 'uploader' });
  const root = host.attachShadow({ mode: 'open' });
  const input = el('input', { id: 'inner', type: 'file' }, root);

  assert.equal(drop(input).defaultPrevented, false);
});

test('a file input inside a closed shadow root is cancelled (fail-safe)', () => {
  const host = el('div', { id: 'closed' });
  const root = host.attachShadow({ mode: 'closed' });
  const input = el('input', { id: 'hidden', type: 'file' }, root);

  assert.equal(drop(input).defaultPrevented, true);
});

test('dragover is judged too, so a drop can still be produced', () => {
  const target = el('div', { id: 'over-target' });
  const over = dragEvent(dom, 'dragover', filesTypeOnlyPayload());
  target.dispatchEvent(over);

  assert.equal(over.defaultPrevented, true);
});

test('text, link and image drags are left alone', () => {
  const target = el('div', { id: 'text-target' });
  const textDrop = drop(target, textDragPayload());

  assert.equal(textDrop.defaultPrevented, false);
  assert.equal(dom.counts.count(dom.window, 'drop'), 1);
});

test('a second injection into the same window is a no-op', async () => {
  await import(new URL('./content.reinjection.mjs', import.meta.url).href);

  assert.equal(dom.counts.count(dom.window, 'drop'), 1, 'the marker must prevent a re-install');
  assert.equal(dom.counts.count(dom.window, 'dragover'), 1);
  assert.equal(drop(el('div', { id: 'after-reinjection' })).defaultPrevented, true);
});
