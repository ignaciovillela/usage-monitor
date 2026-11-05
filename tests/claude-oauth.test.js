const test = require("node:test");
const assert = require("node:assert");
const oauth = require("../src/providers/claude-oauth");

const now = Date.parse("2026-11-03T13:00:00Z");
const creds = (expiresAt = now + 3600e3) => async () => ({ token: "tok-secreto", expiresAt });
const body = { five_hour: { utilization: 5.0, resets_at: "2026-11-03T16:59:59.832848+00:00" }, seven_day: { utilization: 1.0, resets_at: "2026-11-10T02:59:59+00:00" } };
const reply = (status, json) => async () => ({ status, json: async () => json });

test.beforeEach(() => oauth.resetCache());

test("tokenFromCredentials extrae accessToken y vencimiento", () => {
  const r = oauth.tokenFromCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "abc", expiresAt: 123 } }));
  assert.deepEqual(r, { token: "abc", expiresAt: 123 });
});
test("tokenFromCredentials sin sesión lanza noauth", () => {
  assert.throws(() => oauth.tokenFromCredentials("{}"), e => e.kind === "noauth");
  assert.throws(() => oauth.tokenFromCredentials("no json"), e => e.kind === "noauth");
});
test("readUsage devuelve el uso en la forma común y envía el token como Bearer", async () => {
  let sent;
  const u = await oauth.readUsage({ now: () => now, readCredentials: creds(), fetch: async (url, opts) => { sent = { url, opts }; return { status: 200, json: async () => body }; } });
  assert.equal(u.utilization, 5);
  assert.equal(u.idle, false);
  assert.equal(u.resetsAt, Date.parse("2026-11-03T16:59:59.832848+00:00"));
  assert.equal(u.weekly[0].utilization, 1);
  assert.equal(sent.opts.headers.Authorization, "Bearer tok-secreto");
});
test("token vencido lanza noauth sin consultar", async () => {
  let called = false;
  await assert.rejects(oauth.readUsage({ now: () => now, readCredentials: creds(now - 1), fetch: async () => { called = true; } }), e => e.kind === "noauth");
  assert.equal(called, false);
});
test("401 relee las credenciales una vez y reintenta", async () => {
  let reads = 0, calls = 0;
  const u = await oauth.readUsage({
    now: () => now,
    readCredentials: async () => ({ token: "t" + ++reads, expiresAt: now + 3600e3 }),
    fetch: async (_u, o) => { calls++; return o.headers.Authorization === "Bearer t1" ? { status: 401 } : { status: 200, json: async () => body }; }
  });
  assert.equal(u.utilization, 5);
  assert.equal(reads, 2); assert.equal(calls, 2);
});
test("401 persistente, 429 y otros códigos tienen su tipo de error", async () => {
  const base = { now: () => now, readCredentials: creds() };
  await assert.rejects(oauth.readUsage({ ...base, fetch: reply(401) }), e => e.kind === "noauth");
  oauth.resetCache();
  await assert.rejects(oauth.readUsage({ ...base, fetch: reply(429) }), e => e.kind === "limited");
  oauth.resetCache();
  await assert.rejects(oauth.readUsage({ ...base, fetch: reply(500) }), e => e.kind === "http" && /500/.test(e.message));
});
test("los errores no filtran el token", async () => {
  await assert.rejects(oauth.readUsage({ now: () => now, readCredentials: creds(), fetch: reply(500) }), e => !e.message.includes("tok-secreto"));
});

test("entre consultas reutiliza el último dato y no vuelve a llamar antes del intervalo", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { status: 200, json: async () => body }; };
  await oauth.readUsage({ now: () => now, readCredentials: creds(), fetch });
  const u = await oauth.readUsage({ now: () => now + 20e3, readCredentials: creds(), fetch });
  assert.equal(calls, 1); assert.equal(u.utilization, 5);
  await oauth.readUsage({ now: () => now + 121e3, readCredentials: creds(), fetch });
  assert.equal(calls, 2);
});
test("429 con dato previo devuelve el último dato y espera con backoff", async () => {
  let calls = 0, status = 200;
  const fetch = async () => { calls++; return { status, json: async () => body }; };
  await oauth.readUsage({ now: () => now, readCredentials: creds(), fetch });
  status = 429;
  const u = await oauth.readUsage({ now: () => now + 130e3, readCredentials: creds(), fetch });
  assert.equal(u.utilization, 5); assert.equal(calls, 2);
  await oauth.readUsage({ now: () => now + 160e3, readCredentials: creds(), fetch });
  assert.equal(calls, 2);      // sigue en espera
});
test("429 sin dato previo lanza limited y no reintenta durante el backoff", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { status: 429, json: async () => ({}) }; };
  await assert.rejects(oauth.readUsage({ now: () => now, readCredentials: creds(), fetch }), e => e.kind === "limited");
  await assert.rejects(oauth.readUsage({ now: () => now + 20e3, readCredentials: creds(), fetch }), e => e.kind === "limited");
  assert.equal(calls, 1);
});
