// Proyección probabilística (solo service worker y pruebas; el popup y el widget leen state.forecast).
// Depende de util.js y core.js. No toca chrome.* ni Date.now(): todo recibe `now`, así que es reproducible.
//
// Modelo: el consumo llega en ráfagas. Cada bloque de 10 min el usuario está "activo" o "en pausa"
// (cadena de Markov con probabilidades que dependen de la hora/día y de cuánto lleva activo); si está
// activo, el bloque suma un escalón de tamaño aleatorio. Se aprende de bloques históricos con
// contracción hacia un prior (arranque en frío) y se simula el resto de la ventana (Monte Carlo)
// para obtener P(agotar el límite antes del reinicio) y cuantiles de la hora de agotamiento.

const BLOCK_MS = 10 * MINUTE;
const DAY_MS = 24 * HOUR;
const BLOCKS_RETENTION_MS = 42 * DAY_MS;
const WINDOWS_RETENTION_MS = 180 * DAY_MS;
const FLOG_RETENTION_MS = 90 * DAY_MS;
const WEEKLY_RETENTION_MS = 400 * DAY_MS;
const WEEKLY_KEEPALIVE_MS = 6 * HOUR;
const FLOG_EVERY_MS = 30 * MINUTE;
const MODEL_VERSION = 1;
const GAP_MS = 25 * MINUTE;        // sin lecturas más de esto = equipo dormido / Chrome cerrado
const FLAG_GAP = 1, FLAG_RESET = 2, FLAG_CENSORED = 4, FLAG_NOWIN = 8;
const ACT_THR = 0.5;               // pp por bloque para considerar "activo" (1 si los datos son enteros)
const PATHS = 400;
const FULL_CAP = 99.5;
const PRIORS = {
  startDay: 0.15, startNight: 0.03, dayFrom: 8,   // P(activo | pausa) por bloque, según la hora
  kappaHour: 6, kappaDay: 6, smooth: 0.25,        // pseudo-observaciones del prior hora->día; peso de cada hora vecina
  actLevelN: 5, actScaleMin: 0.25, actScaleMax: 4,
  stay: [0.55, 0.72, 0.85, 0.92], stayN: 20,      // P(activo | activo) según antigüedad de la sesión (1, 2-3, 4-7, ≥8 bloques)
  sizeMedian: 1.5, sizeSigma: 1.0, sizeN: 10, maxSizes: 500,
  halfLifeDays: 21,
  thetaMode: "ig", thetaA: 2, thetaB: 1, thetaTau: 0.4                            // intensidad de la ventana actual: 1/θ ~ Gamma(A, B)
};
const CAL_MIN_WINDOWS = 12;      // ventanas cerradas necesarias para recalibrar P(agotar)
const CAL_PRIOR = { a: 0, aSd: 0.5, b: 1, bSd: 0.3 };
const PROJECTION_ALERT_MIN = 45; // motor lineal: avisar si el límite llegaría en menos de esto
const PROB_ALERT_MIN = 60;       // motor probabilístico
const HYST = { dangerIn: 0.45, dangerOut: 0.30, warnIn: 0.20, warnOut: 0.12, downPolls: 3 };
const LEVEL_RANK = { ok: 0, warn: 1, danger: 2 };

