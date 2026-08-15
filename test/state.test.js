import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-state-'));
process.env.XDG_STATE_HOME = path.join(home, '.state');

const state = await import('../src/state.js');
const accounts = await import('../src/accounts.js');

test('switchesInLastHour counts only recent switches at the boundary', () => {
  const now = Date.now();
  assert.equal(state.switchesInLastHour({
    switches: [
      { at: now - 60 * 60 * 1000 - 1 },
      { at: now - 60 * 60 * 1000 + 1000 },
      { at: now - 1000 },
    ],
  }), 2);
});

test('recordRateLimit stores cooldown timestamp and recordSwitch keeps session index', () => {
  state.recordRateLimit({ name: 'work', email: 'work@example.invalid' });
  let loaded = state.loadState();
  assert.equal(typeof loaded.rateLimited.work, 'number');
  assert.equal(typeof loaded.rateLimitedByEmail['work@example.invalid'], 'number');
  assert.ok(Date.now() - loaded.rateLimited.work < 5000);

  state.recordSwitch({ fromName: 'default', toName: 'work', sessionId: 'abc' });
  loaded = state.loadState();
  assert.equal(loaded.switches.at(-1).fromName, 'default');
  assert.equal(typeof loaded.lastSwitchBySession.abc, 'number');
});

test('email cooldown makes matching accounts unhealthy without affecting other emails', () => {
  state.recordRateLimit({ name: 'primary', email: 'shared@example.invalid' });
  const loaded = state.loadState();
  const config = { autoSwitch: { cooldownMinutes: 60 } };

  assert.equal(accounts.isHealthy({ name: 'alias', email: 'shared@example.invalid', loggedIn: true }, loaded, config), false);
  assert.equal(accounts.isHealthy({ name: 'other', email: 'other@example.invalid', loggedIn: true }, loaded, config), true);
  assert.equal(accounts.isHealthy({ name: 'no-email', email: null, loggedIn: true }, loaded, config), true);
});
