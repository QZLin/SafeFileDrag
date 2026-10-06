/**
 * jsdom-backed test DOM.
 *
 * The suite runs against a real DOM implementation rather than a hand-written
 * simulation, because the guard's entire mechanism is a bet about *when* listeners
 * run: it attaches observers from a `window` capture listener and expects them to run
 * after the page's own listeners on the same node, and to be reachable at all for
 * nodes that have not been visited yet. A simulation written for this repository could
 * easily be made to agree with the guard by accident, so the semantics are borrowed
 * from jsdom (see `test/dispatch.test.ts`, which pins the specific behaviours the guard
 * depends on) and only the drag-specific payload is provided here: jsdom has no
 * `DataTransfer`, so a plain `Event` carries a `dataTransfer` property instead.
 *
 * jsdom is not Gecko. What it cannot settle — Firefox's own default action for a file
 * drop, and the real `DataTransfer`/`dragenter` behaviour — is covered by the manual
 * playground (`pnpm start`, see README).
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import type { DataTransferLike } from '../../src/guard.js';

export type AnyListener = (event: Event) => void;

/** Slot key: the DOM treats capture and bubble registrations as separate lists. */
export function listenerKey(type: string, capture: boolean): string {
  return `${capture ? 'capture' : 'bubble'}:${type}`;
}

function captureOf(options?: boolean | EventListenerOptions): boolean {
  return typeof options === 'boolean' ? options : options?.capture === true;
}

/**
 * Listener bookkeeping. jsdom does not expose `listenerCount`, and "does the guard
 * leave observers behind?" is one of the things this suite has to be able to assert,
 * so registrations are wrapped and counted here.
 *
 * The wrapper reproduces the two details that matter for counting: an identical
 * registration is ignored, and a `once` listener is removed *before* it runs.
 */
export class ListenerRegistry {
  private readonly live = new WeakMap<EventTarget, Map<string, Set<AnyListener>>>();
  private readonly wrappers = new WeakMap<EventTarget, Map<string, Map<AnyListener, AnyListener>>>();

  instrument(window: JsdomWindow): void {
    const prototype = window.EventTarget.prototype;
    const nativeAdd = prototype.addEventListener;
    const nativeRemove = prototype.removeEventListener;
    const registry = this;

    prototype.addEventListener = function addEventListener(
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (typeof listener !== 'function') {
        nativeAdd.call(this, type, listener, options);
        return;
      }
      const target = this;
      const key = listenerKey(type, captureOf(options as EventListenerOptions | undefined));
      const byListener = registry.wrappersFor(target, key);
      // The DOM ignores a second registration of the same (type, listener, capture).
      if (byListener.has(listener)) return;

      const once = typeof options === 'object' && options !== null && options.once === true;
      const passive = typeof options === 'object' && options !== null && options.passive === true;

      let wrapper: AnyListener = listener as AnyListener;
      if (once) {
        wrapper = function onceWrapper(this: EventTarget, event: Event) {
          registry.forget(target, key, listener as AnyListener);
          nativeRemove.call(target, type, wrapper, { capture: captureOf(options as EventListenerOptions | undefined) });
          Reflect.apply(listener as AnyListener, this, [event]);
        };
      }

      registry.liveFor(target, key).add(wrapper);
      byListener.set(listener as AnyListener, wrapper);
      nativeAdd.call(this, type, wrapper, {
        capture: captureOf(options as EventListenerOptions | undefined),
        passive,
      });
    };

    prototype.removeEventListener = function removeEventListener(
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (typeof listener !== 'function') {
        nativeRemove.call(this, type, listener, options);
        return;
      }
      const target = this;
      const capture = captureOf(options);
      const key = listenerKey(type, capture);
      const wrapper = registry.wrappersFor(target, key).get(listener as AnyListener);
      registry.forget(target, key, listener as AnyListener);
      nativeRemove.call(this, type, wrapper ?? listener, { capture });
    };
  }

  /** Live listeners on `target`, for one type or for all of them. */
  count(target: EventTarget, type?: string): number {
    const slots = this.live.get(target);
    if (!slots) return 0;
    let total = 0;
    for (const [key, listeners] of slots) {
      if (type !== undefined && key !== listenerKey(type, true) && key !== listenerKey(type, false)) {
        continue;
      }
      total += listeners.size;
    }
    return total;
  }

