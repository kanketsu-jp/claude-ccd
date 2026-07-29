import fs from 'node:fs';
import path from 'node:path';

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
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  return 0;
}
