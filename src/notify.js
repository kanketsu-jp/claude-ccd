import { commandExists, run } from './util.js';

export function notify(title, body) {
  try {
    if (commandExists('herdr')) {
      run('herdr', ['notification', 'show', String(title), String(body || '')]);
      return;
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
