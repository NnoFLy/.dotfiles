fish_add_path -g \
    $HOME/.dotfiles/scripts \
    $HOME/.local/bin \
    $HOME/.cargo/bin \
    $HOME/apps/v2rayN-linux-64 \
    $HOME/go/bin \
    $HOME/apps/bin \
    $HOME/.bun/bin \
    $HOME/.opencode/bin

set -gx PNPM_HOME "$HOME/.local/share/pnpm"
fish_add_path -g $PNPM_HOME

if status is-interactive
  stty -ixon
  bind \cs '__tmux_sessionizer'
  # bind \cs '__zoxide'
end

function __zoxide
  commandline -r 'zi'
  commandline -f execute
end

function __tmux_sessionizer
  commandline -r 'tmux-sessionizer'
  commandline -f execute
end

if test -f "$HOME/Secure/.secure-keys"
  source "$HOME/Secure/.secure-keys"
end

if test -f "$HOME/.cargo/env.fish"
  source "$HOME/.cargo/env.fish"
end


function codex
    HTTP_PROXY=http://127.0.0.1:10808 HTTPS_PROXY=http://127.0.0.1:10808 command codex $argv
end

function opencode
    HTTP_PROXY=http://127.0.0.1:10808 HTTPS_PROXY=http://127.0.0.1:10808 command opencode $argv
end

set -gx EDITOR "nvim"

alias open='xdg-open'
alias py='uv run python'
alias vim='nvim'
alias ls='ls -p --group-directories-first --color=always'
alias la='ls -Alhvp --group-directories-first --color=always'
alias share='python3 -m http.server 8000 & sleep 1; ngrok http 8000'
alias cd='z'

zoxide init fish | source


# Added by Antigravity CLI installer
set -gx PATH "/home/nnofly/.local/bin" $PATH
