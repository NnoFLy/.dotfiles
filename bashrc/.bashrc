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
  # bind -x '"\C-s":tmux-sessionizer -c'
  bind -x '"\C-s":zi'
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
alias h="herdr"

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

eval "$(zoxide init bash)"
eval "$(fzf --bash)"

# pnpm
export PNPM_HOME="/home/nnofly/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME/bin:"*) ;;
  *) export PATH="$PNPM_HOME/bin:$PATH" ;;
esac
# pnpm end

# Added by Antigravity CLI installer
export PATH="/home/nnofly/.local/bin:$PATH"

# fnm
FNM_PATH="/home/nnofly/.local/share/fnm"
if [ -d "$FNM_PATH" ]; then
  export PATH="$FNM_PATH:$PATH"
  eval "$(fnm env --shell bash)"
fi

# Sync terminal proxy with GNOME settings (including SOCKS)
gsettings_sync_proxy() {
    local mode=$(gsettings get org.gnome.system.proxy mode | tr -d "'")
    if [ "$mode" = "manual" ]; then
        # HTTP/HTTPS Proxy
        local http_host=$(gsettings get org.gnome.system.proxy.http host | tr -d "'")
        local http_port=$(gsettings get org.gnome.system.proxy.http port)
        if [ -n "$http_host" ] && [ "$http_port" -ne 0 ]; then
            export http_proxy="http://$http_host:$http_port/"
            export https_proxy="http://$http_host:$http_port/"
            export HTTP_PROXY="$http_proxy"
            export HTTPS_PROXY="$https_proxy"
        fi

        # SOCKS Proxy
        local socks_host=$(gsettings get org.gnome.system.proxy.socks host | tr -d "'")
        local socks_port=$(gsettings get org.gnome.system.proxy.socks port)
        if [ -n "$socks_host" ] && [ "$socks_port" -ne 0 ]; then
            export socks_proxy="socks5://$socks_host:$socks_port/"
            export SOCKS_PROXY="$socks_proxy"
            # Optional: Fallback for tools that do not support socks_proxy directly
            export all_proxy="socks5://$socks_host:$socks_port/"
            export ALL_PROXY="$all_proxy"
        fi
    elif [ "$mode" = "none" ]; then
        unset http_proxy https_proxy ftp_proxy no_proxy socks_proxy all_proxy HTTP_PROXY HTTPS_PROXY FTP_PROXY NO_PROXY SOCKS_PROXY ALL_PROXY
    fi
}
gsettings_sync_proxy
