#!/bin/bash
# Crea un instalador .dmg "arrastra a Aplicaciones" a partir del .app ya compilado (solo macOS, sin dependencias).
# (Un script .command y un acceso directo .webloc a Ajustes se probaron: macOS bloquea el primero y no abre el segundo con doble clic.)
# Uso: scripts/make-dmg.sh "dist/Usage Monitor-darwin-arm64/Usage Monitor.app" dist/Usage-Monitor-macos-arm64.dmg
set -euo pipefail
APP="${1:?ruta al .app}"
OUT="${2:?ruta del .dmg de salida}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Usage Monitor.app"      # ditto conserva la firma y los atributos
ln -s /Applications "$STAGE/Applications"    # el destino al que se arrastra
cat > "$STAGE/Leer primero.txt" <<'TXT'
1. Arrastra "Usage Monitor" a "Applications".
2. Ábrela. La app no está firmada con un certificado de pago de Apple, así que macOS puede decir que no
   puede verificarla. Para permitirla:
     - Ajustes del Sistema > Privacidad y seguridad > baja hasta "Seguridad" > "Abrir de todos modos"
       (esa opción aparece después de intentar abrirla una vez), o
     - en Terminal:  xattr -dr com.apple.quarantine "/Applications/Usage Monitor.app"
Alternativa sin ningún bloqueo: instalar con una línea en Terminal (ver el README del proyecto en GitHub).
TXT
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "Usage Monitor" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$OUT" >/dev/null
echo "Listo: $OUT"
