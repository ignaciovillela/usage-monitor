#!/bin/bash
# Crea un instalador .dmg "arrastra a Aplicaciones" a partir del .app ya compilado (solo macOS, sin dependencias).
# Uso: scripts/make-dmg.sh "dist/Usage Monitor-darwin-arm64/Usage Monitor.app" dist/Usage-Monitor-macos-arm64.dmg
set -euo pipefail
APP="${1:?ruta al .app}"
OUT="${2:?ruta del .dmg de salida}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Usage Monitor.app"      # ditto conserva la firma y los atributos
ln -s /Applications "$STAGE/Applications"    # el destino al que se arrastra
cat > "$STAGE/Leer primero.txt" <<'TXT'
Arrastra "Usage Monitor" a "Applications".

La app no está firmada por un desarrollador identificado de Apple (ni notarizada), así que
la primera vez macOS puede negarse a abrirla:
  1. Intenta abrirla una vez (puede decir que no se puede verificar).
  2. Ve a Ajustes del Sistema > Privacidad y seguridad, baja hasta "Seguridad" y pulsa
     "Abrir de todos modos" junto a Usage Monitor.
  (En versiones anteriores de macOS basta con clic derecho > Abrir.)
TXT
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "Usage Monitor" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$OUT" >/dev/null
echo "Listo: $OUT"
