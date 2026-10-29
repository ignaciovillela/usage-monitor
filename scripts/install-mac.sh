#!/bin/bash
# Instala Usage Monitor en macOS (Apple Silicon) desde el último release de GitHub.
#
# Uso:  curl -fsSL https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-mac.sh | bash
#
# Qué hace (léelo antes de ejecutarlo, es corto):
#   1. busca en GitHub el .dmg del release más reciente y lo descarga con curl a una carpeta temporal;
#   2. lo monta, copia "Usage Monitor.app" a /Applications y lo desmonta;
#   3. abre la app.
# Por qué no aparece el bloqueo de macOS: macOS marca como "descargado de internet" lo que bajan los navegadores,
# no lo que baja curl. Este script no modifica ningún atributo de seguridad ni usa sudo.
# Variables: INSTALL_DIR (por defecto /Applications), OPEN=0 para no abrir la app al terminar.
set -euo pipefail

REPO="ignaciovillela/usage-monitor"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
APP="Usage Monitor.app"

[ "$(uname -s)" = "Darwin" ] || { echo "Este instalador es solo para macOS." >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "Los instaladores publicados son para Apple Silicon. En Mac Intel, compila desde el código fuente (ver README)." >&2; exit 1; }

TMP="$(mktemp -d)"
MNT="$TMP/mnt"
cleanup() { hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "Buscando la última versión…"
URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=10" \
  | grep -o '"browser_download_url": *"[^"]*macos-arm64\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$URL" ] || { echo "No encontré un instalador de macOS en https://github.com/$REPO/releases" >&2; exit 1; }
echo "Descargando $(basename "$URL")…"
curl -fL --progress-bar -o "$TMP/app.dmg" "$URL"

mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$TMP/app.dmg" -quiet
[ -d "$MNT/$APP" ] || { echo "El instalador no contiene $APP." >&2; exit 1; }

if pgrep -f "$INSTALL_DIR/$APP/Contents/MacOS/" >/dev/null 2>&1; then     # solo la copia que se va a reemplazar
  echo "Cerrando la versión instalada, que está abierta…"
  osascript -e 'quit app "Usage Monitor"' >/dev/null 2>&1 || true
  sleep 2
fi
mkdir -p "$INSTALL_DIR"
rm -rf "${INSTALL_DIR:?}/$APP"
ditto "$MNT/$APP" "$INSTALL_DIR/$APP"
echo "Instalado en $INSTALL_DIR/$APP"

if [ "${OPEN:-1}" = "1" ]; then open "$INSTALL_DIR/$APP"; echo "Abriendo Usage Monitor… inicia sesión en claude.ai en la ventana que aparece."; fi
