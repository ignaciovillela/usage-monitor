// Usage Monitor: ícono dinámico del Dock con el uso de Claude y su proyección hasta el reinicio.
// Lee el uso con tu propia sesión de claude.ai, iniciada en una ventana de la app (sin extensión ni navegador).
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, session, ipcMain, dialog, screen, safeStorage, shell, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");
const engine = require("./engine");
const { parseUsage, pageScript } = require("./providers/claude");
const claudeCode = require("./providers/claude-code");
const remote = require("./providers/remote");
const updates = require("./updates");
const store = require("./store");
const importer = require("./importer");

const SELFTEST = process.argv.includes("--selftest");
const MAKE_ICON = process.argv.includes("--make-icon");   // genera build/icon-1024.png para el .icns de la app
const MOCK = process.env.USAGE_MONITOR_MOCK ? require("./mockfeed") : null;
const ICON_REFRESH_MS = 5000;           // el ícono se redibuja cada pocos segundos (anillo de tiempo y cuentas atrás)
const PAGE_RELOAD_MS = 3 * 60 * 60 * 1000;

app.setName("Usage Monitor");
const APP_ID = "io.github.ignaciovillela.usage-monitor";
if (process.platform === "win32") app.setAppUserModelId(APP_ID);   // necesario para las notificaciones de Windows
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
let pollTimer = null, saveTimer = null, lastIconKey = "", lastMenuKey = "", renderChain = Promise.resolve(), taskbarIcon = null;
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

// ── Servidor propio: URL y token (el token se cifra con el llavero del sistema si está disponible) ─────────
// Dos URLs: la local (red de casa) y una online opcional de respaldo; basta con una de las dos.
// USAGE_MONITOR_REMOTE_URL, USAGE_MONITOR_REMOTE_URL_ONLINE y USAGE_MONITOR_REMOTE_TOKEN tienen prioridad sobre los ajustes.
const remoteFromEnv = () => !!(process.env.USAGE_MONITOR_REMOTE_URL || process.env.USAGE_MONITOR_REMOTE_URL_ONLINE);
const remoteUrls = () => remoteFromEnv()
  ? { local: process.env.USAGE_MONITOR_REMOTE_URL || "", online: process.env.USAGE_MONITOR_REMOTE_URL_ONLINE || "" }
  : { local: settings.remoteUrl || "", online: settings.remoteUrlOnline || "" };
const remoteUrl = () => { const u = remoteUrls(); return u.local || u.online; };
let remoteInfo = null;      // { version, via } de la última respuesta del servidor propio
function remoteToken() {
  if (process.env.USAGE_MONITOR_REMOTE_TOKEN) return process.env.USAGE_MONITOR_REMOTE_TOKEN;
  const t = settings.remoteToken || "";
  if (!t.startsWith("enc:")) return t;
  try { return safeStorage.decryptString(Buffer.from(t.slice(4), "base64")); } catch (_) { return ""; }
}
const sealToken = t => !t ? "" : safeStorage.isEncryptionAvailable() ? "enc:" + safeStorage.encryptString(t).toString("base64") : t;
// Desde el panel: guarda URL y token (token vacío = se mantiene el actual) y pasa a esta fuente con una consulta inmediata.
async function setRemote({ url, urlOnline, token, clearToken } = {}) {
  const next = { ...settings };
  if (!remoteFromEnv()) {
    url = String(url || "").trim(); urlOnline = String(urlOnline || "").trim();
    if (!url && !urlOnline) return { ok: false, error: "Escribe la URL local, la online o ambas." };
    for (const u of [url, urlOnline]) if (u && !remote.validUrl(u)) return { ok: false, error: `«${u}» no es válida: debe empezar por http:// o https://.` };
    Object.assign(next, { remoteUrl: url, remoteUrlOnline: urlOnline });
  }
  if (clearToken) next.remoteToken = "";
  else if (token) next.remoteToken = sealToken(String(token).trim());
  settings = { ...next, source: "remote" };
  store.saveSettings(settings);
  errors = 0; loginShown = false;
  await tick({ manual: true });
  const s = persisted.state;
  return s.status === "connected" ? { ok: true } : { ok: false, error: s.error || "Sin datos todavía." };
}

// ── Ciclo de consulta ───────────────────────────────────────────────────────
async function readUsage(now, manual) {
  if (MOCK) return MOCK.next();
  if (settings.source === "claude-code") return claudeCode.readFeed(claudeCode.feedFile(), now);
  if (settings.source === "remote") {
    try {
      const r = await remote.fetchRemote(remoteUrls(), remoteToken(), now, { refresh: manual });
      setRemoteInfo({ version: r.version, via: r.via });
      return r.usage;
    } catch (e) {
      if (e.serverVersion !== undefined) setRemoteInfo({ version: e.serverVersion, via: e.via });   // respondió aunque fuera con error
      throw e;
    }
  }
  return fetchUsageViaPage();
}
function setRemoteInfo(info) {
  const changed = !remoteInfo || remoteInfo.version !== info.version;
  remoteInfo = info;
  if (changed) refreshAdvice();
}

