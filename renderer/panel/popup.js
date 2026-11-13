const STATE_KEY = "usageState";
const SAMPLES_KEY = "usageSamples";
const ALERTS_KEY = "alertsEnabled";
const BADGE_KEY = "badgeMode";
const ICON_SHAPE_KEY = "iconShape";
const NUMBER_ALPHA_KEY = "numberAlpha";
const NUMBER_SCALE_KEY = "numberScale";
const NUMBER_DX_KEY = "numberDx";
const NUMBER_DY_KEY = "numberDy";
const BLOCKS_KEY = "usageBlocks";
const WINDOWS_KEY = "usageWindows";
const FLOG_KEY = "usageForecastLog";
const WEEKLY_KEY = "usageWeekly";
const SVG_NS = "http://www.w3.org/2000/svg";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHART_W = 400;
const CHART_H = 190;

const ui = { tab: "window", view: "chart", weekBack: 0, scope: "window" };   // scope: "window" (ventana de 5 h) o "week" (ciclo semanal)   // weekBack: cuántos ciclos semanales hacia atrás
let model = { state: {}, samples: [], now: Date.now() };

const $ = id => document.getElementById(id);
function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}
function html(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const linear = (d0, d1, r0, r1) => v => r0 + (v - d0) / (d1 - d0) * (r1 - r0);
// La API sube a saltos (el uso se actualiza al terminar cada respuesta) y graficado lectura a lectura eso se ve como
// escalones. Para el dibujo solo se conservan los puntos donde el uso sube y se unen con rectas, de modo que cada escalón
// queda como una pendiente. Si entre dos subidas pasó mucho tiempo (una pausa de verdad) se mantiene plano y la subida
// ocurre al final, para no inventar consumo gradual donde no lo hubo.
function rampSeries(points, maxRampMin = 15, jumpMin = 3) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = i === points.length - 1;
    if (points[i].value === points[i - 1].value && !last) continue;
    const prev = out[out.length - 1];
    if (points[i].value !== prev.value && (points[i].ts - prev.ts) / MINUTE > maxRampMin) {
      out.push({ ts: Math.max(prev.ts, points[i].ts - jumpMin * MINUTE), value: prev.value });
    }
    out.push(points[i]);
  }
  return out;
}

const num = (n, d = 1) => n.toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: d });
const hourLabel = ts => `${String(new Date(ts).getHours()).padStart(2, "0")}h`;
const dayLabel = ts => new Date(ts).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });

