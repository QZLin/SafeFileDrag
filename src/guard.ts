/**
 * SafeFileDrag — core guard logic.
 *
 * Problem (Firefox): when a local file is dropped on a page whose own handlers do
 * not consume the `drop` event, the browser performs the event's default action,
 * which replaces ("navigates") the current tab with the dropped file. Work in the
 * tab is lost.
 *
 * Fix: observe the *page's own* drag/drop handling and only cancel the event when
 * the page did not consume it.
 *
 *   event.defaultPrevented === true   -> the page consumed it -> leave it alone
 *   event.defaultPrevented === false  -> nobody consumed it   -> cancel it
 *
 * The hard part is that "did the page consume it?" is only knowable at the very
 * end of event propagation, and `preventDefault()` stops working once dispatch is
 * over. This module therefore walks the propagation path and places a one-shot
 * observer on every node, deciding at the last node the event actually reaches:
 *
 *   - observers are attached from a `window` capture listener, i.e. *before* the
 *     page's handlers run, but they are attached *after* the page's handlers were
 *     registered, so on any given node they run after that node's own listeners;
 *   - the decision is taken at `window` (the last node of every path) in the
 *     bubble phase, or earlier if propagation was stopped there
 *     (`event.cancelBubble`) or the event does not bubble.
 *
 * This module is deliberately DOM-free: everything it touches is injected through
 * `GuardEnv`, which keeps the policy testable and keeps the browser-specific
 * poking in one small adapter (`src/content.ts`).
 */

/** The bits of `DataTransfer` this guard reads. */
export interface DataTransferLike {
  /** Preferred source: works during `dragover`, where `files` may still be empty. */
  readonly items?: ArrayLike<{ readonly kind?: string | null } | null> | null;
  /** Fallback source: reliably populated during `drop`. */
  readonly files?: ArrayLike<unknown> | null;
  /** Last resort: Firefox reports `"Files"` / `"application/x-moz-file"`. */
  readonly types?: ArrayLike<string> | null;
}

/** The bits of `DragEvent` this guard reads. */
export interface DragEventLike {
  readonly type: string;
  readonly target: unknown;
  readonly dataTransfer: DataTransferLike | null;
  readonly defaultPrevented: boolean;
  readonly bubbles?: boolean;
  /** True once someone called `stopPropagation()` (or set `cancelBubble`). */
  readonly cancelBubble?: boolean;
  preventDefault(): void;
}

export interface ListenerOptionsLike {
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
}

export type ListenerLike = (event: DragEventLike) => void;

/** Minimal structural view of a real `EventTarget` (window, document, element). */
export interface EventTargetLike {
  addEventListener(type: string, listener: ListenerLike, options?: ListenerOptionsLike): void;
  removeEventListener(type: string, listener: ListenerLike, options?: ListenerOptionsLike): void;
}

export type GuardAction =
  /** Not a file drag (text, link, image, HTML): the guard stays out of the way. */
  | 'ignore:not-a-file-drag'
  /** The page's own handler called `preventDefault()`: pass through untouched. */
  | 'allow:page-consumed'
  /** Native file target (e.g. `<input type="file">`) relies on the default action. */
  | 'allow:native-file-target'
  /** Nobody consumed the file drop: cancel it so the tab is not navigated. */
  | 'block';

export interface Decision {
  readonly phase: string;
  readonly action: GuardAction;
  /** Node at which the decision was taken (for diagnostics). */
  readonly node: EventTargetLike;
}

export interface GuardEnv {
  /** The page's `window`; the guard's own listeners and the tail of every path. */
  readonly window: EventTargetLike;
  /** Propagation path of the event (`Event.composedPath()`), or null if unknown. */
  getPath(event: DragEventLike): EventTargetLike[] | null;
  /** True when the drop target itself handles files natively. */
  isNativeFileDropTarget(target: unknown): boolean;
  /** Optional diagnostics hook; the shipped content script does not use it. */
  onDecision?(decision: Decision): void;
}

