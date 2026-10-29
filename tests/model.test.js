const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");
const m = load();
const { MINUTE, HOUR, WINDOW_MS, BLOCK_MS } = m;

// Miércoles 28-oct-2026 14:00 hora local: horario laboral, día de semana.
const NOW = new Date(2026, 9, 28, 14, 0, 0).getTime();
const S = (min, value, resetsAt, base = NOW) => ({ ts: base - min * MINUTE, value, resetsAt: resetsAt ?? null });

test("makeRng es determinista y uniforme", () => {
  const a = m.makeRng(42), b = m.makeRng(42), c = m.makeRng(43);
  const xs = Array.from({ length: 1000 }, a), ys = Array.from({ length: 1000 }, b);
  assert.deepStrictEqual(xs, ys);
  assert.notStrictEqual(c(), xs[0]);
  assert(xs.every(x => x >= 0 && x < 1));
  assert(Math.abs(xs.reduce((p, q) => p + q) / 1000 - 0.5) < 0.05);
});

test("sampleGamma tiene la media correcta", () => {
  const rng = m.makeRng(7);
  for (const shape of [0.5, 2, 6]) {
    const mean = Array.from({ length: 4000 }, () => m.sampleGamma(rng, shape)).reduce((a, b) => a + b) / 4000;
    assert(Math.abs(mean - shape) < 0.15 * Math.max(1, shape), `shape ${shape}: ${mean}`);
  }
});

test("buildBlocks: incrementos, huecos, reinicios, tope y sin ventana", () => {
  const R1 = NOW + 3 * HOUR;
  // Tres bloques contiguos con lecturas cada minuto: sube 1 pp por bloque de 10 min, luego pausa
  const samples = [];
  for (let i = 0; i <= 35; i++) samples.push(S(60 - i, 10 + Math.min(i, 20) * 0.5, R1));
  const k0 = Math.floor(samples[0].ts / BLOCK_MS);
  const blocks = m.buildBlocks(samples, -Infinity, Math.floor(NOW / BLOCK_MS) + 5);
  assert(blocks.length >= 3);
  assert(blocks[0][3] & 1, "primer bloque sin referencia = GAP");
  const mid = blocks[1];
  assert(mid[2] > 0 && !(mid[3] & 1), "bloque contiguo con consumo y sin GAP");
  // Hueco de 2 h
  const gap = [S(200, 5, R1), S(199, 6, R1), S(10, 20, R1), S(9, 21, R1)];
  const gb = m.buildBlocks(gap, -Infinity, 1e9);
  assert(gb.at(-1)[3] & 1, "tras un hueco el bloque queda marcado GAP");
  // Reinicio: 95 -> 3 cuenta 3 pp en el bloque nuevo
  const rs = [S(5, 95, R1), S(4, 96, R1), S(3, 3, R1 + 5 * HOUR), S(2, 4, R1 + 5 * HOUR)];
  const rb = m.buildBlocks(rs, -Infinity, 1e9);
  assert(rb.some(b => b[3] & 2), "reinicio marcado");
  // Tope: 100 -> 100 es CENSORED
  const cap = [S(5, 99.8, R1), S(4, 100, R1), S(3, 100, R1), S(2, 100, R1)];
  assert(m.buildBlocks(cap, -Infinity, 1e9).some(b => b[3] & 4));
  // Sin ventana
  const nw = [S(5, 0, null), S(4, 0, null), S(3, 0, null)];
  assert(m.buildBlocks(nw, -Infinity, 1e9).every(b => b[3] & 8));
  assert.strictEqual(k0, Math.floor(samples[0].ts / BLOCK_MS));
});

test("fitModel sin datos devuelve (esencialmente) los priors", () => {
  const model = m.fitModel([], NOW);
  assert(Math.abs(model.pStart[14] - 0.15) < 1e-3 && Math.abs(model.pStart[3] - 0.03) < 1e-3);
  assert(Math.abs(model.pStart[24 + 14] - 0.15) < 1e-3);
  assert.deepStrictEqual(model.pStay, [0.55, 0.72, 0.85, 0.92]);
  assert(Math.abs(model.mu - 1.5 * Math.exp(0.5)) < 0.01);
  assert.strictEqual(model.days, 0);
});

