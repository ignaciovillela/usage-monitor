// Lógica pura compartida por el service worker, el popup y el monitor de la página.
// Depende de util.js (formato) y no toca chrome.* — así se puede probar en Node.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const WINDOW_MS = 5 * HOUR;
const RETENTION_MS = 7 * 24 * HOUR;
const FULL_RES_MS = 6 * HOUR;
const THIN_MS = 10 * MINUTE;
const MIN_SAMPLE_MS = 45 * 1000;
const FAST_WINDOW_MS = 3 * MINUTE;
const SLOW_WINDOW_MS = 15 * MINUTE;
const MIN_ESTIMATE_MS = 2 * MINUTE;
const MIN_SAMPLES = 3;
const RESET_DROP_PP = 5;
const RESET_SHIFT_MS = 10 * MINUTE;
const FLAT_RATE = 0.05; // pp/min por debajo de esto no se proyecta nada

const LEVEL_COLORS = {
  ok: "#2e7d32",
  warn: "#b45309",
  danger: "#c62828",
  unknown: "#37608a", // aún sin proyección fiable: solo se muestra el porcentaje
  idle: "#5f6368",
  error: "#5f6368"
};
const BLOCKED_TIGHT_MIN = 15; // quedarse sin límite menos de esto antes del reinicio es "justo"
const EARLY_UTIL = 30;        // por debajo de este uso la proyección es poco fiable: nunca alarma en rojo
const TIGHT_AT_RESET = 90;    // terminar la ventana por encima de esto también es "justo"

// ── Muestras ────────────────────────────────────────────────────────────────
// En memoria: { ts, value, resetsAt|null }. En storage: [ts, value, resetsAt|0].
function packSample(s) { return [s.ts, s.value, s.resetsAt || 0]; }
function unpackSamples(stored) {
  return (Array.isArray(stored) ? stored : [])
    .map(a => ({ ts: Number(a && a[0]), value: Number(a && a[1]), resetsAt: Number(a && a[2]) || null }))
    .filter(s => Number.isFinite(s.ts) && Number.isFinite(s.value) && s.value >= 0 && s.value <= 100)
    .sort((a, b) => a.ts - b.ts);
}
// Historial antiguo: objeto { clave: porcentaje } con claves epoch o "YYYY-MM-DD HH:mm:ss".
function parseLegacyKey(key) {
  if (/^\d{10,}$/.test(key)) return Number(key);
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(key);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN;
}
function migrateLegacy(history) {
  return Object.entries(history || {})
    .map(([k, v]) => [parseLegacyKey(k), Number(v), 0])
    .filter(a => Number.isFinite(a[0]) && Number.isFinite(a[1]));
}

function sameWindow(a, b) {
  return !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < RESET_SHIFT_MS;
}
// ¿Entre dos muestras consecutivas la ventana de 5 h se reinició?
function isReset(prev, next) {
  return next.value <= prev.value - RESET_DROP_PP || !sameWindow(prev.resetsAt, next.resetsAt);
}
function currentWindowSamples(samples) {
  const out = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (out.length && isReset(samples[i], out[0])) break;
    out.unshift(samples[i]);
  }
  return out;
}
// 7 días de historial: resolución completa las últimas 6 h, una muestra cada 10 min antes.
function compactSamples(samples, now) {
  const kept = [];
  for (const s of samples) {
    if (now - s.ts > RETENTION_MS || s.ts > now + 5000) continue;
    const last = kept[kept.length - 1];
    if (s.ts >= now - FULL_RES_MS || !last || s.ts - last.ts >= THIN_MS || isReset(last, s)) {
      kept.push(s);
    } else if (s.value >= last.value) {
      // Mismo tramo: se conserva el valor más alto, anclado al instante original
      // para que el espaciado de 10 min siga contando desde la primera muestra.
      kept[kept.length - 1] = { ...s, ts: last.ts };
    }
  }
  return kept;
}

