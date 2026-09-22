/**
 * No document in this repo may cite a transaction by a truncated id -- the README and the
 * explainer page both did (genesis and claim, 8 chars each) until 2026-09-22, and by then the runs
 * they named no longer resolved on the public index. Copied from quorum, after kaspanet/kccs#29.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { truncatedIds } from './pinned.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => /\.(md|html)$/.test(f)).map((f) => join('docs', f))];

test('a prefix plus an ellipsis is caught; a whole id and ordinary prose are not', () => {
  const full = 'a'.repeat(64);
  assert.deepEqual(truncatedIds('tx `81c3008f1fe5d79508105ada...` landed'), [{ line: 1, text: '81c3008f1fe5d79508105ada...' }]);
  assert.deepEqual(truncatedIds(`tx ${full} landed`), []);
  assert.deepEqual(truncatedIds('and so on... the deed 0xdeadbeef and 12345678 cost'), []);
  assert.equal(truncatedIds('one\ntwo deadbeefcafe…\nthree')[0]?.line, 2);
});

test('no document or page cites a transaction by a truncated id', () => {
  const found = docs.flatMap((d) => truncatedIds(readFileSync(join(root, d), 'utf8')).map((t) => `${d}:${t.line} ${t.text}`));
  assert.deepEqual(found, [], `truncated ids in docs:\n  ${found.join('\n  ')}`);
});
