// Métricas del backtest a partir de los registros de runBacktest.
const MIN = 60e3;
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function metrics(runs, { dayFrom = 0, dayTo = 1e9 } = {}) {
  const cps = [], wins = [], stab = { prob: [], lin: [] };
  const byWindowTruth = new Map();
  for (const run of runs) {
    for (const w of run.windowsEval) byWindowTruth.set(`${run.profile}|${run.seed}|${w.resetsAt}`, w);
    for (const c of run.checkpoints) {
      if (c.day < dayFrom || c.day >= dayTo) continue;
      const w = byWindowTruth.get(`${run.profile}|${run.seed}|${c.resetsAt}`);
      if (!w) continue;
      cps.push({ ...c, y: w.hit ? 1 : 0, hitTs: w.hitTs, peak: w.peak, key: `${run.profile}|${run.seed}|${c.resetsAt}` });
    }
    for (const w of run.windowsEval) wins.push({ ...w, key: `${run.profile}|${run.seed}|${w.resetsAt}`, day: Math.floor((w.resetsAt - 5 * 3600e3 - run.checkpoints[0]?.ts + 0) / 864e5) });
    stab.prob.push(...run.stability.prob); stab.lin.push(...run.stability.lin);
  }
  if (!cps.length) return null;
  const brierP = mean(cps.map(c => (c.p - c.y) ** 2)), brierL = mean(cps.map(c => (c.lWill - c.y) ** 2));
  // ECE de 10 tramos
  let ece = 0, eceL = 0;
  for (let b = 0; b < 10; b++) {
    const bin = cps.filter(c => Math.min(9, Math.floor(c.p * 10)) === b);
    if (bin.length) ece += bin.length / cps.length * Math.abs(mean(bin.map(c => c.p)) - mean(bin.map(c => c.y)));
  }
  const lbin = [cps.filter(c => c.lWill === 0), cps.filter(c => c.lWill === 1)];
  lbin.forEach((bin, i) => { if (bin.length) eceL += bin.length / cps.length * Math.abs(i - mean(bin.map(c => c.y))); });
  // cobertura de intervalos
  const hitCps = cps.filter(c => c.y && c.hitLo && c.hitTs);
  const covHit = hitCps.length ? mean(hitCps.map(c => (c.hitTs >= c.hitLo && c.hitTs <= c.hitHi ? 1 : 0))) : NaN;
  const covFinal = mean(cps.map(c => (c.peak >= c.finalQ[0] - 0.5 && c.peak <= c.finalQ[2] + 0.5 ? 1 : 0)));
  // MAE del instante de agotamiento por horizonte
  const maeBy = {};
  const buckets = [[0, 30], [30, 60], [60, 120], [120, 1e9]];
  for (const [lo, hi] of buckets) {
    const sub = cps.filter(c => c.y && c.hitTs && (c.hitTs - c.ts) / MIN >= lo && (c.hitTs - c.ts) / MIN < hi);
    const eP = sub.filter(c => c.hitMed).map(c => Math.abs(c.hitMed - c.hitTs) / MIN);
    const eL = sub.filter(c => c.lHit).map(c => Math.abs(c.lHit - c.hitTs) / MIN);
    maeBy[`${lo}-${hi === 1e9 ? "∞" : hi}`] = { n: sub.length, prob: mean(eP), probCov: sub.length ? eP.length / sub.length : NaN, lin: mean(eL), linCov: sub.length ? eL.length / sub.length : NaN };
  }
  // alarmas por ventana
  const wset = new Map();
  for (const c of cps) wset.set(c.key, wins.find(w => w.key === c.key));
  const W = [...wset.values()].filter(Boolean);
  const nonHit = W.filter(w => !w.hit), hit = W.filter(w => w.hit);
  const falseProb = nonHit.filter(w => w.dangerProb).length, falseLin = nonHit.filter(w => w.dangerLin).length;
  const missedProb = hit.filter(w => !(w.dangerProb && w.hitTs - w.dangerProb >= 30 * MIN)).length;
  const missedLin = hit.filter(w => !(w.dangerLin && w.hitTs - w.dangerLin >= 30 * MIN)).length;
  const lead = k => median(hit.filter(w => w[k]).map(w => (w.hitTs - w[k]) / MIN));
  const falseAnyP = nonHit.filter(w => w.anyProb).length, falseAnyL = nonHit.filter(w => w.anyLin).length;
  const missedAnyP = hit.filter(w => !(w.anyProb && w.hitTs - w.anyProb >= 30 * MIN)).length;
  const missedAnyL = hit.filter(w => !(w.anyLin && w.hitTs - w.anyLin >= 30 * MIN)).length;
  const per = a => mean(a.map(x => x.changes)), fl = a => mean(a.map(x => x.flicker));
  return {
    checkpoints: cps.length, windows: W.length, hitWindows: hit.length,
    brier: { prob: brierP, lin: brierL, ratio: brierP / brierL }, ece: { prob: ece, lin: eceL },
    coverage: { hitInterval: covHit, finalInterval: covFinal }, mae: maeBy,
    falseAlarm: { prob: nonHit.length ? falseProb / nonHit.length : 0, lin: nonHit.length ? falseLin / nonHit.length : 0, nonHit: nonHit.length },
    missed: { prob: hit.length ? missedProb / hit.length : 0, lin: hit.length ? missedLin / hit.length : 0, hit: hit.length },
    anyAlert: { missedProb: hit.length ? missedAnyP / hit.length : 0, missedLin: hit.length ? missedAnyL / hit.length : 0, falseProb: nonHit.length ? falseAnyP / nonHit.length : 0, falseLin: nonHit.length ? falseAnyL / nonHit.length : 0, leadProb: lead("anyProb"), leadLin: lead("anyLin") },
    leadMin: { prob: lead("dangerProb"), lin: lead("dangerLin") },
    stability: { probChanges: per(stab.prob), linChanges: per(stab.lin), probFlicker: fl(stab.prob), linFlicker: fl(stab.lin) }
  };
}
module.exports = { metrics };
