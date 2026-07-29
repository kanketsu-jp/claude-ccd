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

_ccd_complete() {
  local cur commands
  cur="${COMP_WORDS[COMP_CWORD]}"
  commands="list ls use add status st run sync doctor hook config shell-init current help version"
  COMPREPLY=($(compgen -W "$commands" -- "$cur"))
}

complete -F _ccd_complete ccd
