/**
 * SafeFileDrag — content script entry point (`world: "MAIN"`, `document_start`).
 *
 * Everything Firefox-specific lives here: the guard in `./guard.ts` only sees the
 * small structural interfaces it declares, and this file wires the real DOM into
 * them.
 *
 * Running in the page's own world is required: the guard has to read
 * `event.defaultPrevented` / `event.cancelBubble` for events that the page's own
 * handlers have already processed, and it has to take part in the page's own
 * propagation path. The cost is that the page can see and interfere with this
 * script; that trade-off is accepted and documented in the README.
 */

import {
  installGuard,
  type DragEventLike,
  type EventTargetLike,
  type GuardEnv,
  type ListenerLike,
  type ListenerOptionsLike,
} from './guard.js';

/*
 * Native references are captured immediately, at `document_start`, before any page
 * script runs. The page may later replace these, and the guard must keep working
 * with the original behaviour.
 */
type NativeAddEventListener = (
  this: EventTarget,
  type: string,
  listener: EventListener,
  options?: AddEventListenerOptions | boolean,
) => void;

type NativeRemoveEventListener = (
  this: EventTarget,
  type: string,
  listener: EventListener,
  options?: EventListenerOptions | boolean,
) => void;

type NativeComposedPath = (this: Event) => EventTarget[];

const NATIVE_ADD = EventTarget.prototype.addEventListener as unknown as NativeAddEventListener;
const NATIVE_REMOVE = EventTarget.prototype
  .removeEventListener as unknown as NativeRemoveEventListener;
const NATIVE_COMPOSED_PATH = Event.prototype.composedPath as unknown as NativeComposedPath;

/** Marker so a second injection into the same window does not double-install. */
const INSTALLED = Symbol.for('safe-file-drag/installed/v1');

/** One adapter object per real target, so path identity checks stay meaningful. */
const TARGET_ADAPTERS = new WeakMap<EventTarget, EventTargetLike>();

/**
 * The reverse mapping. The guard reads its native-target candidates both from the event
 * (`event.target`, a real node) and from the composed path (our adapters), so the
 * adapter has to be able to translate back before inspecting the DOM.
 */
const ADAPTER_NODES = new WeakMap<EventTargetLike, EventTarget>();

function toTarget(node: EventTarget): EventTargetLike {
  const cached = TARGET_ADAPTERS.get(node);
  if (cached) return cached;

  const adapter: EventTargetLike = {
    addEventListener(type: string, listener: ListenerLike, options?: ListenerOptionsLike): void {
      NATIVE_ADD.call(node, type, listener as unknown as EventListener, options);
    },
    removeEventListener(type: string, listener: ListenerLike, options?: ListenerOptionsLike): void {
      NATIVE_REMOVE.call(node, type, listener as unknown as EventListener, options);
    },
  };
  TARGET_ADAPTERS.set(node, adapter);
  ADAPTER_NODES.set(adapter, node);
  return adapter;
}

function isFileInput(node: unknown): boolean {
  const element = node as Element | null;
  if (!element || element.nodeType !== 1) return false;
  const tagName = element.tagName;
  if (typeof tagName !== 'string' || tagName.toUpperCase() !== 'INPUT') return false;
  const input = element as HTMLInputElement;
  const type = input.type;
  if (typeof type !== 'string' || type.toLowerCase() !== 'file') return false;
  // A disabled input cannot accept the file, so it is not an upload target: fall
  // through to the conservative "block" path instead of leaving the drop to a
  // default action that would not happen.
  return input.disabled !== true;
}

/**
 * Does this drop target accept files by *default action*?
 *
 * `<input type="file">` does: cancelling its `drop` would throw away the file the
 * user just dropped. Such targets are left alone so the built-in upload keeps
 * working. Text-ish targets (`contenteditable`, text inputs) are intentionally not
 * included: for local files their default action is not a reliable "upload", so the
 * conservative choice is to block the navigation there.
 */
function isNativeFileDropTarget(target: unknown): boolean {
  // The guard offers both a real node (`event.target`) and path nodes (our adapters), so
  // translate first: an adapter is not an `Element` and would fail every check below.
  const candidate = ADAPTER_NODES.get(target as EventTargetLike) ?? target;
  if (isFileInput(candidate)) return true;

  // A drop can land inside a file input's (open) shadow tree; retargeting normally
  // reports the host, but walk shadow hosts explicitly to be certain.
  let node = candidate as Element | null;
  for (let depth = 0; node && node.nodeType === 1 && depth < 16; depth++) {
    const root = node.getRootNode() as ShadowRoot | Document;
    const host = (root as ShadowRoot).host;
    if (!host) return false;
    if (isFileInput(host)) return true;
    node = host;
  }
  return false;
}

function getPath(event: DragEventLike): EventTargetLike[] {
  const path = NATIVE_COMPOSED_PATH.call(event as unknown as Event);
  if (!Array.isArray(path)) return [];
  const targets: EventTargetLike[] = [];
  for (const node of path) {
    if (!node || typeof (node as EventTarget).addEventListener !== 'function') continue;
    targets.push(toTarget(node));
  }
  return targets;
}

const GUARD_ENV: GuardEnv = {
  window: toTarget(window),
  getPath,
  isNativeFileDropTarget,
};

function alreadyInstalled(): boolean {
  return Boolean((window as unknown as Record<symbol, unknown>)[INSTALLED]);
}

function markInstalled(): void {
  try {
    Object.defineProperty(window, INSTALLED, {
      value: true,
      configurable: true,
      writable: false,
      enumerable: false,
    });
  } catch {
    /* a page-provided non-extensible window is not worth failing over */
  }
}

if (!alreadyInstalled()) {
  markInstalled();
  installGuard(GUARD_ENV);
}
