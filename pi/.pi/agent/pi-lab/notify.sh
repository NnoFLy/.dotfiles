#!/usr/bin/env bash
set -euo pipefail

payload=$(cat)
event=$(/usr/sbin/jq -r '.event // ""' <<<"$payload")
title=$(/usr/sbin/jq -r '.title // "Pi"' <<<"$payload")
message=$(/usr/sbin/jq -r '.message // ""' <<<"$payload")
cwd=$(/usr/sbin/jq -r '.cwd // "unknown project"' <<<"$payload")

if [[ $cwd == "$HOME" ]]; then
  project="~"
elif [[ $cwd == "$HOME/"* ]]; then
  project="~/${cwd#"$HOME/"}"
else
  project=$cwd
fi

case "$event" in
  permission_ask)
    urgency=critical
    icon=dialog-warning
    ;;
  *)
    urgency=normal
    icon=dialog-information
    ;;
esac

body=$(printf '%s\n%s' "$message" "$project")
/usr/sbin/notify-send \
  --app-name=Pi \
  --urgency="$urgency" \
  --icon="$icon" \
  -- "$title" "$body" >/dev/null 2>&1 || true