// ── Tooltip (un solo elemento; los textos entran por textContent) ───────────
const tip = $("tip");
function showTip(clientX, clientY, title, rows) {
  tip.replaceChildren(html("div", "t", title));
  for (const r of rows) {
    const row = html("div", "row");
    if (r.key) row.append(html("i", `k ${r.key}`));
    row.append(html("b", "", r.value), html("span", "", r.name));
    tip.append(row);
  }
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.max(4, Math.min(clientX + 12, window.innerWidth - w - 4))}px`;
  tip.style.top = `${clientY - h - 10 < 4 ? clientY + 16 : clientY - h - 10}px`;
}
const hideTip = () => { tip.hidden = true; };

// ── Resumen ─────────────────────────────────────────────────────────────────
// Nombre de la fuente que respondió (state.via), para el encabezado.
const VIA_NAMES = { "claude-code": "Claude Code (archivo)", oauth: "Claude Code (cuenta)", web: "Claude.ai" };
function renderSummary() {
  const now = model.now;
  const connected = model.state.status === "connected";
  // Sin conexión no se muestran cifras viejas como si fueran actuales.
  const s = connected ? model.state : { status: model.state.status, error: model.state.error };
  $("status").textContent =
    connected ? `Conectada a ${VIA_NAMES[s.via] || ui.source || "Claude.ai"}${s.fellBack ? " (respaldo)" : ""} · ${new Date(s.updatedAt).toLocaleTimeString(LOCALE)}` :
    s.status === "auth" ? "Sesión no disponible" :
    s.status === "error" ? "Error de conexión" : "Consultando…";

  const proj = projection(s, now);
  const level = levelFor(s, proj, now);
  const parts = projectionParts(s, now);
  $("percent").textContent = connected && Number.isFinite(s.utilization) ? fmtPct(s.utilization) : "—%";
  $("v-icon").textContent = parts.icon;
  $("v-text").textContent = parts.headline;
  $("detail").textContent = parts.detail;
  $("why").textContent = parts.why || "";

  const fill = $("meter-fill");
  fill.style.width = `${connected && Number.isFinite(s.utilization) ? s.utilization : 0}%`;
  fill.className = `meter-fill ${level === "danger" ? "danger" : level === "warn" ? "warn" : ""}`;
  const timeMark = $("meter-time");
  if (connected && !s.idle && Number.isFinite(s.resetsAt)) {
    const elapsed = Math.min(1, Math.max(0, 1 - (s.resetsAt - now) / WINDOW_MS));
    timeMark.style.display = "block";
    timeMark.style.left = `${elapsed * 100}%`;
    $("elapsed").textContent = `${Math.round(elapsed * 100)}%`;
  } else {
    timeMark.style.display = "none";
    $("elapsed").textContent = "—";
  }

  const hasReset = connected && Number.isFinite(s.resetsAt);
  $("reset").textContent = hasReset ? fmtClock(s.resetsAt) : "—";
  $("reset-in").textContent = hasReset ? `en ${fmtReset(s.resetsAt)}` : "";
  const f = s.forecast;
  if (f) { // motor probabilístico: probabilidad y rango en lugar de un número único
    const pct = `${Math.round(f.pHit * 100)} %`;
    $("limit").textContent = f.pHit < 0.10 ? "Improbable" : f.hitQ ? fmtClock(f.hitQ[1]) : "—";
    $("limit-in").textContent = `${pct} prob.`;
    $("rate").textContent = Number.isFinite(f.drivers.rate30) ? `${num(f.drivers.rate30)} %/h` : "—";
    $("confidence").textContent = f.drivers.active ? "activo" : Number.isFinite(f.drivers.minsSinceInc) ? `en pausa ${f.drivers.minsSinceInc} min` : "en pausa";
    $("at-reset").textContent = `~${fmtPct(f.finalQ[1], 0)}`;
    $("at-reset-sub").textContent = `${Math.round(f.finalQ[0])}–${Math.round(f.finalQ[2])} %`;
  } else {
    $("limit").textContent = proj.rising ? (proj.willHit ? fmtClock(proj.hitAt) : "No antes") : "—";
    $("limit-in").textContent = proj.rising && proj.willHit ? `en ${fmtDuration(proj.minutesToHit)}` : "";
    $("rate").textContent = Number.isFinite(proj.rate) ? `${num(proj.rate * 60)} %/h` : "—";
    $("confidence").textContent = s.idle ? "" : s.confidence || "";
    $("at-reset").textContent = Number.isFinite(proj.valueAtReset) ? `~${fmtPct(proj.valueAtReset, 0)}` : "—";
    $("at-reset-sub").textContent = "proyección";
  }
  document.querySelector(".hero").dataset.level = level;
  if (ui.scope === "week") renderWeekHero(s, connected);

  const weekly = $("weekly");
  weekly.replaceChildren();
  // En la vista «Semana» la tarjeta principal es la semanal, así que esta fila pasa a mostrar la ventana de 5 h.
  const rowsData = ui.scope === "week"
    ? (connected && Number.isFinite(s.utilization) ? [{ label: "Ventana 5 h", utilization: s.utilization, resetsAt: s.idle ? NaN : s.resetsAt, span: WINDOW_MS }] : [])
    : (s.weekly || []).map(w => ({ label: weeklyLabel(w.key), utilization: w.utilization, resetsAt: w.resetsAt, span: WEEK_MS }));
  for (const w of rowsData) {
    const row = html("div", "weekly-row");
    const meter = html("div", "meter");
    const f = html("div", `meter-fill ${w.utilization >= 90 ? "danger" : w.utilization >= 70 ? "warn" : ""}`);
    f.style.width = `${w.utilization}%`;
    meter.append(f);
    // Marca de tiempo transcurrido de la semana (la ventana semanal dura 7 días desde su inicio).
    if (Number.isFinite(w.resetsAt)) {
      const elapsed = Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / w.span));
      const mark = html("div", "meter-time");
      mark.style.display = "block";
      mark.style.left = `${elapsed * 100}%`;
      meter.append(mark);
      row.title = `Uso ${fmtPct(w.utilization, 0)} · tiempo transcurrido ${Math.round(elapsed * 100)} % · reinicio en ${fmtReset(w.resetsAt)}`;
      meter.setAttribute("role", "img");
      meter.setAttribute("aria-label", row.title);
    }
    row.append(html("span", "", w.label), meter, html("span", "value", fmtPct(w.utilization, 0)));
    weekly.append(row);
  }
  weekly.hidden = !weekly.childElementCount;

  const error = $("error");
  error.hidden = connected || !s.error;
  error.textContent = s.error || "";
}

// Vista «Semana»: la tarjeta principal pasa a los valores del ciclo semanal (uso, veredicto, reinicio, proyección por perfil horario).
function renderWeekHero(s, connected) {
  const now = model.now;
  const w = connected ? (s.weekly || []).find(x => x.key === "seven_day") || (s.weekly || [])[0] : null;
  const hero = document.querySelector(".hero");
  const util = w && Number.isFinite(w.utilization) ? w.utilization : null;
  const hasReset = !!w && Number.isFinite(w.resetsAt);
  $("percent").textContent = util === null ? "—%" : fmtPct(util);
  $("meter-fill").style.width = `${util === null ? 0 : util}%`;
  const timeMark = $("meter-time");
  const elapsed = hasReset ? Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / WEEK_MS)) : null;
  timeMark.style.display = elapsed === null ? "none" : "block";
  if (elapsed !== null) timeMark.style.left = `${elapsed * 100}%`;
  $("elapsed").textContent = elapsed === null ? "—" : `${Math.round(elapsed * 100)}%`;
  $("reset").textContent = hasReset ? `${new Date(w.resetsAt).toLocaleDateString(LOCALE, { weekday: "short" })} ${fmtClock(w.resetsAt)}` : "—";
  $("reset-in").textContent = hasReset ? `en ${fmtReset(w.resetsAt)}` : "";
  const day = elapsed ? elapsed * 7 : 0;
  $("rate").textContent = util !== null && day >= 0.25 ? `${num(util / day)} %/día` : "—";
  $("confidence").textContent = "promedio";
  let level = util !== null && util >= 90 ? "danger" : util !== null && util >= 70 ? "warn" : "ok";
  let icon = "✓", head = util === null ? "Sin datos semanales" : "Vas bien esta semana", detail = "", why = "";
  $("limit").textContent = "—"; $("limit-in").textContent = "";
  $("at-reset").textContent = "—"; $("at-reset-sub").textContent = "proyección";
  const log = model.weeklyLog || [];
  const cycle = hasReset ? log.filter(r => r[0] === w.key && r[3] && r[3].length).sort((a, b) => b[1] - a[1])[0] : null;
  const wf = cycle && util > 0 && util < 100 && elapsed > 0.1 ? weeklyForecast(log, [w.key, w.resetsAt, cycle[2], cycle[3]], now) : null;
  const wd = ts => `${new Date(ts).toLocaleDateString(LOCALE, { weekday: "short" })} ${fmtClock(ts)}`;
  if (wf) {
    const pct = Math.round(wf.pHit * 100);
    $("limit").textContent = wf.pHit < 0.10 ? "Improbable" : wf.hitQ ? wd(wf.hitQ[1]) : "—";
    $("limit-in").textContent = `${pct} % prob.`;
    $("at-reset").textContent = `~${fmtPct(wf.finalQ[1], 0)}`;
    $("at-reset-sub").textContent = `${Math.round(wf.finalQ[0])}–${Math.round(wf.finalQ[2])} %`;
    if (wf.pHit >= 0.5) { level = "danger"; icon = "⚠"; head = `${pct} % de probabilidad de agotarlo`; }
    else if (wf.pHit >= 0.2) { level = "warn"; icon = "!"; head = `${pct} % de probabilidad de agotarlo`; }
    if (wf.hitQ && wf.pHit >= 0.2) detail = `Lo más probable: ${wd(wf.hitQ[1])} · reinicio ${wd(w.resetsAt)}.`;
    else detail = `Reinicio ${wd(w.resetsAt)}.`;
    if (wf.learning) why = `(aún aprendiendo tus hábitos: ${wf.cycles} ${wf.cycles === 1 ? "semana" : "semanas"} de historial)`;
  } else if (util !== null) {
    if (util >= 99.5) { level = "danger"; icon = "⚠"; head = "Límite semanal alcanzado"; }
    detail = hasReset ? `Reinicio ${wd(w.resetsAt)}.` : "";
  }
  $("v-icon").textContent = icon; $("v-text").textContent = head;
  $("detail").textContent = detail; $("why").textContent = why;
  $("meter-fill").className = `meter-fill ${level === "danger" ? "danger" : level === "warn" ? "warn" : ""}`;
  hero.dataset.level = level;
}

// ── Gráficos ────────────────────────────────────────────────────────────────
function emptySpec(message) {
  return { draw: host => host.append(html("div", "empty", message)), head: null, rows: [], legend: [], caption: "" };
}

// Ventana de 5 h: uso real, proyección hasta el reinicio y ritmo parejo como referencia.
function windowSpec() {
  const s = model.state, now = model.now;
  if (s.status !== "connected" || s.idle || !Number.isFinite(s.resetsAt)) {
    return emptySpec("Sin ventana activa: aparecerá cuando envíes tu próximo mensaje.");
  }
  const t0 = s.resetsAt - WINDOW_MS, t1 = s.resetsAt;
  const pts = currentWindowSamples(model.samples).filter(p => p.ts >= t0 - 2 * MINUTE);
  if (!pts.length || pts[pts.length - 1].ts < s.updatedAt - 1000) pts.push({ ts: s.updatedAt, value: s.utilization });
  const last = pts[pts.length - 1];
  const proj = projection(s, now);
  let end = null;
  // Motor probabilístico: banda p10–p90 y mediana por bloque de 10 min (calculadas por el service worker).
  const fc = s.forecast && s.forecast.engine === "prob" && s.forecast.band ? s.forecast : null;
  const bandPts = fc ? fc.band.map(([min, lo, mid, hi]) => ({ ts: fc.at + min * MINUTE, lo, mid, hi })) : null;
  if (fc) {
    // Si la proyección llega al 100 %, termina ahí (no sigue plana hasta el reinicio): a la hora mediana de agotarlo
    // cuando lo más probable es agotarlo, o donde la mediana de la banda toca el 100 % si no.
    let cross = null;
    for (let i = 1; i < bandPts.length && cross === null; i++) {
      const a = bandPts[i - 1], b = bandPts[i];
      // «Lleno» con el mismo umbral que el modelo (FULL_CAP, 99,5 %): la mediana puede quedarse en 99,9 sin tocar 100.
      if (b.mid >= FULL_CAP) cross = a.mid >= FULL_CAP ? a.ts : a.ts + (b.ts - a.ts) * (FULL_CAP - a.mid) / (b.mid - a.mid);
    }
    const hitTs = fc.hitQ && fc.pHit >= 0.5 && fc.hitQ[1] < t1 ? fc.hitQ[1] : cross !== null && cross < t1 ? cross : null;
    end = hitTs !== null
      ? { ts: Math.max(last.ts, hitTs), value: 100, hit: true, prob: true }
      : { ts: t1, value: fc.finalQ[1], hit: false, label: `~${Math.round(fc.finalQ[1])} %` };
  } else if (Number.isFinite(s.rate) && Number.isFinite(proj.valueAtReset)) {
    end = proj.rising && proj.willHit
      ? { ts: proj.hitAt, value: 100, hit: true }
      : { ts: t1, value: proj.valueAtReset, hit: false };
  }
  const bandAt = t => {
    let i = 0;
    while (i < bandPts.length - 1 && bandPts[i + 1].ts < t) i++;
    const a = bandPts[i], b = bandPts[Math.min(i + 1, bandPts.length - 1)];
    const f = b.ts === a.ts ? 0 : Math.min(1, Math.max(0, (t - a.ts) / (b.ts - a.ts)));
    return { lo: a.lo + (b.lo - a.lo) * f, mid: a.mid + (b.mid - a.mid) * f, hi: a.hi + (b.hi - a.hi) * f };
  };
  const ref = t => Math.min(100, Math.max(0, (t - t0) / WINDOW_MS * 100));

  const valueAt = t => {
    if (bandPts && t > last.ts) {
      const b = bandAt(t);
      return { t, value: b.mid, lo: b.lo, hi: b.hi, kind: "band" };
    }
    if (end && t > last.ts) {
      const f = Math.min(1, (t - last.ts) / Math.max(1, end.ts - last.ts));
      return { t, value: last.value + (end.value - last.value) * f, kind: "proj" };
    }
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p;
    return { t: best.ts, value: best.value, kind: "actual" };
  };

  const rows = [];
  if (bandPts) {
    for (const b of bandPts.slice(1).reverse()) rows.push([`${fmtClock(b.ts)} (proy.)`, `~${fmtPct(b.mid, 0)} (${Math.round(b.lo)}–${Math.round(b.hi)} %)`]);
  } else if (end) rows.push([end.hit ? `Límite · ${fmtClock(end.ts)}` : `Reinicio · ${fmtClock(end.ts)}`, `~${fmtPct(end.value, 0)} (proyección)`]);
  for (const p of pts.slice().reverse().slice(0, 120)) rows.push([new Date(p.ts).toLocaleTimeString(LOCALE), fmtPct(p.value, 1)]);

  return {
    head: ["Hora", "Uso"],
    rows,
    legend: (bandPts
      ? [{ cls: "", text: "Uso" }, { cls: "dashed", text: "Proyección" }, { cls: "band-key", text: "Rango probable" }, { cls: "ref-key", text: "Ritmo parejo" }]
      : [{ cls: "", text: "Uso" }, { cls: "dashed", text: "Proyección" }, { cls: "ref-key", text: "Ritmo parejo" }]
    ),
    caption: "",
    draw(host) {
      const m = { l: 34, r: 12, t: 24, b: 22 };
      const pw = CHART_W - m.l - m.r, ph = CHART_H - m.t - m.b;
      const x = t => Math.max(m.l, Math.min(m.l + pw, linear(t0, t1, m.l, m.l + pw)(t)));
      const y = linear(0, 100, m.t + ph, m.t);
      const root = svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, tabindex: 0, role: "img",
        "aria-label": "Uso de la ventana actual con proyección. La vista de tabla tiene los mismos datos." }, host);

      for (const v of [0, 25, 50, 75, 100]) {
        svg("line", { class: v === 0 ? "axis" : "grid", x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v) }, root);
        svg("text", { class: "tick", x: m.l - 6, y: y(v) + 3.5, "text-anchor": "end" }, root).textContent = `${v}%`;
      }
      // Etiquetas de hora: extremos destacados, horas enteras entre medias.
      svg("text", { class: "tick edge", x: m.l, y: CHART_H - 6 }, root).textContent = fmtClock(t0);
      svg("text", { class: "tick edge", x: m.l + pw, y: 12, "text-anchor": "end" }, root).textContent = `Reinicio ${dayLabel(t1)} ${fmtClock(t1)}`;
      const d = new Date(t0); d.setMinutes(0, 0, 0);
      for (let tick = d.getTime() < t0 ? d.getTime() + HOUR : d.getTime(); tick < t1; tick += HOUR) {
        const px = x(tick);
        if (px - m.l < 48 || m.l + pw - px < 80) continue;
        svg("text", { class: "tick", x: px, y: CHART_H - 6, "text-anchor": "middle" }, root).textContent = fmtClock(tick);
      }

      svg("line", { class: "ref", x1: x(t0), y1: y(0), x2: x(t1), y2: y(100) }, root);
      const shown = rampSeries(pts);
      const path = shown.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
      if (pts.length > 1) {
        svg("path", { class: "area", d: `${path}L${x(last.ts).toFixed(1)},${y(0)}L${x(pts[0].ts).toFixed(1)},${y(0)}Z` }, root);
        svg("path", { class: "line", d: path }, root);
      }
      if (bandPts) {
        // La banda sigue hasta el reinicio aunque la línea termine en el 100 %: su parte baja es lo que aún podría no agotarse.
        const up = bandPts.map(b => `${x(b.ts).toFixed(1)},${y(b.hi).toFixed(1)}`);
        const down = bandPts.map(b => `${x(b.ts).toFixed(1)},${y(b.lo).toFixed(1)}`).reverse();
        svg("path", { class: "band", d: `M${up.join("L")}L${down.join("L")}Z` }, root);
        const mids = end.prob
          ? bandPts.slice(1).filter(b => b.ts < end.ts).map(b => ({ ts: b.ts, value: Math.min(100, b.mid) })).concat({ ts: end.ts, value: 100 })
          : bandPts.slice(1).map(b => ({ ts: b.ts, value: b.mid }));
        svg("path", { class: "proj", d: "M" + [last].concat(mids).map(p => `${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join("L") }, root);
      } else if (end) {
        svg("path", { class: "proj", d: `M${x(last.ts).toFixed(1)},${y(last.value).toFixed(1)}L${x(end.ts).toFixed(1)},${y(end.value).toFixed(1)}` }, root);
      }

      const cross = svg("line", { class: "cross", y1: m.t, y2: m.t + ph, visibility: "hidden" }, root);
      const hoverDot = svg("circle", { class: "dot", r: 4, visibility: "hidden" }, root);
      svg("circle", { class: "dot", r: 4, cx: x(last.ts), cy: y(last.value) }, root);
      if (end) {
        const endDot = svg("circle", { class: `dot ${end.hit ? "critical" : ""}`, r: 4, cx: x(end.ts), cy: y(end.value) }, root);
        const text = end.hit ? `100% · ${fmtClock(end.ts)}` : `~${fmtPct(end.value, 0)}`;
        // Motor probabilístico: punto rojo en la hora más probable de agotarlo (si se agota), solo con la hora.
        // Si la proyección termina en el 100 %, su punto final es el único rojo, con su hora.
        if (end.prob || (fc && fc.hitQ && fc.pHit >= 0.25)) {
          const hitTs = end.prob ? end.ts : fc.hitQ[1];
          const hx = x(hitTs), hy = y(100);
          const hitDot = end.prob ? endDot : svg("circle", { class: "dot critical", r: 4, cx: hx, cy: hy }, root);
          const hitLabel = svg("text", { class: "label", "text-anchor": "middle", x: Math.min(m.l + pw - 14, Math.max(m.l + 14, hx)), y: hy - 9 }, root); // encima del gráfico, sobre el punto
          hitLabel.textContent = fmtClock(hitTs);
          const why = end.prob && fc.pHit < 0.5
            ? `La proyección llega al 100 % a las ${fmtClock(hitTs)} (probabilidad de agotarlo ${Math.round(fc.pHit * 100)} %)`
            : `Si te quedas sin límite, lo más probable es a las ${fmtClock(hitTs)} (probabilidad ${Math.round(fc.pHit * 100)} %)`;
          svg("title", {}, hitDot).textContent = why;
          svg("title", {}, hitLabel).textContent = why;
        }
        if (end.hit && !end.prob) { // etiqueta solo en el motor lineal; en el probabilístico el extremo ya lo dice la loseta "Al reinicio"
          const label = svg("text", { class: "label", "text-anchor": "end" }, root);
          label.textContent = end.label || `⚠ 100% · ${fmtClock(end.ts)}`;
          svg("title", {}, label).textContent = `Hora estimada en que llegarías al 100 %: ${fmtClock(end.ts)}`;
          label.setAttribute("y", y(end.value) + 4);
          label.setAttribute("x", x(end.ts) - 11);
          if (x(end.ts) - 11 - label.getComputedTextLength() < m.l + 2) {
            label.setAttribute("text-anchor", "start");
            label.setAttribute("x", x(end.ts) + 11);
          }
        }
      }

      const fmtRange = (lo, hi) => Math.round(lo) === Math.round(hi) ? `${Math.round(hi)} %` : `${Math.round(lo)}–${Math.round(hi)} %`;
      const show = (t, clientX, clientY) => {
        const v = valueAt(t);
        // Pasado el punto rojo la línea ya terminó en el 100 %: sin mediana ni punto, pero sí el rango y el ritmo parejo.
        const pastEnd = end && end.prob && t > end.ts;
        cross.setAttribute("x1", x(v.t)); cross.setAttribute("x2", x(v.t)); cross.setAttribute("visibility", "visible");
        hoverDot.setAttribute("cx", x(v.t)); hoverDot.setAttribute("cy", y(v.value)); hoverDot.setAttribute("visibility", pastEnd ? "hidden" : "visible");
        const rowsTip = pastEnd
          ? (v.kind === "band" ? [{ key: "band-key", value: fmtRange(v.lo, v.hi), name: "Rango 80 %" }] : [])
          : v.kind === "band"
          ? [{ key: "dashed", value: `~${fmtPct(v.value, 0)}`, name: "Mediana" },
             { key: "band-key", value: fmtRange(v.lo, v.hi), name: "Rango 80 %" }]
          : [v.kind === "actual"
            ? { key: "", value: fmtPct(v.value, 1), name: "Uso" }
            : { key: "dashed", value: `~${fmtPct(v.value, 1)}`, name: "Proyección" }];
        showTip(clientX, clientY, fmtClock(v.t), rowsTip.concat({ key: "ref-key", value: fmtPct(ref(v.t), 0), name: "Ritmo parejo" }));
      };
      const hide = () => {
        cross.setAttribute("visibility", "hidden"); hoverDot.setAttribute("visibility", "hidden"); hideTip();
      };
      const toTime = clientX => {
        const r = root.getBoundingClientRect();
        const px = (clientX - r.left) * CHART_W / r.width;
        return t0 + Math.min(1, Math.max(0, (px - m.l) / pw)) * WINDOW_MS;
      };
      root.addEventListener("pointermove", e => show(toTime(e.clientX), e.clientX, e.clientY));
      root.addEventListener("pointerleave", hide);
      // Teclado: mismas lecturas que con el puntero.
      const stops = pts.map(p => p.ts).concat(end ? [end.ts] : []);
      let k = stops.length - 1 - (end ? 1 : 0);
      root.addEventListener("keydown", e => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        k = Math.min(stops.length - 1, Math.max(0, k + (e.key === "ArrowRight" ? 1 : -1)));
        const r = root.getBoundingClientRect();
        show(stops[k], r.left + x(stops[k]) * r.width / CHART_W, r.top + y(valueAt(stops[k]).value) * r.height / CHART_H);
      });
      root.addEventListener("blur", hide);
    }
  };
}

