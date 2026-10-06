/**
 * "Is everything the manifest promises actually in the package?"
 *
 * `web-ext sign` asks AMO this question for you — after uploading — and reports it as
 * `MANIFEST_CONTENT_SCRIPT_FILE_NOT_FOUND`. That is a slow, confusing way to learn that a
 * path is wrong, or that the directory being signed is not the built one. The same check
 * costs nothing locally, so the build runs it on every build and `scripts/sign.mjs` runs
 * it again before anything is uploaded.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Every manifest path that has to exist inside the package, with where it came from. */
function referencedFiles(manifest) {
  const files = [];
  const add = (path, from) => {
    // Globs (allowed in `web_accessible_resources`) cannot be checked by existence.
    if (typeof path === 'string' && !path.includes('*')) files.push({ path, from });
  };

  for (const [index, entry] of (manifest.content_scripts ?? []).entries()) {
    for (const path of entry.js ?? []) add(path, `content_scripts[${index}].js`);
    for (const path of entry.css ?? []) add(path, `content_scripts[${index}].css`);
  }
  for (const [size, path] of Object.entries(manifest.icons ?? {})) add(path, `icons["${size}"]`);

  add(manifest.action?.default_popup, 'action.default_popup');
  add(manifest.browser_action?.default_popup, 'browser_action.default_popup');
  add(manifest.page_action?.default_popup, 'page_action.default_popup');
  add(manifest.options_ui?.page, 'options_ui.page');
  add(manifest.options_page, 'options_page');
  add(manifest.devtools_page, 'devtools_page');
  add(manifest.sidebar_action?.default_panel, 'sidebar_action.default_panel');
  add(manifest.background?.service_worker, 'background.service_worker');
  for (const path of manifest.background?.scripts ?? []) add(path, 'background.scripts');

  // Manifest V3: [{ resources: [...], matches: [...] }]; V2: a flat list of paths.
  for (const entry of manifest.web_accessible_resources ?? []) {
    if (typeof entry === 'string') add(entry, 'web_accessible_resources');
    else for (const path of entry.resources ?? []) add(path, 'web_accessible_resources[].resources');
  }

  return files;
}

/**
 * @param {object} options
 * @param {string} options.distDir    the package directory (what will be uploaded)
 * @param {string} options.manifestPath  the manifest *inside* that directory
 * @returns {Promise<{ manifest: any, problems: string[] }>}
 */
export async function verifyPackage({ distDir, manifestPath }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const problems = [];

  for (const { path, from } of referencedFiles(manifest)) {
    try {
      await stat(join(distDir, path));
    } catch {
      problems.push(`${from} refers to "${path}", which is not in ${distDir}`);
    }
  }

  return { manifest, problems };
}
