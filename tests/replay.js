// Reproduce tu historial real: node tests/replay.js archivo.csv
// El CSV es el que exporta el popup (Ajustes → Exportar CSV): timestamp,uso_pct,reinicio
// Mide qué habría dicho el modelo en cada ventana ya cerrada frente a lo que realmente pasó.
const fs = require("fs");
const { runBacktest } = require("./backtest");
const { metrics } = require("./metrics");

const file = process.argv[2];
if (!file) { console.error("Uso: node tests/replay.js historial.csv"); process.exit(1); }
const rows = fs.readFileSync(file, "utf8").trim().split("\n").slice(1).map(l => l.split(","))
  .map(([ts, u, r]) => ({ ts: Date.parse(ts), utilization: Number(u), resetsAt: r ? Date.parse(r) : null }))
  .filter(r => Number.isFinite(r.ts) && Number.isFinite(r.utilization)).sort((a, b) => a.ts - b.ts);
const readings = rows.map(r => ({ ...r, idle: !r.resetsAt }));

// Verdad: ventanas agrupadas por reinicio (tolerancia 10 min) con su pico real
const truth = [];
for (const r of rows) {
  if (!r.resetsAt) continue;
  let w = truth.find(x => Math.abs(x.resetsAt - r.resetsAt) < 10 * 60e3);
  if (!w) { w = { resetsAt: r.resetsAt, start: r.resetsAt - 5 * 3600e3, peak: 0, hit: false, hitTs: 0 }; truth.push(w); }
  if (r.utilization > w.peak) w.peak = r.utilization;
  if (!w.hit && r.utilization >= 99.5) { w.hit = true; w.hitTs = r.ts; }
}
// las lecturas deben usar exactamente el resetsAt de la ventana para casar con la verdad
for (const r of readings) if (r.resetsAt) r.resetsAt = truth.find(x => Math.abs(x.resetsAt - r.resetsAt) < 10 * 60e3).resetsAt;

const days = (rows.at(-1).ts - rows[0].ts) / 864e5;
console.log(`${rows.length} lecturas, ${days.toFixed(1)} días, ${truth.length} ventanas (${truth.filter(w => w.hit).length} agotadas)`);
const run = runBacktest({ profile: "real", seed: 0, days, readings, truth });
const m = metrics([run], { dayFrom: Math.min(7, days / 3) });
if (!m) { console.log("Datos insuficientes para evaluar."); process.exit(0); }
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
console.log(`Brier  modelo ${f(m.brier.prob)}  lineal ${f(m.brier.lin)}   ECE ${f(m.ece.prob)}`);
console.log(`Cobertura p10-p90: instante ${f(100 * m.coverage.hitInterval, 0)}%  uso final ${f(100 * m.coverage.finalInterval, 0)}%`);
console.log(`Ámbar+rojo: perdidas ${f(100 * m.anyAlert.missedProb, 0)}% (lineal ${f(100 * m.anyAlert.missedLin, 0)}%)  falsas ${f(100 * m.anyAlert.falseProb, 0)}% (lineal ${f(100 * m.anyAlert.falseLin, 0)}%)`);
console.log(`Cambios de veredicto por ventana: modelo ${f(m.stability.probChanges, 1)}  lineal ${f(m.stability.linChanges, 1)}`);
