// Fuente de uso: Claude Code. Su línea de estado recibe `rate_limits` (solo planes Pro y Max) y un script mínimo lo guarda en un
// archivo local; la app lo lee. No hay sesión, cookies ni tokens de por medio: solo los números que Claude Code ya calculó.
//
// Contrato igual que providers/claude.js: readFeed(file, now) => { utilization 0-100, resetsAt (ms)|null, idle, weekly: [...] }
const fs = require("fs");
const os = require("os");
const path = require("path");

const FEED_DIR = path.join(os.homedir(), ".usage-monitor");
const feedFile = () => process.env.USAGE_MONITOR_FEED || path.join(FEED_DIR, "claude-code.json");

function feedError(message) { const e = new Error(message); e.kind = "nofeed"; return e; }

// resets_at llega en segundos Unix (según la documentación); se acepta también ISO 8601 por si cambia.
function parseReset(value) {
  if (value === null || value === undefined || value === "") return null;
  const ts = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
function parseWindow(w) {
  const utilization = Number(w && w.used_percentage);
  if (!w || !Number.isFinite(utilization)) return null;
  return { utilization: Math.max(0, Math.min(100, utilization)), resetsAt: parseReset(w.resets_at) };
}
// Claude Code deja de enviar una ventana cuando pasa su resets_at; el archivo conserva la última, así que una ventana vencida es "sin uso".
function parseFeed(data, now) {
  const limits = data && data.rate_limits;
  if (!limits || typeof limits !== "object") throw feedError("Claude Code aún no envió límites de uso. Se reciben tras la primera respuesta de una sesión (solo planes Pro y Max).");
  const live = w => w && (w.resetsAt === null || w.resetsAt > now) ? w : null;
  const five = live(parseWindow(limits.five_hour));
  const weekly = Object.keys(limits)
    .filter(key => key.startsWith("seven_day"))
    .map(key => ({ key, ...parseWindow(limits[key]) }))
    .filter(w => Number.isFinite(w.utilization) && live(w));
  return five ? { ...five, idle: false, weekly } : { utilization: 0, resetsAt: null, idle: true, weekly };
}
function readFeed(file, now) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (_) { throw feedError("Falta conectar Claude Code: menú › «Conectar con Claude Code…»."); }
  let data;
  try { data = JSON.parse(text); } catch (_) { throw feedError("El archivo de Claude Code no es JSON válido."); }
  return parseFeed(data, now);
}

// Script que Claude Code ejecuta como línea de estado. Solo guarda `rate_limits` y, si se le pasa un comando, se lo reenvía
// para no perder la línea de estado que ya tengas.
const FEED_SCRIPT = `#!/bin/sh
# Usage Monitor: guarda los límites de uso que Claude Code pasa a la línea de estado.
# Uso: statusline-feed.sh [tu comando de línea de estado actual]
umask 077
FEED="\${USAGE_MONITOR_FEED:-$HOME/.usage-monitor/claude-code.json}"
mkdir -p "$(dirname "$FEED")"
IN=$(cat)
if printf '%s' "$IN" | grep -q '"rate_limits"'; then
  TMP="$FEED.$$"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$IN" | jq -c '{rate_limits: .rate_limits}' > "$TMP" 2>/dev/null
  else
    printf '%s' "$IN" > "$TMP"
  fi
  if [ -s "$TMP" ]; then mv "$TMP" "$FEED"; else rm -f "$TMP"; fi
fi
if [ $# -gt 0 ]; then printf '%s' "$IN" | sh -c "$*"; fi
`;
const scriptFile = () => path.join(FEED_DIR, "statusline-feed.sh");
function installScript() {
  fs.mkdirSync(FEED_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(scriptFile(), FEED_SCRIPT, { mode: 0o700 });
  return scriptFile();
}

module.exports = { readFeed, parseFeed, feedFile, installScript, scriptFile, FEED_SCRIPT };
