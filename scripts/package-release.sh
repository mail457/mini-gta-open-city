#!/usr/bin/env bash
# Build MINI GTA — OPEN CITY and package a distributable ZIP.
#   release/MINI-GTA-OPEN-CITY-v<version>.zip   (playable build + docs, no node_modules)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NAME="MINI-GTA-OPEN-CITY-v${VERSION}"
OUT="release"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "▶ Type-checking and building…"
npm run build

echo "▶ Staging ${NAME}"
mkdir -p "$OUT" "$STAGE/$NAME"
cp -R dist "$STAGE/$NAME/dist"
cp README.md LICENSE "$STAGE/$NAME/"
cp -R docs "$STAGE/$NAME/docs"
cp -R src "$STAGE/$NAME/src"
cp package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts index.html "$STAGE/$NAME/"
cp -R tests scripts .github "$STAGE/$NAME/"
cp PLAN.md ARCHITECTURE.md TASKS.md TEST_RESULTS.md RELEASE_CHECKLIST.md "$STAGE/$NAME/" 2>/dev/null || true

cat > "$STAGE/$NAME/PLAY.txt" <<'TXT'
MINI GTA — OPEN CITY
====================
How to play (no installation required):

1. Double-click  dist/index.html   (Chrome or Safari).
   - Everything is bundled in dist/; the folder must stay together.

   Best result (avoids some browsers' file:// restrictions on audio/mouse capture):
   open Terminal in this folder and run:
       cd dist && python3 -m http.server 8000
   then open  http://localhost:8000  in your browser.

2. Press PLAY.
3. Controls: WASD move/drive · Mouse look · Shift sprint · Space jump/handbrake
              E enter/exit vehicle · Esc pause · R restart · M mute
4. Mission: meet the courier (gold marker) → get in a car → drive to the drop-off
   downtown before the timer runs out.

Source code, tests and deployment instructions are in this ZIP (see README.md).
TXT

ZIP="$OUT/${NAME}.zip"
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$OLDPWD/$ZIP" "$NAME" -x "*/node_modules/*" )

SIZE=$(du -h "$ZIP" | cut -f1)
echo "✔ $ZIP  ($SIZE)"
echo "  files: $(unzip -Z1 "$ZIP" | wc -l | tr -d " ")"