// ── Estimación ──────────────────────────────────────────────────────────────
function slope(points) {
  if (points.length < 2) return null;
  const t0 = points[0].ts;
  const xs = points.map(p => (p.ts - t0) / MINUTE);
  const ys = points.map(p => p.value);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : null;
}
// `win` son las muestras de la ventana actual. `current` es la lectura más reciente.
function estimate(win, now = Date.now(), current) {
  const fast = win.filter(p => now - p.ts <= FAST_WINDOW_MS);
  const slow = win.filter(p => now - p.ts <= SLOW_WINDOW_MS);
  const span = fast.length ? now - fast[0].ts : 0;
  const n = win.length;

  if (fast.length < MIN_SAMPLES || span < MIN_ESTIMATE_MS) {
    return { rate: null, etaMinutes: null, confidence: "Recopilando datos", sampleCount: n };
  }
  const fastRate = slope(fast);
  const slowRate = slow.length >= 4 ? slope(slow) : null;
  if (fastRate === null || !Number.isFinite(fastRate)) {
    return { rate: null, etaMinutes: null, confidence: "Datos insuficientes", sampleCount: n };
  }

  let rate = fastRate;
  let confidence = "Provisional";
  if (slowRate !== null && Number.isFinite(slowRate)) {
    const diff = Math.abs(fastRate - slowRate);
    if (diff < Math.max(0.5, Math.abs(fastRate) * 0.5)) {
      rate = fastRate * 0.7 + slowRate * 0.3;
      confidence = slow.length >= 8 ? "Más estable" : "Moderada";
    } else {
      rate = fastRate * 0.85 + slowRate * 0.15;
      confidence = "Ritmo cambiante";
    }
  }

  const cur = Number.isFinite(current) ? current : win[win.length - 1].value;
  if (rate <= FLAT_RATE) {
    return {
      rate, etaMinutes: null,
      confidence: rate < -FLAT_RATE ? "El uso está bajando" : "Sin subida suficiente para estimar",
      sampleCount: n
    };
  }
  return { rate, etaMinutes: Math.max(0, (100 - cur) / rate), confidence, sampleCount: n };
}

// Proyección a partir del estado guardado. Los instantes son absolutos (epoch ms).
// Con poco uso, una ráfaga corta (un prompt largo) dispara la pendiente reciente. Mientras haya poco
// uso, el ritmo se acerca al promedio de la ventana; nunca sube por encima del ritmo reciente,
// así que si dejas de usar Claude la proyección baja de inmediato.
function effectiveRate(state, base) {
  const rate = state.rate;
  if (!Number.isFinite(rate)) return null;
  if (!Number.isFinite(state.resetsAt)) return rate;
  const elapsedMin = (base - (state.resetsAt - WINDOW_MS)) / MINUTE;
  if (elapsedMin < 5) return rate;
  const recentWeight = Math.min(1, Math.max(0.25, state.utilization / 50));
  const average = state.utilization / elapsedMin;
  return Math.min(rate, recentWeight * rate + (1 - recentWeight) * average);
}
function isEarly(state) { return Number.isFinite(state.utilization) && state.utilization < EARLY_UTIL; }

// Proyección del motor probabilístico, con la misma forma que la lineal (+ pHit, hitQ, finalQ, band).
function probProjection(state, now) {
  const f = state.forecast;
  const hitAt = f.hitQ ? f.hitQ[1] : null;
  return {
    hitAt, minutesToHit: hitAt === null ? null : (hitAt - now) / MINUTE,
    willHit: f.pHit >= 0.5, valueAtReset: f.finalQ[1],
    rising: f.pHit > 0 || f.finalQ[1] > state.utilization + 1,
    rate: f.drivers && Number.isFinite(f.drivers.rate30) ? f.drivers.rate30 / 60 : null,
    prob: true, pHit: f.pHit, hitQ: f.hitQ, finalQ: f.finalQ, band: f.band
  };
}