// ── Aleatoriedad ────────────────────────────────────────────────────────────
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randn(rng) {
  const u = rng() || 1e-12, v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sampleGamma(rng, shape) { // Marsaglia-Tsang, escala 1
  if (shape < 1) return sampleGamma(rng, shape + 1) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = randn(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ── Bloques de 10 min ───────────────────────────────────────────────────────
// Un bloque: [k, vFin×10, d×10, flags], k = floor(ts / BLOCK_MS); d = pp consumidos en el bloque.
function hourIdx(k) { // 0..23 laborable, 24..47 fin de semana (hora local)
  const d = new Date(k * BLOCK_MS), day = d.getDay();
  return d.getHours() + (day === 0 || day === 6 ? 24 : 0);
}
function buildBlocks(samples, fromK, toK) {
  const out = [];
  let prev = null, cur = null;
  const flush = () => {
    if (cur && cur.k >= fromK) out.push([cur.k, Math.round(cur.v * 10), Math.round(cur.d * 10), cur.flags | (cur.nowin ? FLAG_NOWIN : 0)]);
  };
  for (const s of samples) {
    const k = Math.floor(s.ts / BLOCK_MS);
    if (k > toK) break;
    if (!cur || cur.k !== k) {
      flush();
      cur = { k, v: s.value, d: 0, flags: 0, nowin: true };
      if (!prev || s.ts - prev.ts > GAP_MS) cur.flags |= FLAG_GAP;
    }
    if (prev) {
      const reset = isReset(prev, s);
      if (reset) { cur.d += s.value; cur.flags |= FLAG_RESET; }
      else if (s.value > prev.value) cur.d += s.value - prev.value;
      if (!reset && prev.value >= FULL_CAP) cur.flags |= FLAG_CENSORED; // ya estaba en el tope: no pudo consumir
    }
    if (s.value > 0 || Number.isFinite(s.resetsAt)) cur.nowin = false;
    cur.v = s.value;
    prev = s;
  }
  flush();
  return out;
}
function mergeBlocks(old, fresh, now) {
  const byK = new Map();
  for (const b of old || []) byK.set(b[0], b);
  for (const b of fresh) byK.set(b[0], b);
  const minK = Math.floor((now - BLOCKS_RETENTION_MS) / BLOCK_MS);
  return [...byK.values()].filter(b => b[0] >= minK).sort((a, b) => a[0] - b[0]);
}
const ageBucket = run => (run <= 1 ? 0 : run <= 3 ? 1 : run <= 7 ? 2 : 3);

// ── Ajuste ──────────────────────────────────────────────────────────────────
function detectQuantized(blocks) {
  let n = 0, whole = 0;
  for (const b of blocks) if (b[1] > 0) { n++; if (b[1] % 10 === 0) whole++; }
  return n >= 30 && whole / n > 0.97;
}
function priorStart(h, P) { return h % 24 >= P.dayFrom ? P.startDay : P.startNight; }

// Una pasada sobre los bloques. Cada bloque pesa 0.5^(edad / vida media).
function fitModel(blocks, now, P = PRIORS) {
  const quantized = detectQuantized(blocks);
  const thr = quantized ? 1 : ACT_THR;
  const S0 = Array.from({ length: 48 }, () => ({ n: 0, k: 0 }));
  const S1 = Array.from({ length: 4 }, () => ({ n: 0, k: 0 }));
  const M = Array.from({ length: 48 }, () => ({ n: 0, k: 0 })); // fracción de bloques activos por hora (marginal)
  const sizes = [];
  const days = new Set();
  let prev = null, run = 0;
  for (const b of blocks) {
    const [k, , d10, flags] = b;
    const valid = !(flags & (FLAG_GAP | FLAG_CENSORED));
    const active = valid && d10 / 10 >= thr;
    const w = Math.pow(0.5, (now - k * BLOCK_MS) / (P.halfLifeDays * DAY_MS));
    if (valid) { days.add(Math.floor(k * BLOCK_MS / DAY_MS)); const cm = M[hourIdx(k)]; cm.n += w; cm.k += active ? w : 0; }
    const contiguous = prev && prev.k === k - 1 && prev.valid && valid;
    if (contiguous) {
      if (!prev.active) {
        const cell = S0[hourIdx(k)];
        cell.n += w; cell.k += active ? w : 0;
      } else {
        const cell = S1[ageBucket(run)];
        cell.n += w; cell.k += active ? w : 0;
      }
    }
    run = active ? (contiguous && prev.active ? run + 1 : 1) : 0;
    if (active) sizes.push([k, d10]);
    prev = { k, valid, active };
  }

  const pStay = S1.map((c, i) => clamp((c.k + P.stayN * P.stay[i]) / (c.n + P.stayN), 0.05, 0.97));

  // P(activo | pausa) por hora y tipo de día. Con pocas observaciones por celda el pronóstico es muy sensible al ruido,
  // así que cada hora se suaviza con sus vecinas (0.25/0.5/0.25) antes de contraer hacia la media de la hora del día.
  let totN = 0, totK = 0;
  for (const c of S0) { totN += c.n; totK += c.k; }
  const priorMean = Array.from({ length: 24 }, (_, h) => priorStart(h, P)).reduce((a, b) => a + b, 0) / 24;
  const scale = clamp(((totK + P.actLevelN * priorMean) / (totN + P.actLevelN)) / priorMean, P.actScaleMin, P.actScaleMax);
  const smooth = idx => {
    const g = idx < 24 ? 0 : 24, h = idx % 24;
    const a = S0[g + (h + 23) % 24], b = S0[idx], c = S0[g + (h + 1) % 24];
    return { n: P.smooth * (a.n + c.n) + (1 - 2 * P.smooth) * b.n, k: P.smooth * (a.k + c.k) + (1 - 2 * P.smooth) * b.k };
  };
  const sm = Array.from({ length: 48 }, (_, i) => smooth(i));
  const pStart = new Array(48);
  for (let h = 0; h < 24; h++) {
    const n = sm[h].n + sm[h + 24].n, kk = sm[h].k + sm[h + 24].k;
    const q = (kk + P.kappaHour * clamp(priorStart(h, P) * scale, 0.002, 0.95)) / (n + P.kappaHour);
    for (const idx of [h, h + 24]) pStart[idx] = clamp((sm[idx].k + P.kappaDay * q) / (sm[idx].n + P.kappaDay), 0.002, 0.95);
  }

  const kept = sizes.slice(-P.maxSizes);
  let nEff = 0, sw = 0;
  for (const [k, d10] of kept) {
    const w = Math.pow(0.5, (now - k * BLOCK_MS) / (P.halfLifeDays * DAY_MS));
    nEff += w; sw += w * d10 / 10;
  }
  const priorProb = P.sizeN / (P.sizeN + nEff);
  const priorSizeMean = P.sizeMedian * Math.exp(0.5 * P.sizeSigma * P.sizeSigma);
  const mu = priorProb * priorSizeMean + (1 - priorProb) * (nEff > 0 ? sw / nEff : priorSizeMean);
  return {
    v: MODEL_VERSION, fittedAt: now, lastClosedK: blocks.length ? blocks[blocks.length - 1][0] : null,
    pStart: pStart.map(x => +x.toFixed(4)), pStay: pStay.map(x => +x.toFixed(4)),
    sizes: kept, nEff: +nEff.toFixed(2), mu: +mu.toFixed(3), days: days.size, quantized, thr, scale: +scale.toFixed(3)
  };
}

// Muestreador de tamaños de escalón: mezcla de prior lognormal y distribución empírica ponderada.
function makeSizeSampler(model, now, P = PRIORS) {
  const vals = [], cum = [];
  let tot = 0;
  for (const [k, d10] of model.sizes || []) {
    tot += Math.pow(0.5, (now - k * BLOCK_MS) / (P.halfLifeDays * DAY_MS));
    vals.push(d10 / 10); cum.push(tot);
  }
  const priorProb = vals.length ? P.sizeN / (P.sizeN + tot) : 1;
  const lnMed = Math.log(P.sizeMedian);
  return rng => {
    if (rng() < priorProb) return Math.min(100, Math.exp(lnMed + P.sizeSigma * randn(rng)));
    const x = rng() * tot;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
    return Math.min(100, vals[lo] * Math.exp(0.15 * randn(rng)));
  };
}

// ── Contexto de la ventana actual ───────────────────────────────────────────
function windowContext(win, reading, now, thr = ACT_THR) {
  const u = reading.utilization, resetsAt = reading.resetsAt;
  const winStart = resetsAt - WINDOW_MS;
  const byK = new Map();
  let prev = null, hitTs = null, lastIncTs = null;
  for (const s of win) {
    const k = Math.floor(s.ts / BLOCK_MS);
    let inc = 0;
    if (prev) inc = Math.max(0, s.value - prev.value);
    else if (s.ts - winStart <= 15 * MINUTE) inc = s.value; // ventana observada desde su inicio
    if (inc > 0) {
      // Tras un hueco (equipo dormido) el salto no cabe en un solo bloque: se reparte entre los del hueco.
      const k0 = prev && s.ts - prev.ts > BLOCK_MS / 2 ? Math.floor(prev.ts / BLOCK_MS) : k;
      const share = inc / (k - k0 + 1);
      for (let kk = k0; kk <= k; kk++) byK.set(kk, (byK.get(kk) || 0) + share);
      lastIncTs = s.ts;
    }
    if (hitTs === null && s.value >= FULL_CAP) hitTs = s.ts;
    prev = s;
  }
  const base0 = win.length && win[0].ts - winStart <= 15 * MINUTE ? 0 : (win.length ? win[0].value : u);
  const valueAt = t => {
    let v = null;
    for (const s of win) { if (s.ts <= t) v = s.value; else break; }
    return v === null ? base0 : v;
  };
  const elapsedMin = (now - winStart) / MINUTE;
  const gain10 = u - valueAt(now - 10 * MINUTE);
  const den30 = clamp(elapsedMin, 5, 30);
  const nowK = Math.floor(now / BLOCK_MS);
  const active0 = elapsedMin < 10 || gain10 >= thr;
  let age0 = 0;
  if (active0) {
    let k = (byK.get(nowK) || 0) >= thr ? nowK : nowK - 1;
    while ((byK.get(k) || 0) >= thr) { age0++; k--; }
    age0 = Math.max(1, age0);
  }
  // El bloque en curso está incompleto: solo cuenta como evidencia de intensidad si ya supera la media
  // de los completos (si no, diluiría la estimación sin aportar información).
  const done = [...byK.entries()].filter(([k, x]) => k < nowK && x >= thr).map(([, x]) => x);
  const partial = byK.get(nowK) || 0;
  const doneMean = done.length ? done.reduce((a, b) => a + b, 0) / done.length : 0;
  const curX = done.length && partial >= thr && partial > doneMean ? done.concat(partial) : done;
  return {
    u, resetsAt, active0, age0, curX, elapsedMin,
    minsSinceInc: lastIncTs === null ? Infinity : (now - lastIncTs) / MINUTE,
    rate30: Math.max(0, (u - valueAt(now - 30 * MINUTE)) / den30 * 60), // pp/h
    hitTs: hitTs === null && u >= FULL_CAP ? now : hitTs
  };
}


// Intensidad de la ventana actual (θ): multiplicador del tamaño de los escalones, común a toda la ventana.
// "logn": log θ ~ Normal con prior N(0, τ²) y observaciones log(x/μ) + σ²/2 (corrige el sesgo de la lognormal).
function thetaModel(curX, model, opts = {}) {
  const mode = opts.thetaMode || PRIORS.thetaMode;
  if (opts.noTheta || mode === "none") return { mean: 1, draw: () => 1 };
  if (mode === "ig") {
    const A = (opts.thetaA ?? PRIORS.thetaA) + curX.length;
    const B = (opts.thetaB ?? PRIORS.thetaB) + curX.reduce((a, b) => a + b, 0) / Math.max(model.mu, 0.1);
    return { mean: B / (A - 1), draw: rng => clamp(B / sampleGamma(rng, A), 0.2, 8) };
  }
  const sizes = (model.sizes || []).map(([, d10]) => Math.log(Math.max(d10 / 10, 0.05)));
  let sigma = 0.9;
  if (sizes.length >= 20) {
    const mu = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    sigma = Math.sqrt(sizes.reduce((a, b) => a + (b - mu) ** 2, 0) / (sizes.length - 1));
  }
  sigma = clamp(sigma, 0.4, 1.3);
  const tau = opts.thetaTau ?? PRIORS.thetaTau;
  const n = curX.length;
  const v = 1 / (1 / (tau * tau) + n / (sigma * sigma));
  const sumY = curX.reduce((a, x) => a + Math.log(Math.max(x, 0.05) / Math.max(model.mu, 0.1)) + sigma * sigma / 2, 0);
  const m = v * sumY / (sigma * sigma);
  return { mean: Math.exp(m + v / 2), draw: rng => clamp(Math.exp(m + Math.sqrt(v) * randn(rng)), 0.2, 8) };
}

// ── Pronóstico (Monte Carlo) ────────────────────────────────────────────────
function forecast(ctx, model, now, opts = {}) {
  const N = opts.paths || PATHS;
  const u0 = ctx.u;
  const R = (ctx.resetsAt - now) / MINUTE;
  const theta = thetaModel(ctx.curX, model, opts);
  const thetaMean = theta.mean;
  const out = {
    engine: "prob", at: now, pHit: 0, hitQ: null, finalQ: [u0, u0, u0], band: [[0, u0, u0, u0]],
    theta: thetaMean,
    drivers: { active: ctx.active0, age0: ctx.age0, minsSinceInc: ctx.minsSinceInc, rate30: ctx.rate30, theta: thetaMean, days: model.days, n: ctx.curX.length }
  };
  if (u0 >= FULL_CAP) {
    const t = ctx.hitTs || now;
    return { ...out, pHit: 1, hitQ: [t, t, t], finalQ: [100, 100, 100], band: [[0, 100, 100, 100], [Math.max(0, R), 100, 100, 100]] };
  }
  if (!(R > 0)) return out;

  const nb = Math.ceil(R / 10);
  const pS = new Array(nb);
  for (let b = 0; b < nb; b++) pS[b] = model.pStart[hourIdx(Math.floor((now + b * BLOCK_MS) / BLOCK_MS))];
  pS[0] = pS[0] ?? 0.1;
  const sampleSize = makeSizeSampler(model, now);
  const bands = Array.from({ length: nb }, () => new Float32Array(N));
  const finals = new Float64Array(N);
  const hits = [];
  const seed = opts.seed ?? 12345;
  for (let i = 0; i < N; i++) {
    const rng = makeRng((seed ^ Math.imul(i + 1, 2654435761)) >>> 0);
    const th = theta.draw(rng);
    let u = u0, s = ctx.active0, age = ctx.age0, hit = null;
    for (let b = 0; b < nb; b++) {
      if (u < FULL_CAP) {
        const p = s ? model.pStay[ageBucket(age)] : pS[b];
        s = rng() < p;
        age = s ? age + 1 : 0;
        if (s) {
          const frac = Math.min(10, R - 10 * b) / 10;
          const delta = th * sampleSize(rng) * frac;
          if (u + delta >= 100) {
            hit = now + b * BLOCK_MS + (100 - u) / delta * frac * BLOCK_MS;
            u = 100;
          } else u += delta;
        }
      }
      bands[b][i] = u;
    }
    finals[i] = u;
    if (hit !== null) hits.push(hit);
  }
  const sortedFinal = Array.from(finals).sort((a, b) => a - b);
  out.finalQ = [0.1, 0.5, 0.9].map(p => quantile(sortedFinal, p));
  out.pHit = hits.length / N;
  if (out.pHit >= 0.05) {
    hits.sort((a, b) => a - b);
    out.hitQ = [0.1, 0.5, 0.9].map(p => quantile(hits, p));
  }
  out.band = [[0, u0, u0, u0]];
  for (let b = 0; b < nb; b++) {
    const sorted = Array.from(bands[b]).sort((x, y) => x - y);
    out.band.push([Math.min((b + 1) * 10, R), quantile(sorted, 0.1), quantile(sorted, 0.5), quantile(sorted, 0.9)]);
  }
  out.drivers.pStartNow = pS[0];
  return out;
}

// Redondea para guardar en storage sin perder lo que se muestra.
function packForecast(f) {
  const r1 = x => Math.round(x * 10) / 10;
  return {
    engine: f.engine, at: f.at, pHit: Math.round(f.pHit * 1000) / 1000,
    hitQ: f.hitQ ? f.hitQ.map(Math.round) : null,
    finalQ: f.finalQ.map(r1),
    band: f.band.map(([m, a, b, c]) => [Math.round(m), r1(a), r1(b), r1(c)]),
    theta: Math.round(f.theta * 100) / 100,
    drivers: { ...f.drivers, minsSinceInc: Number.isFinite(f.drivers.minsSinceInc) ? Math.round(f.drivers.minsSinceInc) : null,
      rate30: r1(f.drivers.rate30), theta: Math.round(f.drivers.theta * 100) / 100, pStartNow: f.drivers.pStartNow },
    why: f.why || ""
  };
}

// Una línea que explica el veredicto (la primera regla que se cumple).
function explainForecast(ctx, f, now) {
  const R = (ctx.resetsAt - now) / MINUTE;
  const d = f.drivers;
  let text;
  if (ctx.u >= FULL_CAP) text = "Alcanzaste el límite de esta ventana.";
  else if (d.active && f.theta >= 1.3) text = `Esta sesión va ×${f.theta.toFixed(1)} más rápida que tu media.`;
  else if (d.active) text = `Sesión activa: queda ${num1(100 - ctx.u)} % de uso y ${fmtDuration(R)} de ventana.`;
  else if (ctx.minsSinceInc >= 10 && Number.isFinite(ctx.minsSinceInc)) {
    text = `Llevas ${Math.round(ctx.minsSinceInc)} min en pausa; a esta hora ${(d.pStartNow ?? 0.1) < 0.08 ? "sueles retomar poco" : "sueles retomar"}.`;
  } else text = `Quedan ${fmtDuration(R)} de ventana.`;
  if (d.days < 3) text += " (aún aprendiendo tus hábitos)";
  return text;
}
function num1(x) { return (Math.round(x * 10) / 10).toLocaleString(LOCALE); }

// ── Veredicto con histéresis ────────────────────────────────────────────────
function rawLevel(u, f, resetsAt) {
  if (u >= FULL_CAP) return "danger";
  const blocked = f.hitQ ? (resetsAt - f.hitQ[1]) / MINUTE : 0;
  let level = "ok";
  if (f.pHit >= HYST.dangerIn) level = blocked >= BLOCKED_TIGHT_MIN ? "danger" : "warn";
  else if (f.pHit >= HYST.warnIn) level = "warn";
  if (u >= 90 && level === "ok") level = "warn";
  return level;
}
// Sube al instante; baja solo tras `downPolls` lecturas seguidas por debajo del umbral de salida.
function applyHysteresis(memo, raw, pHit, resetsAt) {
  if (!memo || !sameWindow(memo.resetsAt, resetsAt)) return { level: raw, resetsAt, down: 0 };
  const next = { ...memo, resetsAt };
  if (LEVEL_RANK[raw] > LEVEL_RANK[memo.level]) { next.level = raw; next.down = 0; return next; }
  if (LEVEL_RANK[raw] === LEVEL_RANK[memo.level]) { next.down = 0; return next; }
  const exit = memo.level === "danger" ? HYST.dangerOut : HYST.warnOut;
  next.down = pHit < exit ? memo.down + 1 : 0;
  if (next.down >= HYST.downPolls) { next.level = raw; next.down = 0; }
  return next;
}

// ── Registros: ventanas y pronósticos (calibración) ─────────────────────────
// Ventana: [inicio, reinicio, pico, hitTs|0]
function updateWindowLog(windows, reading, now) {
  if (reading.idle || !Number.isFinite(reading.resetsAt)) return { windows, changed: false };
  const list = windows.filter(w => now - w[1] < WINDOWS_RETENTION_MS);
  let w = null;
  for (let i = list.length - 1; i >= 0; i--) if (sameWindow(list[i][1], reading.resetsAt)) { w = list[i]; break; }
  let changed = list.length !== windows.length;
  if (!w) {
    w = [reading.resetsAt - WINDOW_MS, reading.resetsAt, reading.utilization, reading.utilization >= FULL_CAP ? now : 0];
    list.push(w); changed = true;
  } else {
    if (reading.utilization > w[2]) { w[2] = reading.utilization; changed = true; }
    if (!w[3] && reading.utilization >= FULL_CAP) { w[3] = now; changed = true; }
  }
  return { windows: list, changed };
}
// Semanal: un registro por ciclo y cupo (seven_day, seven_day_opus…): [key, reinicio, pico, [[ts, uso], …]].
// Se agrega un punto solo cuando el uso cambia (o pasaron 6 h), así que un ciclo pesa unos pocos KB.
function updateWeeklyLog(log, weekly, now) {
  if (!weekly || !weekly.length) return { log, changed: false };
  const list = log.filter(r => now - r[1] < WEEKLY_RETENTION_MS);
  let changed = list.length !== log.length;
  for (const w of weekly) {
    if (!Number.isFinite(w.resetsAt)) continue;
    const value = Number(w.utilization.toFixed(2));
    let r = null;
    for (let i = list.length - 1; i >= 0; i--) if (list[i][0] === w.key && sameWindow(list[i][1], w.resetsAt)) { r = list[i]; break; }
    if (!r) { list.push([w.key, w.resetsAt, value, [[now, value]]]); changed = true; continue; }
    const pts = r[3], last = pts[pts.length - 1];
    if (value > r[2]) r[2] = value;
    if (!last || last[1] !== value || now - last[0] >= WEEKLY_KEEPALIVE_MS) { pts.push([now, value]); changed = true; }
  }
  return { log: list, changed };
}
// Entrada: [reinicio, ts, uso×10, pHit×1000, mediana|0]
function appendForecastLog(log, f, resetsAt, u, now) {
  const last = log[log.length - 1];
  if (last && sameWindow(last[0], resetsAt) && now - last[1] < FLOG_EVERY_MS) return { log, changed: false };
  const list = log.filter(e => now - e[1] < FLOG_RETENTION_MS).slice(-3000);
  list.push([Math.round(resetsAt), Math.round(now), Math.round(u * 10), Math.round(f.pHit * 1000), f.hitQ ? Math.round(f.hitQ[1]) : 0]);
  return { log: list, changed: true };
}
// Brier de P(agotar) sobre ventanas ya cerradas (menor es mejor; 0,25 = moneda al aire).
function brierScore(log, windows, now, calib) {
  let sum = 0, n = 0;
  const seen = new Set();
  for (const [r, ts, , p1000] of log) {
    if (r > now - 5 * MINUTE || r - ts < 20 * MINUTE) continue;
    const w = windows.find(x => sameWindow(x[1], r));
    if (!w) continue;
    const y = w[3] ? 1 : 0;
    sum += (applyCalibration(p1000 / 1000, calib) - y) ** 2; n++;
    seen.add(w[1]);
  }
  return { brier: n ? sum / n : null, n, windows: seen.size };
}


// ── Recalibración con los resultados del propio usuario ─────────────────────
// p' = σ(a + b·logit p), ajustada por MAP (priors a~N(0,.5²), b~N(1,.3²)) con las predicciones registradas
// de ventanas ya cerradas. Corrige sesgos sistemáticos del modelo (p. ej. subestimar a usuarios intensos).
const logit = p => Math.log(clamp(p, 0.01, 0.99) / (1 - clamp(p, 0.01, 0.99)));
const sigmoid = x => 1 / (1 + Math.exp(-x));
function calibrationSet(log, windows, now) {
  const byWindow = new Map();
  for (const [r, ts, , p1000] of log) {
    if (r > now - 5 * MINUTE || r - ts < 20 * MINUTE) continue;
    const w = windows.find(x => sameWindow(x[1], r));
    if (!w) continue;
    if (!byWindow.has(w[1])) byWindow.set(w[1], { y: w[3] ? 1 : 0, xs: [] });
    byWindow.get(w[1]).xs.push(logit(p1000 / 1000));
  }
  return byWindow;
}
function fitCalibration(log, windows, now) {
  const set = calibrationSet(log, windows, now);
  if (set.size < CAL_MIN_WINDOWS) return null;
  const pts = [];
  for (const { y, xs } of set.values()) for (const x of xs) pts.push({ x, y, w: 3 / xs.length }); // cada ventana pesa 3
  let a = CAL_PRIOR.a, b = CAL_PRIOR.b;
  for (let it = 0; it < 12; it++) {
    let ga = (a - CAL_PRIOR.a) / CAL_PRIOR.aSd ** 2, gb = (b - CAL_PRIOR.b) / CAL_PRIOR.bSd ** 2;
    let haa = 1 / CAL_PRIOR.aSd ** 2, hab = 0, hbb = 1 / CAL_PRIOR.bSd ** 2;
    for (const { x, y, w } of pts) {
      const p = sigmoid(a + b * x), r = w * (p - y), h = w * p * (1 - p);
      ga += r; gb += r * x; haa += h; hab += h * x; hbb += h * x * x;
    }
    const det = haa * hbb - hab * hab;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-6) break;
  }
  return { a: +a.toFixed(3), b: +b.toFixed(3), n: set.size };
}
function applyCalibration(p, cal) { return cal ? sigmoid(cal.a + cal.b * logit(p)) : p; }

// ── Una lectura completa (núcleo puro) ──────────────────────────────────────
// persisted: { samples (objetos), blocks, model, windows, forecastLog, state }
// usage: { utilization, resetsAt, idle, weekly }
// Devuelve { persisted, dirty:Set, events:[...] }. Lo usan el service worker y el backtest.
function step(persisted, usage, now, opts = {}) {
  const engine = opts.engine || "prob";
  const dirty = new Set(["samples", "state"]);
  const prev = persisted.state || { status: "idle" };
  let samples = persisted.samples || [];

  const last = samples[samples.length - 1];
  const sample = { ts: now, value: Number(usage.utilization.toFixed(2)), resetsAt: usage.resetsAt };
  // Sin ventana activa basta una lectura cada ~10 min: así los bloques de pausa quedan observados sin llenar el historial.
  const idleRepeat = usage.idle && last && last.value === 0 && !Number.isFinite(last.resetsAt) && now - last.ts < BLOCK_MS - MINUTE;
  if (!idleRepeat && (!last || isReset(last, sample) || now - last.ts >= MIN_SAMPLE_MS)) samples = samples.concat(sample);
  samples = compactSamples(samples, now);

  // Bloques y modelo: se actualizan al cerrarse cada bloque de 10 min (o al migrar).
  const nowK = Math.floor(now / BLOCK_MS);
  let blocks = persisted.blocks;
  let model = persisted.model && persisted.model.v === MODEL_VERSION ? persisted.model : null;
  if (!blocks || !model) {
    blocks = buildBlocks(samples, -Infinity, nowK - 1);
    model = fitModel(blocks, now, opts.priors);
    model.lastClosedK = nowK - 1;
    dirty.add("blocks"); dirty.add("model");
  } else if (nowK - 1 > model.lastClosedK) {
    const fresh = buildBlocks(samples, model.lastClosedK + 1, nowK - 1);
    blocks = mergeBlocks(blocks, fresh, now);
    model = fitModel(blocks, now, opts.priors);
    model.lastClosedK = nowK - 1;
    dirty.add("blocks"); dirty.add("model");
  }

  const win = currentWindowSamples(samples);
  const calc = usage.idle
    ? { rate: null, etaMinutes: null, confidence: "Sin ventana activa", sampleCount: win.length }
    : estimate(win, now, usage.utilization);

  const state = {
    ...prev, status: "connected", error: null, updatedAt: now,
    utilization: usage.utilization, resetsAt: usage.resetsAt, idle: usage.idle, weekly: usage.weekly,
    rate: calc.rate, etaMinutes: calc.etaMinutes, confidence: calc.confidence, sampleCount: calc.sampleCount,
    lastNotifiedThreshold: prev.lastNotifiedThreshold || 0
  };
  delete state.alertsEnabled;

  // Pronóstico probabilístico
  let windows = persisted.windows || [], flog = persisted.forecastLog || [];
  state.forecast = null;
  if (engine === "prob" && !usage.idle && Number.isFinite(usage.resetsAt)) {
    try {
      if (!state.windowSeed || !sameWindow(state.windowSeed.resetsAt, usage.resetsAt)) {
        state.windowSeed = { resetsAt: usage.resetsAt, seed: Math.imul(Math.round(usage.resetsAt / BLOCK_MS), 2654435761) >>> 0 };
        // Ventana nueva = la anterior acaba de cerrarse: buen momento para recalibrar con sus resultados.
        state.calib = opts.calibrate === false ? null : fitCalibration(flog, windows, now);
      } else state.windowSeed = prev.windowSeed;
      const ctx = windowContext(win, usage, now, model.thr);
      const f = forecast(ctx, model, now, { paths: opts.paths, seed: state.windowSeed.seed, ...(opts.forecast || {}) });
      const lg = appendForecastLog(flog, f, usage.resetsAt, usage.utilization, now);   // se registra la P sin calibrar
      if (lg.changed) { flog = lg.log; dirty.add("forecastLog"); }
      if (state.calib) { f.drivers.pRaw = f.pHit; f.pHit = applyCalibration(f.pHit, state.calib); }
      f.why = explainForecast(ctx, f, now);
      state.forecast = packForecast(f);
      const raw = rawLevel(usage.utilization, f, usage.resetsAt);
      state.verdictMemo = applyHysteresis(prev.verdictMemo, raw, f.pHit, usage.resetsAt);
    } catch (e) {
      state.forecast = null;
      state.forecastError = String(e && e.message || e);
    }
  } else {
    state.verdictMemo = null;
  }
  const wl = updateWindowLog(windows, usage, now);
  if (wl.changed) { windows = wl.windows; dirty.add("windows"); }
  let weeklyLog = persisted.weeklyLog || [];
  const wk = updateWeeklyLog(weeklyLog, usage.weekly, now);
  if (wk.changed) { weeklyLog = wk.log; dirty.add("weeklyLog"); }

  // Eventos (el service worker decide si notificar según los ajustes)
  const events = [];
  const percent = usage.utilization;
  if (percent < 75) state.lastNotifiedThreshold = 0;
  if (!usage.idle) {
    const crossed = [80, 90].filter(t => percent >= t && state.lastNotifiedThreshold < t).pop();
    if (crossed) { events.push({ type: "threshold", threshold: crossed, percent }); state.lastNotifiedThreshold = crossed; }
    const warned = Number.isFinite(state.lastProjectionAlertReset) && sameWindow(state.lastProjectionAlertReset, usage.resetsAt);
    if (!warned && Number.isFinite(usage.resetsAt)) {
      let fire = null;
      if (state.forecast) {
        const f = state.forecast;
        if (state.verdictMemo && state.verdictMemo.level === "danger" && f.pHit >= 0.7 && f.hitQ
            && (f.hitQ[1] - now) / MINUTE <= PROB_ALERT_MIN && percent < FULL_CAP) {
          fire = { type: "projection", prob: f.pHit, hitAt: f.hitQ[1], minutesToHit: (f.hitQ[1] - now) / MINUTE, resetsAt: usage.resetsAt };
        }
      } else {
        const proj = projection(state, now);
        if (proj.willHit && proj.minutesToHit <= PROJECTION_ALERT_MIN && state.sampleCount >= 5 && !isEarly(state)) {
          fire = { type: "projection", prob: null, hitAt: proj.hitAt, minutesToHit: proj.minutesToHit, resetsAt: usage.resetsAt };
        }
      }
      if (fire) { events.push(fire); state.lastProjectionAlertReset = usage.resetsAt; }
    }
  }
  return { persisted: { samples, blocks, model, windows, forecastLog: flog, weeklyLog, state }, dirty, events };
}
