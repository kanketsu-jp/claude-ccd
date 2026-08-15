import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'bin', 'ccd.js');

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-switch-all-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-work'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(home, '.claude-work', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.invalid' } }));
  const log = path.join(root, 'calls.log');
  writeExecutable(path.join(bin, 'herdr'), `#!/bin/sh
printf '%s\\n' "herdr $*" >> "$CALL_LOG"
if [ "$1 $2" = "pane list" ]; then
  printf '%s\\n' '{"result":{"panes":[{"pane_id":"self"},{"pane_id":"other"}]}}'
  exit 0
fi
if [ "$1 $2 $3" = "pane process-info --pane" ]; then
  /bin/cat "$PROCESS_INFO_DIR/$4.json"
  exit 0
fi
exit 0
`);
  writeExecutable(path.join(bin, 'ps'), `#!/bin/sh
/bin/cat "$PS_OUT"
`);
  const processInfoDir = path.join(root, 'process-info');
  fs.mkdirSync(processInfoDir);
  return { root, home, bin, log, psOut: path.join(root, 'ps.txt'), processInfoDir };
}

function writeProcessInfo(fixture, paneId, info) {
  fs.writeFileSync(path.join(fixture.processInfoDir, `${paneId}.json`), JSON.stringify({ result: { process_info: info } }));
}

function runCli(args, fixture, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: fixture.home,
    XDG_CONFIG_HOME: path.join(fixture.home, '.config'),
    XDG_STATE_HOME: path.join(fixture.home, '.state'),
    CCD_SKIP_KEYCHAIN_CHECK: '1',
    PATH: fixture.bin,
    CALL_LOG: fixture.log,
    PS_OUT: fixture.psOut,
    PROCESS_INFO_DIR: fixture.processInfoDir,
    HERDR_PANE_ID: 'self',
    ...extraEnv,
  };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
}

test('switch-all --dry-run reports target sessions without running pane commands', () => {
  const fixture = setup();
  fs.writeFileSync(fixture.psOut, '');
  writeProcessInfo(fixture, 'self', {
    shell_pid: 101,
    foreground_processes: [{ pid: 301, name: 'claude', argv: ['claude', '--resume', '11111111-1111-4111-8111-111111111111'] }],
  });
  writeProcessInfo(fixture, 'other', {
    shell_pid: 201,
    foreground_processes: [{ pid: 302, name: 'claude', argv: ['claude', '--resume', '22222222-2222-4222-8222-222222222222'] }],
  });

  const result = runCli(['switch-all', 'work', '--dry-run'], fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /other/);
  assert.match(result.stdout, /pid 302/);
  assert.match(result.stdout, /22222222-2222-4222-8222-222222222222/);
  assert.doesNotMatch(result.stdout, /pane other pid 301/);
  assert.doesNotMatch(fs.readFileSync(fixture.log, 'utf8'), /pane run/);
});

test('switch-all skips its own HERDR_PANE_ID by default', () => {
  const fixture = setup();
  fs.writeFileSync(fixture.psOut, '');
  writeProcessInfo(fixture, 'self', {
    shell_pid: 101,
    foreground_processes: [{ pid: 301, name: 'claude', argv: ['claude', '--resume', '11111111-1111-4111-8111-111111111111'] }],
  });
  writeProcessInfo(fixture, 'other', {
    shell_pid: 201,
    foreground_processes: [{ pid: 302, name: 'claude', argv: ['claude', '--resume', '22222222-2222-4222-8222-222222222222'] }],
  });

  const result = runCli(['switch-all', 'work', '--dry-run'], fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip self/);
  assert.doesNotMatch(result.stdout, /pane self/);
});

test('switch-all assigns distinct pid and sid per herdr pane', () => {
  const fixture = setup();
  fs.writeFileSync(fixture.psOut, '');
  writeProcessInfo(fixture, 'self', {
    shell_pid: 101,
    foreground_processes: [{ pid: 301, name: 'claude', argv: ['claude', '--resume', '11111111-1111-4111-8111-111111111111'] }],
  });
  writeProcessInfo(fixture, 'other', {
    shell_pid: 201,
    foreground_processes: [{ pid: 302, name: 'claude', argv: ['claude', '--resume', '22222222-2222-4222-8222-222222222222'] }],
  });

  const result = runCli(['switch-all', 'work', '--dry-run', '--include-self'], fixture);

  assert.equal(result.status, 0, result.stderr);
  const planned = result.stdout.split('\n').filter((line) => line.startsWith('dry-run pane '));
  assert.equal(planned.length, 2);
  const pids = planned.map((line) => line.match(/ pid (\d+) /)?.[1]);
  const sids = planned.map((line) => line.match(/ resume ([0-9a-f-]{36}) /)?.[1]);
  assert.deepEqual(pids, ['301', '302']);
  assert.equal(new Set(pids).size, 2);
  assert.equal(new Set(sids).size, 2);
});

test('switch-all skips panes without a process or resume session', () => {
  const fixture = setup();
  fs.writeFileSync(fixture.psOut, '');
  writeProcessInfo(fixture, 'self', {
    shell_pid: 101,
    foreground_processes: [],
  });
  writeProcessInfo(fixture, 'other', {
    shell_pid: 201,
    foreground_processes: [{ pid: 302, name: 'claude', argv: ['claude'] }],
  });

  const result = runCli(['switch-all', 'work', '--dry-run', '--include-self'], fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip pane self: no claude process/);
  assert.match(result.stdout, /skip pane other pid 302: no resume session/);
  assert.doesNotMatch(result.stdout, /^dry-run pane /m);
});

test('switch-all does not match unrelated node processes whose cmdline contains claude', () => {
  const fixture = setup();
  fs.writeFileSync(fixture.psOut, ` 900  201 node /Users/horiikekazuma/Develop/Projects/kk2/line-claude-channel/server.mjs --resume 33333333-3333-4333-8333-333333333333
`);
  writeProcessInfo(fixture, 'self', {
    shell_pid: 101,
    foreground_processes: [{ pid: 301, name: 'claude', argv: ['claude', '--resume', '11111111-1111-4111-8111-111111111111'] }],
  });
  writeProcessInfo(fixture, 'other', {
    shell_pid: 201,
    foreground_processes: [{ pid: 900, name: 'node', argv: ['node', '/Users/horiikekazuma/Develop/Projects/kk2/line-claude-channel/server.mjs', '--resume', '33333333-3333-4333-8333-333333333333'] }],
  });

  const result = runCli(['switch-all', 'work', '--dry-run', '--include-self'], fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run pane self pid 301/);
  assert.match(result.stdout, /skip pane other: no claude process/);
  assert.doesNotMatch(result.stdout, /33333333-3333-4333-8333-333333333333/);
});