function projection(state, now = Date.now()) {
  if (state && state.forecast && state.forecast.engine === "prob" && Number.isFinite(state.utilization)) {
    return probProjection(state, now);
  }
  const out = { hitAt: null, minutesToHit: null, willHit: false, valueAtReset: null, rising: false, rate: null };
  if (!state || !Number.isFinite(state.utilization)) return out;
  const cur = state.utilization;
  const base = state.updatedAt || now;
  const rate = effectiveRate(state, base);
  out.rate = rate;
  const reset = state.resetsAt;
  out.rising = Number.isFinite(rate) && rate > FLAT_RATE;
  if (out.rising) {
    out.hitAt = base + Math.max(0, (100 - cur) / rate) * MINUTE;
    out.minutesToHit = (out.hitAt - now) / MINUTE;
    out.willHit = !Number.isFinite(reset) || out.hitAt < reset;
  }
  if (Number.isFinite(reset)) {
    out.valueAtReset = out.rising ? Math.min(100, cur + rate * Math.max(0, reset - base) / MINUTE) : cur;
  }
  return out;
}

// Minutos que quedarías sin límite antes del reinicio (null si no te quedas sin él).
function blockedMinutes(state, proj) {
  return proj.willHit && Number.isFinite(state.resetsAt) ? Math.max(0, (state.resetsAt - proj.hitAt) / MINUTE) : null;
}
// El nivel es el veredicto de la proyección: ok (llegas con margen), warn (justo), danger (te quedas sin límite).
function levelFor(state, proj, now = Date.now()) {
  if (!state || state.status === "auth" || state.status === "error") return "error";
  if (state.idle) return "idle";
  if (!Number.isFinite(state.utilization)) return "error";
  const prob = !!(state.forecast && state.verdictMemo);
  let level = "unknown";
  if (prob) {
    level = state.verdictMemo.level;
  } else if (proj.willHit) {
    const blocked = blockedMinutes(state, proj);
    level = blocked === null || blocked > BLOCKED_TIGHT_MIN ? "danger" : "warn";
    if (isEarly(state) && level === "danger") level = "warn"; // aún es pronto para dar la alarma
  } else if (Number.isFinite(state.rate)) {
    level = (proj.valueAtReset ?? state.utilization) >= TIGHT_AT_RESET ? "warn" : "ok";
  }
  if (state.utilization >= 95 && !prob) return "danger";
  if (state.utilization >= 90 && level !== "danger") return "warn";
  return level;
}
const VERDICTS = {
  ok: { icon: "✔", label: "Vas bien" },
  warn: { icon: "▲", label: "Vas justo" },
  danger: { icon: "⚠", label: "Te quedas sin límite" },
  unknown: { icon: "…", label: "Calculando" },
  idle: { icon: "–", label: "Sin ventana activa" },
  error: { icon: "!", label: "Sin datos" }
};
function verdict(state, now = Date.now()) {
  const proj = projection(state, now);
  const level = levelFor(state, proj, now);
  return { level, ...VERDICTS[level], blockedMin: blockedMinutes(state, proj) };
}

// ── Textos ──────────────────────────────────────────────────────────────────
function fmtShort(mins) {
  const n = Math.max(0, Math.round(mins));
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60), m = n % 60;
  return h >= 10 || !m ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}
