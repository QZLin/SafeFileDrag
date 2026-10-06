/**
 * Points the page's global DOM at jsdom, so the *real* content script
 * (`src/content.ts` — the file Firefox actually injects) can be evaluated in Node.
 *
 * `src/content.ts` reaches for `window`, `EventTarget.prototype` and
 * `Event.prototype.composedPath` at module scope, which is exactly what this replaces.
 * Node already defines `EventTarget`/`Event` globals (for streams and workers), so
 * overriding them is not cosmetic: it is how the content script is aimed at the test
 * DOM.
 *
 * Callers must install the globals *before* the content-script bundle is evaluated;
 * `test/content.test.ts` does that with a runtime `import()`.
 */
import { createDom, type Dom } from './dom.js';

export function installJsdomGlobals(): Dom {
  const dom = createDom();
  const globals = globalThis as unknown as Record<string, unknown>;

  globals['window'] = dom.window;
  globals['self'] = dom.window;
  globals['document'] = dom.document;
  globals['EventTarget'] = dom.window.EventTarget;
  globals['Event'] = dom.window.Event;
  // Named only in type positions today; defined anyway so a future `instanceof` works.
  globals['Node'] = dom.window.Node;
  globals['Element'] = dom.window.Element;
  globals['ShadowRoot'] = dom.window.ShadowRoot;
  globals['HTMLInputElement'] = dom.window.HTMLInputElement;

  return dom;
}
