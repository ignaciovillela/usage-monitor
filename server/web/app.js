// Página del servidor: muestra lo que devuelve /usage. Usa rutas relativas, así funciona también detrás de un
// proxy inverso con subruta. El token se guarda solo en este navegador y se envía como «Authorization: Bearer».
"use strict";
const $ = id => document.getElementById(id);
const WINDOW_MS = 5 * 3600e3;
const STALE_MS = 15 * 60000;
const WEEKLY_LABELS = { seven_day: "Semanal", seven_day_opus: "Semanal Opus", seven_day_sonnet: "Semanal Sonnet" };
const weeklyLabel = key => WEEKLY_LABELS[key] || key.replace(/^seven_day_?/, "Semanal ").replace(/_/g, " ").trim();
const tokenStore = {
  get() { try { return localStorage.getItem("usageMonitorToken") || ""; } catch (_) { return ""; } },
  set(v) { try { if (v) localStorage.setItem("usageMonitorToken", v); else localStorage.removeItem("usageMonitorToken"); } catch (_) { /* sin almacenamiento: vale para esta visita */ } }
};
let token = tokenStore.get(), last = null, busy = false;

function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} días`;
}
const fmtClock = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = ts => `${new Date(ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${fmtClock(ts)}`;
const parseTs = v => { if (v === null || v === undefined || v === "") return null; const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const level = pct => pct >= 90 ? "lvl-danger" : pct >= 80 ? "lvl-warn" : "";
function setBar(el, pct, marker) {
  el.className = `bar ${level(pct)}`;
  el.querySelector("i").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  const b = el.querySelector("b");
  if (b) { b.hidden = marker === null; if (marker !== null) b.style.left = `calc(${marker * 100}% - 1px)`; }
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

async function load(refresh = false) {
  if (busy) return;
  busy = true;
  $("refresh").classList.add("spinning");
  try {
    const res = await fetch("usage", { method: refresh ? "POST" : "GET", headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
    if (res.status === 401) { showLogin(token ? "El token no es válido." : ""); return; }
    const body = await res.json().catch(() => null);
    if (!body) throw new Error(`HTTP ${res.status}`);
    $("login").hidden = true;
    $("logout-wrap").hidden = !token;
    last = body;
    render();
  } catch (e) {
    showError(`No se pudo conectar con el servidor (${e.message}).`);
  } finally {
    busy = false;
    $("refresh").classList.remove("spinning");
  }
}
function showLogin(message) {
  $("login").hidden = false;
  $("five").hidden = $("weekly").hidden = $("error").hidden = true;
  $("login-error").textContent = message;
  $("status").textContent = "Falta el token";
  $("token").focus();
}
function showError(text) { $("error").hidden = !text; $("error-text").textContent = text || ""; }

function render() {
  const now = Date.now(), b = last || {};
  $("version").textContent = b.version ? `Servidor v${b.version}` : "";
  $("version").hidden = !b.version;
  const fetchedAt = parseTs(b.fetchedAt);
  const ago = fetchedAt && now - fetchedAt < 60000 ? "hace un momento" : `hace ${fmtDuration(now - fetchedAt)}`;
  $("status").textContent = fetchedAt ? `Actualizado ${ago} · ${fmtClock(fetchedAt)}` : "Sin datos todavía";
  showError(b.error ? `Último error del servidor: ${b.error}` : fetchedAt && now - fetchedAt > STALE_MS ? "Los datos tienen más de 15 minutos." : "");
  const u = b.usage;
  if (!u) { $("five").hidden = $("weekly").hidden = true; return; }

  $("five").hidden = false;
  const five = u.five_hour;
  if (five && Number.isFinite(Number(five.utilization))) {
    const pct = Number(five.utilization), reset = parseTs(five.resets_at);
    const elapsed = reset ? Math.min(1, Math.max(0, 1 - (reset - now) / WINDOW_MS)) : null;
    $("five-pct").textContent = `${Math.round(pct)} %`;
    setBar($("five-bar"), pct, elapsed);
    $("five-reset").textContent = reset ? `reinicio ${fmtClock(reset)}` : "";
    $("five-elapsed").textContent = elapsed !== null ? `Transcurrido: ${Math.round(elapsed * 100)} %` : "";
    $("five-left").textContent = reset ? `quedan ${fmtDuration(reset - now)}` : "";
  } else {
    $("five-pct").textContent = "0 %";
    setBar($("five-bar"), 0, null);
    $("five-reset").textContent = "";
    $("five-elapsed").textContent = "Sin uso en las últimas 5 horas";
    $("five-left").textContent = "";
  }

  const keys = Object.keys(u).filter(k => k.startsWith("seven_day") && u[k] && Number.isFinite(Number(u[k].utilization)));
  $("weekly").hidden = !keys.length;
  $("weekly").replaceChildren(...keys.map(key => {
    const w = u[key], pct = Number(w.utilization), reset = parseTs(w.resets_at);
    const track = el("div"); track.append(el("i"));
    setBar(track, pct, null);
    const meta = el("div", "meta");
    meta.append(el("span", "", reset ? `reinicio ${fmtDay(reset)}` : ""), el("span", "", reset ? `quedan ${fmtDuration(reset - now)}` : ""));
    const row = el("div", "row");
    row.append(el("span", "label", weeklyLabel(key)), el("span", "pct", `${Math.round(pct)} %`), track, meta);
    return row;
  }));
}

$("refresh").addEventListener("click", () => load(true));
$("login-form").addEventListener("submit", e => { e.preventDefault(); token = $("token").value.trim(); tokenStore.set(token); $("token").value = ""; load(); });
$("logout").addEventListener("click", () => { token = ""; tokenStore.set(""); showLogin(""); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden) load(); }, 60000);
setInterval(() => { if (last) render(); }, 30000);      // cuentas atrás al día entre consultas
load();
