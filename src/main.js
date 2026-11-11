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
const selfupdate = require("./selfupdate");
const claudeOauth = require("./providers/claude-oauth");
const { pickUsage } = require("./pick-usage");
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
// Fuentes en el orden en que se consultan: una sola, o las dos según la prioridad elegida («auto»).
// «auto» consulta primero la elegida y luego las demás; claude.ai (ventana con login) solo entra si es la prioritaria.
const AUTO_FALLBACK = ["oauth", "claude-code"];
const sourceOrder = () => settings.source !== "auto" ? [settings.source] : [settings.priority, ...AUTO_FALLBACK.filter(v => v !== settings.priority)];
const SOURCE_NAMES = { web: "claude.ai", "claude-code": "Claude Code (archivo)", oauth: "Claude Code (cuenta)", remote: "Servidor propio" };

// ── Ciclo de consulta ───────────────────────────────────────────────────────
// Devuelve el uso con `via` (qué fuente respondió) y `fellBack` (respondió una de respaldo). Si todas fallan se informa el error de claude.ai, que es el accionable.
async function readUsage(now, manual) {
  if (MOCK) return MOCK.next();
  return pickUsage(sourceOrder(), {
    web: fetchUsageViaPage,
    oauth: () => claudeOauth.readUsage(),
    "claude-code": () => claudeCode.readFeed(claudeCode.feedFile(), now),
    remote: () => readRemote(now, manual)
  });
}
async function readRemote(now, manual) {
  try {
    const r = await remote.fetchRemote(remoteUrls(), remoteToken(), now, { refresh: manual });
    setRemoteInfo({ version: r.version, via: r.via });
    return r.usage;
  } catch (e) {
    if (e.serverVersion !== undefined) setRemoteInfo({ version: e.serverVersion, via: e.via });   // respondió aunque fuera con error
    throw e;
  }
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
const updateChannel = () => updates.effectiveChannel(settings.updateChannel, app.getVersion());
async function checkUpdates() {
  if (!settings.updateCheck || !releases.api || MOCK) return;
  const channel = updateChannel();
  let found;
  try { found = await updates.fetchLatest(releases.api, app.getVersion(), channel); }
  catch (e) { console.error("no se pudo consultar las versiones:", e.message); return; }
  if (channel !== updateChannel()) return;      // se cambió de canal mientras tanto: vale la consulta nueva
  latest = found;
  refreshAdvice();
}
function refreshAdvice() {
  const serverVersion = settings.source === "remote" && remoteInfo ? remoteInfo.version : null;
  updateAdvice = updates.advice({ appVersion: app.getVersion(), serverVersion, latest: settings.updateCheck ? latest : null, releasesPage: releases.page, channel: updateChannel() });
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
// Solo se abren las páginas de releases conocidas (las de los avisos, la del resumen o la del repositorio).
function openRelease(url) {
  const known = url === releases.page || url === releases.repo || updateAdvice.some(a => a.url === url) || (settings.updateSummary && settings.updateSummary.url === url);
  if (url && known && /^https:\/\//.test(url)) shell.openExternal(url);
}

// ── Actualizar con un botón ─────────────────────────────────────────────────
// La app descarga el instalador del release (con barra de progreso y comprobación sha256) y se lo pasa al script de
// su sistema, que viene dentro de la app: scripts/install-win.ps1 (zip) o scripts/install-mac.sh (dmg). La app se
// cierra; el script espera a que termine, reemplaza la app, la vuelve a abrir y, si algo falla, reabre la anterior y
// deja el error en «last-update-error.txt», que se muestra en el panel al arrancar.
const exeDir = () => path.dirname(process.execPath);
const scriptInstalled = () => process.platform === "win32" && fs.existsSync(path.join(exeDir(), ".release-tag"));
const updateErrorFile = () => path.join(app.getPath("userData"), "last-update-error.txt");
const writable = dir => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (_) { return false; } };
// Dónde se instala, o null si desde aquí no se puede (desarrollo, Mac Intel, carpeta sin permiso de escritura…).
function selfUpdateTarget() {
  if (!app.isPackaged || MOCK || process.env.USAGE_MONITOR_DATA) return null;
  if (process.platform === "win32" && process.arch === "x64") {
    // Instalada por el script: se reemplaza en su sitio. Abierta desde un zip: se instala donde lo hace el script.
    return { os: "win", dir: scriptInstalled() ? exeDir() : path.join(process.env.LOCALAPPDATA || "", "Programs", "Usage Monitor") };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    const bundle = path.resolve(process.execPath, "..", "..", "..");      // …/Usage Monitor.app/Contents/MacOS/Usage Monitor
    const dir = path.basename(bundle) === "Usage Monitor.app" && writable(path.dirname(bundle)) ? path.dirname(bundle) : "/Applications";
    return writable(dir) ? { os: "mac", dir, bundle } : null;
  }
  return null;
}
const updateAsset = () => latest && selfupdate.pickAsset(latest.assets);
const canSelfInstall = () => !!selfUpdateTarget() && !!updateAsset();
const bundledScript = name => fs.readFileSync(path.join(__dirname, "..", "scripts", name));
// La tarea de actualización automática de Windows ejecuta una copia local del instalador: se mantiene igual a la de esta versión.
function refreshUpdaterCopy() {
  if (!scriptInstalled()) return;
  const copy = path.join(process.env.LOCALAPPDATA || "", "Usage Monitor Updater", "install-win.ps1");
  try { if (fs.existsSync(copy)) fs.writeFileSync(copy, bundledScript("install-win.ps1")); } catch (e) { console.error("no se pudo actualizar el instalador local:", e.message); }
}

// Estado de la actualización en curso: { phase: "download" | "install" | "error", version, received, total, error }.
let updateJob = null;
const publicJob = () => updateJob && { phase: updateJob.phase, version: updateJob.version, received: updateJob.received || 0, total: updateJob.total || 0, error: updateJob.error || null };
function pushProgress(phaseChanged) {
  const j = publicJob();
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send("storage-changed", { updateProgress: { newValue: j } });
    // Barra también en el ícono de la barra de tareas (Windows) o del Dock (macOS) mientras el panel está abierto.
    panelWin.setProgressBar(j && j.phase === "download" && j.total ? j.received / j.total : j && j.phase === "install" ? 2 : -1);
  }
  if (phaseChanged) refreshChrome(true);
}
async function installUpdate() {
  if (updateJob && updateJob.phase !== "error") return;      // ya hay una en curso
  const target = selfUpdateTarget(), asset = updateAsset();
  if (!target || !asset) { if (latest && latest.url) openRelease(latest.url); return; }
  const version = latest.version, controller = new AbortController();
  updateJob = { phase: "download", version, received: 0, total: asset.size, controller };
  pushProgress(true);
  const file = path.join(app.getPath("temp"), `usage-monitor-update-${process.pid}-${asset.name}`);
  try {
    await selfupdate.download(asset, file, {
      signal: controller.signal, userAgent: `usage-monitor/${app.getVersion()}`,
      onProgress: (received, total) => { updateJob.received = received; updateJob.total = total; pushProgress(false); }
    });
  } catch (e) {
    updateJob = controller.signal.aborted ? null : { phase: "error", version, error: e.message || String(e) };
    pushProgress(true);
    return;
  }
  updateJob = { ...updateJob, phase: "install", controller: null };
  pushProgress(true);
  try {
    launchInstaller(target, file, version);
  } catch (e) {
    fs.rmSync(file, { force: true });
    updateJob = { phase: "error", version, error: `No se pudo iniciar el instalador: ${e.message}` };
    pushProgress(true);
    return;
  }
  // Windows registra el inicio automático con la ruta del .exe: la versión nueva lo vuelve a registrar con la suya.
  if (process.platform === "win32" && app.getLoginItemSettings().openAtLogin) saveFlag("reapplyLogin", true);
  setTimeout(() => app.quit(), 1200);      // el script espera a que este proceso termine
}
function cancelUpdate() { if (updateJob && updateJob.controller) updateJob.controller.abort(); }
function launchInstaller(target, file, version) {
  const { spawn } = require("child_process");
  const opts = { detached: true, stdio: "ignore", windowsHide: true };
  fs.rmSync(updateErrorFile(), { force: true });
  if (target.os === "win") {
    const script = path.join(app.getPath("userData"), "install-win.ps1");
    fs.writeFileSync(script, bundledScript("install-win.ps1"));
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Quiet", "-ZipPath", file, "-Tag", `v${version}`, "-InstallDir", target.dir,
      "-WaitPid", String(process.pid), "-Relaunch", process.execPath, "-ErrorLog", updateErrorFile()], opts).unref();
  } else {
    const script = path.join(app.getPath("userData"), "install-mac.sh");
    fs.writeFileSync(script, bundledScript("install-mac.sh"));
    spawn("/bin/bash", [script], { ...opts, env: { ...process.env, DMG: file, INSTALL_DIR: target.dir, WAIT_PID: String(process.pid),
      RELAUNCH: target.bundle, ERROR_LOG: updateErrorFile(), OPEN: "1" } }).unref();
  }
}
// Al arrancar: error de la última actualización (si la hubo) y el inicio automático tras cambiar de carpeta.
function afterUpdateStartup() {
  try {
    const f = updateErrorFile();
    if (fs.existsSync(f)) {
      updateJob = { phase: "error", version: null, error: fs.readFileSync(f, "utf8").trim().slice(0, 500) || "La actualización falló." };
      fs.rmSync(f, { force: true });
    }
  } catch (e) { console.error("no se pudo leer el error de la actualización:", e.message); }
  if (settings.reapplyLogin) { app.setLoginItemSettings({ openAtLogin: true }); saveFlag("reapplyLogin", false); }
}

