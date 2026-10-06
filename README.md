# Safe File Drag

A **Firefox-only WebExtension** that stops an accidental local-file drop from
replacing ("navigating away") the page you are working on — without breaking the
file uploads that are supposed to work.

* Source: <https://github.com/QZLin/SafeFileDrag> — GPL-3.0-or-later, see [LICENSE](LICENSE).
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
| `scripts/test.mjs` | Bundles the jsdom suite and runs it on Node's built-in test runner. |
| `scripts/test-gecko.mjs` | Drives real Firefox (through `web-ext run`) and collects the probe page's report. |
| `scripts/sign.mjs` | Signs the built package with AMO, with the pre-flight checks that stop the classic mistake. |
| `scripts/lib/` | Shared by the launchers: finding Firefox/web-ext, the static server, the package check. |
| `test/` | The jsdom suite (no test framework). |
| `test/support/` | Harness: jsdom page, listener bookkeeping, drag payloads, globals bridge for `src/content.ts`. |
| `test/gecko/` | The probe page and its scripts: assert inside real Gecko, then post the results back. |
| `scripts/dev.mjs` | Manual-test launcher: serves `dev/` and opens Firefox with the add-on loaded. |
| `dev/index.html` | The manual playground (zones that need a real Firefox and a real file drag). |
| `dev/playground.js` | The playground's behaviour, external so no page carries an inline script. |
| `LICENSE` | GPL-3.0-or-later. Copied into `dist/` so the signed package carries it too. |
| `dist/` | The loadable (temporary) add-on. Generated; not minified on purpose. |

## Build

```sh
pnpm install
pnpm run check      # typecheck (src + tests) && build && test   (no browser needed)
pnpm run check:full # the above, then the real-Gecko check       (needs Firefox)
```

or separately:

```sh
pnpm run typecheck       # tsc --noEmit (TypeScript 7)
pnpm run typecheck:test  # tsc -p tsconfig.test.json (sources + tests)
pnpm run test            # node --test over the bundled jsdom suite
pnpm run test:gecko      # the same promises, checked in real Firefox
pnpm run build           # -> dist/manifest.json, dist/content.js
```

The build ends by checking the package against its own manifest: every file the manifest
names must exist in `dist/`. That is the local version of AMO's
`MANIFEST_CONTENT_SCRIPT_FILE_NOT_FOUND`, and it fails the build instead of the upload.

The bundle is deliberately **not** minified: it is small, security-sensitive, and
meant to be read by whoever installs or reviews it.

## Package and sign

```sh
pnpm run sign                        # unlisted build (self-distribution), the default
pnpm run sign -- --channel=listed    # submit for an AMO listing
pnpm run sign -- --check             # pre-flight only: no upload, no network
pnpm run lint                        # = web-ext lint --source-dir dist
```

**Always sign `dist/`, never the repository root.** `web-ext sign` on its own signs the
current directory. The root contains the *source* manifest, whose `content.js` only exists
after the build, so signing there uploads a package AMO rejects:

```
MANIFEST_CONTENT_SCRIPT_FILE_NOT_FOUND   content_scripts[0].js refers to "content.js",
                                         which is not in the package
KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION   …
KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION   …
INLINE_SCRIPT × 3                        dev/index.html, test/gecko/index.html
```

Every one of those goes away with `--source-dir dist`: the inline-script warnings were
about development pages that are not part of the add-on at all, and the missing file was
the build output. `pnpm run sign` always passes `--source-dir dist`, checks the package
against the manifest, and refuses to upload without credentials — so that particular
failure cannot be repeated by hand. The signed `.xpi` lands in `web-ext-artifacts/`
(git-ignored).

Credentials are never committed; `scripts/sign.mjs` accepts them from the environment
(`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`), from a `.env` file next to `package.json`, or
from `--api-key=` / `--api-secret=`. Create them at
<https://addons.mozilla.org/developers/addon/api/key/>.

### The two warnings that remain

`pnpm run lint` reports **0 errors and 2 warnings**, and both are about the same metadata
key:

* `browser_specific_settings.gecko.data_collection_permissions` is understood from
  Firefox 140 (desktop) and Firefox for Android 142, while `strict_min_version` is 128.0 —
  the first release with `world: "MAIN"` content scripts;
* older versions simply ignore the key, and AMO requires it for new submissions, so the
  only effect is the warning;
* raising `strict_min_version` to `140.0` (or adding
  `browser_specific_settings.gecko_android.strict_min_version: "142.0"`) silences one
  warning each, at the price of making the add-on uninstallable on Firefox 128–139 for no
  functional gain. The warnings are therefore accepted deliberately.

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

## Manual verification

`pnpm start` builds the extension, serves `dev/index.html` on
`http://127.0.0.1:8788/` and opens Firefox with the add-on installed temporarily — one
command, visible window, no headless. (`pnpm start:check` does the same setup without
launching a browser.)

The page is a manual playground of nine zones; each one states its own pass criterion,
and a banner at the top plus the tab title reveal immediately if a drop navigated the
tab. Checked on Firefox 158 Developer Edition:

