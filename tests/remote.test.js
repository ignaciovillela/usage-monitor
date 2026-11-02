const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { parseRemote, fetchUsage } = require("../src/providers/remote");
const { createMonitor, createServer, readConfig } = require("../server/server");

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const CLAUDE_AI = {
  five_hour: { utilization: 40, resets_at: new Date(NOW + 3600e3).toISOString() },
  seven_day: { utilization: 12, resets_at: new Date(NOW + 4 * 86400e3).toISOString() },
  seven_day_opus: { utilization: 92, resets_at: new Date(NOW + 4 * 86400e3).toISOString() }
};
const listen = server => new Promise(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const quiet = { error() {} };

test("acepta el formato de claude.ai, con todos los topes semanales", () => {
  const u = parseRemote(CLAUDE_AI, NOW);
  assert.strictEqual(u.utilization, 40);
  assert.deepStrictEqual(u.weekly.map(w => [w.key, w.utilization]), [["seven_day", 12], ["seven_day_opus", 92]]);
});
test("acepta el formato de la línea de estado de Claude Code", () => {
  const u = parseRemote({ rate_limits: { five_hour: { used_percentage: 7, resets_at: (NOW + 3600e3) / 1000 } } }, NOW);
  assert.strictEqual(u.utilization, 7);
});
test("sobre del servidor: usa usage, avisa si está viejo o trae solo error", () => {
  assert.strictEqual(parseRemote({ fetchedAt: NOW - 60e3, usage: CLAUDE_AI }, NOW).utilization, 40);
  assert.throws(() => parseRemote({ fetchedAt: NOW - 20 * 60e3, usage: CLAUDE_AI, error: "sesión" }, NOW), /20 min.*sesión/);
  assert.throws(() => parseRemote({ fetchedAt: null, usage: null, error: "Falta CLAUDE_SESSION_KEY." }, NOW), /Falta CLAUDE_SESSION_KEY/);
  assert.throws(() => parseRemote({ foo: 1 }, NOW), /formato desconocido/);
});
test("sin URL o con URL inválida: error de configuración", async () => {
  await assert.rejects(fetchUsage("", ""), e => e.kind === "config");
  await assert.rejects(fetchUsage("ftp://x", ""), e => e.kind === "config");
});

test("de punta a punta: claude.ai simulado → servicio → app", async t => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    if (req.headers.cookie !== "sessionKey=sk-test") { res.writeHead(401); return res.end("{}"); }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/organizations") return res.end(JSON.stringify([{ uuid: "api-org", capabilities: ["api"] }, { uuid: "org-1", capabilities: ["chat"] }]));
    if (req.url === "/api/organizations/org-1/usage") return res.end(JSON.stringify(CLAUDE_AI));
    res.writeHead(404); res.end("{}");
  });
  const base = await listen(upstream);
  const config = { ...readConfig({}), sessionKey: "sk-test", apiToken: "secreto", baseUrl: base };
  const monitor = createMonitor(config, quiet);
  const server = createServer(monitor, config);
  const url = await listen(server);
  t.after(() => { upstream.close(); server.close(); monitor.stop(); });

  // Antes de la primera consulta: 503 con el sobre vacío, que la app explica.
  await assert.rejects(fetchUsage(`${url}/usage`, "secreto"), /aún no tiene datos|HTTP 503/);
  await monitor.pollOnce();
  assert.strictEqual(monitor.state.error, null);
  const usage = await fetchUsage(`${url}/usage`, "secreto");
  assert.strictEqual(usage.utilization, 40);
  assert.strictEqual(usage.weekly.find(w => w.key === "seven_day_opus").utilization, 92);
  await assert.rejects(fetchUsage(`${url}/usage`, "otro"), /rechazó el token/);
  await assert.rejects(fetchUsage(`${url}/usage`, ""), /rechazó el token/);
  const health = await (await fetch(`${url}/health`)).json();
  assert.strictEqual(health.ok, true);
  assert.ok(!("usage" in health), "/health no expone el uso");

  // Sesión caducada: el error queda en el sobre y los datos anteriores se conservan.
  config.sessionKey = "sk-vieja";
  await monitor.pollOnce();
  assert.match(monitor.state.error, /CLAUDE_SESSION_KEY/);
  assert.strictEqual(monitor.state.usage.five_hour.utilization, 40);
  assert.ok(calls >= 3);
});

