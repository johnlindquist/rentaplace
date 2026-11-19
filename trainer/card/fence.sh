#!/bin/sh
# The Fence: syntax of every module, types of the shared rules, and the tests.
set -e
cd "$(dirname "$0")"
for f in main.js nav.js frame.js drafts.mjs settings.mjs; do node --check "$f"; done
if command -v tsc >/dev/null 2>&1; then tsc=tsc
elif [ -x ../../node_modules/.bin/tsc ]; then tsc=../../node_modules/.bin/tsc
else echo "fence: TypeScript is missing" >&2; exit 1; fi
"$tsc" --noEmit --allowJs --checkJs --strict --noImplicitAny false --target ES2022 --module ES2022 --lib ES2022 --typeRoots ./no-ambient-types nav.js frame.js
node --disable-warning=ExperimentalWarning --test test/*.test.mjs
echo "fence: ok"