| Zone | Scenario | Result |
| --- | --- | --- |
| 1 | empty area, no listeners at all | no reaction, no navigation |
| 2 | `<input type="file" multiple>` | file received, `change` fires |
| 3 | dropzone with `dragover` + `drop` | file received |
| 4 | dropzone with `drop` only (no `dragover` handler) | `drop` fires, file received, no navigation |
| 5 | `dragover` cancelled, no `drop` handler | nothing happens, no navigation |
| 6 | `contenteditable` | text drag inserts, file drag does nothing |
| 7 | `<textarea>` | text drag unaffected |
| 8 | link drag | URL inserted, guard never engages |
| 9 | `<input type="file">` inside an open shadow root (web component) | file received, `change` fires |

Zone 2 is the important one: it is what proves the native upload path is untouched.
Zone 4 is the interesting one: the page never cancels `dragover`, so the guard's own
cancellation is what lets that `drop` fire at all. Zone 9 is the newest: it is the only
place where the browser's own retargeting ("which element is `event.target` inside a
shadow tree?") is exercised by a real drag, and it is why the guard reads the composed
path as well as `event.target`.

## The jsdom test suite

```sh
pnpm run test        # 89 tests, Node's built-in runner
pnpm run check       # typecheck (src + tests) && build && test
```

No test framework and no extra runtime dependency: `scripts/test.mjs` bundles each
`test/**/*.test.ts` with esbuild (the compiler the build already uses) into
`.test-build/` and runs `node --test` over the result. The suite imports the shipping
sources directly, and it runs against **jsdom** rather than a hand-written DOM stub.

Why jsdom matters here: the guard is a bet about *when* listeners run, and a simulation
written for this repository could be made to agree with the guard by accident. jsdom
implements DOM dispatch the way the specification describes, so the semantics are
borrowed rather than asserted. `test/dispatch.test.ts` pins the specific behaviours the
guard depends on — capture/bubble order, listeners added mid-dispatch still running on
nodes not yet visited, `once` removal before the callback, `cancelBubble` readable by
later listeners on the same node, shadow retargeting, and the `preventDefault()` rules.
The only thing faked is the drag payload: jsdom has no `DataTransfer`, so a plain `Event`
carries a `dataTransfer` property. jsdom's shadow retargeting — the one place where a DOM
implementation could plausibly differ, and the place the guard's native-target check
depends on — was cross-checked against Gecko by the check below, and agrees.

| File | Covers |
| --- | --- |
| `dispatch.test.ts` | The DOM semantics the guard is built on. |
| `is-file-drag.test.ts` | Pure unit tests for `isFileDrag()`: which payloads count as a file drag, and which must not (text, link, HTML, unreadable payloads). |
| `policy.test.ts` | The verdict matrix: every kind of target against every kind of drag. |
| `propagation.test.ts` | Timing, `stopPropagation` / `stopImmediatePropagation`, late-attached handlers, and the two "KNOWN HOLE" cases. |
| `robustness.test.ts` | Hostile environments: throwing `composedPath`, garbage paths, nodes that refuse listeners, 300-deep trees, 50 drops in a row, leaks. |
| `shadow-dom.test.ts` | Open and closed shadow roots, including nested ones. |
| `content.test.ts` | The real `src/content.ts` against jsdom, plus the once-per-window install marker. |
| `artifact.test.ts` | `dist/content.js` and `dist/manifest.json` as built (skipped when `dist/` is absent — `pnpm run check` builds first). |
| `manifest.test.ts` | Manifest invariants: MV3, no permissions, no remote code, MAIN world, `document_start`, all frames. |

Writing these tests paid for itself immediately: they found the open-shadow-root bug
described at the end of this section, and the real-Gecko check below confirmed it.

`@types/node` is a direct devDependency now; before that it only arrived transitively
through `@types/jsdom`, which would have broken `typecheck:test` the moment jsdom was
dropped.

## The real-Gecko check
```sh
pnpm run test:gecko              # headless (default)
pnpm run test:gecko -- --headed  # watch it happen in a window
```

jsdom is not Gecko, so the suite cannot settle the things that only a browser decides.
`scripts/test-gecko.mjs` starts the local static server, launches Firefox through
`web-ext run` with `dist/` installed as a temporary add-on, and waits for
`test/gecko/index.html` to POST its report back. Headless by default; no WebDriver, no
geckodriver, no extra dependency.

Twelve checks, each of them something jsdom cannot answer:

