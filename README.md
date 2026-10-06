# Safe File Drag

A **Firefox-only WebExtension** that stops an accidental local-file drop from
replacing ("navigating away") the page you are working on — without breaking the
file uploads that are supposed to work.

* Manifest V3, Firefox 128+, no build-time UI, no background script.
* No `permissions`, no `storage`, no `background`/`popup`/`options`, no network
  access, no remote code, no `eval`.
* One content script in the **page's own world** (`world: "MAIN"`), running at
  `document_start`.

---

## The problem

In Firefox, dropping a local file onto a page whose own handlers do **not** consume
the `drop` event makes the browser run the event's *default action*, which loads the
dropped file in place of the current document. Any unsaved work in that tab is gone.

The tempting one-liner is wrong:

```js
// DO NOT DO THIS
window.addEventListener('drop', (e) => e.preventDefault());
```

That breaks legitimate uploads. Receiving a dropped file is a **default action** for
several targets, most notably `<input type="file">` (and rich-text editors): if you
cancel `drop` unconditionally, the file never reaches the input. The guard must
therefore ask *"did the page consume this event?"* and only cancel when nobody did.

## The rule

```
drop / dragover / dragenter, and the drag carries file(s):

  event.defaultPrevented === true   →  the page consumed it  →  do nothing
  event.defaultPrevented === false  →  nobody consumed it    →  cancel the event
      … except when the drop target is a native file target
        (`<input type="file">` that is not disabled), which needs the default action
```

Decisions are made **per event target**, never globally: the presence of a dropzone
somewhere on the page does not make the rest of the page a dropzone. When the
situation cannot be judged reliably, the guard cancels — losing a possible upload is
recoverable, losing the tab is not.

`dragenter` / `dragover` get the same verdict for a different reason: Firefox only
fires a `drop` event at a target whose `dragover` was cancelled. Cancelling those
phases is what *guarantees* the `drop` event happens, so the guard can then decide on
`drop` itself, where the page has had its say. Nothing is cancelled for drags that do
not carry files, so text, link, image and HTML drags are untouched.

## How the timing problem is solved

`defaultPrevented` is only meaningful at the **end** of event propagation, and
`preventDefault()` only works **during** propagation. Reading the flag from an early
capture listener, from a timer or from a microtask is either too early (the page has
not run yet) or too late (the default action already happened).

The guard therefore instruments the propagation path for the duration of one event:

1. A `window` **capture** listener — registered at `document_start`, so before any
   page script — is the first listener to see each drag event. It reads
   `event.dataTransfer` and, if the drag carries files, resolves the event's path via
   `Event.composedPath()`.
2. It attaches a one-shot listener for **both phases on every node of that path**.
   Because the page's own listeners were registered earlier, the guard's listener
   runs *after* the page's listeners on any given node, while sharing the node.
   (Per the DOM dispatch algorithm, a struct's listener list is snapshotted when the
   event reaches that struct, so listeners added during the capture phase are still
   honoured for later nodes and for the bubble phase.)
3. The verdict is taken at the **last node the event actually reaches**:
   * `window` in the bubble phase — the tail of every path, or
   * the first node where the event no longer bubbles, or
   * the node where propagation was stopped, detected through the legacy
     `event.cancelBubble` flag, which `stopPropagation()` sets immediately and which
     is still readable by listeners on that same node.

   All observers for the previous event are detached before the next one is
   instrumented, so nothing accumulates over a long drag.

Because propagation is only ever *observed* — never hijacked — the page's own
handlers (capture or bubble, delegated or direct, React/Vue style) keep working
exactly as before, and the guard's verdict is simply "was `preventDefault()` called
by the time the event finished?"

## Layout

| Path | Purpose |
| --- | --- |
| `src/guard.ts` | The whole policy. DOM-free: everything it touches is injected via `GuardEnv`. |
| `src/content.ts` | The Firefox adapter: captures native DOM references at `document_start` and wires the real `window`/`document` into the guard. |
| `manifest.json` | MV3 manifest (copied into `dist/` by the build). |
| `scripts/build.mjs` | esbuild bundle → `dist/content.js`, then copies the manifest. |
| `dist/` | The loadable (temporary) add-on. Generated; not minified on purpose. |

## Build

```sh
pnpm install
pnpm run check      # tsc --noEmit && build
```

or separately:

```sh
pnpm run typecheck  # tsc --noEmit (TypeScript 7)
pnpm run build      # -> dist/manifest.json, dist/content.js
```

