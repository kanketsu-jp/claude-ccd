# ccd

Switch between multiple Claude Code accounts — and **auto-switch when you hit a rate limit**.

`ccd` keeps each account in its own `CLAUDE_CONFIG_DIR`, so you can hold several
logins side by side and move between them without re-authenticating in a browser
every time. It also ships a `StopFailure` hook that detects a rate limit and
brings up a fresh session on another account.

```console
$ ccd list
   NAME       CONFIG DIR            ACCOUNT (email)        PLAN   LOGIN
*  default    ~/.claude             you@example.com        max    ok
   work       ~/.claude-work        you@work.example       pro    ok
   spare      ~/.claude-spare       -                      -      NOT LOGGED IN

$ ccd use work
CLAUDE_CONFIG_DIR is now ~/.claude-work (work / you@work.example)
```

> Unofficial community tool. Not affiliated with or endorsed by Anthropic.

## Install

```bash
npm install -g claude-ccd
```

Then add the shell integration to your shell rc file:

```bash
# ~/.zshrc
eval "$(ccd shell-init zsh)"

# ~/.bashrc
eval "$(ccd shell-init bash)"

# ~/.config/fish/config.fish
ccd shell-init fish | source
```

The shell integration is **required for `ccd use`**. Changing the current
shell's environment is something only a shell function can do — a plain binary
runs in a child process and cannot touch its parent. Every other subcommand
works without it.

Requires Node.js >= 18.17, macOS or Linux, and an installed
[Claude Code](https://claude.com/claude-code) CLI.

## Commands

| Command | What it does |
| --- | --- |
| `ccd` | Launch Claude Code with the current account (passes args through) |
| `ccd list` | List accounts: config dir, email, plan, login state |
| `ccd use <name\|email>` | Switch the current shell to another account |
| `ccd add [name]` | Create a new config dir (auto-numbers if name is omitted) |
| `ccd status [name\|email]` | Show details, including the keychain entry it maps to |
| `ccd run <name\|email> [args]` | Run Claude Code as another account without switching the shell |
| `ccd sync <name\|email>` | Share skills/rules/agents/commands + merge MCP servers from the default account |
| `ccd doctor` | Diagnose setup problems |
| `ccd hook install` | Install the rate-limit auto-switch hook |
| `ccd config` | Read/write `~/.config/ccd/config.json` |

Accounts can be addressed by **name** (`work`), by **path**, or by a
**substring of the email** (`ccd use work.example`).

## Adding an account

```bash
ccd add work          # creates ~/.claude-work
ccd sync work         # optional: share skills/rules/MCP with the default account
ccd run work          # starts Claude Code there → run /login → /status to confirm
ccd list              # LOGIN should now read "ok"
```

Each config dir is fully independent: its own settings, history, MCP servers and
credentials. `ccd sync` exists so you don't have to set all of that up twice.

## Auto-switch on rate limit

```bash
ccd hook install --mode notify   # notify only (default, recommended to start)
ccd hook install --mode auto     # actually switch and continue
```

This registers a `StopFailure` hook with `matcher: "rate_limit"` in the
account's `settings.json`. Claude Code normalizes rate-limit failures to
`error: "rate_limit"`, so detection does not depend on matching English error
text.

When it fires, `ccd`:

1. records that the current account is rate-limited,
2. picks the next account that is logged in and not in cooldown,
3. opens a new pane for it (herdr or tmux), resuming the same session,
4. sends a continue message.

In `notify` mode it stops after step 2 and just tells you the command to run.

### Safety limits

Auto-switching a coding agent is the kind of automation that can loop forever if
you let it, so it is bounded by default:

| Setting | Default | Purpose |
| --- | --- | --- |
| `autoSwitch.mode` | `notify` | `auto` \| `notify` \| `off` |
| `autoSwitch.cooldownMinutes` | `60` | How long a rate-limited account is skipped |
| `autoSwitch.minIntervalMinutes` | `5` | Minimum gap between switches in one session |
| `autoSwitch.maxSwitchesPerHour` | `4` | Global ceiling — the runaway stop |
| `autoSwitch.resume` | `true` | Resume the same session on the new account |
| `autoSwitch.launcher` | `auto` | `auto` \| `herdr` \| `tmux` \| `none` |

```bash
ccd config set autoSwitch.mode auto
ccd config set autoSwitch.cooldownMinutes 90
```

The hook always exits 0. A broken auto-switch must never take your session
down with it.

### Session continuity

Claude Code stores conversation history per config dir, so resuming a session
under a different account needs that session's transcript to be reachable. `ccd`
symlinks the single session file into the target config dir rather than sharing
the whole history directory. If it can't find the transcript, it starts a fresh
session instead of failing.

## How it works

Claude Code reads `CLAUDE_CONFIG_DIR` to decide where settings, history and
credentials live. `ccd` is a thin, careful wrapper around that variable.

The careful part is credential storage. On macOS the keychain service name
depends on the config dir:

| `CLAUDE_CONFIG_DIR` | Keychain service |
| --- | --- |
| unset | `Claude Code-credentials` |
| set | `Claude Code-credentials-<sha256(dir)[0:8]>` |

So setting `CLAUDE_CONFIG_DIR=$HOME/.claude` — pointing at the default directory
explicitly — makes Claude Code look up a *different* keychain entry and report
you as logged out. `ccd` unsets the variable for the default account instead of
setting it, and `ccd doctor` flags this if your shell config does it.

On Linux, credentials are a `.credentials.json` file inside the config dir, and
the same isolation falls out naturally.

`ccd` does **not** replace `~/.claude` with a symlink. Some guides suggest that;
it puts your skills, rules and history at risk for no benefit.

## Limitations

- A **running** session cannot change accounts. Switching means starting a new
  session; `/login` only re-authenticates within the same config dir.
- Auto-switch needs a second account that is actually logged in and on a
  separate plan. Two config dirs signed into the same account share one quota.
- Automatic pane creation supports [herdr](https://herdr.dev) and tmux. Anywhere
  else, `ccd` prints the command for you to run.

## License

MIT