function projectionParts(state, now = Date.now()) {
  if (!state || !state.status || state.status === "idle") return { level: "unknown", icon: "…", headline: "Consultando…", detail: "" };
  if (state.status === "auth") return { level: "error", icon: "!", headline: "Inicia sesión en Claude.ai", detail: "Abre claude.ai y vuelve a intentarlo." };
  if (state.status === "error") return { level: "error", icon: "!", headline: "Uso no disponible", detail: state.error || "No se pudo consultar el uso." };
  const v = verdict(state, now);
  const p = projection(state, now);
  const reset = Number.isFinite(state.resetsAt) ? fmtClock(state.resetsAt) : null;
  const out = (headline, detail) => ({ level: v.level, icon: v.icon, headline, detail });
  if (state.idle) return out("Sin ventana activa", "Se activa con tu próximo mensaje.");
  if (state.forecast) return probParts(state, v, reset, now);
  if (state.rate == null) return out("Recopilando datos…", "Hacen falta unos minutos de uso para estimar.");
  if (p.willHit && isEarly(state)) {
    return out("Ritmo alto", `Si lo sostienes, llegarías al límite a las ${fmtClock(p.hitAt)}. Aún es pronto para afirmarlo.`);
  }
  if (p.willHit) {
    const before = v.blockedMin !== null ? `${fmtDuration(v.blockedMin)} antes del reinicio (${reset}) · ` : "";
    return out(`Sin límite a las ${fmtClock(p.hitAt)}`, `${before}en ${fmtDuration(p.minutesToHit)}`);
  }
  const end = `~${fmtPct(p.valueAtReset ?? state.utilization, 0)}`;
  const tail = `la ventana en ${end}${reset ? ` (reinicio ${reset})` : ""}.`;
  return out(v.label, p.rising ? `Terminarías ${tail}` : `Ritmo estable: terminarías ${tail}`);
}
// Textos del motor probabilístico: probabilidad, mediana y rango de la hora de agotamiento.
function probParts(state, v, reset, now) {
  const f = state.forecast;
  const pct = `${Math.round(f.pHit * 100)} %`;
  const out = (headline, detail) => ({ level: v.level, icon: v.icon, headline, detail, why: f.why || "" });
  if (state.utilization >= 99.5) {
    return out("Límite alcanzado", `Reinicio a las ${reset} (en ${fmtReset(state.resetsAt)}).`);
  }
  if (f.pHit >= HYST_WARN_IN) {
    const detail = f.hitQ
      ? `Mediana ${fmtClock(f.hitQ[1])} · rango ${fmtClock(f.hitQ[0])}–${fmtClock(f.hitQ[2])} · reinicio ${reset}`
      : `Terminarías en ~${Math.round(f.finalQ[1])} % · reinicio ${reset}`;
    return out(`${pct} de probabilidad de agotarlo`, detail);
  }
  const range = `${Math.round(f.finalQ[0])}–${Math.round(f.finalQ[2])} %`;
  const risk = f.pHit >= 0.05 ? ` Probabilidad de agotarlo: ${pct}.` : "";
  return out(v.label, `Terminarías en ~${Math.round(f.finalQ[1])} % (${range}) · reinicio ${reset}.${risk}`);
}
const HYST_WARN_IN = 0.20; // = HYST.warnIn de model.js (core.js no puede depender de él)

function projectionText(state, now = Date.now()) {
  const { icon, headline, detail } = projectionParts(state, now);
  return `${icon} ${headline}${detail ? ` — ${detail}` : ""}`;
}

const WEEKLY_LABELS = { seven_day: "Semanal", seven_day_opus: "Semanal Opus", seven_day_sonnet: "Semanal Sonnet" };
function weeklyLabel(key) { return WEEKLY_LABELS[key] || key.replace(/^seven_day_?/, "Semanal ").trim(); }

