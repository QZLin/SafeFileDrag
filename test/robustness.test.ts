/**
 * Robustness: what the guard does when the page, the DOM or its own environment
 * misbehaves. The rule the extension follows is "when in doubt, cancel the navigation",
 * so these tests mostly assert that a broken input still ends in a blocked file drop
 * rather than an exception or a silent pass-through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installGuard, type DataTransferLike, type EventTargetLike } from '../src/guard.js';
import { Page, createPage } from './support/harness.js';

test('a path that cannot be resolved still ends in a blocked drop', () => {
  const page = createPage({
    getPath: () => {
      throw new Error('composedPath exploded');
    },
  });
  const target = page.el('div');

  const drop = page.drop(target);

  assert.deepEqual(drop.actions, ['block']);
  assert.deepEqual(drop.decisions[0]?.node, 'window');
  assert.equal(drop.preventedByGuard, true);
});

test('a missing path falls back to the window', () => {
  const page = createPage({ getPath: () => null });
  const target = page.el('div');

  const drop = page.drop(target);

  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('nonsense and duplicated nodes in the path are tolerated', () => {
  const page = new Page();
  const target = page.el('div');
  page.install({
    getPath: () => [null, 42, {}, page.window, page.window] as unknown as EventTargetLike[],
  });

  const drop = page.drop(target);

  assert.deepEqual(drop.actions, ['block']);
  assert.deepEqual(drop.decisions[0]?.node, 'window');
  assert.equal(drop.decisions.length, 1, 'a duplicated window must not be decided twice');
});

test('a node that refuses listeners does not stop the verdict', () => {
  const page = new Page();
  const target = page.el('div');
  const hostile = {
    addEventListener() {
      throw new Error('this node refuses listeners');
    },
    removeEventListener() {},
  };
  page.install({ getPath: () => [target, hostile, page.window] as unknown as EventTargetLike[] });

  const drop = page.drop(target);

  assert.deepEqual(drop.actions, ['block']);
  assert.deepEqual(drop.decisions[0]?.node, 'window');
});

test('a very deep tree is still covered (the path length is capped)', () => {
  const page = createPage();
  let deepest = page.el('div');
  for (let depth = 0; depth < 299; depth++) deepest = page.el('div', {}, deepest);

  // Observed from the document capture pass, i.e. after the guard has attached its
  // observers but before the deeper nodes have been visited.
  const observed: Record<string, number> = {};
  page.on(
    page.document,
    'drop',
    () => {
      observed['deepest'] = page.count(deepest, 'drop');
      observed['body'] = page.count(page.body, 'drop');
    },
    { capture: true },
  );

  const drop = page.drop(deepest);

  assert.equal(drop.preventedByGuard, true);
  // The cap drops the *outer* nodes, never the target, and the window tail guarantees
  // that a verdict is still reached.
  assert.equal(observed['deepest'], 2);
  assert.equal(observed['body'], 0);
});

test('a native-target test that throws falls back to blocking', () => {
  const page = createPage({
    isNativeFileDropTarget: () => {
      throw new Error('cannot tell');
    },
  });
  const input = page.el('input', { id: 'upload', type: 'file' });

  const drop = page.drop(input);

  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('a diagnostics hook that throws cannot change the outcome', () => {
  const page = createPage({
    onDecision: () => {
      throw new Error('diagnostics exploded');
    },
  });
  const target = page.el('div');

  const drop = page.drop(target);

  assert.equal(drop.preventedByGuard, true);
});

test('an unreadable DataTransfer is treated as "not a file drag"', () => {
  const page = createPage();
  const target = page.el('div');
  const unreadable: Record<string, unknown> = {};
  for (const property of ['items', 'files', 'types']) {
    Object.defineProperty(unreadable, property, {
      get() {
        throw new Error(`DataTransfer.${property} is not readable`);
      },
    });
  }

  const drop = page.drop(target, unreadable as DataTransferLike);

  // Documented in README under "Known limitations": with no readable evidence the guard
  // cannot tell a file drag from a text drag and stays out of the way. A blanket
  // cancellation here would break ordinary text drops on every page.
  assert.deepEqual(drop.decisions, []);
  assert.equal(drop.prevented, false);
});

test('a window that refuses listeners does not make the script throw', () => {
  const hostile = {
    addEventListener() {
      throw new Error('no listeners for you');
    },
    removeEventListener() {},
  };

  assert.doesNotThrow(() => {
    installGuard({
      window: hostile as unknown as EventTargetLike,
      getPath: () => null,
      isNativeFileDropTarget: () => false,
    });
  });
});

test("the guard itself is not idempotent; double installation is the marker's job", () => {
  const page = new Page();
  page.install();
  page.install();
  const target = page.el('div');

  const drop = page.drop(target);

  // Two guards both reach a verdict and both cancel: harmless (`preventDefault` is
  // idempotent) but wasteful. `src/content.ts` installs at most once per window, which
  // `test/content.test.ts` covers.
  assert.equal(drop.prevented, true);
  assert.equal(drop.decisions.length, 2);
});

test('a fifty-drop run leaks nothing and stays effective', () => {
  const page = createPage();
  const target = page.el('div', { id: 'soak' });

  for (let round = 0; round < 50; round++) {
    const drop = page.drop(target);
    assert.equal(drop.preventedByGuard, true, `round ${round} was not blocked`);
    assert.equal(page.count(page.body, 'drop'), 0, `round ${round} left an observer on <body>`);
    assert.equal(page.count(target, 'drop'), 0, `round ${round} left an observer on the target`);
    assert.equal(page.count(page.window, 'drop'), 2, `round ${round} changed the window count`);
  }

  assert.equal(page.decisions.length, 50);

  // The one observer that cannot have run (the window capture observer of the last
  // event) is collected by the next drag event.
  page.enter(target);
  assert.equal(page.count(page.window, 'drop'), 1);
});

test('a drop event with no dataTransfer at all is not treated as a file drag', () => {
  const page = createPage();
  const target = page.el('div', { id: 'synthetic' });

  // A synthetic event (some UI libraries dispatch their own) carries no drag payload, so
  // there is no evidence of a local file and the guard stays out of it entirely.
  const event = new page.dom.window.Event('drop', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(page.decisions, []);
  assert.equal(page.count(page.body, 'drop'), 0);
  assert.equal(page.count(page.window, 'drop'), 1, 'only the persistent trigger listener');
});
