import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { currentDir, envForAccount, nameForDir, resolveDefaultAccount } from './accounts.js';
import { loadConfig } from './config.js';
import { commandExists, expandArgAliases, findCommandOnPath } from './util.js';
import { findRunningSession, resumeSessionIdFromArgs } from './launcher.js';
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
import * as defaultCmd from './commands/defaultCmd.js';
import * as switchAllCmd from './commands/switchAll.js';
import * as disableCmd from './commands/disableCmd.js';

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
  ['default', defaultCmd],
  ['switch-all', switchAllCmd],
  ['disable', disableCmd],
  ['enable', { run: (args) => disableCmd.runEnable(args) }],
]);

function help() {
  return `ccd - Claude Code account switcher

Usage:
  ccd [claude args...]
  ccd <command> [args...]

Commands:
  list, ls                 List accounts
  use <account>            Print shell code to switch account
                           (copies this directory's sessions; --no-sessions,
                            --sessions <n|all> to change)
  add [name]               Create a new account directory
  status, st [account]     Show account status
  run <account> [args...]  Run claude with an account
  sync <account>           Link shared Claude Code files
  hook <action>            Manage StopFailure/statusline hooks
  config <action>          Manage ccd config
  shell-init [shell]       Print shell integration
  current                  Print current account name
  default [account]        Show or set the default account
  switch-all <account>     Switch all herdr/tmux panes to an account
  disable [account]        Exclude an account from automatic switching (list if no arg)
  enable <account>         Re-include a disabled account
  doctor                   Check local setup
  <name> [args...]         Delegate to ccd-<name> on PATH if available
  help                     Show this help
  version                  Show package version

Hook actions:
  hook install             Install StopFailure rate-limit hook
  hook install-usage       Install statusline usage failover hook
  hook usage [--used <n>]  Feed statusline usage JSON to ccd
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
  const expandedArgs = [...(config.launchArgs || []), ...expandArgAliases(args, config)];
  const forceDuplicate = expandedArgs.includes('--force-duplicate');
  const claudeArgs = expandedArgs.filter((arg) => arg !== '--force-duplicate');
  const resumeSessionId = resumeSessionIdFromArgs(claudeArgs);
  if (resumeSessionId && !forceDuplicate) {
    const existing = findRunningSession(resumeSessionId);
    if (existing) {
      process.stderr.write(`Session ${resumeSessionId} is already running in PID ${existing.pid}. Use --force-duplicate to override.\n`);
      return 1;
    }
  }
  const env = process.env.CLAUDE_CONFIG_DIR ? process.env : envForAccount(resolveDefaultAccount(config));
  const result = spawnSync(bin, claudeArgs, { stdio: 'inherit', env });
  return typeof result.status === 'number' ? result.status : 1;
}

function isExternalSubcommandName(command) {
  return /^[a-z][a-z0-9-]*$/.test(command);
}

function launchExternalSubcommand(command, args) {
  if (!isExternalSubcommandName(command)) return null;
  const bin = findCommandOnPath(`ccd-${command}`);
  if (!bin) return null;
  const configDir = currentDir();
  const result = spawnSync(bin, args, {
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      CCD_ACCOUNT: nameForDir(configDir),
      CCD_CONFIG_DIR: configDir,
      CCD_BIN_VERSION: packageVersion(),
    },
  });
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
      const externalExitCode = launchExternalSubcommand(command, argv.slice(1));
      exitCode = typeof externalExitCode === 'number' ? externalExitCode : launchClaude(argv);
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