// ── Ícono de la barra ───────────────────────────────────────────────────────
function fmtBlocked(mins) {
  const n = Math.max(1, Math.round(mins));
  return n < 100 ? `-${n}m` : `-${Math.round(n / 60)}h`;
}
// Modos: "pace" (veredicto: vacío si todo va bien; probabilidad o minutos sin límite si hay riesgo), "percent", "limit", "reset".
// Con el veredicto en verde el badge queda vacío: no tapa el ícono y el anillo exterior ya va en verde.
function badgeInfo(state, mode, now = Date.now()) {
  const proj = projection(state, now);
  const level = levelFor(state, proj, now);
  if (level === "error") return { level, text: state && state.status === "auth" ? "?" : "!" };
  if (state.idle) return { level, text: "" }; // sin ventana activa: sin badge (el anillo del ícono queda en gris)
  let text = String(Math.round(state.utilization));
  if (mode === "prob" && proj.prob) {
    text = `${Math.round(proj.pHit * 100)}%`;
  } else if (mode === "pace" || mode === "prob") {
    const blocked = blockedMinutes(state, proj);
    if (blocked !== null && (proj.prob || !isEarly(state))) text = fmtBlocked(blocked);
    else if (level === "ok") text = "";
    else if (level === "warn" && proj.prob && proj.pHit >= HYST_WARN_IN) text = `${Math.round(proj.pHit * 100)}%`; // riesgo real: se muestra la probabilidad
    else if (level === "warn" && !proj.willHit && (proj.prob || Number.isFinite(state.rate))) text = "~" + Math.round(proj.valueAtReset ?? state.utilization);
  } else if (mode === "limit" && proj.willHit) text = fmtShort(proj.minutesToHit);
  else if (mode === "reset" && Number.isFinite(state.resetsAt) && state.resetsAt > now) {
    text = fmtShort((state.resetsAt - now) / MINUTE);
  }
  return { level, text };
}
function tooltipText(state, now = Date.now()) {
  const lines = ["Usage Monitor"];
  if (!state || state.status === "idle") return lines.concat("Consultando…").join("\n");
  if (state.status === "auth" || state.status === "error") {
    return lines.concat(state.error || "No se pudo consultar el uso.").join("\n");
  }
  lines.push(`Ventana de 5 h: ${fmtPct(state.utilization)}`);
  if (Number.isFinite(state.resetsAt)) lines.push(`Reinicio: ${fmtClock(state.resetsAt)} (en ${fmtReset(state.resetsAt)})`);
  lines.push(projectionText(state, now));
  if (state.forecast && state.forecast.why) lines.push(state.forecast.why);
  for (const w of state.weekly || []) lines.push(`${weeklyLabel(w.key)}: ${fmtPct(w.utilization)}`);
  return lines.join("\n");
}

