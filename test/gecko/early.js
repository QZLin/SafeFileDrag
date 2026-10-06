  /*
   * Runs as early as a page script can run. The content script is injected at
   * `document_start` — before this — and in the page's own world (`world: "MAIN"`), so
   * both observations below are only possible if the injection really happened that way:
   * the install marker lives on the page's `window`, and a MAIN-world script gets no
   * WebExtension APIs.
   */
  window.__safeFileDragProbe = {
    markerAtDocumentStart: Boolean(window[Symbol.for('safe-file-drag/installed/v1')]),
    hasWebExtensionApis: typeof browser !== 'undefined' || typeof chrome !== 'undefined',
  };
