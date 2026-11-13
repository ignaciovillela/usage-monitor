// Persistencia en disco (userData): historial/modelo y ajustes. Se escribe con retardo para no machacar el disco.
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const dataFile = () => path.join(app.getPath("userData"), "usage-data.json");
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

const DEFAULT_SETTINGS = { shape: "donut", mode: "pace", alpha: 0.7, pollSeconds: 20, scope: "window", source: "claude-code", priority: "oauth", connectPrompted: false, alerts: true, numScale: 1, numDx: 0, numDy: 0, remoteUrl: "", remoteUrlOnline: "", remoteToken: "", updateCheck: true, notifiedUpdates: [], updateChannel: "", lastVersion: "", updateSummary: null };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);      // escritura atómica: un corte no deja el archivo a medias
  } catch (e) { console.error("no se pudo guardar", file, e.message); }
}
// `source` solo admite estos valores; los ajustes de la app antigua traen otros (p. ej. "extension") y se descartan.
const SOURCES = ["claude-code", "web", "remote", "oauth", "auto"];
const PRIORITIES = ["oauth", "claude-code", "web"];      // en «auto»: cuál se consulta primero
function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) };
  if (!SOURCES.includes(s.source)) s.source = DEFAULT_SETTINGS.source;
  if (s.scope !== "week") s.scope = "window";
  if (!PRIORITIES.includes(s.priority)) s.priority = DEFAULT_SETTINGS.priority;
  return s;
}
const saveSettings = s => writeJson(settingsFile(), s);
const loadData = () => readJson(dataFile(), null);
const saveData = d => writeJson(dataFile(), d);
module.exports = { loadSettings, saveSettings, loadData, saveData, DEFAULT_SETTINGS };