// Dos anillos: el exterior es el uso; el interior, el tiempo transcurrido de la ventana.
// Si el exterior va por delante del interior, se consume más rápido que el tiempo.
// Formas del ícono: "rings" (dos anillos: uso y tiempo), "donut" (anillo de uso + anillo fino de tiempo),
// "pie1" (torta de uso), "pie2" (torta de uso + anillo fino de tiempo), "pie3" (torta de uso con una torta
// pequeña de tiempo encima). En todas el número va (opcional) en el centro, semitransparente y sin contorno.
const TIME_COLOR = "#3da5f5"; // azul: distinto de verde/ámbar/rojo del veredicto, así el tiempo siempre se distingue
function drawIcon(ctx, size, params) {
  const { usage, elapsed, color, text, layout = "rings", ink = "255,255,255", alpha = 0.48, num } = params;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2, TAU = Math.PI * 2, TOP = -Math.PI / 2;
  const ring = (radius, width, fraction, stroke, trackAlpha) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(128,128,128,${trackAlpha})`;
    ctx.beginPath(); ctx.arc(c, c, radius, 0, TAU); ctx.stroke();
    if (fraction > 0) {
      ctx.strokeStyle = stroke;
      ctx.beginPath(); ctx.arc(c, c, radius, TOP, TOP + TAU * Math.min(1, fraction)); ctx.stroke();
    }
  };
  const pie = (radius, fraction, fill, trackAlpha) => {
    ctx.fillStyle = `rgba(128,128,128,${trackAlpha})`;
    ctx.beginPath(); ctx.arc(c, c, radius, 0, TAU); ctx.fill();
    if (fraction > 0) {
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, radius, TOP, TOP + TAU * Math.min(1, fraction)); ctx.closePath(); ctx.fill();
    }
  };
  const bezel = () => { // anillo fino exterior de tiempo transcurrido
    const wt = size * 0.07, rt = c - wt / 2 - size * 0.01;
    ring(rt, wt, elapsed, TIME_COLOR, 0.22);
    return rt - wt / 2 - size * 0.02;   // radio libre por dentro del bisel
  };
  if (layout === "donut") {
    const free = bezel(), w = size * 0.15;
    ring(free - w / 2, w, usage, color, 0.32);
  } else if (layout === "pie1") {
    pie(c - size * 0.04, usage, color, 0.28);
  } else if (layout === "pie2") {
    pie(bezel() - size * 0.01, usage, color, 0.28);
  } else if (layout === "pie3") {
    const R = c - size * 0.04;
    pie(R, usage, color, 0.28);
    pie(R * 0.52, elapsed, TIME_COLOR, 0.30);
  } else { // "rings": los dos anillos originales
    const w1 = size * 0.17, r1 = c - w1 / 2 - size * 0.02;
    const w2 = size * 0.21, r2 = r1 - w1 / 2 - size * 0.03 - w2 / 2;
    ring(r1, w1, usage, color, 0.30);
    ring(r2, w2, elapsed, TIME_COLOR, 0.30);
  }
  drawIconNumber(ctx, size, text, ink, alpha, num);
}
// Número del ícono: solo dígitos (para poder usar una fuente grande), semitransparente y sin contorno ni disco,
// así la forma se ve a través. Su color (claro u oscuro) contrasta con la barra de Chrome.
// num = { scale (tamaño, 1 = normal), dx, dy (desplazamiento como fracción del ícono, + = derecha/abajo) }.
function drawIconNumber(ctx, size, text, ink, alpha, num = {}) {
  const label = (text || "").replace(/[^0-9]/g, "");
  if (!label) return;
  const scale = Math.min(2, Math.max(0.3, Number(num.scale) || 1));
  let px = Math.round(size * 0.7 * scale);
  const maxW = size * 0.9 * scale;
  for (; px > 6; px--) { ctx.font = `800 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`; if (ctx.measureText(label).width <= maxW) break; }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(${ink}, ${alpha})`;
  ctx.fillText(label, size / 2 + (Number(num.dx) || 0) * size, size / 2 + size * 0.035 + (Number(num.dy) || 0) * size);
}
function iconParams(state, level, now = Date.now(), text = "", layout = "rings", ink = "255,255,255", alpha = 0.48, num = {}) {
  const ok = state && Number.isFinite(state.utilization) && !state.idle && level !== "error";
  const elapsed = ok && Number.isFinite(state.resetsAt)
    ? Math.min(1, Math.max(0, 1 - (state.resetsAt - now) / WINDOW_MS)) : 0;
  return { usage: ok ? state.utilization / 100 : 0, elapsed, color: LEVEL_COLORS[level], text, layout, ink, alpha, num };
}

// ── Series para los gráficos ────────────────────────────────────────────────
// Puntos de uso consumidos por hora (últimas `hours` horas locales).
function hourlyConsumption(samples, now, hours = 24) {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  const end = d.getTime() + HOUR;
  const start = end - hours * HOUR;
  const buckets = Array.from({ length: hours }, (_, i) => ({ start: start + i * HOUR, pp: 0 }));
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1], cur = samples[i];
    if (cur.ts < start || cur.ts >= end) continue;
    const idx = Math.min(hours - 1, Math.max(0, Math.floor((cur.ts - start) / HOUR)));
    if (isReset(prev, cur)) buckets[idx].pp += cur.value; // la ventana nueva parte de 0
    else if (cur.value > prev.value) buckets[idx].pp += cur.value - prev.value;
  }
  return buckets;
}
// Una entrada por ventana de 5 h observada, con su pico de uso.
function windowSummaries(samples) {
  const groups = [];
  let g = null, prev = null;
  for (const s of samples) {
    if (Number.isFinite(s.resetsAt)) {
      if (g && sameWindow(g.resetsAt, s.resetsAt) && !(prev && isReset(prev, s))) {
        g.peak = Math.max(g.peak, s.value);
        g.resetsAt = s.resetsAt;
        g.lastTs = s.ts;
      } else {
        g = { resetsAt: s.resetsAt, start: s.resetsAt - WINDOW_MS, peak: s.value, firstTs: s.ts, lastTs: s.ts };
        groups.push(g);
      }
    }
    prev = s;
  }
  return groups;
}
