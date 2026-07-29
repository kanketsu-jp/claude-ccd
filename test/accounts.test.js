import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-accounts-'));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.XDG_STATE_HOME = path.join(home, '.state');
process.env.CCD_SKIP_KEYCHAIN_CHECK = '1';
delete process.env.CLAUDE_CONFIG_DIR;

const accounts = await import('../src/accounts.js');
const credentials = await import('../src/credentials.js');
const util = await import('../src/util.js');

test('keychainServiceName uses default service without suffix', () => {
  assert.equal(credentials.keychainServiceName(path.join(home, '.claude'), { isDefault: true }), 'Claude Code-credentials');
});

test('keychainServiceName uses sha256 hex8 suffix for non-default config dir', () => {
  const dir = '~/raw-dir/'.normalize('NFC');
  assert.equal(
    credentials.keychainServiceName(dir, { isDefault: false }),
    `Claude Code-credentials-${util.sha256Hex8(dir.normalize('NFC'))}`,
  );
});

test('dirForName and nameForDir round trip common account names', () => {
  assert.equal(accounts.dirForName('default'), path.join(home, '.claude'));
  assert.equal(accounts.dirForName('2'), path.join(home, '.claude-account2'));
  assert.equal(accounts.nameForDir(path.join(home, '.claude')), 'default');
  assert.equal(accounts.nameForDir(path.join(home, '.claude-work')), 'work');
  assert.equal(accounts.nameForDir(path.join(home, '.claude-account2')), 'account2');
});

test('configFileForDir follows default and non-default Claude Code locations', () => {
  assert.equal(accounts.configFileForDir(path.join(home, '.claude')), path.join(home, '.claude.json'));
  assert.equal(accounts.configFileForDir(path.join(home, '.claude-work')), path.join(home, '.claude-work', '.claude.json'));
});

test('resolveAccount resolves by name, path, and email substring', () => {
  const defaultDir = path.join(home, '.claude');
  const workDir = path.join(home, '.claude-work');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'main@example.invalid' } }));
  fs.writeFileSync(path.join(workDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.invalid' } }));

  assert.equal(accounts.resolveAccount('default').account.dir, defaultDir);
  assert.equal(accounts.resolveAccount(workDir).account.name, 'work');
  assert.equal(accounts.resolveAccount('WORK@').account.dir, workDir);
});
