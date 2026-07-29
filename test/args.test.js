import assert from 'node:assert/strict';
import test from 'node:test';
import { expandArgAliases } from '../src/util.js';

const config = { argAliases: { '-y': ['--dangerously-skip-permissions'], '-m': '--model' } };

test('expandArgAliases expands array and string replacements', () => {
  assert.deepEqual(expandArgAliases(['-y'], config), ['--dangerously-skip-permissions']);
  assert.deepEqual(expandArgAliases(['-m', 'opus'], config), ['--model', 'opus']);
});

test('expandArgAliases leaves unknown arguments untouched', () => {
  assert.deepEqual(expandArgAliases(['--resume', 'abc'], config), ['--resume', 'abc']);
});

test('expandArgAliases stops expanding after a bare --', () => {
  // `--` 以降は claude への素通し領域なので、短縮フラグと同名の文字列を書き換えてはいけない。
  assert.deepEqual(expandArgAliases(['-y', '--', '-y'], config), ['--dangerously-skip-permissions', '--', '-y']);
});

test('expandArgAliases is a no-op without a table', () => {
  assert.deepEqual(expandArgAliases(['-y'], {}), ['-y']);
});

test('expandArgAliases does not treat inherited Object keys as aliases', () => {
  assert.deepEqual(expandArgAliases(['toString', 'constructor'], config), ['toString', 'constructor']);
});
