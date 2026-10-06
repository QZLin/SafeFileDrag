/**
 * Timing and propagation: the cases where "did the page consume this event?" is hard
 * to answer, plus the situations the extension knowingly cannot win.
 *
 * The guard's whole design exists because `defaultPrevented` is only final at the end
 * of propagation, so these are the tests most worth having: they pin down where the
 * verdict is taken, and what happens when the page stops propagation mid-flight. The
 * "KNOWN HOLE" tests document accepted holes rather than desired behaviour, and say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPage } from './support/harness.js';
import { dataTransferOf, fileDragPayload, fileNames } from './support/dom.js';

test('a page that cancels and stops propagation is decided at the target', () => {
  const page = createPage();
  const target = page.el('div', { id: 'consumed' });
  page.on(target, 'drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const drop = page.drop(target);

  assert.deepEqual(drop.actions, ['allow:page-consumed']);
  assert.equal(drop.decisions[0]?.node, '<div#consumed>');
  assert.equal(drop.preventedByPage, true);
});

test('a page that only stops propagation is still overruled', () => {
  const page = createPage();
  const target = page.el('div', { id: 'stops-only' });
  page.on(target, 'drop', (event) => event.stopPropagation());

  const drop = page.drop(target);

  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.decisions[0]?.node, '<div#stops-only>');
  assert.equal(drop.preventedByGuard, true);
});

test('a capture listener that stops propagation on the target is handled too', () => {
  const page = createPage();
  const target = page.el('div', { id: 'capture-stop' });
  page.on(target, 'drop', (event) => event.stopPropagation(), { capture: true });

  const drop = page.drop(target);

  // Propagation stopped before the target's bubble listeners, so the target is the last
  // node visited and the verdict is taken there.
  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.decisions[0]?.node, '<div#capture-stop>');
  assert.equal(drop.preventedByGuard, true);
});

test('cancelling with stopImmediatePropagation keeps the tab safe', () => {
  const page = createPage();
  const target = page.el('div', { id: 'immediate' });
  page.on(target, 'drop', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  const drop = page.drop(target);

  // The guard never gets to speak — the page's listener skipped it — but the page did
  // the guard's job itself, so there is nothing left to do.
  assert.deepEqual(drop.decisions, []);
  assert.equal(drop.preventedByPage, true);
  assert.equal(drop.event.defaultPrevented, true);
});

test('KNOWN HOLE: stopImmediatePropagation without cancelling defeats the guard', () => {
  const page = createPage();
  const target = page.el('div', { id: 'hostile' });
  page.on(target, 'drop', (event) => event.stopImmediatePropagation());

  const drop = page.drop(target);

  // The guard's observers on that node never run, and stopping propagation means no
  // later node is visited either, so no verdict can be taken and the drop's default
  // action stands. Documented in README under "Known limitations"; the alternative
  // (cancelling every drop up front) is exactly what the extension must not do.
  assert.deepEqual(drop.decisions, []);
  assert.equal(drop.prevented, false);
});

test('KNOWN HOLE: stopPropagation from a window capture listener defeats the guard', () => {
  const page = createPage();
  const target = page.el('div');
  page.on(page.window, 'drop', (event) => event.stopPropagation(), { capture: true });

  const drop = page.drop(target);

  assert.deepEqual(drop.decisions, []);
  assert.equal(drop.prevented, false);
});

test('a page that cancels from a window capture listener is safe, guard silent', () => {
  const page = createPage();
  const target = page.el('div');
  page.on(
    page.window,
    'drop',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );

  const drop = page.drop(target);

  assert.deepEqual(drop.decisions, []);
  assert.equal(drop.preventedByPage, true);
});

test('a handler attached during the drag (framework delegation) is honoured', () => {
  const page = createPage();
  const target = page.el('div', { id: 'react-ish' });
  page.on(target, 'dragenter', () => {
    // Registered before the drop dispatch starts, so it runs before the guard's
    // observers on that node and its verdict is the one that counts.
    page.on(target, 'drop', (event) => event.preventDefault());
  });

  const { drop } = page.sequence(target);

  assert.deepEqual(drop.actions, ['allow:page-consumed']);
  assert.equal(drop.preventedByPage, true);
});

test('a handler attached mid-drop is late for the verdict but still gets the file', () => {
  const page = createPage();
  const target = page.el('div', { id: 'racing' });
  let pageSawFiles: string[] = [];
  page.on(
    page.window,
    'drop',
    () => {
      // Attached while the event is already in flight, on the last node of the path:
      // the guard's own observer there was registered earlier, so it has already spoken.
      page.on(page.window, 'drop', (inner) => {
        inner.preventDefault();
        pageSawFiles = fileNames(dataTransferOf(inner));
      });
    },
    { capture: true },
  );

  const drop = page.drop(target);

  // The verdict is conservative (`block`, because nothing had consumed the drop when it
  // was taken), but the page's late handler still receives the event and its files, and
  // the tab is safe either way.
  assert.deepEqual(drop.actions, ['block']);
  assert.equal(drop.prevented, true);
  assert.deepEqual(pageSawFiles, ['report.pdf']);
});

test('a non-bubbling drop is decided at the target itself', () => {
  const page = createPage();
  const target = page.el('div', { id: 'quiet' });

  const result = page.dispatch('drop', target, fileDragPayload(), { bubbles: false });

  assert.deepEqual(result.actions, ['block']);
  assert.equal(result.decisions[0]?.node, '<div#quiet>');
  assert.equal(result.preventedByGuard, true);
});

test('a non-cancelable drop can be reported but not stopped', () => {
  const page = createPage();
  const target = page.el('div');

  const result = page.dispatch('drop', target, fileDragPayload(), { cancelable: false });

  // Honest limitation: `preventDefault()` is a no-op on a non-cancelable event, so the
  // guard can only record the attempt. Firefox does not ship non-cancelable drag
  // events, which is why this is acceptable.
  assert.deepEqual(result.actions, ['block']);
  assert.equal(result.prevented, false);
});

test('repeated drops keep working and leave no observers behind', () => {
  const page = createPage();
  const target = page.el('div', { id: 'repeat' });

  for (let round = 0; round < 3; round++) {
    const drop = page.drop(target);
    assert.equal(drop.preventedByGuard, true);
    // Every observer that ran removed itself (they are one-shot), and the one on the
    // target was reached too.
    assert.equal(page.count(page.body, 'drop'), 0);
    assert.equal(page.count(target, 'drop'), 0);
    // What remains is the persistent trigger listener plus the window capture observer
    // this very event attached after its own capture pass had been snapshotted.
    assert.equal(page.count(page.window, 'drop'), 2);
  }

  page.enter(target);
  assert.equal(page.count(page.window, 'drop'), 1, 'the next drag collects the leftover');
  assert.equal(page.decisions.length, 4);
});

test('observers abandoned by a stopped event are cleaned up by the next drag', () => {
  const page = createPage();
  const target = page.el('div', { id: 'stale' });
  const stopper = page.on(page.window, 'drop', (event) => event.stopPropagation(), {
    capture: true,
  });

  const stopped = page.drop(target);
  assert.equal(stopped.prevented, false);
  // The observers attached along the path were never invoked, so they are still there.
  assert.equal(page.count(page.body, 'drop'), 2);

  page.off(page.window, 'drop', stopper, { capture: true });
  const enter = page.enter(target);

  assert.equal(page.count(page.body, 'drop'), 0);
  assert.deepEqual(enter.actions, ['block']);
});
