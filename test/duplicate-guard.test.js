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

function setup(psText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-dupe-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(bin);
  const out = path.join(root, 'claude.json');
  const psOut = path.join(root, 'ps.txt');
  fs.writeFileSync(psOut, psText);
  writeExecutable(path.join(bin, 'ps'), `#!/bin/sh
/bin/cat "$PS_OUT"
`);
  writeExecutable(path.join(bin, 'claude'), `#!/bin/sh
"$NODE" -e 'const fs = require("fs"); fs.writeFileSync(process.env.OUT, JSON.stringify({ argv: process.argv.slice(1), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null } }));' -- "$@"
`);
  return { home, bin, out, psOut };
}

function runCcd(args, fixture) {
  const env = {
    ...process.env,
    HOME: fixture.home,
    XDG_CONFIG_HOME: path.join(fixture.home, '.config'),
    XDG_STATE_HOME: path.join(fixture.home, '.state'),
    CCD_SKIP_KEYCHAIN_CHECK: '1',
    NODE: process.execPath,
    OUT: fixture.out,
    PS_OUT: fixture.psOut,
    PATH: fixture.bin,
  };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
}

test('ccd --resume refuses to launch when the same session id is already running', () => {
  const sid = '11111111-1111-4111-8111-111111111111';
  const fixture = setup(` 777  1 claude --resume ${sid}
`);

  const result = runCcd(['--resume', sid], fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /777/);
  assert.equal(fs.existsSync(fixture.out), false);
});

test('ccd --resume does not block a different session id', () => {
  const fixture = setup(` 777  1 claude --resume 11111111-1111-4111-8111-111111111111
`);

  const result = runCcd(['--resume', '22222222-2222-4222-8222-222222222222'], fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.out, 'utf8')).argv, ['--resume', '22222222-2222-4222-8222-222222222222']);
});
