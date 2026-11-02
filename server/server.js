// Usage Monitor · servicio opcional. Consulta el uso de claude.ai con tu cookie de sesión cada cierto tiempo
// y lo sirve por HTTP para que la app (fuente «Servidor propio») u otras herramientas solo lo lean.
//
//   GET  /usage  → { version, fetchedAt, usage, error, errorAt }   (usage = respuesta de claude.ai: five_hour, seven_day, …)
//   POST /usage  → igual, pero antes consulta claude.ai al momento (como mucho una vez cada REFRESH_MIN_SECONDS)
//   GET  /health → { version, ok, fetchedAt, error }               (sin datos de uso; útil para healthchecks)
//
// Sin dependencias: Node 20+. Configuración por variables de entorno (ver .env.example).
"use strict";
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const VERSION = require("./package.json").version;      // la app la compara con la suya y con el último release

function readConfig(env = process.env) {
  const fromFile = name => env[`${name}_FILE`] ? fs.readFileSync(env[`${name}_FILE`], "utf8").trim() : (env[name] || "").trim();
  return {
    sessionKey: fromFile("CLAUDE_SESSION_KEY"),
    apiToken: fromFile("API_TOKEN"),
    orgId: (env.CLAUDE_ORG_ID || "").trim(),
    baseUrl: (env.CLAUDE_BASE_URL || "https://claude.ai").replace(/\/+$/, ""),
    pollSeconds: Math.max(30, Number(env.POLL_SECONDS) || 60),
    refreshMinSeconds: Math.max(5, Number(env.REFRESH_MIN_SECONDS) || 15),
    port: Number(env.PORT) || 8787,
    host: env.HOST || "0.0.0.0",
    userAgent: env.USER_AGENT || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
  };
}

function createMonitor(config, log = console) {
  const state = { fetchedAt: null, usage: null, error: null, errorAt: null };
  let orgId = config.orgId || null, failures = 0, timer = null, stopped = false, inflight = null, lastAttempt = 0;

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
  async function doPoll() {
    try {
      if (!config.sessionKey) throw new Error("Falta CLAUDE_SESSION_KEY.");
      if (!orgId) orgId = await findOrg();
      let r = await get(`/api/organizations/${encodeURIComponent(orgId)}/usage`);
      if (r.status === 404 && !config.orgId) { orgId = await findOrg(); r = await get(`/api/organizations/${encodeURIComponent(orgId)}/usage`); }
      if (r.status !== 200 || !r.body || !("five_hour" in r.body)) throw new Error(`uso: HTTP ${r.status}`);
      Object.assign(state, { fetchedAt: Date.now(), usage: r.body, error: null, errorAt: null });
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
function createServer(monitor, config) {
  return http.createServer(async (req, res) => {
    const send = (status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Usage-Monitor-Version": VERSION, ...headers }); res.end(JSON.stringify(obj)); };
    const { pathname } = new URL(req.url, "http://localhost");
    const s = monitor.state;
    if (pathname === "/health") {
      if (req.method !== "GET") return send(405, { error: "método no permitido" }, { Allow: "GET" });
      return send(s.usage ? 200 : 503, { version: VERSION, ok: !!s.usage, fetchedAt: s.fetchedAt, error: s.error });
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
  if (!config.sessionKey) { console.error("Falta CLAUDE_SESSION_KEY (o CLAUDE_SESSION_KEY_FILE)."); process.exit(1); }
  if (!config.apiToken) {
    console.error("Falta API_TOKEN. Genera uno en la app (Ajustes y datos → Servidor propio → «Generar» → «Copiar») y pega la línea en .env.");
    console.error("Para no usar token (solo en una red de confianza), pon API_TOKEN=none.");
    process.exit(1);
  }
  if (config.apiToken === NO_TOKEN) console.warn("Aviso: API_TOKEN=none; cualquiera que alcance este puerto puede leer /usage y forzar consultas.");
  const monitor = createMonitor(config);
  const server = createServer(monitor, config);
  server.listen(config.port, config.host, () => console.log(`Usage Monitor servidor v${VERSION} en http://${config.host}:${config.port}/usage (cada ${config.pollSeconds} s)`));
  monitor.start();
  const shutdown = () => { monitor.stop(); server.close(() => process.exit(0)); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}

module.exports = { readConfig, createMonitor, createServer, VERSION };
