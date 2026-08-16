import fs from 'node:fs';
import path from 'node:path';
import { resolveDefaultAccount } from '../accounts.js';
import { loadConfig } from '../config.js';
import { shellQuote } from '../util.js';

const root = path.dirname(path.dirname(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname))));

function detectShell() {
  const shell = process.env.SHELL || '';
  if (shell.endsWith('fish')) return 'fish';
  if (shell.endsWith('bash')) return 'bash';
  return 'zsh';
}

export function run(args = []) {
  const shell = args[0] || detectShell();
  const file = path.join(root, 'shell', `ccd.${shell}`);
  if (!['zsh', 'bash', 'fish'].includes(shell) || !fs.existsSync(file)) {
    process.stderr.write('Supported shells: zsh, bash, fish\n');
    return 1;
  }
  const account = resolveDefaultAccount(loadConfig());
  let init = '';
  if (!account.isDefault) {
    if (shell === 'fish') {
      init = `if not set -q CLAUDE_CONFIG_DIR\n  set -gx CLAUDE_CONFIG_DIR ${shellQuote(account.dir)}\nend\n\n`;
    } else {
      init = `if [ -z "\${CLAUDE_CONFIG_DIR+x}" ]; then\n  export CLAUDE_CONFIG_DIR=${shellQuote(account.dir)}\nfi\n\n`;
    }
  }
  process.stdout.write(init + fs.readFileSync(file, 'utf8'));
  return 0;
}
