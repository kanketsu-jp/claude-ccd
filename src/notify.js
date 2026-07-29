import { commandExists, run } from './util.js';

// StopFailure フックは stdout と exit code が無視されるため、
// 自動切り替えの結果をユーザーへ届ける経路はこの通知だけになる。確実に出す必要がある。
export function notify(title, body) {
  try {
    if (commandExists('herdr')) {
      // herdr は本文を --body フラグで受け取る。位置引数で渡すと unknown option になり通知が出ない。
      const args = ['notification', 'show', String(title)];
      if (body) args.push('--body', String(body));
      const result = run('herdr', args);
      if (result.status === 0 && !/unknown option/i.test(result.stdout + result.stderr)) return;
      // herdr 側で失敗したら OS の通知にフォールバックする。
    }
    if (process.platform === 'darwin' && commandExists('osascript')) {
      run('osascript', ['-e', `display notification ${JSON.stringify(String(body || ''))} with title ${JSON.stringify(String(title))}`]);
      return;
    }
    if (process.platform === 'linux' && commandExists('notify-send')) {
      run('notify-send', [String(title), String(body || '')]);
    }
  } catch {
    // 通知の失敗は本体動作に影響させない。
  }
}
