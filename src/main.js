// Usage Monitor: ícono dinámico del Dock con el uso de Claude y su proyección hasta el reinicio.
// Lee el uso con tu propia sesión de claude.ai, iniciada en una ventana de la app (sin extensión ni navegador).
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, session, ipcMain, dialog, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const engine = require("./engine");
const { parseUsage, pageScript } = require("./providers/claude");
const claudeCode = require("./providers/claude-code");
const store = require("./store");
const importer = require("./importer");

const SELFTEST = process.argv.includes("--selftest");
const MAKE_ICON = process.argv.includes("--make-icon");   // genera build/icon-1024.png para el .icns de la app
const MOCK = process.env.USAGE_MONITOR_MOCK ? require("./mockfeed") : null;
const ICON_REFRESH_MS = 5000;           // el ícono se redibuja cada pocos segundos (anillo de tiempo y cuentas atrás)
const PAGE_RELOAD_MS = 3 * 60 * 60 * 1000;

app.setName("Usage Monitor");
if (process.platform === "win32") app.setAppUserModelId("io.github.ignaciovillela.usage-monitor");   // necesario para las notificaciones de Windows
if (process.env.USAGE_MONITOR_DATA) app.setPath("userData", process.env.USAGE_MONITOR_DATA);   // para pruebas: otra instancia, otros datos
// Instalación anterior (cuando la app se llamaba "Claude Usage"): se copian historial y ajustes una sola vez.
// La sesión de claude.ai no se copia: hay que iniciarla de nuevo.
if (!process.env.USAGE_MONITOR_DATA && !SELFTEST && !MAKE_ICON && !process.argv.some(x => x.startsWith("--panel-shot="))) {
  try {
    const legacy = path.join(app.getPath("appData"), "Claude Usage"), dest = app.getPath("userData");
    if (!fs.existsSync(path.join(dest, "usage-data.json")) && fs.existsSync(path.join(legacy, "usage-data.json"))) {
      fs.mkdirSync(dest, { recursive: true });
      for (const f of ["usage-data.json", "settings.json"]) if (fs.existsSync(path.join(legacy, f))) fs.copyFileSync(path.join(legacy, f), path.join(dest, f));
    }
  } catch (e) { console.error("no se pudo migrar la instalación anterior:", e.message); }
}
if (!SELFTEST && !MAKE_ICON && !process.argv.some(x => x.startsWith("--panel-shot=")) && !app.requestSingleInstanceLock()) app.quit();

let settings, persisted, win, iconWin, panelWin, tray = null;   // tray: solo en Windows (macOS usa el Dock)
const startedAt = Date.now();
let orgId = null, busy = false, errors = 0, loginShown = false, quitting = false;
let pollTimer = null, saveTimer = null, lastIconKey = "", lastMenuKey = "", renderChain = Promise.resolve();
const STALE_MS = 5 * 60 * 1000;       // sin lecturas nuevas en 5 min: el ícono se pone gris en vez de mostrar un dato viejo
const LOAD_TIMEOUT_MS = 30000;        // si claude.ai no termina de cargar en 30 s, se muestra la ventana y se avisa
const startedConnecting = { at: 0 };

// Estado que se muestra: el último calculado, o un aviso si no hay datos recientes.
function currentState() {
  const st = persisted.state;
  if (st.status === "connected" && !MOCK && Date.now() - (st.updatedAt || 0) > STALE_MS) {
    return { status: "error", error: "Sin lecturas recientes de claude.ai. Abre la ventana de claude.ai desde el menú.", updatedAt: st.updatedAt };
  }
  return st;
}

// ── Datos persistidos ───────────────────────────────────────────────────────
function initPersisted() {
  const d = store.loadData() || {};
  return {
    samples: engine.unpackSamples(d.samples), blocks: d.blocks, model: d.model,
    windows: d.windows || [], forecastLog: d.forecastLog || [], weeklyLog: d.weeklyLog || [], state: d.state || { status: "idle" }
  };
}
const serialize = () => ({
  samples: persisted.samples.map(engine.packSample), blocks: persisted.blocks, model: persisted.model,
  windows: persisted.windows, forecastLog: persisted.forecastLog, weeklyLog: persisted.weeklyLog, state: persisted.state
});
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; store.saveData(serialize()); }, 30000);
}

