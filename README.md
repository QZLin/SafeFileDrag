# Safe File Drag

A **Firefox-only WebExtension** that stops an accidental local-file drop from replacing
the current tab, without breaking real uploads.

* Source: <https://github.com/QZLin/SafeFileDrag> — GPL-3.0-or-later, see [LICENSE](LICENSE).
* Manifest V3, Firefox 128+. No permissions, background script, storage, network access,
  remote code or `eval`.
* One content script in the page's own world (`world: "MAIN"`) at `document_start`, in
  every frame.

## The problem

A local file dropped on a page that does not consume the `drop` event makes Firefox run
the event's default action and navigate to the file; unsaved work is lost. Cancelling
`drop` unconditionally breaks uploads, because `<input type="file">` (and rich-text
editors) need that same default action. The guard therefore asks whether the page consumed
the event, and only cancels when nobody did:

```text
file drag, drop / dragover / dragenter:
  defaultPrevented === true   → page consumed it → do nothing
  defaultPrevented === false  → nobody consumed it → cancel
      except on an enabled <input type="file">, which keeps the default action
```

Decisions are per event target, never global; when in doubt the guard cancels (losing a
possible upload is recoverable, losing the tab is not). `dragenter`/`dragover` are
cancelled for the same reason: Firefox only fires `drop` at a target whose `dragover` was
cancelled. Drags without files are untouched.

Because `defaultPrevented` is only final at the end of propagation, the guard registers a
`window` capture listener at `document_start`, attaches one-shot observers along
`Event.composedPath()`, and takes the verdict at the last node the event reaches. The page
is only observed — never hijacked — and the guard never calls `stopPropagation()`.

## Install, build and test

```sh
pnpm install
pnpm run build       # -> dist/ (loadable temporary add-on)
pnpm run check       # typecheck (src + tests), build, jsdom tests — no browser needed
pnpm run check:full  # the above, then the real-Gecko check (needs Firefox)
pnpm run clean       # remove dist/, .test-build/, web-ext-artifacts/
```

`pnpm run clean -- --dry-run` lists instead of deleting; `--all` also removes
`node_modules/`. Nothing outside those fixed names is touched.

Temporary install: run `pnpm run build`, open `about:debugging#/runtime/this-firefox`,
**Load Temporary Add-on…**, pick `dist/manifest.json`. Drop a file on an empty area (no
navigation), on an `<input type="file">` and on a dropzone (file received).

`pnpm start` serves the manual playground in `dev/` and opens Firefox with the add-on
installed; `pnpm start:check` does the setup only. The playground has nine zones, each
stating its own pass criterion. `about:`, the PDF viewer, reader view and other privileged
pages are deliberately not covered; iframes are (`all_frames`).

The jsdom suite imports the shipping sources; `test/dispatch.test.ts` pins the DOM
semantics the guard relies on, and the other files cover the policy, propagation corner
cases, shadow DOM, manifest invariants and the built artifact. `pnpm run test:gecko`
repeats the browser-specific checks in real Firefox through `web-ext run` (headless by
default, `-- --headed` to watch).

## Package, lint and sign

```sh
pnpm run lint                        # = web-ext lint --source-dir dist
pnpm run sign                        # unlisted build (self-distribution)
pnpm run sign -- --channel=listed    # submit for an AMO listing
pnpm run sign -- --check             # pre-flight only: no upload, no network
pnpm web-ext build                   # -> web-ext-artifacts/safe_file_drag-<version>.zip
```

`.web-ext-config.mjs` points every bare `web-ext` command at `dist/`; CLI flags still win,
so `--source-dir .` remains available. **Sign `dist/`, never the repository root**: the
root's `content.js` only exists after a build, and `dev/` plus `test/` add unrelated pages,
which AMO reports as `MANIFEST_CONTENT_SCRIPT_FILE_NOT_FOUND` and `INLINE_SCRIPT`. The
build and `pnpm run sign` both verify every manifest path inside the package, and `sign`
refuses to upload without credentials.

Credentials are never committed: use `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` in the
environment, a `.env` file next to `package.json`, or `--api-key=` / `--api-secret=`; create
them at <https://addons.mozilla.org/developers/addon/api/key/>. Signed output lands in
`web-ext-artifacts/` (git-ignored).

