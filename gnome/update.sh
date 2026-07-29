#!/usr/bin/env bash

set -u

gnome-extensions list --user > ./extensions.txt
dconf load /org/gnome/ < ./gnome-settings.conf
