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
import { readFileSync } from 'node:fs';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const manifestText = readFileSync(manifestUrl, 'utf8');
const manifest = JSON.parse(manifestText);
const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'));

test('declares Manifest V3', () => {
  assert.equal(manifest.manifest_version, 3);
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

test('declares the Firefox floor that has MAIN-world content scripts', () => {
  const gecko = manifest.browser_specific_settings?.gecko;
  assert.equal(typeof gecko, 'object');
  assert.equal(gecko.id, 'safe-file-drag@local.invalid');
  assert.equal(gecko.strict_min_version, '128.0');
  assert.deepEqual(gecko.data_collection_permissions, { required: ['none'] });
});

test('contains no remote code, no eval and no URL', () => {
  assert.equal(/https?:\/\//.test(manifestText), false, 'no remote references');
  assert.equal(/\beval\b/.test(manifestText), false);
  assert.equal(/new\s+Function/.test(manifestText), false);
});

test('the version matches package.json', () => {
  assert.equal(manifest.version, pkg.version);
});