// ── Consulta a claude.ai desde la página (misma sesión que el navegador) ────
function authError(message) { const e = new Error(message); e.kind = "auth"; return e; }
async function fetchUsageViaPage() {
  const wc = win.webContents;
  if (wc.isLoading()) {
    if (Date.now() - startedConnecting.at > LOAD_TIMEOUT_MS) throw new Error("claude.ai tarda en cargar. Revisa la ventana de claude.ai desde el menú (puede estar pidiendo una verificación).");
    throw new Error("Conectando con claude.ai…");
  }
  let host = "";
  try { host = new URL(wc.getURL()).host; } catch (_) { /* sin URL */ }
  if (host !== "claude.ai") throw authError("Inicia sesión en claude.ai (ventana abierta).");
  let result = await wc.executeJavaScript(pageScript(orgId));
  if (result && result.retryOrg) { orgId = null; result = await wc.executeJavaScript(pageScript(null)); }
  if (!result) throw new Error("Sin respuesta de la página.");
  if (result.auth) throw authError("Sesión no disponible: inicia sesión en la ventana de claude.ai.");
  if (result.error) throw new Error(result.error);
  orgId = result.orgId;
  return parseUsage(result.data);
}

// ── Ciclo de consulta ───────────────────────────────────────────────────────
async function tick() {
  if (busy) return;
  busy = true;
  const now = Date.now();
  try {
    const usage = MOCK ? MOCK.next() : settings.source === "claude-code" ? claudeCode.readFeed(claudeCode.feedFile(), now) : await fetchUsageViaPage();
    const res = engine.step(persisted, usage, now, { engine: "prob" });
    persisted = res.persisted;
    if (loginShown && win && win.isVisible()) win.hide();      // ya hay datos: la ventana de inicio de sesión se oculta sola
    errors = 0; loginShown = false;
    if (settings.alerts) res.events.forEach(notify);
    saveSoon();
  } catch (e) {
    errors++;
    persisted.state = { ...persisted.state, status: e.kind === "auth" ? "auth" : "error", error: e.message || String(e), updatedAt: now };
    // Sin sesión, o dos fallos seguidos: se muestra la ventana de claude.ai para iniciar sesión o completar una verificación.
    if (settings.source !== "claude-code" && (e.kind === "auth" || errors >= 2) && !loginShown) { loginShown = true; showLogin(); }
  } finally {
    busy = false;
    await render(true);
    refreshChrome();
    notifyPanel();
    schedule();
  }
}
// Con errores se espacia la consulta (hasta 5 min) para no insistir contra el servidor.
function schedule() {
  clearTimeout(pollTimer);
  const base = Math.max(5, Number(process.env.USAGE_MONITOR_POLL) || settings.pollSeconds) * 1000;
  pollTimer = setTimeout(tick, errors ? Math.min(300000, base * 2 ** Math.min(errors, 5)) : base);
}

function notify(e) {
  const fmt = engine;
  if (e.type === "threshold") {
    new Notification({ title: `Claude: ${e.threshold}% de uso`, body: `El uso de la ventana de cinco horas ha llegado al ${e.percent.toFixed(1)}%.` }).show();
  } else if (e.type === "projection") {
    const odds = e.prob !== null ? `Probabilidad ${Math.round(e.prob * 100)} % de llegar al 100 %: ` : "A este ritmo llegarás al 100 % ";
    new Notification({ title: "Claude: límite cerca", body: `${odds}mediana a las ${fmt.fmtClock(e.hitAt)} (en ${fmt.fmtDuration(e.minutesToHit)}), antes del reinicio de las ${fmt.fmtClock(e.resetsAt)}.` }).show();
  }
}

