import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

function setup({ paneMode = 'success', panes = ['other'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-usage-hook-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const processInfoDir = path.join(root, 'process-info');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(processInfoDir, { recursive: true });
  for (const dir of ['.claude', '.claude-work', '.claude-spare']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${dir.slice(1)}@example.invalid` } }));
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}');
  }

  const log = path.join(root, 'calls.log');
  const psOut = path.join(root, 'ps.txt');
  const paneJson = JSON.stringify({ result: { panes: panes.map((pane_id) => ({ pane_id })) } });
  writeExecutable(path.join(bin, 'herdr'), `#!/bin/sh
printf '%s\\n' "herdr $*" >> "$CALL_LOG"
if [ "$1 $2" = "pane list" ]; then
  printf '%s\\n' '${paneJson}'
  exit 0
fi
if [ "$1 $2 $3" = "pane process-info --pane" ]; then
  if [ -f "$PROCESS_INFO_DIR/$4.seq" ]; then
    n=$(/bin/cat "$PROCESS_INFO_DIR/$4.seq")
    next=$((n + 1))
    printf '%s' "$next" > "$PROCESS_INFO_DIR/$4.seq"
    if [ -f "$PROCESS_INFO_DIR/$4.$next.json" ]; then
      /bin/cat "$PROCESS_INFO_DIR/$4.$next.json"
      exit 0
    fi
  fi
  /bin/cat "$PROCESS_INFO_DIR/$4.json"
  exit 0
fi
exit 0
`);
  writeExecutable(path.join(bin, 'ps'), `#!/bin/sh
/bin/cat "$PS_OUT"
`);
  writeExecutable(path.join(bin, 'security'), '#!/bin/sh\nexit 0\n');

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
    PATH: bin,
    CALL_LOG: log,
    PS_OUT: psOut,
    PROCESS_INFO_DIR: processInfoDir,
    HERDR_PANE_ID: 'self',
    CCD_SWITCH_ALL_START_DELAY_MS: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;

  run(['config', 'set', 'autoSwitch.mode', 'auto'], env);
  run(['config', 'set', 'autoSwitch.order', '["work","spare"]'], env);
  fs.writeFileSync(psOut, '');

  const child = panes.length > 0 ? startReapedSleeper(root) : null;
  if (child) {
    if (paneMode === 'success') {
      writeProcessInfoSequence(processInfoDir, panes[0], [
        { shell_pid: 201, foreground_processes: [{ pid: child.pid, name: 'claude', argv: ['claude', '--resume', '22222222-2222-4222-8222-222222222222'] }] },
        { shell_pid: 201, foreground_processes: [{ pid: 99999, name: 'claude', argv: ['claude', '--resume', '22222222-2222-4222-8222-222222222222'] }] },
      ]);
    } else {
      writeProcessInfoSequence(processInfoDir, panes[0], [
        { shell_pid: 201, foreground_processes: [{ pid: child.pid, name: 'claude', argv: ['claude', '--resume', '22222222-2222-4222-8222-222222222222'] }] },
        { shell_pid: 201, foreground_processes: [] },
        { shell_pid: 201, foreground_processes: [] },
      ]);
    }
  }

  return { root, home, env, log, child };
}

function cleanup(fixture) {
  try {
    fixture.child?.cleanup();
  } catch {
    // テスト対象が既に終了させている場合がある。
  }
}

function writeProcessInfoSequence(dir, paneId, infos) {
  fs.writeFileSync(path.join(dir, `${paneId}.seq`), '0');
  infos.forEach((info, index) => {
    fs.writeFileSync(path.join(dir, `${paneId}.${index + 1}.json`), JSON.stringify({ result: { process_info: info } }));
  });
  fs.writeFileSync(path.join(dir, `${paneId}.json`), JSON.stringify({ result: { process_info: infos.at(-1) } }));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startReapedSleeper(root) {
  const pidFile = path.join(root, `target-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`);
  const supervisor = spawn(process.execPath, ['-e', `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[1], String(child.pid));
child.on('exit', () => setTimeout(() => process.exit(0), 50));
setInterval(() => {}, 1000);
`, pidFile], { stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) {
    if (fs.existsSync(pidFile)) {
      return {
        pid: Number(fs.readFileSync(pidFile, 'utf8')),
        cleanup: () => {
          try {
            process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
          } catch {
            // 既に終了している。
          }
          try {
            process.kill(supervisor.pid, 'SIGKILL');
          } catch {
            // 既に終了している。
          }
        },
      };
    }
    sleepSync(10);
  }
  try {
    process.kill(supervisor.pid, 'SIGKILL');
  } catch {
    // 起動前に終了している。
  }
  throw new Error('target process did not start');
}

function run(args, env, input = '') {
  const result = spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fire(env, used, resetsAt = Math.floor(Date.now() / 1000) + 3600) {
  return run(['hook', 'usage', '--used', String(used)], env, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 1, resets_at: resetsAt } } }));
}

function readConfig(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.config', 'ccd', 'config.json'), 'utf8'));
}

function readState(env) {
  const file = path.join(env.XDG_STATE_HOME, 'ccd', 'state.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function logText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('usage below threshold does not switch or record failover', () => {
  const fixture = setup();
  try {
    assert.equal(fire(fixture.env, 50).trim(), '');
    assert.doesNotMatch(logText(fixture.log), /pane run/);
    assert.equal(readState(fixture.env).lastUsageFailover, undefined);
  } finally {
    cleanup(fixture);
  }
});

test('usage above threshold switches panes and updates preferredAccount', () => {
  const fixture = setup();
  try {
    const out = fire(fixture.env, 92);
    assert.match(out, /Usage failover/);
    assert.match(logText(fixture.log), /herdr pane run other /);
    assert.equal(readConfig(fixture.home).preferredAccount, 'work');
    assert.equal(readState(fixture.env).lastUsageFailover.account, 'default');
  } finally {
    cleanup(fixture);
  }
});

test('usage failover does not fire twice in the same quota period', () => {
  const fixture = setup();
  try {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    fire(fixture.env, 92, resetsAt);
    const runsBefore = (logText(fixture.log).match(/herdr pane run other/g) || []).length;
    assert.equal(fire(fixture.env, 92, resetsAt).trim(), '');
    const runsAfter = (logText(fixture.log).match(/herdr pane run other/g) || []).length;
    assert.equal(runsAfter, runsBefore);
  } finally {
    cleanup(fixture);
  }
});

test('usage failover fires again after the stored reset time has passed', () => {
  const fixture = setup();
  try {
    const stateDir = path.join(fixture.env.XDG_STATE_HOME, 'ccd');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
      rateLimited: {},
      rateLimitedByEmail: {},
      switches: [],
      lastSwitchBySession: {},
      lastEvent: null,
      lastUsageFailover: { account: 'default', resetsAt: Math.floor(Date.now() / 1000) - 1, at: Date.now() - 3600 },
    }));
    fire(fixture.env, 92);
    assert.match(logText(fixture.log), /herdr pane run other /);
  } finally {
    cleanup(fixture);
  }
});

test('usage failover failure does not record lastUsageFailover and leaves a retryable event', () => {
  const fixture = setup({ paneMode: 'failure' });
  try {
    const out = fire(fixture.env, 92);
    const state = readState(fixture.env);
    assert.match(out, /failed/i);
    assert.equal(state.lastUsageFailover, undefined);
    assert.equal(state.lastEvent.kind, 'failed');
    assert.match(logText(fixture.log), /herdr notification show Claude usage failover failed/);
  } finally {
    cleanup(fixture);
  }
});

test('usage hook is ignored when autoSwitch.mode is off', () => {
  const fixture = setup();
  try {
    run(['config', 'set', 'autoSwitch.mode', 'off'], fixture.env);
    assert.equal(fire(fixture.env, 92).trim(), '');
    assert.doesNotMatch(logText(fixture.log), /pane run/);
    assert.equal(readState(fixture.env).lastUsageFailover, undefined);
  } finally {
    cleanup(fixture);
  }
});

test('install-usage is idempotent and does not overwrite an existing statusLine', () => {
  const fixture = setup({ panes: [] });
  try {
    run(['hook', 'install-usage'], fixture.env);
    run(['hook', 'install-usage'], fixture.env);
    const settingsFile = path.join(fixture.home, '.claude', 'settings.json');
    const installed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.match(installed.statusLine.command, /ccd-statusline\.sh$/);

    fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: '/tmp/existing-statusline.sh' } }));
    const out = run(['hook', 'install-usage'], fixture.env);
    const kept = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(kept.statusLine.command, '/tmp/existing-statusline.sh');
    assert.match(out, /既存の statusline/);
    assert.match(out, /ccd hook usage/);
  } finally {
    cleanup(fixture);
  }
});
