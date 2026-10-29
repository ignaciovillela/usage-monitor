// Generador de usuarios sintéticos para el backtest. Modela el consumo real (sesiones, prompts, ventanas de 5 h),
// NO el modelo de la extensión, para que la evaluación no sea circular.
const HOUR = 3600e3, MIN = 60e3, DAY = 24 * HOUR;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const normal = r => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
const lognormal = (r, median, sigma) => median * Math.exp(sigma * normal(r));

// rate(h, weekday): sesiones por hora. mean: minutos de sesión. gap: minutos entre prompts. median/sigma: pp por prompt.
const PROFILES = {
  bursty: { rate: (h, wd) => wd ? (h >= 9 && h < 18 ? 0.55 : h >= 18 && h < 22 ? 0.12 : 0.01) : (h >= 11 && h < 17 ? 0.1 : 0.01), mean: 40, gap: 2.5, median: 1.8, sigma: 0.9 },
  burstygeo: { rate: (h, wd) => wd ? (h >= 9 && h < 18 ? 0.55 : h >= 18 && h < 22 ? 0.12 : 0.01) : (h >= 11 && h < 17 ? 0.1 : 0.01), mean: 45, expo: true, gap: 2.5, median: 1.8, sigma: 0.9 },
  marathon: { rate: (h, wd) => wd && h >= 9 && h < 14 ? 0.18 : 0.005, mean: 170, continuous: [0.4, 0.8], skipDay: 0.3 },
  light: { rate: (h, wd) => (h >= 10 && h < 20 ? 0.12 : 0.005), mean: 15, gap: 4, median: 0.8, sigma: 0.6 },
  nightowl: { rate: (h, wd) => (h >= 20 || h < 2 ? 0.5 : 0.01) * (wd ? 1 : 1.5), mean: 45, gap: 3, median: 1.2, sigma: 0.8 },
  planchange: { rate: (h, wd) => wd ? (h >= 9 && h < 18 ? 0.55 : 0.02) : 0.02, mean: 40, gap: 2.5, median: 2.0, sigma: 0.9, switchDay: 14, switchFactor: 0.5 },
  markov: { markov: true, pStart: (h, wd) => (wd && h >= 8 && h < 20 ? 0.12 : 0.01), pStay: 0.8, median: 2.4, sigma: 0.9 },
  spikes: { rate: (h, wd) => (h >= 9 && h < 18 ? 0.15 : 0.005), mean: 6, gap: 3, median: 0.6, sigma: 0.5, spikeProb: 0.04, spike: 15 }
};

// Devuelve { readings, windows }. readings: lecturas de la API que vería la extensión.
function simulate({ profile, seed, days, quantized = false, start = new Date(2026, 8, 7, 0, 0, 0).getTime() }) {
  const P = PROFILES[profile];
  const r = rng(seed * 7919 + profile.length);
  const readings = [], windows = [];
  const total = days * 1440;
  // Horarios sin conexión por día
  const offline = [];
  for (let d = 0; d < days; d++) {
    const base = start + d * DAY;
    if (r() < 0.7) offline.push([base, base + (7 + 2 * r()) * HOUR]);          // noche
    if (r() < 0.5) { const s = base + (9 + 10 * r()) * HOUR; offline.push([s, s + (30 + 90 * r()) * MIN]); } // suspensión
  }
  const isOffline = t => offline.some(([a, b]) => t >= a && t < b);

  let inSession = 0, contRate = 0, skipToday = -1;
  const pending = new Float64Array(total + 10);
  let win = null; // { start, resetsAt, cum, peak, hit, hitTs }
  for (let m = 0; m < total; m++) {
    const t = start + m * MIN, date = new Date(t);
    const h = date.getHours(), wd = date.getDay() >= 1 && date.getDay() <= 5, day = Math.floor(m / 1440);
    const factor = P.switchDay && day >= P.switchDay ? P.switchFactor : 1;
    if (P.skipDay && skipToday !== day) { skipToday = day; P._skip = r() < P.skipDay; }
    if (P.markov) { // cadena de Markov por bloques de 10 min alineados al reloj; el tamaño se reparte por minuto
      if (m % 10 === 0) {
        inSession = inSession > 0 ? (r() < P.pStay ? 1 : 0) : (r() < P.pStart(h, wd) ? 1 : 0);
        contRate = inSession > 0 ? lognormal(r, P.median, P.sigma) / 10 * factor : 0;
      }
      pending[m] += contRate;
    } else
    // ¿empieza una sesión?
    if (inSession <= 0 && !(P._skip && P.skipDay) && r() < P.rate(h, wd) / 60) {
      inSession = P.expo ? Math.max(2, -Math.log(r() || 1e-9) * P.mean) : Math.max(5, lognormal(r, P.mean, 0.5));
      contRate = P.continuous ? P.continuous[0] + (P.continuous[1] - P.continuous[0]) * r() : 0;
    }
    let inc = pending[m];
    if (!P.markov && inSession > 0) {
      inSession -= 1;
      if (P.continuous) inc += contRate * (0.7 + 0.6 * r()) * factor;
      else if (r() < 1 / P.gap) {
        const cost = (P.spikeProb && r() < P.spikeProb ? P.spike : lognormal(r, P.median, P.sigma)) * factor;
        const spread = 1 + Math.floor(r() * 3);
        for (let i = 0; i < spread; i++) pending[m + i] += cost / spread; // se sirve durante 1-3 min
        inc += pending[m] - inc; // el minuto actual ya incluye su parte
      }
    }
    if (win && t >= win.resetsAt) { windows.push(win); win = null; }
    if (inc > 0 && !(win && win.cum >= 100)) {
      if (!win) win = { start: t, resetsAt: t + 5 * HOUR, cum: 0, peak: 0, hit: false, hitTs: 0 };
      win.cum = Math.min(100, win.cum + inc);
      win.peak = win.cum;
      if (win.cum >= 100 && !win.hit) { win.hit = true; win.hitTs = t; }
    }
    if (!isOffline(t)) {
      const ts = t + Math.round((r() - 0.5) * 10000);
      const u = win ? (quantized ? Math.round(win.cum) : Math.round(win.cum * 100) / 100) : 0;
      readings.push({ ts, utilization: u, resetsAt: win ? win.resetsAt : null, idle: !win });
    }
  }
  if (win) windows.push(win);
  return { readings, windows };
}
module.exports = { simulate, PROFILES, HOUR, MIN, DAY };