// ── Ícono del Dock ──────────────────────────────────────────────────────────
function iconParamsNow() {
  const now = Date.now(), state = currentState();
  const { level, text } = engine.badgeInfo(state, settings.mode, now);
  return { level, text, params: engine.iconParams(state, level, now, text, settings.shape, "255,255,255", settings.alpha, { scale: settings.numScale, dx: settings.numDx, dy: settings.numDy }) };
}
async function drawDockIcon(params, size = 512) {
  const dataUrl = await iconWin.webContents.executeJavaScript(`renderIcon(${JSON.stringify(params)}, ${size})`);
  return nativeImage.createFromDataURL(dataUrl);
}
// Solo se redibuja si algo visible cambió; las llamadas se encadenan para no solaparse.
function render(force) {
  renderChain = renderChain.then(async () => {
    try {
      const { level, text, params } = iconParamsNow();
      const key = [level, text, settings.shape, settings.alpha, settings.numScale, settings.numDx, settings.numDy, Math.round(params.usage * 1000), Math.round(params.elapsed * 2000)].join("|");
      if (!force && key === lastIconKey) return;
      lastIconKey = key;
      if (process.env.USAGE_MONITOR_DEBUG) console.log(new Date().toISOString().slice(11, 23), "ícono", key);
      const img = await drawDockIcon(params);
      if (app.dock) app.dock.setIcon(img);
      if (tray) tray.setImage(img.resize({ width: 32, height: 32, quality: "best" }));
    } catch (e) { console.error("no se pudo dibujar el ícono:", e.message); }
  });
  return renderChain;
}

