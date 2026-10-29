const runs = JSON.parse(require('fs').readFileSync(process.argv[2]));
const prof = process.argv[3];
const cps = [];
for (const r of runs) { if (prof !== 'all' && r.profile !== prof) continue; const tw = new Map(r.windowsEval.map(w => [w.resetsAt, w])); for (const c of r.checkpoints) { if (c.day < 15) continue; const w = tw.get(c.resetsAt); if (w) cps.push({ ...c, y: w.hit ? 1 : 0 }); } }
console.log(prof, 'n', cps.length);
for (let b = 0; b < 10; b++) { const bin = cps.filter(c => Math.min(9, Math.floor(c.p * 10)) === b); if (!bin.length) continue; const mp = bin.reduce((a, c) => a + c.p, 0) / bin.length, my = bin.reduce((a, c) => a + c.y, 0) / bin.length; console.log(`  p∈[${b / 10},${(b + 1) / 10})  n=${String(bin.length).padStart(5)}  pred ${mp.toFixed(2)}  obs ${my.toFixed(2)}  ${my > mp + 0.05 ? 'SUBESTIMA' : my < mp - 0.05 ? 'sobreestima' : ''}`); }
