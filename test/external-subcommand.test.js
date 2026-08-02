import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ccdBin = path.join(repoRoot, 'bin', 'ccd.js');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function makeTemp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-external-'));
  const binDir = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(binDir);
  fs.mkdirSync(home);
  return { root, binDir, home };
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function writeExternal(binDir, name) {
  writeExecutable(
    path.join(binDir, `ccd-${name}`),
    `#!/bin/sh
"$NODE" -e 'const fs = require("fs"); fs.writeFileSync(process.env.OUT, JSON.stringify({ argv: process.argv.slice(1), env: { CCD_ACCOUNT: process.env.CCD_ACCOUNT, CCD_CONFIG_DIR: process.env.CCD_CONFIG_DIR, CCD_BIN_VERSION: process.env.CCD_BIN_VERSION } })); process.exit(Number(process.env.CHILD_EXIT || "0"));' -- "$@"
`,
  );
}

function writeClaude(binDir) {
  writeExecutable(
    path.join(binDir, 'claude'),
    `#!/bin/sh
"$NODE" -e 'const fs = require("fs"); fs.writeFileSync(process.env.OUT, JSON.stringify({ argv: process.argv.slice(1) }));' -- "$@"
`,
  );
}

function runCcd(args, { binDir, home, out, childExit, claudeConfigDir } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
    CCD_SKIP_KEYCHAIN_CHECK: '1',
    NODE: process.execPath,
    OUT: out,
    PATH: binDir,
  };
  if (childExit != null) env.CHILD_EXIT = String(childExit);
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [ccdBin, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('delegates to ccd-<name> on PATH with args and context env', () => {
  const { root, binDir, home } = makeTemp();
  const out = path.join(root, 'external.json');
  const configDir = path.join(home, '.claude-work');
  writeExternal(binDir, 'hello');

  const result = runCcd(['hello', 'a', 'b', 'c'], { binDir, home, out, claudeConfigDir: configDir });

  assert.equal(result.status, 0);
  assert.deepEqual(readJson(out), {
    argv: ['a', 'b', 'c'],
    env: {
      CCD_ACCOUNT: 'work',
      CCD_CONFIG_DIR: configDir,
      CCD_BIN_VERSION: packageJson.version,
    },
  });
});

test('does not delegate arguments that start with -', () => {
  const { root, binDir, home } = makeTemp();
  const out = path.join(root, 'claude.json');
  writeExternal(binDir, '--dangerously-skip-permissions');
  writeClaude(binDir);

  const result = runCcd(['--dangerously-skip-permissions'], { binDir, home, out });

  assert.equal(result.status, 0);
  assert.deepEqual(readJson(out), { argv: ['--dangerously-skip-permissions'] });
});

test('does not delegate words with uppercase letters or symbols', () => {
  for (const command of ['Hello', 'bad_name']) {
    const { root, binDir, home } = makeTemp();
    const out = path.join(root, 'claude.json');
    writeExternal(binDir, command);
    writeClaude(binDir);

    const result = runCcd([command], { binDir, home, out });

    assert.equal(result.status, 0);
    assert.deepEqual(readJson(out), { argv: [command] });
  }
});

test('falls back to claude when no external subcommand exists', () => {
  const { root, binDir, home } = makeTemp();
  const out = path.join(root, 'claude.json');
  writeClaude(binDir);

  const result = runCcd(['missing', 'arg'], { binDir, home, out });

  assert.equal(result.status, 0);
  assert.deepEqual(readJson(out), { argv: ['missing', 'arg'] });
});

test('uses the external subcommand exit code as the ccd exit code', () => {
  const { root, binDir, home } = makeTemp();
  const out = path.join(root, 'external.json');
  writeExternal(binDir, 'fail');

  const result = runCcd(['fail'], { binDir, home, out, childExit: 17 });

  assert.equal(result.status, 17);
});