// ── Menú del Dock y ventana de estado ───────────────────────────────────────
function statusLines() {
  const s = currentState(), now = Date.now(), lines = [];
  if (s.status === "connected") {
    const parts = engine.projectionParts(s, now);
    lines.push(`Uso ${engine.fmtPct(s.utilization)}${Number.isFinite(s.resetsAt) ? ` · reinicio ${engine.fmtClock(s.resetsAt)} (en ${engine.fmtReset(s.resetsAt)})` : ""}`);
    lines.push(`${parts.icon} ${parts.headline}`);
    if (parts.detail) lines.push(parts.detail);
    if (parts.why) lines.push(parts.why);
    for (const w of s.weekly || []) lines.push(`${engine.weeklyLabel(w.key)} ${engine.fmtPct(w.utilization, 0)}`);
  } else if (s.status === "auth") lines.push("Inicia sesión en claude.ai (ventana abierta)");
  else lines.push(s.error || "Conectando con claude.ai…");
  return lines;
}
const radio = (items, current, set) => items.map(([label, value]) => ({ label, type: "radio", checked: current === value, click: () => set(value) }));
function updateSetting(key, value) {
  settings = { ...settings, [key]: value };
  store.saveSettings(settings);
  if (key === "pollSeconds") schedule();
  if (key === "source") { errors = 0; loginShown = false; if (value === "web" && !win) createSessionWindow(); tick(); }
  render(true); refreshChrome(true);
}
function menuTemplate() {
  const lines = statusLines().map(label => ({ label, enabled: false }));
  if (persisted.state.status === "auth") lines[0] = { label: "Inicia sesión en claude.ai…", click: showLogin };
  return [
    ...lines, { type: "separator" },
    { label: "Abrir panel (gráficos y ajustes)", click: showPanel },
    { label: "Actualizar ahora", click: () => tick() },
    { label: "Forma del ícono", submenu: radio([["Dos anillos", "rings"], ["Donut + anillo de tiempo", "donut"], ["Torta 1 (uso)", "pie1"], ["Torta 2 (uso + anillo de tiempo)", "pie2"], ["Torta 3 (uso + torta de tiempo)", "pie3"]], settings.shape, v => updateSetting("shape", v)) },
    { label: "Qué muestra el número", submenu: radio([["Veredicto (solo si hay riesgo)", "pace"], ["Probabilidad de agotarlo", "prob"], ["Porcentaje de uso", "percent"], ["Tiempo hasta el límite", "limit"], ["Tiempo hasta el reinicio", "reset"]], settings.mode, v => updateSetting("mode", v)) },
    { label: "Transparencia del número", submenu: radio([["30 %", 0.3], ["50 %", 0.5], ["70 %", 0.7], ["90 %", 0.9], ["100 %", 1]], settings.alpha, v => updateSetting("alpha", v)) },
    { label: "Fuente de datos", submenu: radio([["claude.ai (ventana propia)", "web"], ["Claude Code (línea de estado)", "claude-code"]], settings.source, v => updateSetting("source", v)) },
    { label: "Conectar con Claude Code…", click: connectClaudeCode },
    { label: "Frecuencia de consulta", submenu: radio([["Cada 10 s", 10], ["Cada 20 s", 20], ["Cada 30 s", 30], ["Cada 60 s", 60]], settings.pollSeconds, v => updateSetting("pollSeconds", v)) },
    { type: "separator" },
    { label: "Alertas", type: "checkbox", checked: settings.alerts, click: m => updateSetting("alerts", m.checked) },
    { label: "Abrir al iniciar sesión", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: m => app.setLoginItemSettings({ openAtLogin: m.checked }) },
    { label: "Ventana de claude.ai…", click: showLogin },
    ...(canSetup() && !app.isInApplicationsFolder() ? [{ label: "Mover a Aplicaciones…", click: () => offerMove(true) }] : [])
  ];
}
function refreshChrome(force) {
  const key = statusLines().join("|") + JSON.stringify(settings);
  if (!force && key === lastMenuKey) return;      // el menú solo se reconstruye si cambió algo
  lastMenuKey = key;
  if (app.dock) app.dock.setMenu(Menu.buildFromTemplate(menuTemplate()));
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}
// Tamaño de las ventanas: el que se quiere, acotado al área útil de la pantalla (portátiles de poca altura).
// USAGE_MONITOR_PANEL_SIZE=ANCHOxALTO fuerza un tamaño (para capturas de prueba).
function fitToScreen(width, height) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { width: Math.min(width, Math.max(340, wa.width - 40)), height: Math.min(height, Math.max(420, wa.height - 40)) };
}
function panelBounds() {
  const forced = /^(\d+)x(\d+)$/.exec(process.env.USAGE_MONITOR_PANEL_SIZE || "");
  return forced ? { width: +forced[1], height: +forced[2] } : fitToScreen(460, 900);
}
// Panel: el popup (gráficos, ajustes) dentro de una ventana, con los datos de la app en lugar de chrome.storage.
function showPanel() {
  if (!panelWin || panelWin.isDestroyed()) {
    panelWin = new BrowserWindow({
      ...panelBounds(), useContentSize: true, minWidth: 340, minHeight: 420, title: "Usage Monitor", backgroundColor: "#0d0d0d",
      webPreferences: { preload: path.join(__dirname, "panel-preload.js"), contextIsolation: false }
    });
    panelWin.on("closed", () => { panelWin = null; });
    if (process.env.USAGE_MONITOR_DEBUG) panelWin.webContents.on("console-message", (_e, level, message, line, source) => console.log("panel:", level, message, `(${path.basename(source)}:${line})`));
    panelWin.loadFile(path.join(__dirname, "..", "renderer", "panel", "popup.html"));
  }
  panelWin.show(); panelWin.focus();
}
function notifyPanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  panelWin.webContents.send("storage-changed", { usageState: { newValue: currentState() }, usageSamples: { newValue: panelSamples() } });
}
const panelSamples = () => persisted.samples.map(engine.packSample);
// Lo que el popup lee de "chrome.storage.local" (ver panel-preload.js), armado con los datos de la app.
function storageSnapshot() {
  return {
    usageState: currentState(), usageSamples: panelSamples(),
    usageWindows: persisted.windows, usageForecastLog: persisted.forecastLog, usageBlocks: persisted.blocks || [],
    usageWeekly: persisted.weeklyLog,
    appVersion: app.getVersion(),
    alertsEnabled: settings.alerts, badgeMode: settings.mode, iconShape: settings.shape, numberAlpha: settings.alpha,
    numberScale: settings.numScale, numberDx: settings.numDx, numberDy: settings.numDy,
    badgeStyle: "inside", numberInk: "auto", projectionEngine: "prob"
  };
}
const SETTING_KEYS = { alertsEnabled: "alerts", badgeMode: "mode", iconShape: "shape", numberAlpha: "alpha", numberScale: "numScale", numberDx: "numDx", numberDy: "numDy" };
ipcMain.handle("storage-get", (_e, keys) => {
  const all = storageSnapshot();
  if (keys == null) return all;
  const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
  return Object.fromEntries(list.filter(k => k in all).map(k => [k, all[k]]));
});
ipcMain.handle("storage-set", (_e, obj) => { for (const [k, v] of Object.entries(obj || {})) if (SETTING_KEYS[k]) updateSetting(SETTING_KEYS[k], v); });
ipcMain.handle("storage-remove", () => undefined);
ipcMain.handle("runtime-message", async (_e, message) => {
  if (message && message.type === "IMPORT_CSV") return importCsv();
  if (message && message.type === "POLL_NOW") tick();
  return { ok: true };
});
// Importar historial: el usuario elige uno o más CSV exportados desde el panel; se fusionan con los datos actuales.
async function importCsv() {
  const parent = panelWin && !panelWin.isDestroyed() ? panelWin : undefined;
  const r = await dialog.showOpenDialog(parent, { title: "Importar historial", properties: ["openFile", "multiSelections"], filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  try {
    const { persisted: merged, summary } = importer.mergeImport(persisted, r.filePaths);
    persisted = merged;
    store.saveData(serialize());
    render(true); refreshChrome(); notifyPanel();
    return { ok: true, summary };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}
// No se edita ~/.claude/settings.json por el usuario: se instala el script y se le muestra la línea a pegar (con o sin línea de estado previa).
async function connectClaudeCode() {
  const script = claudeCode.installScript();
  const snippet = JSON.stringify({ statusLine: { type: "command", command: script } }, null, 2);
  const r = await dialog.showMessageBox({
    type: "info", buttons: ["Copiar configuración", "Cerrar"], defaultId: 0, cancelId: 1, title: "Conectar con Claude Code",
    message: "Añade esto a ~/.claude/settings.json",
    detail: `${snippet}\n\nSi ya tienes una línea de estado, pon tu comando a continuación del script y se conservará:\n"command": "${script} <tu comando>"\n\nSolo funciona con planes Pro y Max, y los datos llegan tras la primera respuesta de cada sesión de Claude Code.`
  });
  if (r.response === 0) require("electron").clipboard.writeText(snippet);
}
function showLogin() { if (win) { win.show(); win.focus(); } }

// ── Ventanas ────────────────────────────────────────────────────────────────
function createSessionWindow() {
  const ses = session.fromPartition("persist:claude");      // las cookies de claude.ai se conservan entre ejecuciones
  win = new BrowserWindow({ ...fitToScreen(1000, 760), minWidth: 480, minHeight: 420, show: false, title: "claude.ai", webPreferences: { partition: "persist:claude", backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: "allow" }));   // el inicio de sesión con Google abre una ventana
  win.on("close", e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.on("did-finish-load", () => { if (!busy && !MOCK) setTimeout(tick, 1500); });
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;      // -3: navegación cancelada (normal al redirigir)
    errors++;
    persisted.state = { ...persisted.state, status: "error", error: `No se pudo cargar claude.ai (${desc}). ¿Hay conexión a internet?`, updatedAt: Date.now() };
    refreshChrome(); notifyPanel();
  });
  startedConnecting.at = Date.now();
  win.loadURL("https://claude.ai/");
  schedule();       // aunque la página no termine de cargar, se sigue intentando y avisando
  setInterval(() => { if (!win.isVisible()) win.webContents.reload(); }, PAGE_RELOAD_MS);
}
function createIconWindow() {
  iconWin = new BrowserWindow({ show: false, width: 600, height: 600, webPreferences: { backgroundThrottling: false } });
  return iconWin.loadFile(path.join(__dirname, "..", "renderer", "icon.html"));
}

// ── Prueba sin red: simula una hora de uso, comprueba el modelo y guarda los íconos como PNG ──
async function selftest() {
  const outDir = path.join(__dirname, "..", "selftest", "out");
  fs.mkdirSync(outDir, { recursive: true });
  const results = {};
  let ok = true;
  const base = new Date(2026, 9, 28, 10, 0, 0).getTime();
  const scenarios = { tranquilo: t => 4 + t * 0.08, intenso: t => 4 + (t < 20 ? t * 0.2 : 4 + (t - 20) * 1.1), "sin-ventana": () => null };
  for (const [name, fn] of Object.entries(scenarios)) {
    let p = { samples: [], windows: [], forecastLog: [], state: { status: "idle" } };
    for (let t = 0; t <= 60; t++) {
      const u = fn(t), now = base + t * 60000;
      const usage = u === null ? { utilization: 0, resetsAt: null, idle: true, weekly: [] }
        : { utilization: Math.min(100, +u.toFixed(2)), resetsAt: base + 140 * 60000, idle: false, weekly: [{ key: "seven_day", utilization: 41, resetsAt: base + 3 * 864e5 }] };
      p = engine.step(p, usage, now, { engine: "prob" }).persisted;
    }
    const now = base + 60 * 60000, state = p.state;
    const { level, text } = engine.badgeInfo(state, "pace", now);
    results[name] = { util: state.utilization, level, text, pHit: state.forecast ? state.forecast.pHit : null };
    if (name !== "sin-ventana" && !state.forecast) ok = false;
    for (const shape of ["rings", "donut", "pie1", "pie2", "pie3"]) {
      const params = engine.iconParams(state, level, now, text, shape, "255,255,255", 0.7);
      const img = await drawDockIcon(params);
      const size = img.getSize();
      if (size.width !== 512) ok = false;
      fs.writeFileSync(path.join(outDir, `${name}-${shape}.png`), img.toPNG());
    }
  }
  if (app.dock) app.dock.setIcon(await drawDockIcon(engine.iconParams({ status: "connected", utilization: 62, resetsAt: base + 7e6 }, "warn", base, "62", "donut", "255,255,255", 0.7)));
  console.log(JSON.stringify({ ok, results }, null, 1));
  app.exit(ok ? 0 : 1);
}

// Captura el panel con datos generados por el modelo (sin red): node . --panel-shot=archivo.png
async function panelShot(file) {
  const base = Date.now() - 180 * 60000;
  let p = { samples: [], windows: [], forecastLog: [], state: { status: "idle" } };
  for (let t = 0; t <= 180; t++) {
    const u = 4 + (t < 60 ? t * 0.12 : t < 120 ? 7.2 + (t - 60) * 0.45 : 34.2 + (t - 120) * 0.95);
    p = engine.step(p, { utilization: Math.min(100, +u.toFixed(1)), resetsAt: base + 300 * 60000, idle: false,
      weekly: [{ key: "seven_day", utilization: 41, resetsAt: base + 3.5 * 864e5 }] }, base + t * 60000, { engine: "prob" }).persisted;
  }
  persisted = p;
  showPanel();
  await new Promise(r => setTimeout(r, 3500));
  if (process.env.USAGE_MONITOR_OPEN) { await panelWin.webContents.executeJavaScript(`document.querySelector("details").open = true; window.scrollTo(0, 9999)`); await new Promise(r => setTimeout(r, 600)); }
  fs.writeFileSync(file, (await panelWin.webContents.capturePage()).toPNG());
  app.exit(0);
}

// ── Primera ejecución: carpeta Aplicaciones e inicio automático ─────────────
// Solo con la app empaquetada y sin datos de prueba (así las pruebas no abren diálogos ni tocan los ajustes de inicio).
const canSetup = () => process.platform === "darwin" && app.isPackaged && !process.env.USAGE_MONITOR_DATA;
function saveFlag(key, value) { settings = { ...settings, [key]: value }; store.saveSettings(settings); }
async function offerMove(manual) {
  if (!canSetup() || app.isInApplicationsFolder()) return false;
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: "question", buttons: ["Mover a Aplicaciones", "Ahora no"], defaultId: 0, cancelId: 1,
    message: "¿Mover Usage Monitor a la carpeta Aplicaciones?",
    detail: "Así queda instalada como cualquier otra app y el inicio automático apunta a un lugar estable. La app se reiniciará.",
    checkboxLabel: "No volver a preguntar", checkboxChecked: false
  });
  if (response === 0) {
    try { return app.moveToApplicationsFolder(); }     // cierra y vuelve a abrir la copia movida
    catch (e) { dialog.showErrorBox("No se pudo mover la app", String(e.message || e)); }
  } else if (checkboxChecked && !manual) saveFlag("moveDeclined", true);
  return false;
}
async function firstRunSetup() {
  if (!canSetup()) return;
  if (!app.isInApplicationsFolder() && !settings.moveDeclined) {
    if (await offerMove(false)) return;                // se movió: la copia nueva repite esta rutina ya en Aplicaciones
  }
  // Inicio automático: se activa la primera vez; después se respeta lo que elijas en el menú del Dock.
  if (!settings.loginConfigured) { app.setLoginItemSettings({ openAtLogin: true }); saveFlag("loginConfigured", true); }
}