| Check | What the browser reported (Firefox 158 Developer Edition) |
| --- | --- |
| install marker visible to a `<head>` script | `true` — the content script really runs in the page's world at `document_start` |
| no WebExtension APIs in the page world | `typeof browser`/`chrome` are `undefined` — `world: "MAIN"` is not an isolated world |
| a real `DataTransfer` with a `File` item | `types` is `["Files"]` — the token `isFileDrag()` looks for |
| a file drop on a plain element | `dragenter=true dragover=true drop=true` (all cancelled) |
| a file drop on `<input type="file">` | all three phases left alone, so the control can receive the file |
| a disabled file input | cancelled |
| a file input inside an **open** shadow root | `event.target` is the host (`div#component`) but `composedPath()[0]` is the input; the drop is left alone |
| a file input inside a **closed** shadow root | `event.target` is the host and the path stops there; cancelled (fail-safe) |
| a text drag | not touched, `types` is `["text/plain"]` |
| a dropzone that consumes the drop | its handler receives `zone.pdf`, and a plain element in the same page is still cancelled |
| `stopPropagation()` without `preventDefault()` | still cancelled — `cancelBubble` detection works in Gecko |
| `stopImmediatePropagation()` without `preventDefault()` | **not** cancelled — the documented limitation reproduces in Gecko |

What even this cannot prove: whether Firefox really navigates the tab on an unconsumed
file drop, and whether its native `<input type="file">` accepts a real drop without
anyone cancelling `dragover`. Both need a drag started from the operating system's file
manager, which WebDriver cannot inject — so they stay in the manual playground, which is
what zone 2 is for.

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
  fine, because the page already did the guard's job.) Covered as a characterisation
  test in `test/propagation.test.ts`.
* The same applies to `stopPropagation()` called from a `window` **capture** listener,
  which is the only listener that can run before the guard's own `window` capture
  listener and cut off the whole path.
* Drops inside **closed** shadow roots are seen only through retargeting, and the
  composed path stops at the host, so a file input nested in a closed shadow tree cannot
  be recognised as an upload target and will be blocked (fail-safe direction). Open
  shadow roots *are* handled: the guard reads the deepest node of the composed path in
  addition to `event.target`.
* If `DataTransfer` cannot be read at all (nothing but throwing accessors), the event is
  indistinguishable from a text drag and is left alone. Cancelling on "no readable
  evidence" would break ordinary text drops on every page, so this trade-off is
  deliberate. `test/robustness.test.ts` documents it.
* Non-file drags are not intercepted at all, so a page whose own default action for,
  say, a link drop navigates is out of scope — this extension is about files.

### A bug the tests caught

File inputs inside **open** shadow roots used to be blocked. `event.target` is retargeted
to the shadow host for every listener outside the shadow tree, so the guard saw the host
(a `<div>`, in the common `<my-uploader><input type="file"></my-uploader>` shape) and
concluded it was not an upload control — cancelling a drop that the browser would have
handled correctly. The composed path still names the real target, so the guard now tests
that as well. A second half of the same bug lived in `src/content.ts`: path nodes are
wrapped in per-target adapters for identity checks, and the adapter was being handed to
`isNativeFileDropTarget()` — which promptly failed, because an adapter is not an
`Element`.

The jsdom suite found it (`test/shadow-dom.test.ts`, `test/content.test.ts`), and the
real-Gecko check now confirms both the premise and the fix in Firefox — `event.target`
really is `div#component` while `composedPath()[0]` really is `input#shadow-input`.
Reverting just those two source files makes `pnpm run test:gecko` report 11/12, failing
on exactly that check with `dragenter=true dragover=true drop=true`: a legitimate upload
cancelled in a real browser. Zone 9 of the playground reproduces it by hand.

## Next steps (not done yet)

The nine zones documented under "Manual verification" were checked by hand, the jsdom
suite covers the policy and its propagation corner cases, and the real-Gecko check covers
the browser-specific dispatch behaviour. What is left:

* **The two claims that need a real drag from the OS.** That Firefox really navigates the
  tab on an unconsumed file drop, and that its native `<input type="file">` accepts a drop
  without anyone cancelling `dragover` (`CANCEL_DRAGOVER_ON_NATIVE_TARGET`). Injecting
  that would mean synthesising mouse input over a file manager window, which WebDriver
  cannot do and which would hijack the machine's own pointer — so it stays manual, and the
  playground is built for it.
* **The real `DataTransfer` shape of an OS file drag.** The probe page shows a
  `DataTransfer` built from a `File` reports `["Files"]`; whether a real drag additionally
  reports `application/x-moz-file` (the historical token `isFileDrag()` also accepts) can
  only be seen with a real drag. The playground's log prints `dataTransfer.types` for
  every event precisely so this is visible.
* Playground zones for an **iframe** drop; iframes are already covered by `all_frames` and
  by the jsdom suite, but not yet by a real drag.

## License

Copyright (C) 2026 QZLin

This program is free software: you can redistribute it and/or modify it under the terms
of the GNU General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but **without any
warranty**; without even the implied warranty of merchantability or fitness for a
particular purpose. See the GNU General Public License for more details.

The full text is in [LICENSE](LICENSE), and is copied into `dist/` so the signed `.xpi`
carries it too. `package.json` declares the same terms as `GPL-3.0-or-later`.

The add-on id is `safe-file-drag@qzlin.github.io`. It is the add-on's identity on AMO:
changing it creates a different add-on, so it is pinned by a test rather than left to a
casual edit.