The bundle is deliberately not minified: it is small, security-sensitive and meant to be
read by whoever installs or reviews it.

### First listed submission

Unlisted signing needs only credentials. A listed version is refused until AMO has licence
metadata, which a manifest cannot carry (`400 {"version": {"license": [...]}}`). Submit
the first listed version through the web UI once:

1. `pnpm web-ext build`, then open <https://addons.mozilla.org/developers/addons/>. If the
   failed API attempts already created `safe-file-drag@qzlin.github.io`, upload from that
   add-on's page; a second add-on with the same id is refused.
2. Otherwise <https://addons.mozilla.org/developers/addon/submit/> → *On this site* →
   upload the `.zip` → name, summary, categories → licence → review notes → submit. The
   first version is reviewed (`nominated`) before it is published.

Later versions inherit the licence, so `pnpm run sign -- --channel=listed` works from then
on.

AMO's licence list has no `GPL-3.0-or-later` (only `GPL-3.0-only` and friends), so choose
**Custom License** and paste name `GNU General Public License v3.0 or later` with:

```text
Copyright (C) 2026 QZLin

This program is free software: you can redistribute it and/or modify it under the terms
of the GNU General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

The full text is at https://github.com/QZLin/SafeFileDrag/blob/main/LICENSE
```

Notes to reviewer:

```text
No permissions, no background script, no network access, no remote code, no eval.
The content script runs in the page's own world at document_start; it observes drag/drop
and only calls preventDefault() on a file drop no page handler consumed, so an accidental
drop cannot navigate the tab away. <input type="file"> targets are detected through the
composed path and left alone, so real uploads keep working. Source is unminified in the
package; repository: https://github.com/QZLin/SafeFileDrag (GPL-3.0-or-later).
```

### Two accepted lint warnings

`data_collection_permissions` is understood from Firefox 140 / Android 142, while
`strict_min_version` is 128.0 (the first release with `world: "MAIN"`). Older versions
ignore the key, AMO requires it, so the two warnings are accepted; raising the minimum
would silence them but block Firefox 128–139 for no functional gain.

## Design notes and limitations

* **Firefox-only.** The mechanism depends on Firefox behaviour: unconsumed file drops
  navigating, `DataTransfer.types` reporting `Files` / `application/x-moz-file`, and
  `cancelBubble` staying readable by same-node listeners. Not tested against Chrome.
* **MAIN world is required and is a real risk.** The verdict needs the page's own event
  state, so the page can detect or fight the script. Native references are captured at
  `document_start`, but the risk cannot be eliminated.
* **The cursor may show "copy" over non-dropzones.** `dropEffect` is deliberately not set
  to `"none"`, which could suppress the `drop` the page is waiting for.
* **Text-like targets block file drags.** Only enabled `<input type="file">` gets the
  native exemption; drops into `contenteditable`, `textarea` or text inputs are cancelled.
  Editors that accept files handle `drop` themselves and pass the `defaultPrevented` check.
* **Small blast radius.** Only `preventDefault()` is used: no propagation stopping, no
  payload rewriting, no re-dispatch.
* **Known limits:** `stopImmediatePropagation()` without `preventDefault()` (or
  `stopPropagation()` from a `window` capture listener) defeats the guard; closed shadow
  roots are seen only through retargeting, so a nested file input is blocked (fail-safe —
  open roots work); an unreadable `DataTransfer` is treated like a text drag; non-file
  drags are out of scope.

## Layout

* `src/guard.ts` — the whole policy, DOM-free via `GuardEnv`.
* `src/content.ts` — Firefox adapter: captures native DOM references at `document_start`.
* `manifest.json`, `.web-ext-config.mjs` — MV3 manifest and web-ext defaults (`dist/`).
* `scripts/` — build, clean, test, Gecko check, sign and the dev launcher.
* `test/` — jsdom suite; `test/gecko/` — probe page for the real-browser check.
* `dev/` — manual playground; `icon/` — icon sources (`scripts/resize.sh` regenerates).
* `dist/` — generated, loadable add-on.

## License

Copyright (C) 2026 QZLin. GPL-3.0-or-later; the full text is [LICENSE](LICENSE) and is
copied into `dist/`. The add-on id is `safe-file-drag@qzlin.github.io`, pinned by a test.
