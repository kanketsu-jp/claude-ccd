import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'bin', 'ccd.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-sync-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-work', 'projects', 'p'), { recursive: true });
  return home;
}

function runCli(args, home) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
    CCD_SKIP_KEYCHAIN_CHECK: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
}

function listRelative(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(root, file);
      const stat = fs.lstatSync(file);
      out.push(`${rel}:${stat.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file'}`);
      if (entry.isDirectory()) walk(file);
    }
  }
  walk(root);
  return out.sort();
}

test('sync --projects preserves an existing real projects directory as a backup', () => {
  const home = makeHome();
  const sourceFile = path.join(home, '.claude', 'projects', 'p', 'same.jsonl');
  const targetFile = path.join(home, '.claude-work', 'projects', 'p', 'same.jsonl');
  const targetOnly = path.join(home, '.claude-work', 'projects', 'p', 'target-only.jsonl');
  fs.writeFileSync(sourceFile, 'source\n');
  fs.writeFileSync(targetFile, 'target-newer\n');
  fs.writeFileSync(targetOnly, 'target only\n');
  fs.utimesSync(sourceFile, new Date(1000), new Date(1000));
  fs.utimesSync(targetFile, new Date(2000), new Date(2000));

  const result = runCli(['sync', 'work', '--no-mcp', '--no-settings'], home);

  assert.equal(result.status, 0, result.stderr);
  const link = path.join(home, '.claude-work', 'projects');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), path.join(home, '.claude', 'projects'));
  const backups = fs.readdirSync(path.join(home, '.claude-work')).filter((name) => name.startsWith('projects.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(home, '.claude-work', backups[0], 'p', 'same.jsonl'), 'utf8'), 'target-newer\n');
  assert.equal(fs.readFileSync(path.join(home, '.claude-work', backups[0], 'p', 'target-only.jsonl'), 'utf8'), 'target only\n');
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), 'target-newer\n');
  assert.ok(fs.readdirSync(path.join(home, '.claude', 'projects', 'p')).some((name) => /^same\.jsonl\.bak-/.test(name)));
});

test('sync --dry-run does not change the file tree', () => {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.claude', 'statusline-command.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(home, '.claude-work', 'projects', 'p', 'a.jsonl'), 'a\n');
  const before = listRelative(home);

  const result = runCli(['sync', 'work', '--dry-run'], home);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(listRelative(home), before);
  assert.match(result.stdout, /link/);
});

test('sync merges only settings.json statusLine and keeps account hooks', () => {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/statusline-command.sh' }, hooks: { Stop: [] } }));
  fs.writeFileSync(path.join(home, '.claude-work', 'settings.json'), JSON.stringify({ hooks: { StopFailure: [{ matcher: 'rate_limit', hooks: [] }] }, theme: 'dark' }));

  const result = runCli(['sync', 'work', '--no-projects', '--no-mcp'], home);

  assert.equal(result.status, 0, result.stderr);
  const target = JSON.parse(fs.readFileSync(path.join(home, '.claude-work', 'settings.json'), 'utf8'));
  assert.deepEqual(target.statusLine, { type: 'command', command: '~/.claude/statusline-command.sh' });
  assert.deepEqual(target.hooks, { StopFailure: [{ matcher: 'rate_limit', hooks: [] }] });
  assert.equal(target.theme, 'dark');
  assert.ok(fs.existsSync(path.join(home, '.claude-work', 'settings.json.bak')));
});