// Resumen de la actualización: al arrancar con otra versión que la última vez, se arma la lista de cambios (notas
// de los releases y commits entre ambas) y se muestra en el panel hasta que la cierres.
async function noteVersionChange() {
  const ver = app.getVersion(), prev = settings.lastVersion;
  if (prev === ver || MOCK) return;
  saveFlag("lastVersion", ver);
  if (!prev) return;      // primera vez: no hay «desde»
  let summary = { from: prev, to: ver, downgrade: updates.compareVersions(ver, prev) < 0, items: [], more: 0, url: releases.page };
  if (settings.updateCheck) {
    try { summary = await updates.fetchSummary(releases, prev, ver, ver); } catch (e) { console.error("no se pudo armar el resumen:", e.message); }
  }
  saveFlag("updateSummary", { ...summary, at: Date.now() });
  if (settings.alerts && Notification.isSupported()) {
    const n = new Notification({ title: `Usage Monitor actualizado a v${summary.to}`, body: summary.items[0] ? `${summary.items[0]}${summary.items.length > 1 ? ` (y ${summary.items.length - 1 + summary.more} más)` : ""}` : "Abre el panel para ver las novedades." });
    n.on("click", showPanel);
    n.show();
  }
  refreshChrome(true); notifyPanel();
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
    persisted.state.via = usage.via; persisted.state.fellBack = usage.fellBack;
    if (loginShown && win && win.isVisible()) win.hide();      // ya hay datos: la ventana de inicio de sesión se oculta sola
    errors = 0; loginShown = false;
    if (settings.alerts) res.events.forEach(notify);
    saveSoon();
  } catch (e) {
    if (e.kind !== "nofeed" && e.kind !== "config") errors++;      // esperar datos de Claude Code o la URL del servidor no es un fallo: no se espacian los intentos
    persisted.state = { ...persisted.state, status: e.kind === "auth" ? "auth" : "error", waiting: e.kind === "nofeed", error: e.message || String(e), updatedAt: now };
    // Sin sesión (cualquier modo con claude.ai) o, solo en «solo claude.ai», dos fallos seguidos: se muestra la ventana de claude.ai para iniciar sesión o completar una verificación.
    if (((settings.source === "web" && errors >= 2) || (sourceOrder().includes("web") && e.kind === "auth")) && !loginShown) { loginShown = true; showLogin(); }
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
    lines.push(`Fuente: ${SOURCE_NAMES[s.via] || "claude.ai"}${s.fellBack ? ` (respaldo: ${SOURCE_NAMES[sourceOrder()[0]]} no respondió)` : ""}`);
    lines.push(`Uso ${engine.fmtPct(s.utilization)}${Number.isFinite(s.resetsAt) ? ` · reinicio ${engine.fmtClock(s.resetsAt)} (en ${engine.fmtReset(s.resetsAt)})` : ""}`);
    lines.push(`${parts.icon} ${parts.headline}`);
    if (parts.detail) lines.push(parts.detail);
    if (parts.why) lines.push(parts.why);
    for (const w of s.weekly || []) lines.push(`${engine.weeklyLabel(w.key)} ${engine.fmtPct(w.utilization, 0)}`);
  } else if (s.status === "auth") lines.push("Inicia sesión en claude.ai (ventana abierta)");
  else lines.push(s.error || "Conectando con claude.ai…");
  return lines;
}
function updateSetting(key, value) {
  if (key === "updateChannel" && !updates.CHANNELS.includes(value)) return;
  settings = { ...settings, [key]: value };
  store.saveSettings(settings);
  if (key === "pollSeconds") schedule();
  if (key === "updateCheck") { if (value) checkUpdates(); else refreshAdvice(); }
  if (key === "updateChannel") { latest = null; refreshAdvice(); checkUpdates(); }   // lo del canal anterior ya no vale
  if (key === "source" || key === "priority") {
    errors = 0; loginShown = false;
    if (sourceOrder().includes("web") && !win) createSessionWindow();
    if (key === "source" && value === "remote" && !remoteUrl()) showPanel("settings");      // los campos de URL y token están en Ajustes
    if (key === "source" && value !== "remote") refreshAdvice();                   // sin servidor propio no hay aviso sobre su versión
    tick();
  }
  render(true); refreshChrome(true);
}
function menuTemplate() {
  const lines = statusLines().map(label => ({ label, enabled: false }));
  if (persisted.state.status === "auth") lines[0] = { label: "Inicia sesión en claude.ai…", click: showLogin };
  const install = a => a.kind === "app" && canSelfInstall();
  const job = publicJob();
  const advice = job && job.phase !== "error" ? [{ label: job.phase === "download" ? `Descargando v${job.version}…` : `Instalando v${job.version}…`, click: showPanel }] : updateAdvice.map(a => ({
    label: a.kind === "server" ? `Actualiza el servidor a v${a.version}…` : install(a) ? `Instalar v${a.version} ahora` : `Actualización disponible: v${a.version}…`,
    click: () => install(a) ? installUpdate() : openRelease(a.url)
  }));
  if (settings.updateSummary) advice.push({ label: `Novedades de v${settings.updateSummary.to}…`, click: showPanel });
  if (advice.length) lines.push({ type: "separator" }, ...advice);
  // Todos los ajustes viven en el panel (vista «Ajustes»); el menú solo tiene lo de uso diario.
  return [
    ...lines, { type: "separator" },
    { label: "Abrir panel", click: () => showPanel() },
    { label: "Actualizar ahora", click: () => tick({ manual: true }) },
    ...(settings.source === "web" ? [{ label: "Ventana de claude.ai…", click: showLogin }] : []),
    { label: "Ajustes…", click: () => showPanel("settings") },
    ...(canSetup() && !app.isInApplicationsFolder() ? [{ label: "Mover a Aplicaciones…", click: () => offerMove(true) }] : []),
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
  return forced ? { width: +forced[1], height: +forced[2] } : fitToScreen(460, 700);
}
// El panel avisa cuánto mide su vista de uso tras el primer render; la ventana se ajusta a eso una sola vez
// (después manda el tamaño que elija quien la use) y nunca más alto que la pantalla.
function fitPanel(height) {
  if (!panelWin || panelWin.isDestroyed() || panelWin.fitted || process.env.USAGE_MONITOR_PANEL_SIZE) return;
  panelWin.fitted = true;
  if (!(height > 0)) return;
  const [width] = panelWin.getContentSize();
  panelWin.setContentSize(width, fitToScreen(width, Math.max(420, Math.ceil(height))).height);
}
// Panel: el popup (gráficos, ajustes) dentro de una ventana, con los datos de la app en lugar de chrome.storage.
// view = "settings" abre directamente la vista de ajustes.
function showPanel(view) {
  if (typeof view !== "string") view = null;      // como manejador de clic recibe el ítem del menú o el evento
  if (panelWin && !panelWin.isDestroyed() && view) panelWin.webContents.send("storage-changed", { panelView: { newValue: view } });
  if (!panelWin || panelWin.isDestroyed()) {
    panelWin = new BrowserWindow({
      ...panelBounds(), useContentSize: true, minWidth: 340, minHeight: 420, title: "Usage Monitor", backgroundColor: "#0d0d0d",
      webPreferences: { preload: path.join(__dirname, "panel-preload.js"), contextIsolation: false }
    });
    setupTaskbar(panelWin);
    panelWin.on("closed", () => { panelWin = null; });
    if (process.env.USAGE_MONITOR_DEBUG) panelWin.webContents.on("console-message", (_e, level, message, line, source) => console.log("panel:", level, message, `(${path.basename(source)}:${line})`));
    panelWin.loadFile(path.join(__dirname, "..", "renderer", "panel", "popup.html"), view ? { hash: view } : {});
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
    appVersion: app.getVersion(), dataSource: settings.source, dataPriority: settings.priority, claudeCodeConnected: claudeCode.isConnected(),
    remoteUrl: remoteUrls().local, remoteUrlOnline: remoteUrls().online, remoteTokenSet: !!remoteToken(), remoteFromEnv: remoteFromEnv(),
    serverVersion: settings.source === "remote" && remoteInfo ? remoteInfo.version : null, remoteVia: settings.source === "remote" && remoteInfo ? remoteInfo.via : null,
    updateAdvice, updateCheck: settings.updateCheck, repoUrl: releases.repo,
    updateChannel: updateChannel(), canInstallUpdate: canSelfInstall(), updateSummary: settings.updateSummary, updateProgress: publicJob(),
    alertsEnabled: settings.alerts, badgeMode: settings.mode, iconShape: settings.shape, numberAlpha: settings.alpha,
    numberScale: settings.numScale, numberDx: settings.numDx, numberDy: settings.numDy,
    pollSeconds: settings.pollSeconds, openAtLogin: app.getLoginItemSettings().openAtLogin,
    badgeStyle: "inside", numberInk: "auto", projectionEngine: "prob"
  };
}
const SETTING_KEYS = { alertsEnabled: "alerts", badgeMode: "mode", iconShape: "shape", numberAlpha: "alpha", numberScale: "numScale", numberDx: "numDx", numberDy: "numDy", updateCheck: "updateCheck", updateChannel: "updateChannel", pollSeconds: "pollSeconds" };
ipcMain.handle("storage-get", (_e, keys) => {
  const all = storageSnapshot();
  if (keys == null) return all;
  const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
  return Object.fromEntries(list.filter(k => k in all).map(k => [k, all[k]]));
});
ipcMain.handle("storage-set", (_e, obj) => {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === "pollSeconds" && ![10, 20, 30, 60].includes(v)) continue;
    if (k === "dataPriority") { if (["oauth", "claude-code", "web"].includes(v)) updateSetting("priority", v); continue; }
    if (k === "openAtLogin") { app.setLoginItemSettings({ openAtLogin: !!v }); refreshChrome(true); continue; }
    if (SETTING_KEYS[k]) updateSetting(SETTING_KEYS[k], v);
  }
});
ipcMain.handle("storage-remove", () => undefined);
ipcMain.handle("runtime-message", async (_e, message) => {
  if (message && message.type === "PANEL_FIT") return fitPanel(Number(message.height));
  if (message && message.type === "IMPORT_CSV") return importCsv();
  if (message && message.type === "POLL_NOW") await tick({ manual: true });
  if (message && message.type === "CONNECT_CLAUDE_CODE") { await connectClaudeCode(); return { ok: true }; }
  if (message && message.type === "DISCONNECT_CLAUDE_CODE") { await disconnectClaudeCode(); return { ok: true }; }
  if (message && message.type === "OPEN_LOGIN_WINDOW") { if (!win) createSessionWindow(); showLogin(); return { ok: true }; }
  if (message && message.type === "SET_SOURCE" && ["claude-code", "web", "remote", "oauth", "auto"].includes(message.value)) { updateSetting("source", message.value); return { ok: true }; }
  if (message && message.type === "SET_REMOTE") return setRemote(message);
  // Solo se copia un token generado en el panel (nada arbitrario al portapapeles).
  if (message && message.type === "COPY_TOKEN_LINE" && /^[0-9a-f]{64}$/.test(String(message.text))) { clipboard.writeText(message.text); return { ok: true }; }
  if (message && message.type === "OPEN_RELEASE") { openRelease(message.url); return { ok: true }; }
  if (message && message.type === "INSTALL_UPDATE") { installUpdate(); return { ok: true }; }
  if (message && message.type === "CANCEL_UPDATE") { cancelUpdate(); return { ok: true }; }
  if (message && message.type === "DISMISS_UPDATE_ERROR") { if (updateJob && updateJob.phase === "error") { updateJob = null; pushProgress(true); } return { ok: true }; }
  if (message && message.type === "DISMISS_UPDATE_SUMMARY") { saveFlag("updateSummary", null); refreshChrome(true); notifyPanel(); return { ok: true }; }
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
  if (process.env.USAGE_MONITOR_OPEN) { await panelWin.webContents.executeJavaScript(`document.getElementById("settings-btn").click()`); await new Promise(r => setTimeout(r, 600)); }
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
  // Inicio automático: se activa la primera vez; después se respeta lo que elijas en Ajustes.
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
  if (!MOCK && sourceOrder().includes("claude-code") && !settings.connectPrompted && !claudeCode.isConnected()) { saveFlag("connectPrompted", true); showPanel(); }   // el panel trae la tarjeta «Conectar con Claude Code»
  if (!MOCK && sourceOrder().includes("web")) createSessionWindow();
  setInterval(() => { render(false); refreshChrome(); }, ICON_REFRESH_MS);
  setTimeout(checkUpdates, 10000); setInterval(checkUpdates, UPDATE_CHECK_MS);
  afterUpdateStartup(); noteVersionChange(); refreshUpdaterCopy();
  firstRunSetup();
  // Clic en el ícono del Dock abre el panel (se ignora el aviso inicial que macOS emite al arrancar).
  app.on("activate", () => { if (Date.now() - startedAt > 4000) showPanel(); });
});
app.on("second-instance", () => { if (app.isReady()) showPanel(); });      // abrir la app otra vez (p. ej. desde el menú Inicio) muestra el panel
app.on("before-quit", () => { quitting = true; store.saveData(serialize()); });
app.on("window-all-closed", () => { /* la app vive en el Dock aunque no haya ventanas */ });
