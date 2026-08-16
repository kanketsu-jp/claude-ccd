import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'bin', 'ccd.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-default-'));
  for (const dir of ['.claude', '.claude-work', '.claude-spare']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}');
  }
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'main@example.invalid' } }));
  fs.writeFileSync(path.join(home, '.claude-work', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.invalid' } }));
  fs.writeFileSync(path.join(home, '.claude-spare', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'spare@example.invalid' } }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return home;
}

function runCli(args, home, options = {}) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
    PATH: options.path || `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH}`,
    ...(options.env || {}),
  };
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, 'CLAUDE_CONFIG_DIR')) delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
}

function config(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.config', 'ccd', 'config.json'), 'utf8'));
}

test('ccd default shows fallback when preferredAccount is clear', () => {
  const home = makeHome();
  const result = runCli(['default'], home);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /default/);
  assert.match(result.stdout, /fallback/);
});

test('ccd default <name> stores the resolved account name', () => {
  const home = makeHome();
  const result = runCli(['default', 'work'], home);
  assert.equal(result.status, 0);
  assert.equal(config(home).preferredAccount, 'work');
  assert.match(result.stdout, /work/);
});

test('ccd default --clear resets preferredAccount to null', () => {
  const home = makeHome();
  runCli(['default', 'work'], home);
  const result = runCli(['default', '--clear'], home);
  assert.equal(result.status, 0);
  assert.equal(config(home).preferredAccount, null);
});

test('ccd default --auto skips accounts still inside cooldown', () => {
  const home = makeHome();
  runCli(['config', 'set', 'autoSwitch.order', '["work","spare"]'], home);
  const stateFile = path.join(home, '.state', 'ccd', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ rateLimited: { work: Date.now() }, switches: [], lastSwitchBySession: {} }));

  const result = runCli(['default', '--auto'], home);

  assert.equal(result.status, 0);
  assert.equal(config(home).preferredAccount, 'spare');
});

test('ccd default --auto skips accounts cooling by shared email', () => {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.claude-work', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'shared@example.invalid' } }));
  fs.writeFileSync(path.join(home, '.claude-spare', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'shared@example.invalid' } }));
  runCli(['config', 'set', 'autoSwitch.order', '["spare","default"]'], home);
  const stateFile = path.join(home, '.state', 'ccd', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    rateLimited: { work: Date.now() },
    rateLimitedByEmail: { 'shared@example.invalid': Date.now() },
    switches: [],
    lastSwitchBySession: {},
  }));

  const result = runCli(['default', '--auto'], home);

  assert.equal(result.status, 0);
  assert.equal(config(home).preferredAccount, 'default');
});

test('ccd list shows shared quota and email-based cooling', () => {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.claude-work', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'main@example.invalid' } }));
  const stateFile = path.join(home, '.state', 'ccd', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    rateLimited: {},
    rateLimitedByEmail: { 'main@example.invalid': Date.now() },
    switches: [],
    lastSwitchBySession: {},
  }));

  const result = runCli(['list'], home);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /work\s+~\/\.claude-work\s+main@example\.invalid \(shares quota with default\)/);
  assert.match(result.stdout, /default[\s\S]*yes \(cooling \d+m\)/);
  assert.match(result.stdout, /work[\s\S]*yes \(cooling \d+m\)/);
});

test('resolveDefaultAccount honors preferredAccount without moving ~/.claude', async () => {
  const home = makeHome();
  runCli(['default', 'work'], home);
  const before = fs.lstatSync(path.join(home, '.claude'));
  const script = `
    process.env.HOME = ${JSON.stringify(home)};
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(path.join(home, '.config'))};
    const { resolveDefaultAccount } = await import(${JSON.stringify(path.join(repoRoot, 'src', 'accounts.js'))});
    const account = resolveDefaultAccount();
    console.log(JSON.stringify({ name: account.name, dir: account.dir }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const resolved = JSON.parse(out);
  const after = fs.lstatSync(path.join(home, '.claude'));
  assert.equal(resolved.name, 'work');
  assert.equal(before.isDirectory(), true);
  assert.equal(before.isSymbolicLink(), false);
  assert.equal(after.isDirectory(), true);
  assert.equal(after.isSymbolicLink(), false);
});

test('plain ccd launch uses preferredAccount only when CLAUDE_CONFIG_DIR is unset', () => {
  const home = makeHome();
  const out = path.join(home, 'claude-env.json');
  fs.writeFileSync(
    path.join(home, 'bin', 'claude'),
    `#!/bin/sh
"$NODE" -e 'const fs = require("fs"); fs.writeFileSync(process.env.OUT, JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR || null }));'
`,
    { mode: 0o755 },
  );
  runCli(['default', 'work'], home);

  let result = runCli([], home, { env: { NODE: process.execPath, OUT: out } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { configDir: path.join(home, '.claude-work') });

  result = runCli([], home, { env: { NODE: process.execPath, OUT: out, CLAUDE_CONFIG_DIR: path.join(home, '.claude-spare') } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { configDir: path.join(home, '.claude-spare') });
});

test('shell-init emits preferredAccount initialization guarded by an unset check', () => {
  const home = makeHome();
  runCli(['default', 'work'], home);

  const result = runCli(['shell-init', 'zsh'], home);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /if \[ -z "\$\{CLAUDE_CONFIG_DIR\+x\}" \]/);
  assert.ok(result.stdout.includes(path.join(home, '.claude-work')));
});