test("actualización manual: POST consulta claude.ai al momento, con límite de frecuencia", async t => {
  let usageCalls = 0;
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/organizations") return res.end(JSON.stringify([{ uuid: "org-1", capabilities: ["chat"] }]));
    usageCalls++;
    res.end(JSON.stringify({ ...CLAUDE_AI, five_hour: { ...CLAUDE_AI.five_hour, utilization: 40 + usageCalls } }));
  });
  const base = await listen(upstream);
  const config = { ...readConfig({}), sessionKey: "sk", apiToken: "none", baseUrl: base, refreshMinSeconds: 60 };
  const monitor = createMonitor(config, quiet);
  const server = createServer(monitor, config);
  const url = await listen(server);
  t.after(() => { upstream.close(); server.close(); monitor.stop(); });

  // El primer POST consulta aunque no haya datos; GET nunca consulta.
  assert.strictEqual((await fetchUsage(`${url}/usage`, "", Date.now(), { refresh: true })).utilization, 41);
  assert.strictEqual((await fetchUsage(`${url}/usage`, "")).utilization, 41);
  // Dentro del límite de frecuencia, el POST devuelve lo último sin volver a consultar.
  assert.strictEqual((await fetchUsage(`${url}/usage`, "", Date.now(), { refresh: true })).utilization, 41);
  assert.strictEqual(usageCalls, 1);
  // Pasado el límite, consulta de nuevo; dos POST a la vez comparten una sola consulta.
  config.refreshMinSeconds = 0;
  const [a, b] = await Promise.all([1, 2].map(() => fetchUsage(`${url}/usage`, "", Date.now(), { refresh: true })));
  assert.strictEqual(usageCalls, 2);
  assert.strictEqual(a.utilization, 42); assert.strictEqual(b.utilization, 42);
  // Otros métodos: 405.
  assert.strictEqual((await fetch(`${url}/usage`, { method: "DELETE" })).status, 405);
});
test("actualización manual contra un servidor que solo acepta GET: repite con GET", async t => {
  const methods = [];
  const plain = http.createServer((req, res) => {
    methods.push(req.method);
    if (req.method !== "GET") { res.writeHead(405); return res.end(); }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(CLAUDE_AI));
  });
  const url = await listen(plain);
  t.after(() => plain.close());
  assert.strictEqual((await fetchUsage(url, "", NOW, { refresh: true })).utilization, 40);
  assert.deepStrictEqual(methods, ["POST", "GET"]);
});

test("URL local y online: usa la local, cae a la online si la local no responde, informa versión y vía", async t => {
  const config = { ...readConfig({}), sessionKey: "sk", apiToken: "tk", baseUrl: "http://127.0.0.1:9" };
  const monitor = createMonitor(config, quiet);
  monitor.state.fetchedAt = Date.now(); monitor.state.usage = CLAUDE_AI;
  const server = createServer(monitor, config);
  const url = await listen(server);
  t.after(() => { server.close(); monitor.stop(); });
  const { fetchRemote } = require("../src/providers/remote");
  const { VERSION } = require("../server/server");
  const dead = "http://127.0.0.1:1/usage";      // puerto cerrado: conexión rechazada

  let r = await fetchRemote({ local: `${url}/usage`, online: dead }, "tk");
  assert.deepStrictEqual([r.via, r.version, r.usage.utilization], ["local", VERSION, 40]);
  r = await fetchRemote({ local: dead, online: `${url}/usage` }, "tk");
  assert.deepStrictEqual([r.via, r.version], ["online", VERSION]);
  r = await fetchRemote({ online: `${url}/usage` }, "tk");
  assert.strictEqual(r.via, "online");
  // Si la local responde con error (token), no se prueba la online: el servidor sí respondió.
  await assert.rejects(fetchRemote({ local: `${url}/usage`, online: `${url}/usage` }, "malo"), e => e.via === "local" && e.serverVersion === VERSION && /token/.test(e.message));
  await assert.rejects(fetchRemote({ local: dead, online: dead }, "tk"), /No se pudo conectar.*No se pudo conectar/);
  const health = await (await fetch(`${url}/health`)).json();
  assert.strictEqual(health.version, VERSION);
});

