export CCD_SHELL_INTEGRATION=1

ccd() {
  if [ "$1" = "use" ]; then
    local code
    code="$(command ccd "$@")" || return
    eval "$code"
  else
    command ccd "$@"
  fi
}

_ccd() {
  local -a commands
  commands=(
    'list:List accounts'
    'use:Switch account'
    'add:Add account'
    'status:Show status'
    'run:Run Claude with account'
    'sync:Sync shared files'
    'doctor:Check setup'
    'hook:Manage hook'
    'config:Manage config'
    'shell-init:Print shell integration'
    'current:Print current account'
    'help:Show help'
    'version:Show version'
  )
  _describe 'command' commands
}

if whence -w compdef >/dev/null 2>&1; then
  compdef _ccd ccd
fi