test("fitModel aprende horarios y tamaños del usuario", () => {
  // 20 días: entre 10 y 12 h alterna activo/pausa con escalones de 4 pp; el resto del día nunca consume
  const blocks = [];
  for (let d = 20; d >= 1; d--) {
    for (let h = 9; h < 17; h++) for (let b = 0; b < 6; b++) {
      const k = Math.floor((NOW - d * 24 * HOUR - (14 - h) * HOUR + b * BLOCK_MS) / BLOCK_MS);
      const active = (h === 10 || h === 11) && b % 2 === 0;
      blocks.push([k, 100, active ? 40 : 0, 0]);
    }
  }
  blocks.sort((a, b) => a[0] - b[0]);
  const model = m.fitModel(blocks, NOW);
  // índices por hora local de los bloques; se toman las horas reales de cada día simulado
  const idxOf = h => m.hourIdx(Math.floor((NOW - 7 * 24 * HOUR - (14 - h) * HOUR) / BLOCK_MS));
  const weekday = h => (idxOf(h) < 24 ? idxOf(h) : idxOf(h) - 24);
  assert(model.pStart[weekday(11)] > 0.5, `pStart[11]=${model.pStart[weekday(11)]}`);
  assert(model.pStart[weekday(15)] < 0.05, `pStart[15]=${model.pStart[weekday(15)]}`);
  assert(model.pStay[0] < 0.3, `pStay[0]=${model.pStay[0]}`);   // tras un bloque activo viene pausa
  assert(model.mu > 3 && model.mu < 4.5, `mu=${model.mu}`);
  assert(model.days >= 18);
});

function windowOf(points, resetsAt) { return points.map(([min, v]) => S(min, v, resetsAt)); }
function ctxFor(points, u, resetsAt, now = NOW) {
  const win = windowOf(points, resetsAt);
  return m.windowContext(win, { utilization: u, resetsAt }, now);
}

test("forecast: invariantes", () => {
  const model = m.fitModel([], NOW);
  const R = NOW + 2 * HOUR;
  const pts = [[60, 20], [30, 22], [10, 25], [0, 30]];
  let last = -1;
  for (const u of [10, 30, 50, 70, 90, 98]) {
    const ctx = { ...ctxFor(pts, u, R), u };
    const f = m.forecast(ctx, model, NOW, { seed: 99 });
    assert(f.pHit >= last - 1e-9, `pHit monótona: ${f.pHit} < ${last} en u=${u}`);
    last = f.pHit;
    assert(f.finalQ[0] <= f.finalQ[1] && f.finalQ[1] <= f.finalQ[2]);
    for (const [, a, b, c] of f.band) assert(a <= b + 1e-6 && b <= c + 1e-6);
    for (let i = 1; i < f.band.length; i++) assert(f.band[i][2] >= f.band[i - 1][2] - 1e-6, "mediana no decrece");
    if (f.hitQ) assert(f.hitQ[0] <= f.hitQ[1] && f.hitQ[1] <= f.hitQ[2]);
  }
  const full = m.forecast({ ...ctxFor(pts, 99.7, R), u: 99.7 }, model, NOW, { seed: 1 });
  assert.strictEqual(full.pHit, 1);
  const done = m.forecast({ ...ctxFor(pts, 50, NOW), u: 50 }, model, NOW, { seed: 1 });
  assert.strictEqual(done.pHit, 0);
  // Determinista con la misma semilla
  const a = m.forecast(ctxFor(pts, 40, R), model, NOW, { seed: 5 }), b = m.forecast(ctxFor(pts, 40, R), model, NOW, { seed: 5 });
  assert.deepStrictEqual(a.finalQ, b.finalQ);
  // Menos tiempo => menos probabilidad
  const short = m.forecast(ctxFor(pts, 60, NOW + 30 * MINUTE), model, NOW, { seed: 5 });
  const long = m.forecast(ctxFor(pts, 60, NOW + 150 * MINUTE), model, NOW, { seed: 5 });
  assert(long.pHit > short.pHit);
});

