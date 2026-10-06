/**
 * Shadow DOM: `<my-uploader><input type="file"></my-uploader>` is a common web component
 * shape, and it is the one case where "which element did the user drop on?" and "which
 * element does the event report as its target?" are different elements.
 *
 * A listener outside an open shadow root sees `event.target` retargeted to the host,
 * while `composedPath()` still names the real target. The guard has to prefer the real
 * target, or a file input inside a component would stop accepting uploads — which is
 * exactly the regression these tests exist for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPage } from './support/harness.js';

test('a file input inside an open shadow root still accepts the drop', () => {
  const page = createPage();
  const host = page.el('div', { id: 'uploader' });
  const root = host.attachShadow({ mode: 'open' });
  const input = page.el('input', { id: 'inner', type: 'file' }, root);

  const drop = page.drop(input);

  assert.deepEqual(drop.actions, ['allow:native-file-target']);
  assert.equal(drop.prevented, false);
});

test('nested open shadow roots are followed down to the real target', () => {
  const page = createPage();
  const outerHost = page.el('div', { id: 'outer' });
  const outerRoot = outerHost.attachShadow({ mode: 'open' });
  const innerHost = page.el('div', { id: 'inner-host' }, outerRoot);
  const innerRoot = innerHost.attachShadow({ mode: 'open' });
  const input = page.el('input', { id: 'deep', type: 'file' }, innerRoot);

  const drop = page.drop(input);

  assert.deepEqual(drop.actions, ['allow:native-file-target']);
  assert.equal(drop.prevented, false);
});

test('a plain element inside an open shadow root is still blocked', () => {
  const page = createPage();
  const host = page.el('div', { id: 'component' });
  const root = host.attachShadow({ mode: 'open' });
  const inner = page.el('div', { id: 'panel' }, root);

  const drop = page.drop(inner);

  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('a file input inside a closed shadow root is blocked (fail-safe)', () => {
  const page = createPage();
  const host = page.el('div', { id: 'closed-uploader' });
  const root = host.attachShadow({ mode: 'closed' });
  const input = page.el('input', { id: 'hidden', type: 'file' }, root);

  const drop = page.drop(input);

  // The guard cannot see inside a closed root, so it cannot know an upload control is
  // there. It cancels rather than gamble on the default action. Documented in README.
  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.preventedByGuard, true);
});

test('a page handler on the shadow host still wins over the guard', () => {
  const page = createPage();
  const host = page.el('div', { id: 'handler-host' });
  const root = host.attachShadow({ mode: 'open' });
  const inner = page.el('div', { id: 'panel' }, root);
  page.on(host, 'drop', (event) => event.preventDefault());

  const drop = page.drop(inner);

  assert.deepEqual(drop.actions, ['allow:page-consumed']);
  assert.equal(drop.preventedByPage, true);
});
