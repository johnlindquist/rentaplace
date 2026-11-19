#!/bin/sh
# Copies the Drafts card into a Herdr app's mods folder ($HERDR_APP_HOME, default ~/.config/herdr-app)
# and checks it. Nothing is installed until you run this yourself.
set -e
command -v herdr-app >/dev/null 2>&1 || { echo "install: herdr-app was not found on your PATH. Install the Herdr app first: https://herdr.dev/" >&2; exit 1; }
src="$(cd "$(dirname "$0")" && pwd)"
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
mkdir -p "$mods/drafts"
cp "$src"/main.js "$src"/nav.js "$src"/frame.js "$src"/settings.mjs "$src"/drafts.mjs "$src"/mod.json "$mods/drafts/"
herdr-app check "$mods/drafts"
echo "Installed Drafts into $mods"
