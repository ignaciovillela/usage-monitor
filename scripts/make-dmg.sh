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
# Acceso directo a Ajustes del Sistema > Privacidad y seguridad (un .webloc, no un programa: macOS no lo bloquea).
# Hace doble clic -> abre esa pantalla, donde aparece "Abrir de todos modos" tras el primer intento de abrir la app.
cat > "$STAGE/Abrir Privacidad y seguridad.webloc" <<'WEBLOC'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>URL</key>
	<string>x-apple.systempreferences:com.apple.preference.security</string>
</dict>
</plist>
WEBLOC
cat > "$STAGE/Leer primero.txt" <<'TXT'
1. Arrastra "Usage Monitor" a "Applications".
2. Ábrela desde Aplicaciones. Si macOS dice que no puede verificarla, pulsa "Listo".
3. Haz doble clic en "Abrir Privacidad y seguridad.webloc": te lleva a Ajustes del Sistema.
   Baja hasta "Seguridad", pulsa "Abrir de todos modos" junto a Usage Monitor y confirma.
   (La app aún no está firmada ni notarizada por Apple. En macOS anteriores basta clic derecho > Abrir.)
TXT
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "Usage Monitor" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$OUT" >/dev/null
echo "Listo: $OUT"