// ── Versiones y actualizaciones ─────────────────────────────────────────────
// Cada 6 h se consulta la lista de releases (se puede desactivar en el panel); los avisos comparan la app,
// el servidor propio (si se usa y dice su versión) y el último release. Cada versión nueva se notifica una sola vez.
const UPDATE_CHECK_MS = 6 * 3600e3;
const releases = updates.repoUrls(require("../package.json"));
let latest = null, updateAdvice = [];
async function checkUpdates() {
  if (!settings.updateCheck || !releases.api || MOCK) return;
  try { latest = await updates.fetchLatest(releases.api, app.getVersion()); }
  catch (e) { console.error("no se pudo consultar las versiones:", e.message); return; }
  refreshAdvice();
}
function refreshAdvice() {
  const serverVersion = settings.source === "remote" && remoteInfo ? remoteInfo.version : null;
  updateAdvice = updates.advice({ appVersion: app.getVersion(), serverVersion, latest: settings.updateCheck ? latest : null, releasesPage: releases.page });
  for (const a of updateAdvice) {
    const key = `${a.kind}@${a.version}`;
    if ((settings.notifiedUpdates || []).includes(key)) continue;
    saveFlag("notifiedUpdates", [...(settings.notifiedUpdates || []), key].slice(-10));
    if (settings.alerts && Notification.isSupported()) {
      const n = new Notification({ title: a.kind === "server" ? "Usage Monitor: actualiza el servidor" : "Usage Monitor: actualización disponible", body: a.text });
      if (a.url) n.on("click", () => openRelease(a.url));
      n.show();
    }
  }
  refreshChrome(true); notifyPanel();
}
// Solo se abren las páginas de releases conocidas (las que vienen en los avisos o la del repositorio).
function openRelease(url) {
  if (url && (url === releases.page || url === releases.repo || updateAdvice.some(a => a.url === url)) && /^https:\/\//.test(url)) shell.openExternal(url);
}
async function tick({ manual = false } = {}) {      // manual: «Actualizar ahora» o la flecha del panel
  if (busy) return;
  busy = true;
  const now = Date.now();
  try {
    if (settings.source === "claude-code") watchFeed();
    const usage = await readUsage(now, manual);
    const res = engine.step(persisted, usage, now, { engine: "prob" });
    persisted = res.persisted;
    if (loginShown && win && win.isVisible()) win.hide();      // ya hay datos: la ventana de inicio de sesión se oculta sola
    errors = 0; loginShown = false;
    if (settings.alerts) res.events.forEach(notify);
    saveSoon();
  } catch (e) {
    if (e.kind !== "nofeed" && e.kind !== "config") errors++;      // esperar datos de Claude Code o la URL del servidor no es un fallo: no se espacian los intentos
    persisted.state = { ...persisted.state, status: e.kind === "auth" ? "auth" : "error", error: e.message || String(e), updatedAt: now };
    // Sin sesión, o dos fallos seguidos: se muestra la ventana de claude.ai para iniciar sesión o completar una verificación.
    if (settings.source === "web" && (e.kind === "auth" || errors >= 2) && !loginShown) { loginShown = true; showLogin(); }
  } finally {
    busy = false;
    await render(true);
    refreshChrome();
    notifyPanel();
    schedule();
  }
}
// Claude Code escribe el archivo de datos cuando llega una respuesta: se observa la carpeta para actualizar al instante, sin esperar al sondeo.
let feedWatcher = null, feedWatchTimer = null;
function watchFeed() {
  if (feedWatcher || MOCK) return;
  try {
    feedWatcher = fs.watch(path.dirname(claudeCode.feedFile()), (_ev, name) => {
      if (name && name !== path.basename(claudeCode.feedFile())) return;
      clearTimeout(feedWatchTimer);
      feedWatchTimer = setTimeout(() => { if (settings.source === "claude-code" && !busy) tick(); }, 400);
    });
    feedWatcher.on("error", () => { feedWatcher = null; });
  } catch (_) { /* la carpeta aún no existe: se reintenta tras conectar y en cada consulta */ }
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
async function drawDockIcon(params, size = 512, plate = process.platform === "darwin") {   // en Windows sin placa: el anillo llena todo el ícono
  const dataUrl = await iconWin.webContents.executeJavaScript(`renderIcon(${JSON.stringify(params)}, ${size}, ${plate})`);
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
      if (tray) {
        tray.setImage(img.resize({ width: 32, height: 32, quality: "best" }));
        // Windows: las ventanas abiertas muestran el mismo ícono en la barra de tareas, más grande que el de la bandeja.
        taskbarIcon = img.resize({ width: 256, height: 256, quality: "best" });
        for (const w of [panelWin, win]) if (w && !w.isDestroyed()) w.setIcon(taskbarIcon);
      }
    } catch (e) { console.error("no se pudo dibujar el ícono:", e.message); }
  });
  return renderChain;
}

