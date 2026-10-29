// Backtest: reproduce un flujo de lecturas (sintético o CSV exportado) por la función `step` de la extensión
// y compara el motor probabilístico con el lineal anterior contra lo que realmente ocurrió en cada ventana.
const { load } = require("./load");
const { simulate, MIN } = require("./sim");

function runBacktest({ profile, seed, days, quantized = false, paths, readings, truth, stepOpts = {} }) {
  const m = load();
  if (!readings) ({ readings, windows: truth } = simulate({ profile, seed, days, quantized }));
  const truthBy = new Map(truth.map(w => [w.resetsAt, w]));
  let persisted = { samples: [], windows: [], forecastLog: [], state: { status: "idle" } };
  const t0 = readings[0].ts;
  const checkpoints = [], stability = { prob: [], lin: [] };
  const durations = [];
  let lastCp = 0;
  const perWindow = new Map();
  const win = r => { if (!perWindow.has(r)) perWindow.set(r, { prob: [], lin: [], danger: { prob: null, lin: null }, any: { prob: null, lin: null } }); return perWindow.get(r); };

  for (const rd of readings) {
    const usage = { utilization: rd.utilization, resetsAt: rd.resetsAt, idle: rd.idle, weekly: [] };
    const h0 = process.hrtime.bigint();
    const res = m.step(persisted, usage, rd.ts, { engine: "prob", paths, ...stepOpts });
    durations.push(Number(process.hrtime.bigint() - h0) / 1e6);
    persisted = res.persisted;
    if (rd.idle) continue;
    const state = persisted.state, f = state.forecast;
    if (!f) continue;
    const proj = m.projection(state, rd.ts);
    const lin = { ...state, forecast: null, verdictMemo: null };
    const lproj = m.projection(lin, rd.ts);
    const level = m.levelFor(state, proj, rd.ts), llevel = m.levelFor(lin, lproj, rd.ts);
    const w = win(rd.resetsAt);
    w.prob.push([rd.ts, level]); w.lin.push([rd.ts, llevel]);
    const elapsed = (rd.ts - (rd.resetsAt - 5 * 3600e3)) / MIN;
    if (level === "danger" && !w.danger.prob && elapsed >= 20) w.danger.prob = rd.ts;
    if (llevel === "danger" && !w.danger.lin && elapsed >= 20) w.danger.lin = rd.ts;
    if ((level === "danger" || level === "warn") && !w.any.prob && elapsed >= 20) w.any.prob = rd.ts;
    if ((llevel === "danger" || llevel === "warn") && !w.any.lin && elapsed >= 20) w.any.lin = rd.ts;
    const R = (rd.resetsAt - rd.ts) / MIN;
    if (rd.ts - lastCp >= 10 * MIN && R > 10 && rd.utilization < 99.5) {
      lastCp = rd.ts;
      checkpoints.push({
        ts: rd.ts, day: Math.floor((rd.ts - t0) / 864e5), resetsAt: rd.resetsAt, u: rd.utilization,
        p: f.pHit, hitMed: f.hitQ ? f.hitQ[1] : 0, hitLo: f.hitQ ? f.hitQ[0] : 0, hitHi: f.hitQ ? f.hitQ[2] : 0, finalQ: f.finalQ,
        act: f.drivers.active ? 1 : 0, age: f.drivers.age0, R: Math.round(R), theta: f.theta,
        lWill: lproj.willHit ? 1 : 0, lHit: lproj.willHit ? lproj.hitAt : 0, lLevel: llevel, level
      });
    }
  }
  // estabilidad (por lectura)
  for (const [, w] of perWindow) for (const k of ["prob", "lin"]) {
    const seq = w[k]; let changes = 0, flicker = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i][1] !== seq[i - 1][1]) {
        changes++;
        // A -> B -> A en menos de 15 min
        for (let j = i + 1; j < seq.length && seq[j][0] - seq[i][0] < 15 * MIN; j++) {
          if (seq[j][1] === seq[i - 1][1]) { flicker++; break; }
          if (seq[j][1] !== seq[i][1]) break;
        }
      }
    }
    stability[k].push({ changes, flicker });
  }
  const windowsEval = [...perWindow.entries()].map(([r, w]) => {
    const t = truthBy.get(r);
    return t ? { resetsAt: r, hit: t.hit, hitTs: t.hitTs, peak: t.peak, dangerProb: w.danger.prob, dangerLin: w.danger.lin, anyProb: w.any.prob, anyLin: w.any.lin } : null;
  }).filter(Boolean);
  durations.sort((a, b) => a - b);
  return { profile, seed, days, quantized, checkpoints, windowsEval, stability, cpu: { p50: durations[Math.floor(durations.length * 0.5)], p95: durations[Math.floor(durations.length * 0.95)], max: durations[durations.length - 1] }, truthWindows: truth.length };
}
module.exports = { runBacktest };

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
  const out = runBacktest({ profile: args.profile || "bursty", seed: +(args.seed || 1), days: +(args.days || 28), quantized: args.int === "1", paths: args.paths ? +args.paths : undefined, stepOpts: args.opts ? JSON.parse(args.opts) : {} });
  process.stdout.write(JSON.stringify(out));
}