test("forecast: escenarios de arranque en frío", () => {
  const model = m.fitModel([], NOW);
  const level = (u, f, R) => m.rawLevel(u, f, R);
  // 15 % tras 60 min, con una ráfaga en los últimos 5 min: nunca rojo, pHit moderada
  const R1 = NOW + 240 * MINUTE;
  const burst = [[60, 0], [30, 3], [10, 5], [5, 5], [4, 7], [3, 9], [2, 11], [1, 13], [0, 15]];
  const ctx1 = ctxFor(burst, 15, R1);
  const f1 = m.forecast(ctx1, model, NOW, { seed: 3 });
  assert(f1.pHit < 0.45, `ráfaga: pHit=${f1.pHit}`);
  assert.notStrictEqual(level(15, f1, R1), "danger");
  // 60 % sostenido a 1 pp/min con ~100 min restantes: rojo
  const R2 = NOW + 100 * MINUTE;
  const hot = Array.from({ length: 31 }, (_, i) => [30 - i, 60 - (30 - i) * 1.0 * (i < 31 ? 1 : 0)]).map(([a, b]) => [a, 30 + (30 - a)]);
  const ctx2 = ctxFor(hot, 60, R2);
  const f2 = m.forecast(ctx2, model, NOW, { seed: 3 });
  assert(f2.pHit >= 0.35, `sostenido: pHit=${f2.pHit}`);   // sin historial: honesto, no certeza
  assert.notStrictEqual(level(60, f2, R2), "ok");
  // 80 % y 40 min en pausa, 2 h restantes: poco probable
  const R3 = NOW + 120 * MINUTE;
  const knots = [[200, 0], [120, 40], [60, 70], [41, 80], [0, 80]];
  const paused = [];
  for (let min = 200; min >= 0; min--) {  // lecturas cada minuto, interpolando linealmente entre los nudos
    const i = knots.findIndex((kn, j) => j < knots.length - 1 && min <= kn[0] && min >= knots[j + 1][0]);
    const [a, va] = knots[i], [b, vb] = knots[i + 1];
    paused.push([min, va + (vb - va) * (a - min) / (a - b)]);
  }
  const ctx3 = ctxFor(paused, 80, R3);
  const f3 = m.forecast(ctx3, model, NOW, { seed: 3 });
  assert(!ctx3.active0, "en pausa");
  assert(f3.pHit <= 0.35, `pausa: pHit=${f3.pHit}`);
});

test("histéresis: sube al instante, baja tras 3 lecturas, sin parpadeo", () => {
  const R = NOW + HOUR;
  const { dangerIn, dangerOut, warnOut } = m.HYST;
  let memo = m.applyHysteresis(null, "ok", 0.05, R);
  memo = m.applyHysteresis(memo, "danger", 0.7, R);
  assert.strictEqual(memo.level, "danger");
  // pHit oscila alrededor del umbral de entrada: el nivel crudo parpadea, el memo se queda en rojo
  const seq = [dangerIn + 0.02, dangerIn - 0.04, dangerIn + 0.02, dangerIn - 0.04, dangerIn + 0.01, dangerIn - 0.03];
  const changes = [];
  for (const p of seq) {
    const raw = p >= dangerIn ? "danger" : "warn";
    const next = m.applyHysteresis(memo, raw, p, R);
    if (next.level !== memo.level) changes.push(next.level);
    memo = next;
  }
  assert.deepStrictEqual(changes, []);
  // Baja de verdad: 3 lecturas seguidas bajo la salida
  const low = dangerOut - 0.05;
  for (let i = 0; i < 2; i++) memo = m.applyHysteresis(memo, "warn", low, R);
  assert.strictEqual(memo.level, "danger");
  memo = m.applyHysteresis(memo, "warn", low, R);
  assert.strictEqual(memo.level, "warn");
  // Una lectura alta reinicia el contador (entre warnOut y warnIn el ámbar se mantiene)
  memo = m.applyHysteresis(memo, "ok", warnOut - 0.05, R);
  memo = m.applyHysteresis(memo, "ok", warnOut - 0.05, R);
  memo = m.applyHysteresis(memo, "warn", warnOut + 0.03, R);
  memo = m.applyHysteresis(memo, "ok", warnOut - 0.05, R);
  assert.strictEqual(memo.level, "warn");
  // Nueva ventana: memoria nueva
  assert.strictEqual(m.applyHysteresis(memo, "ok", 0.0, R + 6 * HOUR).level, "ok");
});

test("registro de ventanas y Brier", () => {
  const R = NOW - 2 * HOUR; // ventana ya cerrada
  let { windows } = m.updateWindowLog([], { utilization: 40, resetsAt: R }, NOW - 5 * HOUR + 10 * MINUTE);
  ({ windows } = m.updateWindowLog(windows, { utilization: 100, resetsAt: R }, NOW - 3 * HOUR));
  assert.strictEqual(windows.length, 1);
  assert(windows[0][3] > 0 && windows[0][2] === 100);
  let log = [];
  ({ log } = m.appendForecastLog(log, { pHit: 0.9, hitQ: [1, 2, 3] }, R, 50, NOW - 4 * HOUR));
  ({ log } = m.appendForecastLog(log, { pHit: 0.7, hitQ: [1, 2, 3] }, R, 60, NOW - 3.2 * HOUR));
  const b = m.brierScore(log, windows, NOW);
  assert.strictEqual(b.n, 2);
  assert(Math.abs(b.brier - (0.01 + 0.09) / 2) < 1e-9);
});

