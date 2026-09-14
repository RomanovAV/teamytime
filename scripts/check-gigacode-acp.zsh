#!/bin/zsh -f
emulate -LR zsh
unsetopt BG_NICE ALIASES
# Keep this file next to check-gigacode.zsh when copying to the target machine.
exec /bin/zsh -f "${0:A:h}/check-gigacode.zsh" --acp-only "$@"
