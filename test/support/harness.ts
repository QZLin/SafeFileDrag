/**
 * Test harness: a jsdom page with the real `installGuard()` from `src/guard.ts`
 * installed on it, plus recording of what the guard decided.
 *
 * The harness implements no policy of its own. It only supplies the environment the
 * guard asks for (`window`, `composedPath()`, a native-target test) and remembers the
 * verdicts, so a test reads as a statement about the shipping code.
 */
import {
  installGuard,
  type DataTransferLike,
  type Decision,
  type EventTargetLike,
  type GuardAction,
  type GuardEnv,
} from '../../src/guard.js';
import {
  type AnyListener,
  createDom,
  describeNode,
  dragEvent,
  fileDragPayload,
  fileNames,
  listenerKey,
  type Dom,
} from './dom.js';

export interface Recording {
  readonly phase: string;
  readonly action: GuardAction;
  /** Name of the node the guard decided at, e.g. `window` or `<input#upload>`. */
  readonly node: string;
}

export interface DragResult {
  readonly event: Event;
  /** Decisions taken during this single dispatch. */
  readonly decisions: readonly Recording[];
  readonly actions: readonly GuardAction[];
  readonly prevented: boolean;
  /** Prevented, and no page listener (one registered through `page.on`) did it. */
  readonly preventedByGuard: boolean;
  readonly preventedByPage: boolean;
}

/** Environment overrides, used by the robustness tests to build hostile pages. */
export interface GuardEnvOverrides {
  readonly getPath?: (event: Event) => EventTargetLike[] | null;
  readonly isNativeFileDropTarget?: (target: unknown) => boolean;
  readonly onDecision?: (decision: Decision) => void;
}

/**
 * The native-target policy of `src/content.ts`, restated for the guard-level tests.
 * `test/content.test.ts` covers the real implementation, shadow walk included.
 */
export function isNativeFileInput(target: unknown): boolean {
  const element = target as HTMLInputElement | null;
  if (!element || element.nodeType !== 1) return false;
  if (element.tagName !== 'INPUT') return false;
  if (String(element.type ?? '').toLowerCase() !== 'file') return false;
  return element.disabled !== true;
}

export function installRawGuard(options: GuardEnvOverrides & { readonly window: Window }): void {
  const env: GuardEnv = {
    window: options.window as unknown as EventTargetLike,
    getPath: (event) => {
      if (options.getPath) return options.getPath(event as unknown as Event);
      return (event as unknown as Event).composedPath() as unknown as EventTargetLike[];
    },
    isNativeFileDropTarget: options.isNativeFileDropTarget ?? isNativeFileInput,
    onDecision: options.onDecision,
  };
  installGuard(env);
}

export interface ElementInit {
  readonly id?: string;
  readonly type?: string;
  readonly disabled?: boolean;
}

export class Page {
  readonly dom: Dom = createDom();
  readonly window = this.dom.window;
  readonly document = this.dom.document;
  readonly body = this.dom.body;
  /** Every decision the guard reported, in order. */
  readonly decisions: Recording[] = [];

  private pagePrevented = false;
  private readonly pageWrappers = new WeakMap<EventTarget, Map<string, Map<AnyListener, AnyListener>>>();

  install(overrides: GuardEnvOverrides = {}): void {
    installRawGuard({
      window: this.window,
      getPath: overrides.getPath,
      isNativeFileDropTarget: overrides.isNativeFileDropTarget,
      onDecision: (decision) => {
        this.decisions.push({
          phase: decision.phase,
          action: decision.action,
          node: this.describe(decision.node),
        });
        overrides.onDecision?.(decision);
      },
    });
  }

  /** Creates an element and appends it to `<body>` (or to `parent`). */
  el(tagName: string, init: ElementInit = {}, parent: ParentNode = this.body): HTMLElement {
    const element = this.document.createElement(tagName) as HTMLElement & {
      type?: string;
      disabled?: boolean;
    };
    if (init.id !== undefined) element.id = init.id;
    if (init.type !== undefined) element.setAttribute('type', init.type);
    if (init.disabled !== undefined) element.toggleAttribute('disabled', init.disabled);
    parent.append(element);
    return element;
  }

