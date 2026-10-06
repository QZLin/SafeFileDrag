/*
 * Manual playground behaviour for dev/index.html.
 *
 * Kept in its own file rather than inline: `web-ext lint` walks the whole repository and
 * reports INLINE_SCRIPT for every inline script it finds, which drowns out the warnings
 * that actually matter for the packaged add-on. It is also what a page served with the
 * default CSP would need.
 */
(function () {
  'use strict';

  var logEl = document.getElementById('log');
  var here = document.getElementById('here');
  here.textContent = location.href;

  function log(message) {
    var t = (performance.now() / 1000).toFixed(2);
    logEl.textContent += '[' + t + 's] ' + message + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function fileNames(dataTransfer) {
    if (!dataTransfer) return '(no dataTransfer)';
    var names = [];
    if (dataTransfer.files) {
      for (var i = 0; i < dataTransfer.files.length; i++) names.push(dataTransfer.files[i].name);
    }
    return names.length ? names.join(', ') : '(no files)';
  }

  document.getElementById('clear').addEventListener('click', function () {
    logEl.textContent = '';
  });

  // --- diagnostics only: never calls preventDefault(), so the extension's verdict
  // --- is unaffected. Runs on `window` in the bubble phase, i.e. after the page's
  // --- own handlers, so it shows what the page made of the event.
  var lastOverTarget = null;
  ['dragenter', 'dragover', 'drop'].forEach(function (type) {
    window.addEventListener(type, function (event) {
      var target = event.target;
      var id = (target && (target.id || target.tagName)) || '?';
      if (type === 'dragover') {
        if (id === lastOverTarget) return;
        lastOverTarget = id;
      }
      var types = event.dataTransfer ? Array.prototype.join.call(event.dataTransfer.types, ',') : '(none)';
      var deepest = event.composedPath ? event.composedPath()[0] : null;
      var deepestId = (deepest && (deepest.id || deepest.tagName)) || '?';
      log('window ' + type + ' on #' + id + ' — defaultPrevented=' + event.defaultPrevented + ' types=[' + types + '] composedPath[0]=#' + deepestId);
    });
  });

  // --- 2. native <input type="file"> -------------------------------------------
  var nativeInput = document.getElementById('native');
  nativeInput.addEventListener('change', function () {
    var names = Array.prototype.map.call(nativeInput.files, function (f) { return f.name; });
    document.getElementById('native-out').textContent = 'change: ' + (names.join(', ') || '(none)');
    log('input[type=file] change: ' + (names.join(', ') || '(none)'));
  });

  // --- 3. custom dropzone: dragover + drop, both preventDefault -----------------
  var dropzone = document.getElementById('dropzone');
  dropzone.addEventListener('dragover', function (event) {
    event.preventDefault();
    dropzone.classList.add('hot');
    log('dropzone dragover: preventDefault()');
  });
  dropzone.addEventListener('dragleave', function () {
    dropzone.classList.remove('hot');
  });
  dropzone.addEventListener('drop', function (event) {
    event.preventDefault();
    dropzone.classList.remove('hot');
    var names = fileNames(event.dataTransfer);
    document.getElementById('dropzone-out').textContent = 'drop: ' + names;
    log('dropzone drop: preventDefault() files=' + names);
  });

  // --- 4. drop-only dropzone: no dragover listener at all -----------------------
  var droponly = document.getElementById('droponly');
  droponly.addEventListener('drop', function (event) {
    event.preventDefault();
    var names = fileNames(event.dataTransfer);
    document.getElementById('droponly-out').textContent = 'drop: ' + names;
    log('droponly drop: preventDefault() files=' + names);
  });

  // --- 5. dragover-only: cancels dragover, has no drop handler -------------------
  var dragoveronly = document.getElementById('dragoveronly');
  dragoveronly.addEventListener('dragover', function (event) {
    event.preventDefault();
    document.getElementById('dragoveronly-out').textContent = 'dragover: preventDefault() (no drop handler)';
  });

  // --- 9. file input inside an open shadow root (web component shape) -----------
  var shadowRoot = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
  shadowRoot.innerHTML = '<style>input{font:inherit;width:100%}</style>'
    + '<input type="file" id="shadow-input" multiple>';
  var shadowInput = shadowRoot.getElementById('shadow-input');
  shadowInput.addEventListener('change', function () {
    var names = Array.prototype.map.call(shadowInput.files, function (f) { return f.name; });
    document.getElementById('shadow-out').textContent = 'change: ' + (names.join(', ') || '(none)');
    log('shadow input change: ' + (names.join(', ') || '(none)'));
  });

  log('page ready — drag a local file from the file manager onto the zones above');
})();
