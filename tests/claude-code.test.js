const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseFeed, readFeed, FEED_SCRIPT } = require("../src/providers/claude-code");

const NOW = Date.UTC(2026, 9, 28, 14, 0, 0);
const sec = ms => Math.floor(ms / 1000);

test("lee la ventana de 5 h y la semanal (resets_at en segundos)", () => {
  const u = parseFeed({ rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: sec(NOW + 3600e3) },
    seven_day: { used_percentage: 41.2, resets_at: sec(NOW + 86400e3) }
  } }, NOW);
  assert.equal(u.utilization, 23.5);
  assert.equal(u.resetsAt, sec(NOW + 3600e3) * 1000);
  assert.equal(u.idle, false);
  assert.deepEqual(u.weekly.map(w => [w.key, w.utilization]), [["seven_day", 41.2]]);
});
test("acepta resets_at en ISO 8601", () => {
  const u = parseFeed({ rate_limits: { five_hour: { used_percentage: 10, resets_at: new Date(NOW + 1800e3).toISOString() } } }, NOW);
  assert.equal(u.resetsAt, NOW + 1800e3);
});
test("una ventana vencida cuenta como sin uso", () => {
  const u = parseFeed({ rate_limits: { five_hour: { used_percentage: 90, resets_at: sec(NOW - 60e3) } } }, NOW);
  assert.equal(u.idle, true);
  assert.equal(u.utilization, 0);
});
test("ventana ausente (solo semanal) es sin uso en 5 h", () => {
  const u = parseFeed({ rate_limits: { seven_day: { used_percentage: 5, resets_at: sec(NOW + 3600e3) } } }, NOW);
  assert.equal(u.idle, true);
  assert.equal(u.weekly.length, 1);
});
test("sin rate_limits o archivo ausente o corrupto: error de tipo nofeed", () => {
  assert.throws(() => parseFeed({}, NOW), e => e.kind === "nofeed");
  assert.throws(() => readFeed(path.join(os.tmpdir(), "no-existe-usage-monitor.json"), NOW), e => e.kind === "nofeed");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "um-feed-")), "x.json");
  fs.writeFileSync(f, "{no json");
  assert.throws(() => readFeed(f, NOW), e => e.kind === "nofeed");
});
test("el uso se limita a 0-100", () => {
  const u = parseFeed({ rate_limits: { five_hour: { used_percentage: 130, resets_at: sec(NOW + 3600e3) } } }, NOW);
  assert.equal(u.utilization, 100);
});

test("el script guarda rate_limits, reenvía al comando original y no pisa con entradas sin límites", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-script-"));
  const script = path.join(dir, "feed.sh"), feed = path.join(dir, "feed.json");
  fs.writeFileSync(script, FEED_SCRIPT, { mode: 0o700 });
  const env = { ...process.env, USAGE_MONITOR_FEED: feed };
  const run = (input, ...args) => execFileSync("sh", [script, ...args], { input, env }).toString();

  const withLimits = JSON.stringify({ cwd: "/secreto", rate_limits: { five_hour: { used_percentage: 7, resets_at: sec(NOW + 3600e3) } } });
  const out = run(withLimits, "cat");
  assert.equal(out, withLimits, "el comando original recibe la entrada completa");
  const saved = fs.readFileSync(feed, "utf8");
  assert.equal(JSON.parse(saved).rate_limits.five_hour.used_percentage, 7);
  run(JSON.stringify({ cwd: "/otro" }));
  assert.equal(fs.readFileSync(feed, "utf8"), saved, "una entrada sin rate_limits no sobrescribe");
  assert.equal(fs.statSync(feed).mode & 0o777, 0o600);
});

// ── Conexión con ~/.claude/settings.json (siempre en carpetas temporales) ──
const cc = require("../src/providers/claude-code");
function sandbox(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-conn-"));
  process.env.USAGE_MONITOR_FEED_DIR = path.join(dir, "um");
  const file = path.join(dir, "settings.json");
  if (initial !== undefined) fs.writeFileSync(file, typeof initial === "string" ? initial : JSON.stringify(initial, null, 2));
  return { dir, file, read: () => JSON.parse(fs.readFileSync(file, "utf8")), baks: () => fs.readdirSync(dir).filter(f => f.endsWith(".bak")) };
}
test("conectar sin statusLine: añade solo esa clave, instala el script y hace respaldo", () => {
  const s = sandbox({ model: "opus", hooks: { a: 1 } });
  const r = cc.connect(s.file);
  assert.equal(r.status, "new");
  const d = s.read();
  assert.equal(d.model, "opus"); assert.deepEqual(d.hooks, { a: 1 });
  assert.equal(d.statusLine.command, `"${cc.scriptFile()}"`);
  assert.ok(fs.existsSync(cc.scriptFile()));
  assert.equal(s.baks().length, 1);
  assert.ok(cc.isConnected(s.file));
});
test("si el script desapareció, ya no cuenta como conectado y conectar lo reinstala", () => {
  const s = sandbox({});
  cc.connect(s.file);
  fs.rmSync(cc.scriptFile());
  assert.equal(cc.isConnected(s.file), false);
  cc.connect(s.file);
  assert.ok(fs.existsSync(cc.scriptFile()) && cc.isConnected(s.file));
});
test("conectar es idempotente", () => {
  const s = sandbox({});
  cc.connect(s.file);
  const again = cc.connect(s.file);
  assert.equal(again.status, "connected");
  assert.equal(again.backup, null);
});
test("conectar con una statusLine existente la envuelve y desconectar la restaura", () => {
  const original = { type: "command", command: "~/mi-linea.sh --color", padding: 2 };
  const s = sandbox({ statusLine: original, x: 1 });
  assert.equal(cc.connect(s.file).status, "wrap");
  const wrapped = s.read().statusLine;
  assert.equal(wrapped.command, `"${cc.scriptFile()}" ~/mi-linea.sh --color`);
  assert.equal(wrapped.padding, 2);
  assert.equal(cc.disconnect(s.file).status, "removed");
  assert.deepEqual(s.read().statusLine, original);
  assert.equal(s.read().x, 1);
});
test("desconectar quita la clave si no había línea previa; si no estaba conectado no hace nada", () => {
  const s = sandbox({ a: 1 });
  assert.equal(cc.disconnect(s.file).status, "absent");
  assert.equal(s.baks().length, 0);
  cc.connect(s.file);
  cc.disconnect(s.file);
  assert.deepEqual(s.read(), { a: 1 });
});
test("settings.json ausente se crea; inválido o con statusLine rara no se toca", () => {
  const none = sandbox();
  assert.equal(cc.connect(none.file).status, "new");
  assert.equal(none.baks().length, 0);
  const bad = sandbox("{no json");
  assert.throws(() => cc.connect(bad.file), /no es JSON válido/);
  assert.equal(fs.readFileSync(bad.file, "utf8"), "{no json");
  const odd = sandbox({ statusLine: { type: "plugin" } });
  assert.throws(() => cc.connect(odd.file), /no es de tipo/);
  assert.deepEqual(odd.read(), { statusLine: { type: "plugin" } });
});