/** Phases the guard observes. `dragenter`/`dragover` only serve to let `drop` fire. */
const HANDLED_PHASES = ['dragenter', 'dragover', 'drop'] as const;

/**
 * Firefox reports file drags through these `DataTransfer.types` tokens.
 * (`application/x-moz-file` is the historical Firefox spelling.)
 */
const FILE_TYPE_TOKENS = ['Files', 'application/x-moz-file'];

/** Cheap upper bound on how many path nodes we are willing to instrument. */
const MAX_PATH_NODES = 256;

/**
 * Whether a native drop target that accepts files by *default action* also has its
 * `dragenter`/`dragover` cancelled.
 *
 * `false` (default) is the smaller intervention: Firefox's native controls accept
 * drops without any JavaScript, so leaving them completely alone preserves their
 * built-in behaviour. Flip to `true` only if manual testing shows a native control
 * rejecting drops because nothing cancelled `dragover`.
 */
const CANCEL_DRAGOVER_ON_NATIVE_TARGET = false;

function readLength(value: ArrayLike<unknown> | null | undefined): number {
  if (!value) return 0;
  const length = value.length;
  return typeof length === 'number' && length > 0 ? length : 0;
}

/**
 * Is this a drag carrying local file(s)?
 *
 * Deliberately narrow: text, link, image and HTML drags must be left untouched, so
 * only explicit file evidence counts. Each accessor is guarded because
 * `DataTransfer` throws when read outside a valid drag event or after the drop.
 */
export function isFileDrag(dataTransfer: DataTransferLike | null | undefined): boolean {
  if (!dataTransfer) return false;

  try {
    const items = dataTransfer.items;
    const itemCount = readLength(items);
    for (let i = 0; i < itemCount; i++) {
      if (items?.[i]?.kind === 'file') return true;
    }
  } catch {
    /* fall through to the next source */
  }

  try {
    if (readLength(dataTransfer.files) > 0) return true;
  } catch {
    /* fall through to the next source */
  }

  try {
    const types = dataTransfer.types;
    const typeCount = readLength(types);
    for (let i = 0; i < typeCount; i++) {
      const type = types?.[i];
      if (typeof type === 'string' && FILE_TYPE_TOKENS.includes(type)) return true;
    }
  } catch {
    /* no reliable file evidence */
  }

  return false;
}

