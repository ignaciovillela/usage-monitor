// Importa los CSV que exporta el panel (Ajustes → Exportar CSV) y arma el historial y el modelo
// de la app, para que la "sesión propia" no parta de cero. Es Node puro (sin Electron).
const fs = require("fs");
const engine = require("./engine");

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(",").map(s => s.trim());
  return { header, rows: lines.filter(Boolean).map(l => l.split(",")) };
}
function readCsv(file) {
  const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
  if (header[0] === "timestamp") return { kind: "samples", rows };
  if (header[0] === "inicio_bloque") return { kind: "blocks", rows };
  throw new Error(`Formato de CSV no reconocido: ${file} (cabecera "${header.join(",")}")`);
}

function toSamples(rows) {
  return rows.map(([ts, value, reset]) => ({ ts: Date.parse(ts), value: Number(value), resetsAt: reset ? Date.parse(reset) : null }))
    .filter(s => Number.isFinite(s.ts) && Number.isFinite(s.value) && s.value >= 0 && s.value <= 100)
    .sort((a, b) => a.ts - b.ts);
}
function toBlocks(rows) {
  return rows.map(([start, v, d, flags]) => [Math.round(Date.parse(start) / engine.BLOCK_MS), Math.round(Number(v) * 10), Math.round(Number(d) * 10), Number(flags) || 0])
    .filter(b => Number.isFinite(b[0]) && Number.isFinite(b[1]) && Number.isFinite(b[2]))
    .sort((a, b) => a[0] - b[0]);
}
// Ventanas [inicio, reinicio, pico, hitTs|0] a partir de las muestras.
function toWindows(samples) {
  return engine.windowSummaries(samples).map(w => {
    const hit = samples.find(s => Number.isFinite(s.resetsAt) && engine.sameWindow(s.resetsAt, w.resetsAt) && s.value >= 99.5);
    return [w.start, w.resetsAt, w.peak, hit ? hit.ts : 0];
  });
}

// Devuelve el estado persistido de la app ({ samples, blocks, model, windows, forecastLog, state }) y un resumen.
function buildPersisted(files, now = Date.now()) {
  let samples = [], blocks = [];
  for (const f of files) {
    const csv = readCsv(f);
    if (csv.kind === "samples") samples = toSamples(csv.rows); else blocks = toBlocks(csv.rows);
  }
  if (!samples.length && !blocks.length) throw new Error("No hay datos que importar.");
  samples = engine.compactSamples(samples, now);
  const nowK = Math.floor(now / engine.BLOCK_MS);
  // Sin CSV de bloques se reconstruyen desde las muestras.
  if (!blocks.length) blocks = engine.buildBlocks(samples, -Infinity, nowK - 1);
  blocks = engine.mergeBlocks([], blocks, now);
  const model = engine.fitModel(blocks, now);
  // Los bloques posteriores al último importado se arman solos con las muestras en la siguiente lectura.
  model.lastClosedK = blocks.length ? blocks[blocks.length - 1][0] : nowK - 1;
  const persisted = { samples, blocks, model, windows: toWindows(samples), forecastLog: [], state: { status: "idle" } };
  const summary = {
    muestras: samples.length, bloques: blocks.length, ventanas: persisted.windows.length,
    desde: samples.length ? new Date(samples[0].ts).toISOString() : null, hasta: samples.length ? new Date(samples[samples.length - 1].ts).toISOString() : null,
    diasConDatos: model.days, datosEnteros: model.quantized, umbralActividad: model.thr
  };
  return { persisted, summary };
}
module.exports = { buildPersisted };
