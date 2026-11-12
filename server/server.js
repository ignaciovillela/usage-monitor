// Usage Monitor · servicio opcional. Consulta el uso de tu cuenta de Claude cada cierto tiempo y lo sirve por HTTP
// para que la app (fuente «Servidor propio») u otras herramientas solo lo lean. Dos formas de acceder a la cuenta:
//   · CLAUDE_CREDENTIALS_FILE: el login de Claude Code de esta máquina (~/.claude/.credentials.json). Si el acceso
//     vence, lo renueva y lo guarda en el mismo archivo, como otra terminal de Claude Code (CLAUDE_CREDENTIALS_RENEW=false
//     para solo leer).
//   · CLAUDE_SESSION_KEY: la cookie «sessionKey» de claude.ai.
//
//   GET  /usage  → { version, source, fetchedAt, usage, error, errorAt }   (usage: five_hour, seven_day, …)
//   POST /usage  → igual, pero antes consulta claude.ai al momento (como mucho una vez cada REFRESH_MIN_SECONDS)
//   GET  /       → página web para ver el uso desde el navegador (pide el token y lo guarda en ese navegador)
//   GET  /health → { version, ok, source, fetchedAt, error }             (sin datos de uso; útil para healthchecks)
//
// Sin dependencias: Node 20+. Configuración por variables de entorno (ver .env.example).
"use strict";
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const VERSION = require("./package.json").version;      // la app la compara con la suya y con el último release

