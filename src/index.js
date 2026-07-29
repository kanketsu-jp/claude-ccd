import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { currentDir, nameForDir } from './accounts.js';
import { loadConfig } from './config.js';
import { commandExists } from './util.js';
import * as listCmd from './commands/list.js';
import * as useCmd from './commands/use.js';
import * as addCmd from './commands/add.js';
import * as statusCmd from './commands/status.js';
import * as runCmd from './commands/run.js';
import * as syncCmd from './commands/sync.js';
import * as doctorCmd from './commands/doctor.js';
import * as hookCmd from './commands/hookCmd.js';
import * as shellInitCmd from './commands/shellInit.js';
import * as configCmd from './commands/configCmd.js';

const commands = new Map([
  ['list', listCmd],
  ['ls', listCmd],
  ['use', useCmd],
  ['add', addCmd],
  ['status', statusCmd],
  ['st', statusCmd],
  ['run', runCmd],
  ['sync', syncCmd],
  ['doctor', doctorCmd],
  ['hook', hookCmd],
  ['shell-init', shellInitCmd],
  ['config', configCmd],
]);

function help() {
  return `ccd - Claude Code account switcher

Usage:
  ccd [claude args...]
  ccd <command> [args...]

Commands:
  list, ls                 List accounts
  use <account>            Print shell code to switch account
  add [name]               Create a new account directory
  status, st [account]     Show account status
  run <account> [args...]  Run claude with an account
  sync <account>           Link shared Claude Code files
  hook <action>            Manage StopFailure hook
  config <action>          Manage ccd config
  shell-init [shell]       Print shell integration
  current                  Print current account name
  doctor                   Check local setup
  help                     Show this help
  version                  Show package version
`;
}

function packageVersion() {
  const file = path.join(path.dirname(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname))), 'package.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function launchClaude(args) {
  const config = loadConfig();
  const bin = config.claudeBin || 'claude';
  if (!commandExists(bin)) {
    process.stderr.write(`Claude binary not found: ${bin}\n`);
    return 1;
  }
  const result = spawnSync(bin, [...(config.launchArgs || []), ...args], { stdio: 'inherit' });
  return typeof result.status === 'number' ? result.status : 1;
}

export async function main(argv = []) {
  try {
    const command = argv[0];
    let exitCode = 0;
    if (!command) {
      exitCode = launchClaude([]);
    } else if (command === '--') {
      exitCode = launchClaude(argv.slice(1));
    } else if (command === '--help' || command === '-h' || command === 'help') {
      process.stdout.write(help());
    } else if (command === '--version' || command === '-v' || command === 'version') {
      process.stdout.write(packageVersion() + '\n');
    } else if (command === 'current') {
      process.stdout.write(nameForDir(currentDir()) + '\n');
    } else if (commands.has(command)) {
      exitCode = await commands.get(command).run(argv.slice(1));
    } else {
      exitCode = launchClaude(argv);
    }
    process.exitCode = exitCode;
    return exitCode;
  } catch (error) {
    if (process.env.CCD_DEBUG === '1') {
      process.stderr.write((error?.stack || String(error)) + '\n');
    } else {
      process.stderr.write(`ccd: ${error?.message || String(error)}\n`);
    }
    process.exitCode = 1;
    return 1;
  }
}