function niceMax(v) {
  const need = Math.max(v, 4);
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100]) {
    if (need <= step * 4) return { max: Math.ceil(need / step) * step, step };
  }
  return { max: 100, step: 25 };
}

// Barras genéricas: una serie, color único, barra ≤ 24 px con extremo redondeado de 4 px.
function drawBars(host, items, { yMax, step, fmtTick, labelAt, seriesName, twoLine }) {
  const m = { l: 34, r: 8, t: 14, b: twoLine ? 34 : 22 };
  const pw = CHART_W - m.l - m.r, ph = CHART_H - m.t - m.b;
  const y = linear(0, yMax, m.t + ph, m.t);
  const band = pw / items.length, bw = Math.min(24, band * 0.62);
  const root = svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, role: "img",
    "aria-label": `${seriesName}. La vista de tabla tiene los mismos datos.` }, host);

  for (let v = 0; v <= yMax; v += step) {
    svg("line", { class: v === 0 ? "axis" : "grid", x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v) }, root);
    svg("text", { class: "tick", x: m.l - 6, y: y(v) + 3.5, "text-anchor": "end" }, root).textContent = fmtTick(v);
  }
  items.forEach((item, i) => {
    const cx = m.l + band * (i + 0.5), x0 = cx - bw / 2;
    const top = y(Math.min(item.value, yMax)), base = y(0), h = base - top;
    const g = svg("g", { class: "bar-group" }, root);
    const hit = svg("rect", { class: "bar-hit", x: m.l + band * i, y: m.t, width: band, height: ph, tabindex: 0,
      "aria-label": `${item.title}: ${item.valueText}` }, g);
    if (h >= 1) {
      const r = Math.min(4, bw / 2, h);
      svg("path", { class: "bar", d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${base}Z` }, g);
    }
    if (labelAt.has(i) && h >= 1) {
      svg("text", { class: "label", x: cx, y: top - 5, "text-anchor": "middle" }, g).textContent = item.shortValue;
    }
    if (item.xlabel) svg("text", { class: "tick", x: cx, y: CHART_H - (twoLine ? 18 : 6), "text-anchor": "middle" }, g).textContent = item.xlabel;
    if (item.xsub) svg("text", { class: "tick edge", x: cx, y: CHART_H - 5, "text-anchor": "middle" }, g).textContent = item.xsub;
    const show = e => {
      const r = hit.getBoundingClientRect();
      showTip(e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top, item.title, [{ key: "", value: item.valueText, name: seriesName }]);
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hideTip);
    hit.addEventListener("blur", hideTip);
  });
}

// Puntos de uso consumidos cada hora, últimas 24 h.
function hoursSpec() {
  const buckets = hourlyConsumption(model.samples, model.now, 24);
  const total = buckets.reduce((a, b) => a + b.pp, 0);
  if (!model.samples.length || total === 0 && model.samples.length < 3) {
    return emptySpec("Aún no hay consumo registrado. Se irá llenando mientras uses Claude.");
  }
  const peak = buckets.reduce((best, b, i) => (b.pp > buckets[best].pp ? i : best), 0);
  const { max, step } = niceMax(Math.max(...buckets.map(b => b.pp)));
  const items = buckets.map((b, i) => ({
    value: b.pp,
    title: `${fmtClock(b.start)}–${fmtClock(b.start + HOUR)}`,
    valueText: `${num(b.pp)} %`,
    shortValue: num(b.pp, 0),
    xlabel: i % 4 === 0 ? hourLabel(b.start) : ""
  }));
  return {
    head: ["Hora", "Consumo"],
    rows: buckets.slice().reverse().map(b => [`${dayLabel(b.start)} ${fmtClock(b.start)}`, num(b.pp)]),
    legend: [],
    caption: `% de la ventana de 5 h consumido cada hora. Total 24 h: ${num(total)} %.`,
    draw: host => drawBars(host, items, { yMax: max, step, fmtTick: v => num(v, 0), labelAt: new Set(buckets[peak].pp > 0 ? [peak] : []), seriesName: "Consumo" })
  };
}

// Pico alcanzado en cada ventana de 5 h observada.
function windowsSpec() {
  const ws = windowSummaries(model.samples).slice(-14);
  if (!ws.length) return emptySpec("Aún no hay ventanas registradas.");
  const peakIdx = ws.reduce((best, w, i) => (w.peak > ws[best].peak ? i : best), 0);
  let lastDay = "";
  const items = ws.map(w => {
    const day = new Date(w.start).toDateString();
    const item = {
      value: w.peak,
      title: `${dayLabel(w.start)} · ${fmtClock(w.start)}–${fmtClock(w.resetsAt)}`,
      valueText: `pico ${fmtPct(w.peak, 0)}`,
      shortValue: fmtPct(w.peak, 0),
      xlabel: hourLabel(w.start),
      xsub: day !== lastDay ? new Date(w.start).toLocaleDateString(LOCALE, { weekday: "short" }) : ""
    };
    lastDay = day;
    return item;
  });
  return {
    head: ["Inicio", "Fin", "Pico"],
    rows: ws.slice().reverse().map(w => [`${dayLabel(w.start)} ${fmtClock(w.start)}`, fmtClock(w.resetsAt), fmtPct(w.peak, 0)]),
    legend: [],
    caption: "Pico de uso de cada ventana de 5 h (hora de inicio en hora local).",
    draw: host => drawBars(host, items, {
      yMax: 100, step: 25, fmtTick: v => `${v}%`, labelAt: new Set([peakIdx, ws.length - 1]), seriesName: "Uso", twoLine: true
    })
  };
}

function drawTable(host, head, rows) {
  const table = html("table");
  const tr = html("tr");
  head.forEach((h, i) => tr.append(html("th", i === head.length - 1 ? "num" : "", h)));
  const thead = html("thead");
  thead.append(tr);
  table.append(thead);
  const body = html("tbody");
  for (const row of rows) {
    const r = html("tr");
    row.forEach((cell, i) => r.append(html("td", i === row.length - 1 ? "num" : "", cell)));
    body.append(r);
  }
  table.append(body);
  const wrap = html("div", "table-wrap");
  wrap.append(table);
  host.append(wrap);
}

function renderChart() {
  const host = $("chart");
  hideTip();
  host.replaceChildren();
  const spec = ui.scope === "week" ? weekSpec() : ui.tab === "hours" ? hoursSpec() : ui.tab === "windows" ? windowsSpec() : windowSpec();
  if (ui.view === "table" && spec.head) drawTable(host, spec.head, spec.rows);
  else spec.draw(host);

  const legend = $("legend");
  legend.replaceChildren();
  for (const item of ui.view === "chart" ? spec.legend : []) {
    const span = html("span");
    span.append(html("i", item.cls), document.createTextNode(item.text));
    legend.append(span);
  }
  legend.hidden = !legend.childElementCount;
  $("caption").textContent = spec.caption;
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab));
  const toggle = $("view-toggle");
  toggle.hidden = !spec.head;      // sin datos no hay tabla que mostrar
  toggle.setAttribute("aria-pressed", String(ui.view === "table"));
  toggle.textContent = ui.view === "table" ? "Ver gráfico" : "Ver tabla";
  const nav = $("week-nav");
  nav.hidden = ui.scope !== "week" || !ui.weekNav;
  $("tabs").hidden = ui.scope === "week";
  if (!nav.hidden) {
    $("week-prev").disabled = !ui.weekNav.prev;
    $("week-next").disabled = !ui.weekNav.next;
    $("week-range").textContent = ui.weekNav.range;
  }
}


// Semanas: un ciclo semanal de reinicio a reinicio, con franjas alternas por día local y proyección por perfil horario.
// Los datos salen de weeklyLog; ‹ › (o [ ]) cambian de semana.
function weekSpec() {
  const log = model.weeklyLog || [];
  const key = log.some(r => r[0] === "seven_day") ? "seven_day" : (log[0] && log[0][0]);
  const cycles = log.filter(r => r[0] === key && Number.isFinite(r[1]) && r[3] && r[3].length).sort((a, b) => a[1] - b[1]);
  ui.weekBack = Math.max(0, Math.min(ui.weekBack, cycles.length - 1));
  const cycle = cycles[cycles.length - 1 - ui.weekBack];
  ui.weekNav = { prev: ui.weekBack < cycles.length - 1, next: ui.weekBack > 0,
    range: cycle ? `${fmtDay(cycle[1] - WEEK_MS)} – ${fmtDay(cycle[1])}${ui.weekBack === 0 ? " (actual)" : ""}` : "" };
  if (!cycle) return emptySpec("Aún no hay datos semanales. Se irán llenando mientras uses Claude.");
  const t1 = cycle[1], t0 = t1 - WEEK_MS, now = model.now;
  let top = 0;   // el uso semanal no baja dentro de un ciclo; el máximo acumulado quita el vaivén entre fuentes
  const pts = cycle[3].map(([ts, value]) => ({ ts, value: (top = Math.max(top, value)) })).filter(p => p.ts >= t0 - HOUR);
  const last = pts[pts.length - 1];
  const tEnd = Math.min(t1, Math.max(now, last.ts));
  if (tEnd > last.ts) pts.push({ ts: tEnd, value: last.value });
  const valueAt = t => {
    let v = pts[0].value;
    for (const p of pts) { if (p.ts <= t) v = p.value; else break; }
    return v;
  };
  // Proyección por perfil horario (laboral / fin de semana); sin datos suficientes, el ritmo medio del ciclo hasta ahora.
  let proj = null;
  if (t1 > now && tEnd - t0 > 12 * HOUR && last.value > 0 && last.value < 100) {
    const wf = weeklyForecast(log, cycle, now);
    if (wf) {
      wf.points[0] = { ts: tEnd, value: last.value };
      const e = wf.points[wf.points.length - 1];
      proj = { points: wf.points, band: wf.band, series: wf.band, ts: e.ts, value: e.value, hit: wf.hit, learning: wf.learning, cycles: wf.cycles, pHit: wf.pHit, hitQ: wf.hitQ, finalQ: wf.finalQ };
    } else {
      const rate = last.value / (tEnd - t0), hitTs = tEnd + (100 - last.value) / rate;
      const e = hitTs < t1 ? { ts: hitTs, value: 100 } : { ts: t1, value: last.value + rate * (t1 - tEnd) };
      proj = { points: [{ ts: tEnd, value: last.value }, e], series: { ts: [tEnd, e.ts], mid: [last.value, e.value], lo: null, hi: null }, ts: e.ts, value: e.value, hit: hitTs < t1, linear: true };
    }
  }
  // Mediana y rango de la proyección en el instante t (interpolación entre puntos; la franja llega hasta el reinicio).
  const projAt = t => {
    const sr = proj.series;
    for (let i = 1; i < sr.ts.length; i++) {
      if (t > sr.ts[i]) continue;
      const f = (t - sr.ts[i - 1]) / Math.max(1, sr.ts[i] - sr.ts[i - 1]), mix = a => a[i - 1] + (a[i] - a[i - 1]) * f;
      return { value: mix(sr.mid), lo: sr.lo ? mix(sr.lo) : null, hi: sr.hi ? mix(sr.hi) : null };
    }
    const e = sr.ts.length - 1;
    return { value: sr.mid[e], lo: sr.lo ? sr.lo[e] : null, hi: sr.hi ? sr.hi[e] : null };
  };
  const projEnd = () => proj.series.ts[proj.series.ts.length - 1];

  // Días locales que cruzan el ciclo, recortados a [t0, t1].
  const days = [];
  for (let d = new Date(t0); d.setHours(0, 0, 0, 0) < t1; d.setDate(d.getDate() + 1)) {
    const a = Math.max(t0, d.getTime()), nd = new Date(d); nd.setDate(nd.getDate() + 1);
    days.push({ a, b: Math.min(t1, nd.getTime()) });
  }
  const gain = day => {
    const a = Math.max(day.a, pts[0].ts), b = Math.min(day.b, tEnd);
    return b > a ? Math.max(0, valueAt(b) - valueAt(a)) : null;
  };

  const past = t1 <= now;
  const wkday = ts => `${new Date(ts).toLocaleDateString(LOCALE, { weekday: "short" })} ${fmtClock(ts)}`;
  // El uso, la probabilidad, la hora probable y el valor al reinicio ya están en la tarjeta principal; aquí solo el cierre de semanas pasadas.
  const cap = past ? `Cerró en ${fmtPct(cycle[2], 0)}.` : "";

  const rows = [];
  if (proj) rows.push([proj.hit ? `Límite · ${wkday(proj.ts)}` : `Reinicio · ${wkday(proj.ts)}`, `~${fmtPct(proj.value, 0)} (proyección)`]);
  for (const p of pts.slice().reverse().slice(0, 120)) rows.push([wkday(p.ts), fmtPct(p.value, 1)]);
  return {
    head: ["Momento", "Uso"],
    rows,
    legend: [{ cls: "", text: "Uso" }, ...(proj ? [{ cls: "dashed", text: "Proyección" }, ...(proj.band ? [{ cls: "band-key", text: "Rango 80 %" }] : [])] : []), { cls: "ref-key", text: "Ritmo parejo" }, ...(cap ? [{ cls: "note", text: cap }] : [])],   // el cierre va en la misma fila que la leyenda
    caption: "",
    draw(host) {
      const m = { l: 34, r: 12, t: 24, b: 22 };
      const pw = CHART_W - m.l - m.r, ph = CHART_H - m.t - m.b;
      const x = linear(t0, t1, m.l, m.l + pw);
      const y = linear(0, 100, m.t + ph, m.t);
      const root = svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, tabindex: 0, role: "img",
        "aria-label": "Uso semanal acumulado a lo largo del ciclo, con una franja por día." }, host);
      svg("text", { class: "tick edge", x: m.l + pw, y: 12, "text-anchor": "end" }, root).textContent = `Reinicio ${wkday(t1)}`;
      if (proj && proj.hit) svg("text", { class: "tick edge", x: m.l, y: 12 }, root).textContent = `Límite ${wkday(proj.ts)}`;
        days.forEach((d, i) => {
        if (i % 2 === 0) svg("rect", { class: "day-band", x: x(d.a), y: m.t, width: x(d.b) - x(d.a), height: ph }, root);
        const wide = x(d.b) - x(d.a) > 22;
        if (wide) svg("text", { class: `day-tick${d.a <= now && now < d.b ? " today" : ""}`, x: (x(d.a) + x(d.b)) / 2, y: CHART_H - 6, "text-anchor": "middle" }, root)
          .textContent = new Date(d.a).toLocaleDateString(LOCALE, { weekday: "short" });
      });
      for (const v of [0, 25, 50, 75, 100]) {
        svg("line", { class: v === 0 ? "axis" : "grid", x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v) }, root);
        svg("text", { class: "tick", x: m.l - 6, y: y(v) + 3.5, "text-anchor": "end" }, root).textContent = `${v}%`;
      }
      svg("line", { class: "ref", x1: x(t0), y1: y(0), x2: x(t1), y2: y(100) }, root);
      const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
      svg("path", { class: "area", d: `${path}L${x(tEnd).toFixed(1)},${y(0)}L${x(pts[0].ts).toFixed(1)},${y(0)}Z` }, root);
      svg("path", { class: "line", d: path }, root);
      if (proj) {
        if (proj.band) {
          const up = proj.band.ts.map((ts, i) => `${x(ts).toFixed(1)},${y(proj.band.hi[i]).toFixed(1)}`);
          const down = proj.band.ts.map((ts, i) => `${x(ts).toFixed(1)},${y(proj.band.lo[i]).toFixed(1)}`).reverse();
          svg("path", { class: "band", d: `M${up.join("L")}L${down.join("L")}Z` }, root);
        }
        svg("path", { class: "proj", d: proj.points.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join("") }, root);
        svg("circle", { class: `dot${proj.hit ? " critical" : ""}`, r: 4, cx: x(proj.ts), cy: y(proj.value) }, root);
      }
      const cross = svg("line", { class: "cross", y1: m.t, y2: m.t + ph, visibility: "hidden" }, root);
      const hoverDot = svg("circle", { class: "dot", r: 4, visibility: "hidden" }, root);
      svg("circle", { class: "dot", r: 4, cx: x(tEnd), cy: y(last.value) }, root);

      const show = (t, clientX, clientY) => {
        t = Math.min(proj ? projEnd() : tEnd, Math.max(pts[0].ts, t));
        const projected = proj && t > tEnd;
        const pr = projected ? projAt(t) : null, v = projected ? pr.value : valueAt(t);
        cross.setAttribute("x1", x(t)); cross.setAttribute("x2", x(t)); cross.setAttribute("visibility", "visible");
        hoverDot.setAttribute("cx", x(t)); hoverDot.setAttribute("cy", y(v)); hoverDot.setAttribute("visibility", "visible");
        const day = days.find(d => t >= d.a && t < d.b) || days[days.length - 1], g = gain(day);
        const rowsTip = [projected ? { key: "dashed", value: `~${fmtPct(v, 0)}`, name: "Proyección" } : { key: "", value: fmtPct(v, 1), name: "Uso semanal" }];
        if (projected && pr.lo !== null) rowsTip.push({ key: "band-key", value: `${Math.round(pr.lo)}–${Math.round(pr.hi)} %`, name: "Rango 80 %" });
        if (!projected && g !== null) rowsTip.push({ key: "ref-key", value: `+${num(g)} pp`, name: "ese día" });
        showTip(clientX, clientY, `${dayLabel(t)} · ${fmtClock(t)}`, rowsTip);
      };
      const hide = () => { cross.setAttribute("visibility", "hidden"); hoverDot.setAttribute("visibility", "hidden"); hideTip(); };
      root.addEventListener("pointermove", e => {
        const r = root.getBoundingClientRect();
        const px = (e.clientX - r.left) * CHART_W / r.width;
        show(t0 + Math.min(1, Math.max(0, (px - m.l) / pw)) * WEEK_MS, e.clientX, e.clientY);
      });
      root.addEventListener("pointerleave", hide);
      root.addEventListener("blur", hide);
    },
  };
}

// ── Datos y ajustes ─────────────────────────────────────────────────────────
function renderAll() {
  renderSummary();
  renderChart();
}
const fmtDay = ts => new Date(ts).toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
async function load() {
  const data = await chrome.storage.local.get([STATE_KEY, SAMPLES_KEY, ALERTS_KEY, BADGE_KEY, ICON_SHAPE_KEY, NUMBER_ALPHA_KEY, NUMBER_SCALE_KEY, NUMBER_DX_KEY, NUMBER_DY_KEY, BLOCKS_KEY, WINDOWS_KEY, FLOG_KEY, WEEKLY_KEY, "viewScope", "appVersion", "dataSource", "dataPriority", "claudeCodeConnected", "remoteUrl", "remoteUrlOnline", "remoteTokenSet", "remoteFromEnv", "serverVersion", "remoteVia", "updateAdvice", "updateCheck", "repoUrl", "updateChannel", "canInstallUpdate", "updateSummary", "updateProgress", "pollSeconds", "openAtLogin"]);
  model = { state: data[STATE_KEY] || {}, samples: unpackSamples(data[SAMPLES_KEY]), blocks: data[BLOCKS_KEY] || [], weeklyLog: data[WEEKLY_KEY] || [], now: Date.now() };
  setScope(data.viewScope);
  $("icon-shape").value = ["rings", "donut", "pie1", "pie2", "pie3"].includes(data[ICON_SHAPE_KEY]) ? data[ICON_SHAPE_KEY] : "donut";
  const alpha = Math.round(Math.min(1, Math.max(0.15, Number(data[NUMBER_ALPHA_KEY]) || 0.48)) * 100);
  $("number-alpha").value = alpha;
  $("alpha-value").textContent = `${alpha} %`;
  const scale = Math.round(Math.min(1.6, Math.max(0.5, Number(data[NUMBER_SCALE_KEY]) || 1)) * 100);
  const dx = Math.round((Number(data[NUMBER_DX_KEY]) || 0) * 100), dy = Math.round((Number(data[NUMBER_DY_KEY]) || 0) * 100);
  $("number-scale").value = scale; $("number-dx").value = dx; $("number-dy").value = dy;
  updateNumberLabels();
  const score = brierScore(data[FLOG_KEY] || [], data[WINDOWS_KEY] || [], Date.now(), model.state.calib);
  $("precision").textContent = score.n >= 5
    ? `Precisión del modelo: Brier ${num(score.brier, 3)} en ${score.windows} ventanas${model.state.calib ? " (recalibrado con tus datos)" : ""}. Menor es mejor; 0,25 equivale a tirar una moneda.`
    : "Precisión del modelo: aún no hay ventanas cerradas suficientes para medirla.";
  $("alerts").checked = data[ALERTS_KEY] !== false;
  $("badge-mode").value = data[BADGE_KEY] || "pace";
  // Con Claude Code como fuente y sin conectar, la tarjeta ofrece conectar desde el propio panel.
  $("connect").hidden = !(data.dataSource === "claude-code" && !data.claudeCodeConnected && model.state.status !== "connected");
  renderSource(data);
  renderVersions(data);
  renderAll();
  if (!$("connect").hidden) $("error").hidden = true;      // la tarjeta ya explica qué falta
  renderIconPreview();
}
function pollNow() {
  $("chart").classList.add("loading"); $("refresh").classList.add("spinning");
  chrome.runtime.sendMessage({ type: "POLL_NOW" }, () => {
    void chrome.runtime.lastError;
    $("chart").classList.remove("loading"); $("refresh").classList.remove("spinning");
    load();
  });
}

// Fuente de datos. El servidor propio se guarda con su botón (no al teclear) y la URL no se pisa mientras se edita.
const SOURCE_HINTS = {
  auto: "Consulta primero la que elijas abajo y, si no responde, las demás. Sin perder el último dato.",
  oauth: "Tu cuenta de Claude Code en este equipo, sin login ni línea de estado.",
  "claude-code": "Los límites que calcula Claude Code (planes Pro y Max) vía la línea de estado. Sin cookies.",
  web: "Tu sesión de claude.ai en una ventana de la app. Trae todos los topes semanales.",
  remote: "Un servidor tuyo que consulta el uso; la app solo lo muestra."
};
function showSource(source, priority = $("data-priority").value) {
  $("data-source").value = source;
  $("source-hint").textContent = SOURCE_HINTS[source] || "";
  $("priority-row").hidden = source !== "auto";
  $("remote-fields").hidden = source !== "remote";
  $("cc-row").hidden = source !== "claude-code" && source !== "auto";      // en «auto» el archivo siempre es uno de los respaldos
  $("web-row").hidden = source !== "web" && !(source === "auto" && priority === "web");
}
function setStatus(text, state) { $("remote-status").textContent = text; $("remote-status").dataset.state = state || ""; }
function renderSource(data) {
  const source = data.dataSource || "claude-code";
  ui.ccConnected = !!data.claudeCodeConnected;
  $("cc-desc").textContent = ui.ccConnected ? "Conectada: la app lee tus límites desde ahí" : "Sin conectar: no llegan datos";
  $("cc-btn").textContent = ui.ccConnected ? "Desconectar…" : "Conectar…";
  $("cc-btn").className = ui.ccConnected ? "text-btn" : "text-btn primary";
  $("poll-seconds").value = String([10, 20, 30, 60].includes(data.pollSeconds) ? data.pollSeconds : 20);
  $("open-at-login").checked = !!data.openAtLogin;
  $("data-priority").value = ["oauth", "claude-code", "web"].includes(data.dataPriority) ? data.dataPriority : "oauth";
  showSource(source);
  for (const [id, key] of [["remote-url", "remoteUrl"], ["remote-url-online", "remoteUrlOnline"]]) {
    if (document.activeElement !== $(id)) $(id).value = data[key] || "";
    $(id).disabled = !!data.remoteFromEnv;
  }
  $("remote-token").placeholder = data.remoteTokenSet ? "guardado ••••••" : "opcional";
  $("remote-clear-token").hidden = !data.remoteTokenSet || !!data.remoteFromEnv;
  if (data.remoteFromEnv) $("remote-status").textContent = "Las URLs vienen de USAGE_MONITOR_REMOTE_URL / USAGE_MONITOR_REMOTE_URL_ONLINE.";
}
$("data-source").addEventListener("change", e => {
  const value = e.target.value;
  showSource(value);
  setStatus("");
  // Sin URL guardada, elegir «Servidor propio» solo muestra los campos; se activa al pulsar «Guardar y probar».
  if (value === "remote" && !$("remote-url").value && !$("remote-url-online").value) { $("remote-url").focus(); return; }
  chrome.runtime.sendMessage({ type: "SET_SOURCE", value }, () => { void chrome.runtime.lastError; load(); });
});
$("data-priority").addEventListener("change", e => {
  showSource($("data-source").value, e.target.value);
  chrome.storage.local.set({ dataPriority: e.target.value }).then(load);
});
function saveRemote(extra = {}) {
  setStatus("Probando…");
  $("remote-save").disabled = true;
  chrome.runtime.sendMessage({ type: "SET_REMOTE", url: $("remote-url").value, urlOnline: $("remote-url-online").value, token: $("remote-token").value, ...extra }, r => {
    void chrome.runtime.lastError;
    $("remote-save").disabled = false;
    $("remote-token").value = "";
    $("remote-token").type = "password";
    if (r && r.ok) $("token-env").hidden = true;      // el servidor ya acepta el token: la línea ya está en su .env
    if (r && r.ok) setStatus("Conectado: datos recibidos.", "ok"); else setStatus(`No se pudo leer: ${(r && r.error) || "sin respuesta"}`, "error");
    load();
  });
}
$("remote-save").addEventListener("click", () => saveRemote());
// Token generado aquí: 32 bytes aleatorios en hex. Se muestra la línea para el .env del servidor y se guarda con «Guardar y probar».
$("remote-gen-token").addEventListener("click", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  $("remote-token").type = "text";
  $("remote-token").value = token;
  $("token-env-line").textContent = token;
  $("token-env").hidden = false;
  $("token-copy").textContent = "Copiar";
  setStatus("");
});
$("token-copy").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "COPY_TOKEN_LINE", text: $("token-env-line").textContent }, r => {
    void chrome.runtime.lastError;
    $("token-copy").textContent = r && r.ok ? "Copiado" : "Selecciona y copia";
  });
});
$("remote-clear-token").addEventListener("click", () => saveRemote({ token: "", clearToken: true }));
$("remote-url").addEventListener("keydown", e => { if (e.key === "Enter") saveRemote(); });
$("remote-url-online").addEventListener("keydown", e => { if (e.key === "Enter") saveRemote(); });
$("remote-token").addEventListener("keydown", e => { if (e.key === "Enter") saveRemote(); });

// Versiones: pie con la app y el servidor (si se usa) y tarjeta con los avisos de actualización.
function renderVersions(data) {
  ui.source = data.dataSource === "claude-code" ? "Claude Code" : data.dataSource === "remote" ? `tu servidor${data.remoteVia ? ` (${data.remoteVia})` : ""}` : "Claude.ai";
  const parts = [];
  if (data.appVersion) parts.push(`Usage Monitor v${data.appVersion}`);
  if (data.dataSource === "remote" && data.serverVersion) parts.push(`servidor v${data.serverVersion}${data.remoteVia ? ` (${data.remoteVia === "online" ? "online" : "local"})` : ""}`);
  else if (data.dataSource === "remote" && data.remoteVia) parts.push(`servidor sin versión (${data.remoteVia})`);
  $("app-version").textContent = parts.join(" · ");
  $("repo-link").hidden = !data.repoUrl;
  $("repo-link").dataset.url = data.repoUrl || "";
  $("update-check").checked = data.updateCheck !== false;
  $("channel-row").hidden = data.updateCheck === false;      // el canal solo importa si se buscan actualizaciones
  $("update-channel").value = data.updateChannel === "dev" ? "dev" : "main";
  renderUpdateSummary(data.updateSummary);
  ui.updates = { advice: Array.isArray(data.updateAdvice) ? data.updateAdvice : [], canInstall: !!data.canInstallUpdate, progress: data.updateProgress || null };
  renderUpdates();
}
const MB = n => `${(n / 1048576).toFixed(0)} MB`;
const button = (text, primary, onClick) => { const b = html("button"); b.className = primary ? "text-btn primary" : "link-btn"; b.textContent = text; b.addEventListener("click", onClick); return b; };
// Tarjeta de actualización: el aviso con «Actualizar ahora» o, si ya empezó, la barra de descarga, la instalación o el error.
// Se vuelve a dibujar con cada avance de la descarga (la app manda «updateProgress» sin recargar el resto del panel).
function renderUpdates() {
  const { advice = [], canInstall = false, progress: job = null } = ui.updates || {};
  const box = $("updates");
  box.hidden = !advice.length && !job;
  box.replaceChildren();
  if (box.hidden) return;
  const row = html("div"); row.className = "notice-actions";
  const h = html("h2");
  if (job && job.phase === "download") {
    const pct = job.total ? Math.min(100, Math.round(job.received / job.total * 100)) : null;
    h.textContent = `Descargando v${job.version}`;
    const bar = html("div"); bar.className = "progress" + (pct == null ? " indeterminate" : "");
    bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
    if (pct != null) bar.setAttribute("aria-valuenow", String(pct));
    const fill = html("div"); fill.className = "progress-fill"; if (pct != null) fill.style.width = `${pct}%`;
    bar.append(fill);
    const p = html("p"); p.className = "progress-text";
    p.textContent = pct == null ? `${MB(job.received)} descargados` : `${pct} % · ${MB(job.received)} de ${MB(job.total)}`;
    row.append(button("Cancelar", false, () => chrome.runtime.sendMessage({ type: "CANCEL_UPDATE" })));
    box.append(h, bar, p, row);
    return;
  }
  if (job && job.phase === "install") {
    h.textContent = `Instalando v${job.version}`;
    const bar = html("div"); bar.className = "progress indeterminate"; bar.append(Object.assign(html("div"), { className: "progress-fill" }));
    const p = html("p"); p.textContent = "Descarga verificada. La app se cerrará y volverá a abrirse en unos segundos.";
    box.append(h, bar, p);
    return;
  }
  if (job && job.phase === "error") {
    h.textContent = "No se pudo actualizar";
    const p = html("p"); p.textContent = job.error || "Error desconocido.";
    box.append(h, p);
    if (advice.some(a => a.kind === "app") && canInstall) row.append(button("Reintentar", true, () => chrome.runtime.sendMessage({ type: "INSTALL_UPDATE" })));
    row.append(button("Cerrar", !row.childElementCount, () => chrome.runtime.sendMessage({ type: "DISMISS_UPDATE_ERROR" })));
    box.append(row);
    return;
  }
  h.textContent = advice.some(a => a.switch) ? "Cambiar a la versión estable" : advice.some(a => a.kind === "app") ? "Actualización disponible" : "Actualiza el servidor";
  box.append(h);
  for (const a of advice) { const p = html("p"); p.textContent = a.text; box.append(p); }
  const appAdvice = advice.find(a => a.kind === "app");
  if (appAdvice && canInstall) {      // la app descarga e instala sola (Windows x64 y macOS Apple Silicon empaquetadas)
    row.append(button(appAdvice.switch ? `Instalar v${appAdvice.version}` : "Actualizar ahora", true, e => {
      e.currentTarget.disabled = true;
      chrome.runtime.sendMessage({ type: "INSTALL_UPDATE" });
    }));
  }
  const url = (advice.find(a => a.url) || {}).url;
  if (url) row.append(button("Ver novedades", !row.childElementCount, () => chrome.runtime.sendMessage({ type: "OPEN_RELEASE", url })));
  if (row.childElementCount) box.append(row);
}
// Tarjeta «Actualizado a vX»: lo que cambió desde la versión anterior, hasta que la cierres.
function renderUpdateSummary(s) {
  const box = $("update-summary");
  box.hidden = !s;
  box.replaceChildren();
  if (!s) return;
  const h = html("h2"); h.textContent = s.downgrade ? `Volviste a v${s.to}` : `Actualizado a v${s.to}`;
  const p = html("p"); p.textContent = s.items && s.items.length ? `Novedades desde v${s.from}:` : `Antes tenías v${s.from}. No hay lista de cambios para este salto; míralos en GitHub.`;
  box.append(h, p);
  if (s.items && s.items.length) {
    const ul = html("ul"); ul.className = "summary-list";
    for (const it of s.items) { const li = html("li"); li.textContent = it; ul.append(li); }
    if (s.more) { const li = html("li"); li.className = "muted"; li.textContent = `y ${s.more} más`; ul.append(li); }
    box.append(ul);
  }
  const row = html("div"); row.className = "notice-actions";
  row.append(button("Entendido", true, () => chrome.runtime.sendMessage({ type: "DISMISS_UPDATE_SUMMARY" })));
  if (s.url) row.append(button("Ver en GitHub", false, () => chrome.runtime.sendMessage({ type: "OPEN_RELEASE", url: s.url })));
  box.append(row);
}
$("update-channel").addEventListener("change", e => chrome.storage.local.set({ updateChannel: e.target.value }));
$("repo-link").addEventListener("click", e => { e.preventDefault(); chrome.runtime.sendMessage({ type: "OPEN_RELEASE", url: e.currentTarget.dataset.url }); });
$("update-check").addEventListener("change", e => { $("channel-row").hidden = !e.target.checked; chrome.storage.local.set({ updateCheck: e.target.checked }); });

// Dos vistas: «Uso» (lo que se mira a diario) y «Ajustes» (lo que se toca de vez en cuando), con el engranaje de la cabecera.
function showSettings(open) {
  $("view-usage").hidden = open;
  $("view-settings").hidden = !open;
  $("settings-btn").setAttribute("aria-pressed", String(open));
  $("settings-btn").title = open ? "Volver al uso" : "Ajustes";
  window.scrollTo(0, 0);
  if (open) renderIconPreview(); else { hideTip(); renderChart(); }
}
$("settings-btn").addEventListener("click", () => showSettings($("view-settings").hidden));
$("settings-back").addEventListener("click", () => showSettings(false));
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("view-settings").hidden) showSettings(false); });

$("refresh").addEventListener("click", pollNow);
function setScope(scope) {
  ui.scope = scope === "week" ? "week" : "window";
  $("scope-btn").textContent = ui.scope === "week" ? "Semana" : "Ventana";
  $("scope-btn").setAttribute("aria-pressed", String(ui.scope === "week"));
}
// El modo se guarda en los ajustes de la app (sobrevive a los reinicios) y también decide qué muestra el ícono.
$("scope-btn").addEventListener("click", () => {
  setScope(ui.scope === "week" ? "window" : "week");
  chrome.storage.local.set({ viewScope: ui.scope });
  renderAll();
});
$("week-prev").addEventListener("click", () => { ui.weekBack++; renderChart(); });
$("week-next").addEventListener("click", () => { ui.weekBack--; renderChart(); });
// Teclado (en la vista «Semana»): ← o [ = semana anterior; → o ] = semana siguiente.
document.addEventListener("keydown", e => {
  if (ui.scope !== "week" || !$("view-settings").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  const dir = e.key === "[" || e.key === "ArrowLeft" ? 1 : e.key === "]" || e.key === "ArrowRight" ? -1 : 0;
  if (!dir || e.shiftKey) return;
  e.preventDefault();
  ui.weekBack = Math.max(0, ui.weekBack + dir);
  renderChart();
});
for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => { ui.tab = b.dataset.tab; renderChart(); });
$("view-toggle").addEventListener("click", () => { ui.view = ui.view === "table" ? "chart" : "table"; renderChart(); });
$("alerts").addEventListener("change", e => chrome.storage.local.set({ [ALERTS_KEY]: e.target.checked }));
// Vista previa del ícono con los valores actuales de las barras (sin esperar a guardar).
function updateNumberLabels() {
  $("scale-value").textContent = `${$("number-scale").value} %`;
  $("dx-value").textContent = $("number-dx").value;
  $("dy-value").textContent = $("number-dy").value;
}
function renderIconPreview() {
  const s = model.state, now = Date.now();
  const proj = projection(s, now), level = levelFor(s, proj, now);
  const text = badgeInfo(s, $("badge-mode").value, now).text || "43";    // sin número real se muestra uno de ejemplo
  const num = { scale: Number($("number-scale").value) / 100, dx: Number($("number-dx").value) / 100, dy: Number($("number-dy").value) / 100 };
  const alpha = Number($("number-alpha").value) / 100, shape = $("icon-shape").value;
  for (const [id, ink] of [["pv-light", "31,33,36"], ["pv-dark", "255,255,255"]]) {
    for (const [suffix, size] of [["", 128], ["-s", 32]]) {
      const canvas = $(id + suffix);
      drawIcon(canvas.getContext("2d"), size, iconParams(s, level, now, text, shape, ink, alpha, num));
    }
  }
}
for (const id of ["number-scale", "number-dx", "number-dy"]) {
  $(id).addEventListener("input", () => { updateNumberLabels(); renderIconPreview(); });
}
$("number-scale").addEventListener("change", e => chrome.storage.local.set({ [NUMBER_SCALE_KEY]: Number(e.target.value) / 100 }));
$("number-dx").addEventListener("change", e => chrome.storage.local.set({ [NUMBER_DX_KEY]: Number(e.target.value) / 100 }));
$("number-dy").addEventListener("change", e => chrome.storage.local.set({ [NUMBER_DY_KEY]: Number(e.target.value) / 100 }));
$("number-reset").addEventListener("click", () => {
  $("number-scale").value = 100; $("number-dx").value = 0; $("number-dy").value = 0; updateNumberLabels(); renderIconPreview();
  chrome.storage.local.set({ [NUMBER_SCALE_KEY]: 1, [NUMBER_DX_KEY]: 0, [NUMBER_DY_KEY]: 0 });
});
for (const id of ["icon-shape", "badge-mode", "number-alpha"]) $(id).addEventListener("input", renderIconPreview);
$("icon-shape").addEventListener("change", e => chrome.storage.local.set({ [ICON_SHAPE_KEY]: e.target.value }));
$("number-alpha").addEventListener("input", e => { $("alpha-value").textContent = `${e.target.value} %`; });
$("number-alpha").addEventListener("change", e => chrome.storage.local.set({ [NUMBER_ALPHA_KEY]: Number(e.target.value) / 100 }));
$("badge-mode").addEventListener("change", e => chrome.storage.local.set({ [BADGE_KEY]: e.target.value }));

function saveCsv(lines, name) {
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = html("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("export").addEventListener("click", () => saveCsv(["timestamp,uso_pct,reinicio"].concat(model.samples.map(s =>
  `${new Date(s.ts).toISOString()},${s.value},${s.resetsAt ? new Date(s.resetsAt).toISOString() : ""}`)), "usage-monitor"));
// Historial semanal [cupo, reinicio, pico, [[ts, uso], …]] en el formato que lee «Importar CSV» (src/importer.js).
$("export-weekly").addEventListener("click", () => {
  const lines = ["cupo,reinicio,timestamp,uso_pct"];
  for (const [key, resetsAt, , points] of model.weeklyLog) {
    for (const [ts, v] of points || []) lines.push(`${key},${new Date(resetsAt).toISOString()},${new Date(ts).toISOString()},${v}`);
  }
  if (lines.length === 1) { $("import-status").textContent = "Aún no hay historial semanal para exportar."; return; }
  saveCsv(lines, "usage-monitor-semanal");
});
$("connect-btn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "CONNECT_CLAUDE_CODE" }, () => { void chrome.runtime.lastError; load(); }));
$("use-web").addEventListener("click", () => chrome.runtime.sendMessage({ type: "SET_SOURCE", value: "web" }, () => { void chrome.runtime.lastError; load(); }));
$("import").addEventListener("click", () => {
  const status = $("import-status");
  status.textContent = "Elige uno o más CSV exportados desde Ajustes (lecturas, bloques o semanal)…";
  chrome.runtime.sendMessage({ type: "IMPORT_CSV" }, r => {
    void chrome.runtime.lastError;
    if (!r || r.canceled) { status.textContent = ""; return; }
    if (!r.ok) { status.textContent = `No se pudo importar: ${r.error || "error desconocido"}.`; return; }
    const s = r.summary, parts = [];
    if (s.lecturas) parts.push(`${s.lecturas} lecturas (${fmtDay(s.desde)} – ${fmtDay(s.hasta)})`);
    if (s.bloques && !s.lecturas) parts.push(`${s.bloques} bloques`);
    if (s.semanal) parts.push(`${s.semanal} ciclos semanales`);
    status.textContent = `Importado: ${parts.join(", ")}. El modelo se reajustó con el historial resultante.`;
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STATE_KEY] || changes[SAMPLES_KEY])) load();
  if (area === "local" && changes.updateProgress) { ui.updates = { ...(ui.updates || {}), progress: changes.updateProgress.newValue }; renderUpdates(); }
  if (area === "local" && changes.panelView) showSettings(changes.panelView.newValue === "settings");    // «Ajustes…» del menú
});
$("cc-btn").addEventListener("click", () => chrome.runtime.sendMessage({ type: ui.ccConnected ? "DISCONNECT_CLAUDE_CODE" : "CONNECT_CLAUDE_CODE" }, () => { void chrome.runtime.lastError; load(); }));
$("web-open").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_LOGIN_WINDOW" }));
$("poll-seconds").addEventListener("change", e => chrome.storage.local.set({ pollSeconds: Number(e.target.value) }));
$("open-at-login").addEventListener("change", e => chrome.storage.local.set({ openAtLogin: e.target.checked }));
if (location.hash === "#settings") showSettings(true);
setInterval(() => { model.now = Date.now(); renderSummary(); }, 15000);

load().then(() => {
  // La ventana toma el alto que pide la vista de uso (sin espacio vacío al pie); los ajustes, más largos, se desplazan.
  if (!$("view-usage").hidden) chrome.runtime.sendMessage({ type: "PANEL_FIT", height: Math.ceil(document.querySelector("main").getBoundingClientRect().height) });
  // Al abrir, refrescar si el dato tiene más de 30 s.
  if (!model.state.updatedAt || Date.now() - model.state.updatedAt > 30000) pollNow();
});