test("token obligatorio: vacío no deja pasar a nadie, «none» deja pasar a todos", async t => {
  const config = { ...readConfig({}), sessionKey: "sk", apiToken: "", baseUrl: "http://127.0.0.1:9" };
  const monitor = createMonitor(config, quiet);
  monitor.state.fetchedAt = Date.now(); monitor.state.usage = CLAUDE_AI;
  const server = createServer(monitor, config);
  const url = await listen(server);
  t.after(() => { server.close(); monitor.stop(); });
  await assert.rejects(fetchUsage(`${url}/usage`, ""), /rechazó el token/);
  await assert.rejects(fetchUsage(`${url}/usage`, "cualquiera"), /rechazó el token/);
  config.apiToken = "none";
  assert.strictEqual((await fetchUsage(`${url}/usage`, "")).utilization, 40);
});
test("el servidor no arranca sin API_TOKEN y explica cómo generarlo", () => {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [require.resolve("../server/server.js")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CLAUDE_SESSION_KEY: "sk", API_TOKEN: "", PORT: "0" }, encoding: "utf8", timeout: 10000 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Falta API_TOKEN.*Generar/s);
  assert.match(r.stderr, /API_TOKEN=none/);
});

test("página web: se sirve sin token, con CSP estricta, y no lleva datos de uso", async t => {
  const config = { ...readConfig({}), sessionKey: "sk", apiToken: "tk", baseUrl: "http://127.0.0.1:9" };
  const monitor = createMonitor(config, quiet);
  monitor.state.fetchedAt = Date.now(); monitor.state.usage = CLAUDE_AI;
  const server = createServer(monitor, config);
  const url = await listen(server);
  t.after(() => { server.close(); monitor.stop(); });
  const page = await fetch(`${url}/`);
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  const html = await page.text();
  assert.match(html, /<script src="app.js">/);
  assert.ok(!html.includes("seven_day_opus") && !html.includes("92"), "la página no incrusta datos");
  for (const [file, type] of [["app.js", /javascript/], ["style.css", /css/]]) {
    const r = await fetch(`${url}/${file}`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get("content-type"), type);
  }
  assert.strictEqual((await fetch(`${url}/server.js`)).status, 404, "solo se sirven los archivos de web/");
  assert.strictEqual((await fetch(`${url}/../server.js`)).status, 404);
  assert.strictEqual((await fetch(`${url}/`, { method: "POST" })).status, 405);
  assert.strictEqual((await fetch(`${url}/usage`)).status, 401, "los datos siguen pidiendo token");
});

// Fuente «Claude Code»: login de ~/.claude/.credentials.json contra un Anthropic simulado.
const fs = require("fs");
const os = require("os");
const path = require("path");
function fakeAnthropic(t) {
  const seen = { usage: [], token: [] };
  let valid = new Set(["acceso-1"]), rejectRefresh = false;
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/oauth/token" && req.method === "POST") {
        const b = JSON.parse(raw);
        seen.token.push(b);
        if (rejectRefresh || b.refresh_token !== "renueva-1") { res.writeHead(400); return res.end(JSON.stringify({ error: "invalid_grant" })); }
        valid.add("acceso-2");
        return res.end(JSON.stringify({ access_token: "acceso-2", refresh_token: "renueva-2", expires_in: 28800, scope: "user:inference user:profile" }));
      }
      if (req.url === "/api/oauth/usage") {
        seen.usage.push({ auth: req.headers.authorization, beta: req.headers["anthropic-beta"] });
        if (!valid.has(String(req.headers.authorization).replace(/^Bearer /, ""))) { res.writeHead(401); return res.end("{}"); }
        return res.end(JSON.stringify({ ...CLAUDE_AI, seven_day_opus: null, seven_day_breakdown: { rows: [] } }));
      }
      res.writeHead(404); res.end("{}");
    });
  });
  t.after(() => upstream.close());
  return { upstream, seen, revoke: tok => valid.delete(tok), allow: tok => valid.add(tok), set rejectRefresh(v) { rejectRefresh = v; } };
}
function credentialsFile(t, oauth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-cred-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".credentials.json");
  fs.writeFileSync(file, JSON.stringify({ otro: { x: 1 }, claudeAiOauth: { accessToken: "acceso-1", refreshToken: "renueva-1", scopes: ["user:inference", "user:profile"], subscriptionType: "max", ...oauth } }));
  return file;
}
async function claudeCodeMonitor(t, file, env = {}) {
  const fake = fakeAnthropic(t);
  const base = await listen(fake.upstream);
  const config = { ...readConfig({ CLAUDE_CREDENTIALS_FILE: file, ...env }), apiToken: "tk", apiUrl: base, tokenUrl: `${base}/v1/oauth/token` };
  const logs = [];
  const monitor = createMonitor(config, { error: m => logs.push(m), log() {} });
  t.after(() => monitor.stop());
  return { fake, monitor, config };
}

