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

test('resolveAccount prefers an exact account name before email substring matches', () => {
  const kimuraDir = path.join(home, '.claude-kimura');
  const claudeItDir = path.join(home, '.claude-claude.it');
  fs.mkdirSync(kimuraDir, { recursive: true });
  fs.mkdirSync(claudeItDir, { recursive: true });
  fs.writeFileSync(path.join(kimuraDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'person@example.invalid' } }));
  fs.writeFileSync(path.join(claudeItDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kanami.kimura.claude.it@example.invalid' } }));

  const resolved = accounts.resolveAccount('kimura');

  assert.equal(resolved.account.name, 'kimura');
  assert.equal(resolved.account.dir, kimuraDir);
});

test('resolveAccount still supports email substrings when no name matches', () => {
  const emailOnlyDir = path.join(home, '.claude-email-only');
  fs.mkdirSync(emailOnlyDir, { recursive: true });
  fs.writeFileSync(path.join(emailOnlyDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'email-only@example.invalid' } }));

  assert.equal(accounts.resolveAccount('email-only@').account.name, 'email-only');
});

test('resolveAccount keeps ambiguous email substring results ambiguous', () => {
  const firstDir = path.join(home, '.claude-ambiguous-a');
  const secondDir = path.join(home, '.claude-ambiguous-b');
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(firstDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'team.shared-a@example.invalid' } }));
  fs.writeFileSync(path.join(secondDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'team.shared-b@example.invalid' } }));

  const resolved = accounts.resolveAccount('team.shared');

  assert.equal(resolved.error, 'ambiguous');
  assert.ok(resolved.matches.some((account) => account.name === 'ambiguous-a'));
  assert.ok(resolved.matches.some((account) => account.name === 'ambiguous-b'));
});

// `ccd disable` で無効化したアカウントは自動選択 (レートリミット時の切替先 /
// 使用率フェイルオーバー / 既定候補) から外れる。手動の use / run は別経路なので影響しない。
// 由来: 2026-08-17「使わないはずの kimura が 5 ペインで動いていた」。
test('isHealthy returns false for accounts listed in disabledAccounts', () => {
  const account = { name: 'kimura', loggedIn: true };
  assert.equal(accounts.isHealthy(account, {}, {}), true);
  assert.equal(accounts.isHealthy(account, {}, { disabledAccounts: ['kimura'] }), false);
});

test('chooseHealthyAccount skips disabled accounts', () => {
  const list = [
    { name: 'kimura', loggedIn: true },
    { name: 'default', loggedIn: true },
  ];
  assert.equal(accounts.chooseHealthyAccount(list, {}, {})?.name, 'kimura');
  assert.equal(accounts.chooseHealthyAccount(list, {}, { disabledAccounts: ['kimura'] })?.name, 'default');
});