The bundle is deliberately **not** minified: it is small, security-sensitive, and
meant to be read by whoever installs or reviews it.

Manifest validation with Mozilla's own linter:

```sh
pnpm dlx web-ext lint --source-dir dist
```

Result for this revision: **0 errors.** It reports two informational warnings because
the manifest declares `browser_specific_settings.gecko.data_collection_permissions`
(required by AMO for new submissions, supported from Firefox 140) while
`strict_min_version` stays at `128.0` — the first version with `world: "MAIN"`
content scripts. Firefox 128–139 simply ignore that metadata key.

## Install (temporary, for testing)

1. `pnpm run build`
2. Firefox → `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → pick `dist/manifest.json`
4. Open a normal page and drop a local file on an empty area: the page must not be
   replaced by the file. Then try it on an `<input type="file">` and on a dropzone:
   both must still receive the file.

`about:`, the PDF viewer, reader view and other privileged pages are deliberately not
covered (`<all_urls>` never matched them anyway); iframes are covered, because the
script runs in every frame.

## Design notes and deliberate trade-offs

* **Firefox-only.** The whole mechanism depends on Firefox behaviours: file drops on
  a non-consuming page performing a navigation default action, `DataTransfer.types`
  reporting `Files` / `application/x-moz-file`, and `cancelBubble` remaining readable
  by same-node listeners. It is not tested against, and not intended for, Chrome.
* **MAIN world is required, and it is a real risk.** The guard must read
  `defaultPrevented` / `cancelBubble` from events the page itself has processed, so it
  has to live in the page's own world — that is where `world: "MAIN"` (Firefox 128+)
  puts it. The consequence is that the page can detect, patch around or fight this
  script. Native references (`addEventListener`, `removeEventListener`,
  `Event.composedPath`) are captured at `document_start`, before any page script runs,
  but the risk cannot be eliminated. Accepted, as required.
* **The drag cursor may show "copy" over areas that are not dropzones.** Cancelling
  `dragover` is what makes the `drop` event fire so the final verdict can be taken;
  the guard deliberately does *not* set `dropEffect = "none"`, because that can
  suppress the `drop` event that the page's own handler may be waiting for.
* **Text-ish targets are blocked for file drags.** Only `<input type="file">` gets the
  native-default exemption. Dropping a file into a `contenteditable`, a plain
  `<textarea>` or a text input is cancelled (no navigation, no inserted file
  name/path). Rich-text editors that actually accept files handle `drop` themselves
  and are therefore allowed by the `defaultPrevented` check.
* **Blast radius.** For a file drag the guard only ever calls `preventDefault()`. It
  never calls `stopPropagation()`/`stopImmediatePropagation()`, never rewrites
  `dataTransfer`, and never re-dispatches events, so a page's own handling cannot be
  broken by it.
* **No UI, no state, no privileges.** Nothing is stored, nothing is sent anywhere,
  and the extension has no browser API surface beyond being injected.

## Known limitations (accepted)

* A page that calls `stopImmediatePropagation()` **without** `preventDefault()` on the
  file drop defeats the guard: the remaining listeners on that node — including the
  guard's observer — are skipped, and propagation stops before any later node could
  report a verdict. (`stopImmediatePropagation()` *with* `preventDefault()` works
  fine, because the page already did the guard's job.)
* The same applies to `stopPropagation()` called from a `window` **capture** listener,
  which is the only listener that can run before the guard's own `window` capture
  listener and cut off the whole path.
* Drops inside **closed** shadow roots are seen only through retargeting, so a file
  input nested in a closed shadow tree may not be recognised as a native upload
  target and will be blocked (fail-safe direction).
* Non-file drags are not intercepted at all, so a page whose own default action for,
  say, a link drop navigates is out of scope — this extension is about files.

## Next steps (not done yet)

The scenario verification was intentionally deferred. Still to add:

* standalone HTML pages for the scenarios (plain page, `<input type="file">`, custom
  dropzone with `dragover`+`drop`, drop-only dropzone, dropzone with `dragover` but no
  `drop` handling, capture-phase handler, bubble-phase handler,
  `preventDefault()`+`stopPropagation()`, `preventDefault()`+`stopImmediatePropagation()`,
  React-style document delegation, text / link / image drags, `contenteditable`, and a
  dropzone that must *not* vouch for the rest of the page);
* an automated harness for the same scenarios, driving `installGuard()` against a
  simulated DOM and propagation path, so the policy is regression-tested without a
  browser.