// Windows: las ventanas usan su propio identificador de app. Al mostrar una notificación, Electron crea en el menú
// Inicio un acceso directo con el identificador de la app, y la barra de tareas pasaría a mostrar el ícono fijo de ese
// acceso directo en vez del ícono dinámico de la ventana.
const WINDOW_APP_ID = APP_ID + ".window";
function setupTaskbar(w) {
  if (process.platform !== "win32" || !w) return;
  w.setAppDetails({ appId: WINDOW_APP_ID });
  if (taskbarIcon) w.setIcon(taskbarIcon);
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
  if (key === "updateCheck") { if (value) checkUpdates(); else refreshAdvice(); }
  if (key === "source") {
    errors = 0; loginShown = false;
    if (value === "web" && !win) createSessionWindow();
    if (value === "remote" && !remoteUrl()) showPanel();      // el panel tiene los campos de URL y token
    if (value !== "remote") refreshAdvice();                   // sin servidor propio no hay aviso sobre su versión
    tick();
  }
  render(true); refreshChrome(true);
}
function menuTemplate() {
  const lines = statusLines().map(label => ({ label, enabled: false }));
  if (persisted.state.status === "auth") lines[0] = { label: "Inicia sesión en claude.ai…", click: showLogin };
  const advice = updateAdvice.map(a => ({ label: a.kind === "server" ? `Actualiza el servidor a v${a.version}…` : `Actualización disponible: v${a.version}…`, click: () => openRelease(a.url) }));
  if (advice.length) lines.push({ type: "separator" }, ...advice);
  // Forma del ícono, número, transparencia y alertas se ajustan en el panel; aquí solo lo de uso diario y lo que el panel no tiene.
  const more = [
    { label: "Fuente de datos", submenu: radio([["Claude Code (línea de estado)", "claude-code"], ["claude.ai (ventana propia)", "web"], ["Servidor propio (URL)…", "remote"]], settings.source, v => updateSetting("source", v)) },
    claudeCode.isConnected() ? { label: "Desconectar de Claude Code…", click: disconnectClaudeCode } : { label: "Conectar con Claude Code…", click: connectClaudeCode },
    ...(settings.source === "web" ? [{ label: "Ventana de claude.ai…", click: showLogin }] : []),
    { label: "Frecuencia de consulta", submenu: radio([["Cada 10 s", 10], ["Cada 20 s", 20], ["Cada 30 s", 30], ["Cada 60 s", 60]], settings.pollSeconds, v => updateSetting("pollSeconds", v)) },
    { type: "separator" },
    { label: "Abrir al iniciar sesión", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: m => app.setLoginItemSettings({ openAtLogin: m.checked }) },
    ...(canSetup() && !app.isInApplicationsFolder() ? [{ label: "Mover a Aplicaciones…", click: () => offerMove(true) }] : [])
  ];
  return [
    ...lines, { type: "separator" },
    { label: "Abrir panel", click: showPanel },
    { label: "Actualizar ahora", click: () => tick({ manual: true }) },
    { label: "Más opciones", submenu: more },
    ...(tray ? [{ type: "separator" }, { label: "Salir", click: () => app.quit() }] : [])   // en macOS el Dock ya trae «Salir»
  ];
}
function refreshChrome(force) {
  const key = statusLines().join("|") + JSON.stringify(settings) + claudeCode.isConnected();
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
    setupTaskbar(panelWin);
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
    appVersion: app.getVersion(), dataSource: settings.source, claudeCodeConnected: claudeCode.isConnected(),
    remoteUrl: remoteUrls().local, remoteUrlOnline: remoteUrls().online, remoteTokenSet: !!remoteToken(), remoteFromEnv: remoteFromEnv(),
    serverVersion: settings.source === "remote" && remoteInfo ? remoteInfo.version : null, remoteVia: settings.source === "remote" && remoteInfo ? remoteInfo.via : null,
    updateAdvice, updateCheck: settings.updateCheck, repoUrl: releases.repo,
    alertsEnabled: settings.alerts, badgeMode: settings.mode, iconShape: settings.shape, numberAlpha: settings.alpha,
    numberScale: settings.numScale, numberDx: settings.numDx, numberDy: settings.numDy,
    badgeStyle: "inside", numberInk: "auto", projectionEngine: "prob"
  };
}
const SETTING_KEYS = { alertsEnabled: "alerts", badgeMode: "mode", iconShape: "shape", numberAlpha: "alpha", numberScale: "numScale", numberDx: "numDx", numberDy: "numDy", updateCheck: "updateCheck" };
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
  if (message && message.type === "POLL_NOW") await tick({ manual: true });
  if (message && message.type === "CONNECT_CLAUDE_CODE") { await connectClaudeCode(); return { ok: true }; }
  if (message && message.type === "SET_SOURCE" && ["claude-code", "web", "remote"].includes(message.value)) { updateSetting("source", message.value); return { ok: true }; }
  if (message && message.type === "SET_REMOTE") return setRemote(message);
  // Solo se copia un token generado en el panel (nada arbitrario al portapapeles).
  if (message && message.type === "COPY_TOKEN_LINE" && /^[0-9a-f]{64}$/.test(String(message.text))) { clipboard.writeText(message.text); return { ok: true }; }
  if (message && message.type === "OPEN_RELEASE") { openRelease(message.url); return { ok: true }; }
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
// Conecta Claude Code con la app: instala el script y añade `statusLine` a ~/.claude/settings.json (con respaldo y confirmación).
async function connectClaudeCode() {
  const file = claudeCode.settingsFile();
  const box = (message, detail, buttons = ["Aceptar"]) => dialog.showMessageBox({ type: "info", title: "Conectar con Claude Code", message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
  try {
    if (claudeCode.isConnected(file)) return void await box("Claude Code ya está conectado.", "Los datos llegan tras la primera respuesta de cada sesión de Claude Code (planes Pro y Max).");
    const r = await box("¿Conectar Usage Monitor con Claude Code?",
      `Se añadirá una línea de estado a ${file} (antes se guarda una copia de respaldo con fecha). El script solo guarda tus límites de uso en ~/.usage-monitor; no usa red ni toca tu inicio de sesión. Si ya tenías una línea de estado, se conserva.\n\nSolo funciona con planes Pro y Max, y los datos llegan tras la primera respuesta de cada sesión.`, ["Conectar", "Cancelar"]);
    if (r.response !== 0) return;
    const res = claudeCode.connect(file);
    updateSetting("source", "claude-code");
    await box("Conectado.", `${res.status === "wrap" ? "Tu línea de estado anterior se conserva. " : ""}Respaldo: ${res.backup || "no hacía falta (el archivo no existía)"}\n\nAbre o usa una sesión nueva de Claude Code para ver los datos.`);
    notifyPanel();
  } catch (e) { dialog.showErrorBox("No se pudo conectar con Claude Code", e.message); }
}
async function disconnectClaudeCode() {
  try {
    const res = claudeCode.disconnect();
    refreshChrome(true); notifyPanel();
    await dialog.showMessageBox({ type: "info", message: res.status === "removed" ? "Desconectado." : "No estaba conectado.", detail: res.backup ? `Respaldo: ${res.backup}` : "", buttons: ["Aceptar"] });
  } catch (e) { dialog.showErrorBox("No se pudo desconectar", e.message); }
}
function showLogin() { if (win) { win.show(); win.focus(); } }

// ── Ventanas ────────────────────────────────────────────────────────────────
function createSessionWindow() {
  const ses = session.fromPartition("persist:claude");      // las cookies de claude.ai se conservan entre ejecuciones
  win = new BrowserWindow({ ...fitToScreen(1000, 760), minWidth: 480, minHeight: 420, show: false, title: "claude.ai", webPreferences: { partition: "persist:claude", backgroundThrottling: false } });
  setupTaskbar(win);
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
  if (MOCK || settings.source !== "web") tick();     // claude.ai espera a que cargue su ventana
  // Primera vez con Claude Code como fuente y sin conectar: se ofrece conectarlo una sola vez.
  if (!MOCK && settings.source === "claude-code" && !settings.connectPrompted && !claudeCode.isConnected()) { saveFlag("connectPrompted", true); showPanel(); }   // el panel trae la tarjeta «Conectar con Claude Code»
  if (!MOCK && settings.source === "web") createSessionWindow();
  setInterval(() => { render(false); refreshChrome(); }, ICON_REFRESH_MS);
  setTimeout(checkUpdates, 10000); setInterval(checkUpdates, UPDATE_CHECK_MS);
  firstRunSetup();
  // Clic en el ícono del Dock abre el panel (se ignora el aviso inicial que macOS emite al arrancar).
  app.on("activate", () => { if (Date.now() - startedAt > 4000) showPanel(); });
});
app.on("second-instance", () => { if (app.isReady()) showPanel(); });      // abrir la app otra vez (p. ej. desde el menú Inicio) muestra el panel
app.on("before-quit", () => { quitting = true; store.saveData(serialize()); });
app.on("window-all-closed", () => { /* la app vive en el Dock aunque no haya ventanas */ });
