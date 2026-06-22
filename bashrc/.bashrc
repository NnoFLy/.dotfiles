[[ -f "$HOME/Secure/.secure-keys" ]] && source "$HOME/Secure/.secure-keys"
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
[[ -f /usr/share/bash-completion/bash_completion ]] && source "/usr/share/bash-completion/bash_completion"

add_to_path() {
    local -r paths=("${@:1}")
    for p in "${paths[@]}"; do
        if [[ -d "$p" ]]; then
            export PATH="$p:$PATH"
        fi
    done
}

add_to_path "$HOME/.dotfiles/scripts" \
            "$HOME/.local/bin" \
            "$HOME/.cargo/bin" \
            "$HOME/apps/v2rayN-linux-64" \
            "$HOME/go/bin" \
            "$HOME/apps/bin" \
            "$HOME/.bun/bin" \
            "$HOME/.opencode/bin" \
            "$HOME/.local/share/pnpm" \
            "$HOME/.npm-global/bin"

HISTFILE=~/.bash_history
HISTSIZE=100000
HISTFILESIZE=200000
HISTCONTROL=ignoreboth
HISTIGNORE="ls:cd:pwd:exit:date:* --help"
HISTTIMEFORMAT="%F %T "
shopt -s histappend

if [[ $- == *i* ]]; then
  stty -ixon
  bind -x '"\C-s":tmux-sessionizer -c'
fi

open_with_proxy() {
  HTTP_PROXY=http://127.0.0.1:10808 \
  HTTPS_PROXY=http://127.0.0.1:10808 \
  command "$@"
}

export EDITOR="/usr/local/bin/nvim"

alias p="open_with_proxy"
alias open="xdg-open"
alias py="uv run python"
alias vim="nvim"
alias ls="ls -p --group-directories-first --color=always"
alias la="ls -Alhvp --group-directories-first --color=always"
alias share="python3 -m http.server 8000 & sleep 1; ngrok http 8000"
alias cd="z"

gitu() {
    if [ -n "$NVIM" ]; then
        GITU_SHOW_EDITOR="nvim --server $NVIM --remote-tab" command gitu "$@"
    else
        command gitu "$@"
    fi
}

q() {
    local prompt="$@"
    gmn --model gemini-3-flash-preview -p "$prompt"
}

qy() {
    local prompt="$@"
    gmn --model gemini-3.1-pro-preview --yolo -p "$prompt"
}

parse_git_branch() {
    local branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [[ -n $branch ]]; then
        echo ":(${branch})"
    fi
}

if [[ $- == *i* ]]; then
  source /usr/share/git/completion/git-prompt.sh 2>/dev/null || true
  PS1='\w$(parse_git_branch) $ '
  PROMPT_COMMAND="history -a; history -n"
fi

# pnpm
export PNPM_HOME="/home/nnofly/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME/bin:"*) ;;
  *) export PATH="$PNPM_HOME/bin:$PATH" ;;
esac
# pnpm end

eval "$(zoxide init bash)"
eval "$(fzf --bash)"

# $HOME/.dotfiles/scripts/tm

# Added by Antigravity CLI installer
export PATH="/home/nnofly/.local/bin:$PATH"
