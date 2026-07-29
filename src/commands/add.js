import fs from 'node:fs';
import { defaultDir, dirForName, normalizeDir } from '../accounts.js';
import { shortenHome } from '../util.js';

function nextName() {
  for (let i = 2; i < 100; i += 1) {
    const name = `account${i}`;
    if (!fs.existsSync(dirForName(name))) return name;
  }
  return `account${Date.now()}`;
}

export function run(args = []) {
  const name = args[0] || nextName();
  const dir = dirForName(name);
  if (normalizeDir(dir) === normalizeDir(defaultDir())) {
    process.stderr.write('Cannot add the default account directory.\n');
    return 1;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.stdout.write(`Created account directory: ${shortenHome(dir)}\n`);
  process.stdout.write(`Next: ccd sync ${name}\n`);
  process.stdout.write(`Then: ccd run ${name} and run /login in Claude Code.\n`);
  return 0;
}