test("Claude Code: consulta el uso con el login del archivo", async t => {
  const file = credentialsFile(t, { expiresAt: Date.now() + 3600e3 });
  const { fake, monitor } = await claudeCodeMonitor(t, file);
  await monitor.pollOnce();
  assert.strictEqual(monitor.state.error, null);
  assert.strictEqual(monitor.state.source, "claude-code");
  assert.strictEqual(monitor.state.usage.five_hour.utilization, 40);
  assert.deepStrictEqual(fake.seen.usage[0], { auth: "Bearer acceso-1", beta: "oauth-2025-04-20" });
  assert.strictEqual(fake.seen.token.length, 0, "con el acceso vigente no renueva");
  assert.strictEqual(parseRemote({ fetchedAt: Date.now(), usage: monitor.state.usage }, Date.now()).weekly.length, 1, "ignora topes nulos y el desglose");
});

test("Claude Code: con el acceso vencido lo renueva y lo guarda sin pisar lo demás", async t => {
  const file = credentialsFile(t, { expiresAt: Date.now() - 1000 });
  const { fake, monitor } = await claudeCodeMonitor(t, file);
  fake.revoke("acceso-1");
  await monitor.pollOnce();
  assert.strictEqual(monitor.state.error, null);
  assert.strictEqual(fake.seen.token.length, 1);
  assert.deepStrictEqual(fake.seen.token[0], { grant_type: "refresh_token", refresh_token: "renueva-1", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", scope: "user:inference user:profile" });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(saved.otro, { x: 1 });
  assert.strictEqual(saved.claudeAiOauth.accessToken, "acceso-2");
  assert.strictEqual(saved.claudeAiOauth.refreshToken, "renueva-2");
  assert.strictEqual(saved.claudeAiOauth.subscriptionType, "max");
  assert.ok(saved.claudeAiOauth.expiresAt > Date.now() + 7 * 3600e3);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), [".credentials.json"], "sin temporales");
  await monitor.pollOnce();
  assert.strictEqual(fake.seen.token.length, 1, "la siguiente consulta usa el acceso guardado");
});

test("Claude Code: si el archivo ya trae un acceso nuevo (lo renovó Claude Code), lo usa sin renovar", async t => {
  const file = credentialsFile(t, { expiresAt: Date.now() + 3600e3 });
  const { fake, monitor } = await claudeCodeMonitor(t, file);
  await monitor.pollOnce();
  fake.revoke("acceso-1");
  fake.allow("acceso-2");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.claudeAiOauth.accessToken = "acceso-2";
  fs.writeFileSync(file, JSON.stringify(data));
  await monitor.pollOnce();
  assert.strictEqual(monitor.state.error, null);
  assert.strictEqual(fake.seen.token.length, 0);
});

test("Claude Code: solo lectura y renovación rechazada dan errores claros", async t => {
  const file = credentialsFile(t, { expiresAt: Date.now() - 1000 });
  const ro = await claudeCodeMonitor(t, file, { CLAUDE_CREDENTIALS_RENEW: "false" });
  await ro.monitor.pollOnce();
  assert.match(ro.monitor.state.error, /venció.*CLAUDE_CREDENTIALS_RENEW/);
  assert.strictEqual(ro.fake.seen.token.length, 0);

  const rw = await claudeCodeMonitor(t, file);
  rw.fake.rejectRefresh = true;
  await rw.monitor.pollOnce();
  assert.match(rw.monitor.state.error, /\/login/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth.accessToken, "acceso-1", "no toca el archivo si falla");

  const missing = await claudeCodeMonitor(t, path.join(path.dirname(file), "no-existe.json"));
  await missing.monitor.pollOnce();
  assert.match(missing.monitor.state.error, /monta la carpeta ~\/\.claude/);
});
