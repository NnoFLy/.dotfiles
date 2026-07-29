#!/usr/bin/env bash

set -u

extensions_file="${1:-$HOME/.dotfiles/gnome/extensions.txt}"

if [[ ! -f "$extensions_file" ]]; then
    printf 'Extension list not found: %s\n' "$extensions_file" >&2
    exit 1
fi

while IFS= read -r uuid; do
    # Ignore blank lines and comments.
    [[ -z "$uuid" || "$uuid" == \#* ]] && continue

    if gnome-extensions info "$uuid" &>/dev/null; then
        printf 'Already installed: %s\n' "$uuid"
    else
        printf 'Installing: %s\n' "$uuid"

        gdbus call \
            --session \
            --dest org.gnome.Shell.Extensions \
            --object-path /org/gnome/Shell/Extensions \
            --method org.gnome.Shell.Extensions.InstallRemoteExtension \
            "$uuid"
    fi

    if gnome-extensions info "$uuid" &>/dev/null; then
        gnome-extensions enable "$uuid" || true
    else
        printf 'Could not install: %s\n' "$uuid" >&2
    fi
done < "$extensions_file"

dconf load /org/gnome/ < ~/.dotfiles/gnome/gnome-settings.conf
