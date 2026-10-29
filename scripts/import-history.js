// Importa un CSV exportado desde el panel (o desde la versión con extensión) a los datos de la app.
// Uso (con la app CERRADA): node scripts/import-history.js <usage-monitor-....csv>
// Hace copia de seguridad de lo que hubiera y no toca nada más.
const fs = require("fs");
const os = require("os");
const path = require("path");
const engine = require("../src/engine");
const { buildPersisted } = require("../src/importer");

const files = process.argv.slice(2);
if (!files.length) { console.error("Uso: node scripts/import-history.js archivo.csv [otro.csv]"); process.exit(1); }
const dir = path.join(os.homedir(), "Library", "Application Support", "Usage Monitor");
fs.mkdirSync(dir, { recursive: true });
const dataFile = path.join(dir, "usage-data.json"), settingsFile = path.join(dir, "settings.json");

const { persisted, summary } = buildPersisted(files);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const f of [dataFile, settingsFile]) if (fs.existsSync(f)) { fs.copyFileSync(f, `${f}.bak-${stamp}`); console.log("copia de seguridad:", `${path.basename(f)}.bak-${stamp}`); }

fs.writeFileSync(dataFile, JSON.stringify({
  samples: persisted.samples.map(engine.packSample), blocks: persisted.blocks, model: persisted.model,
  windows: persisted.windows, forecastLog: persisted.forecastLog, state: persisted.state
}));
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch (_) { /* sin ajustes previos */ }
console.log("Importado:", JSON.stringify(summary, null, 1));
