/**
 * Manifest invariants.
 *
 * The extension's promise is a small, auditable surface: no background script, no
 * storage, no network permission, no remote code, and a MAIN-world content script at
 * `document_start` in every frame. A manifest regression (a stray permission, an
 * accidental `world` change, a version bump that bypasses `package.json`) is exactly
 * the kind of thing that is easy to miss by eye, so it is asserted here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const licenseUrl = new URL('../LICENSE', import.meta.url);
const manifestText = readFileSync(manifestUrl, 'utf8');
const manifest = JSON.parse(manifestText);
const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'));

test('declares Manifest V3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('points at the repository the code actually lives in', () => {
  // `web-ext sign` shows this on the AMO listing, so a stale URL is user-visible.
  const fromPackage = pkg.repository.url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  assert.equal(manifest.homepage_url, fromPackage);
  assert.equal(manifest.developer?.url, 'https://github.com/QZLin');
  assert.equal(typeof manifest.developer?.name, 'string');
});

test('ships the licence it claims', () => {
  assert.equal(pkg.license, 'GPL-3.0-or-later');
  const licence = readFileSync(licenseUrl, 'utf8');
  assert.match(licence, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(licence, /Version 3, 29 June 2007/);
});

test('names icons that actually exist', () => {
  // A broken icon path is a warning-free runtime failure (a blank toolbar tile) and a
  // hard AMO rejection in the worst case; the build checks the package, this checks the
  // source before a build is even attempted.
  const icons = manifest.icons;
  assert.equal(typeof icons, 'object');
  assert.ok(Object.keys(icons).length > 0, 'at least one icon');
  for (const [size, path] of Object.entries(icons as Record<string, string>)) {
    assert.match(size, /^\d+$/, `icon size must be numeric: "${size}"`);
    assert.match(path, /^icon\/logo_\d+\.png$/, `unexpected icon path: "${path}"`);
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `missing icon: ${path}`);
  }
  // 48 is the toolbar/listing icon and 128 the store tile: Firefox and AMO both want them.
  assert.ok('48' in icons, 'icons["48"]');
  assert.ok('128' in icons, 'icons["128"]');
});

test('requests no privileged surface at all', () => {
  const forbidden = [
    'background',
    'permissions',
    'optional_permissions',
    'host_permissions',
    'storage',
    'options_ui',
    'options_page',
    'action',
    'browser_action',
    'page_action',
    'sidebar_action',
    'devtools_page',
    'web_accessible_resources',
    'externally_connectable',
    'declarative_net_request',
    'content_security_policy',
    'user_scripts',
  ];
  for (const key of forbidden) {
    assert.equal(key in manifest, false, `manifest must not declare "${key}"`);
  }
});

test('runs in the page world, in every frame, before page scripts', () => {
  const scripts = manifest.content_scripts;
  assert.equal(Array.isArray(scripts), true);
  assert.equal(scripts.length, 1, 'exactly one content script entry');

  const script = scripts[0];
  assert.deepEqual(script.matches, ['<all_urls>']);
  assert.deepEqual(script.js, ['content.js']);
  assert.equal(script.run_at, 'document_start');
  assert.equal(script.world, 'MAIN');
  assert.equal(script.all_frames, true);
  assert.equal(script.match_about_blank, false);
});

test('declares the add-on id, the Firefox floor and no data collection', () => {
  const gecko = manifest.browser_specific_settings?.gecko;
  assert.equal(typeof gecko, 'object');
  // The id is the add-on's identity on AMO: changing it produces a *different* add-on,
  // so this assertion is a tripwire rather than a formality.
  assert.equal(gecko.id, 'safe-file-drag@qzlin.github.io');
  assert.equal(gecko.strict_min_version, '128.0');
  assert.deepEqual(gecko.data_collection_permissions, { required: ['none'] });
});

test('loads no remote code and no eval', () => {
  // URLs are allowed as *metadata* (`homepage_url`, `developer.url`) — and the only ones
  // present must be the project's own, so a stray CDN or analytics host cannot slip in.
  for (const entry of manifest.content_scripts ?? []) {
    for (const path of entry.js ?? []) {
      assert.equal(/^https?:/i.test(path), false, `remote script: ${path}`);
    }
  }
  for (const url of manifestText.match(/https?:\/\/[^"]+/g) ?? []) {
    assert.match(url, /^https:\/\/github\.com\/QZLin(\/|$)/, `unexpected URL: ${url}`);
  }
  assert.equal(/\beval\b/.test(manifestText), false);
  assert.equal(/new\s+Function/.test(manifestText), false);
});

test('the version matches package.json', () => {
  assert.equal(manifest.version, pkg.version);
});
