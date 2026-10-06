/**
 * The verdict matrix: what the guard does for each kind of drag against each kind of
 * target. Every case here is a promise the extension makes to the user, stated as a
 * plain scenario ("a file dropped on an empty area must not navigate the tab", "a file
 * dropped on an upload control must still arrive").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPage } from './support/harness.js';
import { dataTransferOf, fileDragPayload, fileNames, textDragPayload } from './support/dom.js';
import type { DataTransferLike } from '../src/guard.js';

const multiFilePayload: DataTransferLike = {
  items: [{ kind: 'file' }, { kind: 'file' }],
  files: [{ name: 'a.pdf' }, { name: 'b.pdf' }],
  types: ['Files'],
};

test('a file dropped on a page with no handlers is cancelled in every phase', () => {
  const page = createPage();
  const target = page.el('div', { id: 'plain' });

  const { enter, over, drop } = page.sequence(target);

  for (const result of [enter, over, drop]) {
    assert.deepEqual(result.actions, ['block']);
    assert.equal(result.preventedByGuard, true);
    assert.equal(result.decisions.length, 1);
  }
  assert.deepEqual(
    drop.decisions.map((decision) => [decision.phase, decision.node]),
    [['drop', 'window']],
  );
});

test('a file dropped on <input type="file"> is left to the browser', () => {
  const page = createPage();
  const input = page.el('input', { id: 'upload', type: 'file' });

  const { enter, over, drop } = page.sequence(input);

  for (const result of [enter, over, drop]) {
    assert.deepEqual(result.actions, ['allow:native-file-target']);
    assert.equal(result.prevented, false);
  }
  // Not cancelling the drop is what lets the control receive the file itself.
  assert.equal(drop.event.defaultPrevented, false);
});

test('a dropzone that handles dragover and drop still receives the file', () => {
  const page = createPage();
  const zone = page.el('div', { id: 'dropzone' });
  const received: string[] = [];
  page.on(zone, 'dragover', (event) => event.preventDefault());
  page.on(zone, 'drop', (event) => {
    event.preventDefault();
    received.push(...fileNames(dataTransferOf(event)));
  });

  const { enter, over, drop } = page.sequence(zone);

  // dragenter is a phase the page does not handle, so it is still cancelled: that is
  // what tells Firefox a drop is welcome here.
  assert.deepEqual(enter.actions, ['block']);
  assert.deepEqual(over.actions, ['allow:page-consumed']);
  assert.equal(over.preventedByPage, true);
  assert.equal(over.preventedByGuard, false);
  assert.deepEqual(drop.actions, ['allow:page-consumed']);
  assert.equal(drop.preventedByPage, true);
  assert.deepEqual(received, ['report.pdf']);
});

test('a dropzone that only listens for drop is enabled by the guard, not broken by it', () => {
  const page = createPage();
  const zone = page.el('div', { id: 'drop-only' });
  const received: string[] = [];
  page.on(zone, 'drop', (event) => {
    event.preventDefault();
    received.push(...fileNames(dataTransferOf(event)));
  });

  const { over, drop } = page.sequence(zone);

  // Without a cancelled dragover Firefox would never fire the drop this page waits
  // for, so the guard's cancellation is what makes the page work at all.
  assert.deepEqual(over.actions, ['block']);
  assert.equal(over.preventedByGuard, true);

  assert.deepEqual(drop.actions, ['allow:page-consumed']);
  assert.equal(drop.preventedByPage, true);
  assert.deepEqual(received, ['report.pdf']);
});

test('a page that cancels dragover but ignores drop is not navigated', () => {
  const page = createPage();
  const zone = page.el('div', { id: 'dragover-only' });
  page.on(zone, 'dragover', (event) => event.preventDefault());

  const { over, drop } = page.sequence(zone);

  assert.deepEqual(over.actions, ['allow:page-consumed']);
  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('a handler on an ancestor in the capture phase counts as consuming the drop', () => {
  const page = createPage();
  const target = page.el('div', { id: 'child' });
  page.on(page.body, 'drop', (event) => event.preventDefault(), { capture: true });

  const drop = page.drop(target);

  assert.deepEqual(drop.actions, ['allow:page-consumed']);
  assert.equal(drop.preventedByPage, true);
});

test('a multi-file drag is cancelled just like a single-file one', () => {
  const page = createPage();
  const target = page.el('div');

  const drop = page.drop(target, multiFilePayload);

  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('the document body itself is covered', () => {
  const page = createPage();

  const drop = page.drop(page.body);

  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('a disabled file input is not treated as an upload target', () => {
  const page = createPage();
  const input = page.el('input', { id: 'disabled', type: 'file', disabled: true });

  const drop = page.drop(input);

  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('a text target is blocked for file drags (deliberately conservative)', () => {
  const page = createPage();
  const textarea = page.el('textarea', { id: 'notes' });

  const drop = page.drop(textarea);

  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('a text or link drag is never touched', () => {
  const page = createPage();
  const target = page.el('div', { id: 'plain' });
  const seen: string[] = [];
  page.on(target, 'drop', (event) => seen.push(event.type));

  const textDrop = page.drop(target, textDragPayload());

  assert.deepEqual(textDrop.decisions, []);
  assert.equal(textDrop.prevented, false);
  assert.deepEqual(seen, ['drop']);
  // Nothing was instrumented for this event: only the persistent trigger listener on
  // `window` remains.
  assert.equal(page.count(page.window, 'drop'), 1);
  assert.equal(page.count(page.body, 'drop'), 0);
});

test('the guard decides once per event and never rewrites the payload', () => {
  const page = createPage();
  const target = page.el('div');
  const payload = fileDragPayload();

  const drop = page.drop(target, payload);

  assert.equal(drop.decisions.length, 1);
  assert.equal(dataTransferOf(drop.event), payload);
  assert.deepEqual(fileNames(dataTransferOf(drop.event)), ['report.pdf']);
});
