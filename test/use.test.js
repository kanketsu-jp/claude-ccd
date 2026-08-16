import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'bin', 'ccd.js');

// ユーザーのホームを汚さないよう、HOME を一時ディレクトリに差し替えて CLI を叩く。
function runCli(args, home, options = {}) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
  };
  delete env.CLAUDE_CONFIG_DIR;
  try {
    return {
      stdout: execFileSync(process.execPath, [cli, ...args], { env, cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      status: 0,
    };
  } catch (error) {
    return { stdout: error.stdout || '', status: error.status ?? 1 };
  }
}

function makeHome() {
  // macOS の $TMPDIR は symlink なので、cwd 比較のために実パスへ揃える。
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-test-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-work'), { recursive: true });
  return home;
}

// default アカウント側に、指定 cwd の会話履歴を 1 本作る。
function seedHistory(home, cwd, name = 'session-a.jsonl') {
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ type: 'user', cwd }) + '\n');
  return dir;
}

function makeWorkdir(home) {
  const cwd = path.join(home, 'work-proj');
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

test('use emits an export for a named account when --shell is absent', () => {
  // --shell 省略時に引数の添字 0 を捨てて default に落ちる回帰を防ぐ。
  const home = makeHome();
  const { stdout, status } = runCli(['use', 'work'], home);
  assert.equal(status, 0);
  assert.match(stdout, /^export CLAUDE_CONFIG_DIR='.*\.claude-work'$/m);
  assert.doesNotMatch(stdout, /unset/);
});

test('use unsets the variable for the default account', () => {
  const home = makeHome();
  const { stdout } = runCli(['use', 'default'], home);
  assert.match(stdout, /^unset CLAUDE_CONFIG_DIR$/m);
});

test('use emits fish syntax on request', () => {
  const home = makeHome();
  const { stdout } = runCli(['use', 'work', '--shell', 'fish'], home);
  assert.match(stdout, /^set -gx CLAUDE_CONFIG_DIR '.*\.claude-work'$/m);
});

test('use writes nothing to stdout when the account cannot be resolved', () => {
  // stdout はシェルが eval するため、失敗時に何か出すと壊れたコードを実行してしまう。
  const home = makeHome();
  const { stdout, status } = runCli(['use', 'no-such-account'], home);
  assert.equal(status, 1);
  assert.equal(stdout.trim(), '');
});

test('use requires an argument', () => {
  const home = makeHome();
  const { stdout, status } = runCli(['use'], home);
  assert.equal(status, 1);
  assert.equal(stdout.trim(), '');
});

test('use copies the current directory history into the target account', () => {
  const home = makeHome();
  const cwd = makeWorkdir(home);
  seedHistory(home, cwd);
  const { stdout, status } = runCli(['use', 'work'], home, { cwd });
  assert.equal(status, 0);
  // stdout はシェルが eval するので、コピーの報告が混ざってはいけない。
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.match(stdout, /^export CLAUDE_CONFIG_DIR='.*\.claude-work'$/m);
  const copied = path.join(home, '.claude-work', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'session-a.jsonl');
  assert.ok(fs.existsSync(copied), `expected ${copied} to exist`);
});

test('use --no-sessions skips the history copy', () => {
  const home = makeHome();
  const cwd = makeWorkdir(home);
  seedHistory(home, cwd);
  const { status } = runCli(['use', 'work', '--no-sessions'], home, { cwd });
  assert.equal(status, 0);
  assert.equal(fs.existsSync(path.join(home, '.claude-work', 'projects')), false);
});

test('use ignores history from other directories', () => {
  const home = makeHome();
  const cwd = makeWorkdir(home);
  seedHistory(home, path.join(home, 'another-proj'));
  const { status } = runCli(['use', 'work'], home, { cwd });
  assert.equal(status, 0);
  assert.equal(fs.existsSync(path.join(home, '.claude-work', 'projects')), false);
});

test('use still resolves the account name when --sessions takes a value', () => {
  // --sessions の値をアカウント名と取り違えると default に落ちる。
  const home = makeHome();
  const { stdout } = runCli(['use', '--sessions', '3', 'work'], home);
  assert.match(stdout, /^export CLAUDE_CONFIG_DIR='.*\.claude-work'$/m);
});
