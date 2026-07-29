import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'bin', 'ccd.js');

// 実際に切り替えが走らないよう launcher を none に固定し、HOME も一時ディレクトリにする。
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-hook-'));
  for (const dir of ['.claude', '.claude-a', '.claude-b']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    // ログイン済みとみなされるよう、macOS 以外の認証情報ファイルを置く。
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}');
  }
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
  };
  delete env.CLAUDE_CONFIG_DIR;
  run(['config', 'set', 'autoSwitch.mode', 'auto'], env);
  run(['config', 'set', 'autoSwitch.launcher', 'none'], env);
  return { home, env };
}

function run(args, env, input) {
  return execFileSync(process.execPath, [cli, ...args], {
    env,
    encoding: 'utf8',
    input: input ?? '',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function fire(env, payload) {
  return run(['hook', 'rate-limit'], env, JSON.stringify(payload));
}

function switchCount(env) {
  const file = path.join(env.XDG_STATE_HOME, 'ccd', 'state.json');
  if (!fs.existsSync(file)) return 0;
  return (JSON.parse(fs.readFileSync(file, 'utf8')).switches || []).length;
}

const base = { hook_event_name: 'StopFailure', error: 'rate_limit', cwd: '/tmp' };

test('a real rate limit triggers a switch', (t) => {
  if (process.platform === 'darwin') return t.skip('login state comes from the keychain on macOS');
  const { env } = setup();
  fire(env, { ...base, session_id: 'A', last_assistant_message: '5-hour limit reached' });
  assert.equal(switchCount(env), 1);
});

test('a rate limit absorbed by a model fallback does not trigger a switch', (t) => {
  if (process.platform === 'darwin') return t.skip('login state comes from the keychain on macOS');
  // 応答が続いているのに切り替えるとペインが無駄に増える。
  const { env } = setup();
  const out = fire(env, { ...base, session_id: 'B', last_assistant_message: 'No response requested.' });
  assert.equal(out.trim(), '');
  assert.equal(switchCount(env), 0);
});

test('non rate-limit stop failures are ignored', (t) => {
  if (process.platform === 'darwin') return t.skip('login state comes from the keychain on macOS');
  // overloaded や server_error は容量側の問題で、別アカウントでも同じように失敗する。
  const { env } = setup();
  for (const error of ['overloaded', 'server_error', 'invalid_request']) {
    const out = fire(env, { ...base, error, session_id: `S-${error}` });
    assert.equal(out.trim(), '');
  }
  assert.equal(switchCount(env), 0);
});

test('the hook exits 0 even when the payload is malformed', () => {
  const { env } = setup();
  const out = run(['hook', 'rate-limit'], env, 'not json');
  assert.equal(typeof out, 'string');
});