function isUsableTarget(node: unknown): node is EventTargetLike {
  if (!node || (typeof node !== 'object' && typeof node !== 'function')) return false;
  const candidate = node as Partial<EventTargetLike>;
  return (
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

interface Attachment {
  readonly node: EventTargetLike;
  readonly type: string;
  readonly listener: ListenerLike;
  readonly capture: boolean;
}

/**
 * Installs the guard. Call once per window, as early as possible
 * (`run_at: document_start`) so the capture listener is registered before any page
 * script can register its own.
 */
export function installGuard(env: GuardEnv): void {
  const win = env.window;

  let attachments: Attachment[] = [];
  let activeEvent: DragEventLike | null = null;
  let decided = false;

  const detachAll = (): void => {
    const pending = attachments;
    attachments = [];
    for (const attachment of pending) {
      try {
        attachment.node.removeEventListener(attachment.type, attachment.listener, {
          capture: attachment.capture,
        });
      } catch {
        /* the node may be gone; nothing to do */
      }
    }
  };

  const report = (phase: string, action: GuardAction, node: EventTargetLike): void => {
    if (!env.onDecision) return;
    try {
      env.onDecision({ phase, action, node });
    } catch {
      /* diagnostics must never affect the outcome */
    }
  };

  /**
   * Final verdict for one event. Reached at the last node of the propagation path,
   * i.e. while `preventDefault()` is still effective.
   */
  const decide = (event: DragEventLike, node: EventTargetLike): void => {
    if (decided) return;
    decided = true;

    let fileDrag = false;
    try {
      fileDrag = isFileDrag(event.dataTransfer);
    } catch {
      fileDrag = false;
    }
    if (!fileDrag) {
      report(event.type, 'ignore:not-a-file-drag', node);
      return;
    }

    // The page's own drag/drop handler consumed the event: leave it completely alone.
    if (event.defaultPrevented) {
      report(event.type, 'allow:page-consumed', node);
      return;
    }

    // A native file target (e.g. <input type="file">) receives the file through the
    // event's default action, so cancelling here would break a legitimate upload.
    let nativeTarget = false;
    try {
      nativeTarget = env.isNativeFileDropTarget(event.target);
    } catch {
      nativeTarget = false;
    }
    if (nativeTarget && (event.type === 'drop' || !CANCEL_DRAGOVER_ON_NATIVE_TARGET)) {
      report(event.type, 'allow:native-file-target', node);
      return;
    }

    // Nobody consumed this file drag. Cancelling is the conservative choice: it
    // stops Firefox from performing the drop's default action (loading the file in
    // place of the current page). Note that `preventDefault()` on `dragenter` /
    // `dragover` is what *allows* a `drop` event to fire at all, which is why the
    // same verdict also applies to those phases.
    try {
      event.preventDefault();
    } catch {
      /* nothing more we can do */
    }
    report(event.type, 'block', node);
  };

  const resolvePath = (event: DragEventLike): EventTargetLike[] => {
    const nodes: EventTargetLike[] = [];
    let path: EventTargetLike[] | null = null;
    try {
      path = env.getPath(event);
    } catch {
      path = null;
    }
    if (path) {
      for (const node of path) {
        if (nodes.length >= MAX_PATH_NODES) break;
        if (!isUsableTarget(node)) continue;
        if (nodes.includes(node)) continue;
        nodes.push(node);
      }
    }
    // `window` is the tail of every propagation path; without it the decision could
    // never be taken. It is also the fallback when the path is unavailable.
    if (!nodes.includes(win)) nodes.push(win);
    return nodes;
  };

  const attachObservers = (event: DragEventLike): void => {
    const path = resolvePath(event);

    for (const node of path) {
      for (const capture of [true, false]) {
        const listener: ListenerLike = (observed) => {
          // Ignore a stale observer that a later event happened to reach.
          if (observed !== event || activeEvent !== event || decided) return;

          // Capture phase: only relevant when propagation was stopped *at this node*
          // during capture, which makes this node the last one visited.
          if (capture) {
            if (observed.cancelBubble === true) decide(observed, node);
            return;
          }

          // Bubble phase: this node is the last one visited when it is `window`,
          // when the event does not bubble (only the target is visited), or when
          // propagation was stopped here.
          if (node === win || observed.bubbles === false || observed.cancelBubble === true) {
            decide(observed, node);
          }
        };

        try {
          node.addEventListener(event.type, listener, {
            capture,
            once: true,
            passive: false,
          });
          attachments.push({ node, type: event.type, listener, capture });
        } catch {
          /* a node may refuse listeners; the `window` observer still decides */
        }
      }
    }
  };

  /**
   * Runs first for every drag event (window, capture). Nothing is decided here:
   * the event has not met the page's handlers yet.
   */
  const onCapture = (event: DragEventLike): void => {
    // A previous event's observers are always stale by now.
    detachAll();
    activeEvent = null;
    decided = false;

    let fileDrag = false;
    try {
      fileDrag = isFileDrag(event.dataTransfer);
    } catch {
      fileDrag = false;
    }
    // Text, link, image and HTML drags are not our business at all.
    if (!fileDrag) return;

    activeEvent = event;
    attachObservers(event);
  };

  for (const phase of HANDLED_PHASES) {
    try {
      win.addEventListener(phase, onCapture, { capture: true, passive: false });
    } catch {
      /* nothing to do if even this fails */
    }
  }
}
