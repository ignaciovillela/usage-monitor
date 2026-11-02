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
  const config = { ...readConfig({}), sessionKey: "sk", apiToken: "", baseUrl: base, refreshMinSeconds: 60 };
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
