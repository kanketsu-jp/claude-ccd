set -gx CCD_SHELL_INTEGRATION 1

function ccd
  if test (count $argv) -gt 0; and test "$argv[1]" = "use"
    set -l code (command ccd $argv --shell fish)
    or return
    echo "$code" | source
  else
    command ccd $argv
  end
end

complete -c ccd -f -a "list ls use add status st run sync doctor hook config shell-init current help version"