  private liveFor(target: EventTarget, key: string): Set<AnyListener> {
    let slots = this.live.get(target);
    if (!slots) {
      slots = new Map();
      this.live.set(target, slots);
    }
    let listeners = slots.get(key);
    if (!listeners) {
      listeners = new Set();
      slots.set(key, listeners);
    }
    return listeners;
  }

  private wrappersFor(target: EventTarget, key: string): Map<AnyListener, AnyListener> {
    let slots = this.wrappers.get(target);
    if (!slots) {
      slots = new Map();
      this.wrappers.set(target, slots);
    }
    let byListener = slots.get(key);
    if (!byListener) {
      byListener = new Map();
      slots.set(key, byListener);
    }
    return byListener;
  }

  private forget(target: EventTarget, key: string, listener: AnyListener): void {
    const wrapper = this.wrappersFor(target, key).get(listener);
    if (wrapper) this.liveFor(target, key).delete(wrapper);
    this.wrappersFor(target, key).delete(listener);
  }
}

/**
 * A jsdom window as this suite uses it: the DOM `Window` plus the constructors that are
 * read straight off it (the DOM types do not declare all of them on `Window`).
 */
export type JsdomWindow = Window &
  typeof globalThis & {
    EventTarget: typeof EventTarget;
    Event: typeof Event;
    Node: typeof Node;
    Element: typeof Element;
    ShadowRoot: typeof ShadowRoot;
    HTMLInputElement: typeof HTMLInputElement;
  };

export interface Dom {
  readonly window: JsdomWindow;
  readonly document: Document;
  readonly body: HTMLElement;
  readonly counts: ListenerRegistry;
}

export function createDom(): Dom {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    // Listener exceptions are reported by jsdom; without a console they would be
    // printed by the test runner as noise.
    virtualConsole: new VirtualConsole(),
  });
  const window = dom.window as unknown as JsdomWindow;
  const counts = new ListenerRegistry();
  counts.instrument(window);

  return { window, document: window.document, body: window.document.body as HTMLElement, counts };
}

/** A drag event carrying `dataTransfer`, which jsdom's `Event` has no notion of. */
export function dragEvent(
  dom: Dom,
  type: string,
  dataTransfer: DataTransferLike | null = fileDragPayload(),
  init: { bubbles?: boolean; cancelable?: boolean; composed?: boolean } = {},
): Event {
  const event = new dom.window.Event(type, {
    bubbles: init.bubbles !== false,
    cancelable: init.cancelable !== false,
    composed: init.composed !== false,
  });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
  return event;
}

/** Readable name for a node, used in test failure messages. */
export function describeNode(dom: Dom, node: unknown): string {
  if (node === dom.window) return 'window';
  if (node === dom.document) return 'document';
  if (!node || typeof node !== 'object') return String(node);

  const element = node as Element & { host?: Element; mode?: string };
  if (element.nodeType === 11) {
    return `${describeNode(dom, element.host)}/shadow(${element.mode ?? '?'})`;
  }
  if (element.nodeType === 1) {
    const id = element.id ? `#${element.id}` : '';
    const type = element.getAttribute('type');
    return `<${element.tagName.toLowerCase()}${id}${type ? `[type=${type}]` : ''}>`;
  }
  return `nodeType=${element.nodeType}`;
}

/* ------------------------------------------------------------------ *
 * Drag payloads
 * ------------------------------------------------------------------ */

/** A file drag as Firefox reports it once the drop happens. */
export function fileDragPayload(): DataTransferLike {
  return { items: [{ kind: 'file' }], files: [{ name: 'report.pdf' }], types: ['Files'] };
}

/** What `dragover` often looks like: `files` still empty, only `types` set. */
export function filesTypeOnlyPayload(): DataTransferLike {
  return { items: [], files: [], types: ['application/x-moz-file'] };
}

/** A plain text drag: none of the guard's business. */
export function textDragPayload(): DataTransferLike {
  return { items: [{ kind: 'string' }], files: [], types: ['text/plain'] };
}

/** `dataTransfer` is attached to a plain `Event`, so it needs a typed accessor. */
export function dataTransferOf(event: Event): DataTransferLike | null {
  return (event as Event & { dataTransfer?: DataTransferLike | null }).dataTransfer ?? null;
}

/** The file names a drop handler would see. */
export function fileNames(dataTransfer: DataTransferLike | null | undefined): string[] {  const files = dataTransfer?.files;
  const length = files && typeof files.length === 'number' && files.length > 0 ? files.length : 0;
  const names: string[] = [];
  for (let index = 0; index < length; index++) {
    const entry = files?.[index] as { name?: unknown } | undefined;
    if (entry && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}
