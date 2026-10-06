/**
 * Unit tests for `isFileDrag()`: the one piece of the guard that decides whether the
 * extension has any business in an event at all.
 *
 * Being wrong here is expensive in both directions. A false negative lets a dropped
 * file navigate the tab (the bug this extension exists for); a false positive means
 * blocking text, link or image drags that the user never asked us to touch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isFileDrag, type DataTransferLike } from '../src/guard.js';
import { fileDragPayload, filesTypeOnlyPayload, textDragPayload } from './support/dom.js';

function dt(partial: Partial<DataTransferLike>): DataTransferLike {
  return partial;
}

function throwingDataTransfer(properties: readonly string[]): DataTransferLike {
  const target: Record<string, unknown> = {};
  for (const property of properties) {
    Object.defineProperty(target, property, {
      get() {
        throw new Error(`DataTransfer.${property} is not readable here`);
      },
    });
  }
  return target as DataTransferLike;
}

test('accepts the payload Firefox produces for a real file drag', () => {
  assert.equal(isFileDrag(fileDragPayload()), true);
});

test('accepts a dragover payload whose files are still empty', () => {
  // Firefox only fills `files` once the drop happens; `types` carries the evidence
  // during dragover, which is where the guard has to make up its mind.
  assert.equal(isFileDrag(filesTypeOnlyPayload()), true);
});

test('accepts an item of kind "file" even without files or types', () => {
  assert.equal(isFileDrag(dt({ items: [{ kind: 'file' }] })), true);
});

test('accepts a populated files list even without items or types', () => {
  assert.equal(isFileDrag(dt({ files: [{ name: 'a.pdf' }] })), true);
});

test('accepts the historical application/x-moz-file type token', () => {
  assert.equal(isFileDrag(dt({ types: ['application/x-moz-file'] })), true);
});

test('rejects a plain text drag', () => {
  assert.equal(isFileDrag(textDragPayload()), false);
});

test('rejects a link or HTML drag', () => {
  assert.equal(isFileDrag(dt({ items: [{ kind: 'string' }], types: ['text/uri-list', 'text/html'] })), false);
});

test('rejects an empty or missing DataTransfer', () => {
  assert.equal(isFileDrag(null), false);
  assert.equal(isFileDrag(undefined), false);
  assert.equal(isFileDrag(dt({})), false);
  assert.equal(isFileDrag(dt({ items: [], files: [], types: [] })), false);
});

test('rejects an items list with null or string-kind entries', () => {
  assert.equal(isFileDrag(dt({ items: [null, { kind: 'string' }] })), false);
  assert.equal(isFileDrag(dt({ items: [{}] })), false);
});

test('falls back to files when items throws', () => {
  const transfer = throwingDataTransfer(['items']);
  Object.defineProperty(transfer, 'files', { value: [{ name: 'a.pdf' }] });
  assert.equal(isFileDrag(transfer), true);
});

test('falls back to types when items and files throw', () => {
  const transfer = throwingDataTransfer(['items', 'files']);
  Object.defineProperty(transfer, 'types', { value: ['Files'] });
  assert.equal(isFileDrag(transfer), true);
});

test('reports "not a file drag" when nothing can be read at all', () => {
  assert.equal(isFileDrag(throwingDataTransfer(['items', 'files', 'types'])), false);
});

test('tolerates nonsense lengths instead of reading past the end', () => {
  assert.equal(isFileDrag(dt({ files: { length: -1 } })), false);
  assert.equal(isFileDrag(dt({ files: { length: Number.NaN } })), false);
  assert.equal(isFileDrag(dt({ items: { length: 0 } })), false);
  const notArrayLike = { files: new Set(['a']) } as unknown as DataTransferLike;
  assert.equal(isFileDrag(notArrayLike), false);
});

test('matches the file type tokens exactly', () => {
  assert.equal(isFileDrag(dt({ types: ['files'] })), false);
  assert.equal(isFileDrag(dt({ types: ['Files', 'text/plain'] })), true);
});
