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
# Ayudante de primera apertura: abre la app y, si macOS la bloquea, lleva a Privacidad y seguridad.
# No salta Gatekeeper ni toca atributos de cuarentena: la decisión de permitir la app sigue siendo del usuario.
cat > "$STAGE/Si macOS la bloquea, abre esto.command" <<'CMD'
#!/bin/bash
APP="${APP_PATH:-/Applications/Usage Monitor.app}"
pause() { [ -t 0 ] && read -n 1 -s -r -p "Pulsa una tecla para cerrar…"; echo; }
if [ ! -d "$APP" ]; then
  echo "Primero arrastra «Usage Monitor» a la carpeta Applications y vuelve a abrir este archivo."
  pause; exit 1
fi
echo "Abriendo Usage Monitor…"
open "$APP"
for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  if pgrep -x "Usage Monitor" >/dev/null; then echo "Listo: la app está en marcha."; pause; exit 0; fi
done
echo
echo "macOS bloqueó la app (aún no está firmada por Apple). Te llevo a Ajustes del Sistema:"
echo "  1. En «Privacidad y seguridad» baja hasta «Seguridad»."
echo "  2. Pulsa «Abrir de todos modos» junto a «Usage Monitor» y confirma con tu contraseña."
echo "  3. Vuelve a abrir la app desde Aplicaciones."
open "x-apple.systempreferences:com.apple.preference.security"
pause
CMD
chmod +x "$STAGE/Si macOS la bloquea, abre esto.command"
cat > "$STAGE/Leer primero.txt" <<'TXT'
1. Arrastra "Usage Monitor" a "Applications".
2. Ábrela desde Aplicaciones. Si macOS dice que no puede verificarla, haz doble clic en
   "Si macOS la bloquea, abre esto.command": te lleva a Ajustes del Sistema > Privacidad y seguridad,
   donde debes pulsar "Abrir de todos modos" junto a Usage Monitor.
   (La app aún no está firmada ni notarizada por Apple. En macOS anteriores basta clic derecho > Abrir.)
TXT
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "Usage Monitor" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$OUT" >/dev/null
echo "Listo: $OUT"
