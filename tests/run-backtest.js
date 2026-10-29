// Ejecuta el backtest completo en paralelo y evalúa los criterios de aceptación del plan.
// Uso: node tests/run-backtest.js [--days 42] [--seeds 3] [--profiles bursty,marathon,...] [--int both|0|1]
const { spawn } = require("node:child_process");
const path = require("node:path");
const { metrics } = require("./metrics");
const { PROFILES } = require("./sim");

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const days = +(args.days || 42), seeds = +(args.seeds || 3);
const profiles = (args.profiles || Object.keys(PROFILES).join(",")).split(",");
const intModes = args.int === "0" ? [false] : args.int === "1" ? [true] : [false, true];
const jobs = [];
for (const p of profiles) for (let s = 1; s <= seeds; s++) for (const q of intModes) jobs.push({ p, s, q });

function runJob(j) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "backtest.js"), "--profile", j.p, "--seed", j.s, "--days", days, "--int", j.q ? "1" : "0", ...(args.opts ? ["--opts", args.opts] : [])], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.on("close", code => (code ? reject(new Error(`job ${JSON.stringify(j)} salió con ${code}`)) : resolve(JSON.parse(out))));
  });
}
async function pool(items, n, fn) {
  const results = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; results[k] = await fn(items[k]); } }));
  return results;
}
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "  n/a");
const pc = x => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "n/a");

(async () => {
  const t0 = Date.now();
  const runs = await pool(jobs, 6, runJob);
  if (args.dump) require('node:fs').writeFileSync(args.dump, JSON.stringify(runs));
  console.log(`# ${runs.length} simulaciones (${days} días) en ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  const warm = metrics(runs, { dayFrom: 15 }), cold = metrics(runs, { dayTo: 3 });
  const show = (title, m) => {
    if (!m) return console.log(`## ${title}: sin datos\n`);
    console.log(`## ${title}  (checkpoints ${m.checkpoints}, ventanas ${m.windows}, agotadas ${m.hitWindows})`);
    console.log(`Brier        prob ${f(m.brier.prob)}   lineal ${f(m.brier.lin)}   ratio ${f(m.brier.ratio, 2)}   (objetivo ≤ 0.80)`);
    console.log(`ECE          prob ${f(m.ece.prob)}   lineal ${f(m.ece.lin)}   (objetivo ≤ 0.07)`);
    console.log(`Cobertura    instante p10-p90 ${pc(m.coverage.hitInterval)}   uso final p10-p90 ${pc(m.coverage.finalInterval)}   (objetivo 72-88%)`);
    for (const [k, v] of Object.entries(m.mae)) console.log(`MAE ${k.padEnd(7)} n=${String(v.n).padStart(4)}  prob ${f(v.prob, 1)} min (cubre ${pc(v.probCov)})   lineal ${f(v.lin, 1)} min (cubre ${pc(v.linCov)})`);
    console.log(`Falsas alarm prob ${pc(m.falseAlarm.prob)}   lineal ${pc(m.falseAlarm.lin)}   (de ${m.falseAlarm.nonHit} ventanas no agotadas; objetivo ≤ 50% de la línea base)`);
    console.log(`Perdidas     prob ${pc(m.missed.prob)}   lineal ${pc(m.missed.lin)}   (de ${m.missed.hit}; objetivo ≤ lineal + 2pp)   antelación mediana prob ${f(m.leadMin.prob, 0)} min / lineal ${f(m.leadMin.lin, 0)} min`);
    console.log(`Ámbar+rojo   perdidas prob ${pc(m.anyAlert.missedProb)} lineal ${pc(m.anyAlert.missedLin)} (objetivo ≤ lineal + 2pp)   falsas prob ${pc(m.anyAlert.falseProb)} lineal ${pc(m.anyAlert.falseLin)}   antelación mediana prob ${f(m.anyAlert.leadProb, 0)} / lineal ${f(m.anyAlert.leadLin, 0)} min`);
    console.log(`Estabilidad  cambios/ventana prob ${f(m.stability.probChanges, 1)} lineal ${f(m.stability.linChanges, 1)}   parpadeos A-B-A prob ${f(m.stability.probFlicker, 2)} lineal ${f(m.stability.linFlicker, 2)}   (objetivo ≤ 0.2)\n`);
  };
  show(`Con historial (días 15-${days})`, warm);
  if (days > 36) show(`Con historial y recalibración (días 30-${days})`, metrics(runs, { dayFrom: 30 }));
  show("Arranque en frío (días 0-3)", cold);
  console.log("## Por perfil (días 15-42)");
  for (const p of profiles) {
    const m = metrics(runs.filter(r => r.profile === p), { dayFrom: 15 });
    if (m) console.log(`${p.padEnd(11)} Brier prob ${f(m.brier.prob)} lin ${f(m.brier.lin)} | ECE ${f(m.ece.prob)} | falsas ${pc(m.falseAlarm.prob)} vs ${pc(m.falseAlarm.lin)} | perdidas ${pc(m.missed.prob)} vs ${pc(m.missed.lin)} (${m.missed.hit}) | cambios ${f(m.stability.probChanges, 1)} vs ${f(m.stability.linChanges, 1)}`);
  }
  const cpu = runs.map(r => r.cpu), p95 = Math.max(...cpu.map(c => c.p95));
  console.log(`\nCPU por lectura: p50 ≤ ${f(Math.max(...cpu.map(c => c.p50)), 2)} ms, p95 ≤ ${f(p95, 2)} ms (objetivo < 10 ms), máx ${f(Math.max(...cpu.map(c => c.max)), 1)} ms`);
})().catch(e => { console.error(e); process.exit(1); });
