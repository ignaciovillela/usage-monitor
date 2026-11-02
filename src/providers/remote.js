// Fuente de uso: un servidor propio que expone el uso por HTTP. La app solo lee y muestra.
//
// GET <url> con `Authorization: Bearer <token>` si hay token. Se aceptan tres formas de respuesta:
//   1. La de claude.ai:      { five_hour: {...}, seven_day: {...}, ... }
//   2. La de Claude Code:    { rate_limits: { five_hour: {...}, seven_day: {...} } }
//   3. Un sobre:             { fetchedAt, usage: <1 o 2>, error } (es lo que devuelve el servicio de ejemplo del repo)
// En el sobre, `fetchedAt` (ms o ISO) sirve para avisar si el servidor dejó de actualizar.
//
// Contrato igual que los otros proveedores: => { utilization 0-100, resetsAt (ms)|null, idle, weekly: [...] }
const { parseUsage } = require("./claude");
const { parseFeed } = require("./claude-code");

const TIMEOUT_MS = 10000;
const STALE_MS = 15 * 60 * 1000;      // más viejo que esto ya no representa el uso actual

function remoteError(message, kind = "remote") { const e = new Error(message); e.kind = kind; return e; }

function validUrl(url) {
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:"; } catch (_) { return false; }
}
function parseTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const ts = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
function parseRemote(body, now) {
  if (!body || typeof body !== "object") throw remoteError("El servidor no devolvió JSON con datos de uso.");
  let data = body;
  if ("usage" in body || "fetchedAt" in body) {
    const fetchedAt = parseTime(body.fetchedAt);
    if (!body.usage) throw remoteError(body.error ? `El servidor informa: ${body.error}` : "El servidor aún no tiene datos de uso.");
    if (fetchedAt !== null && now - fetchedAt > STALE_MS) {
      const mins = Math.round((now - fetchedAt) / 60000);
      throw remoteError(`Los datos del servidor tienen ${mins} min${body.error ? ` (último error: ${body.error})` : ""}.`);
    }
    data = body.usage;
  }
  if (data && typeof data === "object" && "five_hour" in data) return parseUsage(data);
  if (data && typeof data === "object" && data.rate_limits) return parseFeed(data, now);
  throw remoteError("Respuesta del servidor con un formato desconocido (se espera five_hour o rate_limits).");
}
// Una URL. refresh: la actualización manual hace POST para pedir datos frescos; si el servidor no admite POST
// (404/405/501, p. ej. un JSON estático), se repite con GET. Los errores llevan la versión del servidor si la informó.
async function fetchOne(url, token, now, { refresh = false, timeoutMs = TIMEOUT_MS } = {}) {
  if (!validUrl(url)) throw remoteError(`La URL ${url} no es válida (debe empezar por http:// o https://).`, "config");
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = method => fetch(url, { method, headers, signal: AbortSignal.timeout(method === "POST" ? timeoutMs * 3 : timeoutMs), cache: "no-store" });
  let res;
  try {
    res = await request(refresh ? "POST" : "GET");
    if (refresh && [404, 405, 501].includes(res.status)) res = await request("GET");
  } catch (e) {
    throw remoteError(`No se pudo conectar con ${new URL(url).host} (${e.name === "TimeoutError" ? "tiempo agotado" : e.cause && e.cause.code || e.message}).`, "network");
  }
  let body = null;
  try { body = await res.json(); } catch (_) { /* se informa abajo */ }
  const version = res.headers.get("x-usage-monitor-version") || (body && typeof body.version === "string" ? body.version : null);
  const fail = message => { const e = remoteError(message); e.serverVersion = version; throw e; };
  if (res.status === 401 || res.status === 403) fail("El servidor rechazó el token.");
  if (!res.ok) fail(body && body.error ? `El servidor informa: ${body.error}` : `El servidor respondió HTTP ${res.status}.`);
  try { return { usage: parseRemote(body, now), version }; } catch (e) { e.serverVersion = version; throw e; }
}
// Dos URLs opcionales: la local (red de casa) y la online. Se prueba la local y, si no se puede conectar, la online.
// Un error de la local que no sea de conexión (token, datos viejos…) se informa tal cual: el servidor sí respondió.
// Devuelve { usage, version, via: "local" | "online" }; los errores llevan `via` y `serverVersion`.
async function fetchRemote({ local, online } = {}, token, now = Date.now(), { refresh = false } = {}) {
  const targets = [["local", local], ["online", online]].filter(([, url]) => url);
  if (!targets.length) throw remoteError("Falta la URL del servidor: configúrala en el panel, en «Ajustes y datos».", "config");
  const failures = [];
  for (const [via, url] of targets) {
    // Con URL online de respaldo, la local se da por caída antes (fuera de casa no debería hacer esperar).
    const timeoutMs = via === "local" && targets.length > 1 ? 4000 : TIMEOUT_MS;
    try { return { ...(await fetchOne(url, token, now, { refresh, timeoutMs })), via }; }
    catch (e) {
      e.via = via;
      if (e.kind !== "network") throw e;
      failures.push(e.message);
    }
  }
  throw remoteError(failures.join(" "), "remote");
}
const fetchUsage = async (url, token, now, opts) => (await fetchRemote({ local: url }, token, now, opts)).usage;
module.exports = { fetchUsage, fetchRemote, parseRemote, validUrl };