test("explainForecast elige una línea razonable", () => {
  const model = m.fitModel([], NOW);
  const R = NOW + 2 * HOUR;
  const ctx = ctxFor([[60, 10], [30, 20], [10, 30], [0, 40]], 40, R);
  const f = m.forecast(ctx, model, NOW, { seed: 1 });
  const why = m.explainForecast(ctx, f, NOW);
  assert(/Sesión activa|más rápida|pausa|Quedan/.test(why), why);
  assert(why.includes("aún aprendiendo"));
});

test("recalibración logística: corrige subestimación sistemática y respeta el prior con pocos datos", () => {
  const R0 = NOW - 60 * HOUR;
  // 30 ventanas cerradas: el modelo dijo p=0.2 pero se agotaron 60 %
  const windows = [], log = [];
  for (let i = 0; i < 30; i++) {
    const r = R0 + i * 5 * HOUR, hit = i % 5 < 3;
    windows.push([r - 5 * HOUR, r, hit ? 100 : 50, hit ? r - HOUR : 0]);
    for (let j = 0; j < 6; j++) log.push([r, r - (4 - j * 0.5) * HOUR, 300, 200, 0]);
  }
  const cal = m.fitCalibration(log, windows, NOW + 1e9);
  assert(cal && cal.n === 30);
  const p = m.applyCalibration(0.2, cal);
  assert(p > 0.45 && p < 0.7, `p calibrada=${p}`);          // acerca 0.2 a ~0.6
  // Pocos datos => sin calibración
  assert.strictEqual(m.fitCalibration(log.slice(0, 20), windows.slice(0, 3), NOW + 1e9), null);
  // Ya calibrado: el prior mantiene la identidad aproximada
  const okLog = [], okWin = [];
  for (let i = 0; i < 30; i++) { const r = R0 + i * 5 * HOUR, hit = i % 2 === 0; okWin.push([r - 5 * HOUR, r, hit ? 100 : 50, hit ? r - HOUR : 0]); for (let j = 0; j < 6; j++) okLog.push([r, r - (4 - j * 0.5) * HOUR, 300, 500, 0]); }
  const cal2 = m.fitCalibration(okLog, okWin, NOW + 1e9);
  assert(Math.abs(m.applyCalibration(0.5, cal2) - 0.5) < 0.05, `p=${m.applyCalibration(0.5, cal2)}`);
  assert.strictEqual(m.applyCalibration(0.3, null), 0.3);
});

test("updateWeeklyLog: un registro por ciclo y cupo, puntos solo al cambiar, retención", () => {
  const R = NOW + 3 * 24 * HOUR;
  const wk = (u, extra = []) => [{ key: "seven_day", utilization: u, resetsAt: R }, ...extra];
  let log = [];
  let r = m.updateWeeklyLog(log, wk(40, [{ key: "seven_day_opus", utilization: 10, resetsAt: R }]), NOW);
  assert(r.changed); log = r.log;
  assert.strictEqual(log.length, 2);
  r = m.updateWeeklyLog(log, wk(40), NOW + MINUTE);               // sin cambio
  assert(!r.changed);
  r = m.updateWeeklyLog(log, wk(43), NOW + 2 * MINUTE); log = r.log;
  assert(r.changed);
  const seven = log.find(x => x[0] === "seven_day");
  assert.strictEqual(seven[2], 43);
  assert.strictEqual(seven[3].length, 2);
  r = m.updateWeeklyLog(log, wk(43), NOW + 7 * HOUR);              // keepalive cada 6 h
  assert(r.changed && seven[3].length === 3);
  r = m.updateWeeklyLog(log, [{ key: "seven_day", utilization: 2, resetsAt: R + 7 * 24 * HOUR }], NOW + 4 * 24 * HOUR);
  assert.strictEqual(r.log.filter(x => x[0] === "seven_day").length, 2);   // ciclo nuevo
  const late = NOW + 500 * 24 * HOUR;
  const old = m.updateWeeklyLog(r.log, [{ key: "seven_day", utilization: 5, resetsAt: late + 3 * 24 * HOUR }], late);
  assert.strictEqual(old.log.length, 1);                  // lo viejo se purga
  assert(!m.updateWeeklyLog([], [], NOW).changed && !m.updateWeeklyLog([], undefined, NOW).changed);
});
