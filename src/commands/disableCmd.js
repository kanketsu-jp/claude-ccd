import { listAccounts, resolveAccount } from '../accounts.js';
import { loadConfig, saveConfig } from '../config.js';

// `ccd disable <name>` / `ccd enable <name>`
// 無効化したアカウントは自動選択 (レートリミット時の切替先 / 使用率フェイルオーバー /
// 既定アカウントの候補) から外れる。手動の `ccd use` / `ccd run` は従来どおり使える。
// 由来: 2026-08-17「使わないはずの kimura が 5 ペインで動いていた」。一度 preferredAccount が
// 書き換わると、その後もそのアカウントが選ばれ続けるため、候補から外す手段が必要だった。

function currentList(config) {
  return Array.isArray(config.disabledAccounts) ? [...config.disabledAccounts] : [];
}

function printList(config) {
  const disabled = currentList(config);
  if (disabled.length === 0) {
    process.stdout.write('無効化されたアカウントはありません\n');
    return 0;
  }
  process.stdout.write('無効化中 (自動選択から除外):\n');
  for (const name of disabled) process.stdout.write(`  ${name}\n`);
  return 0;
}

export function run(args = []) {
  const [name] = args;
  const config = loadConfig();
  if (!name) return printList(config);

  const resolved = resolveAccount(name);
  const account = resolved.account;
  if (!account) {
    process.stderr.write(`アカウントが見つかりません: ${name}\n`);
    return 1;
  }

  const disabled = currentList(config);
  if (disabled.includes(account.name)) {
    process.stdout.write(`${account.name} は既に無効化されています\n`);
    return 0;
  }

  // 全アカウントを無効化すると自動切替の行き先が無くなるので止める。
  const enabled = listAccounts().filter((a) => a.loggedIn && !disabled.includes(a.name) && a.name !== account.name);
  if (enabled.length === 0) {
    process.stderr.write('これを無効化すると自動切替の候補が 0 になります。先に他のアカウントを有効にしてください\n');
    return 1;
  }

  disabled.push(account.name);
  saveConfig({ ...config, disabledAccounts: disabled });
  process.stdout.write(`無効化しました: ${account.name} (自動選択から除外。手動の ccd use ${account.name} は可能)\n`);

  if (config.preferredAccount === account.name) {
    process.stdout.write(`注意: 既定アカウントが ${account.name} のままです。ccd default <name> で変更してください\n`);
  }
  return 0;
}

export function runEnable(args = []) {
  const [name] = args;
  const config = loadConfig();
  if (!name) return printList(config);

  const resolved = resolveAccount(name);
  const target = resolved.account?.name || name;
  const disabled = currentList(config);
  if (!disabled.includes(target)) {
    process.stdout.write(`${target} は無効化されていません\n`);
    return 0;
  }
  saveConfig({ ...config, disabledAccounts: disabled.filter((n) => n !== target) });
  process.stdout.write(`有効化しました: ${target}\n`);
  return 0;
}
