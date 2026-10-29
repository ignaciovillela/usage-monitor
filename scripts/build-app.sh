#!/bin/bash
# Empaqueta la app como "Usage Monitor.app" (nombre e ícono propios en el Dock).
set -e
cd "$(dirname "$0")/.."
OUT="${OUT_DIR:-dist}"   # OUT_DIR=dist-next evita pisar una app que esté abierta
echo "→ ícono"
USAGE_MONITOR_DATA=/tmp/claude-dock-icon-build npx electron . --make-icon
rm -rf build/icon.iconset && mkdir -p build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon-1024.png --out build/icon.iconset/icon_${s}x${s}.png >/dev/null
  sips -z $((s*2)) $((s*2)) build/icon-1024.png --out build/icon.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
echo "→ app"
ARCH=$(uname -m | sed 's/x86_64/x64/')
npx @electron/packager . "Usage Monitor" --platform=darwin --arch="$ARCH" --icon=build/icon.icns --out="$OUT" --overwrite \
  --app-bundle-id=io.github.ignaciovillela.usage-monitor --ignore='^/(selftest|dist|build|tests|docs|assets|\.github|PRD\.md|README.*|CONTRIBUTING\.md|LICENSE)($|/)'
APP=$(ls -d "$OUT"/*/Usage\ Monitor.app)
codesign --force --deep --sign - "$APP"   # firma ad-hoc: sin esto macOS en Apple Silicon puede negarse a abrirla
echo "Listo: $APP"