function readConfig(env = process.env) {
  const fromFile = name => env[`${name}_FILE`] ? fs.readFileSync(env[`${name}_FILE`], "utf8").trim() : (env[name] || "").trim();
  return {
    sessionKey: fromFile("CLAUDE_SESSION_KEY"),
    credentialsFile: (env.CLAUDE_CREDENTIALS_FILE || "").trim(),
    renewCredentials: !/^(0|false|no|off)$/i.test((env.CLAUDE_CREDENTIALS_RENEW || "").trim()),
    apiToken: fromFile("API_TOKEN"),
    orgId: (env.CLAUDE_ORG_ID || "").trim(),
    baseUrl: (env.CLAUDE_BASE_URL || "https://claude.ai").replace(/\/+$/, ""),
    apiUrl: (env.ANTHROPIC_API_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
    tokenUrl: env.CLAUDE_OAUTH_TOKEN_URL || "https://platform.claude.com/v1/oauth/token",
    pollSeconds: Math.max(30, Number(env.POLL_SECONDS) || 60),
    refreshMinSeconds: Math.max(5, Number(env.REFRESH_MIN_SECONDS) || 15),
    port: Number(env.PORT) || 8787,
    host: env.HOST || "0.0.0.0",
    userAgent: env.USER_AGENT || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
  };
}

// Fuente «claude.ai»: cookie de sesión contra la API interna de la web.
function cookieSource(config) {
  let orgId = config.orgId || null;
  async function get(path) {
    const res = await fetch(config.baseUrl + path, {
      headers: { Accept: "application/json", Cookie: `sessionKey=${config.sessionKey}`, "User-Agent": config.userAgent },
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* HTML: suele ser una verificación de Cloudflare */ }
    if (res.status === 401 || (res.status === 403 && body)) throw new Error("claude.ai rechazó la sesión: renueva CLAUDE_SESSION_KEY.");
    if (!body) throw new Error(`claude.ai respondió HTTP ${res.status} sin JSON (posible verificación de Cloudflare).`);
    return { status: res.status, body };
  }
  async function findOrg() {
    const { status, body } = await get("/api/organizations");
    if (status !== 200 || !Array.isArray(body) || !body.length) throw new Error(`organizaciones: HTTP ${status}`);
    const withId = body.filter(o => o.uuid || o.id);
    const org = withId.find(o => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || withId[0];
    if (!org) throw new Error("sin identificador de organización");
    return org.uuid || org.id;
  }
  return {
    name: "claude.ai",
    async usage() {
      if (!orgId) orgId = await findOrg();
      let r = await get(`/api/organizations/${encodeURIComponent(orgId)}/usage`);
      if (r.status === 404 && !config.orgId) { orgId = await findOrg(); r = await get(`/api/organizations/${encodeURIComponent(orgId)}/usage`); }
      if (r.status !== 200) throw new Error(`uso: HTTP ${r.status}`);
      return r.body;
    }
  };
}

// Fuente «Claude Code»: el login que Claude Code guarda en ~/.claude/.credentials.json. Se relee en cada consulta
// (Claude Code lo renueva mientras se usa). Solo si el acceso ya venció —Claude Code no se está usando— lo renueva
// el servidor y escribe el resultado en el mismo archivo; Claude Code relee el archivo cuando cambia.
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA = "oauth-2025-04-20";
const LOGIN_AGAIN = "inicia sesión de nuevo en Claude Code en esa máquina (claude → /login)";
function claudeCodeSource(config, log = console) {
  const file = config.credentialsFile;
  const ua = `usage-monitor-server/${VERSION}`;
  function read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
      if (e.code === "ENOENT") throw new Error(`No existe ${file}: monta la carpeta ~/.claude de la máquina donde está Claude Code.`);
      if (e.code) throw new Error(`No se pudo leer ${file} (${e.code}).`);
      throw new Error(`${file} no es JSON válido.`);
    }
    const oauth = data && data.claudeAiOauth;
    if (!oauth || !oauth.accessToken) throw new Error(`Claude Code no tiene sesión iniciada: ${LOGIN_AGAIN}.`);
    return { data, oauth };
  }
  const expired = oauth => Number(oauth.expiresAt) > 0 && Date.now() >= Number(oauth.expiresAt);
  // Comprobar ANTES de renovar que se podrá guardar: renovar puede invalidar el login anterior, y si el nuevo no
  // quedara en el archivo, Claude Code se quedaría sin sesión.
  function writable() {
    try { fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK); return true; } catch (_) { return false; }
  }
  function save(oauth) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { data = {}; }      // releer: no pisar otros campos
    const text = JSON.stringify({ ...data, claudeAiOauth: oauth });
    const tmp = path.join(path.dirname(file), `.credentials.json.usage-monitor-${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (__) { /* no llegó a crearse */ }
      fs.writeFileSync(file, text, { mode: 0o600 });      // montaje de un solo archivo: no admite rename
    }
  }
  async function renew(oauth) {
    if (!config.renewCredentials) throw new Error("El acceso de Claude Code venció. Ábrelo en esa máquina para renovarlo, o quita CLAUDE_CREDENTIALS_RENEW=false.");
    if (!oauth.refreshToken) throw new Error(`El acceso de Claude Code venció y no se puede renovar: ${LOGIN_AGAIN}.`);
    if (!writable()) throw new Error(`El acceso de Claude Code venció y ${file} es de solo lectura: móntalo con escritura para renovarlo, o abre Claude Code en esa máquina.`);
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": ua },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: CLAUDE_CODE_CLIENT_ID, scope: (Array.isArray(oauth.scopes) ? oauth.scopes : []).join(" ") }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.access_token) {
      if (res.status === 400 || res.status === 401) throw new Error(`No se pudo renovar el acceso de Claude Code: ${LOGIN_AGAIN}.`);
      throw new Error(`Renovación del acceso de Claude Code: HTTP ${res.status}.`);
    }
    const now = Date.now();
    const next = { ...oauth, accessToken: body.access_token, refreshToken: body.refresh_token || oauth.refreshToken };
    if (Number.isFinite(Number(body.expires_in))) next.expiresAt = now + Number(body.expires_in) * 1000;
    if (Number.isFinite(Number(body.refresh_token_expires_in))) next.refreshTokenExpiresAt = now + Number(body.refresh_token_expires_in) * 1000;
    if (typeof body.scope === "string" && body.scope) next.scopes = body.scope.split(" ").filter(Boolean);
    save(next);
    log.log(new Date().toISOString(), "acceso de Claude Code renovado");
    return next;
  }
  async function get(token) {
    const res = await fetch(`${config.apiUrl}/api/oauth/usage`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA, "User-Agent": ua },
      signal: AbortSignal.timeout(15000)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return {
    name: "claude-code",
    async usage() {
      let { oauth } = read();
      if (expired(oauth)) oauth = await renew(oauth);
      let r = await get(oauth.accessToken);
      if (r.status === 401) {
        // Puede que Claude Code lo haya renovado entretanto; si no, el acceso dejó de valer antes de su fecha.
        const again = read().oauth;
        oauth = again.accessToken !== oauth.accessToken ? again : await renew(again);
        r = await get(oauth.accessToken);
        if (r.status === 401) throw new Error(`Anthropic rechazó el acceso de Claude Code: ${LOGIN_AGAIN}.`);
      }
      if (r.status !== 200) throw new Error(`uso: HTTP ${r.status}`);
      return r.body;
    }
  };
}

function createMonitor(config, log = console) {
  const source = config.credentialsFile ? claudeCodeSource(config, log) : config.sessionKey ? cookieSource(config) : null;
  const state = { source: source && source.name, fetchedAt: null, usage: null, error: null, errorAt: null };
  let failures = 0, timer = null, stopped = false, inflight = null, lastAttempt = 0;

  async function doPoll() {
    try {
      if (!source) throw new Error("Falta CLAUDE_CREDENTIALS_FILE (login de Claude Code) o CLAUDE_SESSION_KEY (cookie de claude.ai).");
      const usage = await source.usage();
      if (!usage || typeof usage !== "object" || !("five_hour" in usage)) throw new Error("uso: respuesta sin five_hour");
      Object.assign(state, { fetchedAt: Date.now(), usage, error: null, errorAt: null });
      failures = 0;
    } catch (e) {
      failures++;
      Object.assign(state, { error: e.message || String(e), errorAt: Date.now() });
      log.error(new Date().toISOString(), "error:", state.error);
    }
    return state;
  }
  // Una sola consulta a la vez: quien llegue mientras hay una en curso espera esa misma.
  function pollOnce() {
    if (!inflight) { lastAttempt = Date.now(); inflight = doPoll().finally(() => { inflight = null; }); }
    return inflight;
  }
  // Actualización pedida desde fuera (POST /usage): como mucho una cada refreshMinSeconds para no insistir contra claude.ai.
  function refresh() {
    if (inflight || Date.now() - lastAttempt >= config.refreshMinSeconds * 1000) return pollOnce();
    return Promise.resolve(state);
  }
  // Con errores se espacia la consulta (hasta 30 min) para no insistir contra claude.ai.
  function schedule() {
    if (stopped) return;
    const base = config.pollSeconds * 1000;
    timer = setTimeout(async () => { await pollOnce(); schedule(); }, failures ? Math.min(30 * 60000, base * 2 ** Math.min(failures, 5)) : base);
  }
  return {
    state, pollOnce, refresh,
    async start() { await pollOnce(); schedule(); },
    stop() { stopped = true; clearTimeout(timer); }
  };
}

// API_TOKEN es obligatorio; "none" lo desactiva a propósito (red de confianza). Sin token configurado no se acepta nada.
const NO_TOKEN = "none";
function authorized(req, token) {
  if (token === NO_TOKEN) return true;
  if (!token) return false;
  const got = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Página web: archivos fijos de web/, leídos al arrancar. No llevan datos: los pide a /usage con el token.
const WEB_FILES = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
const WEB_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-cache"
};
function loadWeb(dir = path.join(__dirname, "web")) {
  const out = {};
  for (const [route, [file, type]] of Object.entries(WEB_FILES)) {
    try { out[route] = { body: fs.readFileSync(path.join(dir, file)), type: `${type}; charset=utf-8` }; } catch (_) { /* sin página: solo API */ }
  }
  return out;
}
function createServer(monitor, config, web = loadWeb()) {
  return http.createServer(async (req, res) => {
    const send = (status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Usage-Monitor-Version": VERSION, ...headers }); res.end(JSON.stringify(obj)); };
    const { pathname } = new URL(req.url, "http://localhost");
    const s = monitor.state;
    if (Object.prototype.hasOwnProperty.call(web, pathname)) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "método no permitido" }, { Allow: "GET, HEAD" });
      res.writeHead(200, { "Content-Type": web[pathname].type, "X-Usage-Monitor-Version": VERSION, ...WEB_HEADERS });
      return res.end(req.method === "HEAD" ? undefined : web[pathname].body);
    }
    if (pathname === "/health") {
      if (req.method !== "GET") return send(405, { error: "método no permitido" }, { Allow: "GET" });
      return send(s.usage ? 200 : 503, { version: VERSION, ok: !!s.usage, source: s.source, fetchedAt: s.fetchedAt, error: s.error });
    }
    if (pathname === "/usage") {
      if (req.method !== "GET" && req.method !== "POST") return send(405, { error: "método no permitido" }, { Allow: "GET, POST" });
      if (!authorized(req, config.apiToken)) return send(401, { error: "token inválido" });
      req.resume();      // el cuerpo de un POST se ignora
      if (req.method === "POST") await monitor.refresh();
      return send(s.usage ? 200 : 503, { version: VERSION, ...s });
    }
    send(404, { error: "no encontrado" });
  });
}

if (require.main === module) {
  const config = readConfig();
  if (!config.credentialsFile && !config.sessionKey) {
    console.error("Falta el acceso a tu cuenta. Elige uno:");
    console.error("  CLAUDE_CREDENTIALS_FILE: el login de Claude Code de esta máquina (p. ej. /claude/.credentials.json montando ~/.claude en /claude).");
    console.error("  CLAUDE_SESSION_KEY (o CLAUDE_SESSION_KEY_FILE): la cookie «sessionKey» de claude.ai.");
    process.exit(1);
  }
  if (config.credentialsFile && config.sessionKey) console.warn("Aviso: hay CLAUDE_CREDENTIALS_FILE y CLAUDE_SESSION_KEY; se usa el login de Claude Code.");
  if (!config.apiToken) {
    console.error("Falta API_TOKEN. Genera uno en la app (Ajustes y datos → Servidor propio → «Generar» → «Copiar») y pega la línea en .env.");
    console.error("Para no usar token (solo en una red de confianza), pon API_TOKEN=none.");
    process.exit(1);
  }
  if (config.apiToken === NO_TOKEN) console.warn("Aviso: API_TOKEN=none; cualquiera que alcance este puerto puede leer /usage y forzar consultas.");
  const monitor = createMonitor(config);
  const server = createServer(monitor, config);
  const via = config.credentialsFile ? `login de Claude Code (${config.credentialsFile}${config.renewCredentials ? "" : ", solo lectura"})` : "cookie de claude.ai";
  server.listen(config.port, config.host, () => console.log(`Usage Monitor servidor v${VERSION} en http://${config.host}:${config.port}/usage (cada ${config.pollSeconds} s, vía ${via})`));
  monitor.start();
  const shutdown = () => { monitor.stop(); server.close(() => process.exit(0)); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}

module.exports = { readConfig, createMonitor, createServer, VERSION };
