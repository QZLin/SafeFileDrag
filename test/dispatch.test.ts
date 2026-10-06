/**
 * The DOM behaviour the guard is built on.
 *
 * The guard is a bet about *when* listeners run: it registers a `window` capture
 * listener at `document_start`, and from there attaches one-shot observers to every
 * node of the propagation path, expecting them to run after the page's own listeners
 * on a node but still early enough to cancel the event. That bet only pays off if the
 * DOM underneath behaves as the specification says.
 *
 * These tests pin each of those behaviours against the DOM the suite runs on (jsdom).
 * They are not tests of jsdom for its own sake: if a future DOM implementation — or a
 * future refactor of the harness — ever stopped providing one of them, the guard would
 * look fine while silently doing nothing, and this file is what fails instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDom, describeNode, dragEvent } from './support/dom.js';

test('dispatch runs capture from window down to the target, then bubble back out', () => {
  const dom = createDom();
  const { window, document, body } = dom;
  const target = document.createElement('div');
  body.append(target);

  const order: string[] = [];
  const nodes: Array<[EventTarget, string]> = [
    [window, 'window'],
    [document, 'document'],
    [body, 'body'],
    [target, 'target'],
  ];
  for (const [node, name] of nodes) {
    node.addEventListener('drop', () => order.push(`${name}:capture`), { capture: true });
    node.addEventListener('drop', () => order.push(`${name}:bubble`));
  }

  target.dispatchEvent(dragEvent(dom, 'drop'));

  assert.deepEqual(order, [
    'window:capture',
    'document:capture',
    'body:capture',
    'target:capture',
    'target:bubble',
    'body:bubble',
    'document:bubble',
    'window:bubble',
  ]);
});

test('a listener added during dispatch runs when its node is invoked later', () => {
  const dom = createDom();
  const { window, body } = dom;
  const target = body.appendChild(dom.document.createElement('div'));

  const order: string[] = [];
  window.addEventListener(
    'drop',
    () => {
      body.addEventListener('drop', () => order.push('body:bubble (added during capture)'));
    },
    { capture: true },
  );

  target.dispatchEvent(dragEvent(dom, 'drop'));

  // This is the guard's mechanism: observers attached from `window` capture still get
  // their turn on every node that has not been visited yet.
  assert.deepEqual(order, ['body:bubble (added during capture)']);
});

test('a listener added to the node currently being invoked waits for the next event', () => {
  const dom = createDom();
  const { window, body } = dom;
  const target = body.appendChild(dom.document.createElement('div'));

  const order: string[] = [];
  window.addEventListener(
    'drop',
    () => {
      window.addEventListener('drop', () => order.push('window:capture (added late)'), {
        capture: true,
      });
    },
    { capture: true },
  );

  target.dispatchEvent(dragEvent(dom, 'drop'));

  // The window's capture listeners had already been snapshotted, and the bubble pass
  // does not run capture-flagged listeners, so the late one stays silent.
  assert.deepEqual(order, []);
});

test('once removes the listener before its callback runs', () => {
  const dom = createDom();
  const body = dom.body;
  const target = body.appendChild(dom.document.createElement('div'));

  let calls = 0;
  let countInsideCallback = -1;
  target.addEventListener(
    'drop',
    () => {
      calls += 1;
      countInsideCallback = dom.counts.count(target, 'drop');
    },
    { once: true },
  );

  target.dispatchEvent(dragEvent(dom, 'drop'));
  target.dispatchEvent(dragEvent(dom, 'drop'));

  assert.equal(calls, 1);
  assert.equal(countInsideCallback, 0);
});

test('stopPropagation keeps the remaining listeners of the same node and stops later ones', () => {
  const dom = createDom();
  const { window, body } = dom;
  const target = body.appendChild(dom.document.createElement('div'));

  const order: string[] = [];
  let cancelBubbleSeenBySecondListener: boolean | undefined;
  target.addEventListener('drop', (event) => {
    order.push('target:first');
    event.stopPropagation();
  });
  target.addEventListener('drop', (event) => {
    order.push('target:second');
    cancelBubbleSeenBySecondListener = event.cancelBubble;
  });
  body.addEventListener('drop', () => order.push('body:bubble'));
  window.addEventListener('drop', () => order.push('window:bubble'));

  target.dispatchEvent(dragEvent(dom, 'drop'));

  assert.deepEqual(order, ['target:first', 'target:second']);
  // Legacy `cancelBubble` is how the guard notices that propagation stopped on the node
  // it is currently observing.
  assert.equal(cancelBubbleSeenBySecondListener, true);
});

test('stopImmediatePropagation skips the rest of the node and all later nodes', () => {
  const dom = createDom();
  const { window, body } = dom;
  const target = body.appendChild(dom.document.createElement('div'));

  const order: string[] = [];
  target.addEventListener('drop', (event) => {
    order.push('target:first');
    event.stopImmediatePropagation();
  });
  target.addEventListener('drop', () => order.push('target:second'));
  window.addEventListener('drop', () => order.push('window:bubble'));

  target.dispatchEvent(dragEvent(dom, 'drop'));

  assert.deepEqual(order, ['target:first']);
});

test('preventDefault needs a cancelable event and a non-passive listener', () => {
  const dom = createDom();
  const { document, body } = dom;

  const active = body.appendChild(document.createElement('div'));
  active.addEventListener('drop', (event) => event.preventDefault());
  const cancelled = dragEvent(dom, 'drop');
  assert.equal(active.dispatchEvent(cancelled), false);
  assert.equal(cancelled.defaultPrevented, true);

  const notCancelable = body.appendChild(document.createElement('div'));
  notCancelable.addEventListener('drop', (event) => event.preventDefault());
  const fixed = dragEvent(dom, 'drop', null, { cancelable: false });
  assert.equal(notCancelable.dispatchEvent(fixed), true);
  assert.equal(fixed.defaultPrevented, false);

  const passiveTarget = body.appendChild(document.createElement('div'));
  passiveTarget.addEventListener('drop', (event) => event.preventDefault(), { passive: true });
  const passive = dragEvent(dom, 'drop');
  assert.equal(passiveTarget.dispatchEvent(passive), true);
  assert.equal(passive.defaultPrevented, false);
});

test('a listener that throws does not abort the remaining listeners', () => {
  const dom = createDom();
  const target = dom.body.appendChild(dom.document.createElement('div'));

  const order: string[] = [];
  target.addEventListener('drop', () => {
    throw new Error('page handler exploded');
  });
  target.addEventListener('drop', () => order.push('second listener still ran'));

  target.dispatchEvent(dragEvent(dom, 'drop'));

  assert.deepEqual(order, ['second listener still ran']);
});

test('composedPath runs from the target up to window', () => {
  const dom = createDom();
  const target = dom.body.appendChild(dom.document.createElement('div'));

  let path: string[] = [];
  target.addEventListener('drop', (event) => {
    path = event.composedPath().map((node) => describeNode(dom, node));
  });

  target.dispatchEvent(dragEvent(dom, 'drop'));

  assert.deepEqual(path, ['<div>', '<body>', '<html>', 'document', 'window']);
});

test('an open shadow root exposes internals in composedPath but retargets event.target', () => {
  const dom = createDom();
  const host = dom.body.appendChild(dom.document.createElement('div'));
  host.id = 'host';
  const root = host.attachShadow({ mode: 'open' });
  const inner = root.appendChild(dom.document.createElement('input'));
  inner.id = 'inner';
  inner.setAttribute('type', 'file');

  let outsideTarget = '';
  let outsidePath: string[] = [];
  let insideTarget = '';
  dom.window.addEventListener('drop', (event) => {
    outsideTarget = describeNode(dom, event.target);
    outsidePath = event.composedPath().map((node) => describeNode(dom, node));
  });
  inner.addEventListener('drop', (event) => {
    insideTarget = describeNode(dom, event.target);
  });

  inner.dispatchEvent(dragEvent(dom, 'drop'));

  // Retargeting hides the real target from `window`; the composed path does not. The
  // guard reads both, which is what keeps uploads inside web components working.
  assert.equal(outsideTarget, '<div#host>');
  assert.deepEqual(outsidePath, [
    '<input#inner[type=file]>',
    '<div#host>/shadow(open)',
    '<div#host>',
    '<body>',
    '<html>',
    'document',
    'window',
  ]);
  assert.equal(insideTarget, '<input#inner[type=file]>');
});

test('a closed shadow root hides its internals from listeners outside it', () => {
  const dom = createDom();
  const host = dom.body.appendChild(dom.document.createElement('div'));
  host.id = 'host';
  const root = host.attachShadow({ mode: 'closed' });
  const inner = root.appendChild(dom.document.createElement('input'));
  inner.id = 'inner';

  let outsideTarget = '';
  let outsidePath: string[] = [];
  let insidePath: string[] = [];
  dom.window.addEventListener('drop', (event) => {
    outsideTarget = describeNode(dom, event.target);
    outsidePath = event.composedPath().map((node) => describeNode(dom, node));
  });
  inner.addEventListener('drop', (event) => {
    insidePath = event.composedPath().map((node) => describeNode(dom, node));
  });

  inner.dispatchEvent(dragEvent(dom, 'drop'));

  assert.equal(outsideTarget, '<div#host>');
  assert.deepEqual(outsidePath, ['<div#host>', '<body>', '<html>', 'document', 'window']);
  assert.deepEqual(insidePath, [
    '<input#inner>',
    '<div#host>/shadow(closed)',
    '<div#host>',
    '<body>',
    '<html>',
    'document',
    'window',
  ]);
});

test('a non-bubbling event is captured down to the target and never bubbles', () => {
  const dom = createDom();
  const { window, body } = dom;
  const target = body.appendChild(dom.document.createElement('div'));

  const order: string[] = [];
  window.addEventListener('drop', () => order.push('window:capture'), { capture: true });
  window.addEventListener('drop', () => order.push('window:bubble'));
  body.addEventListener('drop', () => order.push('body:capture'), { capture: true });
  body.addEventListener('drop', () => order.push('body:bubble'));
  target.addEventListener('drop', () => order.push('target'));

  target.dispatchEvent(dragEvent(dom, 'drop', null, { bubbles: false }));

  assert.deepEqual(order, ['window:capture', 'body:capture', 'target']);
});