  describe(node: unknown): string {
    return describeNode(this.dom, node);
  }

  count(target: EventTarget, type?: string): number {
    return this.dom.counts.count(target, type);
  }

  /**
   * Registers a *page* listener. Wrapping it is what makes it possible to tell the
   * guard's own `preventDefault()` from the page's.
   */
  on(
    target: EventTarget,
    type: string,
    listener: AnyListener,
    options?: boolean | AddEventListenerOptions,
  ): AnyListener {
    const page = this;
    const wrapper: AnyListener = function wrapper(this: EventTarget, event: Event) {
      const before = event.defaultPrevented;
      Reflect.apply(listener, this, [event]);
      if (!before && event.defaultPrevented) page.pagePrevented = true;
    };
    this.wrappersFor(target, listenerKey(type, captureOf(options))).set(listener, wrapper);
    target.addEventListener(type, wrapper, options);
    return listener;
  }

  off(
    target: EventTarget,
    type: string,
    listener: AnyListener,
    options?: boolean | EventListenerOptions,
  ): void {
    const capture = captureOf(options);
    const key = listenerKey(type, capture);
    const wrapper = this.pageWrappers.get(target)?.get(key)?.get(listener);
    if (wrapper) target.removeEventListener(type, wrapper, { capture });
  }

  dispatch(
    type: string,
    target: EventTarget,
    dataTransfer: DataTransferLike | null = fileDragPayload(),
    init: { bubbles?: boolean; cancelable?: boolean } = {},
  ): DragResult {
    const before = this.decisions.length;
    this.pagePrevented = false;
    const event = dragEvent(this.dom, type, dataTransfer, init);
    target.dispatchEvent(event);

    const decisions = this.decisions.slice(before);
    const preventedByPage = this.pagePrevented;
    return {
      event,
      decisions,
      actions: decisions.map((decision) => decision.action),
      prevented: event.defaultPrevented,
      preventedByGuard: event.defaultPrevented && !preventedByPage,
      preventedByPage,
    };
  }

  enter(target: EventTarget, dataTransfer: DataTransferLike = fileDragPayload()): DragResult {
    return this.dispatch('dragenter', target, dataTransfer);
  }

  over(target: EventTarget, dataTransfer: DataTransferLike = fileDragPayload()): DragResult {
    return this.dispatch('dragover', target, dataTransfer);
  }

  drop(target: EventTarget, dataTransfer: DataTransferLike = fileDragPayload()): DragResult {
    return this.dispatch('drop', target, dataTransfer);
  }

  /** The full drag sequence a browser would produce over one target. */
  sequence(
    target: EventTarget,
    dataTransfer: DataTransferLike = fileDragPayload(),
  ): { enter: DragResult; over: DragResult; drop: DragResult } {
    return {
      enter: this.enter(target, dataTransfer),
      over: this.over(target, dataTransfer),
      drop: this.drop(target, dataTransfer),
    };
  }

  private wrappersFor(target: EventTarget, key: string): Map<AnyListener, AnyListener> {
    let slots = this.pageWrappers.get(target);
    if (!slots) {
      slots = new Map();
      this.pageWrappers.set(target, slots);
    }
    let wrappers = slots.get(key);
    if (!wrappers) {
      wrappers = new Map();
      slots.set(key, wrappers);
    }
    return wrappers;
  }
}

function captureOf(options?: boolean | EventListenerOptions): boolean {
  return typeof options === 'boolean' ? options : options?.capture === true;
}

/** A page with the guard installed and `parse-time`-like defaults. */
export function createPage(overrides: GuardEnvOverrides = {}): Page {
  const page = new Page();
  page.install(overrides);
  return page;
}

export { createDom, dragEvent, fileDragPayload, fileNames, listenerKey };
export type { Dom };
