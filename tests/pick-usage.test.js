const test = require("node:test");
const assert = require("node:assert");
const { pickUsage } = require("../src/pick-usage");

const ok = { utilization: 40, resetsAt: 1, idle: false, weekly: [] };
const idle = { utilization: 0, resetsAt: null, idle: true, weekly: [] };
const fail = kind => () => { throw Object.assign(new Error("x " + kind), { kind }); };

test("fuente principal responde", async () => {
  const r = await pickUsage(["oauth", "claude-code"], { oauth: async () => ok, "claude-code": () => idle });
  assert.equal(r.via, "oauth"); assert.equal(r.fellBack, false); assert.equal(r.utilization, 40);
});
test("respaldo con uso real se acepta", async () => {
  const r = await pickUsage(["oauth", "claude-code"], { oauth: fail("noauth"), "claude-code": () => ok });
  assert.equal(r.via, "claude-code"); assert.equal(r.fellBack, true);
});
test("respaldo idle NO reemplaza a una principal caída (evita el 0 falso)", async () => {
  await assert.rejects(pickUsage(["oauth", "claude-code"], { oauth: fail("noauth"), "claude-code": () => idle }), e => e.kind === "noauth");
});
test("idle de la fuente principal sí es válido", async () => {
  const r = await pickUsage(["oauth", "claude-code"], { oauth: async () => idle, "claude-code": () => ok });
  assert.equal(r.idle, true); assert.equal(r.fellBack, false);
});
test("una sola fuente (archivo) idle es válido", async () => {
  const r = await pickUsage(["claude-code"], { "claude-code": () => idle });
  assert.equal(r.idle, true);
});
