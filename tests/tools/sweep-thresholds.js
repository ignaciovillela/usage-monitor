const runs = JSON.parse(require('fs').readFileSync(process.argv[2]));
const MIN = 60e3;
// por ventana (días >= 15): máximo pHit alcanzado con >=30 min de antelación al agotamiento / en cualquier momento tras 20 min
const rows = [];
for (const r of runs) {
  const tw = new Map(r.windowsEval.map(w => [w.resetsAt, w]));
  const byW = new Map();
  for (const c of r.checkpoints) { if (c.day < 30) continue; const w = tw.get(c.resetsAt); if (!w) continue; if (!byW.has(c.resetsAt)) byW.set(c.resetsAt, { w, cps: [] }); byW.get(c.resetsAt).cps.push(c); }
  for (const { w, cps } of byW.values()) {
    const elapsed = c => (c.ts - (c.resetsAt - 5 * 3600e3)) / MIN;
    const pre = w.hit ? cps.filter(c => w.hitTs - c.ts >= 30 * MIN) : cps.filter(c => elapsed(c) >= 20);
    rows.push({ hit: w.hit, maxP: Math.max(0, ...pre.map(c => c.p)), prof: r.profile });
  }
}
const H = rows.filter(r => r.hit), N = rows.filter(r => !r.hit);
console.log('ventanas agotadas', H.length, 'no agotadas', N.length);
console.log('umbral  perdidas  falsas   (sobre máximo pHit alcanzado antes de agotarse con ≥30 min / en la ventana)');
for (const t of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7]) {
  const miss = H.filter(r => r.maxP < t).length / H.length, fa = N.filter(r => r.maxP >= t).length / N.length;
  console.log(t.toFixed(2).padEnd(7), (100 * miss).toFixed(0).padStart(5) + '%', (100 * fa).toFixed(0).padStart(7) + '%');
}