// ── Arranque ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  settings = store.loadSettings();
  persisted = initPersisted();
  await createIconWindow();
  if (SELFTEST) return selftest();
  const shotArg = process.argv.find(x => x.startsWith("--panel-shot="));
  if (shotArg) return panelShot(shotArg.split("=")[1]);
  if (MAKE_ICON) {
    const now = Date.now();
    const img = await drawDockIcon(engine.iconParams({ status: "connected", utilization: 62, resetsAt: now + 2 * 3600e3 }, "warn", now, "", "donut", "255,255,255", 0.7), 1024);
    const dir = path.join(__dirname, "..", "build");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "icon-1024.png"), img.toPNG());
    for (const n of [16, 32, 48, 64, 128, 256]) fs.writeFileSync(path.join(dir, `icon-${n}.png`), img.resize({ width: n, height: n, quality: "best" }).toPNG());   // para el .ico de Windows
    return app.exit(0);
  }
  if (process.platform === "win32") {
    // Windows no tiene Dock: el ícono dinámico va en la bandeja del sistema; clic abre el panel, clic derecho el menú.
    tray = new Tray((await drawDockIcon(iconParamsNow().params)).resize({ width: 32, height: 32, quality: "best" }));
    tray.setToolTip("Usage Monitor");
    tray.on("click", showPanel);
  }
  await render(true);
  refreshChrome(true);
  if (MOCK || settings.source === "claude-code") tick();
  if (!MOCK && settings.source !== "claude-code") createSessionWindow();
  setInterval(() => { render(false); refreshChrome(); }, ICON_REFRESH_MS);
  firstRunSetup();
  // Clic en el ícono del Dock abre el panel (se ignora el aviso inicial que macOS emite al arrancar).
  app.on("activate", () => { if (Date.now() - startedAt > 4000) showPanel(); });
});
app.on("second-instance", () => { if (app.isReady()) showPanel(); });      // abrir la app otra vez (p. ej. desde el menú Inicio) muestra el panel
app.on("before-quit", () => { quitting = true; store.saveData(serialize()); });
app.on("window-all-closed", () => { /* la app vive en el Dock aunque no haya ventanas */ });
