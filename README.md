# Dotfiles

## Setup on a new machine

These scripts target Arch Linux and use `pacman`, `yay`, and GNU Stow.

Clone the repository and run the complete setup:

```bash
git clone git@github.com:NnoFLy/.dotfiles ~/.dotfiles
cd ~/.dotfiles
./setup.sh
```

The complete setup installs base packages, configures Neovim, installs additional apps, and links the dotfiles into `$HOME`. The `pi` and `codex` `AGENTS.md` files both use the shared copy at `pi/.pi/agent/AGENTS.md`.

To run only part of the setup:

```bash
./setup.sh base    # Install system dependencies
./setup.sh config  # Link the dotfiles
./setup.sh nvim    # Install Neovim and its configuration
./setup.sh utils   # Install additional applications
```
