// Fuente «cuenta de Claude Code»: consulta el uso con el token OAuth que Claude Code ya guarda en este equipo, sin ventana ni inicio de sesión.
// Endpoint interno y no documentado de Anthropic: puede cambiar sin aviso. El token solo se lee en memoria, nunca se escribe ni se registra.
// Contrato: readUsage(deps?) => Promise<{ utilization, resetsAt, idle, weekly }> (misma forma que providers/claude.js). Los errores traen `kind`.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseUsage } = require("./claude");

const URL_USAGE = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const TIMEOUT_MS = 15000;
const EXPIRY_MARGIN_MS = 60 * 1000;

function oauthError(kind, message) { const e = new Error(message); e.kind = kind; return e; }

function tokenFromCredentials(text) {
  let data;
  try { data = JSON.parse(text); } catch (_) { throw oauthError("noauth", "Las credenciales de Claude Code no son JSON válido."); }
  const o = data && data.claudeAiOauth;
  if (!o || typeof o.accessToken !== "string" || !o.accessToken) throw oauthError("noauth", "Claude Code no tiene una sesión iniciada (inicia sesión con /login).");
  return { token: o.accessToken, expiresAt: Number.isFinite(Number(o.expiresAt)) ? Number(o.expiresAt) : null };
}
function readKeychain() {
  return new Promise((resolve, reject) => {
    execFile("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) return reject(oauthError("noauth", "No se pudo leer la sesión de Claude Code del llavero (¿denegaste el permiso o no has iniciado sesión?)."));
      resolve(stdout);
    });
  });
}
// macOS guarda las credenciales en el llavero; Windows y Linux en ~/.claude/.credentials.json.
async function readCredentials() {
  if (process.platform === "darwin") return tokenFromCredentials(await readKeychain());
  try { return tokenFromCredentials(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8")); }
  catch (e) { throw e.kind ? e : oauthError("noauth", "No se encontró la sesión de Claude Code (~/.claude/.credentials.json)."); }
}

// Se conserva el token mientras no venza; Claude Code es quien lo renueva, aquí nunca se usa el refresh token.
let cached = null;
async function getToken(deps, now, force) {
  if (!force && cached && (cached.expiresAt === null || cached.expiresAt - EXPIRY_MARGIN_MS > now)) return cached.token;
  cached = await (deps.readCredentials || readCredentials)();
  if (cached.expiresAt !== null && cached.expiresAt <= now) {
    cached = null;
    throw oauthError("noauth", "La sesión de Claude Code venció: usa Claude Code una vez para que se renueve.");
  }
  return cached.token;
}
async function request(token, deps) {
  const res = await (deps.fetch || fetch)(URL_USAGE, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return res;
}
// El endpoint limita las consultas (HTTP 429, sin Retry-After útil): se consulta como máximo cada MIN_INTERVAL_MS, se reutiliza el último
// dato bueno entre consultas y, ante un 429, se espera con backoff creciente en vez de reintentar en cada ciclo de la app.
const MIN_INTERVAL_MS = 2 * 60 * 1000;
const BACKOFF_START_MS = 60 * 1000, BACKOFF_MAX_MS = 15 * 60 * 1000;
const STALE_MAX_MS = 30 * 60 * 1000;      // más viejo que esto ya no se presenta como dato actual
let last = null, nextAllowed = 0, backoff = 0;
async function fetchUsage(deps, now) {
  let res = await request(await getToken(deps, now, false), deps);
  if (res.status === 401) { cached = null; res = await request(await getToken(deps, now, true), deps); }   // otro proceso pudo renovar el token
  if (res.status === 401 || res.status === 403) { cached = null; throw oauthError("noauth", "Anthropic rechazó la sesión de Claude Code (HTTP " + res.status + ")."); }
  if (res.status === 429) throw oauthError("limited", "Anthropic limitó las consultas de uso (HTTP 429); se reintenta más tarde.");
  if (res.status !== 200) throw oauthError("http", "Consulta de uso: HTTP " + res.status);
  let body;
  try { body = await res.json(); } catch (_) { throw oauthError("http", "La respuesta de uso no es JSON."); }
  return parseUsage(body);
}
async function readUsage(deps = {}) {
  const now = (deps.now || Date.now)();
  const fresh = last && now - last.at < STALE_MAX_MS ? last.usage : null;
  if (now < nextAllowed) { if (fresh) return fresh; throw oauthError("limited", "Anthropic limitó las consultas de uso (HTTP 429); se reintenta más tarde."); }
  try {
    const usage = await fetchUsage(deps, now);
    last = { at: now, usage }; backoff = 0; nextAllowed = now + MIN_INTERVAL_MS;
    return usage;
  } catch (e) {
    if (e.kind === "limited") { backoff = Math.min(backoff ? backoff * 2 : BACKOFF_START_MS, BACKOFF_MAX_MS); nextAllowed = now + backoff; if (fresh) return fresh; }
    throw e;
  }
}
const resetCache = () => { cached = null; last = null; nextAllowed = 0; backoff = 0; };
module.exports = { readUsage, tokenFromCredentials, resetCache };
