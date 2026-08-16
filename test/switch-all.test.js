import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { switchPane } from '../src/commands/switchAll.js';

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
  const processInfoDir = path.join(root, 'process-info');
  fs.mkdirSync(processInfoDir);
  return { root, home, bin, log, psOut: path.join(root, 'ps.txt'), processInfoDir };
}

function writeProcessInfo(fixture, paneId, info) {
  fs.writeFileSync(path.join(fixture.processInfoDir, `${paneId}.json`), JSON.stringify({ result: { process_info: info } }));
}

function writeProcessInfoSequence(fixture, paneId, infos) {
  fs.writeFileSync(path.join(fixture.processInfoDir, `${paneId}.seq`), '0');
  infos.forEach((info, index) => {
    fs.writeFileSync(path.join(fixture.processInfoDir, `${paneId}.${index + 1}.json`), JSON.stringify({ result: { process_info: info } }));
  });
  writeProcessInfo(fixture, paneId, infos.at(-1));
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
            // The CLI may have already terminated it.
          }
          try {
            process.kill(supervisor.pid, 'SIGKILL');
          } catch {
            // The supervisor exits after reaping the child.
          }
        },
      };
    }
    sleepSync(10);
  }
  try {
    process.kill(supervisor.pid, 'SIGKILL');
  } catch {
    // Nothing to clean up if startup failed early.
  }
  throw new Error('target process did not start');
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

test('switchPane skips and does not run a command when the old process stays alive', async () => {
  const events = [];
  const result = await switchPane('herdr', {
    pane: { id: 'pane-stuck' },
    pid: 12345,
    sessionId: '66666666-6666-4666-8666-666666666666',
  }, {
    dir: '/tmp/.claude-work',
  }, {
    ccdBin: '/abs/bin/ccd',
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    pollIntervalMs: 1,
    kill: (_pid, signal) => {
      events.push(`kill:${signal}`);
    },
    exists: () => true,
    sleep: async () => {},
    runCommand: (cmd, args) => {
      events.push(`run:${cmd} ${args.join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'process 12345 did not exit');
  assert.deepEqual(events, ['kill:SIGTERM', 'kill:SIGKILL']);
});

test('switchPane waits for SIGTERM exit before running the start command', async () => {
  const events = [];
  let existsChecks = 0;
  const result = await switchPane('herdr', {
    pane: { id: 'pane-term' },
    pid: 23456,
    sessionId: '77777777-7777-4777-8777-777777777777',
  }, {
    dir: '/tmp/.claude-work',
  }, {
    ccdBin: '/abs/bin/ccd',
    termTimeoutMs: 100,
    killTimeoutMs: 1,
    pollIntervalMs: 1,
    startDelayMs: 1,
    kill: (_pid, signal) => {
      events.push(`kill:${signal}`);
    },
    exists: () => {
      existsChecks += 1;
      events.push(`exists:${existsChecks}`);
      return existsChecks < 3;
    },
    sleep: async () => {},
    runCommand: (cmd, args) => {
      events.push(`run:${cmd} ${args.join(' ')}`);
      if (args[1] === 'process-info') {
        return { status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ name: 'claude' }] } } }), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(events.includes('kill:SIGKILL'), false);
  assert.deepEqual(events.slice(0, 5), ['kill:SIGTERM', 'exists:1', 'exists:2', 'exists:3', "run:herdr pane run pane-term CLAUDE_CONFIG_DIR='/tmp/.claude-work' '/abs/bin/ccd' --resume '77777777-7777-4777-8777-777777777777'"]);
});

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

test('switch-all runs ccd --resume through an absolute ccd path', () => {
  const fixture = setup();
  const child = startReapedSleeper(fixture.root);
  assert.ok(child.pid);
  fs.writeFileSync(fixture.psOut, '');
  writeProcessInfo(fixture, 'self', {
    shell_pid: 101,
    foreground_processes: [],
  });
  writeProcessInfo(fixture, 'other', {
    shell_pid: 201,
    foreground_processes: [{ pid: child.pid, name: 'claude', argv: ['claude', '--resume', '44444444-4444-4444-8444-444444444444'] }],
  });

  try {
    const result = runCli(['switch-all', 'work', '--include-self'], fixture, {
      CCD_SWITCH_ALL_START_DELAY_MS: '1',
    });

    assert.equal(result.status, 0, result.stderr);
    const log = fs.readFileSync(fixture.log, 'utf8');
    assert.ok(log.includes(`herdr pane run other CLAUDE_CONFIG_DIR='${fixture.home}/.claude-work' '${cli}' --resume '44444444-4444-4444-8444-444444444444'`), log);
  } finally {
    child.cleanup();
  }
});

test('switch-all retries once when claude does not start and counts the failure', () => {
  const fixture = setup();
  const child = startReapedSleeper(fixture.root);
  assert.ok(child.pid);
  fs.writeFileSync(fixture.psOut, '');
  writeProcessInfo(fixture, 'self', {
    shell_pid: 101,
    foreground_processes: [],
  });
  writeProcessInfoSequence(fixture, 'other', [
    {
      shell_pid: 201,
      foreground_processes: [{ pid: child.pid, name: 'claude', argv: ['claude', '--resume', '55555555-5555-4555-8555-555555555555'] }],
    },
    { shell_pid: 201, foreground_processes: [] },
    { shell_pid: 201, foreground_processes: [] },
  ]);

  try {
    const result = runCli(['switch-all', 'work', '--include-self'], fixture, {
      CCD_SWITCH_ALL_START_DELAY_MS: '1',
    });

    assert.equal(result.status, 1);
    const runs = fs.readFileSync(fixture.log, 'utf8').split('\n').filter((line) => line.includes('herdr pane run other '));
    assert.equal(runs.length, 2);
    assert.match(result.stdout, /failed pane other: claude did not start \(sid 55555555-5555-4555-8555-555555555555\)/);
    assert.match(result.stdout, /switched 0 \/ failed 1 \/ skipped 1/);
  } finally {
    child.cleanup();
  }
});
