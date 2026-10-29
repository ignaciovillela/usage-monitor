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
  if (header[0] === "cupo") return { kind: "weekly", rows };
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

// Historial semanal [key, reinicio, pico, [[ts, uso], …]] a partir del CSV «Exportar semanal» (cupo,reinicio,timestamp,uso_pct).
function toWeekly(rows) {
  const byKey = new Map();
  for (const [key, reset, ts, v] of rows) {
    const resetsAt = Date.parse(reset), t = Date.parse(ts), value = Number(v);
    if (!key || !Number.isFinite(resetsAt) || !Number.isFinite(t) || !Number.isFinite(value)) continue;
    const id = `${key}|${resetsAt}`;
    if (!byKey.has(id)) byKey.set(id, [key, resetsAt, 0, []]);
    const r = byKey.get(id);
    r[3].push([t, value]); r[2] = Math.max(r[2], value);
  }
  return [...byKey.values()].map(r => { r[3].sort((a, b) => a[0] - b[0]); return r; });
}
function mergeWeekly(existing, imported, now) {
  const list = (existing || []).map(r => [r[0], r[1], r[2], r[3].slice()]);
  for (const imp of imported) {
    let r = list.find(x => x[0] === imp[0] && engine.sameWindow(x[1], imp[1]));
    if (!r) { list.push(imp); continue; }
    const seen = new Set(r[3].map(p => p[0]));
    for (const p of imp[3]) if (!seen.has(p[0])) r[3].push(p);
    r[3].sort((a, b) => a[0] - b[0]);
    r[2] = Math.max(r[2], imp[2]);
  }
  return list.filter(r => now - r[1] < engine.WEEKLY_RETENTION_MS).sort((a, b) => a[1] - b[1]);
}
function mergeWindows(existing, imported, now) {
  const list = (existing || []).map(w => w.slice());
  for (const imp of imported) {
    const w = list.find(x => engine.sameWindow(x[1], imp[1]));
    if (!w) { list.push(imp.slice()); continue; }
    w[2] = Math.max(w[2], imp[2]);
    w[3] = w[3] || imp[3];
  }
  return list.filter(w => now - w[1] < engine.WINDOWS_RETENTION_MS).sort((a, b) => a[1] - b[1]);
}

// Fusiona los CSV con lo que la app ya tiene (no borra nada): lecturas (por hora), bloques (lo ya registrado manda
// en caso de solaparse), ventanas y semanal. Reajusta el modelo con el historial resultante. `existing` es el estado
// persistido; devuelve uno nuevo y un resumen de lo importado.
function mergeImport(existing, files, now = Date.now()) {
  let impSamples = [], impBlocks = [], impWeekly = [];
  for (const f of files) {
    const csv = readCsv(f);
    if (csv.kind === "samples") impSamples = impSamples.concat(toSamples(csv.rows));
    else if (csv.kind === "blocks") impBlocks = impBlocks.concat(toBlocks(csv.rows));
    else impWeekly = impWeekly.concat(toWeekly(csv.rows));
  }
  if (!impSamples.length && !impBlocks.length && !impWeekly.length) throw new Error("El archivo no tiene datos que importar.");

  const byTs = new Map();
  for (const x of impSamples) byTs.set(x.ts, x);
  for (const x of existing.samples || []) byTs.set(x.ts, x);       // lo ya registrado manda
  const samples = engine.compactSamples([...byTs.values()].sort((a, b) => a.ts - b.ts), now);

  const nowK = Math.floor(now / engine.BLOCK_MS);
  if (!impBlocks.length && impSamples.length) impBlocks = engine.buildBlocks(impSamples, -Infinity, nowK - 1);
  const blocks = engine.mergeBlocks(impBlocks, existing.blocks || [], now);
  const model = engine.fitModel(blocks, now);
  const lastK = blocks.length ? blocks[blocks.length - 1][0] : nowK - 1;
  model.lastClosedK = Math.max(lastK, existing.model && Number.isFinite(existing.model.lastClosedK) ? existing.model.lastClosedK : -Infinity);

  const windows = mergeWindows(existing.windows, toWindows(impSamples), now);
  const weeklyLog = mergeWeekly(existing.weeklyLog, impWeekly, now);
  const summary = {
    lecturas: impSamples.length, bloques: impBlocks.length, semanal: impWeekly.length,
    desde: impSamples.length ? impSamples[0].ts : null, hasta: impSamples.length ? impSamples[impSamples.length - 1].ts : null
  };
  return { persisted: { ...existing, samples, blocks, model, windows, weeklyLog }, summary };
}
module.exports = { buildPersisted, mergeImport };
