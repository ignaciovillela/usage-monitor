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
async function fetchUsage(url, token, now = Date.now()) {
  if (!url) throw remoteError("Falta la URL del servidor: configúrala en el panel, en «Ajustes y datos».", "config");
  if (!validUrl(url)) throw remoteError("La URL del servidor no es válida (debe empezar por http:// o https://).", "config");
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" }); }
  catch (e) { throw remoteError(`No se pudo conectar con el servidor (${e.name === "TimeoutError" ? "tiempo agotado" : e.cause && e.cause.code || e.message}).`); }
  if (res.status === 401 || res.status === 403) throw remoteError("El servidor rechazó el token.");
  let body = null;
  try { body = await res.json(); } catch (_) { /* se informa abajo */ }
  if (!res.ok) throw remoteError(body && body.error ? `El servidor informa: ${body.error}` : `El servidor respondió HTTP ${res.status}.`);
  return parseRemote(body, now);
}
module.exports = { fetchUsage, parseRemote, validUrl };
