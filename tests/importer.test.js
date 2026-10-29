// Importación de CSV (src/importer.js): fusiona con lo existente sin borrar, es idempotente y rechaza archivos inválidos.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const engine = require("../src/engine");
const { mergeImport } = require("../src/importer");

const HOUR = 3600e3, DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 28, 14, 0, 0).getTime();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-monitor-import-"));
const write = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };

// Dos días de uso simulado (una ventana de 5 h por día, +1 pp cada 3 min), terminando 3 días antes de NOW.
function readings(startMs, windows) {
  const out = [];
  for (let w = 0; w < windows; w++) {
    const t0 = startMs + w * DAY, reset = t0 + 5 * HOUR;
    for (let i = 0; i <= 60; i++) out.push({ ts: t0 + i * 3 * 60e3, value: Math.min(100, 2 + i), resetsAt: reset });
  }
  return out;
}
const samplesCsv = rows => ["timestamp,uso_pct,reinicio"].concat(rows.map(r => `${new Date(r.ts).toISOString()},${r.value},${new Date(r.resetsAt).toISOString()}`)).join("\n");
const empty = () => ({ samples: [], blocks: undefined, model: undefined, windows: [], forecastLog: [], weeklyLog: [], state: { status: "idle" } });

test("importa lecturas: arma bloques, modelo y ventanas", () => {
  const rows = readings(NOW - 6 * DAY, 2);
  const { persisted, summary } = mergeImport(empty(), [write("a.csv", samplesCsv(rows))], NOW);
  assert.strictEqual(summary.lecturas, rows.length);
  assert(persisted.blocks.length > 20, "bloques construidos desde las lecturas");
  assert(persisted.model && Number.isFinite(persisted.model.lastClosedK));
  assert.strictEqual(persisted.windows.length, 2);
  assert(persisted.windows.every(w => w[2] >= 60));
});

test("es idempotente: importar dos veces el mismo archivo no duplica nada", () => {
  const f = write("b.csv", samplesCsv(readings(NOW - 6 * DAY, 2)));
  const once = mergeImport(empty(), [f], NOW).persisted;
  const twice = mergeImport(once, [f], NOW).persisted;
  assert.strictEqual(twice.samples.length, once.samples.length);
  assert.strictEqual(twice.blocks.length, once.blocks.length);
  assert.strictEqual(twice.windows.length, once.windows.length);
});

test("fusiona con lo existente sin borrarlo y lo ya registrado manda", () => {
  const old = mergeImport(empty(), [write("c1.csv", samplesCsv(readings(NOW - 6 * DAY, 1)))], NOW).persisted;
  const before = old.samples.length, beforeBlocks = old.blocks.length;
  const merged = mergeImport(old, [write("c2.csv", samplesCsv(readings(NOW - 4 * DAY, 1)))], NOW).persisted;
  assert(merged.samples.length > before && merged.blocks.length > beforeBlocks);
  assert.strictEqual(merged.windows.length, 2);
  // Una lectura con el mismo instante pero otro valor no pisa la existente
  const clash = write("c3.csv", samplesCsv([{ ts: old.samples[3].ts, value: 99, resetsAt: old.samples[3].resetsAt }]));
  const kept = mergeImport(old, [clash], NOW).persisted;
  assert.strictEqual(kept.samples.find(s => s.ts === old.samples[3].ts).value, old.samples[3].value);
});

test("importa el CSV semanal y lo fusiona por cupo y ciclo", () => {
  const reset = new Date(NOW + 3 * DAY).toISOString();
  const csv = ["cupo,reinicio,timestamp,uso_pct",
    `seven_day,${reset},${new Date(NOW - DAY).toISOString()},10`,
    `seven_day,${reset},${new Date(NOW).toISOString()},14`].join("\n");
  const a = mergeImport(empty(), [write("w.csv", csv)], NOW);
  assert.strictEqual(a.persisted.weeklyLog.length, 1);
  assert.strictEqual(a.persisted.weeklyLog[0][2], 14);
  assert.strictEqual(a.persisted.weeklyLog[0][3].length, 2);
  const b = mergeImport(a.persisted, [write("w2.csv", csv)], NOW).persisted;
  assert.strictEqual(b.weeklyLog[0][3].length, 2);                       // idempotente
});

test("rechaza archivos que no son del formato esperado o están vacíos", () => {
  assert.throws(() => mergeImport(empty(), [write("x.csv", "a,b\n1,2")], NOW), /no reconocido/);
  assert.throws(() => mergeImport(empty(), [write("y.csv", "timestamp,uso_pct,reinicio\n")], NOW), /no tiene datos/);
  assert.throws(() => mergeImport(empty(), [write("z.csv", "timestamp,uso_pct,reinicio\nnope,abc,")], NOW), /no tiene datos/);
});
