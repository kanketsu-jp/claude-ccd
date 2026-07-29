import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPaneId } from '../src/launcher.js';

test('extractPaneId reads the pane id out of the herdr response envelope', () => {
  const stdout = JSON.stringify({
    id: 'cli:pane:split',
    result: { type: 'pane_info', pane: { pane_id: 'w1:p2', tab_id: 'w1:t1' } },
  });
  assert.equal(extractPaneId(stdout), 'w1:p2');
});

test('extractPaneId never falls back to the request id', () => {
  // トップレベルの `id` はリクエスト識別子であってペイン ID ではない。
  // ここを掴むと存在しないペインへコマンドを送ってしまう。
  const stdout = JSON.stringify({ id: 'cli:pane:split', result: { type: 'pane_info' } });
  assert.equal(extractPaneId(stdout), null);
});

test('extractPaneId supports tab/workspace responses that nest root_pane', () => {
  const stdout = JSON.stringify({
    id: 'cli:tab:create',
    result: { type: 'tab_created', root_pane: { pane_id: 'w3:p9' } },
  });
  assert.equal(extractPaneId(stdout), 'w3:p9');
});

test('extractPaneId tolerates malformed output', () => {
  assert.equal(extractPaneId(''), null);
  assert.equal(extractPaneId('not json'), null);
  assert.equal(extractPaneId('{}'), null);
});
