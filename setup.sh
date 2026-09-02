#!/usr/bin/env bash

mkdir ~/apps/

setup_config() {
    # stow for each config
}

install_emacs() {
}

install_base() {
    sudo pacman -S --needed --noconfirm base-devel cmake ninja curl git 7zip bash-completion
    sudo pacman -S --needed --noconfirm \
        fzf \
        fd \
        ripgrep \
        zoxide \
        jq \
        go \
        uv \
        btop \
        cloc \
        docker \
        docker-compose \
        pass \
        stow \
        tmux \
        wl-clipboard \
        tree-sitter \
        tree-sitter-cli \
        gitu

    git clone https://aur.archlinux.org/yay.git ~/apps/yay/
    cd ~/apps/yay/
    makepkg -si
    cd -

    # Install `node-js/pnpm` https://nodejs.org/en/download/current
    # Download and install fnm:
    sudo pacman -S --needed --noconfirm fnm
    fnm install 26
    node -v # Should print "v26.7.0".
    npm install -g corepack
    corepack enable pnpm
    pnpm -v
}

setup_neovim() {
    git clone git@github.com:i0i-i0i/nvim.git ~/.config/nvim
    git clone https://github.com/neovim/neovim ~/apps/neovim/ --depth 1

    cd ~/apps/neovim/

    make CMAKE_BUILD_TYPE=Release -j$(( $(nproc) - 1))
    sudo make install

    cd -
}

install_apps() {
    yay -S --needed --noconfirm zen-browser-bin happ t3code-bin
}

case "$1" in
    "base") echo 1
        install_base
        ;;
    "neovim" | "nvim")
        setup_neovim
        ;;
    "utils")
        install_apps
        ;;
    *)
        install_base
        setup_neovim
        install_apps
        ;;
esac

