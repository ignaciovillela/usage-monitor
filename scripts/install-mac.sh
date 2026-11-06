#!/bin/bash
# Instala Usage Monitor en macOS (Apple Silicon) desde el último release de GitHub.
#
# Uso:  curl -fsSL https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-mac.sh | bash
#
# Qué hace (léelo antes de ejecutarlo, es corto):
#   1. busca en GitHub el .dmg del release más reciente y lo descarga con curl a una carpeta temporal;
#   2. lo monta, copia "Usage Monitor.app" a /Applications (primero al lado y después reemplaza la anterior) y lo desmonta;
#   3. abre la app.
# Por qué no aparece el bloqueo de macOS: macOS marca como "descargado de internet" lo que bajan los navegadores,
# no lo que baja curl. Este script no modifica ningún atributo de seguridad ni usa sudo.
# Variables: INSTALL_DIR (por defecto /Applications), OPEN=0 para no abrir la app al terminar.
# Las usa la app al pulsar «Actualizar ahora» (ella descarga el .dmg con barra de progreso y comprueba su sha256):
#   DMG=<archivo>       instalar ese .dmg en vez de buscar y descargar.
#   WAIT_PID=<pid>      esperar a que la app se cierre antes de reemplazarla.
#   RELAUNCH=<app>      si algo falla, abrir esta app (la versión que se estaba usando).
#   ERROR_LOG=<archivo> si algo falla, dejar ahí el error (la app lo muestra al volver a abrirse).
set -euo pipefail

REPO="ignaciovillela/usage-monitor"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
APP="Usage Monitor.app"
DMG="${DMG:-}"
WAIT_PID="${WAIT_PID:-}"

TMP="$(mktemp -d)"
MNT="$TMP/mnt"
NEW="$INSTALL_DIR/.$APP.new"
cleanup() {
  hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP" "$NEW"
  if [ -n "$DMG" ]; then rm -f "$DMG"; fi
}
trap cleanup EXIT
fail() {
  echo "$1" >&2
  if [ -n "${ERROR_LOG:-}" ]; then printf '%s\n' "$1" > "$ERROR_LOG" || true; fi
  if [ -n "${RELAUNCH:-}" ] && [ -d "$RELAUNCH" ]; then open "$RELAUNCH" || true; fi
  exit 1
}
trap 'fail "La instalación falló (línea $LINENO)."' ERR

[ "$(uname -s)" = "Darwin" ] || fail "Este instalador es solo para macOS."
[ "$(uname -m)" = "arm64" ] || fail "Los instaladores publicados son para Apple Silicon. En Mac Intel, compila desde el código fuente (ver README)."

if [ -n "$DMG" ]; then
  [ -f "$DMG" ] || fail "No existe el archivo de la actualización: $DMG"
else
  echo "Buscando la última versión…"
  URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=10" \
    | grep -o '"browser_download_url": *"[^"]*macos-arm64\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$URL" ] || fail "No encontré un instalador de macOS en https://github.com/$REPO/releases"
  echo "Descargando $(basename "$URL")…"
  curl -fL --progress-bar -o "$TMP/app.dmg" "$URL"
  DMG_FILE="$TMP/app.dmg"
fi

mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "${DMG_FILE:-$DMG}" -quiet || fail "No se pudo abrir el instalador .dmg."
[ -d "$MNT/$APP" ] || fail "El instalador no contiene $APP."

# Copia primero al lado: si algo falla aquí, la versión anterior sigue intacta.
mkdir -p "$INSTALL_DIR"
rm -rf "$NEW"
ditto "$MNT/$APP" "$NEW" || fail "No se pudo copiar la app a $INSTALL_DIR."

if [ -n "$WAIT_PID" ]; then
  for _ in $(seq 1 60); do kill -0 "$WAIT_PID" 2>/dev/null || break; sleep 1; done     # la app se está cerrando
fi
if pgrep -f "$INSTALL_DIR/$APP/Contents/MacOS/" >/dev/null 2>&1; then     # solo la copia que se va a reemplazar
  echo "Cerrando la versión instalada, que está abierta…"
  osascript -e 'quit app "Usage Monitor"' >/dev/null 2>&1 || true
  sleep 2
fi
rm -rf "${INSTALL_DIR:?}/$APP"
mv "$NEW" "$INSTALL_DIR/$APP" || fail "No se pudo reemplazar $INSTALL_DIR/$APP."
echo "Instalado en $INSTALL_DIR/$APP"

if [ "${OPEN:-1}" = "1" ]; then open "$INSTALL_DIR/$APP"; echo "Abriendo Usage Monitor…"; fi
