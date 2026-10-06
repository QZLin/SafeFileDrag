/**
 * web-ext configuration, read by every `web-ext` command run from this directory.
 *
 * The trap this closes: the repository root contains the *source* manifest, whose
 * `content.js` only exists after a build, so `web-ext sign` (or `build`, or `lint`) with
 * no arguments used to package the source tree. AMO rejected that with
 * `MANIFEST_CONTENT_SCRIPT_FILE_NOT_FOUND`, and it also dragged `dev/` and `test/` into
 * the package, producing INLINE_SCRIPT warnings for pages that are not part of the add-on.
 *
 * With `sourceDir` set here, the bare command and the explicit one do the same thing:
 *
 *   pnpm web-ext sign --channel listed        ==  pnpm web-ext sign --source-dir dist ...
 *
 * CLI flags still win over this file, so `--source-dir .` remains available deliberately.
 * `pnpm run sign` (scripts/sign.mjs) additionally checks the package against the manifest
 * and refuses to upload without credentials; it passes `--source-dir dist` explicitly.
 */
export default {
  sourceDir: 'dist',
  artifactsDir: 'web-ext-artifacts',
};
